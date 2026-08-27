import type { Cartesian3, Rectangle, Viewer } from "cesium";

export type TerrainTileId = { x: number; y: number; level: number };

/** 碰撞流式器使用的 Cesium 私有 TerrainMesh 最小表面类型。 */
export type CesiumTerrainMeshLike = {
    vertices: Float32Array;
    indices: Uint8Array | Uint16Array | Uint32Array | number[];
    vertexCountWithoutSkirts: number;
    indexCountWithoutSkirts: number;
    rectangle?: Rectangle;
    encoding: {
        decodePosition(buffer: Float32Array, index: number, result?: Cartesian3): Cartesian3;
        getExaggeratedPosition?(buffer: Float32Array, index: number, result?: Cartesian3): Cartesian3;
    };
};

export type TerrainMeshEvent = TerrainTileId & {
    key: string;
    mesh: CesiumTerrainMeshLike;
};

type Listener = (event: TerrainMeshEvent) => void;
type TerrainDataLike = { createMesh?: (options: any) => Promise<CesiumTerrainMeshLike> | undefined };
type TerrainProviderLike = {
    tilingScheme: any;
    requestTileGeometry: (x: number, y: number, level: number, request?: unknown) => Promise<TerrainDataLike> | undefined;
};

/** 单个 TerrainProvider 上的 hook 状态，用于复用请求并监听 createMesh。 */
type ProviderHook = {
    provider: TerrainProviderLike;
    original: TerrainProviderLike["requestTileGeometry"];
    wrapped: TerrainProviderLike["requestTileGeometry"];
    listeners: Set<Listener>;
    patchedTerrainData: WeakSet<object>;
    pendingTerrainData: Map<string, Promise<TerrainDataLike>>;
    pendingMeshes: Map<string, Promise<CesiumTerrainMeshLike>>;
};

/** 按 provider 实例缓存 hook，避免重复包装。 */
const providerHooks = new WeakMap<object, ProviderHook>();

/** 生成地形瓦片唯一键：level/x/y。 */
export function terrainTileKey(level: number, x: number, y: number): string {
    return `${level}/${x}/${y}`;
}

/** 判断对象是否为可用的 Cesium TerrainMesh。 */
function validMesh(value: any): value is CesiumTerrainMeshLike {
    return !!value?.vertices && !!value?.indices && !!value?.encoding?.decodePosition;
}

/** 向所有监听者广播瓦片 mesh 就绪事件。 */
function emit(hook: ProviderHook, options: any, mesh: unknown) {
    if (!validMesh(mesh)) return;
    const x = Number(options?.x), y = Number(options?.y), level = Number(options?.level);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(level)) return;
    const event = { x, y, level, key: terrainTileKey(level, x, y), mesh };
    for (const listener of hook.listeners) listener(event);
}

/**
 * 包装 TerrainData.createMesh，在 Cesium 生成 mesh 时捕获并通知监听者。
 * 同一 TerrainData 实例只 patch 一次。
 */
function patchTerrainData(hook: ProviderHook, terrainData: TerrainDataLike | undefined) {
    if (!terrainData || typeof terrainData.createMesh !== "function" || hook.patchedTerrainData.has(terrainData)) return;
    hook.patchedTerrainData.add(terrainData);
    const originalCreateMesh = terrainData.createMesh;
    try {
        terrainData.createMesh = function (this: TerrainDataLike, options: any) {
            const result = originalCreateMesh.call(this, options);
            if (result !== undefined) {
                const promise = Promise.resolve(result);
                const key = terrainTileKey(Number(options?.level), Number(options?.x), Number(options?.y));
                // 原始 TerrainData 已消费，从 pending 移除；mesh 进入 pendingMeshes
                hook.pendingTerrainData.delete(key);
                hook.pendingMeshes.set(key, promise);
                promise.then((mesh) => emit(hook, options, mesh)).catch(() => undefined).finally(() => {
                    if (hook.pendingMeshes.get(key) === promise) hook.pendingMeshes.delete(key);
                });
            }
            return result;
        };
    } catch {
    }
}

/**
 * 在 TerrainProvider 上安装 requestTileGeometry 包装器并注册监听者。
 * 返回卸载函数；最后一个监听者移除时恢复原方法。
 */
