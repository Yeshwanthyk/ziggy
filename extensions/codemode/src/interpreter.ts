/*
 * Confined tree-walking JavaScript subset, adapted in design from OpenCode's
 * MIT-licensed @opencode-ai/codemode interpreter at commit 3a31c4e.
 * See ../NOTICE.md. This module never evaluates source with eval, Function, vm, or import.
 */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-instanceof-tagged-error, ziggy-effect/no-json-parse, ziggy-effect/no-inline-schema-compile -- Acorn and confined JSON helpers are translated to typed interpreter failures. */
/* oxlint-disable ziggy/no-unknown-parameters, ziggy/no-runtime-typeof, ziggy/no-reflect-get, ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion, ziggy/no-unsafe-dictionary-type, ziggy/no-conditional-empty-object-spread -- Acorn AST nodes are dynamic by contract and are validated by node helpers before interpretation. */
import { parse } from "acorn";
import { Effect, Schema } from "effect";

export class InterpreterError extends Schema.TaggedErrorClass<InterpreterError>()(
  "InterpreterError",
  { kind: Schema.String, message: Schema.String, sourceLine: Schema.optionalKey(Schema.Number) },
) {}

type Node = {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } };
} & Record<string, unknown>;
type Control =
  | { readonly kind: "normal" }
  | { readonly kind: "return"; readonly value: unknown }
  | { readonly kind: "break" }
  | { readonly kind: "continue" };
type Binding = { value: unknown; readonly mutable: boolean };

class ToolReference {
  constructor(readonly path: ReadonlyArray<string>) {}
}

class NativeReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

class InterpretedFunction {
  constructor(
    readonly parameters: ReadonlyArray<string>,
    readonly body: Node,
    readonly scopes: ReadonlyArray<Map<string, Binding>>,
  ) {}
}

export interface InterpreterServices {
  readonly invoke: (
    path: ReadonlyArray<string>,
    input: Schema.Json,
  ) => Effect.Effect<Schema.Json, unknown>;
  readonly log: (level: "log" | "warn" | "error", values: ReadonlyArray<unknown>) => void;
  readonly maxSteps: number;
}

const normal: Control = { kind: "normal" };
const blockedKeys = new Set(["__proto__", "prototype", "constructor"]);

const node = (value: unknown, context: string): Node => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new InterpreterError({ kind: "InvalidAst", message: `Invalid AST node for ${context}.` });
  }
  const type = Reflect.get(value, "type");
  if (typeof type !== "string") {
    throw new InterpreterError({ kind: "InvalidAst", message: `Invalid AST node for ${context}.` });
  }
  return value as Node;
};

const nodes = (value: unknown, context: string): ReadonlyArray<Node> => {
  if (!Array.isArray(value)) {
    throw new InterpreterError({ kind: "InvalidAst", message: `Expected ${context} array.` });
  }
  return value.map((item) => node(item, context));
};

const keyName = (value: unknown, context: string): string => {
  if (typeof value !== "string") {
    throw new InterpreterError({ kind: "UnsupportedSyntax", message: `Expected ${context} name.` });
  }
  if (blockedKeys.has(value)) {
    throw new InterpreterError({ kind: "BlockedMember", message: `Member '${value}' is blocked.` });
  }
  return value;
};

const asJson = (value: unknown): Schema.Json => {
  const decoded = Schema.decodeUnknownOption(Schema.Json)(value);
  if (decoded._tag === "None") {
    throw new InterpreterError({
      kind: "InvalidDataValue",
      message: "Value is not plain JSON data.",
    });
  }
  return decoded.value;
};

