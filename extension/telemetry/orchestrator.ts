import type { ExtensionAPI, ExtensionContext, ExtensionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Telemetry, TELEMETRY_CHANNEL, flushFailures, type TelemetryAttributes, type TelemetrySpan } from "./core.ts";
import { isChangeFolder } from "../artifact-names.ts";

type ModelCall = { span?: TelemetrySpan; ended?: number };
/** Observe only metadata and persisted billing entries. Never retain message content. */
export function registerTelemetry(pi: ExtensionAPI, logicalModel?: (provider: string, model: string) => string | undefined) {
	const telemetry = new Telemetry((event) => pi.events.emit(TELEMETRY_CHANNEL, event));
	let run: TelemetrySpan | undefined, turn: TelemetrySpan | undefined, model: ModelCall | undefined, compaction: TelemetrySpan | undefined;
	let sessionId = "";
	let seen = new Set<string>();
	const tools = new Map<string, TelemetrySpan | undefined>();
	const completedModels: ModelCall[] = [];
	const startupChanges: Array<{ attributes: TelemetryAttributes; time: number }> = [];
	const session = (): TelemetryAttributes => ({ "slate.session.id": sessionId,
		"slate.session.instance_id": telemetry.sessionIdentity(sessionId) });
	const flushStartupChanges = () => {
		if (!startupChanges.length) return;
		const changes = startupChanges.splice(0);
		const span = telemetry.start("session", session(), undefined, changes[0]!.time);
		for (const change of changes) telemetry.attachChange(span, change.attributes, change.time);
		telemetry.end(span, {}, changes.at(-1)!.time);
	};
	const ensureRun = () => {
		flushStartupChanges();
		return run ??= telemetry.start("run", session());
	};
	const route = (ctx: ExtensionContext): TelemetryAttributes => ({
		"gen_ai.provider.name": ctx.model?.provider, "gen_ai.request.model": ctx.model?.id,
		"slate.logical_model": ctx.model ? logicalModel?.(ctx.model.provider, ctx.model.id) : undefined,
	});
	const usageAttributes = (usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } }): TelemetryAttributes => ({
		"gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output,
		"gen_ai.usage.cache_read.input_tokens": usage.cacheRead, "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
		"gen_ai.usage.reasoning.output_tokens": usage.reasoning, "slate.gen_ai.cost.usd": usage.cost?.total,
	});
	const account = (entry: SessionEntry) => {
		if (seen.has(entry.id)) return;
		seen.add(entry.id);
		let usage, attributes: TelemetryAttributes = {}, call: ModelCall | undefined;
		if (entry.type === "message") {
			if (entry.message.role !== "assistant" && entry.message.role !== "toolResult") return;
			usage = entry.message.usage;
			if (entry.message.role === "assistant") {
				// New assistant entries match their orchestratorCostUsd contribution. Compaction
				// and summary usage use separate kinds and are excluded from that total.
				attributes = { "gen_ai.provider.name": entry.message.provider, "gen_ai.request.model": entry.message.model,
					"gen_ai.response.model": entry.message.responseModel ?? entry.message.model,
					"slate.logical_model": logicalModel?.(entry.message.provider, entry.message.model) };
				call = completedModels.shift();
			} else attributes["slate.kind"] = "tool_usage";
		} else if (entry.type === "usage") {
			usage = entry.usage;
			attributes = { "slate.kind": "session_usage", "gen_ai.provider.name": entry.provider, "gen_ai.response.model": entry.model };
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
			attributes["slate.kind"] = entry.type;
			if (entry.type === "compaction") { call = { span: compaction }; compaction = undefined; }
		} else return;
		// Summary entries expose aggregate usage but no physical route. Do not invent one.
		if (!usage && !call?.span) return;
		// Scan-only billing (including branch summaries) gets a bounded span, not a lazy run.
		const span = call?.span ?? telemetry.start("model", { ...session(), ...attributes }, turn ?? run);
		if (usage) telemetry.usage(span, { ...attributes, ...usageAttributes(usage) });
		// A scan-only observation has no measured start time.
		telemetry.end(span, attributes, call?.span ? call.ended : undefined, !!call?.span);
	};
	const scan = (ctx: ExtensionContext) => { for (const entry of ctx.sessionManager.getEntries()) account(entry); };
	const finish = (ctx: ExtensionContext, outcome: string) => {
		telemetry.guard("observer", () => scan(ctx));
		for (const span of [...tools.values()].reverse()) telemetry.end(span, { "slate.outcome": outcome });
		tools.clear();
		for (const call of completedModels.splice(0)) telemetry.end(call.span, {}, call.ended);
		telemetry.end(model?.span, { "slate.outcome": outcome }); model = undefined;
		telemetry.end(compaction, { "slate.outcome": outcome }); compaction = undefined;
		telemetry.end(turn, { "slate.outcome": outcome }); turn = undefined;
		flushStartupChanges();
		telemetry.end(run, { "slate.outcome": outcome }); run = undefined;
	};
	const on = <K extends ExtensionEvent["type"]>(name: K, handler: (event: Extract<ExtensionEvent, { type: K }>, ctx: ExtensionContext) => void) => {
		// Handlers return nothing, including when a telemetry sink throws.
		const subscribe = pi.on as unknown as (name: K, handler: (event: Extract<ExtensionEvent, { type: K }>, ctx: ExtensionContext) => void) => void;
		subscribe.call(pi, name, (event, ctx) => { telemetry.mode = ctx.mode; telemetry.guard("observer", () => handler(event, ctx)); });
	};
	on("agent_start", () => { ensureRun(); });
	on("turn_start", (event) => {
		telemetry.end(turn); turn = telemetry.start("turn", { ...session(), "slate.turn.index": event.turnIndex }, ensureRun());
	});
	on("before_provider_request", (_event, ctx) => {
		if (compaction) return;
		telemetry.end(model?.span);
		model = { span: telemetry.start("model", { ...session(), ...route(ctx) }, turn ?? ensureRun()) };
	});
	on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		completedModels.push({ span: model?.span, ended: Date.now() }); model = undefined;
	});
	on("tool_execution_start", (event, ctx) => {
		scan(ctx);
		const parent = event.parentToolCallId ? tools.get(event.parentToolCallId) : turn ?? ensureRun();
		tools.set(event.toolCallId, telemetry.start("tool", { ...session(), "slate.tool.name": event.toolName,
			"slate.tool.call_id": event.toolCallId, "slate.tool.parent_call_id": event.parentToolCallId }, parent));
	});
	on("tool_execution_end", (event) => {
		telemetry.end(tools.get(event.toolCallId), { "slate.outcome": event.isError ? "failed" : "succeeded" });
		tools.delete(event.toolCallId);
	});
	on("turn_end", (_event, ctx) => { scan(ctx); telemetry.end(turn); turn = undefined; });
	on("agent_end", (_event, ctx) => { finish(ctx, "completed"); });
	on("session_before_compact", () => {
		compaction = telemetry.start("model", { ...session(), "slate.kind": "compaction" }, turn ?? run);
	});
	on("session_compact", (event) => { account(event.compactionEntry); });
	on("session_compact_failed", (event) => {
		telemetry.end(compaction, { "slate.outcome": event.aborted ? "aborted" : "failed" }); compaction = undefined;
	});
	on("session_tree", (event) => { if (event.summaryEntry) account(event.summaryEntry); });
	const change = (action: "start" | "close", folder: string, source: string, toolCallId?: string, previous?: string) => {
		telemetry.guard("observer", () => {
			if (!isChangeFolder(folder)) return;
			const attributes: TelemetryAttributes = { ...session(), "slate.change": folder, "slate.outcome": action,
				"slate.change.source": source, "slate.change.previous": previous };
			const parent = toolCallId ? tools.get(toolCallId) : run;
			const time = Date.now();
			telemetry.change(parent, attributes, time);
			if (!parent) startupChanges.push({ attributes, time });
		});
	};
	return {
		telemetry,
		/** Called by the existing startup handler without adding an awaited boundary. */
		sessionStart(ctx: ExtensionContext) {
			telemetry.mode = ctx.mode;
			telemetry.guard("observer", () => {
				sessionId = ctx.sessionManager.getSessionId();
				seen = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
			});
		},
		/** Register after all Slate teardown hooks and before the exporter teardown. */
		registerShutdown() {
			pi.on("session_shutdown", (event, ctx) => {
				telemetry.mode = ctx.mode;
				telemetry.guard("observer", () => finish(ctx, event.reason));
				if (event.reason === "quit") flushFailures();
			});
		},
		/** Capture the parent context at dispatch admission by its own call id. */
		toolContext: (toolCallId: string) => tools.get(toolCallId)?.context,
		toolSpan: (toolCallId: string) => tools.get(toolCallId),
		change,
		/** Observe successful change commits without editing Slate's mode implementation. */
		changeTools(api: ExtensionAPI): ExtensionAPI {
			return Object.assign(Object.create(api), { registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
				if (tool.name !== "slate_change") { api.registerTool(tool); return; }
				api.registerTool({ ...tool, async execute(id, params, signal, update, ctx) {
					const result = await tool.execute(id, params, signal, update, ctx);
					telemetry.guard("observer", () => {
						// A concurrent call may already have changed the store again. Use this commit.
						const details = result.details as { action?: unknown; folder?: unknown } | undefined;
						if ((details?.action === "start" || details?.action === "close") && typeof details.folder === "string") {
							change(details.action, details.folder, "tool", id, details.action === "close" ? details.folder : undefined);
						}
					});
					return result;
				} });
			} });
		},
	};
}
