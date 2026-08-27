import type { Command } from "commander";
import { loadRegistry } from "../registry/store.js";

const SITE_SUBCOMMANDS = [
  "add",
  "list",
  "use",
  "status",
  "start",
  "stop",
  "restart",
  "edit",
  "remove",
  "start-all",
  "stop-all",
] as const;

const GATEWAY_SUBCOMMANDS = ["start", "stop", "restart", "status"] as const;

const GLOBAL_FLAGS = ["-y", "--yes", "--json", "-v", "--verbose", "-q", "--quiet"] as const;

const SERVICES = ["db", "wordpress", "wpcli"] as const;

function siteKeys(registrySites: Record<string, unknown>): string[] {
  return Object.keys(registrySites).sort();
}

/**
 * Pure candidate generator: given the user's typed tokens (excluding the
 * program name), return completion candidates for the LAST token.
 *
 * Heuristics, in order:
 *   - previous token was `--site`        → site keys
 *   - previous token was the `logs` arg position → service names
 *   - token starts with `-`              → context-appropriate flags
 *   - first positional scope is a group  → that group's subcommands (+ keys)
 *   - otherwise                          → top-level commands + global flags
 */
export async function completionCandidates(
  tokens: string[],
  registrySites: Record<string, unknown>,
): Promise<string[]> {
  const current = tokens.at(-1) ?? "";
  const previous = tokens.length >= 2 ? (tokens.at(-2) ?? "") : "";
  const head = tokens[0] ?? "";

  // Value slots: --site <here> and logs <service>.
  if (previous === "--site") {
    return filterPrefix(siteKeys(registrySites), current);
  }
  if (head === "logs" && tokens.length === 2 && !current.startsWith("-")) {
    return filterPrefix([...SERVICES], current);
  }

  if (current.startsWith("-")) {
    const flags: string[] = [...GLOBAL_FLAGS];
    if (!tokens.includes("--site")) flags.push("--site");
    if (SITE_SUBCOMMANDS.includes(head as (typeof SITE_SUBCOMMANDS)[number])) {
      flags.push("--site"); // every site subcommand also supports it
      if (head === "remove" || head === "status") flags.push("--purge", "-f");
    }
    return filterPrefix(flags, current);
  }

  // Subcommand scopes.
  if (head === "site") {
    return filterPrefix(SITE_SUBCOMMANDS, current);
  }
  if (head === "gateway") {
    return filterPrefix(GATEWAY_SUBCOMMANDS, current);
  }
  if (SITE_SUBCOMMANDS.includes(current as never) || GATEWAY_SUBCOMMANDS.includes(current as never)) {
    return [];
  }

  const top = [
    "config",
    "check",
    "init",
    "pull",
    "pull-files",
    "pull-db",
    "import",
    "import-db",
    "replace-urls",
    "all",
    "site",
    "gateway",
    "logs",
    "open",
    "wp",
    "shell",
    "db-export",
    "help",
    ...GLOBAL_FLAGS,
  ];
  return filterPrefix(top, current);
}

function filterPrefix(candidates: readonly string[], prefix: string): string[] {
  return candidates.filter((candidate) => candidate.startsWith(prefix));
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export function bashCompletionScript(): string {
  return `# bash completion for wp-localify — source this file.
_wp_localify_completions() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  local candidates
  candidates="$(wp-localify __complete "\${COMP_WORDS[@]:1}" 2>/dev/null)"
  COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )
}
complete -o default -F _wp_localify_completions wp-localify
`;
}

export function zshCompletionScript(): string {
  return `#compdef wp-localify
# zsh completion for wp-localify.
_wp_localify() {
  local -a candidates
  candidates=(\${(f)"$(wp-localify __complete "\${words[@]:1:-1}" 2>/dev/null)"})
  _describe 'wp-localify' candidates
}
compdef _wp_localify wp-localify
`;
}

export function registerCompletionCommands(program: Command): void {
  program
    .command("completions")
    .description("Print a shell completion script (bash | zsh)")
    .argument("[shell]", "bash or zsh; defaults to $SHELL")
    .action(async (shellArg: string | undefined) => {
      const detected = shellArg ?? (process.env.SHELL?.includes("zsh") ? "zsh" : "bash");

      if (detected !== "bash" && detected !== "zsh") {
        program.error("Only bash and zsh completions are supported.", { code: "1" });
      }

      process.stdout.write(detected === "zsh" ? zshCompletionScript() : bashCompletionScript());
    });

  program
    .command("__complete", { hidden: true })
    .description("Internal: emit completion candidates, one per line")
    .allowUnknownOption(true)
    .argument("[tokens...]")
    .action(async (tokens: string[]) => {
      let sites: Record<string, unknown> = {};
      try {
        const registry = await loadRegistry();
        sites = registry.sites;
      } catch {
        sites = {};
      }
      const candidates = await completionCandidates(tokens, sites);
      for (const candidate of candidates) {
        process.stdout.write(`${candidate}\n`);
      }
    });
}
