import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { DispatchAccounting, Telemetry, type TelemetryAttributes, type TelemetrySpan } from "./core.ts";
import type { RecoveryCandidate } from "../logical-model-recovery.ts";
import { observeRequests, type RequestObservation } from "./request.ts";

type CollectedUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
function usageAttributes(usage: CollectedUsage | undefined): TelemetryAttributes {
	return { "gen_ai.usage.input_tokens": usage?.input, "gen_ai.usage.output_tokens": usage?.output,
		"gen_ai.usage.cache_read.input_tokens": usage?.cacheRead, "gen_ai.usage.cache_creation.input_tokens": usage?.cacheWrite,
		"slate.gen_ai.cost.usd": usage?.cost?.total };
}
type Call = { span?: TelemetrySpan; compaction: boolean };

/** A dispatch owns one observer and explicit handles, including after admission closes. */
export class WorkerTelemetry {
	private accepting = true;
	private ended = false;
	private index = 0;
	private requests = { index: 0 };
	private attemptIndex = 0;
	private parent?: TelemetrySpan;
	private turns = new Set<TelemetrySpan>();
	private calls = new Set<Call>();
	private billing: Call[] = [];
	private compaction?: { span?: TelemetrySpan; attributes: TelemetryAttributes; requests: { index: number } };
	private seenCompactions = new WeakSet<object>();
	private stopRequests?: () => void;
	private attempt?: TelemetrySpan;
	private attemptOutcome?: string;
	private turn?: TelemetrySpan;
	private tools = new Map<string, TelemetrySpan | undefined>();
	private unsubscribe?: () => void;
	private telemetry: Telemetry;
	private accounting: DispatchAccounting;
	private attributes: TelemetryAttributes;
	constructor(telemetry: Telemetry, parent: TelemetrySpan | undefined, attributes: TelemetryAttributes, session: Pick<AgentSession, "subscribe">, privateAccounting = parent?.accounting ?? new DispatchAccounting()) {
		this.parent = parent;
		this.accounting = privateAccounting;
		this.telemetry = telemetry;
		this.attributes = Object.fromEntries(Object.entries({ ...parent?.attributes, ...attributes, "slate.attempt.index": 0 })
			.filter(([key]) => !key.startsWith("slate.tool.")));
		telemetry.guard("observer", () => {
			this.attempt = telemetry.start("worker_attempt", this.attributes, parent);
			this.stopRequests = observeRequests(session, () => this.request());
			this.unsubscribe = session.subscribe((event) => {
				telemetry.guard("observer", () => { if (!this.ended) this.observe(event); });
			});
		});
	}
	private end(span: TelemetrySpan | undefined, outcome?: string): void {
		this.telemetry.guard("observer", () => this.telemetry.end(span, { "slate.outcome": outcome }));
	}
	private request(): RequestObservation {
		const parent = this.turn ?? this.attempt;
		let admitted = false, waited = false, refused = false;
		let call: Call | undefined;
		return {
			wait: () => this.telemetry.guard("observer", () => {
				if (this.accepting && !waited) { waited = true; this.telemetry.admission(parent, "wait"); }
			}),
			refused: () => this.telemetry.guard("observer", () => {
				if (this.accepting && !admitted && !refused) { refused = true; this.telemetry.admission(parent, "refused"); }
			}),
			admit: (model) => {
				if (this.ended) return undefined;
				admitted = true;
				const compaction = this.compaction;
				// Keep a queue position even when span creation fails.
				call = { compaction: compaction !== undefined };
				this.calls.add(call);
				if (!call.compaction) this.billing.push(call);
				this.telemetry.guard("observer", () => {
					call!.span = this.telemetry.start("worker_model_call", { ...(compaction?.attributes ?? this.attributes),
						"gen_ai.provider.name": model.provider, "gen_ai.request.model": model.id,
						"slate.request.index": (compaction?.requests ?? this.requests).index++ }, compaction ? compaction.span : this.turn ?? this.attempt);
				});
				return call.span;
			},
			failed: () => this.telemetry.guard("observer", () => {
				if (!call || !this.calls.delete(call)) return;
				this.end(call.span, "failed");
				// Pi emits an assistant failure even when the stream function throws.
				call.span = undefined;
			}),
			returned: (_span, value) => this.telemetry.guard("observer", () => {
				const current = call;
				if (!current?.compaction) return;
				// Pi's result promise observes completion without consuming its iterator.
				void Promise.resolve(value).then((stream) => this.telemetry.guard("observer", () => {
					void Promise.resolve((stream as { result(): Promise<{ stopReason?: string }> }).result())
						.then((message) => this.telemetry.guard("observer", () => {
							this.completeCompactionCall(current, message.stopReason === "error" ? "failed"
								: message.stopReason === "aborted" ? "cancelled" : "succeeded");
						})).catch(() => this.completeCompactionCall(current, "failed"));
				})).catch(() => this.completeCompactionCall(current, "failed"));
			}),
		};
	}
	private completeCompactionCall(call: Call, outcome?: string): void {
		this.telemetry.guard("observer", () => {
			if (!this.calls.delete(call)) return;
			this.end(call.span, outcome);
		});
	}
	private usage(span: TelemetrySpan | undefined, attributes: TelemetryAttributes): void {
		try { this.telemetry.usage(span, attributes); }
		catch (error) { this.accounting.unrecorded(attributes); throw error; }
		if (!span) this.accounting.unrecorded(attributes);
	}
	private observe(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const attributes = usageAttributes(event.message.usage);
			this.accounting.collect(attributes, "worker");
			const call = this.billing.shift();
			if (!call?.span) { this.accounting.unrecorded(attributes); return; }
			this.calls.delete(call);
			this.usage(call.span, attributes);
			this.end(call.span, event.message.stopReason === "error" ? "failed"
				: event.message.stopReason === "aborted" ? "cancelled" : "succeeded");
		} else if (event.type === "compaction_start") {
			this.end(this.compaction?.span, "incomplete");
			const compaction = { attributes: this.attributes, requests: this.requests, span: undefined as TelemetrySpan | undefined };
			this.compaction = compaction;
			compaction.span = this.telemetry.start("worker_compaction", this.attributes, this.turn ?? this.attempt);
		} else if (event.type === "compaction_end") {
			if (this.seenCompactions.has(event)) return;
			this.seenCompactions.add(event);
			const attributes = usageAttributes(event.result?.usage);
			this.accounting.collect(attributes, "compaction");
			const compaction = this.compaction; this.compaction = undefined;
			// Slate also collects a completion whose start was not observed.
			const span = compaction ? compaction.span : this.telemetry.start("worker_compaction", this.attributes, this.turn ?? this.attempt);
			this.usage(span, attributes);
			this.telemetry.end(span, { "slate.outcome": event.aborted ? "cancelled" : event.result ? "succeeded" : "failed" }, Date.now(), compaction !== undefined);
		} else if (event.type === "turn_start") {
			if (!this.accepting) return;
			this.turn = this.telemetry.start("worker_turn", { ...this.attributes, "slate.turn.index": this.index++ }, this.attempt);
			if (this.turn) this.turns.add(this.turn);
		} else if (event.type === "turn_end") {
			const turn = this.turns.values().next().value;
			if (turn) this.turns.delete(turn);
			if (turn === this.turn) this.turn = undefined;
			this.end(turn);
		} else if (event.type === "tool_execution_start") {
			if (!this.accepting || this.tools.has(event.toolCallId)) return;
			const parent = event.parentToolCallId ? this.tools.get(event.parentToolCallId) : this.turn;
			// Never attach an operation to an unrelated turn when its parent is absent.
			if (!parent) return;
			this.tools.set(event.toolCallId, this.telemetry.start("worker_tool", {
				...this.attributes, "slate.tool.call_id": event.toolCallId,
				"slate.tool.parent_call_id": event.parentToolCallId, "slate.tool.name": event.toolName,
			}, parent));
		} else if (event.type === "tool_execution_end") {
			const tool = this.tools.get(event.toolCallId);
			this.tools.delete(event.toolCallId);
			this.end(tool, event.isError ? "failed" : "succeeded");
		}
	}
	/** Included requests and compactions retain the current attempt until a fallback starts. */
	cutoff(): void {
		this.accepting = false;
		this.attemptOutcome ??= "failed";
	}
	/** Candidate callbacks contain only fallbacks, so recovery indexes start at one. */
	recover(candidate: RecoveryCandidate): void {
		if (this.ended) return;
		this.cutoff();
		this.end(this.attempt, this.attemptOutcome);
		this.attemptOutcome = undefined;
		this.turn = undefined;
		this.requests = { index: 0 };
		this.attributes = { ...this.attributes, "slate.attempt.index": ++this.attemptIndex,
			"slate.logical_model": candidate.logicalModel, "gen_ai.provider.name": candidate.provider,
			"gen_ai.request.model": candidate.model };
		this.attempt = this.telemetry.start("worker_attempt", this.attributes, this.parent);
		this.accepting = true;
	}
	endRecovery(outcome: string): void {
		// Included work can still start while Slate settles the same worker session.
		this.attemptOutcome = outcome;
	}
	finish(outcome: string): void {
		if (this.ended) return;
		this.ended = true;
		this.accepting = false;
		const stopRequests = this.stopRequests; this.stopRequests = undefined;
		this.telemetry.guard("observer", () => stopRequests?.());
		for (const call of this.calls) this.end(call.span, "incomplete");
		this.calls.clear();
		this.billing = [];
		this.end(this.compaction?.span, "incomplete"); this.compaction = undefined;
		const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
		this.telemetry.guard("observer", () => unsubscribe?.());
		for (const tool of [...this.tools.values()].reverse()) this.end(tool, "incomplete");
		this.tools.clear();
		this.turn = undefined;
		for (const turn of this.turns) this.end(turn, "incomplete");
		this.turns.clear();
		const attempt = this.attempt; this.attempt = undefined;
		this.end(attempt, this.attemptOutcome ?? outcome);
	}
}
