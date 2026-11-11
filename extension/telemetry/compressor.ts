import { DispatchAccounting, Telemetry, type TelemetryAttributes, type TelemetrySpan } from "./core.ts";

type CompressorRoute = { logicalModel: string; provider: string; model: string };

/** One serial compressor sequence belongs to one dispatch, never to a worker attempt. */
export class CompressorTelemetry {
	private operation?: TelemetrySpan;
	private current?: { span?: TelemetrySpan; outcome: string };
	private attemptSpan?: TelemetrySpan;
	private attributes: TelemetryAttributes;
	private attempts = 0;
	private requests = 0;
	collectedCost?: number;
	constructor(telemetry: Telemetry, parent: TelemetrySpan | undefined, attributes: TelemetryAttributes, accounting: DispatchAccounting) {
		this.telemetry = telemetry;
		this.accounting = accounting;
		this.attributes = attributes;
		telemetry.guard("observer", () => { this.operation = telemetry.start("compressor", attributes, parent); });
	}
	private telemetry: Telemetry;
	private accounting: DispatchAccounting;
	async attempt<T extends { kind: string }>(candidate: CompressorRoute, run: () => Promise<T>): Promise<T> {
		this.telemetry.guard("observer", () => {
			this.attributes = { ...this.attributes, "slate.logical_model": candidate.logicalModel,
				"gen_ai.provider.name": candidate.provider, "gen_ai.request.model": candidate.model,
				"slate.attempt.index": this.attempts++ };
			this.requests = 0;
			this.attemptSpan = this.telemetry.start("compressor_attempt", this.attributes, this.operation);
		});
		let outcome = "failed";
		try {
			const result = await run();
			outcome = result.kind === "success" ? "succeeded" : result.kind === "cancelled" ? "cancelled" : "failed";
			return result;
		} finally {
			this.telemetry.guard("observer", () => { this.telemetry.end(this.attemptSpan, { "slate.outcome": outcome }); });
			this.attemptSpan = undefined;
		}
	}
	async request<T>(run: () => Promise<T>): Promise<T> {
		const call: { span?: TelemetrySpan; outcome: string } = { outcome: "failed" };
		this.current = call;
		this.telemetry.guard("observer", () => {
			call.span = this.telemetry.start("compressor_request",
				{ ...this.attributes, "slate.request.index": this.requests++ }, this.attemptSpan);
		});
		try { return await run(); }
		finally {
			this.telemetry.guard("observer", () => { this.telemetry.end(call.span, { "slate.outcome": call.outcome }); });
			this.current = undefined;
		}
	}
	measured(response: unknown, collectedCost: number | undefined): void {
		this.telemetry.guard("observer", () => {
			// This total is supplied by Slate's onMeasured collector, not by telemetry sums.
			this.collectedCost = collectedCost;
			const message = response as { stopReason?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | null;
			const u = message?.usage;
			const attributes: TelemetryAttributes = { "gen_ai.usage.input_tokens": u?.input, "gen_ai.usage.output_tokens": u?.output,
				"gen_ai.usage.cache_read.input_tokens": u?.cacheRead, "gen_ai.usage.cache_creation.input_tokens": u?.cacheWrite,
				"slate.gen_ai.cost.usd": u?.cost?.total };
			this.accounting.collect(attributes, "compressor");
			if (this.current) this.current.outcome = message?.stopReason === "aborted" ? "cancelled"
				: message?.stopReason === "error" ? "failed" : "succeeded";
			const span = this.current?.span;
			try { this.telemetry.usage(span, attributes); }
			catch (error) { this.accounting.unrecorded(attributes); throw error; }
			if (!span) this.accounting.unrecorded(attributes);
		});
	}
	finish(outcome: string): void {
		this.telemetry.guard("observer", () => {
			this.telemetry.end(this.operation, { "slate.outcome": outcome });
		});
		this.operation = undefined;
	}
}

/** Delegate without changing retry producers or their returned values. */
export function compressorAttempt<T extends { kind: string }>(observer: CompressorTelemetry | undefined, candidate: CompressorRoute, run: () => Promise<T>): Promise<T> {
	return observer ? observer.attempt(candidate, run) : run();
}
export function compressorRequest<T>(observer: CompressorTelemetry | undefined, run: () => Promise<T>): Promise<T> {
	return observer ? observer.request(run) : run();
}
