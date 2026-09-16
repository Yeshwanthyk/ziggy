/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeSlackGatewayConfigJson } from "ziggy/domain/slack";

describe("Slack gateway configuration", () => {
  test("decodes optional per-channel activation overrides", () => {
    const base = { botToken: "xoxb-test", appToken: "xapp-test", ownerUserId: "U123" };

    expect(Effect.runSync(decodeSlackGatewayConfigJson(JSON.stringify(base)))).toEqual(base);
    expect(
      Effect.runSync(
        decodeSlackGatewayConfigJson(
          JSON.stringify({
            ...base,
            channels: {
              C0A06UL1CKW: "always",
              C0BP3QUQ3CL: "mention",
            },
          }),
        ),
      ),
    ).toEqual({
      ...base,
      channels: {
        C0A06UL1CKW: "always",
        C0BP3QUQ3CL: "mention",
      },
    });
  });

  test("accepts explicit busy message modes and leaves omission to the steer default", () => {
    const base = { botToken: "bot", appToken: "app", ownerUserId: "U123" };

    for (const busyMessageMode of ["queue", "steer"] as const) {
      const config = { ...base, busyMessageMode };
      expect(Effect.runSync(decodeSlackGatewayConfigJson(JSON.stringify(config)))).toEqual(config);
    }
  });

  test("rejects global policy, unknown modes, invalid channel ids, and unknown fields", () => {
    const base = { botToken: "xoxb-test", appToken: "xapp-test", ownerUserId: "U123" };

    const invalid = [
      { ...base, busyMessageMode: "interrupt" },
      { ...base, channelMode: "mention" },
      { ...base, channels: { general: "mention" } },
      { ...base, channels: { C0BP3QUQ3CL: "sometimes" } },
      { ...base, unexpected: true },
    ];

    for (const config of invalid) {
      expect(
        Effect.runSync(decodeSlackGatewayConfigJson(JSON.stringify(config)).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }
  });
});
