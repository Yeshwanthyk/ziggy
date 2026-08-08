import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionReference } from "../../domain/agent";

/** Keep nested Profile agent sessions inside the Profile-owned Pi session tree. */
export const profileAgentChildSessionDirectory = (
  profilePath: string,
  parentSessionId: string,
): string => join(profilePath, "sessions", "agents", parentSessionId);

export const sessionReference = (manager: SessionManager): SessionReference | undefined => {
  const file = manager.getSessionFile();
  return file === undefined ? undefined : { id: manager.getSessionId(), file };
};

export const createProfileAgentChildSession = (
  profilePath: string,
  parent: SessionManager,
): { readonly manager: SessionManager; readonly reference: SessionReference } | undefined => {
  const parentFile = parent.getSessionFile();
  if (!parent.isPersisted() || parentFile === undefined) return undefined;
  const manager = SessionManager.create(
    profilePath,
    profileAgentChildSessionDirectory(profilePath, parent.getSessionId()),
    { parentSession: parentFile },
  );
  const reference = sessionReference(manager);
  return reference === undefined ? undefined : { manager, reference };
};
