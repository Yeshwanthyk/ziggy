import { Schema } from "effect";

export const DoctorSeverity = Schema.Literals(["ok", "warn", "error"]);
export type DoctorSeverity = typeof DoctorSeverity.Type;

export const DoctorCheck = Schema.Struct({
  id: Schema.String,
  severity: DoctorSeverity,
  message: Schema.String,
});
export type DoctorCheck = typeof DoctorCheck.Type;

export interface DoctorReport {
  readonly profilePath: string;
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly hasErrors: boolean;
}

export const doctorReport = (
  profilePath: string,
  checks: ReadonlyArray<DoctorCheck>,
): DoctorReport => ({
  profilePath,
  checks,
  hasErrors: checks.some((check) => check.severity === "error"),
});
