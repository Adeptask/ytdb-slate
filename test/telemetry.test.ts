import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { trace, metrics, type Span, type SpanOptions, type Context, type Attributes, type TracerProvider, type MeterProvider } from "@opentelemetry/api";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Telemetry, TELEMETRY_CHANNEL, FAILURE_KEY, reportFailure, flushFailures, type TelemetryEvent } from "../extension/telemetry/core.ts";
import { registerTelemetry } from "../extension/telemetry/orchestrator.ts";
import { DispatchTelemetry } from "../extension/telemetry/dispatch.ts";
import { orchestratorCostUsd } from "../extension/state.ts";

type Recorded = { name: string; parent?: Span; attributes: Attributes; started?: Date; events: Array<{ name: string; attributes?: Attributes; time?: Date }>; ends: number; time?: Date; status?: unknown };
function provider() {
	const spans: Recorded[] = [], measurements: Array<{ name: string; value: number; labels: Attributes }> = [];
	let failSpan = false, failMetric = false;
	const tracer = { startSpan(name: string, options: SpanOptions, context: Context) {
		if (failSpan) throw Error();
		const record: Recorded = { name, parent: trace.getSpan(context), attributes: { ...options.attributes }, started: options.startTime as Date, events: [], ends: 0 };
		spans.push(record);
		return Object.assign(record, {
			spanContext: () => ({ traceId: "a".repeat(32), spanId: String(spans.length).padStart(16, "0"), traceFlags: 1 }),
			setAttributes(attributes: Attributes) { Object.assign(record.attributes, attributes); },
			addEvent(name: string, attributes?: Attributes, time?: Date) { record.events.push({ name, attributes, time }); },
			setStatus(status: unknown) { record.status = status; },
			end(time?: Date) { record.ends++; record.time = time; },
		}) as unknown as Span;
	} };
	const meter = {
		createCounter(name: string) { if (failMetric) throw Error(); return { add(value: number, labels: Attributes) { measurements.push({ name, value, labels }); } }; },
		createHistogram(name: string) { if (failMetric) throw Error(); return { record(value: number, labels: Attributes) { measurements.push({ name, value, labels }); } }; },
	};
	return { spans, measurements,
		register() {
			assert.equal(trace.setGlobalTracerProvider({ getTracer: () => tracer } as unknown as TracerProvider), true);
			assert.equal(metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider), true);
		},
		failSpans(value = true) { failSpan = value; }, failMetrics(value = true) { failMetric = value; },
	};
}
function host(logicalModel?: (provider: string, model: string) => string | undefined) {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const events: TelemetryEvent[] = [], entries: any[] = [];
	const ctx = { mode: "print", model: { provider: "provider", id: "physical" },
		sessionManager: { getSessionId: () => "session", getEntries: () => entries } } as unknown as ExtensionContext;
	const pi = { on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
		handlers.set(name, [...handlers.get(name) ?? [], handler]);
	}, events: { emit(name: string, event: TelemetryEvent) { assert.equal(name, TELEMETRY_CHANNEL); events.push(event); } } } as unknown as ExtensionAPI;
	const observer = registerTelemetry(pi, logicalModel);
	pi.on("session_start", (_event, ctx) => { observer.sessionStart(ctx); });
	observer.registerShutdown();
	return { ...observer, pi, ctx, events, entries, async emit(name: string, event: any = {}) {
		for (const handler of handlers.get(name) ?? []) assert.equal(await handler(event, ctx), undefined);
	} };
}
const usage = (cost = 0.2) => ({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 1, cost: { total: cost } });
afterEach(() => {
	trace.disable(); metrics.disable();
	Reflect.deleteProperty(globalThis, FAILURE_KEY);
});

test("late provider registration records spans and metrics without factory or session_start lookups", async () => {
	const h = host(), p = provider();
	await h.emit("session_start");
	assert.equal(h.events.length, 0);
	p.register();
	await h.emit("agent_start"); await h.emit("turn_start", { turnIndex: 0 });
	await h.emit("before_provider_request");
	await h.emit("message_end", { message: { role: "assistant" } });
	h.entries.push({ id: "assistant", type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage() } });
	await h.emit("turn_end"); await h.emit("agent_end"); await h.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(p.spans.map((s) => s.name), ["slate.orchestrator.run", "slate.orchestrator.turn", "slate.orchestrator.model"]);
	assert.equal(p.spans[1]!.parent, p.spans[0]); assert.equal(p.spans[2]!.parent, p.spans[1]);
	assert.ok(p.spans.every((s) => s.ends === 1));
	assert.equal(p.spans[2]!.attributes["slate.gen_ai.cost.usd"], 0.2);
	assert.equal(p.measurements.filter((m) => m.name === "slate.model.cost").length, 1);
});

