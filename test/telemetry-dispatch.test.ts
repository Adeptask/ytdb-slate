import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { registerTelemetry } from "../extension/telemetry/orchestrator.ts";
import { FAILURE_KEY, type TelemetryEvent } from "../extension/telemetry/core.ts";
import { WORKER_IDENTITY_TYPE } from "../extension/telemetry/dispatch.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";
import extension from "../extension/index.ts";

afterEach(() => { Reflect.deleteProperty(globalThis, FAILURE_KEY); });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
function fixture(t: TestContext, mode = "ok") {
	const root = mkdtempSync(join(tmpdir(), "slate-dispatch-telemetry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const handlers = new Map<string, any[]>(), tools = new Map<string, any>(), events: TelemetryEvent[] = [];
	const pi = { on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
		getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [], getThinkingLevel: () => "off",
		events: { emit(_name: string, event: TelemetryEvent) { events.push(event); if (mode === "publication-failure") throw Error("publication"); } },
		appendEntry() {
			if (mode === "running-save" && [...store.threads.values()].some((x) => x.status === "running")) throw Error("save");
			if (mode.includes("stored-save") && store.episodes.size) throw Error("save");
			if (mode === "cancel-save" && [...store.threads.values()].some((x) => x.status === "cancelled")) throw Error("save");
			if (mode === "abort-save" && validation > 1 && !store.threads.size) throw Error("save");
		},
	} as unknown as ExtensionAPI;
	const indexShutdown = mode.startsWith("shutdown");
	const observer = indexShutdown ? undefined : registerTelemetry(pi);
	let store = new SlateStore(pi);
	let validation = 0;
	const base = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: {
		include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50,
			preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }],
	} } } });
	const entered = deferred(), release = deferred();
	const runtime = Object.freeze({ ...base, async validateRoute() {
		validation++;
		if ((mode === "admission-pause" || mode === "shutdown-admission") && validation === 1) { entered.resolve(); await release.promise; }
		return mode.startsWith("abort") && validation > 1
			? { ok: false, kind: "unavailable", reason: "route changed" } as const : { ok: true } as const;
	} });
	let manager = new ThreadManager(store, { maxConcurrent: 2 }, undefined, runtime);
	if (mode === "busy") (manager as any).logicalRuntime = { ...runtime, ownership: { acquire: () => ({ kind: "busy" }) } };
	const parent = SessionManager.create(root, join(root, "parent"));
	const ctx = { cwd: root, mode: "rpc", hasUI: false, sessionManager: parent } as unknown as ExtensionContext;
	observer?.sessionStart(ctx);
	if (observer) {
		registerSlateTools(pi, store, () => manager, observer.dispatch);
		observer.registerShutdown();
	} else extension(pi);
	const controller = new AbortController();
	const sessions: SessionManager[] = [];
	let opens = 0;
	let internal = manager as any;
	const openWorkerFor = async (args: any) => {
		opens++;
		const listeners = new Set<(event: any) => void>();
		const sessionManager = SessionManager.create(root, join(root, "workers"));
		sessions.push(sessionManager);
		const session = { sessionManager, messages: [] as any[], model: { provider: "test", id: "worker" }, thinkingLevel: "off",
			subscribe(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
			async sendCustomMessage() {}, setThinkingLevel() {},
			async abort() { if (mode === "shutdown") { controller.abort(); release.resolve(); } },
			closeManagedOperations() {}, async settleManagedOperations() {},
			async shutdownWorker() {
				if (mode === "cleanup-pause") { entered.resolve(); await release.promise; }
				if (mode.startsWith("cleanup")) throw Error("cleanup");
			},
			async prompt() {
				sessionManager.appendMessage({ role: "user", content: "private task", timestamp: 1 });
				if (mode === "parallel" || mode === "shutdown") { entered.resolve(); await release.promise; }
				if (mode === "shutdown" || mode === "cancel" || mode === "cancel-save") { controller.abort(); throw Error("cancelled"); }
				if (mode.includes("storage")) writeFileSync(join(root, ".pi"), "block episode");
				if (mode.startsWith("empty")) throw Error("empty failure");
				const message = { role: "assistant", provider: "test", model: "worker", api: "openai-responses",
					stopReason: mode === "failed" ? "error" : "stop", errorMessage: mode === "failed" ? "private error" : undefined,
					content: [{ type: "text", text: "private result" }], timestamp: 2,
					usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } } };
				session.messages.push(message); sessionManager.appendMessage(message as any);
				for (const fn of listeners) {
					fn({ type: "message_end", message });
					fn({ type: "compaction_end", result: { usage: { input: 5, output: 4, cost: { total: 0.2 } } }, aborted: false });
				}
			},
		};
		if (mode === "identity-failure") (sessionManager as any).appendCustomEntry = () => { throw Error("identity"); };
		args.observeSession(session);
		if (mode === "startup-cancel") {
			controller.abort(); args.observeStartupFailure("startup"); throw Error("startup");
		}
		bindFakeWorkerRequest(session, args.requestContract);
		internal.live.set(args.thread.id, session);
		return { session };
	};
	internal.openWorkerFor = openWorkerFor;
	if (indexShutdown) {
		const dispatch = ThreadManager.prototype.dispatch;
		t.mock.method(ThreadManager.prototype, "dispatch", function(this: ThreadManager, ...args: Parameters<ThreadManager["dispatch"]>) {
			manager = this; internal = this; store = internal.store;
			internal.logicalRuntime = runtime; internal.openWorkerFor = openWorkerFor;
			return Reflect.apply(dispatch, this, args);
		});
	}
	const emit = async (name: string, event: any) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
	return { root, get store() { return store; }, get manager() { return manager; }, observer, ctx, events, tools, sessions, controller, entered, release,
		opens: () => opens, emit,
		async call(id = "call", params: Record<string, unknown> = {}, parentToolCallId?: string) {
			await emit("tool_execution_start", { toolCallId: id, toolName: "thread", parentToolCallId });
			try {
				const result = await tools.get("thread").execute(id, { type: "general", task: "private task", model: "fixture", reason: "private reason", ...params }, controller.signal, undefined, ctx);
				await emit("tool_execution_end", { toolCallId: id, toolName: "thread", isError: false }); return result;
			} catch (error) { await emit("tool_execution_end", { toolCallId: id, toolName: "thread", isError: true }); throw error; }
		},
		outcomes: () => events.filter((e) => e.kind === "dispatch" && e.phase === "end"),
	};
}

