import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { metrics, trace, type Attributes, type MeterProvider } from "@opentelemetry/api";
import { generateSummaryWithUsage, type AgentSessionEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai/compat";
import { Telemetry, FAILURE_KEY, type TelemetryEvent } from "../extension/telemetry/core.ts";
import { DispatchTelemetry } from "../extension/telemetry/dispatch.ts";
import { createWorkerRequestContract, installRequestThrottle, installWorkerRequestContract, type WorkerSession } from "../extension/worker.ts";
import { createRequestThrottle, RequestThrottleAbort, REQUEST_THROTTLE_DEFAULTS } from "../extension/request-throttle.ts";
import { requestObservation } from "../extension/telemetry/request.ts";

afterEach(() => { metrics.disable(); trace.disable(); Reflect.deleteProperty(globalThis, FAILURE_KEY); });
const model = { provider: "p", id: "m", api: "openai-responses" } as Parameters<WorkerSession["agent"]["streamFunction"]>[0];
const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.3 } };
function fixture(id = "a", enabled = true) {
	const events: TelemetryEvent[] = [];
	const telemetry = new Telemetry((event) => events.push(event), enabled);
	const parent = telemetry.start("tool", { "slate.session.id": "parent", "slate.tool.name": "thread" });
	const dispatch = new DispatchTelemetry(telemetry, parent).claim();
	dispatch.admit({ sessionManager: { getSessionId: () => "parent", getSessionFile: () => "file" } } as unknown as ExtensionContext,
		{ threadId: id, episodeId: id + ".e1", type: "general", model: "logical-" + id, requestedModel: "p/m", effort: "off" });
	let listener: (event: AgentSessionEvent) => void = () => {};
	let sent = 0;
	const stream = createAssistantMessageEventStream();
	const session = {
		model, sessionManager: { appendCustomEntry() {} },
		agent: { streamFunction: () => { sent++; return stream; } },
		subscribe(fn: typeof listener) { listener = fn; return () => {}; },
	} as unknown as WorkerSession;
	const contract = createWorkerRequestContract();
	contract.expect({ provider: "p", model: "m", effort: "off" });
	const install = () => installWorkerRequestContract(session, contract);
	dispatch.worker(session);
	const emit = (event: Record<string, unknown>) => listener(event as AgentSessionEvent);
	const call = (m = model, signal?: AbortSignal) => session.agent.streamFunction(m, normalizeContext({ messages: [] }), { signal });
	const message = (u: unknown = usage, stopReason = "stop") => emit({ type: "message_end",
		message: { role: "assistant", provider: "p", model: "m", usage: u, stopReason, content: [] } });
	const of = (kind: TelemetryEvent["kind"], phase = "start") => events.filter((e) => e.kind === kind && e.phase === phase);
	return { telemetry, dispatch, session, contract, stream, events, emit, call, message, of, install, sent: () => sent };
}
function meter() {
	const points: Array<{ name: string; value: number; labels: Attributes }> = [];
	const record = (name: string) => (value: number, labels: Attributes) => points.push({ name, value, labels });
	metrics.setGlobalMeterProvider({ getMeter: () => ({
		createCounter: (name: string) => ({ add: record(name) }),
		createHistogram: (name: string) => ({ record: record(name) }),
	}) } as unknown as MeterProvider);
	return points;
}
function balanced(events: TelemetryEvent[]) {
	for (const event of events.filter((e) => e.phase === "start")) {
		if (event.kind.startsWith("worker_")) assert.equal(events.filter((e) => e.phase === "end" && e.id === event.id).length, 1);
	}
}

