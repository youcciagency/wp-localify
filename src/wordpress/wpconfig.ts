import { readFile, writeFile } from "node:fs/promises";
import { pathExists } from "../fsutils.js";
import type { SiteContext } from "../types.js";

/** Pure: insert a marked PHP block if its marker comment is missing. */
export function insertPhpBlockIfMissing(content: string, marker: string, block: string): string {
  if (content.includes(marker)) return content;

  const normalizedBlock = `${block.trim()}\n`;
  if (content.includes("<?php")) {
    return content.replace(/<\?php/, `<?php\n\n${normalizedBlock}`);
  }

  return `${normalizedBlock}${content}`;
}

const DB_CONSTANTS = ["DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST"] as const;

/** Pure: guard each `define( 'DB_*', ... )` with a `! defined()` check. */
export function wrapDbDefines(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    let replaced = false;

    for (const constantName of DB_CONSTANTS) {
      const regex = new RegExp(`^\\s*define\\s*\\(\\s*['"]${constantName}['"]\\s*,`);
      if (!regex.test(line)) continue;

      const previousLine = output.length > 0 ? (output[output.length - 1] ?? "") : "";
      if (previousLine.includes(`if ( ! defined( '${constantName}' ) )`)) {
        output.push(line);
      } else {
        output.push(`if ( ! defined( '${constantName}' ) ) {`);
        output.push(`  ${line.trim()}`);
        output.push("}");
      }

      replaced = true;
      break;
    }

    if (!replaced) {
      output.push(line);
    }
  }

  return output.join("\n");
}

const DOCKER_DB_BLOCK = `// BEGIN DOCKER LOCAL DB
if (getenv('WORDPRESS_DB_HOST') && !defined('DB_HOST')) {
  define('DB_HOST', getenv('WORDPRESS_DB_HOST'));
}
if (getenv('WORDPRESS_DB_NAME') && !defined('DB_NAME')) {
  define('DB_NAME', getenv('WORDPRESS_DB_NAME'));
}
if (getenv('WORDPRESS_DB_USER') && !defined('DB_USER')) {
  define('DB_USER', getenv('WORDPRESS_DB_USER'));
}
if (getenv('WORDPRESS_DB_PASSWORD') && !defined('DB_PASSWORD')) {
  define('DB_PASSWORD', getenv('WORDPRESS_DB_PASSWORD'));
}
// END DOCKER LOCAL DB`;

const HTTPS_BLOCK = `// BEGIN DOCKER LOCAL HTTPS
if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
  $_SERVER['HTTPS'] = 'on';
}
// END DOCKER LOCAL HTTPS`;

export function wpConfigPathFor(ctx: SiteContext): string {
  return `${ctx.dirs.wp}/wp-config.php`;
}

/**
 * Patch wp-config.php so the container-provided env vars win only when the
 * file doesn't already define them, and so X-Forwarded-Proto https is honored.
 */
export async function patchWpConfigSafe(ctx: SiteContext): Promise<void> {
  const wpConfigPath = wpConfigPathFor(ctx);
  if (!(await pathExists(wpConfigPath))) return;

  const content = await readFile(wpConfigPath, "utf8");
  let updated = insertPhpBlockIfMissing(content, "BEGIN DOCKER LOCAL DB", DOCKER_DB_BLOCK);
  updated = insertPhpBlockIfMissing(updated, "BEGIN DOCKER LOCAL HTTPS", HTTPS_BLOCK);
  updated = wrapDbDefines(updated);

  if (updated !== content) {
    await writeFile(wpConfigPath, updated, "utf8");
  }
}

/** Pure: replace an existing `$table_prefix` assignment or inject our marked block. */
export function applyTablePrefix(content: string, tablePrefix: string): string | null {
  const escapedPrefix = String(tablePrefix).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const assignmentRegex = /^[ \t]*\$table_prefix[ \t]*=[ \t]*.*;[ \t]*$/m;

  if (assignmentRegex.test(content)) {
    const updated = content.replace(assignmentRegex, `$table_prefix = '${escapedPrefix}';`);
    return updated === content ? null : updated;
  }

  const marker = "BEGIN DOCKER LOCAL TABLE PREFIX";
  const block = `// BEGIN DOCKER LOCAL TABLE PREFIX
$table_prefix = '${escapedPrefix}';
// END DOCKER LOCAL TABLE PREFIX`;

  const withBlock = insertPhpBlockIfMissing(content, marker, block);
  return withBlock === content ? null : withBlock;
}

export async function syncWpConfigTablePrefix(ctx: SiteContext, tablePrefix: string): Promise<boolean> {
  const wpConfigPath = wpConfigPathFor(ctx);
  if (!(await pathExists(wpConfigPath))) return false;

  const current = await readFile(wpConfigPath, "utf8");
  const updated = applyTablePrefix(current, tablePrefix);
  if (updated === null) return false;

  await writeFile(wpConfigPath, updated, "utf8");
  return true;
}

export async function hasWpFiles(ctx: SiteContext): Promise<boolean> {
  return pathExists(wpConfigPathFor(ctx));
}