test("parallel and nested tools keep explicit parents and expose dispatch lookup", async () => {
	const h = host(), p = provider(); p.register();
	await h.emit("session_start"); await h.emit("agent_start"); await h.emit("turn_start", { turnIndex: 0 });
	await Promise.all(["a", "b"].map((toolCallId) => h.emit("tool_execution_start", { toolCallId, toolName: "codemode", args: { private: true } })));
	await Promise.all(["a/1", "b/1"].map((toolCallId) => h.emit("tool_execution_start", { toolCallId, parentToolCallId: toolCallId[0], toolName: "thread" })));
	const span = (id: string) => p.spans.find((s) => s.attributes["slate.tool.call_id"] === id)!;
	assert.equal(span("a/1").parent, span("a")); assert.equal(span("b/1").parent, span("b"));
	const a = h.dispatch("a/1"), b = h.dispatch("b/1");
	assert.ok(a); assert.ok(b);
	b.outcome("succeeded", 0.2); a.outcome("cancelled");
	const dispatches = p.spans.filter((s) => s.name === "slate.dispatch");
	assert.equal(dispatches[0]!.parent, span("a/1")); assert.equal(dispatches[1]!.parent, span("b/1"));
	assert.equal(p.measurements.some((m) => m.name === "slate.model.cost"), false, "dispatch totals never double bill");
	assert.equal(trace.getSpan(h.toolContext("a/1")!), span("a/1"));
	assert.equal(h.toolSpan("b/1")?.kind, "tool"); assert.equal(h.toolContext("absent"), undefined);
	for (const toolCallId of ["b/1", "a/1", "b", "a"]) await h.emit("tool_execution_end", { toolCallId, isError: toolCallId === "b" });
	await h.emit("turn_end"); await h.emit("agent_end");
	assert.equal(span("b").attributes["slate.outcome"], "failed"); assert.ok(span("b").status);
	assert.equal(h.toolContext("a"), undefined);
	assert.ok(p.spans.every((s) => s.ends === 1));
	assert.equal(JSON.stringify(h.events).includes("private"), false);
});

test("every session boundary ends all open spans once before a later session starts", async () => {
	const h = host(), p = provider(); p.register();
	for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
		await h.emit("session_start"); await h.emit("agent_start"); await h.emit("turn_start", { turnIndex: 0 });
		await h.emit("before_provider_request");
		await h.emit("tool_execution_start", { toolCallId: "outer", toolName: "codemode" });
		await h.emit("tool_execution_start", { toolCallId: "inner", toolName: "thread", parentToolCallId: "outer" });
		await h.emit("session_before_compact");
		await h.emit("session_shutdown", { reason }); await h.emit("session_shutdown", { reason });
		assert.ok(p.spans.every((s) => s.ends === 1), reason);
		assert.equal(h.toolContext("inner"), undefined);
	}
});

test("reload and session switches close completed claimed thread tools before exporter flush exactly once", async () => {
	const p = provider(); p.register();
	for (const reason of ["reload", "new", "resume", "fork"]) {
		for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
			const h = host();
			await h.emit("session_start");
			await h.emit("tool_execution_start", { toolCallId: "outer", toolName: "codemode" });
			await h.emit("tool_execution_start", { toolCallId: "inner", parentToolCallId: "outer", toolName: "thread" });
			const tool = p.spans.at(-2)!;
			const dispatch = h.dispatch("inner")!.claim();
			dispatch.outcome(outcome); dispatch.finish("failed");
			await h.emit("agent_end");
			assert.equal(tool.ends, 0);
			h.pi.on("session_shutdown", () => {
				assert.equal(tool.ends, 1, reason);
				assert.equal(tool.attributes["slate.outcome"], outcome);
				assert.equal(h.dispatch("inner"), undefined);
				assert.equal(h.toolSpan("inner"), undefined);
			});
			await h.emit("session_shutdown", { reason });
			const snapshot = h.events.slice();
			await h.emit("tool_execution_end", { toolCallId: "inner", isError: outcome !== "succeeded" });
			await h.emit("session_shutdown", { reason });
			assert.deepEqual(h.events, snapshot);
			assert.equal(tool.ends, 1);
		}
	}
	assert.ok(p.spans.every((span) => span.ends === 1));
});

