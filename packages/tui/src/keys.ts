import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { TuiIntent } from "./model.ts";

export function intentFromInput(data: string): TuiIntent | undefined {
  if (matchesKey(data, Key.alt("enter")) || matchesKey(data, Key.f2)) return "follow-up";
  if (matchesKey(data, Key.ctrl("x"))) return "interrupt";
  if (matchesKey(data, Key.ctrl("p"))) return "sessions";
  if (matchesKey(data, Key.ctrl("c"))) return "detach";
  if (matchesKey(data, Key.escape)) return "dismiss";
  if (matchesKey(data, Key.up)) return "move-up";
  if (matchesKey(data, Key.down)) return "move-down";
  if (matchesKey(data, "a")) return "approve";
  if (matchesKey(data, "d")) return "deny";
  if (matchesKey(data, Key.enter)) return "enter";
  return undefined;
}
