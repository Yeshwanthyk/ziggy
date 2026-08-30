import { Schema } from "effect";
import {
  actionBadge,
  alignEdges,
  createTerminalColors,
  panelLine,
  panelRule,
  terminalPanelWidth,
  truncateMiddle,
  type TerminalRenderOptions,
  ziggyBadge,
} from "./terminal-ui";

export const ProfileListingJson = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
export type ProfileListingJson = typeof ProfileListingJson.Type;

export const ProfilesJson = Schema.Array(ProfileListingJson);
export type ProfilesJson = typeof ProfilesJson.Type;
const encodeProfiles = Schema.encodeSync(ProfilesJson);

export interface ProfilesRenderOptions extends TerminalRenderOptions {
  readonly homeDirectory: string;
}

const shortenHome = (profilePath: string, homeDirectory: string): string =>
  profilePath === homeDirectory
    ? "~"
    : profilePath.startsWith(`${homeDirectory}/`)
      ? `~${profilePath.slice(homeDirectory.length)}`
      : profilePath;

const suspiciousProfileName = (name: string): boolean => name.startsWith("-");

const profileMonogram = (name: string): string => {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  return (words[0] ?? "??").slice(0, 2).toUpperCase().padEnd(2, "·");
};

const renderPlainProfiles = (profiles: ReadonlyArray<ProfileListingJson>): string =>
  profiles.length === 0
    ? "no profiles yet — try: ziggy init <name>"
    : profiles.map((profile) => `${profile.name}\t${profile.path}`).join("\n");

export const renderProfiles = (
  profiles: ReadonlyArray<ProfileListingJson>,
  options: ProfilesRenderOptions,
): string => {
  if (!options.pretty) return renderPlainProfiles(profiles);

  const color = createTerminalColors(options.colors);
  const width = terminalPanelWidth(options.columns);
  const innerWidth = width - 4;
  const count = `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`;
  const badge = ziggyBadge(color);
  const lines = [
    panelRule(color, "╭", "─", "╮", width),
    panelLine(
      color,
      alignEdges(`${badge} ${color.bold("profiles")}`, color.dim(count), innerWidth),
      width,
    ),
    panelRule(color, "├", "─", "┤", width),
  ];

  if (profiles.length === 0) {
    lines.push(
      panelLine(color, "", width),
      panelLine(color, "No profiles yet.", width),
      panelLine(
        color,
        `${color.dim("Create one with")} ${color.magenta(color.bold("ziggy init <name>"))}`,
        width,
      ),
      panelLine(color, "", width),
      panelRule(color, "╰", "─", "╯", width),
    );
    return lines.join("\n");
  }

  const pathWidth = innerWidth - 5;
  for (const profile of profiles) {
    const suspicious = suspiciousProfileName(profile.name);
    const warning = suspicious ? color.yellow("invalid name") : "";
    const tile = suspicious
      ? color.bgYellow(color.black(color.bold(" !! ")))
      : color.bgMagenta(color.black(color.bold(` ${profileMonogram(profile.name)} `)));
    const rowPrefix = `${tile} `;
    const warningWidth = suspicious ? Bun.stringWidth("invalid name") + 2 : 0;
    const nameWidth = innerWidth - Bun.stringWidth(rowPrefix) - warningWidth;
    lines.push(
      panelLine(
        color,
        alignEdges(
          `${rowPrefix}${color.bold(truncateMiddle(profile.name, nameWidth))}`,
          warning,
          innerWidth,
        ),
        width,
      ),
      panelLine(
        color,
        `     ${color.dim(
          `└ ${truncateMiddle(shortenHome(profile.path, options.homeDirectory), pathWidth)}`,
        )}`,
        width,
      ),
    );
  }

  if (profiles.some((profile) => !suspiciousProfileName(profile.name))) {
    const action = actionBadge(color, "OPEN");
    lines.push(
      panelRule(color, "├", "─", "┤", width),
      panelLine(
        color,
        alignEdges(
          `${action} ${color.bold("ziggy <profile>")}`,
          color.dim("open a profile"),
          innerWidth,
        ),
        width,
      ),
    );
  }
  lines.push(panelRule(color, "╰", "─", "╯", width));

  return lines.join("\n");
};

export const renderProfilesJson = (profiles: ReadonlyArray<ProfileListingJson>): string =>
  JSON.stringify(encodeProfiles(profiles));

export const renderProfileListingsJson = renderProfilesJson;
