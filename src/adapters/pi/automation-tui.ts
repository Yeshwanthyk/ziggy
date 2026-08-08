import { Effect, Queue, type Scope } from "effect";

export interface AutomationTuiDefinition {
  readonly id: string;
  readonly path: string;
  readonly valid: boolean;
  readonly lifecycle: "active" | "paused" | "conflict";
  readonly schedule?: string;
  readonly timezone?: string;
  readonly gateState?: "scheduled" | "manual-only";
  readonly message?: string;
}

export interface AutomationTuiDocument {
  readonly id: string;
  readonly path: string;
  readonly lifecycle: "active" | "paused";
  readonly source: string;
}

export type AutomationTuiRequest =
  | { readonly kind: "overview" }
  | { readonly kind: "document"; readonly id: string }
  | {
      readonly kind: "save";
      readonly id: string;
      readonly expectedSource: string;
      readonly source: string;
    }
  | { readonly kind: "runs"; readonly id?: string }
  | { readonly kind: "pause"; readonly id: string }
  | { readonly kind: "resume"; readonly id: string };

export type AutomationTuiFailureCategory = "invalid" | "changed" | "not-found" | "unavailable";

export type AutomationTuiResponse =
  | {
      readonly kind: "overview";
      readonly definitions: ReadonlyArray<AutomationTuiDefinition>;
      readonly statusText: string;
    }
  | ({ readonly kind: "document" } & AutomationTuiDocument)
  | ({ readonly kind: "saved" } & AutomationTuiDocument)
  | {
      readonly kind: "runs";
      readonly automationId?: string;
      readonly text: string;
    }
  | {
      readonly kind: "transitioned";
      readonly id: string;
      readonly path: string;
      readonly lifecycle: "active" | "paused";
    }
  | {
      readonly kind: "failure";
      readonly category: AutomationTuiFailureCategory;
      readonly message: string;
    };

export type AutomationTuiHandler = (
  request: AutomationTuiRequest,
) => Effect.Effect<AutomationTuiResponse, never>;

export type AutomationTuiDispatch = (
  request: AutomationTuiRequest,
) => Promise<AutomationTuiResponse>;

interface AutomationTuiEnvelope {
  readonly request: AutomationTuiRequest;
  readonly resolve: (response: AutomationTuiResponse) => void;
}

const closingResponse = (): AutomationTuiResponse => ({
  kind: "failure",
  category: "unavailable",
  message: "the automation manager is closing",
});

export const makeAutomationTuiDispatch = (
  handler: AutomationTuiHandler,
): Effect.Effect<AutomationTuiDispatch, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AutomationTuiEnvelope>();
    const pending = new Set<AutomationTuiEnvelope["resolve"]>();
    let open = true;

    const complete = (
      resolve: AutomationTuiEnvelope["resolve"],
      response: AutomationTuiResponse,
    ) => {
      if (!pending.delete(resolve)) return;
      resolve(response);
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        open = false;
        for (const resolve of pending) resolve(closingResponse());
        pending.clear();
      }).pipe(Effect.andThen(Queue.shutdown(queue))),
    );

    yield* Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((envelope) =>
          handler(envelope.request).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Automation TUI request failed unexpectedly", { cause }).pipe(
                Effect.as(closingResponse()),
              ),
            ),
            Effect.tap((response) => Effect.sync(() => complete(envelope.resolve, response))),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);

    const dispatch: AutomationTuiDispatch = (request) => {
      if (!open) return Promise.resolve(closingResponse());
      return new Promise((resolve) => {
        pending.add(resolve);
        if (!Queue.offerUnsafe(queue, { request, resolve })) {
          complete(resolve, closingResponse());
        }
      });
    };
    return dispatch;
  });
