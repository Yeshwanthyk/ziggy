import { expect, test } from "bun:test";
import type { ProfileLock } from "../../packages/core/src/daemon/profile-lock.ts";

export interface ProfileLockSpecimen {
  acquire(): Promise<ProfileLock>;
  writeMetadata(value: string): Promise<void>;
  readMetadata(): Promise<string | undefined>;
  writeTakeoverMetadata(value: string): Promise<void>;
  readTakeoverMetadata(): Promise<string | undefined>;
  setAlive(pid: number, alive: boolean): void;
  setOwnerPid(pid: number): void;
}

export function defineProfileLockContract(
  name: string,
  create: () => Promise<ProfileLockSpecimen>,
): void {
  test(`${name}: simultaneous acquisition has one owner`, async () => {
    const specimen = await create();
    const results = await Promise.allSettled([specimen.acquire(), specimen.acquire()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const owner = results.find((result) => result.status === "fulfilled");
    if (owner?.status === "fulfilled") await owner.value.close();
  });

  test(`${name}: refuses live PID and takes over stale PID`, async () => {
    const specimen = await create();
    specimen.setAlive(77, true);
    await specimen.writeMetadata('{"schemaVersion":1,"pid":77,"ownerToken":"old"}\n');
    await expect(specimen.acquire()).rejects.toThrow("PID 77");
    specimen.setAlive(77, false);
    const lock = await specimen.acquire();
    await lock.close();
    expect(await specimen.readMetadata()).toBeUndefined();
  });

  test(`${name}: simultaneous stale takeover has one owner`, async () => {
    const specimen = await create();
    specimen.setAlive(77, false);
    await specimen.writeMetadata('{"schemaVersion":1,"pid":77,"ownerToken":"old"}\n');
    const results = await Promise.allSettled([specimen.acquire(), specimen.acquire()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const owner = results.find((result) => result.status === "fulfilled");
    if (owner?.status === "fulfilled") await owner.value.close();
  });

  test(`${name}: recovers an orphaned stale takeover without a lock`, async () => {
    const specimen = await create();
    specimen.setAlive(77, false);
    await specimen.writeTakeoverMetadata('{"schemaVersion":1,"pid":77,"ownerToken":"orphaned"}\n');
    const lock = await specimen.acquire();
    expect(await specimen.readTakeoverMetadata()).toBeUndefined();
    await lock.close();
  });

  test(`${name}: release is owner-token safe`, async () => {
    const specimen = await create();
    const lock = await specimen.acquire();
    await specimen.writeMetadata('{"schemaVersion":1,"pid":88,"ownerToken":"replacement"}\n');
    await lock.close();
    expect(await specimen.readMetadata()).toContain("replacement");
  });

  test(`${name}: malformed and version-mismatched metadata fail loud`, async () => {
    const specimen = await create();
    await specimen.writeMetadata("not-json");
    await expect(specimen.acquire()).rejects.toThrow("Malformed");
    await specimen.writeMetadata('{"schemaVersion":2,"pid":77,"ownerToken":"old"}');
    await expect(specimen.acquire()).rejects.toThrow("schemaVersion");
  });
}
