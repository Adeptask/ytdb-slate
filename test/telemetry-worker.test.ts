import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FAILURE_KEY, Telemetry, type TelemetryEvent } from "../extension/telemetry/core.ts";
import { DispatchTelemetry, type DispatchOutcome } from "../extension/telemetry/dispatch.ts";

afterEach(() => { Reflect.deleteProperty(globalThis, FAILURE_KEY); });
function fixture(enabled = true, failure?: "subscribe" | "unsubscribe" | "publication") {
	const events: TelemetryEvent[] = [];
	const telemetry = new Telemetry((event) => { events.push(event); if (failure === "publication") throw Error("private error"); }, enabled);
	const codemode = telemetry.start("tool", { "slate.tool.name": "codemode", "slate.tool.call_id": "orchestrator-outer" });
	const parent = telemetry.start("tool", { "slate.session.id": "parent", "slate.session.instance_id": "instance",
		"slate.tool.name": "thread", "slate.tool.call_id": "orchestrator-inner", "slate.tool.parent_call_id": "orchestrator-outer" }, codemode);
	const dispatch = new DispatchTelemetry(telemetry, parent).claim();
	dispatch.admit({ sessionManager: { getSessionId: () => "parent", getSessionFile: () => "file" } } as unknown as ExtensionContext,
		{ change: "change", track: "6", threadId: "t1", episodeId: "t1.e1", type: "general", model: "logical", requestedModel: "p/m", effort: "off" });
	let listener: ((event: AgentSessionEvent) => void) | undefined, subscriptions = 0, unsubscriptions = 0, identities = 0;
	const session = {
		model: { provider: "provider", id: "physical" },
		sessionManager: { appendCustomEntry() { identities++; } },
		subscribe(fn: (event: AgentSessionEvent) => void) {
			subscriptions++;
			if (failure === "subscribe") throw Error("private error");
			listener = fn;
			return () => { unsubscriptions++; if (failure === "unsubscribe") throw Error("private error"); };
		},
	};
	dispatch.worker(session);
	const emit = (event: Record<string, unknown>) => listener?.(event as AgentSessionEvent);
	const of = (kind: TelemetryEvent["kind"], phase = "end") => events.filter((event) => event.kind === kind && event.phase === phase);
	return { telemetry, parent, dispatch, session, emit, events, of,
		counts: () => ({ subscriptions, unsubscriptions, identities }) };
}
function balanced(events: TelemetryEvent[]) {
	for (const start of events.filter((e) => e.phase === "start" && e.kind.startsWith("worker_"))) {
		assert.equal(events.filter((e) => e.phase === "end" && e.id === start.id).length, 1, start.kind);
	}
}

