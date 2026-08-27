import { chmod } from "node:fs/promises";
import { note } from "@clack/prompts";
import { atomicWriteText, ensureDir, pathExists, readTextIfExists } from "../fsutils.js";
import { checkDependencies } from "../system/deps.js";
import { addHostsEntry, hasHostsEntry, type SudoHooks } from "../system/hosts.js";
import { ensureSiteCert } from "../system/certs.js";
import { ensureGatewayInfrastructure } from "../docker/gateway.js";
import { runSiteCompose, runSiteComposeQuiet } from "../docker/compose.js";
import { composeYaml, siteEnvContent, siteNginxConf } from "../docker/templates.js";
import { dotenvQuote } from "../text.js";
import { buildSiteContext } from "./context.js";
import { resolveSiteSecrets } from "../secrets/keychain.js";
import { startSpinner } from "../ui/spinner.js";
import type { GatewaySettings, SiteConfig, SiteContext } from "../types.js";

export { buildSiteContext };

export async function ensureSiteDirs(ctx: SiteContext): Promise<void> {
  await ensureDir(ctx.dirs.storageRoot);
  await ensureDir(ctx.dirs.wp);
  await ensureDir(ctx.dirs.db);
  await ensureDir(ctx.dirs.certs);
  await ensureDir(ctx.dirs.docker);
}

async function writeSiteEnv(ctx: SiteContext): Promise<void> {
  const secrets = await resolveSiteSecrets(ctx.site.key);
  const content = siteEnvContent(
    {
      localDbName: ctx.site.localDbName,
      localDbUser: ctx.site.localDbUser,
      localDbPass: secrets.localDbPass,
      localDbRootPass: secrets.localDbRootPass,
    },
    dotenvQuote,
  );
  const current = await readTextIfExists(ctx.files.envFile);
  if (current !== content) {
    await atomicWriteText(ctx.files.envFile, content);
    await chmod(ctx.files.envFile, 0o600).catch(() => {});
  }
}

export interface SiteArtifactOptions extends SudoHooks {
  onProgress?: (message: string) => void;
  checkDependencies?: boolean;
}

/**
 * Generate every per-site artifact: compose file, chmod-600 .env (DB secrets
 * never appear in the compose yaml), nginx conf, hosts entry, cert, and a
 * gateway reload.
 */
export async function writeSiteArtifacts(
  site: SiteConfig,
  settings: GatewaySettings,
  options: SiteArtifactOptions = {},
): Promise<SiteContext> {
  const ctx = buildSiteContext(site);
  const reportProgress = options.onProgress ?? (() => {});

  if (options.checkDependencies !== false) {
    reportProgress("Checking dependencies (Docker, mkcert)...");
    await checkDependencies(site, {
      needsMkcert: true,
      needsMysqldump: false,
      needsRsync: false,
      needsLftp: false,
    });
  }

  reportProgress("Preparing site directories...");
  await ensureSiteDirs(ctx);

  reportProgress("Writing Docker, env, and gateway config files...");
  await atomicWriteText(ctx.files.compose, composeYaml(site, ctx));
  await writeSiteEnv(ctx);
  await atomicWriteText(ctx.files.nginxConf, siteNginxConf(site, ctx));

  reportProgress(`Updating hosts entry for ${site.localDomain}...`);
  await addHostsEntry(site.localDomain, {
    onBeforeSudoPrompt: options.onBeforeSudoPrompt,
    onAfterSudoPrompt: options.onAfterSudoPrompt,
  });

  reportProgress(`Ensuring HTTPS certificate for ${site.localDomain}...`);
  await ensureSiteCert(site, ctx);

  reportProgress("Syncing shared gateway (reload, not recreate)...");
  await ensureGatewayInfrastructure(settings, { quiet: true });

  reportProgress("Initialization steps finished.");
  return ctx;
}

export async function ensureSiteInitialized(
  site: SiteConfig,
  ctx: SiteContext,
  settings: GatewaySettings,
  options: SiteArtifactOptions & { force?: boolean } = {},
): Promise<void> {
  const composeExists = await pathExists(ctx.files.compose);
  if (composeExists && options.force !== true) {
    await atomicWriteText(ctx.files.compose, composeYaml(site, ctx));
    await writeSiteEnv(ctx);
    await atomicWriteText(ctx.files.nginxConf, siteNginxConf(site, ctx));
    await ensureGatewayInfrastructure(settings, { quiet: true });
    return;
  }

  await writeSiteArtifacts(site, settings, options);
}

export async function upSite(site: SiteConfig, ctx: SiteContext, settings: GatewaySettings): Promise<void> {
  await ensureSiteInitialized(site, ctx, settings, {});
  await runSiteCompose(ctx, ["up", "-d"]);
}

export async function downSite(ctx: SiteContext, purge = false): Promise<void> {
  if (!(await pathExists(ctx.files.compose))) return;
  const extra = purge ? ["--volumes"] : [];
  await runSiteCompose(ctx, ["down", "--remove-orphans", ...extra]);
}

export async function getRunningServices(ctx: SiteContext): Promise<string[]> {
  if (!(await pathExists(ctx.files.compose))) return [];

  const result = await runSiteComposeQuiet(ctx, ["ps", "--services", "--status", "running"]);
  if (!result.ok) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function isServiceRunning(ctx: SiteContext, serviceName: string): Promise<boolean> {
  const running = await getRunningServices(ctx);
  return running.includes(serviceName);
}

export interface CollectedSiteStatus {
  key: string;
  domain: string;
  protocol: string;
  initialized: boolean;
  running: boolean;
  runningServices: string[];
  wpFiles: boolean;
  dbDump: boolean;
  hostsEntry: boolean | "unknown";
  localWpPath: string;
  dockerProject: string;
  updatedAt: string;
}

export async function collectSiteStatus(site: SiteConfig): Promise<CollectedSiteStatus> {
  const ctx = buildSiteContext(site);
  const [composeExists, wpFiles, dumpGz, dumpSql, runningServices] = await Promise.all([
    pathExists(ctx.files.compose),
    pathExists(`${ctx.dirs.wp}/wp-config.php`),
    pathExists(ctx.files.dumpGz),
    pathExists(ctx.files.dumpSql),
    getRunningServices(ctx),
  ]);

  let hostsEntry: boolean | "unknown" = "unknown";
  try {
    hostsEntry = await hasHostsEntry(site.localDomain);
  } catch {
    hostsEntry = "unknown";
  }

  return {
    key: site.key,
    domain: site.localDomain,
    protocol: site.downloadProtocol,
    initialized: composeExists,
    running: runningServices.length > 0,
    runningServices,
    wpFiles,
    dbDump: dumpGz || dumpSql,
    hostsEntry,
    localWpPath: site.localWpPath,
    dockerProject: ctx.projectName,
    updatedAt: site.updatedAt,
  };
}

export interface SudoSpinnerHooksOptions {
  spinner: ReturnType<typeof startSpinner>;
  resumeMessage: string;
}

export function createSudoSpinnerHooks(options: SudoSpinnerHooksOptions): SudoHooks {
  const { spinner, resumeMessage } = options;
  return {
    onBeforeSudoPrompt: () => {
      spinner.stop("Awaiting sudo authentication...");
      note("Enter your password in the terminal prompt to continue.", "Sudo Required");
    },
    onAfterSudoPrompt: () => {
      spinner.start(resumeMessage);
    },
  };
}
