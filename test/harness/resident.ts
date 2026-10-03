/**
 * A real `ziggy serve` child on an ephemeral port, driven through the `packages/ui-sdk` client the
 * web UI uses. With no `web.json` the UI binds an ephemeral port and publishes its port and token in `.runtime/ui-server.json`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { connectZiggy, type ZiggyGatewayClient } from "../../packages/ui-sdk/src/client";
import type { ZiggyClientEvent, ZiggyProfileId } from "../../packages/ui-sdk/src/protocol/common";
import { spawnZiggy } from "./cli";
import { eventually } from "./eventually";
import type { ScratchProfile } from "./profile";

const Projection = Schema.Struct({ port: Schema.Finite, token: Schema.String });

const decodeProjection = Schema.decodeUnknownSync(Schema.fromJsonString(Projection));

const readProjection = (path: string) =>
  readFile(join(path, ".runtime", "ui-server.json"), "utf8").then(
    decodeProjection,
    () => undefined,
  );

export interface Client {
  readonly gateway: ZiggyGatewayClient;
  readonly profileId: ZiggyProfileId;
  /** Every event this client has seen, in order. */
  readonly events: ReadonlyArray<ZiggyClientEvent>;
  readonly close: () => void;
}

export interface Resident {
  readonly pid: number;
  readonly connect: () => Promise<Client>;
  /** SIGINT, then the exit code. */
  readonly stop: () => Promise<number>;
}

/** Residents not yet stopped; `stopResidents` ends them so a failed proof leaks no `serve`. */
const running = new Set<Resident>();

export const startResident = async (profile: ScratchProfile, waitMs = 4_000): Promise<Resident> => {
  const child = spawnZiggy(profile, "serve", profile.path);
  void new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  const projection = await eventually(
    "resident UI",
    () => readProjection(profile.path),
    waitMs,
  ).catch(async () => {
    child.kill("SIGKILL");
    throw new Error(`resident did not start within ${waitMs} ms; stderr:\n${await stderr}`);
  });

  const url = `ws://127.0.0.1:${projection.port}/ws`;
  const clients: Array<Client> = [];

  const connect = async (): Promise<Client> => {
    const gateway = connectZiggy({ url, token: projection.token, reconnectBaseDelayMs: 20 });
    const events: Array<ZiggyClientEvent> = [];
    gateway.onAny((event) => events.push(event));
    const { profileId } = await gateway.currentProfile();
    const client = { gateway, profileId, events, close: () => gateway.close() };
    clients.push(client);

    return client;
  };

  const resident: Resident = {
    pid: child.pid,
    connect,
    stop: async () => {
      running.delete(resident);

      for (const client of clients) client.close();
      child.kill("SIGINT");
      const code = await child.exited;

      if (code !== 0) console.error(await stderr);

      return code;
    },
  };

  running.add(resident);

  return resident;
};

/** Stops every resident still running and returns their exit codes; call it in `afterEach`. */
export const stopResidents = (): Promise<ReadonlyArray<number>> =>
  Promise.all([...running].map((resident) => resident.stop()));