test("concurrent dispatch requests keep parents, zero-based indexes, exact per-call billing and bounded labels", () => {
	const points = meter(), a = fixture("a"), b = fixture("b");
	a.install(); b.install();
	a.emit({ type: "turn_start" }); b.emit({ type: "turn_start" });
	assert.equal(a.call(), a.stream); assert.equal(b.call(), b.stream);
	b.message({ input: 4, cost: { total: 0.8 } }); a.message();
	a.call(); a.message({ output: 9, cost: { total: 0.1 } });
	for (const h of [a, b]) {
		const calls = h.of("worker_model_call");
		assert.deepEqual(calls.map((e) => e.attributes["slate.request.index"]), h === a ? [0, 1] : [0]);
		assert.ok(calls.every((e) => e.parentId === h.of("worker_turn")[0]!.id));
		assert.ok(calls.every((e) => e.attributes["slate.attempt.index"] === 0));
		h.dispatch.finish("succeeded"); balanced(h.events);
	}
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => [p.value, p.labels["slate.logical_model"]]),
		[[0.8, "logical-b"], [0.3, "logical-a"], [0.1, "logical-a"]]);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.tokens").map((p) => p.value), [4, 11, 7, 3, 2, 9]);
	for (const p of points.filter((p) => p.name.startsWith("slate.model."))) {
		assert.ok(Object.keys(p.labels).every((k) => ["slate.kind", "slate.logical_model", "slate.thread.type",
			"gen_ai.provider.name", "gen_ai.request.model", "slate.token.kind"].includes(k)));
		assert.equal(p.labels["gen_ai.provider.name"], "p"); assert.equal(p.labels["gen_ai.request.model"], "m");
	}
});

test("wholly and partly unknown usage omit points and attributes while known zero remains zero", () => {
	const points = meter(), h = fixture(); h.install(); h.emit({ type: "turn_start" });
	for (const u of [undefined, {}, { input: 6 }, { output: 0, cost: { total: 0 } }]) { h.call(); h.message(u === undefined ? null : u); }
	const usages = h.of("worker_model_call", "usage");
	assert.ok(usages.slice(0, 2).every((e) => !Object.keys(e.attributes).some((k) => k.startsWith("gen_ai.usage.") || k === "slate.gen_ai.cost.usd")));
	assert.equal(usages[2]!.attributes["gen_ai.usage.input_tokens"], 6);
	assert.equal(usages[2]!.attributes["slate.gen_ai.cost.usd"], undefined);
	assert.deepEqual(points.filter((p) => p.name.startsWith("slate.model.")).map((p) => p.value), [6, 0, 0]);
	h.dispatch.finish("succeeded"); balanced(h.events);
});

test("compaction retries time requests without request billing and collect final compaction usage once", { timeout: 5000 }, async () => {
	const points = meter(), h = fixture(); h.install();
	h.emit({ type: "compaction_start" });
	const stream = h.call(); assert.equal(stream, h.stream);
	h.stream.end({ role: "assistant" } as never);
	await Promise.resolve(); await Promise.resolve();
	assert.equal(h.of("worker_model_call", "end").length, 1);
	// A retry has its own request index. Its discarded raw usage never enters billing.
	h.call(); await Promise.resolve(); await Promise.resolve();
	const end = { type: "compaction_end", result: { usage: { input: 5, output: 4, cost: { total: 0.2 } } } };
	h.emit(end); h.emit(end);
	assert.deepEqual(h.of("worker_model_call").map((e) => e.attributes["slate.request.index"]), [0, 1]);
	assert.equal(h.of("worker_model_call", "usage").length, 0);
	assert.equal(h.of("worker_compaction", "usage").length, 1);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => p.value), [0.2]);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.tokens").map((p) => p.value), [5, 4]);
	h.dispatch.finish("succeeded"); balanced(h.events);
});

test("compaction completion without a start bills once and keeps duration unknown", () => {
	const points = meter(), h = fixture();
	const end = { type: "compaction_end", aborted: true, result: { usage: { cost: { total: 0.125 }, input: 2 } } };
	h.emit(end); h.emit(end);
	h.dispatch.outcome("cancelled", undefined, undefined, 0.125); h.dispatch.finish("failed");
	assert.equal(h.of("worker_compaction", "usage").length, 1);
	assert.equal(h.of("worker_compaction", "end")[0]!.durationSeconds, undefined);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => p.value), [0.125]);
	assert.equal(h.of("dispatch", "end")[0]!.attributes["slate.dispatch.not_stored_cost.usd"], 0.125);
	balanced(h.events);
});

