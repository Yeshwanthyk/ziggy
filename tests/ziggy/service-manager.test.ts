import { describe } from "bun:test";
import { serviceManagerContract } from "../testkit/service-manager-contract.ts";

describe("launchd service manager contract", () => serviceManagerContract("darwin"));
describe("systemd service manager contract", () => serviceManagerContract("linux"));