test("persisted session billing includes compaction, summary, usage and tool usage exactly once", async () => {
	const h = host(), p = provider(); p.register();
	h.entries.push({ id: "old", type: "usage", usage: usage(50) });
	await h.emit("session_start"); await h.emit("agent_start");
	await h.emit("turn_start", { turnIndex: 0 }); await h.emit("before_provider_request");
	await h.emit("message_end", { message: { role: "user", content: "private" } });
	await h.emit("message_end", { message: { role: "assistant" } });
	h.entries.push({ id: "a", type: "message", message: { role: "assistant", usage: usage(), provider: "p", model: "m" } });
	await h.emit("tool_execution_start", { toolCallId: "x", toolName: "x" });
	h.entries.push({ id: "t", type: "message", message: { role: "toolResult", usage: usage() } });
	await h.emit("tool_execution_end", { toolCallId: "x", isError: false }); await h.emit("turn_end");
	await h.emit("session_before_compact");
	await h.emit("before_provider_request");
	const compaction = { id: "c", type: "compaction", usage: usage(0.5), summary: "private" };
	h.entries.push(compaction); await h.emit("session_compact", { compactionEntry: compaction });
	await h.emit("session_compact", { compactionEntry: compaction });
	const summary = { id: "s", type: "branch_summary", usage: usage(), summary: "private" };
	h.entries.push(summary); await h.emit("session_tree", { summaryEntry: summary }); await h.emit("session_tree", {});
	h.entries.push({ id: "warm", type: "usage", usage: usage(), provider: "p2", model: "m2" });
	h.entries.push({ id: "custom", type: "custom" }, { id: "user", type: "message", message: { role: "user" } });
	await h.emit("agent_end"); await h.emit("session_shutdown", { reason: "quit" });
	const billed = h.events.filter((e) => e.phase === "usage");
	assert.equal(billed.length, 5);
	assert.equal(billed.reduce((n, e) => n + e.attributes["slate.gen_ai.cost.usd"]!, 0), 1.3);
	assert.equal(p.measurements.filter((m) => m.name === "slate.model.cost").reduce((n, m) => n + m.value, 0), 1.3);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const attribute = { input: "gen_ai.usage.input_tokens", output: "gen_ai.usage.output_tokens",
			cacheRead: "gen_ai.usage.cache_read.input_tokens", cacheWrite: "gen_ai.usage.cache_creation.input_tokens" }[key];
		assert.equal(billed.reduce((n, e) => n + (e.attributes as Record<string, number>)[attribute]!, 0), usage()[key] * 5);
	}
	const compactSpan = p.spans.find((s) => s.attributes["slate.kind"] === "compaction")!;
	assert.equal(compactSpan.attributes["slate.gen_ai.cost.usd"], 0.5);
	assert.equal(compactSpan.attributes["gen_ai.provider.name"], undefined, "pi does not expose the compaction route");
	assert.ok(p.spans.every((s) => s.ends === 1));
	assert.equal(JSON.stringify(h.events).includes("private"), false);
});

test("unknown usage stays absent, all compaction outcomes close, and abandoned requests end", async () => {
	const h = host(), p = provider(); p.register();
	await h.emit("session_start");
	for (const aborted of [true, false]) {
		await h.emit("session_before_compact"); await h.emit("session_compact_failed", { aborted });
	}
	await h.emit("before_provider_request"); await h.emit("before_provider_request");
	await h.emit("message_end", { message: { role: "assistant" } });
	h.entries.push({ id: "unknown", type: "message", message: { role: "assistant", usage: {} } });
	await h.emit("turn_end"); await h.emit("agent_end");
	assert.equal(p.measurements.some((m) => m.name === "slate.model.cost"), false);
	assert.equal(p.measurements.some((m) => m.name === "slate.model.tokens"), false);
	assert.equal(p.spans.find((s) => s.attributes["slate.outcome"] === "aborted")?.ends, 1);
	assert.ok(p.spans.every((s) => s.ends === 1));
});

test("publication is frozen and cannot mutate span or metric mapping", () => {
	const p = provider(); p.register();
	let attempts = 0;
	const telemetry = new Telemetry((event) => {
		assert.ok(Object.isFrozen(event)); assert.ok(Object.isFrozen(event.attributes));
		try { (event.attributes as any)["slate.gen_ai.cost.usd"] = 900; } catch { attempts++; }
		try { (event as any).phase = "start"; } catch { attempts++; }
	});
	const span = telemetry.start("model", { "slate.session.id": "id" });
	telemetry.usage(span, { "slate.gen_ai.cost.usd": 0.7, "gen_ai.usage.input_tokens": 4, "slate.session.id": "id", private: "secret" } as any);
	telemetry.end(span, { "slate.outcome": "failed" });
	assert.equal(attempts, 6);
	assert.equal(p.spans[0]!.attributes["slate.gen_ai.cost.usd"], 0.7);
	assert.equal(p.spans[0]!.attributes.private, undefined);
	assert.equal(p.measurements.find((m) => m.name === "slate.model.cost")!.value, 0.7);
	assert.ok(p.measurements.every((m) => m.labels["slate.session.id"] === undefined));
});

