import { Cartesian2, Cartesian3, Cartographic, Math as CMath, Rectangle, type Viewer } from "cesium";
import type { StreamingTerrainCollider } from "../types";
import {
    CesiumTerrainMeshAdapter,
    terrainTileKey,
    type CesiumTerrainMeshLike,
    type TerrainMeshEvent,
    type TerrainTileId,
} from "../terrain/CesiumTerrainMeshAdapter";
import { buildWireframeLinesEcef } from "../utils/debugGeometry";
import type { PhysicsSystem } from "./PhysicsSystem";

/** 流式地形瓦片 debug 线框生命周期回调。 */
export type TerrainDebugHooks = {
    onTileDebugAdd?: (key: string, linesEcef: Float64Array) => void;
    onTileDebugRemove?: (key: string) => void;
    onTileDebugClear?: () => void;
};

type DecodedTerrainMesh = {
    positions: Float32Array;
    indices: Uint32Array;
    debugLinesEcef: Float64Array;
};

/** 单个流式地形瓦片的运行时状态。 */
type TileEntry = TerrainTileId & {
    key: string;
    longitude: number;
    latitude: number;
    halfDiagonal: number;
    distance: number;
    wantedFrame: number;
    firstWantedAt: number;
    nextRequestAt: number;
    requesting: boolean;
    colliderReady: boolean;
};

/** 高精度单调时间戳（毫秒）。 */
const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * 在玩家附近维护有界数量的 Cesium 真实地形 mesh，并同步为 Rapier 静态碰撞体。
 * 加载/卸载以玩家（或载具）为中心，与摄像机可见性解耦。
 */
export class TerrainCollisionStreamer {
    /** Rapier 局部系重锚水平距离阈值（米），传给 playerController 使用。 */
    readonly rebaseDistance: number;

    /** 物理用地形四叉树层级，决定单块瓦片碰撞 mesh 精细程度。 */
    private level: number;
    /** 预测玩家位置周围需加载碰撞的半径（米）。 */
    private radius: number;
    /** 已加载瓦片保留到此半径外才卸载（米），应大于 radius 形成滞回。 */
    private releaseRadius: number;
    /** 速度前瞻秒数，用于按移动方向预加载前方瓦片。 */
    private lookAheadSeconds: number;
    /** 等待 Cesium 自身加载后再发起兜底 mesh 请求的延迟（毫秒）。 */
    private fallbackDelayMs: number;
    /** 同时进行的最大兜底地形 mesh 请求数。 */
    private maxConcurrentRequests: number;
    /** 单次 update 内最多创建的 Rapier trimesh 数量。 */
    private maxBuildsPerFrame: number;
    /** 同时纳入工作集的活跃瓦片数量上限。 */
    private maxActiveTiles: number;
    /** 监听并复用 Cesium 地形 mesh 的适配器。 */
    private adapter: CesiumTerrainMeshAdapter;
    /** 当前工作集内各瓦片的运行时状态，键为 level/x/y。 */
    private entries = new Map<string, TileEntry>();
    /** 已拿到 mesh、待解码并注册为 Rapier collider 的队列。 */
    private buildQueue = new Map<string, CesiumTerrainMeshLike>();
    /** 单调递增帧计数，用于标记本帧仍被需要的瓦片。 */
    private frameNumber = 0;
    /** 当前进行中的兜底 mesh 请求数量。 */
    private inFlight = 0;
    /** 异步请求代数；provider 切换或重置时递增，使旧请求结果失效。 */
    private requestGeneration = 0;
    /** 是否已销毁，阻止后续 update 与异步回调写入。 */
    private disposed = false;
    /** 本帧预测位置所在瓦片的 key，供 prime 优先构建脚下 collider。 */
    private currentTileKey: string | null = null;

    /** 复用：预测位置经纬度。 */
    private scratchCartographic = new Cartographic();
    /** 复用：瓦片 XY 索引。 */
    private scratchTile = new Cartesian2();
    /** 复用：速度前瞻位移（ECEF，米）。 */
    private scratchEcefVelocity = new Cartesian3();
    /** 复用：速度前瞻后的预测位置（ECEF）。 */
    private scratchPredicted = new Cartesian3();

