// The part of `@ziggy/device` a commands module sees: `ziggy-device run --commands commands.ts`
// calls the module's default export with the device before it connects. Types only, so the
// module needs no install. You should not need to edit it.

export type Json = string | number | boolean | null | ReadonlyArray<Json> | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

export interface ToolResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  readonly isError?: boolean;
}

export interface CommandSpec {
  readonly description?: string;
  /** JSON Schema for the arguments. Default: an object with any properties. */
  readonly inputSchema?: JsonObject;
}

/** Returns text or a full MCP result; a thrown error reaches the model as a failed call. */
export type CommandHandler = (
  args: JsonObject,
) => string | ToolResult | Promise<string | ToolResult>;

export interface Device {
  command(name: string, spec: CommandSpec, run: CommandHandler): Device;
}
