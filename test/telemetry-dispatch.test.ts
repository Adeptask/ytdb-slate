import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { metrics, trace, type Attributes, type MeterProvider } from "@opentelemetry/api";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { registerTelemetry } from "../extension/telemetry/orchestrator.ts";
import { Telemetry, FAILURE_KEY, type TelemetryEvent } from "../extension/telemetry/core.ts";
import { DispatchTelemetry, WORKER_IDENTITY_TYPE } from "../extension/telemetry/dispatch.ts";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { installWorkerRequestContract, type WorkerSession } from "../extension/worker.ts";
import extension from "../extension/index.ts";

afterEach(() => { metrics.disable(); trace.disable(); Reflect.deleteProperty(globalThis, FAILURE_KEY); });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
type BillingUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
function fixture(t: TestContext, mode = "ok", billing?: { worker: BillingUsage; compaction: BillingUsage;
	recovery?: BillingUsage; compressor?: BillingUsage; script?: string[]; compactionDelivery?: "duplicate-without-start" }) {
	const recovering = mode.includes("recovery");
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
			preferredProvider: "test", providers: { test: "worker", ...(recovering ? { backup: "worker-2" } : {}) }, guidelines: [], cautions: [] }],
	} } } });
	const entered = deferred(), release = deferred();
	let followup: (() => void) | undefined, startFollowup: (() => void) | undefined;
	const runtime = Object.freeze({ ...base,
		planCompressor: billing?.compressor === undefined ? base.planCompressor : () => ["skip", "alpha", "beta"].map((provider) =>
			({ logicalModel: `compress-${provider}`, provider, model: `model-${provider}`, kind: "compressor" as const, effort: "off" as const })),
		planOrdinary: mode === "recovery-empty" ? () => { startFollowup!(); return []; } : base.planOrdinary,
		async validateRoute(_ctx: unknown, candidate: { provider: string }) {
		if (candidate.provider === "skip") return { ok: false, kind: "unavailable", reason: "skip" } as const;
		validation++;
		if (validation === 4) {
			if (mode === "recovery-gap") { entered.resolve(); await release.promise; }
			if (mode === "recovery-unavailable") { startFollowup!(); return { ok: false, kind: "unavailable", reason: "unavailable" } as const; }
			if (mode === "recovery-validation-fault") { startFollowup!(); throw Error("validation fault"); }
		}
		if ((mode === "admission-pause" || mode === "shutdown-admission") && validation === 1) { entered.resolve(); await release.promise; }
		return mode.startsWith("abort") && validation > 1
			? { ok: false, kind: "unavailable", reason: "route changed" } as const : { ok: true } as const;
	} });
	let manager = new ThreadManager(store, { maxConcurrent: 2 }, undefined, runtime);
	if (mode === "busy") (manager as any).logicalRuntime = { ...runtime, ownership: { acquire: () => ({ kind: "busy" }) } };
	const parent = SessionManager.create(root, join(root, "parent"));
	const ctx = { cwd: root, mode: "rpc", hasUI: false, sessionManager: parent,
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id, api: "openai-responses" }) } } as unknown as ExtensionContext;
	let compressorCalls = 0;
	if (billing?.compressor !== undefined) {
		Object.assign(ctx.modelRegistry, { getApiKeyAndHeaders: async () => ({ ok: true }),
			streamSimple: () => ({ result: async () => {
				const step = billing.script?.[compressorCalls] ?? "success";
				compressorCalls++;
				if (step === "throw") throw Error("private provider failure");
				if (step === "cancel") controller.abort();
				if (step === "backoff") setImmediate(() => controller.abort());
				return { role: "assistant", stopReason: step === "retry" || step === "backoff" || step === "terminal" ? "error"
					: step === "cancel" ? "aborted" : "stop", errorMessage: step === "terminal" ? "invalid api key" : "temporary timeout",
					content: step === "malformed" ? null : [{ type: "text", text: "## Intent\\nprivate compressed result" }],
					usage: billing.compressor };
			} }) });
		(manager as any).compressorRetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 100 };
	}
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
		const localBilling = mode.startsWith("parallel-") ? {
			worker: { input: opens, cost: { total: opens === 1 ? mode === "parallel-invalid" ? -1 : 0.125 : 0.375 } },
			compaction: { output: 2, cost: { total: 0.125 } },
		} : billing;
		const listeners = new Set<(event: any) => void>();
		const sessionManager = SessionManager.create(root, join(root, "workers"));
		sessions.push(sessionManager);
		let prompts = 0, followupPending = false;
		const send = (event: any) => { for (const fn of listeners) fn(event); };
		const session = { agent: { streamFunction: (() => ({})) as unknown as WorkerSession["agent"]["streamFunction"] }, sessionManager, messages: [] as any[], model: { provider: "test", id: "worker" }, thinkingLevel: "off",
			subscribe(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
			async sendCustomMessage() {}, setThinkingLevel() {
				if (mode.startsWith("billed-startup-abort")) throw Error("fixed effort");
			},
			async setModel(model: { provider: string; id: string }) { session.model = model; },
			async abort() { if (mode === "shutdown") { controller.abort(); release.resolve(); } },
			closeManagedOperations() {}, async settleManagedOperations() {
				if (followupPending) { followupPending = false; bill(true, false, true); }
			},
			async shutdownWorker() {
				if (mode === "cleanup-pause") { entered.resolve(); await release.promise; }
				if (mode.startsWith("cleanup")) throw Error("cleanup");
			},
			async prompt() {
				prompts++;
				send({ type: "turn_start" });
				if (mode.startsWith("billed-cancel")) {
					bill(mode.endsWith("facts"), true);
					controller.abort(); throw Error("cancelled");
				}
				session.agent.streamFunction(session.model as Parameters<WorkerSession["agent"]["streamFunction"]>[0], normalizeContext({ messages: [] }));
				if (mode !== "recovery-cancel") {
					send({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode" });
					send({ type: "tool_execution_start", toolCallId: "inner", parentToolCallId: "outer", toolName: "read" });
				}
				sessionManager.appendMessage({ role: "user", content: "private task", timestamp: 1 });
				if (mode.startsWith("parallel") || mode === "shutdown") { entered.resolve(); await release.promise; }
				if (mode === "shutdown" || mode === "cancel" || mode === "cancel-save") { controller.abort(); throw Error("cancelled"); }
				if (mode.includes("storage") && (!recovering || prompts > 1)) writeFileSync(join(root, ".pi"), "block episode");
				if (mode.startsWith("empty")) throw Error("empty failure");
				const message = { role: "assistant", provider: "test", model: "worker", api: "openai-responses",
					stopReason: mode === "failed" || (recovering && (prompts === 1 || /failed|exhausted/.test(mode))) ? "error" : "stop",
					errorMessage: recovering ? "temporary timeout" : mode === "failed" ? "private error" : undefined,
					content: mode === "recovery-cancel" ? [] : [{ type: "text", text: "private result" }], timestamp: 2,
					usage: localBilling ? prompts > 1 && billing?.recovery ? billing.recovery : localBilling.worker : { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } } };
				session.messages.push(message); sessionManager.appendMessage(message as any);
				if (recovering && (prompts === 1 || mode === "recovery-exhausted")) {
					send({ type: "agent_end", willRetry: true });
					send({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "temporary timeout" });
					send({ type: "agent_end", willRetry: false });
					send({ type: "auto_retry_end", success: false, attempt: 1 });
				}
				if (mode !== "recovery-cancel") {
					send({ type: "tool_execution_end", toolCallId: "inner", isError: false });
					send({ type: "tool_execution_end", toolCallId: "outer", isError: false });
				}
				send({ type: "message_end", message });
				compact();
				send({ type: "turn_end" });
				if (mode === "recovery-cancel" && prompts > 1) { controller.abort(); throw Error("cancelled"); }
			},
		};
		const compact = () => {
			const duplicateWithoutStart = billing?.compactionDelivery === "duplicate-without-start";
			if (!duplicateWithoutStart) send({ type: "compaction_start" });
			const end = { type: "compaction_end", result: { usage: localBilling ? localBilling.compaction : { input: 5, output: 4, cost: { total: 0.2 } } }, aborted: false };
			send(end);
			if (duplicateWithoutStart) send(end);
		};
		const bill = (facts: boolean, cancelled = false, admitted = false) => {
			if (!admitted) session.agent.streamFunction(session.model as Parameters<WorkerSession["agent"]["streamFunction"]>[0], normalizeContext({ messages: [] }));
			const message = { role: "assistant", provider: "test", model: "worker", api: "openai-responses",
				content: facts ? [{ type: "text", text: "private startup" }] : [], timestamp: 2,
				stopReason: cancelled ? "aborted" : "stop",
				usage: localBilling ? localBilling.worker : { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.3 } } };
			session.messages.push(message); sessionManager.appendMessage(message as any);
			send({ type: "message_end", message });
			if (localBilling) compact();
		};
		startFollowup = () => { followupPending = true; session.agent.streamFunction(session.model as Parameters<WorkerSession["agent"]["streamFunction"]>[0], normalizeContext({ messages: [] })); };
		followup = () => bill(true);
		if (mode === "identity-failure") (sessionManager as any).appendCustomEntry = () => { throw Error("identity"); };
		installWorkerRequestContract(session as unknown as WorkerSession, args.requestContract);
		args.observeSession(session);
		send({ type: "turn_start" });
		if (mode.startsWith("billed-startup-")) {
			bill(mode.endsWith("facts"));
			if (mode.startsWith("billed-startup-cancel")) {
				controller.abort(); args.observeStartupFailure("startup"); throw Error("startup");
			}
		}
		if (["ok", "parallel", "recovery"].includes(mode)) {
			send({ type: "tool_execution_start", toolCallId: "startup", toolName: "read" });
			send({ type: "tool_execution_end", toolCallId: "startup", isError: false });
		}
		send({ type: "turn_end" });
		if (mode === "startup-cancel") {
			controller.abort(); args.observeStartupFailure("startup"); throw Error("startup");
		}
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
	return { root, pi, get store() { return store; }, get manager() { return manager; }, observer, ctx, events, tools, sessions, controller, entered, release,
		compressorCalls: () => compressorCalls, opens: () => opens, emit, followup: () => followup!(),
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

function checkAgreement(events: TelemetryEvent[], store: SlateStore, expectedCallIds: readonly string[], unrecordedZeroCalls: readonly string[] = []): string[] {
	const starts = new Map(events.filter((e) => e.phase === "start").map((e) => [e.id, e]));
	const descends = (id: string, ancestor: string): boolean => {
		while (id !== ancestor) {
			const parent = starts.get(id)?.parentId;
			if (!parent) return false;
			id = parent;
		}
		return true;
	};
	const checked: string[] = [];
	for (const end of events.filter((e) => e.kind === "dispatch" && e.phase === "end")) {
		const a = end.attributes;
		assert.equal(a["slate.dispatch.invalid_accounting"], undefined, "agreement fixtures must be unmarked");
		const billed = events.filter((e) => e.phase === "usage" && descends(e.id, end.id));
		const costs = billed.flatMap((e) => e.attributes["slate.gen_ai.cost.usd"] === undefined ? [] : [e.attributes["slate.gen_ai.cost.usd"]!]);
		const notStored = a["slate.dispatch.not_stored_cost.usd"];
		if (costs.length) {
			assert.equal(typeof notStored, "number");
			const actual = costs.reduce((n, cost) => n + cost, 0);
			const expected = (a["slate.gen_ai.cost.usd"] ?? 0) + notStored!;
			// Eight rounding units per addition, scaled to these costs, not to one dollar.
			const tolerance = 8 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected), Number.MIN_VALUE) * costs.length;
			assert.ok(Math.abs(actual - expected) <= tolerance, `billed ${actual} != stored + not-stored ${expected}`);
		} else assert.equal(notStored, unrecordedZeroCalls.includes(a["slate.tool.call_id"]!) ? 0 : undefined, "unknown is not zero");
		const episode = store.episodes.get(a["slate.episode.id"]!);
		if (episode) {
			for (const [field, key] of [["input", "input_tokens"], ["output", "output_tokens"],
				["cacheRead", "cache_read.input_tokens"], ["cacheWrite", "cache_creation.input_tokens"]] as const) {
				for (const source of ["worker_model_call", "worker_compaction", "compressor_request"]) {
					const values = billed.filter((e) => e.kind === source)
						.flatMap((e) => e.attributes[`gen_ai.usage.${key}`] === undefined ? [] : [e.attributes[`gen_ai.usage.${key}`]!]);
					assert.equal(values.length ? values.reduce((n, v) => n + v, 0) : undefined,
						source === "worker_compaction" ? episode.compactionUsage?.[field]
							: source === "compressor_request" ? episode.compressorUsage?.[field] : episode[field], field);
				}
			}
		}
		checked.push(a["slate.tool.call_id"]!);
	}
	assert.deepEqual([...checked].sort(), [...expectedCallIds].sort(), "no unmarked dispatch escapes the agreement");
	return checked;
}

