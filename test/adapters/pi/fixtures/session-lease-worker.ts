/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Disposable Bun test worker is an approved test execution boundary */
import { Effect } from "effect";
import { acquireSessionLease, SessionLeaseHeld } from "ziggy/adapters/pi/session-lease";

export type LeaseWorkerFixture = string;

const [profile, id, duration] = process.argv.slice(2);

if (profile === undefined || id === undefined || duration === undefined) process.exit(2);

const result = await Effect.runPromiseExit(acquireSessionLease(profile, id));

if (result._tag === "Failure") {
  const error = result.cause.reasons[0];

  if (error?._tag === "Fail" && error.error instanceof SessionLeaseHeld) {
    console.log("held");
    process.exit(0);
  }

  process.exit(3);
}

console.log("won");

await Bun.sleep(Number(duration));

await Effect.runPromise(result.value);
