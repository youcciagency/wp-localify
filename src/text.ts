export function normalizeNoTrailingSlash(url: string): string {
  return String(url || "").replace(/\/+$/, "");
}

export function slugify(input: string): string {
  const slug = String(input || "site")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "site";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function escapeRegex(input: string): string {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shQuote(input: string): string {
  return `'${String(input).replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for use inside a POSIX double-quoted string (sh -lc contexts). */
export function posixDoubleQuote(input: string): string {
  return `"${String(input).replace(/["\\$`]/g, "\\$&")}"`;
}

export function yamlQuote(input: string): string {
  return `'${String(input).replace(/'/g, "''")}'`;
}

/** Quote a value for a docker-compose .env file (double-quoted dotenv style). */
export function dotenvQuote(input: string): string {
  return `"${String(input).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function uniqueSiteKey(seed: string, sites: Record<string, unknown>): string {
  const base = slugify(seed || "site");
  let key = base;
  let index = 2;
  while (sites[key]) {
    key = `${base}-${index}`;
    index += 1;
  }
  return key;
}

/**
 * Build the grep -E pattern used to detect a hosts-file entry for a domain.
 * Uses POSIX character classes because the consumer is `grep -E`, not JS.
 */
export function buildHostsEntryGrepPattern(domain: string): string {
  return `^[[:space:]]*127\\.0\\.0\\.1[[:space:]]+${escapeRegex(domain)}([[:space:]]|$)`;
}