test("unadmitted zero usage satisfies agreement without converting unknown to zero", () => {
	const events: TelemetryEvent[] = [], telemetry = new Telemetry((e) => events.push(e));
	const dispatch = new DispatchTelemetry(telemetry, telemetry.start("tool", { "slate.tool.call_id": "zero" }));
	dispatch.accounting.collect({ "slate.gen_ai.cost.usd": 0, "gen_ai.usage.input_tokens": 0 }, "worker");
	dispatch.accounting.unrecorded({ "slate.gen_ai.cost.usd": 0, "gen_ai.usage.input_tokens": 0 });
	dispatch.outcome("cancelled", undefined, undefined, 0); dispatch.finish("cancelled");
	const store = { episodes: new Map() } as SlateStore;
	checkAgreement(events, store, ["zero"], ["zero"]);
	assert.throws(() => checkAgreement(events, store, ["zero"]), /unknown is not zero/);
});

test("compressor retry, recovery and every accounting exit agree with Slate collections", { timeout: 15000 }, async (t) => {
	const billing = { worker: { input: 2, cost: { total: 0.375 } }, recovery: { output: 3, cost: { total: 0.625 } },
		compaction: { output: 1, cost: { total: 0.125 } }, compressor: { input: 7, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } },
		script: ["retry", "retry", "success"] };
	for (const mode of ["ok", "failed", "storage", "stored-save", "empty", "empty-storage", "empty-stored-save",
		"running-save", "busy", "abort", "abort-save", "cancel", "cancel-save", "startup-cancel",
		"billed-cancel", "billed-cancel-facts", "billed-startup-abort", "billed-startup-abort-facts",
		"billed-startup-cancel", "billed-startup-cancel-facts",
		"recovery", "recovery-failed", "recovery-exhausted", "recovery-cancel", "recovery-storage", "recovery-stored-save"]) {
		const h = fixture(t, mode, billing); await h.call(mode).catch(() => {});
		checkAgreement(h.events, h.store, [mode]);
		const calls = h.events.filter((e) => e.kind === "compressor_request" && e.phase === "usage");
		assert.equal(calls.length, h.compressorCalls(), mode);
		assert.equal(calls.reduce((n, e) => n + e.attributes["gen_ai.usage.input_tokens"]!, 0), 7 * calls.length, mode);
		if (calls.length) {
			assert.deepEqual(calls.map((e) => [e.attributes["slate.attempt.index"], e.attributes["slate.request.index"],
				e.attributes["slate.logical_model"], e.attributes["gen_ai.provider.name"], e.attributes["gen_ai.request.model"]]),
				[[0, 0, "compress-alpha", "alpha", "model-alpha"], [0, 1, "compress-alpha", "alpha", "model-alpha"],
					[1, 0, "compress-beta", "beta", "model-beta"]].slice(0, h.controller.signal.aborted ? 1 : 3), mode);
			assert.throws(() => checkAgreement(h.events.filter((e) => e !== calls[0]), h.store, [mode]));
			assert.equal(h.events.find((e) => e.kind === "compressor" && e.phase === "end")!.attributes["slate.outcome"], h.controller.signal.aborted ? "cancelled" : "succeeded");
		}
		for (const start of h.events.filter((e) => e.kind.startsWith("compressor") && e.phase === "start")) {
			assert.equal(h.events.filter((e) => e.id === start.id && e.phase === "end").length, 1);
			const parent = h.events.find((e) => e.id === start.parentId && e.phase === "start")!;
			assert.equal(parent.kind, start.kind === "compressor" ? "dispatch" : start.kind === "compressor_attempt" ? "compressor" : "compressor_attempt");
		}
		assert.equal(h.events.filter((e) => e.kind.startsWith("compressor") && e.phase === "admission").length, 0);
		assert.ok(!JSON.stringify(h.events).includes("private compressed"));
		await h.manager.disposeAll();
	}
});

