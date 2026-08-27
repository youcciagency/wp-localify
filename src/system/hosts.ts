import { buildHostsEntryGrepPattern, escapeRegex, shQuote } from "../text.js";
import { run, runShellMaybe } from "../exec.js";

export interface SudoHooks {
  onBeforeSudoPrompt?: () => void | Promise<void>;
  onAfterSudoPrompt?: () => void | Promise<void>;
}

export async function hasHostsEntry(domain: string): Promise<boolean> {
  const pattern = buildHostsEntryGrepPattern(domain);
  const result = await runShellMaybe(`grep -qE ${shQuote(pattern)} /etc/hosts`);
  return result.ok;
}

async function ensureSudoAccess(): Promise<void> {
  await run("sudo", ["-v"]);
}

export async function addHostsEntry(domain: string, hooks: SudoHooks = {}): Promise<void> {
  if (await hasHostsEntry(domain)) return;

  await hooks.onBeforeSudoPrompt?.();
  await ensureSudoAccess();
  await hooks.onAfterSudoPrompt?.();
  // stdin-fed instead of a printf | sudo tee shell pipeline
  await run("sudo", ["tee", "-a", "/etc/hosts"], { input: `127.0.0.1  ${domain}\n` });
}

export async function removeHostsEntry(domain: string, hooks: SudoHooks = {}): Promise<void> {
  if (!(await hasHostsEntry(domain))) return;

  await hooks.onBeforeSudoPrompt?.();
  await ensureSudoAccess();
  await hooks.onAfterSudoPrompt?.();

  // Looser than the detection pattern (parity with the original one-liner):
  // drop any 127.0.0.1 line mentioning the domain.
  const escaped = escapeRegex(domain);
  const perlProgram = `print unless /^[[:space:]]*127\\.0\\.0\\.1[[:space:]]+.*\\b${escaped}\\b/`;
  await run("sudo", ["perl", "-i", "-ne", perlProgram, "/etc/hosts"]);
}
