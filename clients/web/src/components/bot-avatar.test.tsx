import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotAvatar } from "./bot-avatar";

let reducedMotion = false;
let visibilityState: DocumentVisibilityState = "visible";
let nextFrameId = 0;
let frames = new Map<number, FrameRequestCallback>();

function runAnimationFrame(now: number) {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(now);
}

beforeEach(() => {
  reducedMotion = false;
  visibilityState = "visible";
  nextFrameId = 0;
  frames = new Map();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      matches: reducedMotion,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BotAvatar", () => {
  it("evolves a desynchronized idle body at normal speed", () => {
    const { container } = render(<BotAvatar name="Ada" />);
    const body = container.querySelector("mask path");
    const initialPath = body?.getAttribute("d");

    act(() => runAnimationFrame(0));
    act(() => runAnimationFrame(10));
    expect(body?.getAttribute("d")).toBe(initialPath);

    act(() => runAnimationFrame(80));
    expect(body?.getAttribute("d")).not.toBe(initialPath);

    cleanup();
    const pair = render(
      <>
        <BotAvatar name="Ada" variantId="cercle-bleu" />
        <BotAvatar name="Grace" variantId="cercle-bleu" />
      </>,
    );
    const bodies = pair.container.querySelectorAll("mask path");
    expect(bodies[0]?.getAttribute("d")).not.toBe(bodies[1]?.getAttribute("d"));
  });

  it("keeps the engine frame continuous when activity changes", () => {
    const { container, rerender } = render(
      <BotAvatar identity="ada" name="Ada" variantId="cercle-bleu" />,
    );
    act(() => runAnimationFrame(0));
    act(() => runAnimationFrame(80));
    const body = container.querySelector("mask path");
    const idlePath = body?.getAttribute("d");

    rerender(<BotAvatar active identity="ada" name="Ada" variantId="cercle-bleu" />);
    expect(body?.getAttribute("d")).toBe(idlePath);

    act(() => runAnimationFrame(200));
    act(() => runAnimationFrame(280));
    expect(body?.getAttribute("d")).not.toBe(idlePath);

    act(() => runAnimationFrame(2_280));
    expect(container.querySelector("svg circle")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("-126 -126 252 252");
  });

  it("uses the requested catalog variant independently of its accessible name", () => {
    const { container } = render(
      <BotAvatar identity="stable-agent-id" name="Renamed agent" variantId="triangle-rouge" />,
    );

    expect(container.querySelector('rect[fill="#e8483f"]')).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Renamed agent assistant",
    );
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("-126 -126 252 252");
  });

  it("freezes a distinct thinking pose when reduced motion is preferred", () => {
    reducedMotion = true;
    const { container } = render(
      <>
        <BotAvatar name="Idle" variantId="cercle-encre" />
        <BotAvatar active name="Thinking" variantId="cercle-encre" />
      </>,
    );
    const bodies = container.querySelectorAll("mask path");

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(bodies[1]?.getAttribute("d")).not.toBe(bodies[0]?.getAttribute("d"));
    expect(container.querySelectorAll("svg")[1]?.getAttribute("aria-label")).toBe(
      "Thinking assistant is thinking",
    );
  });

  it("stops scheduling while hidden and cleans up on unmount", () => {
    const { unmount } = render(<BotAvatar name="Ada" />);
    expect(frames.size).toBe(1);

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.size).toBe(1);

    unmount();
    expect(frames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
  });
});
