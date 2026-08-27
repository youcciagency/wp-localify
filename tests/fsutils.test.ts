import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { atomicWriteText, readTextIfExists } from "../src/fsutils.js";

let dir: string | undefined;

async function tempDir(): Promise<string> {
  if (!dir) {
    dir = await mkdtemp(path.join(tmpdir(), "wp-localify-test-"));
  }
  return dir;
}

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("atomicWriteText", () => {
  it("writes content and leaves no temp files behind", async () => {
    const base = await tempDir();
    const target = path.join(base, "case1", "nested", "file.json");

    await atomicWriteText(target, "{}\n");

    expect(await readFile(target, "utf8")).toBe("{}\n");
    const files = await readdir(path.dirname(target));
    expect(files).toEqual(["file.json"]);
  });

  it("overwrites an existing file cleanly", async () => {
    const base = await tempDir();
    const target = path.join(base, "case2", "over.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "old", "utf8");

    await atomicWriteText(target, "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(path.dirname(target))).toEqual(["over.json"]);
  });

  it("is safe against concurrent writes (last rename wins, no partial file)", async () => {
    const base = await tempDir();
    const target = path.join(base, "case3", "racy.json");

    await Promise.all([
      atomicWriteText(target, `${"a".repeat(5000)}\n`),
      atomicWriteText(target, `${"b".repeat(5000)}\n`),
      atomicWriteText(target, `${"c".repeat(5000)}\n`),
    ]);

    const content = await readFile(target, "utf8");
    // The file must be one of the complete payloads — never interleaved.
    expect([`${"a".repeat(5000)}\n`, `${"b".repeat(5000)}\n`, `${"c".repeat(5000)}\n`]).toContain(content);
    const files = await readdir(path.dirname(target));
    expect(files).toEqual(["racy.json"]);
  });
});

describe("readTextIfExists", () => {
  it("returns null for missing files", async () => {
    expect(await readTextIfExists("/nonexistent/path/xyz")).toBeNull();
  });
});
