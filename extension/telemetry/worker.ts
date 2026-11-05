import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Telemetry, type TelemetryAttributes, type TelemetrySpan } from "./core.ts";

/** A dispatch owns one observer and explicit handles, including after admission closes. */
export class WorkerTelemetry {
	private accepting = true;
	private ended = false;
	private index = 0;
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
			this.unsubscribe = session.subscribe((event) => {
				telemetry.guard("observer", () => { if (!this.ended) this.observe(event); });
			});
		});
	}
	private end(span: TelemetrySpan | undefined, outcome?: string): void {
		this.telemetry.guard("observer", () => this.telemetry.end(span, { "slate.outcome": outcome }));
	}
	private observe(event: AgentSessionEvent): void {
		if (event.type === "turn_start") {
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
