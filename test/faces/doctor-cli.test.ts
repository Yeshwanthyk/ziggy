import { expect, test } from "bun:test";
import { doctorReport } from "ziggy/domain/doctor";
import { renderSetupRecovery } from "ziggy/faces/doctor-cli";

test("failed init names corrective commands for each failed doctor check", () => {
  const profile = "/tmp/my profile";

  const checks = [
    { id: "auth", severity: "error" as const, message: "auth failed" },
    { id: "model", severity: "error" as const, message: "model failed" },
    { id: "memory", severity: "warn" as const, message: "not relevant" },
  ];

  expect(renderSetupRecovery(doctorReport(profile, checks))).toBe(
    'setup incomplete; fix with: ziggy auth "/tmp/my profile"; ziggy models set "/tmp/my profile" <provider>/<model>',
  );
  expect(
    renderSetupRecovery(
      doctorReport(profile, [{ id: "extensions", severity: "error", message: "broken" }]),
    ),
  ).toBe('setup incomplete; fix with: ziggy doctor "/tmp/my profile"');
});
