import { Schema } from "effect";
import type { ExtensionManagerResult } from "../application/extension-manager";
import type {
  ProfileExtensionLockFailed,
  ProfileExtensionMutation,
  ProfileExtensionPreflightFailed,
  ProfileExtensionRollbackFailed,
} from "../domain/profile-extension";
import {
  actionBadge,
  alignEdges,
  createTerminalColors,
  panelLine,
  panelRule,
  terminalPanelWidth,
  truncateEnd,
  type TerminalRenderOptions,
  ziggyBadge,
} from "./terminal-ui";

type ProfileExtensionFailure =
  | ProfileExtensionPreflightFailed
  | ProfileExtensionLockFailed
  | ProfileExtensionRollbackFailed;

const MAX_DIAGNOSTIC_SOURCE = 160;
const MAX_DIAGNOSTIC_REASON = 360;
const MAX_ROLLBACK_OPERATION = 96;
const MAX_ROLLBACK_PATH = 240;

const bounded = (value: string, maximum: number): string =>
  [
    ...value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ]
    .slice(0, maximum)
    .join("");

const safeText = (value: string, maximum: number): string =>
  bounded(value, maximum) || "unavailable";

export const renderProfileExtensionFailure = (failure: ProfileExtensionFailure): string => {
  switch (failure._tag) {
    case "ProfileExtensionPreflightFailed": {
      const diagnostic = failure.diagnostics[0];
      return [
        `Profile extension preflight failed: ${safeText(failure.message, MAX_DIAGNOSTIC_REASON)}`,
        `stage=${failure.stage}`,
        diagnostic === undefined
          ? "diagnostic=unavailable"
          : `diagnostic source=${safeText(diagnostic.source, MAX_DIAGNOSTIC_SOURCE)}; reason=${safeText(diagnostic.message, MAX_DIAGNOSTIC_REASON)}`,
      ].join("; ");
    }
    case "ProfileExtensionLockFailed":
      return `Profile extension lock failed: operation=${failure.operation}; reason=${safeText(failure.message, MAX_DIAGNOSTIC_REASON)}`;
    case "ProfileExtensionRollbackFailed": {
      const rollbackFailure = failure.rollbackFailures[0];
      return [
        `Profile extension rollback failed: operation=${failure.operation}; reason=${safeText(failure.message, MAX_DIAGNOSTIC_REASON)}`,
        rollbackFailure === undefined
          ? "rollback failure=unavailable"
          : `rollback operation=${safeText(rollbackFailure.operation, MAX_ROLLBACK_OPERATION)}; path=${safeText(rollbackFailure.path, MAX_ROLLBACK_PATH)}; reason=${safeText(rollbackFailure.message, MAX_DIAGNOSTIC_REASON)}`,
      ].join("; ");
    }
  }
};

const ExtensionSkillJson = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
});

export const ExtensionCatalogListingJson = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["skill", "code", "skill+code", "remote"]),
  required: Schema.Boolean,
  source: Schema.Literals(["bundled", "remote-approved"]),
  installed: Schema.Boolean,
  packagePath: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(ExtensionSkillJson)),
  extensionPaths: Schema.optional(Schema.Array(Schema.String)),
});
export type ExtensionCatalogListingJson = typeof ExtensionCatalogListingJson.Type;

export const ExtensionsJson = Schema.Array(ExtensionCatalogListingJson);
export type ExtensionsJson = typeof ExtensionsJson.Type;
const encodeExtensions = Schema.encodeSync(ExtensionsJson);
const encodeExtension = Schema.encodeSync(ExtensionCatalogListingJson);

export const renderExtensionsJson = (
  extensions: ReadonlyArray<ExtensionCatalogListingJson>,
): string => JSON.stringify(encodeExtensions(extensions));

export const renderExtensionJson = (extension: ExtensionCatalogListingJson): string =>
  JSON.stringify(encodeExtension(extension));

const kindBadge = (
  color: ReturnType<typeof createTerminalColors>,
  kind: ExtensionCatalogListingJson["kind"],
): string => {
  const label =
    kind === "skill" ? "SK" : kind === "code" ? "CD" : kind === "skill+code" ? "SC" : "RM";
  return color.bgMagenta(color.black(color.bold(` ${label} `)));
};

const renderPlainExtensions = (extensions: ReadonlyArray<ExtensionCatalogListingJson>): string =>
  extensions
    .map(
      (extension) =>
        `${extension.id}\t${extension.kind}\t${extension.required ? "required" : "optional"}\t${extension.source}\t${extension.description}`,
    )
    .join("\n");

