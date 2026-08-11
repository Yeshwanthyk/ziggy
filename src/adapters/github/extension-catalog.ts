import { Context, Effect, Layer, Predicate } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  ExtensionCatalogUnavailable,
  type GitHubExtensionCatalogEntry,
} from "../../domain/extension-catalog";

export interface ExtensionArchiveClientShape {
  readonly download: (
    entry: GitHubExtensionCatalogEntry,
  ) => Effect.Effect<Uint8Array, ExtensionCatalogUnavailable>;
}

export class ExtensionArchiveClient extends Context.Service<
  ExtensionArchiveClient,
  ExtensionArchiveClientShape
>()("ziggy/ExtensionArchiveClient") {}

export const makeExtensionArchiveClient = (
  client: HttpClient.HttpClient,
): ExtensionArchiveClientShape => ({
  download: (entry) =>
    client.execute(HttpClientRequest.get(entry.archiveUrl)).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.arrayBuffer.pipe(
              Effect.map((body) => new Uint8Array(body)),
              Effect.mapError(
                (cause) =>
                  new ExtensionCatalogUnavailable({
                    operation: "download extension archive",
                    message: `could not read downloaded extension '${entry.id}'`,
                    cause,
                  }),
              ),
            )
          : Effect.fail(
              new ExtensionCatalogUnavailable({
                operation: "download extension archive",
                message: `GitHub returned HTTP ${response.status} for ${entry.id}`,
                cause: undefined,
              }),
            ),
      ),
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "ExtensionCatalogUnavailable")
          ? cause
          : new ExtensionCatalogUnavailable({
              operation: "download extension archive",
              message: `could not download approved extension '${entry.id}'`,
              cause,
            }),
      ),
    ),
});

export const ExtensionArchiveClientLive = Layer.effect(
  ExtensionArchiveClient,
  Effect.gen(function* () {
    return makeExtensionArchiveClient(yield* HttpClient.HttpClient);
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