test("compressor cancellation copy, exhaustion, terminal, malformed and thrown results retain once-only bills", { timeout: 5000 }, async (t) => {
	for (const script of [["backoff"], ["cancel"], ["retry", "retry", "retry", "retry"], ["terminal"], ["malformed"], ["throw"]]) {
		const h = fixture(t, "ok", { worker: {}, compaction: {}, compressor: { input: 2, cost: { total: 0.25 } }, script });
		const result = await h.call();
		assert.equal(result.details.status, "ok");
		checkAgreement(h.events, h.store, ["call"]);
		assert.equal(h.events.filter((e) => e.kind === "compressor_request" && e.phase === "usage").length, script[0] === "throw" ? 0 : script.length);
		assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], "succeeded");
		assert.equal(h.events.find((e) => e.kind === "compressor" && e.phase === "end")!.attributes["slate.outcome"],
			script[0] === "backoff" || script[0] === "cancel" ? "cancelled" : "failed");
		await h.manager.disposeAll();
	}
});

test("unexpected compression exit retains Slate's collected compressor cost as not stored", async (t) => {
	const h = fixture(t, "ok", { worker: { cost: { total: 0.375 } }, compaction: { cost: { total: 0.125 } },
		compressor: { input: 7, cost: { total: 0.25 } } });
	const iso = Date.prototype.toISOString;
	t.mock.method(Date.prototype, "toISOString", function(this: Date) {
		if (h.compressorCalls()) throw Error("header failure after billing");
		return iso.call(this);
	});
	await assert.rejects(h.call());
	assert.equal(h.store.workerCostUsd, 0.5);
	assert.equal(h.outcomes()[0]!.attributes["slate.dispatch.not_stored_cost.usd"], 0.25);
	assert.equal(h.store.episodes.size, 0); checkAgreement(h.events, h.store, ["call"]);
	await h.manager.disposeAll();
});

