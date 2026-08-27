import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Must run before ANY src module is imported: paths.ts freezes BASE_HOME at
// import time from this env var.
process.env.WP_LOCALIFY_HOME = mkdtempSync(path.join(tmpdir(), "wp-localify-it-"));
process.env.WP_LOCALIFY_NO_UPDATE_CHECK = "1";
