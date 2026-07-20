import type { ProviderCall } from "./provider/scripted.ts";
import type { SessionEnvelope } from "../../packages/protocol/src/index.ts";

export const VERIFICATION_OBSERVATION_MARKER = "ZIGGY_VERIFICATION_OBSERVATION ";

export interface CanonicalEventObservation {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly emittedAt: string;
  readonly eventType: string;
  readonly sessionId: string;
}

export interface ProviderInputObservation {
  readonly callIndex: number;
  readonly sessionId: string | null;
  readonly cacheRetention: "none" | "short" | "long" | null;
  readonly provider: string;
  readonly model: string;
  readonly systemPromptCodePoints: number;
  readonly messageRoles: ReadonlyArray<string>;
  readonly toolNames: ReadonlyArray<string>;
}

interface FaultScheduleObservation {
  readonly boundary: string;
  readonly point: string;
  readonly occurrence: number;
  readonly outcome: "continued" | "failed" | "recovered";
}

interface FilesystemDiffObservation {
  readonly path: string;
  readonly change: "created" | "modified" | "deleted" | "unchanged";
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
}

export interface RuntimeObservations {
  readonly canonicalEventTrace: ReadonlyArray<CanonicalEventObservation>;
  readonly providerInputs: ReadonlyArray<ProviderInputObservation>;
  readonly faultSchedule: ReadonlyArray<FaultScheduleObservation>;
  readonly filesystemDiffs: ReadonlyArray<FilesystemDiffObservation>;
}

export function emptyRuntimeObservations(): RuntimeObservations {
  return {
    canonicalEventTrace: [],
    providerInputs: [],
    faultSchedule: [],
    filesystemDiffs: [],
  };
}

export function observeCanonicalEvents(
  envelopes: ReadonlyArray<SessionEnvelope>,
): ReadonlyArray<CanonicalEventObservation> {
  return envelopes.map((envelope) => ({
    schemaVersion: envelope.schemaVersion,
    seq: envelope.seq,
    emittedAt: envelope.emittedAt,
    eventType: envelope.event.type,
    sessionId: envelope.event.sessionId,
  }));
}

export function observeProviderInputs(
  calls: ReadonlyArray<ProviderCall>,
): ReadonlyArray<ProviderInputObservation> {
  return calls.map((call, callIndex) => ({
    callIndex,
    sessionId: call.options.sessionId ?? null,
    cacheRetention: call.options.cacheRetention ?? null,
    provider: call.model.provider,
    model: call.model.id,
    systemPromptCodePoints: [...(call.context.systemPrompt ?? "")].length,
    messageRoles: call.context.messages.map((message) => message.role),
    toolNames: call.context.tools?.map((tool) => tool.name) ?? [],
  }));
}

export function fixtureDigest(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export function emitVerificationObservation(
  scenarioId: string,
  observations: RuntimeObservations,
): void {
  console.log(`${VERIFICATION_OBSERVATION_MARKER}${JSON.stringify({ scenarioId, observations })}`);
}
