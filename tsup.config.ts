import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["cesium", "@dimforge/rapier3d-compat"],
    target: "es2020",
    minify: false,
    outExtension({ format }) {
        return { js: format === "esm" ? ".mjs" : ".js" };
    },
});
