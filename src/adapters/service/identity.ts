import { createHash } from "node:crypto";

export const serviceIdentitySuffix = (profilePath: string): string =>
  createHash("sha256").update(profilePath).digest("hex").slice(0, 16);