test("compressor missing usage events mark nonzero values and output failures report once without marks", async (t) => {
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((s: string) => { output.push(s); return true; }) as any);
	for (const mode of ["missing", "start-throw", "usage-throw", "outputs", "zero"]) {
		const events: TelemetryEvent[] = [];
		const telemetry = new Telemetry((e) => { events.push(e); if (mode === "outputs") throw Error("publication"); });
		const dispatch = new DispatchTelemetry(telemetry);
		const start = telemetry.start.bind(telemetry);
		t.mock.method(telemetry, "start", (...[kind, ...args]: Parameters<Telemetry["start"]>) => {
			if (kind === "compressor_request" && mode !== "outputs") {
				if (mode === "start-throw") throw Error("start");
				if (mode !== "usage-throw") return undefined;
			}
			return start(kind, ...args);
		});
		if (mode === "usage-throw") t.mock.method(telemetry, "usage", () => { throw Error("usage"); });
		if (mode === "outputs") {
			metrics.setGlobalMeterProvider({ getMeter() { throw Error("metrics"); } } as unknown as MeterProvider);
			trace.setGlobalTracerProvider({ getTracer() { throw Error("spans"); } } as any);
		}
		const observer = dispatch.compressor()!;
		for (let i = 0; i < 2; i++) {
			await observer.attempt({ logicalModel: "compress", provider: "p", model: "m" }, () =>
				observer.request(async () => {
					observer.measured({ stopReason: "stop", usage: { input: mode === "zero" ? 0 : 2, cost: { total: mode === "zero" ? 0 : 0.25 } } }, 0.5);
					return { kind: "success" };
				}));
		}
		observer.finish("succeeded"); dispatch.outcome("succeeded", 0.5); dispatch.finish("succeeded");
		assert.equal(events.find((e) => e.kind === "dispatch" && e.phase === "end")!.attributes["slate.dispatch.invalid_accounting"],
			mode === "outputs" || mode === "zero" ? undefined : "both");
		metrics.disable(); trace.disable();
	}
	for (const kind of ["observer", "spans", "metrics", "publication"]) {
		assert.equal(output.filter((s) => s.includes(`telemetry ${kind} failed`)).length, 1, kind);
	}
});

test("compressor unknown, zero, invalid values and sums share dispatch marks", async (t) => {
	for (const compressor of [{}, { input: 0, cost: { total: 0 } }, { input: 1.5 }, { cost: { total: -1 } },
		{ input: -1, cost: { total: NaN } }, { cost: { total: Number.MAX_VALUE } }] as BillingUsage[]) {
		const overflow = compressor.cost?.total === Number.MAX_VALUE;
		const h = fixture(t, "ok", { worker: overflow ? { cost: { total: Number.MAX_VALUE } } : {}, compaction: {}, compressor });
		await h.call();
		const mark = h.outcomes()[0]!.attributes["slate.dispatch.invalid_accounting"];
		assert.equal(mark, compressor.input === -1 ? "both" : compressor.input === 1.5 ? "tokens"
			: compressor.cost?.total ? "cost" : undefined);
		if (!mark) checkAgreement(h.events, h.store, ["call"]);
		else if (mark !== "tokens") assert.equal(h.outcomes()[0]!.attributes["slate.dispatch.not_stored_cost.usd"], undefined);
		await h.manager.disposeAll();
	}
});

