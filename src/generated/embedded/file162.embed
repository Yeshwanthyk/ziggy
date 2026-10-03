// View kit: plain DOM controls, fixed states and the refresh/write loop every plugin view needs.
// Build views from these instead of hand-rolling controls; style with kit.css classes. Copied into
// each plugin (no package to install), so edit freely, but keep the behaviour described here.
import "./kit.css";

type Child = Node | string | false | null | undefined;
type Props = Record<string, string | number | boolean | EventListener | undefined>;

/** `el("li", { class: "x", onclick: fn }, child, …)`: `on*` props become listeners. */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  node.append(...children.filter((child): child is Node | string => Boolean(child)));

  return node;
};

// Layout: a column, a row that wraps, and a toolbar whose extra actions fold into "More…" below
// 480 px (the frame's width).
export const stack = (...children: Child[]) => el("div", { class: "kit-stack" }, ...children);
export const row = (...children: Child[]) => el("div", { class: "kit-row" }, ...children);

export interface Action {
  readonly label: string;
  readonly run: () => void;
}

export const toolbar = (main: ReadonlyArray<Node>, extra: ReadonlyArray<Action> = []) => {
  const more = menu("More…", extra, (action) => action.run());
  more.classList.add("kit-more");

  return el(
    "div",
    { class: "kit-toolbar", role: "toolbar" },
    ...main,
    ...extra.map((action) => {
      const folded = button(action.label, action.run);
      folded.classList.add("kit-folds");
      return folded;
    }),
    extra.length > 0 && more,
  );
};

// Controls

export type Variant = "primary" | "secondary" | "danger";

export const button = (label: string, onClick: () => void, variant: Variant = "secondary") =>
  el("button", { type: "button", class: `kit-button ${variant}`, onclick: () => onClick() }, label);

export type Tone = "neutral" | "success" | "warning" | "danger";

export const tag = (text: string, tone: Tone = "neutral") =>
  el("span", { class: `kit-tag ${tone}` }, text);

/** A labelled input. No <form>: the host frame has no allow-forms, so Enter calls `onEnter`. */
export const field = (
  label: string,
  input: Partial<Pick<HTMLInputElement, "type" | "placeholder" | "maxLength" | "value">> = {},
  onEnter?: (input: HTMLInputElement) => void,
) => {
  const control = el("input", { class: "kit-input", type: input.type ?? "text" });
  Object.assign(control, input);
  if (onEnter) {
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) onEnter(control);
    });
  }

  return { node: el("label", { class: "kit-field" }, label, control), input: control };
};

/** A native select used as a menu: `label` is the prompt, picking an option calls `onPick`. */
export const menu = <T extends { readonly label: string }>(
  label: string,
  options: ReadonlyArray<T>,
  onPick: (option: T) => void,
) => {
  const select = el(
    "select",
    { class: "kit-menu", "aria-label": label },
    el("option", { value: "" }, label),
    ...options.map((option, index) => el("option", { value: String(index) }, option.label)),
  );
  select.addEventListener("change", () => {
    const option = select.value === "" ? undefined : options[Number(select.value)];
    select.value = "";
    if (option) onPick(option);
  });

  return select;
};

// Two-click confirm. The armed state lives here, by key, so a re-render (or a refresh that
// replaces the row) keeps it until it times out.
const armed = new Map<string, ReturnType<typeof setTimeout>>();

export const confirmButton = (
  key: string,
  label: string,
  onConfirm: () => void,
  { armedLabel = "Sure?", ms = 3000 } = {},
) => {
  const node = button(label, () => {
    if (!armed.has(key)) {
      armed.set(
        key,
        setTimeout(() => {
          armed.delete(key);
          show();
        }, ms),
      );
      return show();
    }
    clearTimeout(armed.get(key));
    armed.delete(key);
    show();
    onConfirm();
  });
  node.classList.add("danger");
  node.dataset.kitConfirm = key;
  // Every button for this key, so an older copy left in the DOM agrees with the new one.
  const show = () => {
    for (const each of document.querySelectorAll<HTMLButtonElement>(
      `[data-kit-confirm="${CSS.escape(key)}"]`,
    )) {
      each.textContent = armed.has(key) ? armedLabel : label;
      each.classList.toggle("armed", armed.has(key));
    }
  };
  if (armed.has(key)) {
    node.textContent = armedLabel;
    node.classList.add("armed");
  }

  return node;
};

const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Tomorrow / Next Monday / In a week / In a month, plus a date input. Gives `YYYY-MM-DD`. */
export const datePresets = (onPick: (date: string) => void, now = new Date()) => {
  const after = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const presets: ReadonlyArray<readonly [string, Date]> = [
    ["Tomorrow", after(1)],
    ["Next Monday", after((8 - now.getDay()) % 7 || 7)],
    ["In a week", after(7)],
    ["In a month", new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())],
  ];
  const custom = el("input", { class: "kit-input", type: "date", "aria-label": "Pick a date" });
  custom.min = isoDate(after(1));
  custom.style.width = "auto";
  custom.addEventListener("change", () => custom.value && onPick(custom.value));

  return row(...presets.map(([label, date]) => button(label, () => onPick(isoDate(date)))), custom);
};

// Status line: polite live region, hidden when empty.
export const status = (node: HTMLElement) => {
  node.classList.add("kit-status");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");

  return (text: string, error = false) => {
    node.textContent = text;
    node.classList.toggle("error", error);
  };
};

