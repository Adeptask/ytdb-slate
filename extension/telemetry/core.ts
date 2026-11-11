import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace, metrics, SpanStatusCode, type Context, type Span } from "@opentelemetry/api";

export const TELEMETRY_CHANNEL = "slate.telemetry.v1";
export const FAILURE_KEY = Symbol.for("slate.telemetry.failures.v1");
type Failure = "observer" | "spans" | "metrics" | "publication";
type Failures = { seen: Set<Failure>; pending: Set<Failure> };
function failures(): Failures {
	const global = globalThis as typeof globalThis & { [FAILURE_KEY]?: Failures };
	return global[FAILURE_KEY] ??= { seen: new Set(), pending: new Set() };
}
export function reportFailure(kind: Failure, mode: string): void {
	const state = failures();
	if (state.seen.has(kind)) return;
	state.seen.add(kind);
	if (mode === "tui") state.pending.add(kind);
	else writeFailure(kind);
}
function writeFailure(kind: Failure): void {
	try { process.stderr.write(`slate: telemetry ${kind} failed. Some telemetry may be missing.\n`); }
	catch { /* A broken stderr must not change an agent result. */ }
}
export function flushFailures(): void {
	const state = failures();
	for (const kind of state.pending) writeFailure(kind);
	state.pending.clear();
}

export type TelemetryKind = "session" | "run" | "turn" | "model" | "tool" | "dispatch" | "worker_attempt" | "worker_turn" | "worker_tool" | "worker_model_call" | "worker_compaction";
export type TelemetryAttributes = Partial<Record<
	"slate.session.id" | "slate.session.instance_id" | "slate.change" | "slate.change.previous" | "slate.change.source" |
	"slate.tool.call_id" | "slate.tool.parent_call_id" | "slate.tool.name" |
	"slate.track" | "slate.thread.id" | "slate.episode.id" | "slate.episode.recorded" |
	"slate.dispatch.requested_model" | "slate.dispatch.final_model" | "slate.dispatch.requested_effort" | "slate.dispatch.final_effort" |
	"slate.dispatch.invalid_accounting" | "slate.kind" | "slate.outcome" | "slate.logical_model" | "slate.thread.type" |
	"gen_ai.provider.name" | "gen_ai.request.model" | "gen_ai.response.model", string
>> & Partial<Record<
	"slate.attempt.index" | "slate.request.index" | "slate.turn.index" | "gen_ai.usage.input_tokens" | "gen_ai.usage.output_tokens" |
	"gen_ai.usage.cache_read.input_tokens" | "gen_ai.usage.cache_creation.input_tokens" |
	"gen_ai.usage.reasoning.output_tokens" | "slate.gen_ai.cost.usd" | "slate.dispatch.not_stored_cost.usd", number
>>;
export type TelemetryEvent = Readonly<{
	version: 1;
	phase: "start" | "end" | "usage" | "change" | "admission";
	kind: TelemetryKind;
	id: string;
	parentId?: string;
	time: number;
	attributes: Readonly<TelemetryAttributes>;
	durationSeconds?: number;
}>;
export type TelemetrySpan = { id: string; kind: TelemetryKind; context: Context; started: number; parentId?: string; attributes: TelemetryAttributes; accounting?: DispatchAccounting };
const attributeKeys = new Set([
	"slate.session.id", "slate.session.instance_id", "slate.change", "slate.change.previous", "slate.change.source",
	"slate.tool.call_id", "slate.tool.parent_call_id", "slate.tool.name", "slate.kind",
	"slate.track", "slate.thread.id", "slate.episode.id", "slate.episode.recorded",
	"slate.dispatch.requested_model", "slate.dispatch.final_model", "slate.dispatch.requested_effort", "slate.dispatch.final_effort",
	"slate.dispatch.invalid_accounting", "slate.dispatch.not_stored_cost.usd",
	"slate.outcome", "slate.logical_model", "slate.thread.type", "slate.turn.index", "slate.attempt.index", "slate.request.index",
	"gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model",
	"gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens",
	"gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.reasoning.output_tokens", "slate.gen_ai.cost.usd",
]);
const metricKeys = ["slate.kind", "slate.outcome", "slate.logical_model", "slate.thread.type",
	"gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model"] as const;