test("off switch prevents both outputs and observer work", async (t) => {
	const before = process.env.SLATE_TELEMETRY;
	process.env.SLATE_TELEMETRY = "0";
	t.after(() => { if (before === undefined) delete process.env.SLATE_TELEMETRY; else process.env.SLATE_TELEMETRY = before; });
	const h = host(), p = provider(); p.register();
	await h.emit("session_start"); await h.emit("agent_start"); await h.emit("turn_start");
	await h.emit("before_provider_request"); await h.emit("tool_execution_start");
	h.change("start", "change-20261103T045739Z-f8537843366591cf99a9ba56e7aeb3e4", "tool");
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(p.spans.length, 0); assert.equal(p.measurements.length, 0); assert.equal(h.events.length, 0);
});

test("sink failures are isolated and reported once per kind in non-TUI modes", async (t) => {
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stderr.write);
	const p = provider(); p.register(); p.failSpans(); p.failMetrics();
	const events: TelemetryEvent[] = [];
	const telemetry = new Telemetry((e) => { events.push(e); throw Error(); });
	for (const mode of ["print", "json", "rpc"]) {
		telemetry.mode = mode;
		const span = telemetry.start("model");
		telemetry.usage(span, { "slate.gen_ai.cost.usd": 1 }); telemetry.end(span);
		telemetry.guard("observer", () => { throw Error(); });
	}
	assert.equal(output.length, 4); assert.equal(events.length, 9);
	assert.deepEqual(output.map((s) => s.split(" ")[2]).sort(), ["metrics", "observer", "publication", "spans"]);
	p.failSpans(false); p.failMetrics(false);
	const span = telemetry.start("model"); telemetry.usage(span, { "slate.gen_ai.cost.usd": 1 }); telemetry.end(span);
	assert.equal(p.spans[0]!.ends, 1);
	assert.equal(output.length, 4);
});

test("TUI reports survive a new observer and reload and flush only on quit", async (t) => {
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((chunk: string) => { output.push(chunk); return true; }) as typeof process.stderr.write);
	const h = host(); Object.assign(h.ctx, { mode: "tui" });
	await h.emit("session_start");
	h.telemetry.guard("spans", () => { throw Error(); });
	await h.emit("session_shutdown", { reason: "reload" }); assert.equal(output.length, 0);
	const next = host(); Object.assign(next.ctx, { mode: "tui" });
	await next.emit("session_start");
	next.telemetry.guard("spans", () => { throw Error(); });
	next.telemetry.guard("metrics", () => { throw Error(); });
	await next.emit("session_shutdown", { reason: "quit" });
	assert.equal(output.length, 2);
	await next.emit("session_shutdown", { reason: "quit" }); assert.equal(output.length, 2);
	reportFailure("publication", "print"); assert.equal(output.length, 3);
	reportFailure("publication", "tui"); flushFailures(); assert.equal(output.length, 3);
});

test("broken reporting and broken observer input never escape into pi", async (t) => {
	t.mock.method(process.stderr, "write", (() => { throw Error(); }) as typeof process.stderr.write);
	const h = host();
	await h.emit("session_start"); await h.emit("message_end", {});
	await h.emit("session_shutdown", { reason: "quit" });
});

test("change events map once to causing tools or lazy session metadata", async () => {
	const h = host(), p = provider(); p.register();
	const folder = "change-20261103T045739Z-f8537843366591cf99a9ba56e7aeb3e4";
	await h.emit("session_start"); h.change("start", folder, "allocation");
	assert.equal(p.spans.length, 0); assert.equal(h.events.length, 1);
	h.change("start", "invalid", "allocation"); assert.equal(h.events.length, 1);
	await h.emit("agent_start"); assert.equal(p.spans[0]!.events.length, 1);
	await h.emit("tool_execution_start", { toolCallId: "change", toolName: "slate_change" });
	h.change("close", folder, "tool", "change");
	assert.equal(p.spans[2]!.events.length, 1);
	assert.equal(p.spans[1]!.events.length, 0);
	assert.equal(p.spans[0]!.events.length, 1);
	await h.emit("tool_execution_end", { toolCallId: "change" }); await h.emit("agent_end");
	assert.equal(h.events.filter((e) => e.phase === "change").length, 2);
	h.change("close", folder, "allocation_failed");
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(p.spans[3]!.events.length, 1); assert.equal(p.spans[3]!.ends, 1);
});

