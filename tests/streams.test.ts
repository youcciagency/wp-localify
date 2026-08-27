import { describe, expect, it } from "vitest";
import { createCollationSanitizer, createReplacer } from "../src/streams.js";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";

async function transformChunks(chunks: string[], make: () => Transform): Promise<string> {
  let out = "";
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  await pipeline(
    async function* generate() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    make(),
    collector,
  );
  return out;
}

describe("createReplacer", () => {
  it("replaces tokens split across chunk boundaries", async () => {
    const out = await transformChunks(["HE", "LLO_WO", "RLD and HELLO", "_WORLD again"], () =>
      createReplacer(/HELLO_WORLD/g, "X"),
    );
    expect(out).toBe("X and X again");
  });

  it("handles tokens split across many small chunks (maxTokenLength ≥ token length)", async () => {
    const out = await transformChunks(["abc", "def", "ghi", "j!"], () =>
      createReplacer(/abcdefghij/g, "Z", { maxTokenLength: 10 }),
    );
    expect(out).toBe("Z!");
  });

  it("keeps a match pending when it may still grow with the next chunk", async () => {
    // With maxTokenLength 6, after "abcd" the matcher must hold everything
    // back because "abcd…" could still become "abcdef".
    const out = await transformChunks(["abcd", "efGH", "IJ"], () =>
      createReplacer(/abcdefghij/gi, "Z", { maxTokenLength: 10 }),
    );
    expect(out).toBe("Z");
  });

  it("passes through text without matches", async () => {
    const out = await transformChunks(["nothing to see"], () => createReplacer(/zzz/g, "Y"));
    expect(out).toBe("nothing to see");
  });
});

describe("createCollationSanitizer", () => {
  it("rewrites utf8mb4_0900_* collations for MariaDB", async () => {
    const sql =
      "CREATE TABLE `wp_posts` (`a` varchar(10) COLLATE utf8mb4_0900_ai_ci) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;";
    const out = await transformChunks([sql.slice(0, 40), sql.slice(40)], createCollationSanitizer);
    expect(out).not.toContain("0900");
    expect(out).toContain("utf8mb4_unicode_ci");
    expect(out).toContain("CREATE TABLE");
  });

  it("leaves other content untouched", async () => {
    const sql = "INSERT INTO t VALUES ('utf8mb4_general_ci');";
    const out = await transformChunks([sql], createCollationSanitizer);
    expect(out).toBe(sql);
  });
});