test("parallel compressor sequences keep parents and accounting isolated and off preserves results", { timeout: 5000 }, async (t) => {
	const run = async (enabled: boolean) => {
		const previous = process.env.SLATE_TELEMETRY;
		try {
			process.env.SLATE_TELEMETRY = enabled ? "1" : "0";
			const h = fixture(t, "parallel", { worker: {}, compaction: {}, compressor: { input: 7, cost: { total: 0.25 } } });
			const a = h.call("a"), b = h.call("b"); await h.entered.promise;
			while (h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
			h.release.resolve(); await Promise.all([a, b]);
			if (enabled) checkAgreement(h.events, h.store, ["a", "b"]);
			else assert.deepEqual(h.events, []);
			const results = [...h.store.episodes.values()].map((e) => [e.status, e.input, e.compressorUsage, e.compressorCostUsd]);
			await h.manager.disposeAll();
			return { results, cost: h.store.workerCostUsd };
		} finally { if (previous === undefined) delete process.env.SLATE_TELEMETRY; else process.env.SLATE_TELEMETRY = previous; }
	};
	assert.deepEqual(await run(true), await run(false));
});

test("per-dispatch billed cost and exact episode tokens agree across every accounting exit", async (t) => {
	const points: Array<{ name: string; value: number; labels: Attributes }> = [];
	metrics.setGlobalMeterProvider({ getMeter: () => ({
		createCounter: (name: string) => ({ add: (value: number, labels: Attributes) => points.push({ name, value, labels }) }),
		createHistogram: () => ({ record() {} }),
	}) } as unknown as MeterProvider);
	const known = { worker: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.375 } },
		compaction: { input: 5, output: 4, cost: { total: 0.125 } } };
	const checked: string[] = [], expectedCallIds: string[] = [];
	const expectedCosts: number[] = [];
	const collectCosts = (events: TelemetryEvent[]) => expectedCosts.push(...events.filter((e) => e.phase === "usage")
		.flatMap((e) => e.attributes["slate.gen_ai.cost.usd"] === undefined ? [] : [e.attributes["slate.gen_ai.cost.usd"]!]));
	for (const mode of ["ok", "failed", "storage", "stored-save", "empty", "empty-storage", "empty-stored-save",
		"running-save", "busy", "abort", "abort-save", "cancel", "cancel-save", "startup-cancel",
		"billed-cancel", "billed-cancel-facts", "billed-startup-abort", "billed-startup-abort-facts",
		"billed-startup-cancel", "billed-startup-cancel-facts"]) {
		const h = fixture(t, mode, known);
		expectedCallIds.push(mode);
		await h.call(mode).catch(() => {});
		checked.push(...checkAgreement(h.events, h.store, [mode]));
		collectCosts(h.events);
		if (mode.startsWith("billed-")) {
			const a = h.outcomes()[0]!.attributes, facts = mode.endsWith("facts");
			assert.equal(a["slate.outcome"], facts ? "failed" : mode.includes("abort") ? "aborted" : "cancelled", mode);
			assert.equal(a["slate.dispatch.not_stored_cost.usd"], facts ? 0 : 0.5, mode);
			assert.equal(a["slate.gen_ai.cost.usd"], facts ? 0.5 : undefined, mode);
			assert.equal(h.store.workerCostUsd, facts ? 0.5 : 0, mode);
			assert.equal(h.store.episodes.size, facts ? 1 : 0, mode);
		}
		await h.manager.disposeAll();
	}
	for (const [index, billing] of [
		{ worker: {}, compaction: {} },
		{ worker: { input: 0, cost: { total: 0 } }, compaction: {} },
		{ worker: { input: 4 }, compaction: { output: 0, cost: { total: 0.125 } } },
		{ worker: { cost: { total: 0.1 } }, compaction: { cost: { total: 0.2 } } },
	].entries()) {
		const h = fixture(t, "ok", billing), id = `billing-${index}`;
		expectedCallIds.push(id);
		await h.call(id);
		checked.push(...checkAgreement(h.events, h.store, [id])); collectCosts(h.events);
		await h.manager.disposeAll();
	}
	assert.deepEqual(checked, expectedCallIds, "every scenario dispatch ran its agreement assertions");
	assert.deepEqual(points.filter((p) => p.name === "slate.model.cost").map((p) => p.value), expectedCosts);
	assert.ok(points.every((p) => !Object.keys(p.labels).some((key) => /dispatch|episode|thread.id/.test(key))));
});

test("duplicate compaction completion without a start agrees through real charging and no-facts exits", async (t) => {
	for (const mode of ["ok", "billed-cancel"]) {
		await t.test(mode, async (t) => {
			const h = fixture(t, mode, {
				worker: { input: 11, cost: { total: 0.375 } },
				compaction: { input: 5, output: 4, cost: { total: 0.125 } },
				compactionDelivery: "duplicate-without-start",
			});
			await h.call().catch(() => {});
			checkAgreement(h.events, h.store, ["call"]);
			const compactions = h.events.filter((e) => e.kind === "worker_compaction");
			assert.equal(compactions.filter((e) => e.phase === "usage").length, 1);
			const ends = compactions.filter((e) => e.phase === "end");
			assert.equal(ends.length, 1);
			assert.equal(ends[0]!.durationSeconds, undefined);
			const a = h.outcomes()[0]!.attributes, charging = mode === "ok";
			assert.equal(a["slate.outcome"], charging ? "succeeded" : "cancelled");
			assert.equal(a["slate.gen_ai.cost.usd"], charging ? 0.5 : undefined);
			assert.equal(a["slate.dispatch.not_stored_cost.usd"], charging ? 0 : 0.5);
			assert.equal(h.store.workerCostUsd, charging ? 0.5 : 0);
			assert.equal(h.store.episodes.size, charging ? 1 : 0);
			await h.manager.disposeAll();
		});
	}
});

