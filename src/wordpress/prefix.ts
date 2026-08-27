/**
 * Pure helpers for detecting a WordPress table prefix from imported table
 * names. No I/O — fully unit-testable.
 */

const CORE_SUFFIXES = [
  "commentmeta",
  "comments",
  "links",
  "options",
  "postmeta",
  "posts",
  "term_relationships",
  "term_taxonomy",
  "termmeta",
  "terms",
  "usermeta",
  "users",
] as const;

export interface PrefixCandidate {
  prefix: string;
  score: number;
  length: number;
}

export function rankWordPressTablePrefixes(tableNames: string[]): PrefixCandidate[] {
  const prefixMap = new Map<string, Set<string>>();

  for (const tableName of tableNames) {
    for (const suffix of CORE_SUFFIXES) {
      const marker = `_${suffix}`;
      if (!tableName.endsWith(marker)) continue;

      const prefix = tableName.slice(0, tableName.length - suffix.length);
      if (!prefix.endsWith("_")) continue;

      if (!prefixMap.has(prefix)) {
        prefixMap.set(prefix, new Set());
      }
      prefixMap.get(prefix)?.add(suffix);
    }
  }

  const candidates: PrefixCandidate[] = [];
  for (const [prefix, suffixSet] of prefixMap.entries()) {
    if (!suffixSet.has("options")) continue;

    const hasUsers = suffixSet.has("users");
    const hasPosts = suffixSet.has("posts");
    const score = (hasUsers ? 100 : 0) + (hasPosts ? 50 : 0) + suffixSet.size;

    candidates.push({ prefix, score, length: prefix.length });
  }

  return candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.length - right.length;
  });
}

export function hostFromUrl(value: string): string {
  try {
    const url = new URL(String(value));
    return url.host;
  } catch {
    return "";
  }
}

/** Pure helper: score how well rows from `<prefix>options` match this site's URLs. */
export function scorePrefixBySiteUrl(
  prefix: string,
  optionRows: Array<{ optionValue?: string }>,
  site: { remoteDomain: string; localDomain: string },
): number {
  const remoteHost = hostFromUrl(site.remoteDomain);
  const localHost = site.localDomain;

  let score = 0;
  for (const row of optionRows) {
    const optionValue = row.optionValue ?? "";
    if (localHost && optionValue.includes(localHost)) {
      score += 1000;
    }
    if (remoteHost && optionValue.includes(remoteHost)) {
      score += 900;
    }
    if (/^https?:\/\//.test(optionValue)) {
      score += 25;
    }
  }

  if (!prefix.startsWith("wp_")) {
    score += 20;
  }

  return score;
}

export function pickBestTablePrefix(
  tableNames: string[],
  optionRowLookup: (prefix: string) => Array<{ optionValue?: string }>,
  site: { remoteDomain: string; localDomain: string },
): string | null {
  const ranked = rankWordPressTablePrefixes(tableNames);
  if (ranked.length === 0) return null;

  let bestPrefix = ranked[0]?.prefix ?? null;
  if (ranked.length === 1 || !bestPrefix) {
    return bestPrefix;
  }

  let bestScore = -1;
  for (const candidate of ranked) {
    const optionScore = scorePrefixBySiteUrl(candidate.prefix, optionRowLookup(candidate.prefix), site);
    const totalScore = candidate.score + optionScore;
    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestPrefix = candidate.prefix;
    }
  }

  return bestPrefix;
}

/** Parse `option_name\toption_value` lines from mysql -N -B output. */
export function parseOptionRows(stdout: string): Array<{ optionName: string; optionValue: string }> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [optionName, ...rest] = line.split("\t");
      return { optionName: optionName ?? "", optionValue: rest.join("\t") };
    });
}
