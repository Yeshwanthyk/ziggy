import { describe, expect, test } from "bun:test";
import type { ProviderAuthStatus } from "../adapters/pi/auth";
import { defaultAuthType } from "./auth";

const provider = (supportsApiKeyLogin: boolean, supportsOauth: boolean): ProviderAuthStatus => ({
  id: "provider",
  name: "Provider",
  supportsApiKeyLogin,
  ambientOnly: false,
  supportsOauth,
  configured: undefined,
});

describe("provider auth defaults", () => {
  test("prefers API key when both interactive login types exist", () => {
    expect(defaultAuthType(provider(true, true))).toBe("api_key");
  });

  test("uses OAuth when it is the only interactive login type", () => {
    expect(defaultAuthType(provider(false, true))).toBe("oauth");
  });

  test("keeps API key as the fail-closed default when neither type is advertised", () => {
    expect(defaultAuthType(provider(false, false))).toBe("api_key");
  });
});
