import type { Cartesian3, Matrix4, Model, Primitive, Viewer } from "cesium";
import type { DynamicRayCastVehicleController, RigidBody } from "@dimforge/rapier3d-compat";

// ==================== 碰撞体来源 ====================

// glTF/glb 碰撞源:运行时 fetch + 解析出三角网
export type GltfCollider = {
    type: "gltf";
    url: string;
    // 模型在 ECEF 中的摆放点(与视觉模型一致)。不传则按 modelMatrix;都不传则视几何已在 ECEF。
    position?: Cartesian3;
    // 仅在用 position 摆放时生效;传了 modelMatrix 则忽略。
    rotation?: { heading?: number; pitch?: number; roll?: number };
    // 统一缩放倍率,默认 1。仅在用 position 摆放时生效。
    scale?: number;
    modelMatrix?: number[]; // 16 元素,列主序 ECEF;传了则忽略 position/rotation/scale
};

// Cesium 地形 → 采样成高度场
export type TerrainCollider = {
    type: "terrain";
    // 采样矩形范围 [west, south, east, north](弧度)
    rectangle: [number, number, number, number];
    // 采样网格分辨率,默认 64x64
    resolution?: number;
};

// 流式地形碰撞体
export type StreamingTerrainCollider = {
    type: "streaming-terrain";
    /** 物理用地形四叉树层级。默认 16。 */
    level?: number;
    /** 预测玩家位置周围需加载碰撞的半径（米）。默认 350。 */
    radius?: number;
    /** 已加载瓦片保留到此半径外才卸载（米，滞回）。默认 radius * 1.5。 */
    releaseRadius?: number;
    /** 速度前瞻秒数，用于预加载前方瓦片。默认 1.0。 */
    lookAheadSeconds?: number;
    /** 等待 Cesium 自身加载后再发起缺失瓦片兜底请求的延迟（毫秒）。默认 250。 */
    fallbackDelayMs?: number;
    /** 同时进行的最大兜底地形请求数。默认 2。 */
    maxConcurrentRequests?: number;
    /** 单次 update 内最多创建的 Rapier trimesh 数量。默认 1。 */
    maxBuildsPerFrame?: number;
    /** 同时活跃的最大瓦片数（极区瓦片变窄时重要）。默认 48。 */
    maxActiveTiles?: number;
    /** 适配器缓存的已解码 Cesium TerrainMesh 上限。默认 64。 */
    maxCachedMeshes?: number;
    /** 水平移动超过此距离后重锚 Rapier 局部世界（米）。默认 10000。 */
    rebaseDistance?: number;
};

export type ColliderSource =
    | GltfCollider
    | TerrainCollider
    | StreamingTerrainCollider;

// ==================== 动态物体形状  ====================
// 受物理模拟、可被角色推动的动态物体的几何

export type DynamicShape =
    // 球：radius 米
    | { kind: "ball"; radius: number }
    // 方块：half 为 ENU 三轴半边长（米）
    | { kind: "box"; half: { e: number; n: number; u: number } }
    // 圆柱：轴沿 ENU Up，halfHeight 半高 + radius 半径（米）
    | { kind: "cylinder"; halfHeight: number; radius: number }
    // 圆锥：轴沿 ENU Up（尖朝上），halfHeight 半高 + radius 底半径（米）
    | { kind: "cone"; halfHeight: number; radius: number };

// ==================== 玩家配置 ====================
export type PlayerModelOptions = {
    url: string; // 模型路径(GLB/GLTF）
    scale: number; // 角色尺度倍率
    idleAnim: string; // 静止动画名
    walkAnim: string; // 行走动画名
    runAnim: string; // 跑步动画名
    jumpAnim: string | [startAnim: string, loopAnim: string, endAnim: string]; // 跳跃;或三段 [起跳,循环,落地]
    leftWalkAnim?: string; // 左移动画,默认复用 walkAnim
    rightWalkAnim?: string; // 右移动画,默认复用 walkAnim
    backwardAnim?: string; // 后退动画,默认复用 walkAnim
    flyAnim?: string; // 飞行动画,默认复用 idleAnim
    flyIdleAnim?: string; // 飞行待机,默认复用 idleAnim
    flyHoverForwardAnim?: string; // 飞行前进悬停
    flyHoverBackAnim?: string; // 飞行后退悬停
    flyHoverLeftAnim?: string; // 飞行左移悬停
    flyHoverRightAnim?: string; // 飞行右移悬停
    flyHoverUpAnim?: string; // 飞行上升悬停
    flyHoverDownAnim?: string; // 飞行下降悬停
    drivingAnim?: string; // 驾驶循环动画,默认复用 idleAnim
    gravity?: number; // 重力基准(按 scale 缩放),默认 -2400
    jumpHeight?: number; // 跳跃初速度基准(按 scale 缩放),默认 600
    speed?: number; // 行走速度基准(按 scale 缩放),默认 300
    flySpeed?: number; // 飞行速度基准(按 scale 缩放),默认 2100
    rotateY?: number; // 人物初始朝向(弧度),默认 0
    facingOffset?: number; // 模型正面轴校正(弧度):正面 +Y 用 0,+X 用 -π/2,-Y 用 π,-X 用 π/2
    firstPersonCameraOffset?: [number, number, number]; // 第一人称相机局部偏移(基于胶囊顶部,玩家朝向系 x=右/y=前/z=上,随 yaw 转动,按 scale 缩放),默认 [0,0,0]
    capsuleRadiusRatio?: number; // 胶囊体半径倍率,默认 1
    acceleration?: number; // XZ 加速响应速度,默认 30
    deceleration?: number; // XZ 减速响应速度,默认 30
};

