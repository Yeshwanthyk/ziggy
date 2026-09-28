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

export const renderSetupRecovery = (report: DoctorReport): string => {
  const profile = JSON.stringify(report.profilePath);

  const hints = new Set(
    report.checks
      .filter((check) => check.severity === "error")
      .map((check) =>
        check.id === "auth"
          ? `ziggy auth ${profile}`
          : check.id === "model"
            ? `ziggy models set ${profile} <provider>/<model>`
            : `ziggy doctor ${profile}`,
      ),
  );

  return `setup incomplete; fix with: ${[...hints].join("; ")}`;
};
