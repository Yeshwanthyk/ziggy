/* oxlint-disable ziggy-effect/no-native-promise-ownership -- boundary: Node filesystem APIs are Promise-only */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- boundary: Node rejects through native exceptions */
/* oxlint-disable ziggy-effect/no-error-constructor -- boundary: Node rejects through native Error values */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

/** Raw Node boundary. Provider composition wraps this Promise immediately with Effect.tryPromise. */
export async function readProfileSoul(profilePath: string): Promise<string> {
  const path = join(profilePath, "SOUL.md");
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`expected regular SOUL.md at ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
