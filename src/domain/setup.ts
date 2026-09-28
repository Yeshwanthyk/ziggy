import { Schema } from "effect";
import type { DoctorReport } from "./doctor";

export interface SetupModelStatus {
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly thinking: string;
  readonly authConfigured: boolean;
}

export class SetupIncomplete extends Schema.TaggedErrorClass<SetupIncomplete>()("SetupIncomplete", {
  profilePath: Schema.String,
  message: Schema.String,
}) {}

export interface SetupResult {
  readonly profilePath: string;
  readonly soulCreated: boolean;
  readonly createdDirectories: ReadonlyArray<"agents" | "automations">;
  readonly minimal: boolean;
  readonly modelStatus?: SetupModelStatus;
  readonly doctor?: DoctorReport;
}