test("agreement coverage rejects missing and duplicate dispatch checks", async (t) => {
	const h = fixture(t); await h.call();
	const end = h.outcomes()[0]!;
	assert.throws(() => checkAgreement(h.events.filter((e) => e !== end), h.store, ["call"]), /no unmarked dispatch escapes/);
	assert.throws(() => checkAgreement([...h.events, end], h.store, ["call"]), /no unmarked dispatch escapes/);
	assert.throws(() => checkAgreement(h.events, h.store, ["call", "missing"]), /no unmarked dispatch escapes/);
});

test("invalid real dispatch accounting is marked without changing Slate additions", async (t) => {
	for (const [mode, worker, compaction, mark] of [
		["ok", { input: 1, cost: { total: -1 } }, {}, "cost"],
		["ok", { input: 1.5, cost: { total: 0.125 } }, {}, "tokens"],
		["ok", { input: -1, cost: { total: NaN } }, {}, "both"],
		["ok", {}, { input: 1.5, cost: { total: Infinity } }, "both"],
		["billed-cancel", { cost: { total: -1 } }, {}, "cost"],
		["billed-startup-abort", {}, { cost: { total: Infinity } }, "cost"],
		["ok", { cost: { total: Number.MAX_VALUE } }, { cost: { total: Number.MAX_VALUE } }, "cost"],
	] as Array<[string, BillingUsage, BillingUsage, string]>) {
		const h = fixture(t, mode, { worker, compaction });
		await h.call().catch(() => {});
		const a = h.outcomes()[0]!.attributes;
		assert.equal(a["slate.dispatch.invalid_accounting"], mark, mode);
		assert.equal(a["slate.dispatch.not_stored_cost.usd"], mark === "tokens" ? 0 : undefined);
		if (mode === "ok") {
			assert.equal(h.store.workerCostUsd, (worker.cost?.total ?? 0) + (compaction.cost?.total ?? 0));
		} else assert.equal(h.store.workerCostUsd, 0);
		await h.manager.disposeAll();
	}
});

test("agreement detects a missing charge rather than accepting a sum grouped by labels", async (t) => {
	const h = fixture(t); await h.call();
	checkAgreement(h.events, h.store, ["call"]);
	const broken = h.events.map((e) => e.kind === "dispatch" && e.phase === "end"
		? { ...e, attributes: { ...e.attributes, "slate.gen_ai.cost.usd": 0.3 } } : e);
	assert.throws(() => checkAgreement(broken, h.store, ["call"]), /billed .* != stored/);
});

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
		checkAgreement(h.events, h.store, ["call"]);
		assert.equal(attrs["slate.change"], undefined); assert.equal(attrs["slate.track"], undefined);
		const workerStarts = h.events.filter((e) => e.phase === "start" && e.kind.startsWith("worker_"));
		for (const start of workerStarts) assert.equal(h.events.filter((e) => e.phase === "end" && e.id === start.id).length, 1, mode);
		const attempt = h.events.find((e) => e.phase === "end" && e.kind === "worker_attempt");
		if (attempt) assert.equal(attempt.attributes["slate.outcome"], outcome, mode);
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

test("billed cancellation without facts emits per-call usage without changing Slate accounting", async (t) => {
	const h = fixture(t, "billed-cancel");
	await h.call().catch(() => {});
	assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], "cancelled");
	assert.equal(h.outcomes()[0]!.attributes["slate.episode.recorded"], "false");
	assert.equal(h.store.episodes.size, 0);
	assert.equal(h.store.workerCostUsd, 0);
	const calls = h.events.filter((e) => e.kind === "worker_model_call" && e.phase === "usage");
	assert.equal(calls.length, 1);
	assert.partialDeepStrictEqual(calls[0]!.attributes, {
		"gen_ai.usage.input_tokens": 11, "gen_ai.usage.output_tokens": 7,
		"gen_ai.usage.cache_read.input_tokens": 3, "gen_ai.usage.cache_creation.input_tokens": 2,
		"slate.gen_ai.cost.usd": 0.3,
	});
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
	assert.deepEqual(checkAgreement(h.events, h.store, ["a", "b"]).sort(), ["a", "b"], "same-label parallel dispatches each agree");
	assert.equal(h.store.workerCostUsd, 13);
	assert.notEqual(ends[0]!.attributes["slate.thread.id"], ends[1]!.attributes["slate.thread.id"]);
	assert.doesNotMatch(JSON.stringify(h.events), /private task|private result|private error|private reason/);
});

