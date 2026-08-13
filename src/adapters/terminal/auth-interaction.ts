import { createInterface } from "node:readline";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "../pi/auth";

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new Error("authentication prompt aborted");
  }
};

const printPrompt = (message: string, placeholder: string | undefined): void => {
  console.log(placeholder === undefined ? message : `${message} (${placeholder})`);
};

const readLine = (signal: AbortSignal | undefined): Promise<string> => {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const readline = createInterface({
      input,
      output: process.stdout,
      terminal: process.stdout.isTTY,
    });
    let settled = false;

    const finish = (result: { readonly value: string } | { readonly error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      readline.close();
      input.pause();
      if ("value" in result) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };
    const onAbort = () => finish({ error: new Error("authentication prompt aborted") });

    signal?.addEventListener("abort", onAbort, { once: true });
    readline.question("", (answer) => finish({ value: answer }));
  });
};

const readSecret = (signal: AbortSignal | undefined): Promise<string> => {
  if (!process.stdin.isTTY) {
    throw new Error("secret prompt requires an interactive terminal");
  }
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const previousRawMode = input.isRaw;
    let value = "";
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      input.removeListener("data", onData);
      input.setRawMode(previousRawMode);
      process.stdout.write("\n");
    };
    const finish = (result: { readonly value: string } | { readonly error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if ("value" in result) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };
    const onAbort = () => finish({ error: new Error("authentication prompt aborted") });
    const onData = (chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const character of text) {
        if (character === "\u0003") {
          finish({ error: new Error("authentication cancelled") });
          return;
        }
        if (character === "\r" || character === "\n") {
          finish({ value });
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
        }
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    input.setRawMode(true);
    input.on("data", onData);
  });
};

const promptForValue = async (prompt: AuthPrompt): Promise<string> => {
  switch (prompt.type) {
    case "text":
    case "manual_code":
      printPrompt(prompt.message, prompt.placeholder);
      return readLine(prompt.signal);
    case "secret":
      printPrompt(prompt.message, prompt.placeholder);
      return readSecret(prompt.signal);
    case "select": {
      while (true) {
        throwIfAborted(prompt.signal);
        console.log(prompt.message);
        prompt.options.forEach((option, index) => {
          console.log(
            `${index + 1}) ${option.label}${option.description === undefined ? "" : ` — ${option.description}`}`,
          );
        });
        const answer = (await readLine(prompt.signal)).trim();
        const optionIndex = Number(answer);
        const selected =
          Number.isInteger(optionIndex) && optionIndex >= 1 && optionIndex <= prompt.options.length
            ? prompt.options[optionIndex - 1]
            : prompt.options.find((option) => option.id === answer);
        if (selected !== undefined) {
          return selected.id;
        }
        console.log("invalid selection; enter an option number or id");
      }
    }
  }
};

const notify = (event: AuthEvent): void => {
  switch (event.type) {
    case "info":
      console.log(event.message);
      event.links?.forEach((link) => {
        console.log(link.label === undefined ? link.url : `${link.label}: ${link.url}`);
      });
      return;
    case "auth_url":
      console.log(event.url);
      if (event.instructions !== undefined) {
        console.log(event.instructions);
      }
      return;
    case "device_code":
      console.log(`Open ${event.verificationUri} and enter code ${event.userCode}`);
      return;
    case "progress":
      console.log(event.message);
      return;
  }
};

export const terminalAuthInteraction = (): AuthInteraction => ({
  prompt: promptForValue,
  notify,
});
