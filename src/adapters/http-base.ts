import { HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * Send a client's requests for `origin` to `base` instead, so a chat API can be pointed at a fake
 * server. Other URLs (file downloads, CDNs) are left alone.
 */
export const withBaseUrl = (
  client: HttpClient.HttpClient,
  origin: string,
  base: string | undefined,
): HttpClient.HttpClient =>
  base === undefined || base === origin
    ? client
    : HttpClient.mapRequest(client, (request) =>
        request.url === origin || request.url.startsWith(`${origin}/`)
          ? HttpClientRequest.setUrl(request, `${base}${request.url.slice(origin.length)}`)
          : request,
      );
