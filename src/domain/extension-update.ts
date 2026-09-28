import { Schema } from "effect";

export class ExtensionUpdateError extends Schema.TaggedErrorClass<ExtensionUpdateError>()(
  "ExtensionUpdateError",
  {
    profilePath: Schema.String,
    id: Schema.String,
    reason: Schema.Literals([
      "unsupported",
      "unmanaged",
      "modified",
      "automation",
      "filesystem",
      "recovery",
      "resident",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface ExtensionUpdateResult {
  readonly id: string;
  readonly profilePath: string;
  readonly status: "updated" | "current" | "adopted";
  readonly previousHash: string;
  readonly contentHash: string;
  readonly adoptedUnknownOrigin: boolean;
  readonly residentStopped?: boolean;
  readonly backupPath?: string;
}