    /** 从配置初始化流式参数并创建 Cesium 地形 mesh 适配器。 */
    constructor(
        private viewer: Viewer,
        private physics: PhysicsSystem,
        options: StreamingTerrainCollider,
        private debugHooks: TerrainDebugHooks = {},
    ) {
        this.level = Math.max(0, Math.floor(options.level ?? 16));
        this.radius = Math.max(1, options.radius ?? 350);
        this.releaseRadius = Math.max(this.radius, options.releaseRadius ?? this.radius * 1.5);
        this.lookAheadSeconds = Math.max(0, options.lookAheadSeconds ?? 1);
        this.fallbackDelayMs = Math.max(0, options.fallbackDelayMs ?? 250);
        this.maxConcurrentRequests = Math.max(1, Math.floor(options.maxConcurrentRequests ?? 2));
        this.maxBuildsPerFrame = Math.max(1, Math.floor(options.maxBuildsPerFrame ?? 1));
        this.maxActiveTiles = Math.max(1, Math.floor(options.maxActiveTiles ?? 48));
        this.rebaseDistance = Math.max(100, options.rebaseDistance ?? 10_000);

        this.adapter = new CesiumTerrainMeshAdapter(
            viewer,
            (event) => this.acceptMesh(event),
            () => this.resetForProviderChange(),
            options.maxCachedMeshes ?? 64,
        );
    }

    /** 启动 mesh 适配器（监听 Cesium 加载与 postRender 扫描）。 */
    start() { this.adapter.start(); }

    /**
     * Rapier 局部系 rebase 后，将仍活跃瓦片的 mesh 重新入队构建碰撞体。
     * 顶点需按新 anchor 重算 Rapier 坐标。
     */
    refreshAfterRebase() {
        for (const entry of this.entries.values()) {
            if (!entry.colliderReady) continue;
            const mesh = this.adapter.getCached(entry.key);
            if (mesh) this.buildQueue.set(entry.key, mesh);
        }
    }

    /**
     * 控制器初始化完成前，同步构建出生点所在瓦片的碰撞体，避免首帧穿地。
     * @returns 是否已成功创建脚下 collider
     */
    async prime(positionEcef: Cartesian3): Promise<boolean> {
        this.update(positionEcef, { e: 0, n: 0, u: 0 });
        const key = this.currentTileKey;
        const entry = key ? this.entries.get(key) : undefined;
        if (!entry || entry.colliderReady) return !!entry?.colliderReady;
        try {
            const mesh = this.adapter.getCached(key!) ?? await this.adapter.requestMesh(entry);
            if (this.disposed || this.entries.get(entry.key) !== entry) return false;
            const tri = this.decodeMesh(mesh);
            this.installTileCollider(entry, tri);
            this.buildQueue.delete(entry.key);
            return true;
        } catch (error) {
            entry.nextRequestAt = now();
            console.warn(`预加载地形碰撞体 ${entry.key} 失败，流式加载将继续重试`, error);
            return false;
        }
    }

