import type RAPIER from "@dimforge/rapier3d-compat";
import { Cartesian3, sampleTerrainMostDetailed, Cartographic, Math as CMath, Matrix4, Transforms, HeadingPitchRoll } from "cesium";
import { LocalFrame } from "../utils/frame";
import { loadGltfGeometry } from "../utils/gltfGeometry";
import type { ColliderSource, TriMeshCollider } from "../types";

export interface CharacterShapeDesc {
    radius: number; // 胶囊半径
    halfHeight: number; // 胶囊圆柱段半高
}

export interface CharacterControllerOpts {
    maxSlopeClimbDeg?: number; // 最大爬坡角度(度)
    minSlopeSlideDeg?: number; // 超过此坡度下滑
    autostepMaxHeight?: number; // 最大自动步进高度(米)
    autostepMinWidth?: number; // 最小自动步进宽度(米)
    snapToGroundDist?: number; // 自动吸附到地面距离(米)
}

// Rapier 模块
let R: typeof RAPIER | null = null;

// 初始化 Rapier 模块
export async function initRapier(): Promise<typeof RAPIER> {
    if (R) return R;
    const mod = await import("@dimforge/rapier3d-compat");
    await mod.init();
    R = mod;
    return R;
}

// 物理系统
export class PhysicsSystem {
    frame: LocalFrame; // 本地坐标系
    world!: RAPIER.World; // 物理世界
    private rapier!: typeof RAPIER; // Rapier 模块（实例持有）

    // 玩家
    charController!: RAPIER.KinematicCharacterController; // 玩家角色控制器
    charBody!: RAPIER.RigidBody; // 玩家胶囊刚体
    charCollider!: RAPIER.Collider; // 玩家胶囊碰撞体
    private shape!: CharacterShapeDesc; // 玩家胶囊形状参数(半径/半高)

    // 碰撞体登记
    private staticColliders: RAPIER.Collider[] = []; // 静态碰撞体
    private dynamicBodies = new Map<RAPIER.RigidBody, RAPIER.Collider>(); // 动态刚体
    dynamicBySource = new Map<object, RAPIER.RigidBody>(); // 动态刚体登记（按来源对象索引）
    activeDynamicSource: object | null = null; // 当前玩家站立的动态碰撞源

    onGround = false; // 是否在地面上

    constructor(frame: LocalFrame) {
        this.frame = frame;
    }

    // 创建物理世界。gravity 为 ENU 局部系下的重力
    async create(gravityY: number) {
        this.rapier = await initRapier(); // 初始化 Rapier 模块
        this.world = new this.rapier.World({ x: 0, y: gravityY, z: 0 }); // 创建物理世界 （重力沿 -Y）
    }

    // 设置物理世界重力
    setGravity(gravityY: number) {
        this.world.gravity = { x: 0, y: gravityY, z: 0 };
    }

    // ==================== 玩家角色 ====================

    // 创建玩家胶囊 + 角色控制器,放在指定 ECEF 位置
    createCharacter(positionEcef: Cartesian3, shape: CharacterShapeDesc, opts?: {
        maxSlopeClimbDeg?: number; // 最大爬坡角度(度)
        minSlopeSlideDeg?: number; // 超过此坡度下滑
        autostepMaxHeight?: number; // 最大自动步进高度(米)
        autostepMinWidth?: number; // 最小自动步进宽度(米)
        snapToGroundDist?: number; // 自动吸附到地面距离(米)
    }) {
        this.shape = shape; // 缓存形状参数,后续重建胶囊几何用
        const r = this.rapier;
        const p = this.frame.ecefToRapier(positionEcef); // ECEF 转换为 Rapier 局部系

        // 运动学(位置驱动)刚体:角色由控制器算位移,不被力推
        const bodyDesc = r.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z);
        this.charBody = this.world.createRigidBody(bodyDesc);

        // 胶囊碰撞体(参数为圆柱段半高 + 半径),挂到上面的刚体上
        const colDesc = r.ColliderDesc.capsule(shape.halfHeight, shape.radius);
        this.charCollider = this.world.createCollider(colDesc, this.charBody);

