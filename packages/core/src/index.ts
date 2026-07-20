export const corePackageName = "@ziggy/core";
export {
  createFilesystemWorld,
  type FilesystemWorld,
  type FilesystemWorldOptions,
  type MemoryCommitCutPoint,
  type MemoryDocument,
  type MemoryRecoveryPoint,
  type MemoryReplacement,
  type SessionAppendPoint,
  type SessionSummary,
} from "./world/filesystem.ts";
