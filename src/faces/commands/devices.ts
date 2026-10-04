import { networkInterfaces } from "node:os";
import { Clock, Effect } from "effect";
import { ResidentService } from "../../application/resident-service";
import { writeFileAtomic } from "../../platform/atomic-write";
import { ZiggyPaths } from "../../platform/paths";
import {
  type DevicesConfig,
  deviceHubKey,
  devicesConfigPath,
  formatZdpPairing,
  issuePairingCode,
  listDevices,
  readDeviceHubProjection,
  readDevicesConfig,
  renameDevice,
  revokeDevice,
} from "../../devices";
import { type ProfileTarget, resolveProfileTarget } from "../../profile";
import type { CliCommand } from "../cli-command";
import { CliCommandFailed } from "../cli-exit";

export type DevicesCommand = Extract<
  CliCommand,
  {
    readonly _tag:
      | "DevicesConfigure"
      | "DevicesPair"
      | "DevicesList"
      | "DevicesRename"
      | "DevicesRevoke";
  }
>;

/** The first LAN IPv4 address, which a device on the same network can reach. */
const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === "IPv4" && !address.internal)?.address;

const WILDCARD = new Set(["0.0.0.0", "::"]);

/** The hub as the resident runs it now: the published port, while the resident is up. */
const runningHub = (target: ProfileTarget) =>
  Effect.gen(function* () {
    const residentService = yield* ResidentService;

    const owner = yield* residentService.owner(target);

    if (owner._tag !== "running") return { running: false, hub: undefined };

    return { running: true, hub: yield* readDeviceHubProjection(target.path) };
  });

const requireConfig = (target: ProfileTarget) =>
  Effect.gen(function* () {
    const config = yield* readDevicesConfig(target.path);

    if (config !== undefined) return config;

    return yield* new CliCommandFailed({
      message: `devices are off for this Profile; turn them on with: ziggy devices configure ${JSON.stringify(target.path)}`,
    });
  });

export const runDevicesCommand = (command: DevicesCommand) =>
  Effect.gen(function* () {
    const paths = yield* ZiggyPaths;

    const target = resolveProfileTarget(command.target, paths);

    switch (command._tag) {
      case "DevicesConfigure": {
        const config: DevicesConfig = {
          version: 1,
          listen: { host: command.host, port: command.port },
        };

        yield* writeFileAtomic(
          devicesConfigPath(target.path),
          `${JSON.stringify(config, null, 2)}\n`,
          0o644,
        );

        console.log(
          `devices configured: ${command.host}:${command.port}\nrestart the resident to apply it`,
        );

        return;
      }

      case "DevicesPair": {
        const config = yield* requireConfig(target);

        const key = yield* deviceHubKey(target.path);

        const { running, hub } = yield* runningHub(target);

        const port = hub?.port ?? (config.listen.port === 0 ? undefined : config.listen.port);

        if (port === undefined)
          return yield* new CliCommandFailed({
            message: `devices.json asks for any free port; start the resident first: ziggy serve ${JSON.stringify(target.path)}`,
          });

        const host = WILDCARD.has(config.listen.host)
          ? (lanAddress() ?? "127.0.0.1")
          : config.listen.host;

        const issued = yield* issuePairingCode(target.path, yield* Clock.currentTimeMillis);

        console.log(formatZdpPairing({ host, port, code: issued.code, key: key.publicKey }));
        console.log(`expires: ${new Date(issued.expiresAtMs).toISOString()}`);

        if (!running)
          console.log(
            `the resident is not running; start it before pairing: ziggy serve ${JSON.stringify(target.path)}`,
          );
        else if (hub === undefined)
          console.log("the resident is not serving devices; restart it to apply devices.json");

        return;
      }

      case "DevicesList": {
        const devices = yield* listDevices(target.path);

        const { hub } = yield* runningHub(target);

        const online = new Map((hub?.online ?? []).map((entry) => [entry.id, entry.since]));

        const rows = devices.map((device) => ({
          id: device.id,
          name: device.name,
          model: device.model,
          pairedAt: device.pairedAt,
          online: online.get(device.id) ?? null,
        }));

        if (command.json) console.log(JSON.stringify(rows, null, 2));
        else if (rows.length === 0) console.log("no paired devices");
        else
          for (const row of rows)
            console.log(
              `${row.id}  ${row.name}  ${row.model}  ${row.online === null ? "offline" : `online since ${row.online}`}`,
            );

        return;
      }

      case "DevicesRename": {
        const renamed = yield* renameDevice(target.path, command.id, command.name);

        if (renamed === undefined)
          return yield* new CliCommandFailed({ message: `no paired device ${command.id}` });

        console.log(`renamed ${renamed.id}: ${renamed.name}`);

        return;
      }

      case "DevicesRevoke": {
        const revoked = yield* revokeDevice(target.path, command.id);

        if (!revoked)
          return yield* new CliCommandFailed({ message: `no paired device ${command.id}` });

        console.log(`revoked ${command.id}; a running resident drops its link within seconds`);

        return;
      }
    }
  });
