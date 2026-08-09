/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeSlackGatewayConfigJson } from "./slack";

describe("Slack gateway configuration", () => {
  test("decodes both explicit channel modes while preserving existing configurations", () => {
    const base = { botToken: "xoxb-test", appToken: "xapp-test", ownerUserId: "U123" };

    expect(Effect.runSync(decodeSlackGatewayConfigJson(JSON.stringify(base)))).toEqual(base);
    expect(
      Effect.runSync(
        decodeSlackGatewayConfigJson(JSON.stringify({ ...base, channelMode: "mention" })),
      ),
    ).toEqual({ ...base, channelMode: "mention" });
    expect(
      Effect.runSync(
        decodeSlackGatewayConfigJson(JSON.stringify({ ...base, channelMode: "always" })),
      ),
    ).toEqual({ ...base, channelMode: "always" });
  });

  test("rejects an unknown channel mode", () => {
    const result = Effect.runSync(
      decodeSlackGatewayConfigJson(
        JSON.stringify({
          botToken: "xoxb-test",
          appToken: "xapp-test",
          ownerUserId: "U123",
          channelMode: "sometimes",
        }),
      ).pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
  });
});