export const renderExtensions = (
  extensions: ReadonlyArray<ExtensionCatalogListingJson>,
  options: TerminalRenderOptions,
): string => {
  if (!options.pretty) return renderPlainExtensions(extensions);

  const color = createTerminalColors(options.colors);
  const width = terminalPanelWidth(options.columns);
  const innerWidth = width - 4;
  const count = `${extensions.length} available`;
  const lines = [
    panelRule(color, "╭", "─", "╮", width),
    panelLine(
      color,
      alignEdges(`${ziggyBadge(color)} ${color.bold("extensions")}`, color.dim(count), innerWidth),
      width,
    ),
    panelRule(color, "├", "─", "┤", width),
  ];

  if (extensions.length === 0) {
    lines.push(panelLine(color, "No extensions available.", width));
  } else {
    for (const extension of extensions) {
      const badge = kindBadge(color, extension.kind);
      const status = `${extension.source} · ${extension.required ? "required" : "optional"}`;
      const nameWidth = innerWidth - Bun.stringWidth(badge) - Bun.stringWidth(status) - 4;
      lines.push(
        panelLine(
          color,
          alignEdges(
            `${badge} ${color.bold(truncateEnd(extension.id, nameWidth))}`,
            color.dim(status),
            innerWidth,
          ),
          width,
        ),
        panelLine(
          color,
          `     ${color.dim(truncateEnd(extension.description, innerWidth - 5))}`,
          width,
        ),
      );
    }
  }

  const action = actionBadge(color, "MANAGE");
  const command = "ziggy extensions manage <profile>";
  const hint = "choose extensions";
  const fullHintWidth = Bun.stringWidth(action) + 1 + command.length + 2 + hint.length;
  lines.push(panelRule(color, "├", "─", "┤", width));
  if (fullHintWidth <= innerWidth) {
    lines.push(
      panelLine(
        color,
        alignEdges(`${action} ${color.bold(command)}`, color.dim(hint), innerWidth),
        width,
      ),
    );
  } else {
    lines.push(
      panelLine(color, `${action} ${color.bold("ziggy extensions manage")}`, width),
      panelLine(color, alignEdges(color.bold("<profile>"), color.dim(hint), innerWidth), width),
    );
  }
  lines.push(panelRule(color, "╰", "─", "╯", width));
  return lines.join("\n");
};

const renderPlainExtension = (extension: ExtensionCatalogListingJson): string =>
  [
    `id\t${extension.id}`,
    `kind\t${extension.kind}`,
    `status\t${extension.required ? "required" : "optional"}`,
    `description\t${extension.description}`,
    `source\t${extension.source}`,
    `version\t${extension.version}`,
    `installed\t${extension.installed ? "yes" : "no"}`,
    ...(extension.packagePath === undefined ? [] : [`path\t${extension.packagePath}`]),
    ...(extension.skills ?? []).map((skill) => `skill\t${skill.name} — ${skill.description}`),
    ...(extension.extensionPaths ?? []).map((extensionPath) => `executable\t${extensionPath}`),
  ].join("\n");

export const renderExtension = (
  extension: ExtensionCatalogListingJson,
  options: TerminalRenderOptions,
): string => {
  if (!options.pretty) return renderPlainExtension(extension);

  const color = createTerminalColors(options.colors);
  const width = terminalPanelWidth(options.columns);
  const innerWidth = width - 4;
  const lines = [
    panelRule(color, "╭", "─", "╮", width),
    panelLine(
      color,
      alignEdges(
        `${ziggyBadge(color)} ${color.bold("extension")}`,
        color.dim(extension.version),
        innerWidth,
      ),
      width,
    ),
    panelRule(color, "├", "─", "┤", width),
    panelLine(color, `${kindBadge(color, extension.kind)} ${color.bold(extension.id)}`, width),
    panelLine(color, color.dim(truncateEnd(extension.description, innerWidth)), width),
    panelLine(color, "", width),
    panelLine(color, alignEdges("kind", extension.kind, innerWidth), width),
    panelLine(color, alignEdges("source", extension.source, innerWidth), width),
    panelLine(
      color,
      alignEdges("selection", extension.required ? "required" : "optional", innerWidth),
      width,
    ),
    panelLine(
      color,
      alignEdges("installed", extension.installed ? "yes" : "no", innerWidth),
      width,
    ),
  ];
  if (extension.packagePath !== undefined) {
    lines.push(panelLine(color, alignEdges("path", extension.packagePath, innerWidth), width));
  }
  if ((extension.skills?.length ?? 0) > 0 || (extension.extensionPaths?.length ?? 0) > 0) {
    lines.push(panelRule(color, "├", "─", "┤", width));
    for (const skill of extension.skills ?? []) {
      lines.push(
        panelLine(color, `${actionBadge(color, "SKILL")} ${color.bold(skill.name)}`, width),
        panelLine(color, color.dim(truncateEnd(skill.description, innerWidth)), width),
      );
    }
    for (const extensionPath of extension.extensionPaths ?? []) {
      lines.push(
        panelLine(
          color,
          `${actionBadge(color, "CODE")} ${truncateEnd(extensionPath, innerWidth - 7)}`,
          width,
        ),
      );
    }
  }
  lines.push(panelRule(color, "╰", "─", "╯", width));
  return lines.join("\n");
};