test("invalid cost and tokens mark the dispatch, drop only bad values and never fabricate not-stored cost", () => {
	const points = meter();
	for (const [field, value, mark] of [
		["cost", -1, "cost"], ["cost", NaN, "cost"], ["cost", Infinity, "cost"], ["cost", -Infinity, "cost"], ["cost", "1", "cost"],
		["input", -1, "tokens"], ["input", NaN, "tokens"], ["input", Infinity, "tokens"], ["input", 1.5, "tokens"], ["input", "2", "tokens"],
		["both", -1, "both"],
	] as const) {
		const h = fixture(); h.install(); h.call();
		const u = { input: field === "cost" ? 2 : value, cost: { total: field === "input" ? 0.125 : value } };
		h.message(u); h.dispatch.outcome("succeeded", 0.125); h.dispatch.finish("failed");
		const a = h.of("dispatch", "end")[0]!.attributes, billed = h.of("worker_model_call", "usage")[0]!.attributes;
		assert.equal(a["slate.dispatch.invalid_accounting"], mark);
		assert.equal(a["slate.dispatch.not_stored_cost.usd"], mark === "tokens" ? 0 : undefined);
		assert.equal(billed["slate.gen_ai.cost.usd"], field === "input" ? 0.125 : undefined);
		assert.equal(billed["gen_ai.usage.input_tokens"], field === "cost" ? 2 : undefined);
	}
	assert.ok(points.filter((p) => p.name.startsWith("slate.model.")).every((p) => Number.isFinite(p.value) && p.value >= 0));
	assert.ok(points.filter((p) => p.name === "slate.model.tokens").every((p) => Number.isInteger(p.value)));
});

test("one accounting record includes unmatched assistant usage, compaction, local and collected charges and overflow", () => {
	for (const source of ["unmatched", "compaction", "charge", "collected", "worker-overflow", "compaction-overflow", "mixed-overflow", "token-overflow"]) {
		const h = fixture(); h.install();
		if (source === "unmatched") h.message({ cost: { total: -1 } });
		if (source === "compaction") h.emit({ type: "compaction_end", result: { usage: { cost: { total: NaN } } } });
		if (source.endsWith("overflow")) {
			const u = source === "token-overflow" ? { input: Number.MAX_VALUE } : { cost: { total: Number.MAX_VALUE } };
			h.call(); h.message(u);
			if (source === "compaction-overflow") {
				h.emit({ type: "compaction_end", result: { usage: u } });
				h.emit({ type: "compaction_end", result: { usage: u } });
			} else if (source === "mixed-overflow") h.emit({ type: "compaction_end", result: { usage: u } });
			else { h.call(); h.message(u); }
		}
		h.dispatch.outcome("cancelled", source === "charge" ? -1 : undefined, undefined, source === "collected" ? Infinity : 0.125);
		h.dispatch.finish("failed");
		const a = h.of("dispatch", "end")[0]!.attributes;
		assert.equal(a["slate.dispatch.invalid_accounting"], source === "token-overflow" ? "tokens" : "cost", source);
		assert.equal(a["slate.dispatch.not_stored_cost.usd"], source === "token-overflow" ? 0.125 : undefined);
	}
	const h = fixture();
	h.message({ input: -1 }); h.dispatch.cutoff();
	h.emit({ type: "compaction_end", result: { usage: { cost: { total: -1 } } } });
	h.dispatch.outcome("cancelled", undefined, undefined, 0.125); h.dispatch.finish("cancelled");
	assert.equal(h.of("dispatch", "end")[0]!.attributes["slate.dispatch.invalid_accounting"], "both");
});

