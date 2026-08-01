import { cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const cesiumSource = resolve(__dirname, "node_modules/cesium/Build/Cesium");
const cesiumPublic = resolve(__dirname, "example/public/cesium");

function copyDir(src: string, dest: string) {
    if (process.platform === "win32") {
        const result = spawnSync(
            "robocopy",
            [src, dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"],
            { windowsHide: true },
        );
        if (result.status != null && result.status >= 8) {
            throw new Error(`robocopy failed with exit code ${result.status}`);
        }
        return;
    }
    cpSync(src, dest, { recursive: true });
}

function copyCesium(): Plugin {
    return {
        name: "copy-cesium",
        buildStart() {
            copyDir(cesiumSource, cesiumPublic);
        },
    };
}

export default defineConfig({
    base: "/cesium-player-controller/",
    root: resolve(__dirname, "example"),
    plugins: [copyCesium()],
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
                "gltf": resolve(__dirname, "example", "gltf", "index.html"),
            },
        },
    },
});
