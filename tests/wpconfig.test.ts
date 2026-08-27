import { describe, expect, it } from "vitest";
import { applyTablePrefix, insertPhpBlockIfMissing, wrapDbDefines } from "../src/wordpress/wpconfig.js";

const WP_CONFIG = `<?php
define( 'DB_NAME', 'production' );
define( 'DB_USER', 'prod_user' );
define( 'DB_PASSWORD', 'prod_pass' );
define( 'DB_HOST', 'localhost' );
$table_prefix = 'wp_';
`;

describe("insertPhpBlockIfMissing", () => {
  it("inserts after <?php when marker missing", () => {
    const out = insertPhpBlockIfMissing(WP_CONFIG, "MARK", "// MARK\n$flag = true;");
    expect(out).toContain("<?php\n\n// MARK");
    expect(out.indexOf("// MARK")).toBeLessThan(out.indexOf("DB_NAME"));
  });

  it("is idempotent when the block contains its marker", () => {
    const once = insertPhpBlockIfMissing(WP_CONFIG, "BEGIN X", "// BEGIN X\n$flag = true;");
    const twice = insertPhpBlockIfMissing(once, "BEGIN X", "// BEGIN X\n$flag = true;");
    expect(twice).toBe(once);
  });

  it("prepends to files without <?php", () => {
    const out = insertPhpBlockIfMissing("# nothing", "M", "content;");
    expect(out.startsWith("content;")).toBe(true);
  });
});

describe("wrapDbDefines", () => {
  it("wraps bare DB_* defines in defined() guards", () => {
    const wrapped = wrapDbDefines(WP_CONFIG);
    expect(wrapped).toContain("if ( ! defined( 'DB_NAME' ) ) {");
    expect(wrapped).toContain("define( 'DB_NAME', 'production' );");
  });

  it("does not double-wrap already guarded defines", () => {
    const guarded = `<?php\nif ( ! defined( 'DB_NAME' ) )\ndefine('DB_NAME','x');\n`;
    expect(wrapDbDefines(guarded)).toBe(guarded);
  });

  it("leaves other defines alone", () => {
    const other = `<?php\ndefine('WP_HOME','https://x.test');\n`;
    expect(wrapDbDefines(other)).toBe(other);
  });
});

describe("applyTablePrefix", () => {
  it("replaces an existing assignment", () => {
    const updated = applyTablePrefix(WP_CONFIG, "custom_");
    expect(updated).toContain("$table_prefix = 'custom_';");
    expect(updated).not.toContain("'wp_'");
  });

  it("escapes quotes and backslashes in the prefix", () => {
    const updated = applyTablePrefix(WP_CONFIG, "we'ird\\_");
    expect(updated).toContain("$table_prefix = 'we\\'ird\\\\_';");
  });

  it("injects a marked block when no assignment exists", () => {
    const noAssignment = "<?php\ndefine('DB_NAME','x');\n";
    const updated = applyTablePrefix(noAssignment, "abc_");
    expect(updated).toContain("BEGIN DOCKER LOCAL TABLE PREFIX");
    expect(updated).toContain("$table_prefix = 'abc_';");
  });

  it("returns null when the prefix is already set to the same value", () => {
    const withPrefix = WP_CONFIG.replace(/'wp_'/g, "'custom_'");
    expect(applyTablePrefix(withPrefix, "custom_")).toBeNull();
  });
});