test("real dispatch outcome paths agree with local charges and stored episodes", async (t) => {
	for (const [mode, outcome, recorded, cost] of [
		["ok", "succeeded", true, 0.5], ["failed", "failed", true, 0.5],
		["empty", "failed", true, 0], ["stored-save", "stored but failed", true, 0.5],
		["empty-stored-save", "stored but failed", true, 0],
		["storage", "failed", false, 0.5], ["empty-storage", "failed", false, 0],
		["running-save", "failed", false, undefined], ["busy", "rejected", false, undefined],
		["abort", "aborted", false, undefined], ["abort-save", "aborted", false, undefined],
		["cancel", "cancelled", false, undefined], ["cancel-save", "cancelled", false, undefined],
		["startup-cancel", "cancelled", false, undefined], ["cleanup", "succeeded", true, 0.5],
	] as const) {
		const h = fixture(t, mode);
		await h.call().catch(() => {});
		const ends = h.outcomes(); assert.equal(ends.length, 1, mode);
		const attrs = ends[0]!.attributes;
		assert.equal(attrs["slate.outcome"], outcome, mode); assert.equal(attrs["slate.episode.recorded"], String(recorded), mode);
		assert.equal(attrs["slate.gen_ai.cost.usd"], cost, mode);
		assert.equal(h.store.workerCostUsd, cost ?? 0, mode);
		assert.equal(h.store.episodes.size, recorded ? 1 : 0, mode);
		if (recorded) {
			const episode = [...h.store.episodes.values()][0]!;
			for (const [key, value] of [["input_tokens", episode.input], ["output_tokens", episode.output]] as const) assert.equal(attrs[`gen_ai.usage.${key}`], value);
			assert.equal(attrs["slate.dispatch.final_model"], episode.model);
		}
		assert.equal(attrs["slate.change"], undefined); assert.equal(attrs["slate.track"], undefined);
		await h.manager.disposeAll();
	}
});

test("rejected wrapper arguments and pi pre-execute rejection have one outer fallback", async (t) => {
	const h = fixture(t);
	for (const params of [{ trackNumber: "01" }, { model: "missing" }, { type: "implementer", trackNumber: null }]) {
		await assert.rejects(h.call(String(h.outcomes().length), params));
		assert.equal(h.outcomes().at(-1)!.attributes["slate.outcome"], "rejected");
	}
	await h.emit("tool_execution_start", { toolCallId: "pi-refused", toolName: "thread" });
	assert.throws(() => h.tools.get("thread").prepareArguments({ trackNumber: "0" }));
	await h.emit("tool_execution_end", { toolCallId: "pi-refused", isError: true });
	assert.equal(h.outcomes().length, 4); assert.equal(h.opens(), 0);
});