test("queued startup changes use a bounded session span without creating or extending a run", async (t) => {
	let now = 1000; t.mock.method(Date, "now", () => now);
	const p = provider();
	const folder = "change-20261103T045739Z-f8537843366591cf99a9ba56e7aeb3e4";
	for (const withRun of [false, true]) {
		for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
			const h = host(), spanOffset = p.spans.length, metricOffset = p.measurements.length;
			await h.emit("session_start"); h.change("start", folder, "allocation");
			now += 500; h.change("close", folder, "allocation_failed");
			const changes = h.events.filter((e) => e.phase === "change");
			assert.equal(changes.length, 2);
			assert.equal(p.spans.length, spanOffset, "startup must not consult a provider");
			if (!spanOffset) p.register();
			now += 10000;
			if (withRun) {
				await h.emit("agent_start"); now += 100; await h.emit("agent_end");
			}
			await h.emit("session_shutdown", { reason }); await h.emit("session_shutdown", { reason });
			const spans = p.spans.slice(spanOffset), metadata = spans[0]!;
			assert.equal(h.events.find((e) => e.kind === "session" && e.phase === "end")?.durationSeconds, undefined);
			assert.equal(p.measurements.slice(metricOffset).some((m) => m.labels["slate.kind"] === "session"), false);
			assert.equal(metadata.name, "slate.orchestrator.session");
			assert.equal(metadata.parent, undefined); assert.equal(metadata.ends, 1);
			assert.equal(metadata.attributes["slate.session.instance_id"], changes[0]!.id);
			assert.equal(metadata.started!.getTime(), changes[0]!.time);
			assert.equal(metadata.time!.getTime(), changes[1]!.time);
			assert.deepEqual(metadata.events.map((e) => e.time!.getTime()), changes.map((e) => e.time));
			assert.ok(metadata.events.every((e) => metadata.started! <= e.time! && e.time! <= metadata.time!));
			assert.deepEqual(h.events.filter((e) => e.phase === "change"), changes, "publish each change once");
			const runs = spans.filter((s) => s.name === "slate.orchestrator.run");
			assert.equal(runs.length, withRun ? 1 : 0);
			assert.deepEqual(h.events.filter((e) => e.kind === "run" && e.phase === "end").map((e) => e.durationSeconds), withRun ? [0.1] : []);
			assert.deepEqual(p.measurements.slice(metricOffset).filter((m) => m.labels["slate.kind"] === "run").map((m) => [m.name, m.value]),
				withRun ? [["slate.duration", 0.1]] : []);
			if (withRun) {
				assert.equal(runs[0]!.started!.getTime(), changes[1]!.time + 10000);
				assert.equal(runs[0]!.events.length, 0); assert.equal(runs[0]!.ends, 1);
			}
		}
	}
});

test("scan-only billing omits unknown duration and records tokens and cost once", async (t) => {
	let now = 1000; t.mock.method(Date, "now", () => now);
	const h = host(), p = provider(); p.register();
	await h.emit("session_start"); await h.emit("session_before_tree");
	now += 5000;
	const summary = { id: "summary", type: "branch_summary", usage: usage() };
	h.entries.push(summary, { id: "usage", type: "usage", usage: usage() },
		{ id: "tool", type: "message", message: { role: "toolResult", usage: usage() } });
	await h.emit("session_tree", { summaryEntry: summary }); await h.emit("session_tree", { summaryEntry: summary });
	await h.emit("session_shutdown", { reason: "quit" }); await h.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(p.spans.map((s) => s.attributes["slate.kind"]), ["branch_summary", "session_usage", "tool_usage"]);
	assert.ok(p.spans.every((s) => s.ends === 1 && s.parent === undefined));
	assert.equal(h.events.filter((e) => e.phase === "usage").length, 3);
	assert.ok(h.events.filter((e) => e.phase === "end").every((e) => e.durationSeconds === undefined));
	assert.equal(p.measurements.filter((m) => m.name === "slate.duration").length, 0);
	for (const kind of ["branch_summary", "session_usage", "tool_usage"]) {
		const measured = p.measurements.filter((m) => m.labels["slate.kind"] === kind);
		assert.deepEqual(measured.filter((m) => m.name === "slate.model.cost").map((m) => m.value), [0.2]);
		assert.deepEqual(measured.filter((m) => m.name === "slate.model.tokens").map((m) => m.value), [11, 7, 3, 2, 1]);
	}
});

