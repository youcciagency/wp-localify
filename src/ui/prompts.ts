import path from "node:path";
import { confirm, intro, note, password, select, text } from "@clack/prompts";
import { exitCancelled } from "../errors.js";
import { canPrompt, requirePromptCapability } from "../ui/env.js";
import { MANAGED_SITES_ROOT } from "../paths.js";
import { normalizeNoTrailingSlash, nowIso, slugify, uniqueSiteKey } from "../text.js";
import { buildSiteConfig } from "../registry/schema.js";
import { setSecret, renameSiteSecrets } from "../secrets/keychain.js";
import type { Registry, SiteConfig } from "../types.js";

async function askText(
  message: string,
  initialValue: string,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  const answer = await text({ message, initialValue, validate });
  if (typeof answer === "symbol") await exitCancelled();
  return String(answer);
}

/** Masked secret prompt. Empty input keeps `initialValue` (used for edits). */
async function askSecret(message: string, initialValue: string): Promise<string> {
  if (!canPrompt()) return initialValue;
  const answer = await password({ message });
  if (typeof answer === "symbol") await exitCancelled();
  const typed = String(answer);
  return typed.length > 0 ? typed : initialValue;
}

export interface PromptSiteOptions {
  ftpPassword?: string;
  remoteDbPass?: string;
}

/**
 * Interactive site wizard. Secret fields are captured here and written to the
 * OS keychain; they never enter the registry file.
 */