test("cancelled before start retains no episode", async (t) => {
	const h = fixture(t); h.controller.abort();
	await assert.rejects(h.call());
	assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], "cancelled before start");
	assert.equal(h.outcomes()[0]!.attributes["slate.episode.recorded"], "false");
	assert.equal(h.opens(), 0);
});

test("parallel dispatches retain their own explicit tool parents, charge and canonical track", async (t) => {
	const h = fixture(t, "parallel");
	const change = "change-20261103T045739Z-f8537843366591cf99a9ba56e7aeb3e4";
	mkdirSync(join(h.root, "slate-changes", change), { recursive: true }); h.store.currentChange = change;
	const a = h.call("a", { trackNumber: 3 }), b = h.call("b", { trackNumber: "4.2" });
	await h.entered.promise;
	while (h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
	h.store.workerCostUsd += 12;
	h.store.currentChange = undefined;
	h.release.resolve(); await Promise.all([a, b]);
	const ends = h.outcomes(); assert.equal(ends.length, 2);
	for (const [id, track] of [["a", "3"], ["b", "4.2"]]) {
		const tool = h.events.find((e) => e.kind === "tool" && e.phase === "start" && e.attributes["slate.tool.call_id"] === id)!;
		const end = ends.find((e) => e.parentId === tool.id)!;
		assert.equal(end.attributes["slate.track"], track);
		assert.equal(end.attributes["slate.change"], change);
		const identity = h.sessions.map((sm) => sm.getEntries().find((e) => e.type === "custom" && e.customType === WORKER_IDENTITY_TYPE))
			.find((e: any) => e.data.track === track) as any;
		assert.equal(identity.data.change, change); assert.equal(identity.data.threadId, end.attributes["slate.thread.id"]);
		assert.equal(end.attributes["slate.gen_ai.cost.usd"], 0.5);
	}
	assert.equal(h.store.workerCostUsd, 13);
	assert.notEqual(ends[0]!.attributes["slate.thread.id"], ends[1]!.attributes["slate.thread.id"]);
	assert.doesNotMatch(JSON.stringify(h.events), /private task|private result|private error|private reason/);
});

test("teardown cancels a queued dispatch before start and every call finishes once", async (t) => {
	const h = fixture(t, "parallel");
	const a = h.call("a"), b = h.call("b"), queued = h.call("queued");
	const results = Promise.allSettled([a, b, queued]);
	await h.entered.promise;
	while (h.store.threads.size < 3 || h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
	const shutdown = h.manager.disposeAll();
	h.release.resolve(); await results; await shutdown;
	const outcome = h.outcomes().find((e) => e.attributes["slate.tool.call_id"] === "queued")!;
	assert.equal(outcome.attributes["slate.outcome"], "cancelled before start");
	assert.equal(outcome.attributes["slate.episode.recorded"], "false");
	assert.equal(h.opens(), 2); assert.equal(h.outcomes().length, 3);
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(h.outcomes().length, 3);
});

test("nested dispatches outlive agent_end and retain queued cancellation and running charges", { timeout: 5000 }, async (t) => {
	for (const boundary of ["agent_end", "session_shutdown"]) {
		const h = fixture(t, "parallel");
		await h.emit("tool_execution_start", { toolCallId: "codemode", toolName: "codemode" });
		const a = h.call("a", {}, "codemode"), b = h.call("b", {}, "codemode"), queued = h.call("queued", {}, "codemode");
		const results = Promise.allSettled([a, b, queued]);
		await h.entered.promise;
		while (h.store.threads.size < 3 || h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
		await h.emit("tool_execution_start", { toolCallId: "unclaimed", toolName: "thread", parentToolCallId: "codemode" });
		await h.emit(boundary, { reason: "reload" });
		await h.emit(boundary, { reason: "reload" });
		assert.deepEqual(h.outcomes().map((e) => e.attributes["slate.outcome"]), ["rejected"]);
		assert.equal(h.events.filter((e) => e.kind === "tool" && e.phase === "end" && e.attributes["slate.tool.call_id"] !== "codemode").length, 1);
		await h.emit("tool_execution_end", { toolCallId: "queued", isError: true });
		assert.equal(h.outcomes().length, 1);
		h.controller.abort(); h.release.resolve();
		await results;
		assert.equal(h.outcomes().length, 4);
		for (const id of ["a", "b", "queued", "unclaimed"]) {
			const ends = h.outcomes().filter((e) => e.attributes["slate.tool.call_id"] === id);
			assert.equal(ends.length, 1);
			const attrs = ends[0]!.attributes;
			assert.equal(attrs["slate.outcome"], id === "queued" ? "cancelled before start" : id === "unclaimed" ? "rejected" : "failed");
			assert.equal(attrs["slate.gen_ai.cost.usd"], id === "a" || id === "b" ? 0.5 : undefined);
			assert.equal(attrs["slate.episode.recorded"], id === "a" || id === "b" ? "true" : "false");
			assert.equal(h.events.filter((e) => e.kind === "tool" && e.phase === "end" && e.attributes["slate.tool.call_id"] === id).length, 1);
			assert.equal(h.observer!.dispatch(id), undefined);
		}
		assert.equal(h.store.workerCostUsd, 1);
		assert.equal([...h.store.episodes.values()].reduce((total, e) => total + (e.workerCostUsd ?? 0) + (e.compressorCostUsd ?? 0) + (e.compactionCostUsd ?? 0), 0), 1);
		await h.manager.disposeAll(); await h.emit("session_shutdown", { reason: "quit" });
		assert.equal(h.outcomes().length, 4);
	}
});

test("claimed admission rejection settles after agent_end without leaking", { timeout: 1000 }, async (t) => {
	const h = fixture(t, "admission-pause");
	const call = h.call();
	await h.entered.promise; await h.emit("agent_end", {});
	assert.equal(h.outcomes().length, 0);
	h.store.currentChange = "other"; h.release.resolve();
	await assert.rejects(call);
	assert.equal(h.outcomes().length, 1);
	assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], "rejected");
	assert.equal(h.observer!.dispatch("call"), undefined);
});

test("index shutdown joins an active dispatch before telemetry shutdown", { timeout: 5000 }, async (t) => {
	const h = fixture(t, "shutdown");
	await h.emit("agent_start", {});
	const call = h.call();
	const settled = Promise.allSettled([call]);
	await h.entered.promise;
	await h.emit("session_shutdown", { reason: "quit" });
	await settled;
	assert.equal(h.outcomes().length, 1);
	assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], "cancelled");
	const runEnd = h.events.findIndex((e) => e.kind === "run" && e.phase === "end");
	assert.ok(runEnd > h.events.indexOf(h.outcomes()[0]!));
	assert.equal(h.outcomes()[0]!.attributes["slate.episode.recorded"], "false");
	assert.equal(h.events.filter((e) => e.kind === "tool" && e.phase === "end").length, 1);
	await h.emit("session_shutdown", { reason: "quit" });
	assert.equal(h.outcomes().length, 1);
});

