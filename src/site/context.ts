import path from "node:path";
import { GATEWAY_CONF_DIR, MANAGED_SITES_ROOT } from "../paths.js";
import type { SiteConfig, SiteContext } from "../types.js";

export function buildSiteContext(site: SiteConfig): SiteContext {
  const storageRoot = path.join(MANAGED_SITES_ROOT, site.key);
  const wp = path.resolve(site.localWpPath);
  const db = path.join(storageRoot, "db");
  const certs = path.join(storageRoot, "certs");
  const docker = path.join(storageRoot, "docker");

  return {
    site,
    projectName: site.dockerProject || `wp_localify_${site.key.replace(/-/g, "_")}`,
    wordpressAlias: `wp_${site.key.replace(/-/g, "_")}`,
    dirs: {
      storageRoot,
      wp,
      db,
      certs,
      docker,
    },
    files: {
      compose: path.join(docker, "docker-compose.yml"),
      envFile: path.join(docker, ".env"),
      dumpGz: path.join(db, "dump.sql.gz"),
      dumpSql: path.join(db, "dump.sql"),
      certPem: path.join(certs, "cert.pem"),
      certKey: path.join(certs, "key.pem"),
      nginxConf: path.join(GATEWAY_CONF_DIR, `${site.key}.conf`),
      snapshotsDir: path.join(storageRoot, "snapshots"),
    },
  };
}
