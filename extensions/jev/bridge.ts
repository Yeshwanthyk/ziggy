/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-instanceof-error, ziggy/no-unknown-parameters, ziggy/require-readable-spacing -- The provider bridge validates an accepted event and converts all request failures into bounded replies. */

import { JevFailure, type JevClient, type JevEvaluationOptions } from "./client.ts";
import {
  isBridgeRequest,
  JEV_BRIDGE_CHANNEL,
  JEV_BRIDGE_VERSION,
  parseEvaluateRequest,
  type JevBridgeReply,
} from "./contract.ts";

export { bridgeRequest, requestJevJudgment } from "./caller.ts";

export type JevClientResolver = (profilePath: string) => Promise<JevClient>;

const safeMessage = (cause: unknown): string => {
  if (cause instanceof JevFailure) return cause.message.slice(0, 1_024);
  if (cause instanceof Error) return cause.message.slice(0, 1_024);
  return "Jev evaluation failed.";
};

const failureCode = (cause: unknown): string =>
  cause instanceof JevFailure ? cause.code : "upstream_http";

export const createJevBridgeHandler =
  (resolveClient: JevClientResolver): ((data: unknown) => void) =>
  (data) => {
    if (!isBridgeRequest(data)) return;
    data.accept();
    void (async () => {
      try {
        let request;
        try {
          request = parseEvaluateRequest(data.request);
        } catch (cause) {
          throw new JevFailure(
            "request_invalid",
            cause instanceof Error ? cause.message : "Invalid Jev request.",
          );
        }
        const client = await resolveClient(data.profilePath);
        const evaluationOptions: JevEvaluationOptions = {};
        if (data.signal !== undefined) evaluationOptions.signal = data.signal;
        if (data.deadlineMs !== undefined) evaluationOptions.deadlineMs = data.deadlineMs;
        const evaluation = await client.evaluate(request, evaluationOptions);
        const reply: JevBridgeReply = {
          version: JEV_BRIDGE_VERSION,
          requestId: data.requestId,
          ok: true,
          evaluation,
        };
        data.reply(reply);
      } catch (cause) {
        const reply: JevBridgeReply = {
          version: JEV_BRIDGE_VERSION,
          requestId: data.requestId,
          ok: false,
          error: { code: failureCode(cause), message: safeMessage(cause) },
        };
        data.reply(reply);
      }
    })();
  };

export { JEV_BRIDGE_CHANNEL, JEV_BRIDGE_VERSION };
