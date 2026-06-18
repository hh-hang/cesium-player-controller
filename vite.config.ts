import { resolve } from "path";
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
    base: "/cesium-player-controller/",
    root: resolve(__dirname, "example"),
    plugins: [cesium()],
    server: { host: true },
    resolve: {
        alias: {
            "cesium-player-controller": resolve(__dirname, "src/index.ts"),
        },
    },
    build: {
        outDir: "../docs",
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, "example", "index.html"),
                agihq: resolve(__dirname, "example", "3dtiles", "index.html"),
            },
        },
    },
});
