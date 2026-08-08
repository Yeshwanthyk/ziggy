import type { GatewayOwnerStatus } from "../domain/gateway";

export const renderServeStatus = (status: GatewayOwnerStatus): string =>
  status._tag === "stopped"
    ? [`process: stopped`, `pid: -`, `acquired at: -`, `owner path: ${status.path}`].join("\n")
    : [
        `process: ${status._tag}`,
        `pid: ${status.pid}`,
        `acquired at: ${status.acquiredAt}`,
        `owner path: ${status.path}`,
      ].join("\n");
