import type { TelemetrySpan } from "./core.ts";

export type RequestObservation = {
	wait(): void;
	refused(): void;
	admit(model: { provider: string; id: string }): TelemetrySpan | undefined;
	failed(span: TelemetrySpan | undefined): void;
	returned(span: TelemetrySpan | undefined, value: unknown): void;
};
const observers = new WeakMap<object, () => RequestObservation>();
export function observeRequests(session: object, observe: () => RequestObservation): () => void {
	observers.set(session, observe);
	return () => { observers.delete(session); };
}
export function requestObservation(session: object): RequestObservation | undefined {
	return observers.get(session)?.();
}
/** Delegate without inspecting, consuming, or replacing the provider stream. */
export function requestHandoff<T>(request: RequestObservation | undefined, model: { provider: string; id: string }, send: () => T): T {
	const span = request?.admit(model);
	try { const value = send(); request?.returned(span, value); return value; }
	catch (error) { request?.failed(span); throw error; }
}