        // 角色控制器(offset = 碰撞外皮厚度)
        const offset = shape.radius * 0.05;
        this.charController = this.world.createCharacterController(offset);
        // 可爬升的最大坡度:超过则视为墙,不再向上走
        this.charController.setMaxSlopeClimbAngle(CMath.toRadians(opts?.maxSlopeClimbDeg ?? 50));
        // 触发下滑的最小坡度:陡于此值时角色会沿坡下滑
        this.charController.setMinSlopeSlideAngle(CMath.toRadians(opts?.minSlopeSlideDeg ?? 60));
        // 自动步进:可自动迈上不超过该高度的台阶/障碍(宽度默认取半径的一半)
        if (opts?.autostepMaxHeight) {
            this.charController.enableAutostep(opts.autostepMaxHeight, opts.autostepMinWidth ?? shape.radius * 0.5, true);
        }
        // 吸附地面:在该距离内自动贴地,避免下坡/小落差时悬空抖动
        this.charController.enableSnapToGround(opts?.snapToGroundDist ?? shape.radius * 0.5);
        // 允许角色推动动态刚体
        this.charController.setApplyImpulsesToDynamicBodies(true);
    }

    // 更新玩家胶囊尺寸
    updateCharacterShape(shape: CharacterShapeDesc) {
        this.shape = shape; // 同步缓存
        this.charCollider.setRadius(shape.radius);
        this.charCollider.setHalfHeight(shape.halfHeight);
    }


    // 向下射线测胶囊中心到地面的距离
    groundDistance(maxDist: number): number {
        const t = this.charBody.translation();
        const ray = new this.rapier.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
        const hit = this.world.castRay(
            ray, maxDist, true,
            undefined, undefined, this.charCollider, this.charBody,
        );
        return hit ? hit.timeOfImpact : Infinity;
    }

    /**
     * 任意方向 ECEF 射线测最近碰撞距离。用于相机避障：从玩家朝相机方向投射。
     * @param originEcef 射线起点（ECEF）
     * @param dirEcef 射线方向（ECEF，需归一化）
     * @param maxDist 最大检测距离（米）
     * @returns 命中距离（米）；未命中返回 Infinity
     */
    raycastEcef(originEcef: Cartesian3, dirEcef: Cartesian3, maxDist: number): number {
        // ECEF 起点/方向 → Rapier 局部系。
        const o = this.frame.ecefToRapier(originEcef);
        // 方向：ECEF → ENU 向量 → Rapier 轴交换
        const localDir = this.frame.ecefVectorToEnu(dirEcef, this._scratchDir);
        const d = LocalFrame.enuToRapier(localDir.x, localDir.y, localDir.z);
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        const ray = new this.rapier.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x / len, y: d.y / len, z: d.z / len });
        const hit = this.world.castRay(
            ray, maxDist, true,
            undefined, undefined, this.charCollider, this.charBody,
        );
        return hit ? hit.timeOfImpact : Infinity;
    }
    private _scratchDir = new Cartesian3();

    /**
     * 同 raycastEcef，但返回命中点 + 表面法线（均 ECEF）而非距离。
     * 用 castRayAndGetNormal 拿命中法线，ray.pointAt(toi) 取命中点，再转回 ECEF。
     * @param originEcef 射线起点（ECEF）
     * @param dirEcef 射线方向（ECEF，需归一化）
     * @param maxDist 最大检测距离（米）
     * @returns { distance, point, normal }；未命中返回 undefined
     */
    raycastEcefHit(originEcef: Cartesian3, dirEcef: Cartesian3, maxDist: number): { distance: number; point: Cartesian3; normal: Cartesian3 } | undefined {
        const o = this.frame.ecefToRapier(originEcef); // 起点:ECEF → Rapier 局部系
        // 方向:ECEF → ENU 向量 → Rapier 轴交换，再归一化
        const localDir = this.frame.ecefVectorToEnu(dirEcef, this._scratchDir);
        const d = LocalFrame.enuToRapier(localDir.x, localDir.y, localDir.z);
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        const ray = new this.rapier.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x / len, y: d.y / len, z: d.z / len });
        // 投射并取命中法线，排除角色自身的碰撞体/刚体
        const hit = this.world.castRayAndGetNormal(
            ray, maxDist, true,
            undefined, undefined, this.charCollider, this.charBody,
        );
        if (!hit) return undefined; // 未命中
        // Rapier 局部命中点 → ECEF
        const p = ray.pointAt(hit.timeOfImpact);
        const point = this.frame.rapierToEcef(p.x, p.y, p.z);
        // Rapier 局部法线（向量）→ ENU → ECEF（只旋转不平移），再归一化
        const nEnu = LocalFrame.rapierToEnu(hit.normal.x, hit.normal.y, hit.normal.z, this._scratchNormal);
        const normal = this.frame.enuVectorToEcef(nEnu, new Cartesian3());
        Cartesian3.normalize(normal, normal);
        return { distance: hit.timeOfImpact, point, normal };
    }
    private _scratchNormal = new Cartesian3();

    /**
     * 用期望位移驱动角色一步。
     * @param desiredEnu 本帧期望位移，ENU 分量 {e,n,u}(米)
     * @returns 角色新的 ECEF 位置
     */
    moveCharacter(desiredEnu: { e: number; n: number; u: number }, outEcef = new Cartesian3()): Cartesian3 {
        // 期望位移:ENU → Rapier 轴交换
        const desired = LocalFrame.enuToRapier(desiredEnu.e, desiredEnu.n, desiredEnu.u);
        // 控制器解算碰撞
        this.charController.computeColliderMovement(this.charCollider, desired);
        const corrected = this.charController.computedMovement();
        // 当前位置 + 修正位移 = 下一帧目标位置
        const t = this.charBody.translation();
        const next = { x: t.x + corrected.x, y: t.y + corrected.y, z: t.z + corrected.z };
        // 物理步插值到目标
        this.charBody.setNextKinematicTranslation(next);
        // 新位置转回 ECEF 返回
        return this.frame.rapierToEcef(next.x, next.y, next.z, outEcef);
    }

    // 仅静态碰撞体(地形/glTF 等 trimesh)的调试线段 → ECEF。静态不动。
    buildStaticDebugLinesEcef(): Float64Array {
        const meshes: { v: Float32Array; i: Uint32Array }[] = [];
        let triCount = 0;
        for (const col of this.staticColliders) {
            // trimesh 顶点/索引在 shape 上
            const shape = col.shape as { vertices?: Float32Array; indices?: Uint32Array };
            const v = shape.vertices, i = shape.indices;
            if (!v || !i || v.length === 0 || i.length === 0) continue;
            meshes.push({ v, i });
            triCount += i.length / 3;
        }
        const out = new Float64Array(triCount * 18); // 每三角 3 边 × 2 点 × 3 坐标
        const c = new Cartesian3();
        let o = 0;
        const emit = (v: Float32Array, a: number) => {
            this.frame.rapierToEcef(v[a], v[a + 1], v[a + 2], c);
            out[o++] = c.x; out[o++] = c.y; out[o++] = c.z;
        };
        for (const { v, i } of meshes) {
            for (let t = 0; t < i.length; t += 3) {
                const a = i[t] * 3, b = i[t + 1] * 3, d = i[t + 2] * 3;
                emit(v, a); emit(v, b); // 边 AB
                emit(v, b); emit(v, d); // 边 BC
                emit(v, d); emit(v, a); // 边 CA
            }
        }
        return out;
    }

    // 玩家胶囊调试线框(ENU 局部空间,只建一次):2 个水平环 + 2 个竖直轮廓环,摆放由 modelMatrix 负责。
    buildCapsuleDebugLocal(seg = 24): Float64Array {
        if (!this.shape) return new Float64Array(0);
        const r = this.shape.radius, hh = this.shape.halfHeight;
        const pts: number[] = []; // ENU 局部坐标:x=E, y=N, z=U(胶囊轴沿 z)
        const line = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
            pts.push(x1, y1, z1, x2, y2, z2);

        // 2 个水平环(z = ±halfHeight,在 E-N 平面)
        for (const lvl of [hh, -hh]) {
            for (let k = 0; k < seg; k++) {
                const a1 = (k / seg) * 2 * Math.PI, a2 = ((k + 1) / seg) * 2 * Math.PI;
                line(
                    r * Math.cos(a1), r * Math.sin(a1), lvl,
                    r * Math.cos(a2), r * Math.sin(a2), lvl,
                );
            }
        }
        // 2 个竖直轮廓环(在含 z 轴的平面,phi = 0 与 90°),stadium 参数:上/下半球用 ±hh 偏移
        for (const phi of [0, Math.PI / 2]) {
            const dx = Math.cos(phi), dy = Math.sin(phi);
            let ph = r, pv = hh; // a = 0 起点
            for (let k = 1; k <= seg; k++) {
                const a = (k / seg) * 2 * Math.PI;
                const h = r * Math.cos(a);
                const v = (Math.sin(a) >= 0 ? hh : -hh) + r * Math.sin(a);
                line(ph * dx, ph * dy, pv, h * dx, h * dy, v);
                ph = h; pv = v;
            }
        }
        return new Float64Array(pts);
    }

    // 胶囊线框 modelMatrix(每帧):enuToEcef · 平移(角色 ENU 位置),把局部几何摆到当前 ECEF 位置。
    getCapsuleModelMatrix(out = new Matrix4()): Matrix4 {
        const t = this.charBody.translation(); // Rapier 空间胶囊中心
        const enu = LocalFrame.rapierToEnu(t.x, t.y, t.z, this._capScratchEnu); // → ENU(Z-up)
        Matrix4.fromTranslation(enu, this._capScratchTrans);
        return Matrix4.multiply(this.frame.enuToEcef, this._capScratchTrans, out);
    }
    private _capScratchEnu = new Cartesian3();
    private _capScratchTrans = new Matrix4();

    // 直接把角色瞬移到某 ECEF(reset 用)
    teleportCharacter(positionEcef: Cartesian3) {
        const p = this.frame.ecefToRapier(positionEcef);
        this.charBody.setTranslation(p, true);
        this.charBody.setNextKinematicTranslation(p);
    }

    // 步进物理世界
    step() {
        this.world.step();
    }

    // ==================== 碰撞源 → Rapier collider ====================

    // 注册一批静态碰撞源
    async addStaticColliders(viewer: any, sources: ColliderSource | ColliderSource[]) {
        const list = Array.isArray(sources) ? sources : [sources];
        // 下载 + 解析并行
        const results = await Promise.allSettled(list.map((s) => this.resolveTriMesh(viewer, s)));
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "rejected") { console.warn(`静态碰撞源[${i}]加载失败,已跳过:`, r.reason); continue; }
            const tri = r.value;
            if (!tri) continue;
            this.staticColliders.push(this.world.createCollider(this.triColliderDesc(tri)));
        }
    }

    // 注册一个动态(可移动)碰撞源,返回其刚体以便外部每帧驱动
    async addDynamicCollider(viewer: any, source: ColliderSource): Promise<RAPIER.RigidBody | null> {
        const r = this.rapier;
        const tri = await this.resolveTriMesh(viewer, source);
        if (!tri) return null;
        const body = this.world.createRigidBody(r.RigidBodyDesc.kinematicPositionBased());
        const col = this.world.createCollider(this.triColliderDesc(tri), body);
        this.dynamicBodies.set(body, col);
        return body;
    }

    // 移除动态碰撞源(按来源对象)
    removeDynamicCollider(source: object) {
        const body = this.dynamicBySource.get(source);
        if (!body) return;
        this.dynamicBodies.delete(body);
        this.dynamicBySource.delete(source);
        if (this.activeDynamicSource === source) this.activeDynamicSource = null;
        this.world.removeRigidBody(body); // 连带移除其 collider
    }

    // 清除所有动态碰撞源
    clearDynamicColliders() {
        for (const body of this.dynamicBodies.keys()) this.world.removeRigidBody(body);
        this.dynamicBodies.clear();
        this.dynamicBySource.clear();
        this.activeDynamicSource = null;
    }

    // 驱动动态刚体到新位置/朝向(ECEF) 
    setDynamicBodyTransform(body: RAPIER.RigidBody, positionEcef: Cartesian3) {
        const p = this.frame.ecefToRapier(positionEcef);
        body.setNextKinematicTranslation(p);
    }

    private triColliderDesc(tri: TriMeshCollider): RAPIER.ColliderDesc {
        const r = this.rapier;
        const pos = tri.positions instanceof Float32Array ? tri.positions : new Float32Array(tri.positions);
        const idx = tri.indices instanceof Uint32Array ? tri.indices : new Uint32Array(tri.indices);
        return r.ColliderDesc.trimesh(pos, idx);
    }

    // 把碰撞源(trimesh / gltf / terrain)统一解析成 Rapier 局部空间的三角网。
    private async resolveTriMesh(viewer: any, s: ColliderSource): Promise<TriMeshCollider | null> {
        if (s.type === "trimesh") {
            // 输入 positions 视为 ECEF,逐点映射到 Rapier 局部空间
            const src = s.positions instanceof Float32Array ? s.positions : new Float32Array(s.positions);
            const out = new Float32Array(src.length);
            const c = new Cartesian3();
            for (let i = 0; i < src.length; i += 3) {
                c.x = src[i]; c.y = src[i + 1]; c.z = src[i + 2];
                const rp = this.frame.ecefToRapier(c);
                out[i] = rp.x; out[i + 1] = rp.y; out[i + 2] = rp.z;
            }
            return { type: "trimesh", positions: out, indices: s.indices };
        }
        if (s.type === "terrain") {
            return this.terrainToTriMesh(viewer, s.rectangle, s.resolution ?? 64);
        }
        if (s.type === "gltf") {
            return this.gltfToTriMesh(s);
        }
        return null;
    }

    // glTF/glb → Rapier 三角网:模型局部几何
    private async gltfToTriMesh(s: Extract<ColliderSource, { type: "gltf" }>): Promise<TriMeshCollider> {
        const geo = await loadGltfGeometry(s.url);

        // 模型局部 → ECEF 的摆放矩阵
        let placement: Matrix4;
        if (s.modelMatrix && s.modelMatrix.length === 16) {
            placement = Matrix4.fromColumnMajorArray(s.modelMatrix, new Matrix4());
        } else if (s.position) {
            const rot = s.rotation;
            if (rot && (rot.heading || rot.pitch || rot.roll)) {
                // 用 HPR 在本地 ENU 系内旋转(度→弧度)
                const hpr = new HeadingPitchRoll(
                    CMath.toRadians(rot.heading ?? 0),
                    CMath.toRadians(rot.pitch ?? 0),
                    CMath.toRadians(rot.roll ?? 0),
                );
                placement = Transforms.headingPitchRollToFixedFrame(s.position, hpr, undefined, undefined, new Matrix4());
            } else {
                placement = Transforms.eastNorthUpToFixedFrame(s.position, undefined, new Matrix4());
            }
            // 统一缩放
            if (s.scale && s.scale !== 1) Matrix4.multiplyByUniformScale(placement, s.scale, placement);
        } else {
            placement = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
        }

        const src = geo.positions;
        const out = new Float32Array(src.length);
        const local = new Cartesian3();
        const ecef = new Cartesian3();
        for (let i = 0; i < src.length; i += 3) {
            local.x = src[i]; local.y = src[i + 1]; local.z = src[i + 2];
            Matrix4.multiplyByPoint(placement, local, ecef); // 局部 → ECEF
            const rp = this.frame.ecefToRapier(ecef); // ECEF → Rapier
            out[i] = rp.x; out[i + 1] = rp.y; out[i + 2] = rp.z;
        }
        return { type: "trimesh", positions: out, indices: geo.indices };
    }

    // 采样 Cesium 地形 → 高度场三角网(ECEF 转 Rapier)
    private async terrainToTriMesh(
        viewer: any,
        rect: [number, number, number, number],
        res: number,
    ): Promise<TriMeshCollider> {
        const provider = viewer.terrainProvider;
        const hasTerrain = !!provider && provider.constructor?.name !== "EllipsoidTerrainProvider";

        const [west, south, east, north] = rect;
        const carts: Cartographic[] = [];
        for (let j = 0; j < res; j++) {
            for (let i = 0; i < res; i++) {
                const lon = CMath.lerp(west, east, i / (res - 1));
                const lat = CMath.lerp(south, north, j / (res - 1));
                carts.push(new Cartographic(lon, lat, 0));
            }
        }
        // 有地形才采样;无地形保持 height=0(贴椭球面)
        if (hasTerrain) await sampleTerrainMostDetailed(provider, carts);

        const positions = new Float32Array(res * res * 3);
        const c = new Cartesian3();
        for (let k = 0; k < carts.length; k++) {
            Cartesian3.fromRadians(carts[k].longitude, carts[k].latitude, carts[k].height, undefined, c);
            const rp = this.frame.ecefToRapier(c);
            positions[k * 3] = rp.x; positions[k * 3 + 1] = rp.y; positions[k * 3 + 2] = rp.z;
        }

        // 生成网格索引
        const indices: number[] = [];
        for (let j = 0; j < res - 1; j++) {
            for (let i = 0; i < res - 1; i++) {
                const a = j * res + i;
                const b = a + 1;
                const d = a + res;
                const e = d + 1;
                indices.push(a, d, b, b, d, e);
            }
        }
        return { type: "trimesh", positions, indices: new Uint32Array(indices) };
    }

    // 销毁物理系统
    destroy() {
        this.staticColliders = [];
        this.dynamicBodies.clear();
        if (this.world) this.world.free();
    }
}
