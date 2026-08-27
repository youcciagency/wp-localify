import path from "node:path";
import { MANAGED_SITES_ROOT } from "../paths.js";
import { nowIso, normalizeNoTrailingSlash, slugify, uniqueSiteKey } from "../text.js";
import {
  SECRET_FIELDS,
  type DownloadProtocol,
  type Registry,
  type SiteConfig,
  type GatewaySettings,
} from "../types.js";
import { setSecret } from "../secrets/keychain.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function defaultGatewaySettings(): GatewaySettings {
  return { httpPort: 80, httpsPort: 443 };
}

/** Derive the canonical fields from a partial site shape (port of defaultSiteConfig). */
export function buildSiteConfig(partial: Record<string, unknown> = {}): SiteConfig {
  const key = slugify(String(partial.key || partial.siteName || "site"));
  const siteName = String(partial.siteName || key);
  const localTld = String(partial.localTld || "test");
  const localDomain = `${siteName}.${localTld}`;
  const storageRoot = path.join(MANAGED_SITES_ROOT, key);
  const defaultWpPath = path.join(storageRoot, "wp");
  const parsedThreads = Number(partial.parallelThreads || 4);
  const parallelThreads =
    Number.isInteger(parsedThreads) && parsedThreads >= 1 && parsedThreads <= 10 ? parsedThreads : 4;
  const localWpPath = partial.localWpPath ? path.resolve(String(partial.localWpPath)) : defaultWpPath;

  const usingManagedWpPath =
    typeof partial.usingManagedWpPath === "boolean"
      ? partial.usingManagedWpPath
      : path.resolve(localWpPath) === path.resolve(defaultWpPath);

  const rawProtocol = String(partial.downloadProtocol || "ssh");
  const downloadProtocol: DownloadProtocol = rawProtocol === "ftp" ? "ftp" : "ssh";
  const rawEngine = String(partial.dbEngine || "mariadb");
  const dbEngine = rawEngine === "mysql" ? "mysql" : "mariadb";
  const rawAccess = String(partial.dbAccess || "direct");
  const dbAccess = rawAccess === "ssh-tunnel" ? "ssh-tunnel" : "direct";

  return {
    key,
    siteName,
    localTld,
    localDomain,
    downloadProtocol,
    remoteSsh: String(partial.remoteSsh ?? ""),
    remoteFtpHost: String(partial.remoteFtpHost ?? ""),
    remoteFtpUser: String(partial.remoteFtpUser ?? ""),
    remoteFtpPass: "",
    remoteWpPath: String(partial.remoteWpPath ?? "/var/www/html"),
    remoteDomain: normalizeNoTrailingSlash(String(partial.remoteDomain ?? "")),

    remoteDbHost: String(partial.remoteDbHost ?? "localhost"),
    remoteDbPort: String(partial.remoteDbPort ?? "3306"),
    remoteDbName: String(partial.remoteDbName ?? "wordpress"),
    remoteDbUser: String(partial.remoteDbUser ?? "root"),
    remoteDbPass: "",

    localDbName: String(partial.localDbName ?? "wordpress"),
    localDbUser: String(partial.localDbUser ?? "wp"),
    localDbPass: "",
    localDbRootPass: "",

    dbEngine,
    dbAccess,
    parallelThreads,
    localWpPath,
    usingManagedWpPath,
    dockerProject:
      typeof partial.dockerProject === "string" && partial.dockerProject.length > 0
        ? partial.dockerProject
        : `wp_localify_${key.replace(/-/g, "_")}`,
    createdAt: typeof partial.createdAt === "string" ? partial.createdAt : nowIso(),
    updatedAt: nowIso(),
  };
}

/** Re-normalize an existing site entry, preserving createdAt. */
export function normalizeSiteEntry(rawKey: string, value: Record<string, unknown>): SiteConfig {
  const merged = { ...value, key: typeof value.key === "string" && value.key ? value.key : rawKey };
  const site = buildSiteConfig(merged);
  site.createdAt = typeof value.createdAt === "string" && value.createdAt ? value.createdAt : nowIso();
  return site;
}

const PLACEHOLDER_SSH = "user@example.com";
const PLACEHOLDER_FTP_HOST = "ftp.example.com";
const PLACEHOLDER_FTP_USER = "ftpuser";

/** Field list matching the ORIGINAL legacy `.wp-localize.json` contract. */
const LEGACY_REQUIRED_FIELDS = [
  "siteName",
  "localTld",
  "downloadProtocol",
  "remoteWpPath",
  "remoteDomain",
  "remoteDbHost",
  "remoteDbPort",
  "remoteDbName",
  "remoteDbUser",
] as const;

export function isLegacyConfigComplete(raw: Record<string, unknown>): boolean {
  for (const field of LEGACY_REQUIRED_FIELDS) {
    if (!raw[field] && raw[field] !== "") return false;
  }
  return true;
}