test("parallel dispatches sharing every metric label keep different bills and invalid marks separate", async (t) => {
	for (const mode of ["parallel-varied", "parallel-invalid"]) {
		const h = fixture(t, mode), a = h.call("a"), b = h.call("b");
		await h.entered.promise;
		while (h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
		h.release.resolve(); await Promise.all([a, b]);
		const ends = h.outcomes();
		const first = ends.find((e) => e.attributes["slate.tool.call_id"] === "a")!.attributes;
		const second = ends.find((e) => e.attributes["slate.tool.call_id"] === "b")!.attributes;
		assert.equal(first["slate.gen_ai.cost.usd"], mode === "parallel-invalid" ? undefined : 0.25);
		assert.equal(second["slate.gen_ai.cost.usd"], 0.5);
		assert.equal(first["slate.dispatch.invalid_accounting"], mode === "parallel-invalid" ? "cost" : undefined);
		assert.equal(second["slate.dispatch.invalid_accounting"], undefined);
		assert.equal(second["slate.dispatch.not_stored_cost.usd"], 0);
		const labels = h.events.filter((e) => e.kind === "worker_model_call" && e.phase === "usage")
			.map((e) => ["slate.logical_model", "slate.thread.type", "gen_ai.provider.name", "gen_ai.request.model"]
				.map((key) => e.attributes[key as keyof typeof e.attributes]));
		assert.equal(labels.length, 2); assert.deepEqual(labels[0], labels[1]);
		if (mode === "parallel-varied") checkAgreement(h.events, h.store, ["a", "b"]);
		await h.manager.disposeAll();
	}
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


test("index quit ends claimed thread parents before exporter shutdown without a Pi result", { timeout: 5000 }, async (t) => {
	const h = fixture(t, "shutdown");
	await h.emit("agent_start", {});
	await h.emit("tool_execution_start", { toolCallId: "call", toolName: "thread" });
	const action = h.tools.get("thread").execute("call", { type: "general", task: "private task", model: "fixture", reason: "private reason" }, h.controller.signal, undefined, h.ctx);
	const settled = Promise.allSettled([action]);
	await h.entered.promise;
	let checked = false;
	h.pi.on("session_shutdown", () => {
		checked = true;
		const ends = h.events.filter((e) => e.phase === "end");
		const tool = ends.find((e) => e.kind === "tool" && e.attributes["slate.tool.call_id"] === "call");
		assert.ok(tool);
		assert.equal(tool.attributes["slate.outcome"], "cancelled");
		assert.ok(h.events.indexOf(tool) > h.events.indexOf(h.outcomes()[0]!));
		for (const start of h.events.filter((e) => e.phase === "start")) assert.equal(ends.filter((e) => e.id === start.id).length, 1);
	});
	await h.emit("session_shutdown", { reason: "quit" });
	assert.ok(checked);
	await settled;
	const snapshot = h.events.slice();
	await h.emit("tool_execution_end", { toolCallId: "call", isError: false });
	await h.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(h.events, snapshot);
});

test("real recovery closes attempt zero before recovery turns and keeps old handles", { timeout: 5000 }, async (t) => {
	const h = fixture(t, "recovery");
	const result = await h.call();
	assert.equal(result.details.status, "ok");
	const attempts = h.events.filter((e) => e.kind === "worker_attempt" && e.phase === "end");
	assert.deepEqual(attempts.map((e) => [e.attributes["slate.attempt.index"], e.attributes["slate.outcome"]]), [[0, "failed"], [1, "succeeded"]]);
	assert.equal(h.events.filter((e) => e.kind === "worker_turn" && e.phase === "start").length, 3);
	assert.equal(h.events.filter((e) => e.kind === "worker_tool" && e.phase === "start").length, 5);
	checkAgreement(h.events, h.store, ["call"]);
	for (const start of h.events.filter((e) => e.kind.startsWith("worker_") && e.phase === "start")) {
		assert.equal(h.events.filter((e) => e.id === start.id && e.phase === "end").length, 1);
	}
	assert.ok(h.events.indexOf(attempts[0]!) < h.events.indexOf(h.outcomes()[0]!));
});

test("requests admitted during recovery validation belong to attempt zero and agree with dispatch billing", { timeout: 5000 }, async (t) => {
	const h = fixture(t, "recovery-gap", { worker: { input: 2, cost: { total: 0.375 } },
		recovery: { input: 4, cost: { total: 0.625 } }, compaction: { output: 1, cost: { total: 0.125 } } });
	const pending = h.call();
	await h.entered.promise;
	h.followup();
	h.release.resolve();
	assert.equal((await pending).details.status, "ok");
	checkAgreement(h.events, h.store, ["call"]);
	const calls = h.events.filter((e) => e.kind === "worker_model_call" && e.phase === "usage");
	assert.deepEqual(calls.map((e) => [e.attributes["slate.attempt.index"], e.attributes["slate.request.index"],
		e.attributes["gen_ai.provider.name"], e.attributes["slate.gen_ai.cost.usd"]]),
		[[0, 0, "test", 0.375], [0, 1, "test", 0.375], [1, 0, "backup", 0.625]]);
	assert.equal(h.store.workerCostUsd, 1.75);
	await h.manager.disposeAll();
});

test("included requests remain billed when recovery attempts no candidate", { timeout: 5000 }, async (t) => {
	for (const mode of ["recovery-empty", "recovery-unavailable", "recovery-validation-fault"]) {
		const h = fixture(t, mode, { worker: { input: 2, cost: { total: 0.375 } }, compaction: { output: 1, cost: { total: 0.125 } } });
		assert.equal((await h.call()).details.status, "failed", mode);
		checkAgreement(h.events, h.store, ["call"]);
		assert.equal(h.store.workerCostUsd, 1, mode);
		assert.deepEqual(h.events.filter((e) => e.kind === "worker_attempt" && e.phase === "start")
			.map((e) => e.attributes["slate.attempt.index"]), [0], mode);
		assert.deepEqual(h.events.filter((e) => e.kind === "worker_model_call" && e.phase === "usage")
			.map((e) => [e.attributes["slate.attempt.index"], e.attributes["slate.request.index"]]), [[0, 0], [0, 1]], mode);
		await h.manager.disposeAll();
	}
});

test("recovery extends per-dispatch agreement to every exit without compressor spend", async (t) => {
	const billing = { worker: { input: 2, output: 1, cost: { total: 0.375 } },
		recovery: { input: 4, cacheRead: 2, cost: { total: 0.625 } }, compaction: { output: 2, cost: { total: 0.125 } } };
	for (const [mode, outcome] of [["recovery", "succeeded"], ["recovery-failed", "failed"],
		["recovery-exhausted", "failed"], ["recovery-cancel", "cancelled"], ["recovery-storage", "failed"],
		["recovery-stored-save", "stored but failed"]] as const) {
		const h = fixture(t, mode, billing); await h.call(mode).catch(() => {});
		assert.equal(h.outcomes()[0]!.attributes["slate.outcome"], outcome, mode);
		assert.equal(h.store.workerCostUsd, mode === "recovery-cancel" ? 0 : 1.25, mode);
		checkAgreement(h.events, h.store, [mode]);
		const attempts = h.events.filter((e) => e.kind === "worker_attempt" && e.phase === "start");
		assert.deepEqual(attempts.map((e) => e.attributes["slate.attempt.index"]), [0, 1]);
		const calls = h.events.filter((e) => e.kind === "worker_model_call" && e.phase === "usage");
		assert.deepEqual(calls.map((e) => [e.attributes["slate.attempt.index"], e.attributes["slate.request.index"],
			e.attributes["gen_ai.provider.name"], e.attributes["gen_ai.request.model"]]), [[0, 0, "test", "worker"], [1, 0, "backup", "worker-2"]]);
		const compactions = h.events.filter((e) => e.kind === "worker_compaction" && e.phase === "usage");
		assert.deepEqual(compactions.map((e) => e.attributes["slate.attempt.index"]), [0, 1]);
		assert.throws(() => checkAgreement(h.events.filter((e) => e !== compactions[1]), h.store, [mode]));
		await h.manager.disposeAll();
	}
});

test("recovery unknown, zero and invalid quantities share the dispatch accounting boundary", async (t) => {
	for (const recovery of [{}, { input: 0, cost: { total: 0 } }, { input: 1.5 }, { cost: { total: -1 } },
		{ input: "4" }, { cost: { total: Number.MAX_VALUE } }] as BillingUsage[]) {
		const overflow = recovery.cost?.total === Number.MAX_VALUE;
		const h = fixture(t, "recovery", { worker: overflow ? { cost: { total: Number.MAX_VALUE } } : {}, recovery, compaction: {} });
		await h.call();
		const mark = h.outcomes()[0]!.attributes["slate.dispatch.invalid_accounting"];
		if (recovery.input && recovery.input !== 0) assert.equal(mark, "tokens");
		else if (recovery.cost?.total) assert.equal(mark, "cost");
		else { assert.equal(mark, undefined); checkAgreement(h.events, h.store, ["call"]); }
		await h.manager.disposeAll();
	}
});

test("parallel recoveries keep attempt parents, route labels and bills isolated", async (t) => {
	const h = fixture(t, "parallel-recovery");
	const a = h.call("a"), b = h.call("b");
	await h.entered.promise;
	while (h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
	h.release.resolve(); await Promise.all([a, b]);
	checkAgreement(h.events, h.store, ["a", "b"]);
	const starts = new Map(h.events.filter((e) => e.phase === "start").map((e) => [e.id, e]));
	for (const start of starts.values()) {
		if (!start.kind.startsWith("worker_")) continue;
		const parent = starts.get(start.parentId!)!;
		if (start.kind === "worker_attempt") assert.equal(parent.kind, "dispatch");
		else assert.equal(parent.attributes["slate.thread.id"], start.attributes["slate.thread.id"]);
		if (start.kind !== "worker_attempt") assert.equal(parent.attributes["slate.attempt.index"], start.attributes["slate.attempt.index"]);
	}
	assert.equal(h.events.filter((e) => e.kind === "worker_attempt" && e.phase === "start").length, 4);
	await h.manager.disposeAll();
});

test("telemetry off preserves recovery results and Slate cost and tokens", async (t) => {
	const run = async (enabled: boolean) => {
		const previous = process.env.SLATE_TELEMETRY;
		try {
			process.env.SLATE_TELEMETRY = enabled ? "1" : "0";
			const h = fixture(t, "recovery"); const result = await h.call();
			if (!enabled) assert.deepEqual(h.events, []);
			const episode = [...h.store.episodes.values()][0]!;
			await h.manager.disposeAll();
			return { status: result.details.status, cost: h.store.workerCostUsd, input: episode.input, output: episode.output, compaction: episode.compactionUsage };
		} finally { if (previous === undefined) delete process.env.SLATE_TELEMETRY; else process.env.SLATE_TELEMETRY = previous; }
	};
	assert.deepEqual(await run(true), await run(false));
});

test("parallel workers with identical tool ids keep distinct attempt and turn parents", { timeout: 5000 }, async (t) => {
	const h = fixture(t, "parallel");
	const a = h.call("a"), b = h.call("b");
	await h.entered.promise;
	while (h.opens() < 2) await new Promise<void>((done) => setImmediate(done));
	h.release.resolve(); await Promise.all([a, b]);
	const attempts = h.events.filter((e) => e.kind === "worker_attempt" && e.phase === "start");
	assert.equal(attempts.length, 2); assert.notEqual(attempts[0]!.parentId, attempts[1]!.parentId);
	const starts = h.events.filter((e) => e.phase === "start");
	for (const tool of starts.filter((e) => e.kind === "worker_tool")) {
		const parent = starts.find((e) => e.id === tool.parentId)!;
		assert.ok(parent);
		assert.equal(parent.attributes["slate.thread.id"], tool.attributes["slate.thread.id"]);
		assert.equal(parent.kind, tool.attributes["slate.tool.parent_call_id"] ? "worker_tool" : "worker_turn");
	}
	for (const turn of starts.filter((e) => e.kind === "worker_turn")) {
		assert.equal(starts.find((e) => e.id === turn.parentId)!.attributes["slate.thread.id"], turn.attributes["slate.thread.id"]);
	}
});
