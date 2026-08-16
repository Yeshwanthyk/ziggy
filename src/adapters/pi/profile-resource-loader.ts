import type {
  CreateAgentSessionServicesOptions,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { isEmbeddedBundledSkillPath, type PiResources } from "./resources";

export type ProfileResourceLoaderOptions = NonNullable<
  CreateAgentSessionServicesOptions["resourceLoaderOptions"]
>;

/** Build the single resource-loader shape shared by production and disposable preflight. */
export const profileResourceLoaderOptions = (
  systemPrompt: string,
  resources: PiResources,
  inlineExtensions: ReadonlyArray<InlineExtension>,
): ProfileResourceLoaderOptions => {
  const options: ProfileResourceLoaderOptions = {
    systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [...inlineExtensions, ...resources.extensionFactories],
  };
  if (resources.extensionPaths.length > 0) {
    options.additionalExtensionPaths = [...resources.extensionPaths];
  }
  if (resources.skillPaths.length > 0) {
    options.additionalSkillPaths = [...resources.skillPaths];
  }
  const embeddedSkillPaths = new Set(resources.skillPaths.filter(isEmbeddedBundledSkillPath));
  if (embeddedSkillPaths.size > 0) {
    options.skillsOverride = (base) => ({
      skills: base.skills,
      diagnostics: base.diagnostics.filter(
        (diagnostic) =>
          !(
            diagnostic.type === "warning" &&
            diagnostic.message === "skill path is not a markdown file" &&
            diagnostic.path !== undefined &&
            embeddedSkillPaths.has(diagnostic.path)
          ),
      ),
    });
  }
  return options;
};
