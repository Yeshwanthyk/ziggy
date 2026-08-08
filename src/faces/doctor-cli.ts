import type { DoctorReport } from "../domain/doctor";

export interface RenderedDoctor {
  readonly text: string;
  readonly exitCode: 0 | 1;
}

export const renderDoctor = (report: DoctorReport): RenderedDoctor => ({
  text: report.checks
    .map((check) => `${check.severity.toUpperCase()}\t${check.id}\t${check.message}`)
    .join("\n"),
  exitCode: report.hasErrors ? 1 : 0,
});