    /**
     * 每帧根据玩家 ECEF 位置与 ENU 速度更新活跃瓦片集合。
     * 含速度前瞻、滞回卸载、兜底请求与限流建网。
     */
    update(positionEcef: Cartesian3, velocityEnu: { e: number; n: number; u: number }) {
        if (this.disposed) return;
        const provider = this.adapter.provider;
        const tilingScheme = provider?.tilingScheme;
        if (!tilingScheme) return;

        this.frameNumber++;
        // 速度前瞻：预测 lookAheadSeconds 后的位置，用于决定预加载范围
        const velocity = new Cartesian3(velocityEnu.e, velocityEnu.n, velocityEnu.u);
        this.physics.frame.enuVectorToEcef(velocity, this.scratchEcefVelocity);
        Cartesian3.multiplyByScalar(this.scratchEcefVelocity, this.lookAheadSeconds, this.scratchEcefVelocity);
        Cartesian3.add(positionEcef, this.scratchEcefVelocity, this.scratchPredicted);

        const ellipsoid = tilingScheme.ellipsoid;
        const cartographic = ellipsoid.cartesianToCartographic(this.scratchPredicted, this.scratchCartographic);
        if (!cartographic) return;
        const centerTile = tilingScheme.positionToTileXY(cartographic, this.level, this.scratchTile);
        if (!centerTile) return;
        this.currentTileKey = terrainTileKey(this.level, centerTile.x, centerTile.y);

        // 估算瓦片地表尺寸，换算 radius 需要覆盖的 x/y 瓦片范围
        const centerRect = tilingScheme.tileXYToRectangle(centerTile.x, centerTile.y, this.level);
        const radiusAtLatitude = ellipsoid.maximumRadius * Math.max(0.01, Math.cos(cartographic.latitude));
        const tileWidth = Math.max(1, Rectangle.computeWidth(centerRect) * radiusAtLatitude);
        const tileHeight = Math.max(1, (centerRect.north - centerRect.south) * ellipsoid.maximumRadius);
        const rangeX = Math.ceil(this.radius / tileWidth) + 1;
        const rangeY = Math.ceil(this.radius / tileHeight) + 1;
        const xCount = tilingScheme.getNumberOfXTilesAtLevel(this.level);
        const yCount = tilingScheme.getNumberOfYTilesAtLevel(this.level);
        const timestamp = now();
        const wanted: Array<{
            key: string; x: number; y: number; longitude: number; latitude: number;
            halfDiagonal: number; distance: number;
        }> = [];

        for (let dy = -rangeY; dy <= rangeY; dy++) {
            const y = centerTile.y + dy;
            if (y < 0 || y >= yCount) continue;
            for (let dx = -rangeX; dx <= rangeX; dx++) {
                // 经度方向瓦片 X 环绕
                const x = ((centerTile.x + dx) % xCount + xCount) % xCount;
                const rect = tilingScheme.tileXYToRectangle(x, y, this.level);
                const center = Rectangle.center(rect, new Cartographic());
                const halfDiagonal = 0.5 * Math.hypot(
                    Rectangle.computeWidth(rect) * ellipsoid.maximumRadius * Math.max(0.01, Math.cos(center.latitude)),
                    (rect.north - rect.south) * ellipsoid.maximumRadius,
                );
                const distance = this.surfaceDistance(cartographic, center, ellipsoid.maximumRadius);
                if (distance > this.radius + halfDiagonal) continue;
                const key = terrainTileKey(this.level, x, y);
                wanted.push({ key, x, y, longitude: center.longitude, latitude: center.latitude, halfDiagonal, distance });
            }
        }

        // 按距离排序，限制 maxActiveTiles；保证脚下瓦片始终在内
        wanted.sort((a, b) => a.distance - b.distance);
        const active = wanted.slice(0, this.maxActiveTiles);
        const current = wanted.find((tile) => tile.key === this.currentTileKey);
        if (current && !active.includes(current)) active[Math.max(0, active.length - 1)] = current;
        for (const tile of active) {
            const { key, x, y, longitude, latitude, halfDiagonal, distance } = tile;
            let entry = this.entries.get(key);
            if (!entry) {
                entry = {
                    key, x, y, level: this.level,
                    longitude,
                    latitude,
                    halfDiagonal,
                    distance,
                    wantedFrame: this.frameNumber,
                    firstWantedAt: timestamp,
                    nextRequestAt: timestamp + this.fallbackDelayMs,
                    requesting: false,
                    colliderReady: false,
                };
                this.entries.set(key, entry);
                const cached = this.adapter.getCached(key);
                if (cached) this.buildQueue.set(key, cached);
            } else {
                entry.wantedFrame = this.frameNumber;
                entry.distance = distance;
            }
        }

        this.releaseOldTiles(cartographic, ellipsoid.maximumRadius);
        this.queueFallbackRequests(timestamp);
        this.buildPendingMeshes();
    }

