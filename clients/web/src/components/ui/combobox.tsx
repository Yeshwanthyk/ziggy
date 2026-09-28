import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import "./combobox.css";

interface ComboboxOption<Value> {
  readonly key: string;
  readonly value: Value;
  readonly selected: boolean;
  readonly content: React.ReactNode;
}

interface ComboboxGroup<Value> {
  readonly key: string;
  readonly heading: React.ReactNode;
  readonly icon?: React.ReactNode;
  readonly options: ReadonlyArray<ComboboxOption<Value>>;
}

interface ComboboxProps<Value> {
  /** Accessible name of the trigger (the field label); the visible value is its content. */
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly className?: string;
  readonly disabled?: boolean;
  /** Accessible name of the popover, e.g. "Choose a model". */
  readonly popoverLabel: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly groups: ReadonlyArray<ComboboxGroup<Value>>;
  readonly onSelect: (value: Value) => void;
  /** Called whenever the popover closes, so callers can reset query and filters. */
  readonly onClose?: () => void;
  readonly empty: React.ReactNode;
  /** Optional controls between the search field and the list, such as filter chips. */
  readonly toolbar?: React.ReactNode;
  readonly children: React.ReactNode;
}

interface Placement {
  readonly container: HTMLElement;
  readonly fixed: boolean;
  readonly side: "top" | "bottom";
  readonly top?: number;
  readonly bottom?: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

const GAP = 4;
const EDGE = 8;
const PREFERRED_HEIGHT = 360;
const MIN_WIDTH = 320;

/**
 * Anchors the popover to the trigger. Inside a modal dialog the popover is portalled into the
 * dialog itself, so focus trapping and outside-click dismissal keep treating it as dialog content.
 */
const measure = (trigger: HTMLElement): Placement => {
  const host = trigger.closest<HTMLElement>('[role="dialog"]');
  const rect = trigger.getBoundingClientRect();
  const bounds =
    host === null
      ? { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
      : host.getBoundingClientRect();
  const originTop = host === null ? 0 : bounds.top + host.clientTop;
  const originLeft = host === null ? 0 : bounds.left + host.clientLeft;
  const paddingBottom = host === null ? window.innerHeight : originTop + host.clientHeight;
  const below = bounds.bottom - rect.bottom - GAP - EDGE;
  const above = rect.top - bounds.top - GAP - EDGE;
  const side = below >= Math.min(PREFERRED_HEIGHT, 240) || below >= above ? "bottom" : "top";
  const available = bounds.right - bounds.left - EDGE * 2;
  const width = Math.min(Math.max(rect.width, MIN_WIDTH), available);
  const left = Math.min(Math.max(rect.left, bounds.left + EDGE), bounds.right - EDGE - width);
  return {
    container: host ?? document.body,
    fixed: host === null,
    side,
    ...(side === "bottom"
      ? { top: rect.bottom + GAP - originTop }
      : { bottom: paddingBottom - rect.top + GAP }),
    left: left - originLeft,
    width,
    maxHeight: Math.max(160, Math.min(PREFERRED_HEIGHT, side === "bottom" ? below : above)),
  };
};

const hasExitAnimation = (element: HTMLElement): boolean => {
  const name = getComputedStyle(element).animationName;
  return name !== "" && name !== "none";
};

/**
 * A select-only combobox whose popover holds a search field and a grouped listbox.
 * Arrow keys move the active option (no highlight animation), Enter selects, Escape closes
 * and returns focus to the trigger.
 */
function Combobox<Value>({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  disabled = false,
  popoverLabel,
  searchLabel,
  searchPlaceholder,
  query,
  onQueryChange,
  groups,
  onSelect,
  onClose,
  empty,
  toolbar,
  children,
}: ComboboxProps<Value>) {
  const baseId = React.useId();
  const listId = `${baseId}-list`;
  const popoverId = `${baseId}-popover`;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [instant, setInstant] = React.useState(false);
  const [placement, setPlacement] = React.useState<Placement>();
  const [activeIndex, setActiveIndex] = React.useState(0);
  const scrollActive = React.useRef(false);

  const options = React.useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const active = options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const optionId = (index: number): string => `${baseId}-option-${index}`;

  const show = (keyboard: boolean): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    setPlacement(measure(trigger));
    setInstant(keyboard);
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.selected),
      ),
    );
    scrollActive.current = true;
    setMounted(true);
    setOpen(true);
  };

  const hide = React.useCallback(
    ({ instant: skipExit, restoreFocus }: { instant: boolean; restoreFocus: boolean }) => {
      setOpen(false);
      if (skipExit) setMounted(false);
      onClose?.();
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onClose],
  );

  // Run the exit keyframe when one is defined, then unmount.
  React.useLayoutEffect(() => {
    if (open || !mounted) return;
    const element = popoverRef.current;
    if (element === null || !hasExitAnimation(element)) {
      setMounted(false);
      return;
    }
    const done = (): void => setMounted(false);
    element.addEventListener("animationend", done, { once: true });
    return () => element.removeEventListener("animationend", done);
  }, [open, mounted]);

  React.useEffect(() => {
    if (!open) return;
    const reposition = (): void => {
      const trigger = triggerRef.current;
      if (trigger !== null) setPlacement(measure(trigger));
    };
    const dismissOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      hide({ instant: false, restoreFocus: false });
    };
    // Capture on window runs before a surrounding Radix dialog's document listener,
    // so Escape closes only this popover.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hide({ instant: true, restoreFocus: true });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", dismissOutside, true);
    };
  }, [open, hide]);

  React.useEffect(() => {
    if (!open || !scrollActive.current || active < 0) return;
    scrollActive.current = false;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  const choose = (index: number, keyboard: boolean): void => {
    const option = options[index];
    if (option === undefined) return;
    onSelect(option.value);
    hide({ instant: keyboard, restoreFocus: true });
  };

  const moveActive = (next: number): void => {
    scrollActive.current = true;
    setActiveIndex(next);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(Math.min(active + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(Math.max(active - 1, 0));
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      moveActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      moveActive(options.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active, true);
    }
  };

  let index = -1;

  return (
    <>
      <button
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn("ui-combobox-trigger", className)}
        disabled={disabled}
        onClick={(event) => {
          if (open) hide({ instant: event.detail === 0, restoreFocus: false });
          else show(event.detail === 0);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            show(true);
          }
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="ui-combobox-value">{children}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {mounted && placement !== undefined
        ? createPortal(
            <div
              aria-label={popoverLabel}
              className="ui-combobox-popover"
              data-instant={instant ? "" : undefined}
              data-side={placement.side}
              data-state={open ? "open" : "closed"}
              id={popoverId}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (
                  next instanceof Node &&
                  !event.currentTarget.contains(next) &&
                  next !== triggerRef.current
                )
                  hide({ instant: true, restoreFocus: false });
              }}
              ref={popoverRef}
              role="dialog"
              style={{
                position: placement.fixed ? "fixed" : "absolute",
                top: placement.top,
                bottom: placement.bottom,
                left: placement.left,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
            >
              <label className="ui-combobox-search">
                <Search aria-hidden="true" />
                <span className="sr-only">{searchLabel}</span>
                <input
                  aria-activedescendant={active < 0 ? undefined : optionId(active)}
                  aria-autocomplete="list"
                  aria-controls={listId}
                  autoComplete="off"
                  autoFocus
                  onChange={(event) => {
                    onQueryChange(event.target.value);
                    moveActive(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder={searchPlaceholder}
                  spellCheck={false}
                  type="search"
                  value={query}
                />
              </label>
              {toolbar}
              {options.length === 0 ? (
                <div className="ui-combobox-empty">{empty}</div>
              ) : (
                <div
                  aria-label={popoverLabel}
                  className="ui-combobox-list"
                  id={listId}
                  // Keep focus in the search field while choosing with the pointer.
                  onMouseDown={(event) => event.preventDefault()}
                  role="listbox"
                >
                  {groups.map((group) => (
                    <section
                      aria-labelledby={`${baseId}-group-${group.key}`}
                      className="ui-combobox-group"
                      key={group.key}
                      role="group"
                    >
                      <div className="ui-combobox-heading" role="presentation">
                        {group.icon}
                        <h3 id={`${baseId}-group-${group.key}`}>{group.heading}</h3>
                        <span aria-hidden="true">{group.options.length}</span>
                      </div>
                      {group.options.map((option) => {
                        index += 1;
                        const optionIndex = index;
                        return (
                          <div
                            aria-selected={option.selected}
                            className="ui-combobox-option"
                            data-active={optionIndex === active ? "" : undefined}
                            id={optionId(optionIndex)}
                            key={option.key}
                            onClick={() => choose(optionIndex, false)}
                            onPointerMove={() => {
                              if (optionIndex !== active) setActiveIndex(optionIndex);
                            }}
                            role="option"
                          >
                            {option.content}
                            <Check aria-hidden="true" className="ui-combobox-check" />
                          </div>
                        );
                      })}
                    </section>
                  ))}
                </div>
              )}
            </div>,
            placement.container,
          )
        : null}
    </>
  );
}

export { Combobox };