/**
 * Completeness check over non-secret fields only — passwords live in the OS
 * keychain now and are optional.
 */
export function isSiteConfigComplete(site: Partial<SiteConfig> | Record<string, unknown>): boolean {
  const record = asRecord(site);
  const required = [
    "key",
    "siteName",
    "localTld",
    "localDomain",
    "downloadProtocol",
    "remoteWpPath",
    "remoteDomain",
    "remoteDbHost",
    "remoteDbPort",
    "remoteDbName",
    "remoteDbUser",
    "localWpPath",
  ];

  for (const field of required) {
    if (!record[field] && record[field] !== "") {
      return false;
    }
  }

  if (record.downloadProtocol === "ssh") {
    const remoteSsh = String(record.remoteSsh ?? "");
    if (!remoteSsh || remoteSsh === PLACEHOLDER_SSH) return false;
  }

  if (record.downloadProtocol === "ftp") {
    const host = String(record.remoteFtpHost ?? "");
    const user = String(record.remoteFtpUser ?? "");
    if (!host || host === PLACEHOLDER_FTP_HOST) return false;
    if (!user || user === PLACEHOLDER_FTP_USER) return false;
  }

  return true;
}

/**
 * Move any plaintext secret fields found in a raw site object into the OS
 * keychain, returning the object with those fields blanked.
 */
async function extractSecretsToKeychain(
  siteKey: string,
  raw: Record<string, unknown>,
  migratedKeys: string[],
): Promise<Record<string, unknown>> {
  const cleaned = { ...raw };
  for (const field of SECRET_FIELDS) {
    const value = cleaned[field];
    if (typeof value === "string" && value.length > 0) {
      await setSecret(siteKey, field, value);
      migratedKeys.push(`${siteKey}.${field}`);
    }
    cleaned[field] = "";
  }
  return cleaned;
}

export interface MigrationResult {
  registry: Registry;
  /** Human-readable notes about what migration did (secrets moved, etc.). */
  notes: string[];
  changed: boolean;
}

export async function migrateRawRegistry(raw: unknown): Promise<MigrationResult> {
  const notes: string[] = [];
  const source = asRecord(raw);
  const sites: Record<string, SiteConfig> = {};
  const migratedKeys: string[] = [];

  const sourceSites = asRecord(source.sites);
  for (const [rawKey, value] of Object.entries(sourceSites)) {
    const record = asRecord(value);
    if (Object.keys(record).length === 0) continue;
    let site = normalizeSiteEntry(rawKey, record);
    const hadSecrets = SECRET_FIELDS.some(
      (field) => typeof record[field] === "string" && (record[field] as string).length > 0,
    );
    if (hadSecrets) {
      const cleaned = await extractSecretsToKeychain(site.key, { ...record }, migratedKeys);
      site = normalizeSiteEntry(site.key, cleaned);
    }
    sites[site.key] = site;
  }

  let activeSite: string | null =
    typeof source.activeSite === "string" && sites[source.activeSite] ? source.activeSite : null;
  if (!activeSite) {
    const keys = Object.keys(sites);
    activeSite = keys.length > 0 ? keys[0]! : null;
  }

  const settings: GatewaySettings = { ...defaultGatewaySettings(), ...asRecord(source.settings) };

  const registry = RegistryPassthrough({
    version: 2,
    activeSite,
    settings,
    sites,
  });

  if (migratedKeys.length > 0) {
    notes.push(`Moved ${migratedKeys.length} secret(s) into the OS keychain.`);
  }

  return { registry, notes, changed: notes.length > 0 };
}

function RegistryPassthrough(input: {
  version: number;
  activeSite: string | null;
  settings: GatewaySettings;
  sites: Record<string, SiteConfig>;
  [key: string]: unknown;
}): Registry {
  return input as unknown as Registry;
}

/** Migrate a legacy single-site `.wp-localize.json` config into the registry. */
export async function migrateLegacyConfig(
  legacy: unknown,
  registry: Registry,
): Promise<{ registry: Registry; migratedKey: string | null }> {
  const legacyRecord = asRecord(legacy);
  if (!isLegacyConfigComplete(legacyRecord)) {
    return { registry, migratedKey: null };
  }

  const base = buildSiteConfig(legacyRecord);
  const key = uniqueSiteKey(base.key || base.siteName, registry.sites);

  const withSecrets = { ...legacyRecord };
  for (const field of SECRET_FIELDS) {
    const value = withSecrets[field];
    if (typeof value === "string" && value.length > 0) {
      await setSecret(key, field, value);
    }
    withSecrets[field] = "";
  }

  const migrated = normalizeSiteEntry(key, {
    ...withSecrets,
    key,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  registry.sites[key] = migrated;
  registry.activeSite = key;
  return { registry, migratedKey: key };
}
