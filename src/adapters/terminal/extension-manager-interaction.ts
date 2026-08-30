import { autocompleteMultiselect, confirm, isCancel, select } from "@clack/prompts";
import { Effect } from "effect";
import pc from "picocolors";
import type {
  ExtensionManagerChanges,
  ExtensionManagerInteraction,
} from "../../application/extension-manager";
import type { ProfileListing } from "../../application/profiles";
import type { ProfileExtensionListing } from "../../domain/profile-extension";
import type { ProfileTarget } from "../../domain/profile";
import { TerminalInteractionFailed } from "../../domain/terminal-interaction";

const prompt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A | symbol>) =>
  Effect.tryPromise({
    try: (signal) => run(signal),
    catch: (cause) => new TerminalInteractionFailed({ operation, cause }),
  }).pipe(Effect.map((value) => (isCancel(value) ? undefined : value)));

const color = pc.createColors(process.env.NO_COLOR === undefined);
const ziggyPrompt = (label: string): string =>
  `${color.bgMagenta(color.black(color.bold(" ZIGGY ")))} ${color.bold(label)}`;

const selectProfile = (profiles: ReadonlyArray<ProfileListing>) =>
  prompt("select Profile", (signal) =>
    select({
      message: ziggyPrompt("choose a Profile"),
      options: profiles.map((profile) => ({
        value: profile.path,
        label: profile.name,
        hint: profile.path,
      })),
      maxItems: 8,
      withGuide: false,
      signal,
    }),
  ).pipe(
    Effect.map((selectedPath) =>
      selectedPath === undefined
        ? undefined
        : profiles.find((profile) => profile.path === selectedPath),
    ),
  );

const selectExtensions = (profile: ProfileTarget, listing: ProfileExtensionListing) =>
  prompt("select extensions", (signal) =>
    autocompleteMultiselect({
      message: ziggyPrompt(`extensions · ${profile.name}`),
      options: listing.available.map((extension) => ({
        value: extension.id,
        label: extension.id,
        hint: `${extension.kind} · ${extension.source}`,
      })),
      initialValues: [...listing.selected],
      placeholder: "type to filter",
      maxItems: 10,
      required: false,
      withGuide: false,
      signal,
    }),
  );

const changeSummary = (changes: ExtensionManagerChanges): string =>
  [
    changes.added.length === 0 ? undefined : `+${changes.added.length} add`,
    changes.removed.length === 0 ? undefined : `−${changes.removed.length} remove`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

const confirmChanges = (profile: ProfileTarget, changes: ExtensionManagerChanges) =>
  prompt("confirm extension changes", (signal) =>
    confirm({
      message: ziggyPrompt(`apply ${changeSummary(changes)} to ${profile.name}?`),
      active: "Apply",
      inactive: "Cancel",
      initialValue: true,
      withGuide: false,
      signal,
    }),
  );

export const terminalExtensionManagerInteraction: ExtensionManagerInteraction = {
  selectProfile,
  selectExtensions,
  confirmChanges,
};