test("not-stored cost uses the supplied Slate accumulator, never a telemetry subtraction", () => {
	const h = fixture(); h.install(); h.call(); h.message({ cost: { total: 0.125 } });
	h.dispatch.outcome("cancelled", undefined, undefined, 0.75); h.dispatch.finish("failed");
	assert.equal(h.of("dispatch", "end")[0]!.attributes["slate.dispatch.not_stored_cost.usd"], 0.75);
});

test("valid unknown, zero and partly known usage stay unmarked", () => {
	for (const u of [{}, { input: 0, cost: { total: 0 } }, { output: 2 }, { cost: { total: 0.125 } }]) {
		const h = fixture(); h.install(); h.call(); h.message(u);
		h.dispatch.outcome("succeeded", 0); h.dispatch.finish("failed");
		const a = h.of("dispatch", "end")[0]!.attributes;
		assert.equal(a["slate.dispatch.invalid_accounting"], undefined);
		assert.equal(a["slate.dispatch.not_stored_cost.usd"], "cost" in u ? 0 : undefined);
	}
});

test("throttle waits and contract refusals are events, not requests, and do not consume request indexes", { timeout: 5000 }, async () => {
	const h = fixture();
	let now = 0, release: (() => void) | undefined;
	const throttle = createRequestThrottle({ ...REQUEST_THROTTLE_DEFAULTS, maxRequestsPerMinute: 1 },
		{ now: () => now, schedule: (_ms, run) => { release = run; return () => {}; }, scheduleExpiry: () => () => {} });
	installRequestThrottle(h.session, throttle, h.contract);
	h.emit({ type: "turn_start" }); await h.call(); h.message();
	const waiting = h.call();
	assert.equal(h.of("worker_model_call").length, 1);
	assert.deepEqual(h.events.filter((e) => e.phase === "admission").map((e) => [e.id, e.attributes["slate.outcome"]]),
		[[h.of("worker_turn")[0]!.id, "wait"]]);
	now = 60001; release!(); assert.equal(await waiting, h.stream); h.message();
	now = 120002;
	await assert.rejects(Promise.resolve().then(() => h.call({ ...model, id: "wrong" })), /contract/);
	assert.equal(h.of("worker_model_call").length, 2);
	assert.equal(h.events.filter((e) => e.phase === "admission" && e.attributes["slate.outcome"] === "refused").length, 1);
	h.dispatch.finish("failed"); balanced(h.events);
});

test("refusal without a turn targets the attempt while caller cancellation emits no refusal", { timeout: 5000 }, async () => {
	const h = fixture(); h.install();
	assert.throws(() => h.call({ ...model, id: "wrong" }), /contract/);
	assert.equal(h.of("worker_model_call").length, 0);
	assert.equal(h.events.find((e) => e.phase === "admission")!.id, h.of("worker_attempt")[0]!.id);
	h.dispatch.finish("failed");
	const abort = new AbortController(); abort.abort();
	for (const throttled of [false, true]) {
		const a = fixture("cancelled");
		if (throttled) installRequestThrottle(a.session, createRequestThrottle({ ...REQUEST_THROTTLE_DEFAULTS, enabled: false }));
		else a.install();
		await assert.rejects(Promise.resolve().then(() => a.call(model, abort.signal)), throttled ? /aborted/ : /contract/);
		assert.equal(a.events.filter((e) => e.phase === "admission").length, 0);
		assert.equal(a.sent(), 0); a.dispatch.finish("cancelled"); balanced(a.events);
	}
});

