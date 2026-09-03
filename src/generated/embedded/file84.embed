/* oxlint-disable ziggy-effect/no-error-constructor, ziggy-effect/no-try-catch-or-throw -- Package admission fails at this external module boundary. */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- The Pi entrypoint must dynamically load the pinned external ESM runtime. */
/* oxlint-disable ziggy/no-unknown-parameters -- The dynamic module is validated before its factory enters Pi. */
/* oxlint-disable ziggy/no-runtime-typeof -- A dynamic third-party module must expose one callable default export. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeSegment, type SegmentBridge } from "./segment.ts";

type ExtensionFactory = (pi: ExtensionAPI) => void;
type SegmentBridgeModule = {
  readonly executeAct: SegmentBridge["act"];
  readonly executeFind: SegmentBridge["find"];
  readonly executeObserve: SegmentBridge["observe"];
  readonly executeSearchUi: SegmentBridge["search"];
  readonly executeWaitFor: SegmentBridge["wait"];
};

const isExtensionModule = (value: unknown): value is { readonly default: ExtensionFactory } => {
  if (value !== Object(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "default");
  return typeof descriptor?.value === "function";
};

const isSegmentBridgeModule = (value: unknown): value is SegmentBridgeModule => {
  if (value !== Object(value)) return false;
  return ["executeAct", "executeFind", "executeObserve", "executeSearchUi", "executeWaitFor"].every(
    (name) => typeof Object.getOwnPropertyDescriptor(value, name)?.value === "function",
  );
};

const upstreamModule: unknown = await import(
  new URL("./dist/extensions/computer-use.mjs", import.meta.url).href
);

if (!isExtensionModule(upstreamModule)) {
  throw new Error("The pinned computer-use runtime has no default extension factory.");
}

const bridgeModule: unknown = await import(new URL("./dist/src/bridge.mjs", import.meta.url).href);
if (!isSegmentBridgeModule(bridgeModule)) {
  throw new Error("The pinned computer-use runtime has no compatible semantic bridge executors.");
}

const Target = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
const Condition = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    until: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
  },
  { additionalProperties: false },
);
const RootQuery = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    app: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    bundleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    kind: Type.Optional(
      Type.Union([
        Type.Literal("window"),
        Type.Literal("menu"),
        Type.Literal("sheet"),
        Type.Literal("popover"),
        Type.Literal("dialog"),
        Type.Literal("browser_page"),
      ]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);
const SegmentAction = Type.Union([
  Type.Object(
    {
      action: Type.Literal("click"),
      button: Type.Optional(
        Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]),
      ),
      clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("keypress"),
      keys: Type.Array(Type.String({ pattern: "^[A-Za-z0-9+_-]{1,32}$" }), {
        minItems: 1,
        maxItems: 20,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("scroll"),
      scrollX: Type.Optional(Type.Number({ minimum: -10_000, maximum: 10_000 })),
      scrollY: Type.Optional(Type.Number({ minimum: -10_000, maximum: 10_000 })),
    },
    { additionalProperties: false },
  ),
]);
const ActionStep = Type.Object(
  {
    target: Target,
    actions: Type.Array(SegmentAction, { minItems: 1, maxItems: 20 }),
    expect: Condition,
  },
  { additionalProperties: false },
);
const AssertionStep = Type.Object({ assert: Condition }, { additionalProperties: false });

export default ((pi: ExtensionAPI): void => {
  upstreamModule.default(pi);
  pi.registerTool({
    name: "run_ui_segment",
    label: "Run Semantic UI Segment",
    description:
      "Execute a bounded group of semantic desktop/CDP actions with fresh unique target resolution and mandatory verified postconditions. This tool accepts no text-entry, secret-value, coordinate, or JavaScript fields.",
    parameters: Type.Object(
      {
        root: Type.Optional(Type.String({ pattern: "^@r[0-9]+$" })),
        rootQuery: Type.Optional(RootQuery),
        steps: Type.Array(Type.Union([ActionStep, AssertionStep]), {
          minItems: 1,
          maxItems: 20,
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(toolCallId, parameters, signal, _onUpdate, ctx) {
      return await executeSegment(toolCallId, parameters, signal, ctx, {
        observe: bridgeModule.executeObserve,
        find: bridgeModule.executeFind,
        search: bridgeModule.executeSearchUi,
        act: bridgeModule.executeAct,
        wait: bridgeModule.executeWaitFor,
      });
    },
  });
}) satisfies ExtensionFactory;
