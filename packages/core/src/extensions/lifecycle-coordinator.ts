import { resolve } from "node:path";
import { Effect, Semaphore } from "effect";

const gates = new Map<string, Semaphore.Semaphore>();

export function withExtensionLifecyclePermit<Value, Error, Requirements>(
  profilePath: string,
  extensionId: string,
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> {
  const key = `${resolve(profilePath)}\0${extensionId}`;
  let gate = gates.get(key);
  if (gate === undefined) {
    gate = Semaphore.makeUnsafe(1);
    gates.set(key, gate);
  }
  return Semaphore.withPermit(gate, effect);
}

export function withExtensionPublicationPermit<Value, Error, Requirements>(
  profilePath: string,
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, Error, Requirements> {
  return withExtensionLifecyclePermit(profilePath, "\0publication", effect);
}
