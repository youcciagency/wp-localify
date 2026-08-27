import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

let tmpWriteCounter = 0;

function tmpName(filePath: string): string {
  // pid+counter+uuid: safe under concurrent writers within the same ms.
  tmpWriteCounter += 1;
  return `${filePath}.tmp-${process.pid}-${tmpWriteCounter}-${randomUUID()}`;
}

/** Write text atomically: temp file in the same directory, then rename over the target. */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = tmpName(filePath);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile };
export function tmpRoot(): string {
  return tmpdir();
}
