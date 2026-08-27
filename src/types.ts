export type DownloadProtocol = "ssh" | "ftp";
export type DbEngine = "mariadb" | "mysql";
export type DbAccess = "direct" | "ssh-tunnel";

export interface GatewaySettings {
  httpPort: number;
  httpsPort: number;
}

/**
 * Secret fields are never persisted in the registry. They live in the OS
 * keychain; the registry keeps the keys with empty-string values so the
 * on-disk shape stays stable.
 */
export const SECRET_FIELDS = ["remoteDbPass", "remoteFtpPass", "localDbPass", "localDbRootPass"] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export interface SiteSecrets {
  remoteDbPass: string;
  remoteFtpPass: string;
  localDbPass: string;
  localDbRootPass: string;
}

export interface SiteConfig {
  key: string;
  siteName: string;
  localTld: string;
  localDomain: string;
  downloadProtocol: DownloadProtocol;
  remoteSsh: string;
  remoteFtpHost: string;
  remoteFtpUser: string;
  remoteFtpPass: string;
  remoteWpPath: string;
  remoteDomain: string;

  remoteDbHost: string;
  remoteDbPort: string;
  remoteDbName: string;
  remoteDbUser: string;
  remoteDbPass: string;

  localDbName: string;
  localDbUser: string;
  localDbPass: string;
  localDbRootPass: string;

  dbEngine: DbEngine;
  dbAccess: DbAccess;
  parallelThreads: number;

  localWpPath: string;
  usingManagedWpPath: boolean;

  dockerProject: string;
  createdAt: string;
  updatedAt: string;
}

export interface Registry {
  version: number;
  activeSite: string | null;
  settings: GatewaySettings;
  sites: Record<string, SiteConfig>;
}

export interface SiteContext {
  site: SiteConfig;
  projectName: string;
  wordpressAlias: string;
  dirs: {
    storageRoot: string;
    wp: string;
    db: string;
    certs: string;
    docker: string;
  };
  files: {
    compose: string;
    envFile: string;
    dumpGz: string;
    dumpSql: string;
    certPem: string;
    certKey: string;
    nginxConf: string;
    snapshotsDir: string;
  };
}

/** Runtime guard used wherever raw user/file data enters the pipeline. */
export function asDownloadProtocol(value: unknown): DownloadProtocol {
  return value === "ftp" ? "ftp" : "ssh";
}

export function asDbEngine(value: unknown): DbEngine {
  return value === "mysql" ? "mysql" : "mariadb";
}

export function asDbAccess(value: unknown): DbAccess {
  return value === "ssh-tunnel" ? "ssh-tunnel" : "direct";
}
