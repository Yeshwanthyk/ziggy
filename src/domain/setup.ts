import { Schema } from "effect";
import type { ModelStatus } from "../adapters/pi/models";
import type { DoctorReport } from "./doctor";

export class SetupIncomplete extends Schema.TaggedErrorClass<SetupIncomplete>()("SetupIncomplete", {
  profilePath: Schema.String,
  message: Schema.String,
}) {}

export interface SetupResult {
  readonly profilePath: string;
  readonly soulCreated: boolean;
  readonly createdDirectories: ReadonlyArray<"agents" | "automations">;
  readonly minimal: boolean;
  readonly modelStatus?: ModelStatus;
  readonly doctor?: DoctorReport;
}
