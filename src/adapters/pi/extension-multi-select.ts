import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ProfileExtensionChoice } from "./profile-extension-selection";

export type ExtensionMultiSelectResult = ReadonlyArray<string> | undefined;

export interface ExtensionMultiSelectTheme {
  readonly fg: (color: "accent" | "muted" | "text" | "dim", text: string) => string;
  readonly bold: (text: string) => string;
}

export class ExtensionMultiSelect {
  private readonly checked: Set<string>;
  private selectedIndex = 0;
  private readonly visibleRows = 12;

  constructor(
    private readonly extensions: ReadonlyArray<ProfileExtensionChoice>,
    selected: ReadonlyArray<string>,
    private readonly theme: ExtensionMultiSelectTheme,
    private readonly onChange: () => void,
    private readonly done: (result: ExtensionMultiSelectResult) => void,
  ) {
    this.checked = new Set(selected);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.extensions.length - 1, this.selectedIndex + 1);
      this.onChange();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const extension = this.extensions[this.selectedIndex];
      if (extension !== undefined) {
        if (this.checked.has(extension.id)) {
          this.checked.delete(extension.id);
        } else {
          this.checked.add(extension.id);
        }
        this.onChange();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.extensions.flatMap(({ id }) => (this.checked.has(id) ? [id] : [])));
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
    }
  }

  render(width: number): Array<string> {
    const availableWidth = Math.max(1, width);
    const first = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.visibleRows / 2),
        this.extensions.length - this.visibleRows,
      ),
    );
    const visible = this.extensions.slice(first, first + this.visibleRows);
    const lines = [
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("Profile extensions")),
        availableWidth,
      ),
      truncateToWidth(
        this.theme.fg("muted", "Space toggles · Enter saves the full set · Esc cancels"),
        availableWidth,
      ),
      "",
    ];

    for (const [offset, extension] of visible.entries()) {
      const index = first + offset;
      const cursor = index === this.selectedIndex ? "›" : " ";
      const checkbox = this.checked.has(extension.id) ? "[x]" : "[ ]";
      const label = `${cursor} ${checkbox} ${extension.id} · ${extension.kind} · ${extension.source} — ${extension.description}`;
      lines.push(
        truncateToWidth(
          index === this.selectedIndex
            ? this.theme.fg("accent", label)
            : this.theme.fg("text", label),
          availableWidth,
        ),
      );
    }

    if (this.extensions.length > this.visibleRows) {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "dim",
            `${this.selectedIndex + 1}/${this.extensions.length} · ${this.checked.size} selected`,
          ),
          availableWidth,
        ),
      );
    }
    return lines;
  }

  invalidate(): void {}
}