    /** 为已就绪的活跃瓦片补建 debug 线框。 */
    syncDebugTiles() {
        for (const entry of this.entries.values()) {
            if (!entry.colliderReady) continue;
            const mesh = this.adapter.getCached(entry.key);
            if (!mesh) continue;
            try {
                const tri = this.decodeMesh(mesh);
                this.debugHooks.onTileDebugAdd?.(entry.key, tri.debugLinesEcef);
            } catch {
                // 缓存 mesh 不完整时跳过
            }
        }
    }

    /** 移除所有 Rapier 碰撞体并销毁 mesh 适配器。 */
    destroy() {
        this.disposed = true;
        this.adapter.destroy();
        for (const entry of this.entries.values()) {
            if (entry.colliderReady) {
                this.physics.removeTerrainTileCollider(entry.key);
                this.debugHooks.onTileDebugRemove?.(entry.key);
            }
        }
        this.debugHooks.onTileDebugClear?.();
        this.entries.clear();
        this.buildQueue.clear();
        this.currentTileKey = null;
    }

    /** 适配器监听到 mesh 时：仅当该瓦片本帧仍被需要才入构建队列。 */
    private acceptMesh(event: TerrainMeshEvent) {
        const entry = this.entries.get(event.key);
        if (!entry || entry.wantedFrame !== this.frameNumber) return;
        this.buildQueue.set(event.key, event.mesh);
    }

    /**
     * 对仍未就绪的瓦片发起兜底 requestMesh。
     * 受 maxConcurrentRequests 与 fallbackDelayMs 限制。
     */
    private queueFallbackRequests(timestamp: number) {
        if (this.inFlight >= this.maxConcurrentRequests) return;
        const candidates = [...this.entries.values()]
            .filter((entry) => entry.wantedFrame === this.frameNumber && !entry.colliderReady && !entry.requesting && entry.nextRequestAt <= timestamp)
            .sort((a, b) => a.distance - b.distance || a.firstWantedAt - b.firstWantedAt);

        for (const entry of candidates) {
            if (this.inFlight >= this.maxConcurrentRequests) break;
            entry.requesting = true;
            this.inFlight++;
            const generation = this.requestGeneration;
            this.adapter.requestMesh(entry).then((mesh) => {
                const current = this.entries.get(entry.key);
                if (current && current.wantedFrame === this.frameNumber) this.buildQueue.set(entry.key, mesh);
            }).catch(() => {
                const current = this.entries.get(entry.key);
                if (current) current.nextRequestAt = now() + 500;
            }).finally(() => {
                entry.requesting = false;
                // provider 切换后忽略旧 generation 的 inFlight 计数
                if (generation === this.requestGeneration) this.inFlight--;
            });
        }
    }

    /** 每帧限流将 buildQueue 中的 mesh 解码并注册为 Rapier trimesh，优先近处瓦片。 */
    private buildPendingMeshes() {
        let built = 0;
        const pending = [...this.buildQueue.entries()].sort((a, b) =>
            (this.entries.get(a[0])?.distance ?? Number.POSITIVE_INFINITY) -
            (this.entries.get(b[0])?.distance ?? Number.POSITIVE_INFINITY),
        );
        for (const [key, mesh] of pending) {
            if (built >= this.maxBuildsPerFrame) break;
            this.buildQueue.delete(key);
            const entry = this.entries.get(key);
            if (!entry || entry.wantedFrame !== this.frameNumber) continue;
            try {
                const tri = this.decodeMesh(mesh);
                this.installTileCollider(entry, tri);
                built++;
            } catch (error) {
                entry.nextRequestAt = now() + 1000;
                console.warn(`构建地形碰撞体 ${key} 失败`, error);
            }
        }
    }