test("worker turns and nested tools use dispatch-local handles and numeric indexes", () => {
	const h = fixture();
	h.dispatch.worker(h.session);
	h.emit({ type: "tool_execution_start", toolCallId: "orphan", toolName: "read" });
	h.emit({ type: "turn_start" });
	h.emit({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode", args: "private task" });
	h.emit({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode" });
	h.emit({ type: "tool_execution_start", toolCallId: "inner", parentToolCallId: "outer", toolName: "read" });
	h.emit({ type: "tool_execution_start", toolCallId: "missing-parent", parentToolCallId: "missing", toolName: "read" });
	h.emit({ type: "turn_end", message: "private response" });
	h.emit({ type: "turn_start" });
	h.emit({ type: "tool_execution_end", toolCallId: "inner", isError: true, result: "private result" });
	h.emit({ type: "tool_execution_end", toolCallId: "outer", isError: false });
	h.emit({ type: "tool_execution_end", toolCallId: "outer", isError: true });
	h.emit({ type: "turn_end" });
	h.dispatch.outcome("succeeded");
	h.dispatch.finish("failed"); h.dispatch.finish("failed");
	const attempt = h.of("worker_attempt", "start")[0]!, turns = h.of("worker_turn", "start"), tools = h.of("worker_tool", "start");
	assert.equal(attempt.parentId, h.of("dispatch", "start")[0]!.id);
	assert.equal(attempt.attributes["slate.attempt.index"], 0);
	assert.equal(attempt.attributes["slate.session.id"], "parent");
	assert.equal(attempt.attributes["slate.thread.id"], "t1");
	assert.equal(attempt.attributes["gen_ai.provider.name"], "provider");
	assert.equal(attempt.attributes["gen_ai.request.model"], "physical");
	assert.deepEqual(turns.map((e) => [e.parentId, e.attributes["slate.turn.index"]]), [[attempt.id, 0], [attempt.id, 1]]);
	assert.equal(tools.length, 2);
	assert.equal(tools[0]!.parentId, turns[0]!.id);
	assert.equal(tools[1]!.parentId, tools[0]!.id);
	assert.deepEqual(h.of("worker_tool").map((e) => e.attributes["slate.outcome"]), ["failed", "succeeded"]);
	assert.equal(h.of("worker_attempt")[0]!.attributes["slate.outcome"], "succeeded");
	assert.deepEqual(h.counts(), { subscriptions: 1, unsubscriptions: 1, identities: 1 });
	assert.ok(h.events.every((e) => Object.isFrozen(e) && Object.isFrozen(e.attributes)));
	assert.doesNotMatch(JSON.stringify(h.events), /private/);
	balanced(h.events);
});

test("worker spans exclude the nested orchestrator thread tool identity but keep dispatch context", () => {
	const h = fixture();
	h.emit({ type: "turn_start" });
	h.emit({ type: "tool_execution_start", toolCallId: "worker-read", toolName: "read" });
	h.dispatch.finish("succeeded");
	const starts = h.events.filter((e) => e.phase === "start");
	const thread = starts.find((e) => e.kind === "tool" && e.attributes["slate.tool.name"] === "thread")!;
	assert.equal(thread.parentId, starts.find((e) => e.attributes["slate.tool.name"] === "codemode")!.id);
	assert.equal(thread.attributes["slate.tool.parent_call_id"], "orchestrator-outer");
	const dispatch = h.of("dispatch", "start")[0]!, attempt = h.of("worker_attempt", "start")[0]!;
	assert.equal(dispatch.parentId, thread.id);
	assert.equal(dispatch.attributes["slate.tool.call_id"], "orchestrator-inner");
	assert.equal(attempt.parentId, dispatch.id);
	assert.equal(h.of("worker_turn", "start")[0]!.parentId, attempt.id);
	for (const event of h.events.filter((e) => e.kind.startsWith("worker_"))) {
		assert.partialDeepStrictEqual(event.attributes, { "slate.session.id": "parent", "slate.session.instance_id": "instance",
			"slate.change": "change", "slate.track": "6", "slate.thread.id": "t1", "slate.episode.id": "t1.e1",
			"slate.thread.type": "general", "slate.logical_model": "logical",
			"slate.dispatch.requested_model": "p/m", "slate.dispatch.requested_effort": "off",
			"gen_ai.provider.name": "provider", "gen_ai.request.model": "physical" });
		assert.deepEqual(Object.fromEntries(Object.entries(event.attributes).filter(([key]) => key.startsWith("slate.tool."))),
			event.kind === "worker_tool" ? { "slate.tool.call_id": "worker-read", "slate.tool.name": "read" } : {});
	}
	balanced(h.events);
});

test("cutoff excludes new turn and tool spans and keeps the current attempt open for included billing", () => {
	const h = fixture();
	h.emit({ type: "turn_start" });
	h.emit({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode" });
	h.dispatch.cutoff(); h.dispatch.cutoff();
	h.emit({ type: "turn_start" });
	h.emit({ type: "tool_execution_start", toolCallId: "recovery", parentToolCallId: "outer", toolName: "read" });
	assert.equal(h.of("worker_tool").length, 0);
	h.emit({ type: "tool_execution_end", toolCallId: "outer", isError: false });
	h.emit({ type: "turn_end" });
	h.emit({ type: "turn_start" }); h.emit({ type: "turn_end" });
	h.dispatch.finish("succeeded");
	assert.equal(h.of("worker_turn").length, 1);
	assert.equal(h.of("worker_tool").length, 1);
	assert.equal(h.of("worker_tool")[0]!.attributes["slate.outcome"], "succeeded");
	assert.equal(h.of("worker_attempt")[0]!.attributes["slate.outcome"], "failed");
	assert.ok(h.events.indexOf(h.of("worker_attempt")[0]!) > h.events.indexOf(h.of("worker_tool")[0]!));
	balanced(h.events);
});

test("all dispatch outcomes close abandoned worker work once with incomplete status", () => {
	for (const outcome of ["rejected", "cancelled before start", "aborted", "cancelled", "failed", "succeeded", "stored but failed"] as DispatchOutcome[]) {
		const h = fixture();
		h.emit({ type: "turn_start" }); h.emit({ type: "turn_start" });
		h.emit({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode" });
		h.emit({ type: "tool_execution_start", toolCallId: "inner", parentToolCallId: "outer", toolName: "read" });
		h.dispatch.outcome(outcome); h.dispatch.finish("failed");
		const snapshot = h.events.slice();
		h.emit({ type: "turn_start" }); h.emit({ type: "tool_execution_end", toolCallId: "inner" });
		h.dispatch.worker(h.session); h.dispatch.closeWorker(); h.dispatch.finish("failed"); h.dispatch.cutoff();
		assert.deepEqual(h.events, snapshot);
		assert.equal(h.of("worker_attempt")[0]!.attributes["slate.outcome"], outcome);
		assert.ok([...h.of("worker_turn"), ...h.of("worker_tool")].every((e) => e.attributes["slate.outcome"] === "incomplete"));
		assert.equal(h.counts().unsubscriptions, 1);
		balanced(h.events);
	}
});

test("shutdown closes observer work with unknown status without selecting a dispatch outcome", () => {
	const h = fixture();
	h.emit({ type: "turn_start" });
	h.dispatch.closeWorker(); h.dispatch.closeWorker();
	assert.equal(h.dispatch.pending, true);
	assert.equal(h.of("worker_attempt")[0]!.attributes["slate.outcome"], "unknown");
	h.dispatch.finish("cancelled");
	balanced(h.events);
});

test("disabled telemetry does no worker work and never subscribes", () => {
	const h = fixture(false);
	h.dispatch.cutoff(); h.dispatch.closeWorker(); h.dispatch.finish("succeeded");
	assert.deepEqual(h.counts(), { subscriptions: 0, unsubscriptions: 0, identities: 0 });
	assert.deepEqual(h.events, []);
});

test("worker observer failures are isolated and report once per kind across dispatches", (t) => {
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((s: string) => { output.push(s); return true; }) as typeof process.stderr.write);
	for (const failure of ["subscribe", "unsubscribe", "publication"] as const) {
		for (let n = 0; n < 2; n++) {
			const h = fixture(true, failure);
			h.emit({ type: "turn_start" });
			h.emit({ type: "tool_execution_start", toolCallId: "x", toolName: "read" });
			h.dispatch.finish("succeeded");
			assert.equal(h.of("dispatch")[0]!.attributes["slate.outcome"], "succeeded");
			balanced(h.events);
		}
	}
	const h = fixture();
	h.emit(null as unknown as Record<string, unknown>);
	h.emit({ type: "turn_start" }); h.dispatch.finish("succeeded");
	assert.equal(output.filter((s) => s.includes("observer failed")).length, 1);
	assert.equal(output.filter((s) => s.includes("publication failed")).length, 1);
	assert.doesNotMatch(output.join(""), /private/);
	balanced(h.events);
});

test("worker bash spans carry command labels without inheriting them into later spans", () => {
	const h = fixture();
	h.emit({ type: "turn_start" });
	h.emit({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode", args: { code: "private" } });
	h.emit({ type: "tool_execution_start", toolCallId: "sh", parentToolCallId: "outer", toolName: "bash", args: { command: "boat-run run test private" } });
	h.emit({ type: "tool_execution_end", toolCallId: "sh", isError: false });
	h.emit({ type: "tool_execution_end", toolCallId: "outer", isError: false });
	h.emit({ type: "turn_end" });
	h.emit({ type: "turn_start" });
	h.emit({ type: "turn_end" });
	h.dispatch.finish("succeeded");
	const tool = (id: string) => h.of("worker_tool").find((e) => e.attributes["slate.tool.call_id"] === id);
	const codemode = tool("outer"), bash = tool("sh");
	assert.equal(codemode!.attributes["slate.command.category"], undefined);
	assert.equal(bash!.attributes["slate.command.category"], "test");
	assert.equal(bash!.attributes["slate.command.runner"], "boat");
	assert.equal(bash!.attributes["slate.command.program"], "boat-run");
	assert.ok(h.of("worker_turn").every((e) => e.attributes["slate.command.category"] === undefined));
	assert.doesNotMatch(JSON.stringify(h.events), /private/);
	balanced(h.events);
});
