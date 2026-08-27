import { run } from "../exec.js";
import { pathExists } from "../fsutils.js";
import type { SiteConfig, SiteContext } from "../types.js";

export async function ensureSiteCert(site: SiteConfig, ctx: SiteContext): Promise<void> {
  if ((await pathExists(ctx.files.certPem)) && (await pathExists(ctx.files.certKey))) {
    return;
  }

  // -install may fail in headless environments; the cert itself can still be issued.
  await run("mkcert", ["-install"]).catch(() => {});
  await run("mkcert", ["-cert-file", ctx.files.certPem, "-key-file", ctx.files.certKey, site.localDomain]);
}
