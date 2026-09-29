/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are Promise execution boundaries. */
import { expect, test } from "bun:test";
import { assertPublicUrl, isPrivateIp, readBounded } from "../fetch-url";

test("classifies private and unknown addresses as private", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "not-an-ip",
  ]) {
    expect(isPrivateIp(ip)).toBe(true);
  }

  for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    expect(isPrivateIp(ip)).toBe(false);
  }
});

test("refuses non-public targets before any network access", async () => {
  for (const url of [
    "file:///etc/passwd",
    "http://localhost:3000",
    "http://printer.local",
    "http://127.0.0.1",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "not a url",
  ]) {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  }
});

test("stops reading once the byte limit is exceeded", async () => {
  expect(await readBounded(new Response("small"), 16)).toBe("small");
  await expect(readBounded(new Response("x".repeat(32)), 16)).rejects.toThrow("16 byte limit");
});
