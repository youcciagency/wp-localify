import { describe, expect, it } from "vitest";
import {
  hostFromUrl,
  parseOptionRows,
  pickBestTablePrefix,
  rankWordPressTablePrefixes,
  scorePrefixBySiteUrl,
} from "../src/wordpress/prefix.js";

const WP_CORE = [
  "wp_commentmeta",
  "wp_comments",
  "wp_links",
  "wp_options",
  "wp_postmeta",
  "wp_posts",
  "wp_term_relationships",
  "wp_term_taxonomy",
  "wp_termmeta",
  "wp_terms",
  "wp_usermeta",
  "wp_users",
];

describe("rankWordPressTablePrefixes", () => {
  it("ranks a full core set highest", () => {
    const ranked = rankWordPressTablePrefixes([...WP_CORE, "wp_blogmeta"]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.prefix).toBe("wp_");
    expect(ranked[0]?.score).toBe(150 + 12); // users+posts bonus + 12 suffixes
  });

  it("ignores prefixes without an options table", () => {
    const tables = ["custom_posts", "custom_postmeta", "other_options"];
    const ranked = rankWordPressTablePrefixes(tables);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.prefix).toBe("other_");
  });

  it("returns empty for non-WordPress tables", () => {
    expect(rankWordPressTablePrefixes(["users", "posts"])).toEqual([]);
  });
});

describe("scorePrefixBySiteUrl", () => {
  const site = { remoteDomain: "https://example.com", localDomain: "example.test" };

  it("strongly prefers rows matching local then remote host", () => {
    const localRows = [{ optionValue: "https://example.test" }];
    const remoteRows = [{ optionValue: "https://example.com" }];
    expect(scorePrefixBySiteUrl("wp_", localRows, site)).toBeGreaterThan(
      scorePrefixBySiteUrl("wp_", remoteRows, site),
    );
    expect(scorePrefixBySiteUrl("wp_", remoteRows, site)).toBeGreaterThan(0);
  });

  it("gives a small bonus to non-default prefixes", () => {
    const empty: Array<{ optionValue?: string }> = [];
    expect(scorePrefixBySiteUrl("custom_", empty, site)).toBe(20);
    expect(scorePrefixBySiteUrl("wp_", empty, site)).toBe(0);
  });
});

describe("pickBestTablePrefix", () => {
  it("returns the only candidate directly", () => {
    const best = pickBestTablePrefix(WP_CORE, () => [], {
      remoteDomain: "",
      localDomain: "",
    });
    expect(best).toBe("wp_");
  });

  it("breaks ties using option-row lookups", () => {
    const multiSiteTables = [...WP_CORE.map((t) => t.replace("wp_", "wp2_")), ...WP_CORE];
    const best = pickBestTablePrefix(
      multiSiteTables,
      (prefix) =>
        prefix === "wp2_"
          ? [{ optionValue: "https://example.test" }]
          : [{ optionValue: "https://unrelated.org" }],
      { remoteDomain: "", localDomain: "example.test" },
    );
    expect(best).toBe("wp2_");
  });

  it("returns null with no candidates", () => {
    expect(pickBestTablePrefix(["foo"], () => [], { remoteDomain: "", localDomain: "" })).toBeNull();
  });
});

describe("hostFromUrl", () => {
  it("extracts host with port", () => {
    expect(hostFromUrl("https://example.com:8443/path")).toBe("example.com:8443");
  });

  it("returns empty on garbage", () => {
    expect(hostFromUrl("not a url")).toBe("");
  });
});

describe("parseOptionRows", () => {
  it("splits name from value on the first tab and preserves the rest", () => {
    const rows = parseOptionRows("siteurl\thttps://a.test\tx\thome\thttps://b.test");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.optionName).toBe("siteurl");
    expect(rows[0]?.optionValue).toBe("https://a.test\tx\thome\thttps://b.test");
  });

  it("parses one row per line", () => {
    const rows = parseOptionRows("siteurl\thttps://a.test\nhome\thttps://b.test\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ optionName: "home", optionValue: "https://b.test" });
  });
});
