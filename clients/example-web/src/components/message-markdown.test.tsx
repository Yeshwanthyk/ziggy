import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageMarkdown } from "./message-markdown";

afterEach(cleanup);

describe("MessageMarkdown", () => {
  it("renders common Markdown and GFM structure", () => {
    const { container } = render(
      <MessageMarkdown>{`## Details

A **clear** answer with \`code\`.

- First
- Second

| Item | State |
| --- | --- |
| Build | Ready |

[Docs](https://example.com/docs)`}</MessageMarkdown>,
    );

    expect(screen.getByText("clear").tagName).toBe("STRONG");
    expect(screen.getByRole("heading", { name: "Details" }).tagName).toBe("H2");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByRole("list")).not.toBeNull();
    expect(screen.getByRole("table")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(container.querySelector("p")?.textContent).toContain("A clear answer with code.");
  });

  it("does not execute raw HTML, unsafe links, or remote images", () => {
    const { container } = render(
      <MessageMarkdown>{`<script>globalThis.compromised = true</script>

[Unsafe](javascript:alert(1))

[Encoded unsafe](jav&#x61;script:alert(1))

![Tracking pixel](https://tracker.example/pixel.gif)`}</MessageMarkdown>,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Encoded unsafe" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "View image: Tracking pixel" }).getAttribute("href"),
    ).toBe("https://tracker.example/pixel.gif");
  });
});
