import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Telemetry, type TelemetryAttributes, type TelemetrySpan } from "./core.ts";
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
	private requestIndex = 0;
	private calls = new Set<Call>();
	private billing: Call[] = [];
	private compaction?: { span?: TelemetrySpan };
	private seenCompactions = new WeakSet<object>();
	private stopRequests?: () => void;
	private attempt?: TelemetrySpan;
	private turn?: TelemetrySpan;
	private tools = new Map<string, TelemetrySpan | undefined>();
	private unsubscribe?: () => void;
	private telemetry: Telemetry;
	private attributes: TelemetryAttributes;
	constructor(telemetry: Telemetry, parent: TelemetrySpan | undefined, attributes: TelemetryAttributes, session: Pick<AgentSession, "subscribe">) {
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
		return {
			wait: () => this.telemetry.guard("observer", () => {
				if (this.accepting && !waited) { waited = true; this.telemetry.admission(parent, "wait"); }
			}),
			refused: () => this.telemetry.guard("observer", () => {
				if (this.accepting && !admitted && !refused) { refused = true; this.telemetry.admission(parent, "refused"); }
			}),
			admit: (model) => {
				let span: TelemetrySpan | undefined;
				this.telemetry.guard("observer", () => {
					admitted = true;
					if (!this.accepting) return;
					span = this.telemetry.start("worker_model_call", { ...this.attributes,
						"gen_ai.provider.name": model.provider, "gen_ai.request.model": model.id,
						"slate.request.index": this.requestIndex++ }, parent);
					const call = { span, compaction: this.compaction !== undefined };
					this.calls.add(call);
					if (!call.compaction) this.billing.push(call);
				});
				return span;
			},
			failed: (span) => this.telemetry.guard("observer", () => {
				const call = [...this.calls].find((call) => call.span === span);
				if (!call) return;
				this.calls.delete(call);
				this.billing = this.billing.filter((candidate) => candidate !== call);
				this.end(call.span, "failed");
			}),
			returned: (span, value) => this.telemetry.guard("observer", () => {
				const call = [...this.calls].find((call) => call.span === span);
				if (!call?.compaction) return;
				// Pi's result promise observes completion without consuming its iterator.
				void Promise.resolve(value).then((stream) => this.telemetry.guard("observer", () => {
					void Promise.resolve((stream as { result(): Promise<{ stopReason?: string }> }).result())
						.then((message) => this.telemetry.guard("observer", () => {
							this.completeCompactionCall(call, message.stopReason === "error" ? "failed"
								: message.stopReason === "aborted" ? "cancelled" : "succeeded");
						})).catch(() => this.completeCompactionCall(call, "failed"));
				})).catch(() => this.completeCompactionCall(call, "failed"));
			}),
		};
	}
	private completeCompactionCall(call: Call, outcome?: string): void {
		this.telemetry.guard("observer", () => {
			if (!this.calls.delete(call)) return;
			this.end(call.span, outcome);
		});
	}
	private observe(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const call = this.billing.shift();
			if (!call) return;
			this.calls.delete(call);
			this.telemetry.usage(call.span, usageAttributes(event.message.usage));
			this.end(call.span, event.message.stopReason === "error" ? "failed"
				: event.message.stopReason === "aborted" ? "cancelled" : "succeeded");
		} else if (event.type === "compaction_start") {
			if (!this.accepting) return;
			this.end(this.compaction?.span, "incomplete");
			this.compaction = { span: this.telemetry.start("worker_compaction", this.attributes, this.turn ?? this.attempt) };
		} else if (event.type === "compaction_end") {
			if (this.seenCompactions.has(event)) return;
			this.seenCompactions.add(event);
			const compaction = this.compaction; this.compaction = undefined;
			if (!compaction) return;
			this.telemetry.usage(compaction.span, usageAttributes(event.result?.usage));
			this.end(compaction.span, event.aborted ? "cancelled" : event.result ? "succeeded" : "failed");
		} else if (event.type === "turn_start") {
			if (!this.accepting) return;
			const previous = this.turn; this.turn = undefined;
			this.end(previous, "incomplete");
			this.turn = this.telemetry.start("worker_turn", { ...this.attributes, "slate.turn.index": this.index++ }, this.attempt);
		} else if (event.type === "turn_end") {
			const turn = this.turn; this.turn = undefined;
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
	/** Recovery owns subsequent starts. Existing operations retain their handles. */
	cutoff(): void {
		this.accepting = false;
		const attempt = this.attempt; this.attempt = undefined;
		this.end(attempt, "failed");
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
		const turn = this.turn; this.turn = undefined;
		this.end(turn, "incomplete");
		const attempt = this.attempt; this.attempt = undefined;
		this.end(attempt, outcome);
	}
}
