import { createInterface } from "node:readline";
import { Effect } from "effect";
import { SetupIncomplete } from "../../domain/setup";
import type { SetupChoice, SetupInteraction } from "../../application/setup";
import { terminalAuthInteraction } from "./auth-interaction";

const readLine = (): Promise<string> =>
  new Promise((resolve) => {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    readline.question("> ", (answer) => {
      readline.close();
      process.stdin.pause();
      resolve(answer);
    });
  });

const select = (
  profilePath: string,
  message: string,
  choices: ReadonlyArray<SetupChoice>,
): Effect.Effect<string, SetupIncomplete> =>
  Effect.gen(function* () {
    console.log(message);
    choices.forEach((choice, index) => console.log(`${index + 1}) ${choice.label}`));
    while (true) {
      const answer = yield* Effect.tryPromise({
        try: () => readLine(),
        catch: () =>
          new SetupIncomplete({
            profilePath,
            message: "terminal setup prompt failed",
          }),
      });
      const index = Number(answer.trim());
      const selected =
        Number.isInteger(index) && index >= 1 && index <= choices.length
          ? choices[index - 1]
          : choices.find((choice) => choice.id === answer.trim());
      if (selected !== undefined) return selected.id;
      console.log("invalid selection; enter an option number or id");
    }
  });

export const terminalSetupInteraction = (profilePath: string): SetupInteraction => ({
  select: (message, choices) => select(profilePath, message, choices),
  auth: terminalAuthInteraction(),
});