test("non-finite usage is omitted rather than reported as zero", () => {
	const events: TelemetryEvent[] = [], telemetry = new Telemetry((e) => { events.push(e); });
	const span = telemetry.start("model");
	telemetry.usage(span, { "slate.gen_ai.cost.usd": NaN, "gen_ai.usage.input_tokens": -1, "gen_ai.usage.output_tokens": Infinity });
	assert.deepEqual(events.at(-1)!.attributes, {});
	telemetry.end(span);
});

test("logical and physical route labels follow billed assistant metadata", async () => {
	const h = host((provider, model) => provider === "p" && model === "m" ? "logical" : undefined), p = provider(); p.register();
	await h.emit("session_start"); await h.emit("turn_start", { turnIndex: 0 });
	await h.emit("before_provider_request"); await h.emit("message_end", { message: { role: "assistant" } });
	h.entries.push({ id: "routed", type: "message", message: { role: "assistant", provider: "p", model: "m", responseModel: "served", usage: usage() } });
	await h.emit("turn_end"); await h.emit("agent_end");
	const cost = p.measurements.find((m) => m.name === "slate.model.cost")!;
	assert.equal(cost.labels["slate.logical_model"], "logical");
	assert.equal(cost.labels["gen_ai.provider.name"], "p");
	assert.equal(cost.labels["gen_ai.request.model"], "m");
	assert.equal(cost.labels["gen_ai.response.model"], "served");
});

test("a billing scan failure cannot leave existing spans open at shutdown", async (t) => {
	const h = host(), p = provider(); p.register();
	await h.emit("session_start"); await h.emit("agent_start");
	await h.emit("turn_start", { turnIndex: 0 }); await h.emit("before_provider_request");
	t.mock.method(h.ctx.sessionManager, "getEntries", () => { throw Error(); });
	t.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
	await h.emit("session_shutdown", { reason: "quit" });
	assert.ok(p.spans.every((span) => span.ends === 1));
});

test("out-of-run compaction and summary billing cannot absorb idle time or the next run", async (t) => {
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const h = host(), p = provider(); p.register();
	await h.emit("session_start");
	const run = async () => {
		await h.emit("agent_start"); now += 100;
		await h.emit("agent_end");
	};
	await run();
	for (const work of ["threshold", "manual", "failed", "cancelled", "aborted", "summary", "tree_failed", "tree_cancelled"]) {
		now += 10000;
		const count = p.spans.length;
		if (work.startsWith("tree_") || work === "summary") {
			// Pi exposes no failed-tree completion hook. Only persisted summaries open a span.
			const abort = new AbortController();
			await h.emit("session_before_tree", { preparation: { userWantsSummary: true }, signal: abort.signal });
			now += 200;
			if (work === "summary") {
				const summary = { id: work, type: "branch_summary", usage: usage() };
				h.entries.push(summary); await h.emit("session_tree", { summaryEntry: summary });
				await h.emit("session_tree", { summaryEntry: summary });
			} else if (work === "tree_cancelled") abort.abort();
		} else {
			await h.emit("session_before_compact", { reason: work });
			now += 200;
			if (work === "threshold" || work === "manual") {
				const compact = { id: work, type: "compaction", usage: usage() };
				h.entries.push(compact); await h.emit("session_compact", { compactionEntry: compact });
			} else await h.emit("session_compact_failed", { aborted: work !== "failed" });
		}
		assert.ok(p.spans.slice(count).every((s) => s.ends === 1 && s.parent === undefined), work);
		assert.ok(p.spans.every((s) => s.ends === 1), work);
		now += 10000;
		await run();
	}
	await h.emit("session_shutdown", { reason: "quit" });
	const runs = h.events.filter((e) => e.kind === "run" && e.phase === "end");
	assert.equal(runs.length, 9);
	assert.ok(runs.every((e) => e.durationSeconds === 0.1));
	assert.deepEqual(p.measurements.filter((m) => m.name === "slate.duration" && m.labels["slate.kind"] === "run").map((m) => m.value),
		Array(9).fill(0.1));
	assert.equal(h.events.filter((e) => e.phase === "usage").length, 3);
	assert.equal(p.measurements.filter((m) => m.name === "slate.model.cost").length, 3);
	assert.equal(p.spans.filter((s) => s.attributes["slate.kind"] === "compaction").length, 5);
	assert.equal(p.spans.filter((s) => s.attributes["slate.kind"] === "branch_summary").length, 1);
});

