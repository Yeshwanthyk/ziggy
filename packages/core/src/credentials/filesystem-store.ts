import type { CredentialStore } from "@earendil-works/pi-ai";
import { Effect, FiberSet, Schema, Scope, Semaphore } from "effect";
import {
  createNodeCredentialStore,
  nodeCredentialErrorMessage,
  serializeNodeCredentialStore,
} from "./filesystem-store-node-adapter.ts";

export class CredentialStoreError extends Schema.TaggedErrorClass<CredentialStoreError>()(
  "CredentialStoreError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export function createProfileCredentialStore(
  profilePath: string,
): Effect.Effect<CredentialStore, CredentialStoreError, Scope.Scope> {
  return Effect.gen(function* () {
    const node = yield* credentialOperation("Failed to open Profile credential store", () =>
      createNodeCredentialStore(profilePath),
    );
    const gate = yield* Semaphore.make(1);
    const fibers = yield* FiberSet.make<unknown, CredentialStoreError>();
    const runPromise = yield* FiberSet.runtimePromise(fibers)<never>();
    return serializeNodeCredentialStore(node, gate, runPromise, credentialOperation);
  });
}

function credentialOperation<Value>(
  operation: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: pi-ai CredentialStore and Node adapters are Promise-only
  run: () => Promise<Value>,
): Effect.Effect<Value, CredentialStoreError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new CredentialStoreError({
        message: nodeCredentialErrorMessage(cause, operation),
        cause,
      }),
  });
}