export const renderExtensionManagerResult = (
  result: ExtensionManagerResult,
  options: TerminalRenderOptions,
): string => {
  if (!options.pretty) {
    if (result.status === "empty") return "no profiles yet — try: ziggy init <name>";
    if (result.status === "cancelled") return "cancelled; no extension changes made";
    if (result.status === "unchanged") {
      return `extensions unchanged for ${result.profile.path}`;
    }
    return `updated extensions for ${result.profile.path}: +${result.added.join(",")} -${result.removed.join(",")}`;
  }

  const color = createTerminalColors(options.colors);
  const width = terminalPanelWidth(options.columns);
  const innerWidth = width - 4;
  const label =
    result.status === "changed"
      ? "DONE"
      : result.status === "unchanged"
        ? "READY"
        : result.status === "empty"
          ? "START"
          : "CANCEL";
  const lines = [
    panelRule(color, "╭", "─", "╮", width),
    panelLine(color, `${actionBadge(color, label)} ${color.bold("extensions")}`, width),
    panelRule(color, "├", "─", "┤", width),
  ];
  if (result.status === "empty") {
    lines.push(
      panelLine(color, "No profiles yet.", width),
      panelLine(
        color,
        `${color.dim("Create one with")} ${color.magenta(color.bold("ziggy init <name>"))}`,
        width,
      ),
    );
  } else if (result.status === "cancelled") {
    lines.push(panelLine(color, "No changes made.", width));
  } else if (result.status === "unchanged") {
    lines.push(
      panelLine(color, alignEdges(result.profile.name, "already up to date", innerWidth), width),
    );
  } else {
    lines.push(
      panelLine(
        color,
        alignEdges(result.profile.name, `${result.selected.length} selected`, innerWidth),
        width,
      ),
      ...result.added.map((id) => panelLine(color, `${color.green("+")} ${id}`, width)),
      ...result.removed.map((id) => panelLine(color, `${color.yellow("−")} ${id}`, width)),
      panelLine(color, "", width),
      panelLine(color, color.dim("Reopen the Profile to apply the change."), width),
    );
  }
  lines.push(panelRule(color, "╰", "─", "╯", width));
  return lines.join("\n");
};

export const renderExtensionMutation = (
  result: ProfileExtensionMutation,
  options: TerminalRenderOptions,
): string => {
  if (!options.pretty) {
    if (!result.changed) {
      return `${result.id} is ${result.selected ? "already selected" : "not selected"} for ${result.profilePath}`;
    }
    return `${result.selected ? "selected" : "unselected"} ${result.id} for ${result.profilePath}\nreopen the Profile or restart its Ziggy process to apply the change`;
  }

  const color = createTerminalColors(options.colors);
  const width = terminalPanelWidth(options.columns);
  const innerWidth = width - 4;
  const state = result.selected ? "selected" : "removed";
  const lines = [
    panelRule(color, "╭", "─", "╮", width),
    panelLine(
      color,
      `${actionBadge(color, result.changed ? "DONE" : "READY")} ${color.bold("extensions")}`,
      width,
    ),
    panelRule(color, "├", "─", "┤", width),
    panelLine(color, alignEdges(result.id, state, innerWidth), width),
    panelLine(color, color.dim(truncateEnd(result.profilePath, innerWidth)), width),
  ];
  if (result.changed) {
    lines.push(
      panelLine(color, "", width),
      panelLine(color, color.dim("Reopen the Profile to apply the change."), width),
    );
  }
  lines.push(panelRule(color, "╰", "─", "╯", width));
  return lines.join("\n");
};

export const renderExtensionListingsJson = renderExtensionsJson;