function acquireProviderHook(provider: TerrainProviderLike | null | undefined, listener: Listener): () => void {
    if (!provider || typeof provider.requestTileGeometry !== "function") return () => { };
    let hook = providerHooks.get(provider as object);
    if (!hook) {
        const original = provider.requestTileGeometry;
        const created = {
            provider,
            original,
            listeners: new Set<Listener>(),
            patchedTerrainData: new WeakSet<object>(),
            pendingTerrainData: new Map<string, Promise<TerrainDataLike>>(),
            pendingMeshes: new Map<string, Promise<CesiumTerrainMeshLike>>(),
        } as ProviderHook;
        const wrapped: TerrainProviderLike["requestTileGeometry"] = function (this: TerrainProviderLike, x, y, level, request) {
            const result = original.call(this, x, y, level, request);
            if (result !== undefined) {
                const key = terrainTileKey(level, x, y);
                const promise = Promise.resolve(result);
                created.pendingTerrainData.set(key, promise);
                promise.then((terrainData) => {
                    patchTerrainData(created, terrainData);
                    // 短暂保留已解析的 TerrainData，供碰撞兜底复用，等 Cesium 进入 createMesh 阶段
                    setTimeout(() => {
                        if (created.pendingTerrainData.get(key) === promise) created.pendingTerrainData.delete(key);
                    }, 1000);
                }).catch(() => {
                    if (created.pendingTerrainData.get(key) === promise) created.pendingTerrainData.delete(key);
                });
            }
            return result;
        };
        created.wrapped = wrapped;
        hook = created;
        providerHooks.set(provider as object, hook);
        try { provider.requestTileGeometry = wrapped; } catch { /* provider 不可写时，仍可用渲染扫描/兜底 */ }
    }
    hook.listeners.add(listener);

    return () => {
        if (!hook) return;
        hook.listeners.delete(listener);
        if (hook.listeners.size === 0) {
            try {
                if (provider.requestTileGeometry === hook.wrapped) provider.requestTileGeometry = hook.original;
            } catch { /* provider 可能不可变 */ }
            providerHooks.delete(provider as object);
        }
    };
}

type SceneTerrainLike = {
    ready?: boolean;
    provider?: TerrainProviderLike;
    readyEvent?: { addEventListener(listener: () => void): () => void };
};

/**
 * 隔离访问 Cesium 私有地形 mesh 所需的 hook。
 */
export class CesiumTerrainMeshAdapter {
    private cache = new Map<string, CesiumTerrainMeshLike>();
    private currentProvider: TerrainProviderLike | null = null;
    private releaseProviderHook: (() => void) | null = null;
    private removePostRender: (() => void) | null = null;
    private removeProviderChanged: (() => void) | null = null;
    private removeTerrainReady: (() => void) | null = null;
    private started = false;
    private disposed = false;

    constructor(
        private viewer: Viewer,
        private onMesh: Listener,
        private onProviderChanged: () => void,
        private maxCachedMeshes = 64,
    ) { }

    /** 绑定当前 terrain provider，并每帧扫描 Cesium 已渲染瓦片的 mesh。 */
    start() {
        if (this.disposed || this.started) return;
        this.started = true;
        this.bindProvider();

        const terrain = (this.viewer.scene as { terrain?: SceneTerrainLike }).terrain;
        if (terrain && !terrain.ready && terrain.readyEvent) {
            this.removeTerrainReady = terrain.readyEvent.addEventListener(() => {
                if (this.disposed) return;
                const hadProvider = !!this.currentProvider;
                this.bindProvider();
                if (this.currentProvider && !hadProvider) this.onProviderChanged();
            });
        }

        this.removePostRender = this.viewer.scene.postRender.addEventListener(() => this.scanRenderedTiles());
        this.removeProviderChanged = this.viewer.scene.globe.terrainProviderChanged.addEventListener(() => {
            this.cache.clear();
            this.bindProvider();
            this.onProviderChanged();
        });
        this.scanRenderedTiles();
    }

    /** 当前绑定的 terrain provider；未启动时为 null。 */
    get provider(): TerrainProviderLike | null { return this.currentProvider; }

    /**
     * LRU 式读取缓存 mesh：命中时移到 Map 末尾。
     * 未命中返回 undefined。
     */
    getCached(key: string): CesiumTerrainMeshLike | undefined {
        const mesh = this.cache.get(key);
        if (!mesh) return undefined;
        this.cache.delete(key);
        this.cache.set(key, mesh);
        return mesh;
    }

