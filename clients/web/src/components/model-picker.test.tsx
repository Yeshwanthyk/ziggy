import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./model-picker";

const models = [
  {
    providerId: "anthropic",
    modelId: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    thinkingLevels: ["low", "medium", "high"],
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    thinkingLevels: ["low", "medium", "high"],
  },
] as const;

afterEach(cleanup);

describe("ModelPicker", () => {
  it("filters grouped models and returns the chosen descriptor", () => {
    const onSelect = vi.fn();
    render(
      <ModelPicker disabled={false} models={models} onSelect={onSelect} selected={models[1]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /GPT-5.6 Sol/u }));

    expect(screen.getByRole("heading", { name: "Anthropic" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "OpenAI Codex" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /GPT-5.6 Sol/u }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), {
      target: { value: "sonnet" },
    });

    expect(screen.getByRole("button", { name: /Claude Sonnet 4/u })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /GPT-5.6 Sol/u })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 4/u }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(models[0]);
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).toBeNull();
  });
});
