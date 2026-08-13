import { Context, Effect, Layer, Predicate } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ZiggyUpdateUnavailable } from "../../domain/extension-catalog";

export interface ZiggyReleaseClientApi {
  readonly downloadLatest: () => Effect.Effect<
    { readonly version: string; readonly executable: Uint8Array; readonly sha256: string },
    ZiggyUpdateUnavailable
  >;
}

export class ZiggyReleaseClient extends Context.Service<
  ZiggyReleaseClient,
  ZiggyReleaseClientApi
>()("ziggy/ZiggyReleaseClient") {}

const requestBytes = (client: HttpClient.HttpClient, url: string, operation: string) =>
  client.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.arrayBuffer.pipe(
            Effect.map((body) => new Uint8Array(body)),
            Effect.mapError(
              (cause) =>
                new ZiggyUpdateUnavailable({
                  message: `could not read ${operation} response`,
                  cause,
                }),
            ),
          )
        : Effect.fail(
            new ZiggyUpdateUnavailable({
              message: `${operation} returned HTTP ${response.status}`,
              cause: undefined,
            }),
          ),
    ),
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "ZiggyUpdateUnavailable")
        ? cause
        : new ZiggyUpdateUnavailable({ message: `could not ${operation}`, cause }),
    ),
  );

export const makeZiggyReleaseClient = (
  client: HttpClient.HttpClient,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ZiggyReleaseClientApi => {
  const target = `${platform}-${arch}`;
  const base = `https://github.com/Yeshwanthyk/ziggy/releases/latest/download/ziggy-${target}`;
  return {
    downloadLatest: () =>
      Effect.gen(function* () {
        const executable = yield* requestBytes(client, base, "download Ziggy update");
        const checksumBytes = yield* requestBytes(
          client,
          `${base}.sha256`,
          "download Ziggy checksum",
        );
        const checksum = new TextDecoder().decode(checksumBytes).trim().split(/\s+/u)[0];
        if (checksum === undefined || !/^[a-f0-9]{64}$/u.test(checksum)) {
          return yield* new ZiggyUpdateUnavailable({
            message: "Ziggy update checksum is invalid",
            cause: undefined,
          });
        }
        return { version: "latest", executable, sha256: checksum };
      }),
  };
};

export const ZiggyReleaseClientLive = Layer.effect(
  ZiggyReleaseClient,
  Effect.gen(function* () {
    return makeZiggyReleaseClient(yield* HttpClient.HttpClient);
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
