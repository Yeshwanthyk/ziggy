import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  UiEventFrame,
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
