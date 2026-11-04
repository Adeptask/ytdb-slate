import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { Telemetry, type TelemetryEvent } from "../extension/telemetry/core.ts";
import { SlateStore } from "../extension/state.ts";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";

function harness(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "slate-telemetry-hooks-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, any>(), events: TelemetryEvent[] = [];
	const entries: any[] = [];
	let branch: any[] = [], active = ["read"], failSave = false, failNextSave = false, sessionId = "session";
	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		events: { emit(_name: string, event: TelemetryEvent) { events.push(event); } },
		registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
		getActiveTools: () => active, setActiveTools(value: string[]) { active = value; },
		getAllTools: () => [...tools.keys()].map((name) => ({ name })), getThinkingLevel: () => "off",
		appendEntry(customType: string, data: unknown) {
			if (failSave || failNextSave) { failNextSave = false; throw Error(); }
			const entry = { id: String(entries.length), type: "custom", customType, data: structuredClone(data) };
			entries.push(entry); branch.push(entry);
		},
	};
	const ctx = { cwd, mode: "rpc", hasUI: false, isProjectTrusted: () => true, model: undefined,
		modelRegistry: {}, isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getBranch: () => branch, getEntries: () => entries },
		ui: { notify() {}, setWidget() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	extension(pi as unknown as ExtensionAPI);
	const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	return { cwd, events, entries, emit,
		seed(currentChange?: string, owner = "session") {
			branch = [{ type: "custom", customType: "slate-state", data: { format: "single-action-v1", threads: [], episodes: [],
				orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0,
				currentChange, changeOwnerSessionId: currentChange ? owner : undefined } }];
		},
		handoff(currentChange: string) {
			branch = [{ type: "custom", customType: "slate-handoff", data: { sessionId,
				snapshot: { format: "single-action-v1", threads: [], episodes: [], orchestratorMode: true,
					currentChange, changeOwnerSessionId: "parent", paused: true } } }];
		},
		failSave(value: boolean) { failSave = value; }, failNextSave() { failNextSave = true; }, session(value: string) { sessionId = value; },
		async change(action: string) {
			const id = String(events.length);
			await emit("tool_execution_start", { toolCallId: id, toolName: "slate_change" });
			try {
				const result = await tools.get("slate_change").execute(id, { action }, undefined, undefined, ctx);
				await emit("tool_execution_end", { toolCallId: id, isError: false }); return result;
			} catch (error) { await emit("tool_execution_end", { toolCallId: id, isError: true }); throw error; }
		},
		changes() { return events.filter((event) => event.phase === "change"); },
	};
}

test("real change tool emits exactly once after save, not on rejected or rolled-back actions", async (t) => {
	const h = harness(t); h.seed(); await h.emit("session_start");
	await assert.rejects(h.change("close")); assert.equal(h.changes().length, 0);
	h.failSave(true); await assert.rejects(h.change("start")); assert.equal(h.changes().length, 0); h.failSave(false);
	const result = await h.change("start");
	assert.equal(h.changes().length, 1); assert.equal(result.details.action, "start");
	const folder = result.details.folder;
	assert.equal(h.changes()[0]!.attributes["slate.session.id"], "session");
	assert.equal(h.changes()[0]!.attributes["slate.change"], folder);
	await assert.rejects(h.change("start")); assert.equal(h.changes().length, 1);
	h.failSave(true); await assert.rejects(h.change("close")); assert.equal(h.changes().length, 1); h.failSave(false);
	const closed = await h.change("close"); assert.equal(closed.details.action, "close");
	assert.equal(h.changes().length, 2); assert.equal(h.changes()[1]!.attributes["slate.outcome"], "close");
	assert.ok(h.changes().every((event) => event.id !== "session"));
	await h.emit("session_shutdown", { reason: "quit" });
});

