import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
    base: "/cesium-player-controller/",
    root: resolve(__dirname, "example"),
    define: {
        CESIUM_BASE_URL: JSON.stringify("/cesium-player-controller/cesium/"),
    },
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
                "3dtiles": resolve(__dirname, "example", "3dtiles", "index.html"),
                "3dgs": resolve(__dirname, "example", "3dgs", "index.html"),
            },
        },
    },
});