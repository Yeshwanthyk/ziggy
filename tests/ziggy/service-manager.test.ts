import { afterAll, describe } from "bun:test";
import { serviceManagerContract } from "../testkit/service-manager-contract.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

describe("launchd service manager contract", () => serviceManagerContract("darwin"));
describe("systemd service manager contract", () => serviceManagerContract("linux"));

afterAll(() => {
  emitVerificationObservation("s2.service-lifecycle", emptyRuntimeObservations());
});
