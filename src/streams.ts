import { Transform } from "node:stream";

/**
 * Streaming regex replacement that is safe across chunk boundaries.
 *
 * Incoming bytes are appended to a carry-over buffer. Matches are finalized
 * only when they end at least `maxTokenLength - 1` characters before the
 * buffer's end; anything closer to the edge may still be extended by the next
 * chunk, so the buffer is held back from the match's START. On flush the whole
 * remainder is processed without a safety margin.
 *
 * `maxTokenLength` must be >= the longest string `pattern` can match.
 */
export function createReplacer(
  pattern: RegExp,
  replacement: string,
  options: { maxTokenLength?: number } = {},
): Transform {
  const source = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const maxTokenLength = Math.max(1, options.maxTokenLength ?? 64);

  let tail = "";

  /** Returns [outputToEmit, remainderToKeep]. */
  const consume = (text: string, final: boolean): [string, string] => {
    const softLimit = final ? text.length : Math.max(0, text.length - (maxTokenLength - 1));

    let out = "";
    let pos = 0;
    // Everything from `cut` onwards stays buffered for the next chunk.
    let cut = softLimit;

    source.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = source.exec(text)) !== null) {
      if (match[0].length === 0) {
        source.lastIndex += 1;
        continue;
      }
      const end = match.index + match[0].length;
      if (!final && end > softLimit) {
        // Pending match may grow with more data: keep it (and its prefix)
        // entirely.
        cut = Math.min(cut, match.index);
        break;
      }
      out += text.slice(pos, match.index) + replacement;
      pos = end;
    }

    if (final) {
      return [out + text.slice(pos), ""];
    }

    out += text.slice(pos, cut);
    return [out, text.slice(cut)];
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        const text = tail + chunk.toString("utf8");
        const [emit, rest] = consume(text, false);
        tail = rest;
        callback(null, emit);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const [emit] = consume(tail, true);
        tail = "";
        callback(null, emit);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

/**
 * Sanitize MySQL 8 dumps for import into MariaDB: rewrite utf8mb4_0900_*
 * collations to utf8mb4_unicode_ci, which MariaDB understands.
 */
export function createCollationSanitizer(): Transform {
  return createReplacer(/utf8mb4_0900_[a-z0-9_]*/gi, "utf8mb4_unicode_ci", { maxTokenLength: 32 });
}
