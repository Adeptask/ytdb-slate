import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EpisodeRecord } from "../state.ts";
import { DispatchAccounting, Telemetry, type TelemetryAttributes, type TelemetrySpan } from "./core.ts";
import { WorkerTelemetry } from "./worker.ts";

export type DispatchOutcome = "rejected" | "cancelled before start" | "aborted" | "cancelled" | "failed" | "succeeded" | "stored but failed";
export const WORKER_IDENTITY_TYPE = "slate-worker-identity";

/** One call owns this handle. No ambient context or shared accounting is sampled. */
export class DispatchTelemetry {
	readonly accounting = new DispatchAccounting();
	private ended = false;
	private owner = false;
	private admitted = false;
	private result?: TelemetryAttributes;
	private attributes: TelemetryAttributes = {};
	private identity?: Record<string, unknown>;
	private span?: TelemetrySpan;
	private observer?: WorkerTelemetry;
	private finalOutcome?: DispatchOutcome;
	constructor(privateTelemetry: Telemetry, parent?: TelemetrySpan, privateOnFinish?: (outcome: DispatchOutcome) => void) {
		this.onFinish = privateOnFinish;
		this.telemetry = privateTelemetry;
		this.telemetry.guard("observer", () => {
			this.span = this.telemetry.start("dispatch", parent?.attributes, parent);
			if (this.span) this.span.accounting = this.accounting;
		});
	}
	private telemetry: Telemetry;
	private onFinish?: (outcome: DispatchOutcome) => void;
	claim(): this { this.owner = true; return this; }
	get claimed(): boolean { return this.owner; }
	get pending(): boolean { return this.owner && !this.ended; }
	get finishedOutcome(): DispatchOutcome | undefined { return this.finalOutcome; }
	/** Fallback covers pre-execute rejection and execute-time validation before claim(). */
	rejectUnclaimed(): void { if (!this.owner) this.finish("rejected"); }
	/** Final quit closes admission work that manager teardown cannot join. */
	rejectUnadmitted(): void { if (!this.admitted) this.finish("rejected"); }
	admit(ctx: ExtensionContext, data: { change?: string; track?: string; threadId: string; episodeId: string; type?: string; model?: string; requestedModel: string; effort: string }): void {
		this.admitted = true;
		this.telemetry.guard("observer", () => {
			this.attributes = { ...this.attributes, "slate.change": data.change, "slate.track": data.track,
				"slate.thread.id": data.threadId, "slate.episode.id": data.episodeId, "slate.thread.type": data.type,
				"slate.logical_model": data.model, "slate.dispatch.requested_model": data.requestedModel,
				"slate.dispatch.requested_effort": data.effort };
			this.identity = { version: 1, parentSessionId: ctx.sessionManager.getSessionId(),
				parentSessionFile: ctx.sessionManager.getSessionFile(), change: data.change, track: data.track,
				threadId: data.threadId, episodeId: data.episodeId, threadType: data.type, logicalModel: data.model };
		});
	}
	worker(session: Pick<AgentSession, "subscribe"> & { model?: { provider: string; id: string }; sessionManager: { appendCustomEntry(type: string, data: unknown): unknown } }): void {
		this.telemetry.guard("observer", () => {
			if (!this.ended && !this.observer) this.observer = new WorkerTelemetry(this.telemetry, this.span, {
				...this.attributes, "gen_ai.provider.name": session.model?.provider, "gen_ai.request.model": session.model?.id,
			}, session, this.accounting);
		});
		this.telemetry.guard("observer", () => {
			if (this.identity) { const identity = this.identity; this.identity = undefined; session.sessionManager.appendCustomEntry(WORKER_IDENTITY_TYPE, identity); }
		});
	}
	cutoff(): void { this.observer?.cutoff(); }
	closeWorker(): void { this.observer?.finish(this.finalOutcome ?? "unknown"); }
	route(model?: string, effort?: string): void {
		this.telemetry.guard("observer", () => {
			Object.assign(this.attributes, { "slate.dispatch.final_model": model, "slate.dispatch.final_effort": effort });
		});
	}
	outcome(outcome: DispatchOutcome, cost?: number, episode?: EpisodeRecord, collectedCost?: number): void {
		this.telemetry.guard("observer", () => {
			this.accounting.check({ "slate.gen_ai.cost.usd": cost, "slate.dispatch.not_stored_cost.usd": collectedCost,
				"gen_ai.usage.input_tokens": episode?.input, "gen_ai.usage.output_tokens": episode?.output,
				"gen_ai.usage.cache_read.input_tokens": episode?.cacheRead, "gen_ai.usage.cache_creation.input_tokens": episode?.cacheWrite });
			this.result ??= { "slate.dispatch.not_stored_cost.usd": cost !== undefined
				? this.accounting.costKnown || cost > 0 ? 0 : undefined : collectedCost,
				"slate.outcome": outcome, "slate.episode.recorded": episode ? "true" : "false",
				"slate.gen_ai.cost.usd": cost, "gen_ai.usage.input_tokens": episode?.input,
				"gen_ai.usage.output_tokens": episode?.output, "gen_ai.usage.cache_read.input_tokens": episode?.cacheRead,
				"gen_ai.usage.cache_creation.input_tokens": episode?.cacheWrite };
			this.accounting.check(this.result);
		});
	}
	/** Publish once at the outer boundary. Cleanup cannot replace a chosen outcome. */
	finish(fallback: DispatchOutcome): void {
		if (this.ended) return;
		this.ended = true;
		this.finalOutcome = (this.result?.["slate.outcome"] as DispatchOutcome | undefined) ?? fallback;
		this.closeWorker();
		this.telemetry.guard("observer", () => {
			// Dispatch totals are span facts, not billed-call metrics.
			if (this.result && this.accounting.costInvalid) delete this.result["slate.dispatch.not_stored_cost.usd"];
			this.telemetry.end(this.span, { ...this.attributes,
				...this.result ?? { "slate.outcome": fallback, "slate.episode.recorded": "false" },
				"slate.dispatch.invalid_accounting": this.accounting.mark });
			this.onFinish?.((this.result?.["slate.outcome"] as DispatchOutcome | undefined) ?? fallback);
		});
	}
}
