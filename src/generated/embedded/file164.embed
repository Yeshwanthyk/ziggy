// The view runs in a sandboxed iframe with no network: it reaches only its own server's tools,
// through the host. Clicks here call app-only tools; the model never sees them. Build it from the
// kit (./kit.ts): controls, fixed states, in-place rows, queued writes and refresh on return.
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import {
  button,
  confirmButton,
  el,
  field,
  keyedList,
  notice,
  query,
  refreshOnReturn,
  row,
  skeleton,
  stack,
  status,
  toolbar,
  writeQueue,
  type QueryState,
} from "./kit";

interface Item {
  id: number;
  title: string;
  done: boolean;
}

/** `off` is set by a server whose feature is turned off at the source (say, a disabled inbox). */
interface Items {
  items: Item[];
  off?: string;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const app = new App({ name: "example-view", version: "0.1.0" });

const applyContext = (context: Partial<McpUiHostContext> | undefined) => {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
};

const textOf = (result: ToolResult) =>
  (result.content ?? [])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");

const itemsOf = (result: ToolResult): Items => {
  const items = result.structuredContent?.items;
  if (!Array.isArray(items)) throw new Error(textOf(result) || "The server sent no items.");

  return { items: items as Item[], off: result.structuredContent?.off as string | undefined };
};

/** Calls one of this plugin's tools; an error result throws with its text. */
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await app.callServerTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(textOf(result) || `${name} failed.`);

  return result;
};

const statusLine = el("p");
const say = status(statusLine);
const body = el("div");
const list = el("ul", { "aria-label": "Items" });

const items = query(
  async () => itemsOf(await call("list_items")),
  (state) => show(state),
);
const queue = writeQueue(
  () => items.refresh(),
  (message) => say(message, true),
);
const write = (name: string, args: Record<string, unknown>) =>
  void queue(async () => {
    await call(name, args);
  });

const updateRows = keyedList(
  list,
  (item: Item) => item.id,
  (first) => {
    let item = first;
    const box = el("input", { type: "checkbox", class: "kit-check" });
    box.addEventListener("change", () => write("set_done", { id: item.id, done: box.checked }));
    const title = el("span", { class: "kit-title" });
    const remove = confirmButton(`remove:${item.id}`, "Remove", () =>
      write("remove_item", { id: item.id }),
    );
    const node = el("li", {}, box, title, remove);

    return {
      node,
      update: (next) => {
        item = next;
        node.classList.toggle("done", next.done);
        box.checked = next.done;
        box.setAttribute("aria-label", `Done: ${next.title}`);
        title.textContent = next.title;
      },
    };
  },
);

function show(state: QueryState<Items>) {
  if (state.kind === "pending") return body.replaceChildren(state.slow ? skeleton() : "");
  if (state.kind === "error")
    return body.replaceChildren(notice("error", state.error, () => void items.refresh()));

  // A failed refresh keeps the rows and says so here.
  say(state.error ? `Couldn't refresh: ${state.error}` : "", Boolean(state.error));
  const { items: rows, off } = state.data;
  if (off) return body.replaceChildren(notice("off", off));
  if (rows.length === 0)
    return body.replaceChildren(notice("empty", "No items yet. Add one above."));
  updateRows(rows);
  if (list.parentNode !== body) body.replaceChildren(list);
}

const add = field("New item", { placeholder: "What needs doing?", maxLength: 200 }, () => submit());
const submit = () => {
  const value = add.input.value.trim();
  if (!value) return;
  add.input.value = "";
  write("add_item", { title: value });
};
add.node.classList.add("kit-grow");

document
  .querySelector("#root")!
  .append(
    stack(
      row(
        add.node,
        toolbar(
          [button("Add", submit, "primary")],
          [{ label: "Refresh", run: () => void items.refresh() }],
        ),
      ),
      body,
      statusLine,
    ),
  );

// The result the view opened with may be old (history, another session, another face), so the
// view re-reads on load and on return; this only fills the gap until the first read lands.
app.ontoolresult = (result) => {
  if (items.state.kind !== "data" && !(result as ToolResult).isError) {
    try {
      items.set(itemsOf(result as ToolResult));
    } catch {
      // Not a list result: wait for the read.
    }
  }
};
app.onhostcontextchanged = applyContext;

await app.connect();
applyContext(app.getHostContext());
void items.refresh();
refreshOnReturn(() => void items.refresh());