export async function promptSiteConfig(
  existingSite: SiteConfig | null,
  registry: Registry,
  mode: "add" | "edit",
): Promise<SiteConfig> {
  requirePromptCapability(mode === "add" ? "site add" : "site edit");

  const base = buildSiteConfig((existingSite ?? {}) as Record<string, unknown>);
  const isEditMode = mode === "edit";
  const previousKey = existingSite?.key;

  if (!isEditMode) {
    intro("wp-localify site setup");
  }

  const siteName = await askText("Site name (for local domain)", base.siteName);

  let siteKey: string;
  if (isEditMode && existingSite) {
    const keyInput = await askText("Site key (CLI identifier)", existingSite.key, (value) => {
      const candidate = slugify(value);
      if (!candidate) return "Enter a valid key";
      const owner = registry.sites[candidate];
      if (owner && owner.key !== existingSite.key) return "Site key already exists";
      return undefined;
    });
    siteKey = slugify(keyInput);
  } else {
    const initialKey = uniqueSiteKey(slugify(siteName), registry.sites);
    const keyInput = await askText("Site key (CLI identifier)", initialKey, (value) => {
      const key = slugify(value);
      if (!key) return "Enter a valid key";
      if (registry.sites[key]) return "Site key already exists";
      return undefined;
    });
    siteKey = slugify(keyInput);
  }

  const initialTldOption = ["test", "local"].includes(base.localTld) ? base.localTld : "custom";
  const localTldSelect = await select({
    message: "Local TLD",
    initialValue: initialTldOption,
    options: [
      { label: ".test (recommended)", value: "test" },
      { label: ".local", value: "local" },
      { label: "Custom", value: "custom" },
    ],
  });
  if (typeof localTldSelect === "symbol") await exitCancelled();

  let localTld: string;
  if (localTldSelect === "custom") {
    localTld = await askText("Custom TLD (without dot)", base.localTld);
  } else {
    localTld = String(localTldSelect);
  }

  const localDomain = `${siteName}.${localTld}`;

  const downloadProtocol = await select({
    message: "File download protocol",
    initialValue: base.downloadProtocol,
    options: [
      { label: "SSH (rsync)", value: "ssh" },
      { label: "FTP (lftp)", value: "ftp" },
    ],
  });
  if (typeof downloadProtocol === "symbol") await exitCancelled();
  const protocol = downloadProtocol === "ftp" ? "ftp" : "ssh";

  let remoteSsh = base.remoteSsh || "";
  let remoteFtpHost = base.remoteFtpHost || "";
  let remoteFtpUser = base.remoteFtpUser || "";

  if (protocol === "ssh") {
    remoteSsh = await askText("Remote SSH target (user@host)", remoteSsh);
  } else {
    remoteFtpHost = await askText("FTP host", remoteFtpHost);
    remoteFtpUser = await askText("FTP username", remoteFtpUser);
  }

  const ftpPassword =
    protocol === "ftp"
      ? await askSecret(isEditMode ? "FTP password (leave empty to keep existing)" : "FTP password", "")
      : "";

  const remoteWpPath = await askText("Remote WordPress path", base.remoteWpPath);
  const remoteDomain = normalizeNoTrailingSlash(
    await askText("Live site URL (include scheme)", base.remoteDomain),
  );

  note("Remote database credentials", "Database");

  const remoteDbHost = await askText("Remote DB host", base.remoteDbHost);
  const remoteDbPort = await askText("Remote DB port", base.remoteDbPort);
  const remoteDbName = await askText("Remote DB name", base.remoteDbName);
  const remoteDbUser = await askText("Remote DB user", base.remoteDbUser);

  const dbAccessSelect = await select({
    message: "How can you reach the remote database?",
    initialValue: base.dbAccess,
    options: [
      { label: "Direct connection (host allows external MySQL)", value: "direct" },
      { label: "SSH tunnel (DB only reachable from the server itself)", value: "ssh-tunnel" },
    ],
  });
  if (typeof dbAccessSelect === "symbol") await exitCancelled();
  const dbAccess = dbAccessSelect === "ssh-tunnel" ? "ssh-tunnel" : "direct";

  // In tunnel mode the DB is reached through SSH, so a separate DB password
  // usually still exists — ask unless flags supplied it.
  const remoteDbPass = await askSecret(
    isEditMode ? "Remote DB password (leave empty to keep existing)" : "Remote DB password",
    "",
  );

  const engineSelect = await select({
    message: "Remote database engine",
    initialValue: base.dbEngine,
    options: [
      { label: "MariaDB (most shared hosts)", value: "mariadb" },
      { label: "MySQL 8 (host runs MySQL 8+)", value: "mysql" },
    ],
  });
  if (typeof engineSelect === "symbol") await exitCancelled();
  const dbEngine = engineSelect === "mysql" ? "mysql" : "mariadb";

  const parallelThreadsInput = await askText(
    "Parallel download threads (1-10)",
    String(base.parallelThreads),
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 10) {
        return "Enter a number between 1 and 10";
      }
      return undefined;
    },
  );
  const parallelThreads = Number.parseInt(parallelThreadsInput, 10);

  const managedDefaultWpPath = path.join(MANAGED_SITES_ROOT, siteKey, "wp");
  const initialLocalWpPath = isEditMode && existingSite ? existingSite.localWpPath : managedDefaultWpPath;
  const localWpPathInput = await askText("Local WordPress path", initialLocalWpPath);
  const localWpPath = path.resolve(localWpPathInput);
  const usingManagedWpPath = path.resolve(localWpPath) === path.resolve(managedDefaultWpPath);

  note(
    [
      `Site key: ${siteKey}`,
      `Local URL: https://${localDomain}`,
      `Protocol: ${protocol.toUpperCase()}`,
      protocol === "ssh" ? `Remote SSH: ${remoteSsh}` : `FTP: ${remoteFtpUser}@${remoteFtpHost}`,
      `Remote WP path: ${remoteWpPath}`,
      `Remote URL: ${remoteDomain}`,
      `Remote DB: ${remoteDbUser}@${remoteDbHost}:${remoteDbPort}/${remoteDbName} (${dbAccess})`,
      `DB engine: ${dbEngine}`,
      `Local WP path: ${localWpPath}`,
    ].join("\n"),
    "Summary",
  );

  const ok = await confirm({ message: "Save and continue?", initialValue: true });
  if (typeof ok === "symbol" || !ok) await exitCancelled("Aborted.");

  // Persist secrets to the OS keychain — never to sites.json.
  const justTyped: string[] = [];
  if (ftpPassword.length > 0) {
    await setSecret(siteKey, "remoteFtpPass", ftpPassword);
    justTyped.push("remoteFtpPass");
  }
  if (remoteDbPass.length > 0) {
    await setSecret(siteKey, "remoteDbPass", remoteDbPass);
    justTyped.push("remoteDbPass");
  }

  // Key renamed during an edit: re-key stored secrets so nothing is stranded.
  if (previousKey && previousKey !== siteKey) {
    await renameSiteSecrets(previousKey, siteKey, { skip: justTyped });
  }

  return buildSiteConfig({
    ...(existingSite as unknown as Record<string, unknown> | null),
    key: siteKey,
    siteName,
    localTld,
    localDomain,
    downloadProtocol: protocol,
    remoteSsh,
    remoteFtpHost,
    remoteFtpUser,
    remoteFtpPass: "",
    remoteWpPath,
    remoteDomain,
    remoteDbHost,
    remoteDbPort,
    remoteDbName,
    remoteDbUser,
    remoteDbPass: "",
    dbEngine,
    dbAccess,
    parallelThreads,
    localWpPath,
    usingManagedWpPath,
    createdAt: existingSite?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
}