    /**
     * 将 Cesium TerrainMesh 解码为 Rapier 局部坐标三角网，并一次性生成 ECEF debug 线段。
     * 排除 terrain skirt，避免接缝处产生垂直碰撞墙。
     */
    private decodeMesh(mesh: CesiumTerrainMeshLike): DecodedTerrainMesh {
        const vertexCount = Math.min(mesh.vertexCountWithoutSkirts, Math.floor(mesh.vertices.length));
        const indexCount = Math.floor(Math.min(mesh.indexCountWithoutSkirts, mesh.indices.length) / 3) * 3;
        if (!(vertexCount > 0) || indexCount < 3) throw new Error("TerrainMesh has no non-skirt triangles");

        const positions = new Float32Array(vertexCount * 3);
        const vertexEcef = new Float64Array(vertexCount * 3);
        const ecef = new Cartesian3();
        // 优先使用含垂直夸张的位置解码
        const decode = mesh.encoding.getExaggeratedPosition?.bind(mesh.encoding) ?? mesh.encoding.decodePosition.bind(mesh.encoding);
        for (let i = 0; i < vertexCount; i++) {
            decode(mesh.vertices, i, ecef);
            vertexEcef[i * 3] = ecef.x;
            vertexEcef[i * 3 + 1] = ecef.y;
            vertexEcef[i * 3 + 2] = ecef.z;
            const point = this.physics.frame.ecefToRapier(ecef);
            positions[i * 3] = point.x;
            positions[i * 3 + 1] = point.y;
            positions[i * 3 + 2] = point.z;
        }
        const indices = new Uint32Array(indexCount);
        for (let i = 0; i < indexCount; i++) {
            const index = mesh.indices[i];
            if (index >= vertexCount) throw new Error("TerrainMesh non-skirt index references a skirt vertex");
            indices[i] = index;
        }
        return {
            positions,
            indices,
            debugLinesEcef: buildWireframeLinesEcef(vertexEcef, indices),
        };
    }

    /** 注册单块瓦片碰撞体，并按需增量创建 debug 线框。 */
    private installTileCollider(entry: TileEntry, tri: DecodedTerrainMesh) {
        this.physics.addTerrainTileCollider(entry.key, tri.positions, tri.indices);
        entry.colliderReady = true;
        this.debugHooks.onTileDebugAdd?.(entry.key, tri.debugLinesEcef);
    }

    /** 卸载超出 releaseRadius 且本帧未标记为 wanted 的瓦片碰撞体（滞回卸载）。 */
    private releaseOldTiles(position: Cartographic, radius: number) {
        for (const [key, entry] of this.entries) {
            if (entry.wantedFrame === this.frameNumber) continue;
            const center = new Cartographic(entry.longitude, entry.latitude, 0);
            if (this.surfaceDistance(position, center, radius) <= this.releaseRadius + entry.halfDiagonal) continue;
            if (entry.colliderReady) {
                this.physics.removeTerrainTileCollider(key);
                this.debugHooks.onTileDebugRemove?.(key);
            }
            this.entries.delete(key);
            this.buildQueue.delete(key);
        }
    }

    /** terrain provider 切换时清空状态、递增 generation 使进行中的异步请求失效。 */
    private resetForProviderChange() {
        for (const entry of this.entries.values()) {
            if (entry.colliderReady) {
                this.physics.removeTerrainTileCollider(entry.key);
                this.debugHooks.onTileDebugRemove?.(entry.key);
            }
        }
        this.debugHooks.onTileDebugClear?.();
        this.entries.clear();
        this.buildQueue.clear();
        this.currentTileKey = null;
        this.requestGeneration++;
        this.inFlight = 0;
    }

    /** 两经纬度点之间的近似地表距离（米）。 */
    private surfaceDistance(a: Cartographic, b: Cartographic, radius: number): number {
        const dLat = b.latitude - a.latitude;
        const dLon = CMath.negativePiToPi(b.longitude - a.longitude);
        return radius * Math.hypot(dLat, dLon * Math.cos((a.latitude + b.latitude) * 0.5));
    }
}