// 可重映射的输入动作
export type KeyAction =
    | "forward" | "backward" | "left" | "right"
    | "sprint" | "jump" | "toggleView" | "toggleFly" | "toggleVehicle";

export type KeyMap = Partial<Record<KeyAction, string | string[] | null>>;

export type MobileButtonOptions = {
    left?: number; // 左侧位置(px)
    right?: number; // 右侧位置(px)
    top?: number; // 顶部位置(px)
    bottom?: number; // 底部位置(px)
    size?: number; // 按钮直径(px),默认 56
    icon?: string; // 自定义图片 URL
};

export type JumpButtonOptions = MobileButtonOptions & {
    brakeIcon?: string; // 车辆模式下的刹车图片 URL
};

export type MobileControlsOptions = {
    joystick?: boolean;
    jump?: boolean | JumpButtonOptions;
    fly?: boolean | MobileButtonOptions;
    view?: boolean | MobileButtonOptions;
    vehicle?: boolean | MobileButtonOptions;
};

// ==================== 主初始化选项 ====================
export type PlayerControllerOptions = {
    viewer: Viewer; // Cesium Viewer
    playerModelConfig: PlayerModelOptions; // 角色模型与参数
    initPos: Cartesian3; // 初始出生点(ECEF)
    staticCollider?: ColliderSource | ColliderSource[]; // 静态碰撞源
    kinematicCollider?: ColliderSource | ColliderSource[]; // 运动学碰撞源(移动平台)
    mouseSensitivity?: number; // 鼠标灵敏度,默认 5
    minCamDistance?: number; // 第三人称最小镜头距,默认 100
    maxCamDistance?: number; // 第三人称最大镜头距,默认 440
    camLookAtHeightRatio?: number; // 相机看向点高度比例,默认 0.8
    thirdMouseMode?: 0 | 1 | 2 | 3 | 4 | 5; // 第三人称鼠标模式,默认 1
    enableZoom?: boolean; // 是否允许滚轮缩放,默认 false
    enableOverShoulderView?: boolean; // 是否启用过肩视角,默认 false
    isFirstPerson?: boolean; // 初始是否第一人称,默认 false
    enableSpringCamera?: boolean; // 是否启用弹簧相机,默认 false
    springCameraTime?: number; // 弹簧相机平滑时间(秒),默认 0.05
    timeScale?: number; // 时间缩放系数,默认 1
    keyMap?: KeyMap; // 自定义键位
    isShowMobileControls?: boolean; // 移动端是否显示虚拟 UI,默认 true
    mobileControls?: MobileControlsOptions; // 移动端按钮显隐
};

// ==================== 车辆配置 ====================

// 车辆模型、物理和驾驶参数
export type VehicleOptions = {
    url: string; // 车辆模型路径(GLB/GLTF)
    position: Cartesian3; // 车辆初始世界坐标(ECEF)
    wheelsNames: string[]; // 车轮节点名,顺序为左前、右前、左后、右后
    scale?: number; // 车辆模型缩放,默认 1
    driverSeatPosition: Cartesian3; // 驾驶位胶囊中心,使用车辆底盘局部坐标
    driverSeatRotation?: number; // 驾驶位相对车辆底盘局部的水平旋转(弧度),默认 0
    chassisRatio?: number; // 底盘高度比例,默认 0.2
    suspensionRestLengthRatio?: number; // 悬挂静止长度比例,默认 0.2
    followVehicleDirection?: boolean; // 驾驶时镜头是否跟随车辆朝向,默认 true
    mass?: number; // 车辆质量基准(kg,按 scale 缩放),默认 1500
    maxSpeed?: number; // 最高速度基准(km/h,按 scale 缩放),默认 300
    acceleration?: number; // 加速度基准(m/s²,按 scale 缩放),默认 8
    deceleration?: number; // 制动减速度基准(m/s²,按 scale 缩放),默认 8
};

// 已加载车辆的运行时对象
export type VehicleInstance = {
    model: Model; // Cesium 车辆模型
    chassisBody: RigidBody; // 底盘刚体
    vehicleController: DynamicRayCastVehicleController; // Rapier 车辆控制器
    updateWheelVisuals: () => void; // 同步车轮视觉的回调
    destroyVehicleController: () => void; // 销毁车辆控制器的回调
    visualLocalMatrix: Matrix4; // 车辆视觉相对底盘的局部矩阵
    scale: number; // 车辆配置缩放
    modelScale: number; // 车辆模型归一化缩放
    driverSeatPosition: Cartesian3; // 驾驶位胶囊中心,使用车辆底盘局部坐标
    driverSeatRotation: number; // 驾驶位相对车辆底盘局部的水平旋转(弧度)
    forwardLocal: Cartesian3; // 由前后轮中心推算的车辆底盘本地前向
    chassisRatio: number; // 底盘高度比例
    suspensionRestLengthRatio: number; // 悬挂静止长度比例
    size: { l: number; w: number; h: number }; // 车辆尺寸(长、宽、高)
    halfExtents: Cartesian3; // 底盘碰撞盒半边长(Rapier 局部坐标)
    mass: number; // 车辆质量(kg)
    maxSpeed: number; // 最高速度(km/h)
    acceleration: number; // 加速度(m/s²)
    deceleration: number; // 制动减速度(m/s²)
    followVehicleDirection: boolean; // 相机是否跟随车辆方向
    physicsBoxPrimitive?: Primitive; // 物理盒体调试图元
};