// Lists keyed by id, updated in place: existing rows keep their nodes (and focus, and a click in
// progress), new ones are created, gone ones removed, and order is fixed with moves only.
export interface Row<T> {
  readonly node: HTMLElement;
  readonly update: (item: T) => void;
}

export const keyedList = <T>(
  list: HTMLElement,
  key: (item: T) => string | number,
  create: (item: T) => Row<T>,
) => {
  list.classList.add("kit-list");
  const rows = new Map<string | number, Row<T>>();

  return (items: ReadonlyArray<T>) => {
    const keep = new Set(items.map(key));
    for (const [id, existing] of rows) {
      if (!keep.has(id)) {
        existing.node.remove();
        rows.delete(id);
      }
    }
    // Anything that isn't a keyed row (a notice, a skeleton) goes.
    const owned = new Set([...rows.values()].map((each) => each.node));
    for (const child of [...list.children]) if (!owned.has(child as HTMLElement)) child.remove();

    items.forEach((item, index) => {
      let current = rows.get(key(item));
      if (!current) {
        current = create(item);
        rows.set(key(item), current);
      }
      current.update(item);
      if (list.children[index] !== current.node)
        list.insertBefore(current.node, list.children[index] ?? null);
    });
  };
};

// States

/** An empty list, a feature turned off at the source, or an error with a retry. */
export const notice = (kind: "empty" | "off" | "error", text: string, retry?: () => void) =>
  el(
    "div",
    {
      class: `kit-notice ${kind === "error" ? "error" : ""}`,
      role: kind === "error" ? "alert" : undefined,
    },
    el("div", {}, text),
    retry && button("Try again", retry),
  );

export const skeleton = (rows = 3) =>
  el(
    "div",
    { role: "status", "aria-busy": "true", "aria-label": "Loading" },
    ...Array.from({ length: rows }, () => el("div", { class: "kit-skeleton" })),
  );

export type QueryState<T> =
  | { readonly kind: "pending"; readonly slow: boolean }
  | { readonly kind: "data"; readonly data: T; readonly error?: string }
  | { readonly kind: "error"; readonly error: string };

/**
 * One read and its state. `pending` turns `slow` after 300 ms (show a skeleton then, not before);
 * a failed refresh keeps the last data and adds `error`; `set` takes data from elsewhere (the
 * result the view opened with). Only the latest read's answer is used.
 */
export const query = <T>(load: () => Promise<T>, onChange: (state: QueryState<T>) => void) => {
  let state: QueryState<T> = { kind: "pending", slow: false };
  let generation = 0;
  const change = (next: QueryState<T>) => {
    state = next;
    onChange(next);
    // A settled-state signal for `bun run shots`: pending, slow, data or error.
    document.documentElement.dataset.kitState =
      next.kind === "pending" ? (next.slow ? "slow" : "pending") : next.kind;
  };

  const refresh = async () => {
    const mine = ++generation;
    let slow: ReturnType<typeof setTimeout> | undefined;
    if (state.kind !== "data") {
      change({ kind: "pending", slow: false });
      slow = setTimeout(
        () => state.kind === "pending" && change({ kind: "pending", slow: true }),
        300,
      );
    }
    try {
      const data = await load();
      if (mine === generation) change({ kind: "data", data });
    } catch (cause) {
      if (mine !== generation) return;
      const error = cause instanceof Error ? cause.message : String(cause);
      change(
        state.kind === "data"
          ? { kind: "data", data: state.data, error }
          : { kind: "error", error },
      );
    } finally {
      clearTimeout(slow);
    }
  };

  return {
    refresh,
    // A read already in flight still lands after this: it is newer.
    set: (data: T) => change({ kind: "data", data }),
    get state() {
      return state;
    },
  };
};

/**
 * Writes run one at a time, each followed by a re-read, so a fast second click never races the
 * first. A failed write reports through `onError` and the queue goes on.
 */
export const writeQueue = (reread: () => Promise<void>, onError: (message: string) => void) => {
  let tail = Promise.resolve();

  return (write: () => Promise<void>) => {
    tail = tail.then(async () => {
      try {
        await write();
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
      }
      await reread();
    });

    return tail;
  };
};

/**
 * Re-reads when the person comes back to the view (focus, tab visible), at most every 2 s. A
 * click into an unfocused frame fires focus between mousedown and mouseup; refreshing then could
 * move the row under the pointer and lose the click, so it waits until the pointer is up.
 */
export const refreshOnReturn = (refresh: () => void, throttleMs = 2000) => {
  let last = 0;
  let pressed = false;
  let pending = false;
  const run = () => {
    if (pressed) {
      pending = true;
      return;
    }
    if (Date.now() - last < throttleMs) return;
    last = Date.now();
    refresh();
  };
  addEventListener("pointerdown", () => (pressed = true), true);
  const release = () => {
    pressed = false;
    // After the click handlers for this press have run.
    if (pending) setTimeout(() => ((pending = false), run()));
  };
  addEventListener("pointerup", release, true);
  addEventListener("pointercancel", release, true);
  // A press that ends outside the frame never sends pointerup here.
  addEventListener("blur", release);
  addEventListener("focus", run);
  document.addEventListener(
    "visibilitychange",
    () => document.visibilityState === "visible" && run(),
  );
};
