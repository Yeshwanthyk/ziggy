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
  it("evolves the idle body while capping state updates to about 30fps", () => {
    const { container } = render(<BotAvatar name="Ada" />);
    const body = container.querySelector("mask path");
    const initialPath = body?.getAttribute("d");

    act(() => runAnimationFrame(0));
    act(() => runAnimationFrame(10));
    expect(body?.getAttribute("d")).toBe(initialPath);

    act(() => runAnimationFrame(100));
    expect(body?.getAttribute("d")).not.toBe(initialPath);
  });

  it("uses the requested catalog variant independently of its accessible name", () => {
    const { container } = render(
      <BotAvatar identity="stable-agent-id" name="Renamed agent" variantId="triangle-rouge" />,
    );

    expect(container.querySelector('rect[fill="#e8483f"]')).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Renamed agent assistant",
    );
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