test("cancellation during a throttle wait emits no refusal, consumes no index and preserves the caller error", { timeout: 5000 }, async () => {
	for (const withContract of [false, true]) {
		const h = fixture();
		let now = 0;
		const throttle = createRequestThrottle({ ...REQUEST_THROTTLE_DEFAULTS, maxRequestsPerMinute: 1 },
			{ now: () => now, schedule: () => () => {}, scheduleExpiry: () => () => {} });
		installRequestThrottle(h.session, throttle, withContract ? h.contract : undefined);
		h.emit({ type: "turn_start" }); await h.call(); h.message();
		const abort = new AbortController();
		const waiting = h.call(model, abort.signal);
		assert.equal(throttle.inspect().waiters, 1);
		abort.abort();
		await assert.rejects(Promise.resolve(waiting), (error: unknown) =>
			error instanceof RequestThrottleAbort && /waiting for capacity/.test(error.message));
		assert.deepEqual(h.events.filter((e) => e.phase === "admission").map((e) => e.attributes["slate.outcome"]), ["wait"]);
		assert.equal(throttle.inspect().waiters, 0); assert.equal(h.sent(), 1);
		assert.equal(h.contract.refusal(), undefined);
		now = 60001; assert.equal(await h.call(), h.stream); h.message();
		assert.deepEqual(h.of("worker_model_call").map((e) => e.attributes["slate.request.index"]), [0, 1]);
		h.dispatch.finish("succeeded"); balanced(h.events);
	}
});

test("lifecycle invalidation during a throttle wait remains a refusal on its own turn", { timeout: 5000 }, async () => {
	const h = fixture();
	const throttle = createRequestThrottle({ ...REQUEST_THROTTLE_DEFAULTS, maxRequestsPerMinute: 1 },
		{ schedule: () => () => {}, scheduleExpiry: () => () => {} });
	installRequestThrottle(h.session, throttle, h.contract);
	h.emit({ type: "turn_start" }); await h.call(); h.message();
	const waiting = h.call(); h.contract.invalidate();
	await assert.rejects(Promise.resolve(waiting), /contract/);
	assert.deepEqual(h.events.filter((e) => e.phase === "admission").map((e) => [e.id, e.attributes["slate.outcome"]]),
		[[h.of("worker_turn")[0]!.id, "wait"], [h.of("worker_turn")[0]!.id, "refused"]]);
	assert.equal(h.sent(), 1); h.dispatch.finish("failed"); balanced(h.events);
});

test("shared throttle keeps the waiting dispatch parent, per-attempt indexes and telemetry-off admission results", { timeout: 5000 }, async () => {
	async function run(enabled: boolean) {
		const a = fixture("a", enabled), b = fixture("b", enabled);
		let now = 0, release: (() => void) | undefined;
		const order: string[] = [];
		const throttle = createRequestThrottle({ ...REQUEST_THROTTLE_DEFAULTS, maxRequestsPerMinute: 1 },
			{ now: () => now, schedule: (_ms, run) => { release = run; return () => {}; }, scheduleExpiry: () => () => {} });
		for (const [id, h] of [["a", a], ["b", b]] as const) {
			h.session.agent.streamFunction = (() => { order.push(id); return h.stream; }) as WorkerSession["agent"]["streamFunction"];
			installRequestThrottle(h.session, throttle, h.contract); h.emit({ type: "turn_start" });
		}
		const admitted = a.call(), waiting = b.call();
		assert.equal(await admitted, a.stream);
		assert.deepEqual(order, ["a"]); assert.equal(throttle.inspect().waiters, 1);
		if (enabled) {
			assert.equal(b.of("worker_model_call").length, 0);
			assert.equal(a.events.filter((e) => e.phase === "admission").length, 0);
			assert.deepEqual(b.events.filter((e) => e.phase === "admission").map((e) => [e.id, e.attributes["slate.outcome"]]),
				[[b.of("worker_turn")[0]!.id, "wait"]]);
			assert.notEqual(a.of("worker_turn")[0]!.id, b.of("worker_turn")[0]!.id);
		}
		a.message();
		now = 60001; release!(); assert.equal(await waiting, b.stream); b.message();
		now = 120002; assert.equal(await b.call(), b.stream); b.message();
		now = 180003; assert.equal(await a.call(), a.stream); a.message();
		for (const h of [a, b]) {
			if (enabled) {
				const calls = h.of("worker_model_call");
				assert.deepEqual(calls.map((e) => e.attributes["slate.request.index"]), [0, 1]);
				assert.ok(calls.every((e) => e.attributes["slate.attempt.index"] === 0 && e.parentId === h.of("worker_turn")[0]!.id));
			} else assert.deepEqual(h.events, []);
			h.dispatch.finish("succeeded"); balanced(h.events);
		}
		return { order, state: throttle.inspect(), accepted: [a.contract.latestAccepted(), b.contract.latestAccepted()] };
	}
	const on = await run(true), off = await run(false);
	assert.deepEqual(on.order, ["a", "b", "b", "a"]); assert.deepEqual(on, off);
});

