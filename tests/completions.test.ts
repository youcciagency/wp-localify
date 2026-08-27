import { describe, expect, it } from "vitest";
import {
  bashCompletionScript,
  completionCandidates,
  zshCompletionScript,
} from "../src/commands/completions.js";

const SITES = { alpha: {}, beta: {} } as Record<string, unknown>;

describe("completionCandidates", () => {
  it("suggests top-level commands and flags at the root", async () => {
    const out = await completionCandidates(["s"], SITES);
    expect(out).toEqual(expect.arrayContaining(["site", "shell"]));

    const exact = await completionCandidates([""], SITES);
    expect(exact).toContain("import");
    expect(exact).toContain("--json");
    expect(exact).toContain("gateway");
  });

  it("scopes to subcommands under groups", async () => {
    expect(await completionCandidates(["site", "st"], SITES)).toEqual(
      expect.arrayContaining(["start", "stop", "status", "start-all"]),
    );
    expect(await completionCandidates(["gateway", ""], SITES)).toEqual([
      "start",
      "stop",
      "restart",
      "status",
    ]);
  });

  it("completes real site keys for --site and after site scope", async () => {
    expect(await completionCandidates(["--site", "a"], SITES)).toEqual(["alpha"]);
    // --site slot offered inside any command
    const withFlag = await completionCandidates(["pull-db", "--si"], SITES);
    expect(withFlag).toContain("--site");
  });

  it("suggests service names for logs", async () => {
    expect(await completionCandidates(["logs", "d"], SITES)).toEqual(["db"]);
    const w = await completionCandidates(["logs", "w"], SITES);
    expect(w).toEqual(expect.arrayContaining(["wordpress", "wpcli"]));
    expect(w.every((c) => c.startsWith("w"))).toBe(true);
  });

  it("handles empty tokens safely and falls back sensibly for unknown heads", async () => {
    expect(await completionCandidates([], SITES)).toEqual(expect.arrayContaining(["config", "check"]));
    // Unknown first word: fall back to the top-level list rather than nothing.
    const fallback = await completionCandidates(["bogus-group", ""], SITES);
    expect(fallback).toContain("config");
    expect(fallback).not.toContain("start"); // group-internal subcommand hidden
  });
});

describe("completion scripts", () => {
  it("bash script registers a complete hook that calls __complete", () => {
    const script = bashCompletionScript();
    expect(script).toContain("complete -o default -F _wp_localify_completions wp-localify");
    expect(script).toContain("__complete");
  });

  it("zsh script defines compdef wrapper", () => {
    const script = zshCompletionScript();
    expect(script).toMatch(/#compdef wp-localify/);
    expect(script).toContain("__complete");
  });
});