test("new assistant telemetry cost equals its orchestratorCostUsd contribution", async () => {
	const h = host(), p = provider(); p.register();
	h.entries.push({ id: "inherited", type: "message", message: { role: "assistant", usage: usage(5) } });
	await h.emit("session_start");
	const before = orchestratorCostUsd(h.ctx);
	await h.emit("agent_start");
	for (const [id, cost] of [["first", 0.125], ["second", 0.375]] as const) {
		await h.emit("before_provider_request"); await h.emit("message_end", { message: { role: "assistant" } });
		h.entries.push({ id, type: "message", message: { role: "assistant", provider: "p", model: "m", usage: usage(cost) } });
		await h.emit("turn_end");
	}
	await h.emit("agent_end");
	await h.emit("session_before_compact");
	const compact = { id: "compaction", type: "compaction", usage: usage(1) };
	h.entries.push(compact); await h.emit("session_compact", { compactionEntry: compact });
	const summary = { id: "summary", type: "branch_summary", usage: usage(2) };
	h.entries.push(summary); await h.emit("session_tree", { summaryEntry: summary });
	await h.emit("session_shutdown", { reason: "quit" });
	const assistantCost = p.measurements.filter((m) => m.name === "slate.model.cost" && m.labels["slate.kind"] === "model")
		.reduce((n, m) => n + m.value, 0);
	assert.equal(assistantCost, 0.5);
	assert.equal(assistantCost, orchestratorCostUsd(h.ctx) - before);
	assert.equal(p.measurements.filter((m) => m.name === "slate.model.cost").reduce((n, m) => n + m.value, 0), 3.5);
});

test("startup events identify their session and instance and join the later run", async (t) => {
	let now = 1000; t.mock.method(Date, "now", () => now);
	const folder = "change-20261103T045739Z-f8537843366591cf99a9ba56e7aeb3e4";
	const h = host(), reloaded = host(), p = provider(); p.register();
	const ids: string[] = [];
	for (const [observer, sessionId] of [[h, "first"], [h, "second"], [reloaded, "second"]] as const) {
		t.mock.method(observer.ctx.sessionManager, "getSessionId", () => sessionId);
		await observer.emit("session_start"); observer.change("start", folder, "allocation");
		const change = observer.events.at(-1)!;
		assert.equal(change.version, 1); assert.equal(change.kind, "session");
		assert.equal(change.attributes["slate.session.id"], sessionId);
		assert.equal(change.id, change.attributes["slate.session.instance_id"]);
		ids.push(change.id);
		now += 10000; await observer.emit("agent_start");
		const start = observer.events.at(-1)!;
		assert.equal(start.attributes["slate.session.instance_id"], change.id);
		assert.equal(start.time, now);
		now += 100; await observer.emit("agent_end");
	}
	assert.equal(new Set(ids).size, 3);
	assert.ok(h.events.filter((e) => e.phase === "end" && e.kind === "run").every((e) => e.durationSeconds === 0.1));
	assert.ok(p.spans.every((s) => s.ends === 1));
});

test("event identifiers distinguish extension instances across reloads", () => {
	const events: TelemetryEvent[] = [];
	const first = new Telemetry((event) => { events.push(event); });
	const second = new Telemetry((event) => { events.push(event); });
	first.start("run"); second.start("run");
	assert.notEqual(events[0]!.id, events[1]!.id);
});


test("worker names, parents and duration labels share the versioned event model", () => {
	const p = provider(); p.register();
	const events: TelemetryEvent[] = [];
	const telemetry = new Telemetry((e) => events.push(e));
	const parent = telemetry.start("dispatch", { "slate.session.id": "session", "slate.change": "change", "slate.track": "6" });
	const attempt = telemetry.start("worker_attempt", { ...parent!.attributes, "slate.attempt.index": 0, "slate.logical_model": "logical", "slate.thread.type": "general" }, parent);
	const turn = telemetry.start("worker_turn", { ...attempt!.attributes, "slate.turn.index": 2 }, attempt);
	const tool = telemetry.start("worker_tool", { ...turn!.attributes, "slate.tool.call_id": "id", "slate.tool.name": "read" }, turn);
	for (const span of [tool, turn, attempt, parent]) telemetry.end(span);
	assert.deepEqual(p.spans.map((s) => s.name), ["slate.dispatch", "slate.worker.attempt", "slate.worker.turn", "slate.worker.tool"]);
	for (let i = 1; i < p.spans.length; i++) assert.equal(p.spans[i]!.parent, p.spans[i - 1]);
	assert.ok(p.spans.every((s) => s.ends === 1));
	assert.ok(events.every((e) => e.version === 1 && Object.isFrozen(e.attributes)));
	assert.equal(events.find((e) => e.kind === "worker_tool")!.attributes["slate.attempt.index"], 0);
	assert.equal(p.measurements.length, 4);
	for (const m of p.measurements) {
		assert.equal(m.name, "slate.duration");
		assert.ok(Object.keys(m.labels).every((key) => ["slate.kind", "slate.logical_model", "slate.thread.type"].includes(key)));
	}
});