test("index quit rejects a real manager admission before exporter shutdown exactly once", { timeout: 5000 }, async (t) => {
	const h = fixture(t, "shutdown-admission");
	await h.emit("agent_start", {});
	const call = h.call();
	const settled = assert.rejects(call, /teardown started while the action route was being validated/);
	await h.entered.promise;
	assert.equal(h.store.threads.size, 0);
	await h.emit("session_shutdown", { reason: "quit" });
	const beforeExporterShutdown = h.outcomes().slice();
	assert.equal(beforeExporterShutdown.length, 1);
	assert.equal(beforeExporterShutdown[0]!.attributes["slate.outcome"], "rejected");
	const runEnd = h.events.findIndex((e) => e.kind === "run" && e.phase === "end");
	assert.ok(runEnd > h.events.indexOf(beforeExporterShutdown[0]!));
	assert.equal(h.opens(), 0);
	h.release.resolve(); await settled;
	await h.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(h.outcomes(), beforeExporterShutdown);
	assert.equal(h.events.filter((e) => e.kind === "tool" && e.phase === "end").length, 1);
});

test("claimed thread tool status follows Pi after cleanup failure or a returned failed episode", { timeout: 5000 }, async (t) => {
	for (const [mode, outcome, isError] of [["cleanup-pause", "succeeded", true], ["failed", "failed", false]] as const) {
		const h = fixture(t, mode);
		let now = 1000;
		t.mock.method(Date, "now", () => now);
		await h.emit("tool_execution_start", { toolCallId: "call", toolName: "thread" });
		const execute = h.tools.get("thread").execute("call", { type: "general", task: "private task", model: "fixture", reason: "private reason" }, h.controller.signal, undefined, h.ctx);
		const result = Promise.allSettled([execute]);
		const toolEnds = () => h.events.filter((e) => e.kind === "tool" && e.phase === "end");
		if (isError) {
			await h.entered.promise;
			assert.equal(toolEnds().length, 0);
			now = 2000; h.release.resolve();
		}
		const [settlement] = await result;
		assert.equal(settlement!.status, isError ? "rejected" : "fulfilled");
		if (settlement!.status === "fulfilled") assert.equal(settlement!.value.details.status, "failed");
		assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], outcome);
		assert.equal(toolEnds().length, 0);
		await h.emit("agent_end", {});
		assert.equal(toolEnds().length, 0);
		now = 3000;
		await h.emit("tool_execution_end", { toolCallId: "call", isError });
		assert.equal(toolEnds().length, 1);
		assert.equal(toolEnds()[0]!.attributes["slate.outcome"], isError ? "failed" : "succeeded");
		assert.equal(toolEnds()[0]!.durationSeconds, 2);
		await h.emit("tool_execution_end", { toolCallId: "call", isError });
		await h.emit("agent_end", {});
		assert.equal(toolEnds().length, 1);
		assert.equal(h.observer!.dispatch("call"), undefined);
		await h.manager.disposeAll();
	}
});