test("cutoff keeps in-flight usage and excludes later requests, compactions and metrics", () => {
	const points = meter(), h = fixture(); h.install(); h.emit({ type: "turn_start" });
	h.call(); h.dispatch.cutoff(); h.message();
	h.call(); h.message(); h.emit({ type: "compaction_start" }); h.emit({ type: "compaction_end", result: { usage } });
	assert.equal(h.sent(), 2); assert.equal(h.of("worker_model_call").length, 1);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => p.value), [0.3]);
	h.dispatch.finish("succeeded"); balanced(h.events);
});

test("real Pi summary retry exposes only final-response collected usage", { timeout: 5000 }, async () => {
	const points = meter(), h = fixture();
	let requests = 0;
	h.session.agent.streamFunction = (() => {
		const first = requests++ === 0;
		const stream = createAssistantMessageEventStream();
		stream.end({ role: "assistant", api: "openai-responses", provider: "p", model: "m",
			content: [{ type: "text", text: first ? "" : "private summary" }], timestamp: Date.now(),
			stopReason: first ? "error" : "stop", errorMessage: first ? "connection terminated" : undefined,
			usage: { input: first ? 100 : 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: first ? 104 : 9,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: first ? 9 : 0.2 } } });
		return stream;
	}) as WorkerSession["agent"]["streamFunction"];
	installRequestThrottle(h.session, createRequestThrottle({ ...REQUEST_THROTTLE_DEFAULTS, enabled: false }), h.contract);
	h.emit({ type: "compaction_start" });
	const result = await generateSummaryWithUsage([], { ...model, maxTokens: 100, reasoning: false }, 100, "fake",
		undefined, undefined, undefined, undefined, undefined, h.session.agent.streamFunction, undefined,
		{ enabled: true, maxRetries: 1, baseDelayMs: 1 });
	h.emit({ type: "compaction_end", result });
	assert.equal(requests, 2);
	assert.equal(result.usage.cost.total, 0.2);
	assert.deepEqual(h.of("worker_model_call", "end").map((e) => e.attributes["slate.outcome"]), ["failed", "succeeded"]);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => p.value), [0.2]);
	assert.doesNotMatch(JSON.stringify(h.events), /private summary|connection terminated/);
	h.dispatch.finish("succeeded"); balanced(h.events);
});

test("compaction unknown values, cancellation and failure close once without fabricated billing", () => {
	const points = meter(), h = fixture(); h.install();
	for (const event of [
		{ type: "compaction_end", aborted: true },
		{ type: "compaction_end" },
		{ type: "compaction_end", result: { usage: { output: 2 } } },
	]) {
		h.emit({ type: "compaction_start" }); h.emit(event);
	}
	h.call(); h.message(usage, "error");
	h.emit({ type: "compaction_start" }); h.dispatch.cutoff();
	h.emit({ type: "compaction_end", result: { usage: { cost: { total: 0.1 } } } });
	assert.deepEqual(h.of("worker_compaction", "end").map((e) => e.attributes["slate.outcome"]), ["cancelled", "failed", "succeeded", "succeeded"]);
	assert.equal(h.of("worker_compaction", "usage")[0]!.attributes["slate.gen_ai.cost.usd"], undefined);
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => p.value), [0.3, 0.1]);
	h.dispatch.finish("failed"); balanced(h.events);
});