test("worker model names, admission events and request indexes map to spans without metric labels", () => {
	const p = provider(); p.register();
	const telemetry = new Telemetry(() => {});
	const turn = telemetry.start("worker_turn");
	telemetry.admission(undefined, "wait");
	telemetry.admission(turn, "wait"); telemetry.admission(turn, "refused");
	const call = telemetry.start("worker_model_call", { "slate.request.index": 0, "slate.attempt.index": 0 }, turn);
	const compaction = telemetry.start("worker_compaction", {}, turn);
	telemetry.end(call); telemetry.end(compaction); telemetry.end(turn);
	assert.deepEqual(p.spans.map((s) => s.name), ["slate.worker.turn", "slate.worker.model_call", "slate.worker.compaction"]);
	assert.deepEqual(p.spans[0]!.events.map((e) => e.name), ["slate.request.wait", "slate.request.refused"]);
	assert.equal(p.spans[1]!.parent, p.spans[0]);
	assert.equal(p.spans[1]!.attributes["slate.request.index"], 0);
	assert.ok(p.measurements.every((p) => !("slate.request.index" in p.labels)));
});

test("nested orchestrator tools end on their own results after agent_end", async () => {
	const h = host(), p = provider(); p.register();
	await h.emit("session_start"); await h.emit("turn_start", { turnIndex: 0 });
	await h.emit("tool_execution_start", { toolCallId: "outer", toolName: "codemode" });
	await h.emit("tool_execution_start", { toolCallId: "inner", parentToolCallId: "outer", toolName: "read" });
	const inner = p.spans.find((s) => s.attributes["slate.tool.call_id"] === "inner")!;
	await h.emit("turn_end"); await h.emit("agent_end"); await h.emit("agent_end");
	assert.equal(inner.ends, 0);
	await h.emit("tool_execution_end", { toolCallId: "inner", isError: true });
	assert.equal(inner.ends, 1); assert.equal(inner.attributes["slate.outcome"], "failed");
	await h.emit("tool_execution_end", { toolCallId: "inner", isError: false });
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(inner.ends, 1);
	assert.equal(h.toolSpan("inner"), undefined);
});

test("final teardown closes nested tools that never publish a result", async () => {
	const h = host(), p = provider(); p.register();
	await h.emit("tool_execution_start", { toolCallId: "outer", toolName: "codemode" });
	await h.emit("tool_execution_start", { toolCallId: "inner", parentToolCallId: "outer", toolName: "read" });
	await h.emit("agent_end");
	assert.equal(p.spans.find((s) => s.attributes["slate.tool.call_id"] === "inner")!.ends, 0);
	await h.emit("session_shutdown", { reason: "quit" });
	assert.ok(p.spans.every((s) => s.ends === 1));
});

test("worker sink failures report once per kind and TUI reporting waits for quit", async (t) => {
	const h = host(), p = provider(); p.register(); h.ctx.mode = "tui";
	await h.emit("session_start");
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((s: string) => { output.push(s); return true; }) as typeof process.stderr.write);
	p.failMetrics(); p.failSpans();
	for (let i = 0; i < 2; i++) {
		const dispatch = new DispatchTelemetry(h.telemetry).claim();
		let listener!: (event: any) => void;
		dispatch.worker({ sessionManager: { appendCustomEntry() {} }, subscribe(fn) { listener = fn; return () => {}; } });
		listener({ type: "turn_start" }); listener({ type: "turn_end" });
		dispatch.finish("succeeded");
	}
	assert.equal(output.length, 0);
	await h.emit("session_shutdown", { reason: "reload" }); assert.equal(output.length, 0);
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(output.filter((s) => s.includes("spans failed")).length, 1);
	assert.equal(output.filter((s) => s.includes("metrics failed")).length, 1);
});