const numericKeys = new Set(["slate.attempt.index", "slate.request.index", "slate.turn.index",
	"gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens",
	"gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.reasoning.output_tokens",
	"slate.gen_ai.cost.usd", "slate.dispatch.not_stored_cost.usd"]);
function validNumber(key: string, value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		&& (!key.startsWith("gen_ai.usage.") || Number.isInteger(value));
}

/** Shared by every hook of one dispatch, not by a route attempt or metric label. */
export class DispatchAccounting {
	private invalidCost = false;
	private invalidTokens = false;
	private totals = new Map<string, number>();
	get mark(): string | undefined {
		return this.invalidCost ? this.invalidTokens ? "both" : "cost" : this.invalidTokens ? "tokens" : undefined;
	}
	get costInvalid(): boolean { return this.invalidCost; }
	get costKnown(): boolean { return this.totals.has("slate.gen_ai.cost.usd"); }
	check(attributes: TelemetryAttributes): void {
		for (const [key, value] of Object.entries(attributes)) {
			if (value === undefined || !numericKeys.has(key) || validNumber(key, value)) continue;
			if (key.startsWith("gen_ai.usage.")) this.invalidTokens = true;
			else if (key.endsWith("cost.usd")) this.invalidCost = true;
		}
	}
	unrecorded(attributes: TelemetryAttributes): void {
		const cost = attributes["slate.gen_ai.cost.usd"];
		if (cost !== undefined && cost !== 0) this.invalidCost = true;
		if (Object.entries(attributes).some(([key, value]) => key.startsWith("gen_ai.usage.") && value !== undefined && value !== 0)) this.invalidTokens = true;
	}
	collect(attributes: TelemetryAttributes, source: "worker" | "compaction"): void {
		this.check(attributes);
		for (const [key, value] of Object.entries(attributes)) {
			if (!validNumber(key, value)) continue;
			// Check both component sums and the combined dispatch sum.
			for (const sumKey of [source + "/" + key, key]) {
				const sum = (this.totals.get(sumKey) ?? 0) + value;
				this.check({ [key]: sum });
				this.totals.set(sumKey, sum);
			}
		}
	}
}

