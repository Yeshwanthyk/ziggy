import { Context, Effect, Layer } from "effect";
import type { AuthApi } from "./auth";
import { Auth } from "./auth";
import type { ModelsApi } from "./models";
import { Models } from "./models";
import { ProfileExtensions } from "./profile-extensions";
import type { DoctorReport } from "../domain/doctor";
import type { ProfileTarget } from "../domain/profile";
import type { ProfileExtensionsApi } from "../domain/profile-extension";

export interface DoctorApi {
  readonly check: (target: ProfileTarget, repositoryRoot: string) => Effect.Effect<DoctorReport>;
}

export class Doctor extends Context.Service<Doctor, DoctorApi>()("ziggy/Doctor") {}

/** Adapter-owned probes, composed only after the application has chosen its capabilities. */
export interface DoctorChecksApi {
  readonly check: (
    target: ProfileTarget,
    repositoryRoot: string,
    auth: AuthApi,
    models: ModelsApi,
    profileExtensions: ProfileExtensionsApi,
  ) => Effect.Effect<DoctorReport>;
}

export class DoctorChecks extends Context.Service<DoctorChecks, DoctorChecksApi>()(
  "ziggy/DoctorChecks",
) {}

export const makeDoctor = (
  auth: AuthApi,
  models: ModelsApi,
  profileExtensions: ProfileExtensionsApi,
  checks: DoctorChecksApi,
): DoctorApi => ({
  check: (target, repositoryRoot) =>
    checks.check(target, repositoryRoot, auth, models, profileExtensions),
});

export const DoctorLive = Layer.effect(
  Doctor,
  Effect.gen(function* () {
    return makeDoctor(yield* Auth, yield* Models, yield* ProfileExtensions, yield* DoctorChecks);
  }),
);
