import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

export interface SkillSelectionItem {
  readonly id: string;
  readonly installed: boolean;
}

export interface SkillSelectionStyle {
  readonly accent: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly success: (text: string) => string;
}

const MAX_VISIBLE_SKILLS = 12;

export class SkillMultiSelectComponent implements Component {
  private cursor: number;
  private readonly selected = new Set<string>();
  private closed = false;

  constructor(
    private readonly items: ReadonlyArray<SkillSelectionItem>,
    private readonly requestRender: () => void,
    private readonly done: (result: ReadonlyArray<string> | undefined) => void,
    private readonly style: SkillSelectionStyle,
  ) {
    const firstAvailable = items.findIndex((item) => !item.installed);
    this.cursor = firstAvailable < 0 ? 0 : firstAvailable;
  }

  handleInput(data: string): void {
    if (this.closed) {
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.cursor = Math.min(Math.max(0, this.items.length - 1), this.cursor + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const current = this.items[this.cursor];
      if (current !== undefined && !current.installed) {
        if (this.selected.has(current.id)) {
          this.selected.delete(current.id);
        } else {
          this.selected.add(current.id);
        }
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.closed = true;
      this.done(this.items.flatMap((item) => (this.selected.has(item.id) ? [item.id] : [])));
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.closed = true;
      this.done(undefined);
    }
  }

  invalidate(): void {}

  render(width: number): Array<string> {
    const installedCount = this.items.filter((item) => item.installed).length;
    const availableCount = this.items.length - installedCount;
    const maxStart = Math.max(0, this.items.length - MAX_VISIBLE_SKILLS);
    const start = Math.min(
      maxStart,
      Math.max(0, this.cursor - Math.floor(MAX_VISIBLE_SKILLS / 2)),
    );
    const end = Math.min(this.items.length, start + MAX_VISIBLE_SKILLS);
    const lines = [
      this.style.accent(this.style.bold("Profile skills")),
      this.style.dim(
        `${installedCount} installed · ${availableCount} available · ${this.selected.size} selected`,
      ),
      "",
    ];

    if (start > 0) {
      lines.push(this.style.dim(`  ↑ ${start} more`));
    }
    for (let index = start; index < end; index += 1) {
      const item = this.items[index];
      if (item === undefined) {
        continue;
      }
      const cursor = index === this.cursor ? this.style.accent("›") : " ";
      const state = item.installed
        ? this.style.success("[✓]")
        : this.selected.has(item.id)
          ? this.style.accent("[x]")
          : "[ ]";
      const suffix = item.installed ? this.style.dim(" installed") : "";
      lines.push(truncateToWidth(`${cursor} ${state} ${item.id}${suffix}`, width));
    }
    if (end < this.items.length) {
      lines.push(this.style.dim(`  ↓ ${this.items.length - end} more`));
    }

    lines.push(
      "",
      this.style.dim("↑/↓ move · Space toggle · Enter install · Esc cancel"),
    );
    return lines;
  }
}