test("parallel change calls report their own successful commits", async (t) => {
	const h = harness(t), source = createChangeFolder(); createChangeDirectory(h.cwd, source); h.seed(source);
	await h.emit("session_start");
	const [closed, started] = await Promise.all([h.change("close"), h.change("start")]);
	assert.equal(closed.details.folder, source);
	assert.deepEqual(h.changes().map((e) => [e.attributes["slate.outcome"], e.attributes["slate.change"]]),
		[["close", source], ["start", started.details.folder]]);
	assert.notEqual(h.changes()[0]!.id, h.changes()[1]!.id);
	await h.change("close");
	const before = h.changes().length;
	const results = await Promise.allSettled([h.change("start"), h.change("start")]);
	assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
	assert.equal(h.changes().length, before + 1);
	assert.equal(h.changes().at(-1)!.attributes["slate.change"],
		(results[0] as PromiseFulfilledResult<any>).value.details.folder);
	await h.emit("session_shutdown", { reason: "quit" });
});

test("handoff adoption continues the parent change without an allocation event", async (t) => {
	const h = harness(t), source = createChangeFolder(); createChangeDirectory(h.cwd, source); h.handoff(source);
	await h.emit("session_start");
	assert.equal(h.changes().length, 0);
	assert.equal(h.entries.at(-1).data.currentChange, source);
	assert.equal(h.entries.at(-1).data.changeOwnerSessionId, "session");
	await h.emit("session_start");
	assert.equal(h.changes().length, 0);
	assert.equal((await h.change("close")).details.folder, source);
	assert.equal(h.changes().length, 1);
	await h.emit("session_shutdown", { reason: "quit" });
});

test("automatic ownership allocation emits once and restoring ownership emits nothing", async (t) => {
	const h = harness(t), source = createChangeFolder(); createChangeDirectory(h.cwd, source); h.seed(source, "parent");
	await h.emit("session_start");
	assert.equal(h.changes().length, 1);
	const change = h.changes()[0]!;
	assert.equal(change.attributes["slate.change.previous"], source);
	assert.equal(change.attributes["slate.change.source"], "allocation");
	assert.equal(change.attributes["slate.session.id"], "session");
	assert.notEqual(change.attributes["slate.change"], source);
	await h.emit("session_start"); assert.equal(h.changes().length, 1);
	await h.emit("agent_start"); await h.emit("agent_end");
	await h.emit("session_shutdown", { reason: "quit" });
});

test("failed allocation clears the change and emits once even if its save also fails", async (t) => {
	for (const failSave of [false, true]) {
		const h = harness(t), source = createChangeFolder(); createChangeDirectory(h.cwd, source); h.seed(source, "parent");
		mkdirSync(join(h.cwd, ".pi")); writeFileSync(join(h.cwd, ".pi", "slate.json"), "{}");
		// Keep source validation valid while making every new change allocation fail.
		rmSync(join(h.cwd, "slate-changes"), { recursive: true });
		writeFileSync(join(h.cwd, "slate-changes"), "fixture");
		if (failSave) {
			const realSave = SlateStore.prototype.save;
			t.mock.method(SlateStore.prototype, "save", function(this: SlateStore, ...args: Parameters<SlateStore["save"]>) {
				if (!this.currentChange) throw Error(); return Reflect.apply(realSave, this, args);
			});
		}
		await h.emit("session_start");
		assert.equal(h.changes().length, 1);
		assert.equal(h.changes()[0]!.attributes["slate.change.source"], "allocation_failed");
		assert.equal(h.changes()[0]!.attributes["slate.outcome"], "close");
		await assert.rejects(h.change("close"));
		await h.emit("session_shutdown", { reason: "quit" });
		t.mock.restoreAll();
	}
});

test("telemetry failures leave the change tool result and persisted state intact", async (t) => {
	const h = harness(t); h.seed(); await h.emit("session_start");
	t.mock.method(Telemetry.prototype, "change", () => { throw Error(); });
	const output: string[] = [];
	t.mock.method(process.stderr, "write", ((text: string) => { output.push(text); return true; }) as typeof process.stderr.write);
	const start = await h.change("start"); const close = await h.change("close");
	assert.equal(start.details.action, "start"); assert.equal(close.details.action, "close");
	assert.equal(h.entries.at(-1).data.currentChange, undefined);
	assert.equal(output.length, 1);
	await h.emit("session_shutdown", { reason: "quit" });
});
