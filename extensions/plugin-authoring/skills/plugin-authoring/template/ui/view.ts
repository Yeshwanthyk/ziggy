// The view runs in a sandboxed iframe with no network: it reaches only its own server's tools,
// through the host. Clicks here call app-only tools; the model never sees them.
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

interface Item {
  id: number;
  title: string;
  done: boolean;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const list = document.querySelector<HTMLUListElement>("#list")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const add = document.querySelector<HTMLButtonElement>("#add")!;
const title = document.querySelector<HTMLInputElement>("#title")!;

const app = new App({ name: "example-view", version: "0.1.0" });

const applyContext = (context: Partial<McpUiHostContext> | undefined) => {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
};

const say = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle("error", error);
};

const textOf = (result: ToolResult) =>
  (result.content ?? [])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");

const render = (result: ToolResult) => {
  if (result.isError) return say(textOf(result) || "Something went wrong.", true);
  const items = result.structuredContent?.items as Item[] | undefined;
  if (!items) return;
  say("");
  list.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.classList.toggle("done", item.done);

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.done;
      box.setAttribute("aria-label", `Done: ${item.title}`);
      box.addEventListener("change", () => call("set_done", { id: item.id, done: box.checked }));

      const label = document.createElement("span");
      label.className = "title";
      label.textContent = item.title;

      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.addEventListener("click", () => call("remove_item", { id: item.id }));

      row.append(box, label, remove);
      return row;
    }),
  );
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No items yet.";
    list.append(empty);
  }
};

// Set once a call of our own has rendered: anything the host sends after that is older.
let synced = false;

async function call(name: string, args: Record<string, unknown>) {
  try {
    const result = (await app.callServerTool({ name, arguments: args })) as ToolResult;
    synced = true;
    render(result);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), true);
  }
}

// G6: the result the view opened with may be old (history, another session, another face).
// Refetch when the view loads and whenever it regains focus or visibility.
let last = 0;
const refresh = () => {
  if (Date.now() - last < 2000) return;
  last = Date.now();
  void call("list_items", {});
};

// Buttons and keys, never a <form>: the view frame has no allow-forms, so submit never fires.
const submit = () => {
  const value = title.value.trim();
  if (!value) return;
  title.value = "";
  void call("add_item", { title: value });
};
add.addEventListener("click", submit);
title.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) submit();
});

// The result the view opened with; ignored when a refresh already rendered newer state.
app.ontoolresult = (result) => {
  if (!synced) render(result as ToolResult);
};
app.onhostcontextchanged = applyContext;

await app.connect();
applyContext(app.getHostContext());
refresh();
window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
