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

const profileId = `prf_${"a".repeat(24)}`;
const liveRef = { profileId, kind: "live" as const, key: "ui/main" };
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

test("UI protocol decodes explicit Profile-scoped request params", () => {
  expect(
    decodeRequest({
      id: "r1",
      method: "session.open",
      params: { profileId, context: { kind: "local" }, name: "main" },
    }),
  ).toEqual({
    id: "r1",
    method: "session.open",
    params: { profileId, context: { kind: "local" }, name: "main" },
  });
  expect(decodeOpen({ profileId, context: { kind: "local" }, name: "main-1" })).toEqual({
    profileId,
    context: { kind: "local" },
    name: "main-1",
  });
  expect(decodeText({ ref: liveRef, text: "hello" })).toEqual({
    ref: liveRef,
    text: "hello",
  });
  expect(() => decodeText({ ref: liveRef, text: "", extra: true })).toThrow();
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

test("UI extension methods require Profile identity and never expose a path", () => {
  expect(decodeExtensionAdd({ profileId, id: "weather" })).toEqual({ profileId, id: "weather" });
  expect(() => decodeExtensionAdd({ profileId, id: "A" })).toThrow();
  expect(() => decodeExtensionAdd({ profileId, id: "a".repeat(129) })).toThrow();
  expect(decodeExtensionValidate({ profileId })).toEqual({ profileId });
  expect(() => decodeExtensionValidate({})).toThrow();

  expect(
    decodeExtensionList({
      profileId,
      available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
      selected: ["weather"],
    }),
  ).toEqual({
    profileId,
    available: [{ id: "weather", description: "Weather", kind: "skill", source: "bundled" }],
    selected: ["weather"],
  });
  expect(
    decodeExtensionMutation({ profileId, id: "weather", changed: true, selected: true }),
  ).toEqual({ profileId, id: "weather", changed: true, selected: true });
  expect(
    decodeExtensionMutation({
      profileId,
      id: "weather",
      profilePath: "/profile",
      changed: true,
      selected: true,
    }),
  ).toEqual({ profileId, id: "weather", changed: true, selected: true });
  expect(
    decodeExtensionValidation({
      profileId,
      selected: ["weather"],
      preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
    }),
  ).toEqual({
    profileId,
    selected: ["weather"],
    preflight: { extensionPathCount: 1, skillPathCount: 2, extensionFactoryCount: 0 },
  });
  expect(() =>
    decodeExtensionList({
      profileId,
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

test("UI event schemas require Profile, epoch, sequence, and stable event identity", () => {
  expect(
    decodeEvent({
      profileId,
      session: liveRef,
      epoch: "epoch-1234",
      seq: 1,
      eventId: "event-1",
      event: "assistant-text",
      payload: { delta: "hi", snapshot: "hi" },
    }),
  ).toEqual({
    profileId,
    session: liveRef,
    epoch: "epoch-1234",
    seq: 1,
    eventId: "event-1",
    event: "assistant-text",
    payload: { delta: "hi", snapshot: "hi" },
  });
  expect(() =>
    decodeEvent({
      profileId,
      session: liveRef,
      epoch: "epoch-1234",
      seq: 1,
      eventId: "event-1",
      event: "assistant-text",
      payload: { text: "wrong schema" },
    }),
  ).toThrow();
});