test("request observer failures report once and never replace provider values or errors", { timeout: 5000 }, async (t) => {
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((s: string) => { output.push(s); return true; }) as typeof process.stderr.write);
	for (let i = 0; i < 2; i++) {
		const h = fixture(); h.install(); h.emit({ type: "turn_start" });
		t.mock.method(h.telemetry, "usage", () => { throw Error("private usage"); });
		h.call(); h.message();
		h.emit({ type: "compaction_start" });
		// A broken completion observer must not become a provider error.
		h.session.agent.streamFunction = (() => ({})) as unknown as WorkerSession["agent"]["streamFunction"];
		h.install(); h.call();
		await Promise.resolve(); await Promise.resolve();
		h.dispatch.finish("cancelled");
	}
	assert.equal(output.filter((s) => s.includes("observer failed")).length, 1);
	assert.doesNotMatch(output.join(""), /private/);
});

test("undefined compaction completion is guarded once with no unhandled rejection or changed stream result", { timeout: 5000 }, async (t) => {
	const output: string[] = [], unhandled: unknown[] = [];
	t.mock.method(process.stderr, "write", ((s: string) => { output.push(s); return true; }) as typeof process.stderr.write);
	const onUnhandled = (error: unknown) => { unhandled.push(error); };
	process.on("unhandledRejection", onUnhandled);
	try {
		for (let i = 0; i < 2; i++) {
			const h = fixture(), result = Promise.resolve(undefined);
			const stream = { result: () => result };
			h.session.agent.streamFunction = (() => stream) as unknown as WorkerSession["agent"]["streamFunction"];
			h.install(); h.emit({ type: "compaction_start" });
			assert.equal(h.call(), stream); assert.equal(stream.result(), result);
			assert.equal(await stream.result(), undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			h.dispatch.finish("cancelled"); balanced(h.events);
		}
		assert.deepEqual(unhandled, []);
		assert.deepEqual(output, ["slate: telemetry observer failed. Some telemetry may be missing.\n"]);
	} finally { process.off("unhandledRejection", onUnhandled); }
});

test("rejected compaction streams and results retain their rejection and close timing without observer failures", { timeout: 5000 }, async () => {
	for (const rejectStream of [false, true]) {
		const h = fixture(), error = Error("private provider rejection");
		const rejected = Promise.reject(error);
		const stream = rejectStream ? rejected : { result: () => rejected };
		h.session.agent.streamFunction = (() => stream) as unknown as WorkerSession["agent"]["streamFunction"];
		h.install(); h.emit({ type: "compaction_start" });
		assert.equal(h.call(), stream);
		await assert.rejects(rejected, (actual) => actual === error);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(h.of("worker_model_call", "end")[0]!.attributes["slate.outcome"], "failed");
		assert.equal(Reflect.has(globalThis, FAILURE_KEY), false);
		h.dispatch.finish("failed"); balanced(h.events);
	}
});

test("provider errors keep their identity, incomplete work closes once, and off installs no request observer", async () => {
	const h = fixture(); h.emit({ type: "turn_start" });
	const error = Error("private provider error");
	h.session.agent.streamFunction = () => { throw error; }; h.install();
	assert.throws(() => h.call(), (actual) => actual === error);
	assert.equal(h.of("worker_model_call", "end")[0]!.attributes["slate.outcome"], "failed");
	assert.equal(h.events.filter((e) => e.phase === "admission").length, 0);
	h.dispatch.finish("failed"); balanced(h.events);
	const abandoned = fixture("open"); abandoned.install(); abandoned.emit({ type: "turn_start" }); abandoned.call();
	abandoned.emit({ type: "compaction_start" }); abandoned.call();
	abandoned.dispatch.finish("cancelled"); abandoned.stream.end({ role: "assistant" } as never);
	await Promise.resolve(); await Promise.resolve(); balanced(abandoned.events);
	const off = fixture("off", false); off.install(); assert.equal(off.call(), off.stream);
	assert.equal(requestObservation(off.session), undefined); off.dispatch.finish("succeeded");
	assert.deepEqual(off.events, []);
});