const publicValue = (value: unknown): string => {
  if (
    value instanceof ToolReference ||
    value instanceof NativeReference ||
    value instanceof InterpretedFunction
  ) {
    return "[confined reference]";
  }
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

export const parseProgram = (code: string): Node => {
  try {
    const parsed: unknown = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
    return node(parsed, "program");
  } catch (cause) {
    if (cause instanceof InterpreterError) throw cause;
    const sourceLine =
      typeof cause === "object" && cause !== null && typeof Reflect.get(cause, "loc") === "object"
        ? Reflect.get(Reflect.get(cause, "loc") as object, "line")
        : undefined;
    throw new InterpreterError({
      kind: "ParseError",
      message: "Code could not be parsed as the confined JavaScript subset.",
      ...(typeof sourceLine === "number" ? { sourceLine } : {}),
    });
  }
};

export const interpret = (
  program: Node,
  services: InterpreterServices,
): Effect.Effect<unknown, InterpreterError | unknown> => {
  let steps = 0;
  let scopes: ReadonlyArray<Map<string, Binding>> = [new Map()];

  const fail = (kind: string, message: string, current?: Node) =>
    Effect.fail(
      new InterpreterError({
        kind,
        message,
        ...(current?.loc === undefined ? {} : { sourceLine: current.loc.start.line }),
      }),
    );

  const step = (current: Node): Effect.Effect<void, InterpreterError> => {
    steps += 1;
    if (steps > services.maxSteps)
      return fail("StepLimitExceeded", "Interpreter step limit exceeded.", current);
    return steps % 128 === 0 ? Effect.yieldNow : Effect.void;
  };

  const lookup = (name: string): Binding | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const binding = scopes[index]?.get(name);
      if (binding !== undefined) return binding;
    }
    return undefined;
  };

  const property = (current: Node): Effect.Effect<string | number, InterpreterError | unknown> => {
    if (current.computed === true) {
      return evaluate(node(current.property, "computed property")).pipe(
        Effect.flatMap((value) =>
          typeof value === "string" || typeof value === "number"
            ? Effect.succeed(value)
            : fail("InvalidMember", "Computed member must be a string or number.", current),
        ),
      );
    }
    const propertyNode = node(current.property, "property");
    return Effect.succeed(keyName(propertyNode.name, "property"));
  };

  const member = (current: Node): Effect.Effect<unknown, InterpreterError | unknown> =>
    Effect.gen(function* () {
      const target = yield* evaluate(node(current.object, "member object"));
      const key = yield* property(current);
      const safeKey = keyName(String(key), "member");
      if (target instanceof ToolReference) return new ToolReference([...target.path, safeKey]);
      if (target === JSON || target === Object || target === console) {
        return new NativeReference(target, safeKey);
      }
      if (Array.isArray(target)) {
        if (typeof key === "number" || /^\d+$/.test(safeKey)) return target[Number(key)];
        if (safeKey === "length") return target.length;
        return new NativeReference(target, safeKey);
      }
      if (typeof target === "string") {
        if (safeKey === "length") return target.length;
        return new NativeReference(target, safeKey);
      }
      if (typeof target === "object" && target !== null) return Reflect.get(target, safeKey);
      return yield* fail("InvalidMember", `Cannot read '${safeKey}' from this value.`, current);
    });

  const invokeFunction = (
    fn: InterpretedFunction,
    args: ReadonlyArray<unknown>,
  ): Effect.Effect<unknown, InterpreterError | unknown> =>
    Effect.gen(function* () {
      const prior = scopes;
      const local = new Map<string, Binding>();
      fn.parameters.forEach((name, index) =>
        local.set(name, { value: args[index], mutable: true }),
      );
      scopes = [...fn.scopes, local];
      const result = yield* executeStatement(fn.body);
      scopes = prior;
      return result.kind === "return" ? result.value : undefined;
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          scopes = fn.scopes;
        }),
      ),
    );

  const invokeNative = (
    reference: NativeReference,
    args: ReadonlyArray<unknown>,
    current: Node,
  ): Effect.Effect<unknown, InterpreterError | unknown> => {
    const { receiver, name } = reference;
    if (receiver === console && (name === "log" || name === "warn" || name === "error")) {
      services.log(name, args);
      return Effect.succeed(undefined);
    }
    if (receiver === JSON && name === "stringify") {
      return Effect.try({
        try: () => JSON.stringify(asJson(args[0])),
        catch: () =>
          new InterpreterError({
            kind: "InvalidDataValue",
            message: "JSON.stringify input is not plain data.",
          }),
      });
    }
    if (receiver === JSON && name === "parse" && typeof args[0] === "string") {
      return Effect.try({
        try: () => asJson(JSON.parse(args[0] as string)),
        catch: () =>
          new InterpreterError({
            kind: "InvalidDataValue",
            message: "JSON.parse input is invalid.",
          }),
      });
    }
    if (receiver === Object && (name === "keys" || name === "values" || name === "entries")) {
      const value = asJson(args[0]);
      if (value === null || typeof value !== "object")
        return fail("InvalidArgument", `Object.${name} expects data.`, current);
      if (name === "keys") return Effect.succeed(Object.keys(value));
      if (name === "values") return Effect.succeed(Object.values(value));
      return Effect.succeed(Object.entries(value));
    }
    if (Array.isArray(receiver)) {
      if (name === "push") return Effect.succeed(receiver.push(...args.map(asJson)));
      if (name === "pop") return Effect.succeed(receiver.pop());
      if (name === "slice")
        return Effect.succeed(
          receiver.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1])),
        );
      if (name === "join") return Effect.succeed(receiver.join(String(args[0] ?? ",")));
      if (name === "includes") return Effect.succeed(receiver.includes(args[0]));
    }
    if (typeof receiver === "string") {
      if (name === "includes") return Effect.succeed(receiver.includes(String(args[0])));
      if (name === "startsWith") return Effect.succeed(receiver.startsWith(String(args[0])));
      if (name === "endsWith") return Effect.succeed(receiver.endsWith(String(args[0])));
      if (name === "toLowerCase") return Effect.succeed(receiver.toLowerCase());
      if (name === "toUpperCase") return Effect.succeed(receiver.toUpperCase());
      if (name === "trim") return Effect.succeed(receiver.trim());
      if (name === "split") return Effect.succeed(receiver.split(String(args[0] ?? "")));
    }
    return fail(
      "UnsupportedCall",
      `Method '${name}' is not available in confined Code Mode.`,
      current,
    );
  };

  const call = (current: Node): Effect.Effect<unknown, InterpreterError | unknown> =>
    Effect.gen(function* () {
      const callee = yield* evaluate(node(current.callee, "callee"));
      const args: unknown[] = [];
      for (const argument of nodes(current.arguments, "arguments"))
        args.push(yield* evaluate(argument));
      if (callee instanceof ToolReference) {
        if (callee.path.length !== 2) {
          return yield* fail(
            "UnknownTool",
            "Tool calls must use tools.<server>.<tool>(input).",
            current,
          );
        }
        return yield* services.invoke(callee.path, asJson(args[0] ?? {})).pipe(
          Effect.mapError((error) =>
            error instanceof InterpreterError
              ? error
              : new InterpreterError({
                  kind: "ToolFailure",
                  message: "An MCP tool call failed.",
                }),
          ),
        );
      }
      if (callee instanceof NativeReference) return yield* invokeNative(callee, args, current);
      if (callee instanceof InterpretedFunction) return yield* invokeFunction(callee, args);
      return yield* fail(
        "UnsupportedCall",
        "Only confined helpers and MCP tools are callable.",
        current,
      );
    });

  const binary = (operator: unknown, left: unknown, right: unknown, current: Node) => {
    switch (operator) {
      case "===":
        return Effect.succeed(left === right);
      case "!==":
        return Effect.succeed(left !== right);
      case "==":
        return Effect.succeed(left === right);
      case "!=":
        return Effect.succeed(left !== right);
      case "+":
        return Effect.succeed(
          typeof left === "string" || typeof right === "string"
            ? String(left) + String(right)
            : Number(left) + Number(right),
        );
      case "-":
        return Effect.succeed(Number(left) - Number(right));
      case "*":
        return Effect.succeed(Number(left) * Number(right));
      case "/":
        return Effect.succeed(Number(left) / Number(right));
      case "%":
        return Effect.succeed(Number(left) % Number(right));
      case "<":
        return Effect.succeed(Number(left) < Number(right));
      case "<=":
        return Effect.succeed(Number(left) <= Number(right));
      case ">":
        return Effect.succeed(Number(left) > Number(right));
      case ">=":
        return Effect.succeed(Number(left) >= Number(right));
      default:
        return fail(
          "UnsupportedSyntax",
          `Binary operator '${String(operator)}' is not supported.`,
          current,
        );
    }
  };

  const evaluate = (current: Node): Effect.Effect<unknown, InterpreterError | unknown> =>
    Effect.gen(function* () {
      yield* step(current);
      switch (current.type) {
        case "Literal":
          return current.value;
        case "Identifier": {
          const name = keyName(current.name, "identifier");
          if (name === "tools") return new ToolReference([]);
          if (name === "JSON") return JSON;
          if (name === "Object") return Object;
          if (name === "console") return console;
          if (name === "undefined") return undefined;
          const binding = lookup(name);
          return binding === undefined
            ? yield* fail("UnknownIdentifier", `Identifier '${name}' is not available.`, current)
            : binding.value;
        }
        case "ArrayExpression": {
          const values: unknown[] = [];
          for (const item of nodes(current.elements, "array elements"))
            values.push(yield* evaluate(item));
          return values;
        }
        case "ObjectExpression": {
          const result: Record<string, unknown> = Object.create(null);
          for (const propertyNode of nodes(current.properties, "object properties")) {
            if (propertyNode.type !== "Property" || propertyNode.kind !== "init") {
              return yield* fail(
                "UnsupportedSyntax",
                "Only plain object properties are supported.",
                propertyNode,
              );
            }
            const propertyKey = node(propertyNode.key, "object key");
            const key =
              propertyNode.computed === true
                ? String(yield* evaluate(propertyKey))
                : propertyKey.type === "Identifier"
                  ? keyName(propertyKey.name, "object key")
                  : keyName(propertyKey.value, "object key");
            result[key] = yield* evaluate(node(propertyNode.value, "object value"));
          }
          return result;
        }
        case "MemberExpression":
          return yield* member(current);
        case "CallExpression":
          return yield* call(current);
        case "AwaitExpression":
          return yield* evaluate(node(current.argument, "await argument"));
        case "BinaryExpression":
          return yield* binary(
            current.operator,
            yield* evaluate(node(current.left, "left")),
            yield* evaluate(node(current.right, "right")),
            current,
          );
        case "LogicalExpression": {
          const left = yield* evaluate(node(current.left, "logical left"));
          if (current.operator === "&&")
            return left ? yield* evaluate(node(current.right, "logical right")) : left;
          if (current.operator === "||")
            return left ? left : yield* evaluate(node(current.right, "logical right"));
          if (current.operator === "??")
            return left === null || left === undefined
              ? yield* evaluate(node(current.right, "logical right"))
              : left;
          return yield* fail("UnsupportedSyntax", "Unsupported logical operator.", current);
        }
        case "UnaryExpression": {
          const value = yield* evaluate(node(current.argument, "unary argument"));
          if (current.operator === "!") return !value;
          if (current.operator === "-") return -Number(value);
          if (current.operator === "+") return Number(value);
          if (current.operator === "typeof") return typeof value;
          return yield* fail("UnsupportedSyntax", "Unsupported unary operator.", current);
        }
        case "ConditionalExpression":
          return yield* evaluate(
            node(
              (yield* evaluate(node(current.test, "condition")))
                ? current.consequent
                : current.alternate,
              "conditional branch",
            ),
          );
        case "TemplateLiteral": {
          const quasis = nodes(current.quasis, "template quasis");
          const expressions = nodes(current.expressions, "template expressions");
          let text = "";
          for (let index = 0; index < quasis.length; index += 1) {
            const cooked = Reflect.get(Reflect.get(quasis[index] ?? {}, "value") ?? {}, "cooked");
            text += typeof cooked === "string" ? cooked : "";
            const expression = expressions[index];
            if (expression !== undefined) text += String(yield* evaluate(expression));
          }
          return text;
        }
        case "ArrowFunctionExpression": {
          const parameters = nodes(current.params, "function parameters").map((parameter) => {
            if (parameter.type !== "Identifier")
              throw new InterpreterError({
                kind: "UnsupportedSyntax",
                message: "Only identifier function parameters are supported.",
              });
            return keyName(parameter.name, "parameter");
          });
          return new InterpretedFunction(parameters, node(current.body, "function body"), [
            ...scopes,
          ]);
        }
        case "AssignmentExpression": {
          if (current.operator !== "=")
            return yield* fail("UnsupportedSyntax", "Only '=' assignment is supported.", current);
          const left = node(current.left, "assignment target");
          const value = yield* evaluate(node(current.right, "assignment value"));
          if (left.type === "Identifier") {
            const binding = lookup(keyName(left.name, "assignment"));
            if (binding === undefined || !binding.mutable)
              return yield* fail("InvalidAssignment", "Assignment target is not mutable.", current);
            binding.value = value;
            return value;
          }
          return yield* fail(
            "UnsupportedSyntax",
            "Only identifier assignment is supported.",
            current,
          );
        }
        default:
          return yield* fail(
            "UnsupportedSyntax",
            `Expression '${current.type}' is not supported.`,
            current,
          );
      }
    });

  const executeBlock = (
    body: ReadonlyArray<Node>,
  ): Effect.Effect<Control, InterpreterError | unknown> =>
    Effect.gen(function* () {
      for (const statement of body) {
        const result = yield* executeStatement(statement);
        if (result.kind !== "normal") return result;
      }
      return normal;
    });

  const declare = (
    declaration: Node,
    mutable: boolean,
  ): Effect.Effect<void, InterpreterError | unknown> =>
    Effect.gen(function* () {
      const identifier = node(declaration.id, "declaration identifier");
      if (identifier.type !== "Identifier")
        return yield* fail(
          "UnsupportedSyntax",
          "Only identifier declarations are supported.",
          declaration,
        );
      const name = keyName(identifier.name, "declaration");
      const value =
        declaration.init === null || declaration.init === undefined
          ? undefined
          : yield* evaluate(node(declaration.init, "initializer"));
      scopes.at(-1)?.set(name, { value, mutable });
    });

  const executeStatement = (current: Node): Effect.Effect<Control, InterpreterError | unknown> =>
    Effect.gen(function* () {
      yield* step(current);
      switch (current.type) {
        case "Program":
          return yield* executeBlock(nodes(current.body, "program body"));
        case "BlockStatement": {
          scopes = [...scopes, new Map()];
          const result = yield* executeBlock(nodes(current.body, "block body"));
          scopes = scopes.slice(0, -1);
          return result;
        }
        case "ExpressionStatement":
          yield* evaluate(node(current.expression, "expression"));
          return normal;
        case "VariableDeclaration": {
          const mutable = current.kind !== "const";
          for (const declaration of nodes(current.declarations, "declarations"))
            yield* declare(declaration, mutable);
          return normal;
        }
        case "ReturnStatement":
          return {
            kind: "return",
            value:
              current.argument === null || current.argument === undefined
                ? null
                : yield* evaluate(node(current.argument, "return value")),
          };
        case "IfStatement": {
          const branch = (yield* evaluate(node(current.test, "if condition")))
            ? current.consequent
            : current.alternate;
          return branch === null || branch === undefined
            ? normal
            : yield* executeStatement(node(branch, "if branch"));
        }
        case "ForOfStatement": {
          const items = yield* evaluate(node(current.right, "for-of value"));
          if (!Array.isArray(items))
            return yield* fail("InvalidLoop", "for...of expects an array.", current);
          const left = node(current.left, "for-of binding");
          for (const item of items) {
            scopes = [...scopes, new Map()];
            if (left.type === "VariableDeclaration") {
              const declaration = nodes(left.declarations, "for-of declarations")[0];
              if (declaration === undefined)
                return yield* fail("InvalidLoop", "Missing for...of binding.", current);
              const identifier = node(declaration.id, "for-of identifier");
              if (identifier.type !== "Identifier")
                return yield* fail(
                  "UnsupportedSyntax",
                  "Only identifier loop bindings are supported.",
                  current,
                );
              scopes.at(-1)?.set(keyName(identifier.name, "loop binding"), {
                value: item,
                mutable: left.kind !== "const",
              });
            } else
              return yield* fail(
                "UnsupportedSyntax",
                "Only declared for...of bindings are supported.",
                current,
              );
            const result = yield* executeStatement(node(current.body, "for-of body"));
            scopes = scopes.slice(0, -1);
            if (result.kind === "return") return result;
            if (result.kind === "break") break;
          }
          return normal;
        }
        case "WhileStatement": {
          while (yield* evaluate(node(current.test, "while condition"))) {
            const result = yield* executeStatement(node(current.body, "while body"));
            if (result.kind === "return") return result;
            if (result.kind === "break") break;
          }
          return normal;
        }
        case "BreakStatement":
          return { kind: "break" };
        case "ContinueStatement":
          return { kind: "continue" };
        case "EmptyStatement":
          return normal;
        default:
          return yield* fail(
            "UnsupportedSyntax",
            `Statement '${current.type}' is not supported.`,
            current,
          );
      }
    });

  return executeStatement(program).pipe(
    Effect.map((result) => (result.kind === "return" ? result.value : null)),
  );
};

export const formatLogValues = (values: ReadonlyArray<unknown>): string =>
  values.map(publicValue).join(" ");
