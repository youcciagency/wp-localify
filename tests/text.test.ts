import { describe, expect, it } from "vitest";
import {
  dotenvQuote,
  buildHostsEntryGrepPattern,
  escapeRegex,
  normalizeNoTrailingSlash,
  posixDoubleQuote,
  shQuote,
  slugify,
  uniqueSiteKey,
  yamlQuote,
} from "../src/text.js";
import { hasHostsEntryOffline } from "./helpers/hosts.js";

describe("slugify", () => {
  it("slugifies names", () => {
    expect(slugify("My Cool Site!!")).toBe("my-cool-site");
  });

  it("falls back to 'site'", () => {
    expect(slugify("")).toBe("site");
    expect(slugify("###")).toBe("site");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("--a-b--")).toBe("a-b");
  });
});

describe("uniqueSiteKey", () => {
  it("returns base when free", () => {
    expect(uniqueSiteKey("blog", {})).toBe("blog");
  });

  it("appends -2, -3 on collision", () => {
    const sites = { blog: true, "blog-2": true };
    expect(uniqueSiteKey("blog", sites)).toBe("blog-3");
  });
});

describe("quoting helpers", () => {
  it("shQuote survives POSIX single-quote rules", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("posixDoubleQuote escapes dangerous chars", () => {
    expect(posixDoubleQuote('a"b$c`d\\e')).toBe('"a\\"b\\$c\\`d\\\\e"');
  });

  it("yamlQuote doubles single quotes", () => {
    expect(yamlQuote("o'brien")).toBe("'o''brien'");
  });

  it("dotenvQuote escapes backslashes and quotes", () => {
    expect(dotenvQuote('p"a\\ss')).toBe('"p\\"a\\\\ss"');
  });
});

describe("escapeRegex / hosts entry pattern", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
  });

  it("builds a grep -E pattern anchored to the IPv4 mapping", () => {
    const pattern = buildHostsEntryGrepPattern("site.test");
    expect(pattern.startsWith("^[[:space:]]*127\\.0\\.0\\.1[[:space:]]+")).toBe(true);
    expect(pattern).toContain(escapeRegex("site.test"));
    expect(pattern.endsWith("([[:space:]]|$)")).toBe(true);
  });

  it("matches real-world hosts lines via an equivalent JS pattern", () => {
    // JS RegExp can't use POSIX classes; mirror them with explicit spaces.
    expect(hasHostsEntryOffline("127.0.0.1\tsite.test", "site.test")).toBe(true);
    expect(hasHostsEntryOffline("127.0.0.1 site.test", "site.test")).toBe(true);
    // Domain must directly follow the mapping (first-position), like grep -E.
    expect(hasHostsEntryOffline("127.0.0.1 site.test.evil", "site.test")).toBe(false);
    expect(hasHostsEntryOffline("::1 site.test", "site.test")).toBe(false);
    expect(hasHostsEntryOffline("#127.0.0.1 site.test", "site.test")).toBe(false);
  });
});

describe("normalizeNoTrailingSlash", () => {
  it("strips trailing slashes", () => {
    expect(normalizeNoTrailingSlash("https://a.com///")).toBe("https://a.com");
    expect(normalizeNoTrailingSlash("https://a.com")).toBe("https://a.com");
  });
});
