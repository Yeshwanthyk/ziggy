import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// In-process tests open sessions, which unpack required extensions under ZIGGY_HOME.
// Point it at a throwaway directory so no test ever writes to the real ~/.ziggy.
process.env.ZIGGY_HOME ??= mkdtempSync(join(tmpdir(), "ziggy-test-home-"));
