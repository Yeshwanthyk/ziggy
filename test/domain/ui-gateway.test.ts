import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  UiEventFrame,
  UiExtensionAddParams,
  UiExtensionFailure,
  UiExtensionListForProfileResult,
  UiExtensionMutationResult,
  UiExtensionValidateParams,
  UiExtensionValidationResult,
  UiRequestEnvelope,
  UiSessionKey,
  UiSessionName,
  UiSessionOpenParams,
  UiSessionTextParams,
} from "ziggy/domain/ui-gateway";

const decodeRequest = Schema.decodeUnknownSync(UiRequestEnvelope);
const decodeOpen = Schema.decodeUnknownSync(UiSessionOpenParams);
const decodeText = Schema.decodeUnknownSync(UiSessionTextParams);
const decodeName = Schema.decodeUnknownSync(UiSessionName);
const decodeKey = Schema.decodeUnknownSync(UiSessionKey);
const decodeEvent = Schema.decodeUnknownSync(UiEventFrame);
const decodeExtensionAdd = Schema.decodeUnknownSync(UiExtensionAddParams);
const decodeExtensionFailure = Schema.decodeUnknownSync(UiExtensionFailure);
const decodeExtensionList = Schema.decodeUnknownSync(UiExtensionListForProfileResult);
const decodeExtensionValidate = Schema.decodeUnknownSync(UiExtensionValidateParams);
const decodeExtensionValidation = Schema.decodeUnknownSync(UiExtensionValidationResult);
const decodeExtensionMutation = Schema.decodeUnknownSync(UiExtensionMutationResult);

test("UI protocol decodes the bounded request envelope and exact method params", () => {
  expect(
    decodeRequest({
      id: "r1",
      method: "session.open",
      params: { name: "main" },
    }),
  ).toEqual({ id: "r1", method: "session.open", params: { name: "main" } });
  expect(decodeOpen({ name: "main-1" })).toEqual({ name: "main-1" });
  expect(decodeText({ session: "ui/main", text: "hello" })).toEqual({
    session: "ui/main",
    text: "hello",
  });
  expect(() => decodeText({ session: "ui/main", text: "", extra: true })).toThrow();
});

test("UI names and live keys reject traversal, separators, uppercase aliases, and overlong values", () => {
  expect(decodeName("chat_1.test")).toBe("chat_1.test");
  for (const value of ["", ".", "..", "Main", "../x", "x/y", "%2e%2e", " white"]) {
    expect(() => decodeName(value)).toThrow();
  }
  expect(decodeKey("discord/group-dc1-thread-2")).toBe("discord/group-dc1-thread-2");
  expect(() => decodeKey("automation/job")).toThrow();
  expect(() => decodeKey(`ui/${"x".repeat(241)}`)).toThrow();
});

test("UI extension methods have bounded params and domain-shaped results", () => {
  expect(decodeExtensionAdd({ id: "weather" })).toEqual({ id: "weather" });
  expect(() => decodeExtensionAdd({ id: "A" })).toThrow();
  expect(() => decodeExtensionAdd({ id: "a".repeat(129) })).toThrow();
  expect(decodeExtensionValidate({})).toEqual({});
  expect(() => decodeExtensionValidate({ extra: true })).toThrow();

  expect(
    decodeExtensionList({
      available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
      selected: ["weather"],
    }),
  ).toEqual({
    available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
    selected: ["weather"],
  });
  expect(
    decodeExtensionMutation({
      id: "weather",
      profilePath: "/profile",
      changed: true,
      selected: true,
    }),
  ).toEqual({ id: "weather", profilePath: "/profile", changed: true, selected: true });
  expect(
    decodeExtensionValidation({
      selected: ["weather"],
      preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
    }),
  ).toEqual({
    selected: ["weather"],
    preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
  });
  expect(() =>
    decodeExtensionList({
      available: [
        {
          id: "weather",
          description: "x".repeat(2_049),
          kind: "skill",
          source: "bundled",
        },
      ],
      selected: [],
    }),
  ).toThrow();
});

test("UI extension failures keep the typed operation contract and optional metadata", () => {
  expect(
    decodeExtensionFailure({
      operation: "add",
      stage: "extensions",
      code: "preflight_failed",
      message: "package import is unavailable",
      id: "weather",
      source: "profile",
      selectionChanged: false,
    }),
  ).toEqual({
    operation: "add",
    stage: "extensions",
    code: "preflight_failed",
    message: "package import is unavailable",
    id: "weather",
    source: "profile",
    selectionChanged: false,
  });
  expect(
    decodeExtensionFailure({
      operation: "validate",
      stage: "services",
      code: "preflight_failed",
      message: "service validation failed",
      selectionChanged: false,
    }),
  ).toEqual({
    operation: "validate",
    stage: "services",
    code: "preflight_failed",
    message: "service validation failed",
    selectionChanged: false,
  });
  expect(() =>
    decodeExtensionFailure({
      operation: "add",
      stage: "extensions",
      code: "preflight_failed",
      message: "x".repeat(361),
      selectionChanged: false,
    }),
  ).toThrow();
  expect(() =>
    decodeExtensionFailure({
      operation: "add",
      stage: "extensions",
      code: "preflight_failed",
      message: "failed",
      id: "a".repeat(129),
      selectionChanged: false,
    }),
  ).toThrow();
});

test("UI event schemas mirror the application ChatEvent payloads", () => {
  expect(
    decodeEvent({
      event: "assistant-text",
      session: "ui/main",
      payload: { delta: "hi", snapshot: "hi" },
    }),
  ).toEqual({
    event: "assistant-text",
    session: "ui/main",
    payload: { delta: "hi", snapshot: "hi" },
  });
  expect(() =>
    decodeEvent({
      event: "assistant-text",
      session: "ui/main",
      payload: { text: "wrong schema" },
    }),
  ).toThrow();
});