test("identity is one plain persisted entry before the first message and off preserves upstream entries", async (t) => {
	for (const enabled of [true, false]) {
		const before = process.env.SLATE_TELEMETRY;
		if (!enabled) process.env.SLATE_TELEMETRY = "0";
		try {
			const h = fixture(t);
			const change = "change-20261103T045739Z-f8537843366591cf99a9ba56e7aeb3e4";
			mkdirSync(join(h.root, "slate-changes", change), { recursive: true }); h.store.currentChange = change;
			await h.call("identity", { trackNumber: "3.1" });
			const sm = h.sessions[0]!, entries = sm.getEntries();
			const identities = entries.filter((e) => e.type === "custom" && e.customType === WORKER_IDENTITY_TYPE);
			assert.equal(identities.length, enabled ? 1 : 0);
			const disk = readFileSync(sm.getSessionFile()!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(disk.filter((e) => e.customType === WORKER_IDENTITY_TYPE).length, enabled ? 1 : 0);
			assert.equal(sm.buildSessionContext().messages.some((m: any) => m.customType === WORKER_IDENTITY_TYPE), false);
			if (enabled) {
				assert.deepEqual((identities[0] as any).data, { version: 1, parentSessionId: h.ctx.sessionManager.getSessionId(),
					parentSessionFile: h.ctx.sessionManager.getSessionFile(), change, track: "3.1", threadId: "t1", episodeId: "t1.e1", threadType: "general", logicalModel: "fixture" });
				assert.equal(disk[1].customType, WORKER_IDENTITY_TYPE);
				assert.equal(h.outcomes()[0]!.attributes["slate.change"], change);
			} else { assert.equal(h.events.length, 0); assert.equal(entries.some((e) => e.type === "custom"), false); }
		} finally { if (before === undefined) delete process.env.SLATE_TELEMETRY; else process.env.SLATE_TELEMETRY = before; }
	}
});

test("identity failures report once and never alter successful results", async (t) => {
	const output: string[] = []; t.mock.method(process.stderr, "write", ((s: string) => { output.push(s); return true; }) as any);
	for (const mode of ["identity-failure", "publication-failure"]) {
		const h = fixture(t, mode);
		await h.call("a"); await h.call("b");
		assert.deepEqual(h.outcomes().map((e) => e.attributes["slate.outcome"]), ["succeeded", "succeeded"]);
	}
	assert.equal(output.filter((s) => s.includes("telemetry observer failed")).length, 1);
	assert.equal(output.filter((s) => s.includes("telemetry publication failed")).length, 1);
});

test("a change switched during admission rejects without borrowing the newer change", async (t) => {
	const h = fixture(t, "admission-pause");
	const action = h.call();
	await h.entered.promise; h.store.currentChange = "other"; h.release.resolve();
	await assert.rejects(action, /changed during action validation/);
	assert.equal(h.opens(), 0); assert.equal(h.outcomes().length, 1);
	assert.equal(h.outcomes()[0]!.attributes["slate.change"], undefined);
});
