import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  sourcemap: true,
  clean: true,
  minify: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