    /**
     * 显式兜底请求：仅在 Cesium 自身加载器未提供所需 mesh 时调用。
     * 优先复用进行中的 Cesium 请求与 pending mesh。
     */
    async requestMesh(tile: TerrainTileId): Promise<CesiumTerrainMeshLike> {
        if (!this.currentProvider) this.bindProvider();
        const provider = this.currentProvider;
        if (!provider) throw new Error("Cesium terrain provider is unavailable");
        const key = terrainTileKey(tile.level, tile.x, tile.y);
        const cached = this.getCached(key);
        if (cached) return cached;

        const hook = providerHooks.get(provider as object);
        // 复用 Cesium 正在 createMesh 的 Promise
        const pendingMesh = hook?.pendingMeshes.get(key);
        if (pendingMesh) return pendingMesh;

        const cesiumRequest = hook?.pendingTerrainData.get(key);
        const request = cesiumRequest ?? provider.requestTileGeometry(tile.x, tile.y, tile.level);
        if (!request) throw new Error(`Terrain request deferred: ${key}`);
        const terrainData = await request;
        if (provider !== this.currentProvider || this.disposed) throw new Error(`Terrain provider changed: ${key}`);
        if (cesiumRequest) {
            // 等待 Cesium 地形状态机进入 createMesh 阶段
            await new Promise<void>((resolve) => {
                if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
                else setTimeout(resolve, 0);
            });
            const reused = this.getCached(key);
            if (reused) return reused;
            const cesiumMesh = hook?.pendingMeshes.get(key);
            if (cesiumMesh) return cesiumMesh;
        }
        patchTerrainData(hook ?? this.makeTransientHook(provider), terrainData);
        if (typeof terrainData.createMesh !== "function") throw new Error(`TerrainData.createMesh is unavailable: ${key}`);

        const scene = this.viewer.scene as any;
        const result = terrainData.createMesh({
            tilingScheme: provider.tilingScheme,
            x: tile.x,
            y: tile.y,
            level: tile.level,
            exaggeration: scene.verticalExaggeration ?? 1,
            exaggerationRelativeHeight: scene.verticalExaggerationRelativeHeight ?? 0,
            throttle: false,
        });
        if (!result) throw new Error(`Terrain mesh creation deferred: ${key}`);
        const mesh = await result;
        if (!validMesh(mesh)) throw new Error(`Invalid TerrainMesh: ${key}`);
        this.remember({ ...tile, key, mesh });
        return mesh;
    }

    /** 移除事件监听、恢复 provider 并清空缓存。 */
    destroy() {
        this.disposed = true;
        this.removePostRender?.();
        this.removeProviderChanged?.();
        this.removeTerrainReady?.();
        this.releaseProviderHook?.();
        this.removePostRender = this.removeProviderChanged = this.releaseProviderHook = this.removeTerrainReady = null;
        this.currentProvider = null;
        this.started = false;
        this.cache.clear();
    }

    /**
     * 解析可用 TerrainProvider。
     */
    private resolveTerrainProvider(): TerrainProviderLike | null {
        const scene = this.viewer.scene as { terrain?: SceneTerrainLike; globe: { terrainProvider?: TerrainProviderLike } };
        const fromTerrain = scene.terrain?.ready ? scene.terrain.provider : undefined;
        if (fromTerrain && typeof fromTerrain.requestTileGeometry === "function") return fromTerrain;

        const fromGlobe = scene.globe.terrainProvider;
        if (fromGlobe && typeof fromGlobe.requestTileGeometry === "function") return fromGlobe;

        return null;
    }

    /** 切换或首次绑定 terrain provider 并安装 hook；未就绪时返回 false。 */
    private bindProvider(): boolean {
        const provider = this.resolveTerrainProvider();
        if (!provider) {
            this.releaseProviderHook?.();
            this.releaseProviderHook = null;
            this.currentProvider = null;
            return false;
        }
        if (this.currentProvider === provider && this.releaseProviderHook) return true;

        this.releaseProviderHook?.();
        this.currentProvider = provider;
        this.releaseProviderHook = acquireProviderHook(provider, (event) => this.remember(event));
        return true;
    }

    /** 写入 LRU 缓存并通知上层；超出容量时淘汰最旧条目。 */
    private remember(event: TerrainMeshEvent) {
        if (this.disposed) return;
        const previous = this.cache.get(event.key);
        if (previous === event.mesh) return;
        this.cache.delete(event.key);
        this.cache.set(event.key, event.mesh);
        while (this.cache.size > Math.max(1, this.maxCachedMeshes)) {
            const oldest = this.cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
        this.onMesh(event);
    }

    /** 每帧扫描 Cesium 本帧渲染的地形瓦片，复用其真实 mesh。 */
    private scanRenderedTiles() {
        const tiles: Iterable<any> | undefined = (this.viewer.scene.globe as any)?._surface?._tilesRenderedThisFrame;
        if (!tiles) return;
        for (const tile of tiles) {
            // mesh 为真实瓦片 mesh；renderedMesh 可能是父级临时填充 mesh
            const mesh = tile?.data?.mesh;
            const x = tile?._x ?? tile?.x;
            const y = tile?._y ?? tile?.y;
            const level = tile?._level ?? tile?.level;
            if (validMesh(mesh) && Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(level)) {
                this.remember({ x, y, level, key: terrainTileKey(level, x, y), mesh });
            }
        }
    }

    /** 无全局 hook 时，为单次兜底 createMesh 构造临时 hook。 */
    private makeTransientHook(provider: TerrainProviderLike): ProviderHook {
        return {
            provider,
            original: provider.requestTileGeometry,
            wrapped: provider.requestTileGeometry,
            listeners: new Set([(event) => this.remember(event)]),
            patchedTerrainData: new WeakSet<object>(),
            pendingTerrainData: new Map<string, Promise<TerrainDataLike>>(),
            pendingMeshes: new Map<string, Promise<CesiumTerrainMeshLike>>(),
        };
    }
}
