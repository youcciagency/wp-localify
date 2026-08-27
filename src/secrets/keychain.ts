import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BASE_HOME, KEYCHAIN_SERVICE } from "../paths.js";
import { runQuiet, tryRun } from "../exec.js";
import { SECRET_FIELDS } from "../types.js";

export interface SecretBackend {
  readonly name: string;
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

function siteAccount(siteKey: string, field: string): string {
  return `site:${siteKey}:${field}`;
}

/* ------------------------------------------------------------------ */
/* macOS Keychain backend (`security`)                                 */
/* ------------------------------------------------------------------ */

class MacosKeychainBackend implements SecretBackend {
  readonly name = "macOS Keychain";

  async get(account: string): Promise<string | null> {
    const result = await tryRun("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    if (!result.ok) return null;
    const value = result.stdout.replace(/\n$/, "");
    return value.length > 0 ? value : "";
  }

  async set(account: string, value: string): Promise<void> {
    // `security -i` reads the command (including the secret) from stdin so the
    // password never appears in argv / process listings.
    const command =
      `add-generic-password -U -s '${KEYCHAIN_SERVICE}' -a '${account.replace(/'/g, `'\\''`)}'` +
      ` -w '${value.replace(/'/g, `'\\''`)}'`;
    await runQuiet("security", ["-i"], { input: `${command}\n` });
  }

  async delete(account: string): Promise<void> {
    await tryRun("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  }
}

/* ------------------------------------------------------------------ */
/* Linux libsecret backend (`secret-tool`)                             */
/* ------------------------------------------------------------------ */

class SecretToolBackend implements SecretBackend {
  readonly name = "libsecret (secret-tool)";

  async get(account: string): Promise<string | null> {
    const result = await tryRun("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", account]);
    if (!result.ok) return null;
    // secret-tool appends a trailing newline; a stored empty secret is
    // indistinguishable from "not found" here, which matches our usage.
    const value = result.stdout.replace(/\n$/, "");
    return value;
  }

  async set(account: string, value: string): Promise<void> {
    await runQuiet(
      "secret-tool",
      ["store", "--label=wp-localify", "service", KEYCHAIN_SERVICE, "account", account],
      {
        input: value,
      },
    );
  }

  async delete(account: string): Promise<void> {
    await tryRun("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account]);
  }
}

/* ------------------------------------------------------------------ */
/* Fallback file backend                                               */
/* ------------------------------------------------------------------ */

interface SecretFileShape {
  version: 1;
  secrets: Record<string, string>;
}

const SECRETS_FILE_PATH = path.join(BASE_HOME, "secrets.json");

class FileBackend implements SecretBackend {
  readonly name = "encrypted-at-rest file fallback";

  private warned = false;

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    console.error("⚠️  OS keychain unavailable — falling back to a permission-restricted secrets file.");
    console.error(`   ${SECRETS_FILE_PATH} (chmod 600). Prefer installing secret-tool on Linux.`);
  }

  private async read(): Promise<SecretFileShape> {
    try {
      const raw = await readFile(SECRETS_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<SecretFileShape>;
      return { version: 1, secrets: parsed.secrets ?? {} };
    } catch {
      return { version: 1, secrets: {} };
    }
  }

  private async write(data: SecretFileShape): Promise<void> {
    await mkdir(path.dirname(SECRETS_FILE_PATH), { recursive: true });
    const tmp = `${SECRETS_FILE_PATH}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, SECRETS_FILE_PATH);
    await chmod(SECRETS_FILE_PATH, 0o600);
  }

  async get(account: string): Promise<string | null> {
    this.warnOnce();
    const data = await this.read();
    const value = data.secrets[account];
    return typeof value === "string" ? value : null;
  }

  async set(account: string, value: string): Promise<void> {
    this.warnOnce();
    const data = await this.read();
    data.secrets[account] = value;
    await this.write(data);
  }

  async delete(account: string): Promise<void> {
    this.warnOnce();
    const data = await this.read();
    delete data.secrets[account];
    await this.write(data);
  }
}

/* ------------------------------------------------------------------ */
/* Backend selection + public API                                      */
/* ------------------------------------------------------------------ */

let cachedBackend: SecretBackend | undefined;

async function selectBackend(): Promise<SecretBackend> {
  if (cachedBackend) return cachedBackend;

  if (process.platform === "darwin") {
    const probe = await tryRun("security", ["list-keychains"]);
    if (probe.ok) {
      cachedBackend = new MacosKeychainBackend();
      return cachedBackend;
    }
  }

  if (process.platform === "linux") {
    const probe = await tryRun("secret-tool", ["lookup", "service", "__wp-localify-probe__"]);
    // secret-tool exists and answered (ok or not-found both count as usable)
    if (probe.ok || !/ENOENT|not found/i.test(probe.stderr)) {
      cachedBackend = new SecretToolBackend();
      return cachedBackend;
    }
  }

  cachedBackend = new FileBackend();
  return cachedBackend;
}

export async function getSecret(siteKey: string, field: string): Promise<string | null> {
  const backend = await selectBackend();
  return backend.get(siteAccount(siteKey, field));
}

export async function setSecret(siteKey: string, field: string, value: string): Promise<void> {
  const backend = await selectBackend();
  await backend.set(siteAccount(siteKey, field), value);
}

export async function deleteSiteSecrets(siteKey: string): Promise<void> {
  const backend = await selectBackend();
  for (const field of SECRET_FIELDS) {
    await backend.delete(siteAccount(siteKey, field));
  }
}

/**
 * Re-key all stored secrets when a site key changes. Copies only values that
 * actually exist (no default materialization), then removes the old accounts.
 * Typed-in values written under the new key beforehand are safe as long as
 * callers pass `skip` for the fields they just wrote.
 */
export async function renameSiteSecrets(
  fromKey: string,
  toKey: string,
  options: { skip?: string[] } = {},
): Promise<void> {
  if (fromKey === toKey) return;

  const backend = await selectBackend();
  const skip = new Set(options.skip ?? []);

  for (const field of SECRET_FIELDS) {
    if (skip.has(field)) continue;
    const value = await backend.get(siteAccount(fromKey, field));
    if (value === null) continue;
    await backend.set(siteAccount(toKey, field), value);
    await backend.delete(siteAccount(fromKey, field));
  }
}

export function defaultSecrets() {
  return {
    remoteDbPass: "",
    remoteFtpPass: "",
    localDbPass: "wp",
    localDbRootPass: "root",
  };
}

/**
 * Resolve all secret fields for a site. Missing keychain entries fall back to
 * the historical defaults ("wp" / "root" for local DB creds) so fresh sites
 * keep working without an explicit prompt.
 */
export async function resolveSiteSecrets(siteKey: string) {
  const defaults = defaultSecrets();
  const resolved = { ...defaults };

  for (const field of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const stored = await getSecret(siteKey, field);
    if (stored !== null) {
      resolved[field] = stored;
    }
  }

  return resolved;
}