/** One allowlisted event feeds both sinks. No SDK or global provider belongs here. */
export class Telemetry {
	private sequence = 0;
	private namespace = randomUUID();
	private spans = new Map<string, Span>();
	mode = "print";
	private publish: (event: TelemetryEvent) => void;
	readonly enabled: boolean;
	constructor(publish: (event: TelemetryEvent) => void, enabled = process.env.SLATE_TELEMETRY !== "0") {
		this.publish = publish;
		this.enabled = enabled;
	}
	guard(kind: Failure, action: () => void): void {
		if (!this.enabled) return;
		try { action(); } catch { reportFailure(kind, this.mode); }
	}
	start(kind: TelemetryKind, attributes: TelemetryAttributes = {}, parent?: TelemetrySpan, started = Date.now()): TelemetrySpan | undefined {
		if (!this.enabled) return undefined;
		const handle: TelemetrySpan = { id: `${this.namespace}/${++this.sequence}`, kind, context: parent?.context ?? ROOT_CONTEXT,
			started, parentId: parent?.id, attributes: { ...attributes }, accounting: parent?.accounting };
		this.record({ version: 1, phase: "start", kind, id: handle.id, parentId: handle.parentId, time: handle.started, attributes }, handle.accounting);
		const span = this.spans.get(handle.id);
		if (span) handle.context = trace.setSpan(handle.context, span);
		return handle;
	}
	end(handle: TelemetrySpan | undefined, attributes: TelemetryAttributes = {}, time = Date.now(), durationKnown = true): void {
		if (!handle) return;
		this.record({ version: 1, phase: "end", kind: handle.kind, id: handle.id, parentId: handle.parentId, time,
			durationSeconds: durationKnown ? Math.max(0, time - handle.started) / 1000 : undefined, attributes: { ...handle.attributes, ...attributes } }, handle.accounting);
	}
	usage(handle: TelemetrySpan | undefined, attributes: TelemetryAttributes): void {
		if (!handle) return;
		this.record({ version: 1, phase: "usage", kind: handle.kind, id: handle.id, time: Date.now(), attributes: { ...handle.attributes, ...attributes } }, handle.accounting);
	}
	admission(handle: TelemetrySpan | undefined, outcome: "wait" | "refused"): void {
		if (handle) this.record({ version: 1, phase: "admission", kind: handle.kind, id: handle.id,
			time: Date.now(), attributes: { "slate.outcome": outcome } });
	}
	/** Startup metadata and later spans share this session-instance identity. */
	sessionIdentity(sessionId: string): string { return `${this.namespace}/session/${sessionId}`; }
	change(handle: TelemetrySpan | undefined, attributes: TelemetryAttributes, time = Date.now()): void {
		this.record({ version: 1, phase: "change", kind: handle?.kind ?? "session",
			id: handle?.id ?? this.sessionIdentity(attributes["slate.session.id"] ?? ""), time, attributes });
	}
	/** A startup change has no span until the exporter has completed session_start. */
	attachChange(handle: TelemetrySpan | undefined, attributes: TelemetryAttributes, time: number): void {
		this.guard("spans", () => { if (handle) this.spans.get(handle.id)?.addEvent("slate.change", attributes, new Date(time)); });
	}
	private record(input: TelemetryEvent, accounting?: DispatchAccounting): void {
		this.guard("observer", () => {
			accounting?.check(input.attributes);
			const attributes: TelemetryAttributes = {};
			for (const [key, value] of Object.entries(input.attributes)) {
				if (attributeKeys.has(key) && (numericKeys.has(key) ? validNumber(key, value) : typeof value === "string")) {
					Object.assign(attributes, { [key]: value });
				}
			}
			const event: TelemetryEvent = Object.freeze({ ...input, attributes: Object.freeze(attributes) });
			this.guard("spans", () => this.mapSpan(event));
			this.guard("metrics", () => this.mapMetrics(event));
			this.guard("publication", () => this.publish(event));
		});
	}
	private mapSpan(event: TelemetryEvent): void {
		if (event.phase === "start") {
			const parent = event.parentId ? this.spans.get(event.parentId) : undefined;
			const context = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
			const name = event.kind === "dispatch" ? "slate.dispatch" : event.kind.startsWith("worker_")
				? `slate.worker.${event.kind.slice(7)}` : `slate.orchestrator.${event.kind}`;
			this.spans.set(event.id, trace.getTracer("slate", "1").startSpan(name,
				{ attributes: event.attributes, startTime: new Date(event.time) }, context));
			return;
		}
		const span = this.spans.get(event.id);
		if (event.phase === "change") { span?.addEvent("slate.change", event.attributes, new Date(event.time)); return; }
		if (event.phase === "admission") { span?.addEvent("slate.request." + event.attributes["slate.outcome"], event.attributes, new Date(event.time)); return; }
		if (event.phase === "usage") { span?.setAttributes(event.attributes); return; }
		this.spans.delete(event.id);
		if (span) {
			try {
				span.setAttributes(event.attributes);
				if (["failed", "stored but failed"].includes(event.attributes["slate.outcome"] ?? "")) span.setStatus({ code: SpanStatusCode.ERROR });
			} finally { span.end(new Date(event.time)); }
		}
	}
	private mapMetrics(event: TelemetryEvent): void {
		if (event.phase !== "usage" && event.phase !== "end") return;
		const meter = metrics.getMeter("slate", "1");
		const labels: Record<string, string> = {};
		for (const key of metricKeys) {
			const value = event.attributes[key];
			if (value !== undefined) labels[key] = value;
		}
		labels["slate.kind"] ??= event.kind;
		if (event.phase === "end") {
			if (event.durationSeconds !== undefined) meter.createHistogram("slate.duration", { unit: "s" }).record(event.durationSeconds, labels);
			return;
		}
		for (const [key, value] of Object.entries(event.attributes)) {
			if (key.startsWith("gen_ai.usage.") && typeof value === "number") {
				meter.createCounter("slate.model.tokens", { unit: "{token}" }).add(value, { ...labels, "slate.token.kind": key.slice(13) });
			}
		}
		const cost = event.attributes["slate.gen_ai.cost.usd"];
		if (typeof cost === "number") meter.createCounter("slate.model.cost", { unit: "USD" }).add(cost, labels);
	}
}
