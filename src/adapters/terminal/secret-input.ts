import { isCancel, password } from "@clack/prompts";
import { Effect } from "effect";
import { TerminalInteractionFailed } from "../../domain/terminal-interaction";

const stripNewline = (value: string): string => value.replace(/\r?\n$/u, "");

/**
 * One secret value: a masked prompt on a terminal, otherwise all of stdin less one trailing
 * newline. The value is never echoed; undefined means the prompt was cancelled.
 */
export const readSecretInput = (message: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (process.stdin.isTTY !== true) return stripNewline(await Bun.stdin.text());

      const value = await password({ message, mask: "•", signal });

      return isCancel(value) ? undefined : value;
    },
    catch: (cause) => new TerminalInteractionFailed({ operation: "read secret", cause }),
  });
