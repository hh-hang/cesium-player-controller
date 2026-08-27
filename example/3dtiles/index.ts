import {
    Cartesian3, Cesium3DTileset, PerspectiveFrustum, Viewer, Math as CMath, Cartographic, ShadowMode,
    DirectionalLight, Transforms, Matrix4, Color, Entity, Terrain,
    Primitive, GeometryInstance, BoxGeometry, CylinderGeometry, VertexFormat,
    ColorGeometryInstanceAttribute, PerInstanceColorAppearance, Model, Ion,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { playerController } from "cesium-player-controller";
import { GUI } from "lil-gui";

Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5ZDJjMmUxZC1mZjNmLTRiNTItODkxZC02ZmUxMWYwZjFmYmEiLCJpZCI6MjIzMDk3LCJpYXQiOjE3MTg3Njc3NDR9.u83SkUcP9A9SvN3549bduETewavU8k_lSBQneyz5M0Q";

// 初始化viewer
const viewer = new Viewer("cesiumContainer", {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
});

// 放大透视相机fov
(viewer.camera.frustum as PerspectiveFrustum).fov = CMath.toRadians(90);

// 帧率显示
viewer.scene.debugShowFramesPerSecond = true;
const fpsStyle = document.createElement("style");
fpsStyle.textContent = `
.cesium-performanceDisplay-defaultContainer {
    top: auto;
    right: auto;
    bottom: 0;
    left: 0;
    z-index: 9999;
}`;
document.head.appendChild(fpsStyle);
// 开启时钟动画
viewer.clock.shouldAnimate = true;

// 初始参数
const params = {
    showShadow: false,
    sunAzimuth: 185,   // 太阳方位角
    sunElevation: 40,  // 太阳高度角
    mouseSensitivity: 5,
    scale: 0.01,
    gravity: -2400,
    jumpHeight: 900,
    playerSpeed: 300,
    flySpeed: 2100,
    playerAcceleration: 30,
    playerDeceleration: 30,
    timeScale: 1,
    minCamDistance: 50,
    maxCamDistance: 300,
    camLookAtHeightRatio: 0.7,
    enableSpringCamera: true,
    springCameraTime: 0.07,
    thirdMouseMode: 1 as 0 | 1 | 2 | 3 | 4 | 5,
    enableZoom: false,
    debug: false,
    enableOverShoulderView: false,
    centerRaycast: false,
};

// 自定义平行光方向参考点
let sunRefEcef = new Cartesian3();

// 按方位角/高度角更新场景平行光
function applySunLight() {
    const az = CMath.toRadians(params.sunAzimuth), el = CMath.toRadians(params.sunElevation);
    // 指向太阳的方向（本地 ENU）
    const e = Math.cos(el) * Math.sin(az);
    const n = Math.cos(el) * Math.cos(az);
    const u = Math.sin(el);
    // 光线传播方向 = 从太阳射向地面 = 取反，再转到世界(ECEF)
    const enu = Transforms.eastNorthUpToFixedFrame(sunRefEcef, undefined, new Matrix4());
    const dir = Matrix4.multiplyByPointAsVector(enu, new Cartesian3(-e, -n, -u), new Cartesian3());
    Cartesian3.normalize(dir, dir);
    viewer.scene.light = new DirectionalLight({ direction: dir });
}

// 动态物体渲染
function addVisualPrimitive(geometry: any, color: Color): Primitive {
    const prim = new Primitive({
        geometryInstances: new GeometryInstance({
            geometry,
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
        }),
        appearance: new PerInstanceColorAppearance({ flat: false, translucent: false }),
        asynchronous: false,
        shadows: ShadowMode.ENABLED, 
    });
    viewer.scene.primitives.add(prim);
    return prim;
}

// 添加盒子
function makeBoxPrimitive(size: number, color: Color): Primitive {
    return addVisualPrimitive(BoxGeometry.fromDimensions({
        dimensions: new Cartesian3(size, size, size),
        vertexFormat: VertexFormat.POSITION_AND_NORMAL,
    }), color);
}

// 添加圆柱（轴沿本地 Z=Up，与物理 cylinder 一致）
function makeCylinderPrimitive(halfHeight: number, radius: number, color: Color): Primitive {
    return addVisualPrimitive(new CylinderGeometry({
        length: halfHeight * 2,
        topRadius: radius,
        bottomRadius: radius,
        vertexFormat: VertexFormat.POSITION_AND_NORMAL,
    }), color);
}

// 添加圆锥（顶半径 0 的圆柱，尖朝 +Z=Up）
function makeConePrimitive(halfHeight: number, radius: number, color: Color): Primitive {
    return addVisualPrimitive(new CylinderGeometry({
        length: halfHeight * 2,
        topRadius: 0,
        bottomRadius: radius,
        vertexFormat: VertexFormat.POSITION_AND_NORMAL,
    }), color);
}

// 用 football.glb 作球的视觉（异步加载）。scale 需调到视觉直径 ≈ 碰撞球直径（2×radius）。
async function makeFootballModel(scale: number): Promise<Model> {
    const url = `${import.meta.env.BASE_URL}glb/football.glb`;
    const model = await Model.fromGltfAsync({ url, scale, scene: viewer.scene });
    viewer.scene.primitives.add(model);
    return model;
}

async function main() {
    // 加载地形
    const terrain = Terrain.fromWorldTerrain();
    viewer.scene.setTerrain(terrain);
    await new Promise<void>((resolve) => {
        if (terrain.ready) resolve();
        else terrain.readyEvent.addEventListener(() => resolve());
    });
    viewer.scene.globe.depthTestAgainstTerrain = true;

    // 加载 3D Tiles
    const tileset = await Cesium3DTileset.fromUrl("https://pelican-public.s3.amazonaws.com/3dtiles/agi-hq/tileset.json");
    tileset.shadows = ShadowMode.RECEIVE_ONLY; // 仅接收阴影
    viewer.scene.primitives.add(tileset);

    // 中心点笛卡尔
    const center = tileset.boundingSphere.center.clone();

    // 沿本地 U 方向偏移
    const heightOffset = -225;
    const enu = Transforms.eastNorthUpToFixedFrame(center, undefined, new Matrix4());
    const newCenter = Matrix4.multiplyByPoint(enu, new Cartesian3(0, 0, heightOffset), new Cartesian3());

    // 写入 tileset 矩阵
    const offset = Cartesian3.subtract(newCenter, center, new Cartesian3());
    tileset.modelMatrix = Matrix4.fromTranslation(offset, new Matrix4());

    // 新中心经纬度
    const carto = Cartographic.fromCartesian(newCenter);
    const spawnLon = CMath.toDegrees(carto.longitude);
    const spawnLat = CMath.toDegrees(carto.latitude);

    // 出生点
    const initPos = Cartesian3.fromDegrees(-75.59632310626372, 40.03923662898148, 90);

    // 生成地形碰撞范围
    const half = 0.006;
    const terrainRect: [number, number, number, number] = [
        CMath.toRadians(spawnLon - half), CMath.toRadians(spawnLat - half),
        CMath.toRadians(spawnLon + half), CMath.toRadians(spawnLat + half),
    ];

    // 飞行定位
    await viewer.flyTo(tileset, { duration: 1 });

    // 初始化玩家控制器
    const player = new playerController();
    await player.init({
        viewer,
        initPos,
        mouseSensitivity: params.mouseSensitivity,
        minCamDistance: params.minCamDistance,
        maxCamDistance: params.maxCamDistance,
        camLookAtHeightRatio: params.camLookAtHeightRatio,
        thirdMouseMode: params.thirdMouseMode,
        enableZoom: params.enableZoom,
        enableOverShoulderView: params.enableOverShoulderView,
        enableSpringCamera: params.enableSpringCamera,
        springCameraTime: params.springCameraTime,
        timeScale: params.timeScale,
        playerModelConfig: {
            url: `${import.meta.env.BASE_URL}glb/UAL1_Standard.glb`,
            scale: params.scale,
            idleAnim: "Idle_Loop",
            walkAnim: "Walk_Loop",
            runAnim: "Sprint_Loop",
            jumpAnim: ["Jump_Start", "Jump_Loop", "Jump_Land"],
            flyAnim: "fly",
            flyIdleAnim: "flyIdle",
            flyHoverForwardAnim: "flyHoverForward",
            flyHoverBackAnim: "flyHoverBack",
            flyHoverLeftAnim: "flyHoverLeft",
            flyHoverRightAnim: "flyHoverRight",
            flyHoverUpAnim: "flyHoverUp",
            drivingAnim: "Driving_Loop",
            rotateY: - Math.PI / 2,
            facingOffset: Math.PI / 2,
        },
        // 静态碰撞源
        staticCollider: [
            // // 地形碰撞
            // {
            //     type: "terrain",
            //     rectangle: terrainRect,
            //     resolution: 48,
            // },
            {
                type: "streaming-terrain",
                level: 18,
                radius: 350,
                releaseRadius: 525,
                lookAheadSeconds: 1,
                fallbackDelayMs: 250,
                maxConcurrentRequests: 2,
                maxBuildsPerFrame: 1,
                maxActiveTiles: 48,
                rebaseDistance: 10_000,
            },
            // 模型碰撞
            {
                type: "gltf",
                url: `${import.meta.env.BASE_URL}glb/agi-hq.glb`,
                position: newCenter,
            },
        ],
    });

    // 加载车辆
    const vehicleEnu = Transforms.eastNorthUpToFixedFrame(initPos, undefined, new Matrix4());
    const vehiclePos = Matrix4.multiplyByPoint(vehicleEnu, new Cartesian3(-5, 0, 0), new Cartesian3());
    const spawned = await player.loadVehicleModel({
        position: vehiclePos,
        url: `${import.meta.env.BASE_URL}glb/sedan.glb`,
        scale: 1,
        wheelsNames: ["Wheel_LF", "Wheel_RF", "Wheel_LR", "Wheel_RR"],
        driverSeatPosition: new Cartesian3(-0.6, 0.3, 0.4),
        driverSeatRotation: Math.PI / 2,
        chassisRatio: 0.35,
        suspensionRestLengthRatio: 0.2,
        mass: 1500,
        maxSpeed: 300,
        acceleration: 8,
        deceleration: 30,
        followVehicleDirection: true,
    });
    if (spawned) spawned.model.shadows = ShadowMode.ENABLED;

    window.addEventListener("keydown", (e) => {
        if (e.code !== "KeyR" || e.repeat) return;
        player.resetVehicle();
    });

    // 动态物体添加到rapier世界
    {
        const enuAt = Transforms.eastNorthUpToFixedFrame(initPos, undefined, new Matrix4());

        // 各 5 个：球 / 方块 / 圆柱 / 圆锥
        const count = 5;
        const r = 0.25, hh = 0.25;            // 半径 / 半高（世界尺度，米）
        const opts = { restitution: 0.3 };

        // 在出生点附近随机取一个 ENU 局部点（E/N 散开，U 抬高），转成 ECEF
        const randomPos = (uBase: number) => {
            const local = new Cartesian3((Math.random() - 0.5) * 4, 1 + (Math.random() - 0.5) * 4, uBase + Math.random() * 3);
            return Matrix4.multiplyByPoint(enuAt, local, new Cartesian3());
        };
        const rndColor = () => Color.fromRandom({ alpha: 1 });

        for (let i = 0; i < count; i++) {
            // 足球
            const ball = player.addDynamicObject(randomPos(1), { kind: "ball", radius: r }, opts);
            makeFootballModel(r).then((model) => ball.attachVisual(model));
            // 方块
            player.addDynamicObject(randomPos(1), { kind: "box", half: { e: r, n: r, u: r } }, opts)
                .attachVisual(makeBoxPrimitive(r * 2, rndColor()));
            // 圆柱
            player.addDynamicObject(randomPos(1), { kind: "cylinder", halfHeight: hh, radius: r }, opts)
                .attachVisual(makeCylinderPrimitive(hh, r, rndColor()));
            // 圆锥
            player.addDynamicObject(randomPos(1), { kind: "cone", halfHeight: hh, radius: r }, opts)
                .attachVisual(makeConePrimitive(hh, r, rndColor()));
        }
    }

    player.setGravity(params.gravity);
    player.setJumpHeight(params.jumpHeight);
    player.setPlayerSpeed(params.playerSpeed);
    player.setPlayerFlySpeed(params.flySpeed);
    player.playerAcceleration = params.playerAcceleration;
    player.playerDeceleration = params.playerDeceleration;
    player.setDebug(params.debug);
    viewer.shadows = params.showShadow;

    // 初始化自定义平行光方向
    sunRefEcef = initPos;
    applySunLight();

    // 第一人称隐藏人物模型
    player.onViewChange = (isFirstPerson) => {
        const model = player.getPlayerModel();
        if (model) model.show = !isFirstPerson;
    };

    // 上车回调 设置第一人称相机偏移匹配车内视角 并设置弹簧相机
    player.onVehicleEnter = (vehicle) => {
        player.setFirstPersonCameraOffset([0, -40, -60]);
        player.cam.springCameraTime = 0.14;
    };

    // 下车回调 恢复第一人称相机偏移 并设置弹簧相机
    player.onVehicleExit = (vehicle) => {
        player.setFirstPersonCameraOffset([0, 0, 0]);
        player.cam.springCameraTime = 0.07;
    };

    // 准星射线交点可视化小球
    const raycastSphere = viewer.entities.add(new Entity({
        position: Cartesian3.ZERO,
        point: { pixelSize: 12, color: Color.CYAN, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        show: false,
    }));

    // 每帧更新中心射线交点
    function updateCenterRaycast() {
        if (!params.centerRaycast) { raycastSphere.show = false; return; }
        const hit = player.getCenterScreenRaycastHit();
        if (hit?.position) {
            raycastSphere.position = hit.position as any;
            raycastSphere.show = true;
        } else {
            raycastSphere.show = false;
        }
    }

    // 主循环
    viewer.scene.preUpdate.addEventListener(() => {
        player.update();
        updateCenterRaycast();
    });

    initGUI(player);
}

// GUI 调试面板
function initGUI(player: playerController) {
    const gui = new GUI({ title: "Debug Panel", width: 280 });
    gui.close();
    Object.assign(gui.domElement.style, { position: "fixed", top: "12px", right: "12px", zIndex: "9999" });

    ["pointerdown", "mousedown", "click"].forEach((type) => {
        gui.domElement.addEventListener(type, (e) => e.stopPropagation());
    });

    gui.add(params, "showShadow").name("Show Shadow").onChange((v: boolean) => { viewer.shadows = v; });
    gui.add(params, "mouseSensitivity", 1, 20, 0.1).onChange((v: number) => player.setMouseSensitivity(v));
    gui.add(params, "scale", 0.001, 0.05, 0.001).name("Player Scale").onChange((v: number) => player.setPlayerScale(v));
    gui.add(params, "gravity", -6000, 0, 50).onChange((v: number) => player.setGravity(v));
    gui.add(params, "jumpHeight", 0, 2000, 10).onChange((v: number) => player.setJumpHeight(v));
    gui.add(params, "playerSpeed", 0, 10000, 10).onChange((v: number) => player.setPlayerSpeed(v));
    gui.add(params, "flySpeed", 0, 20000, 10).onChange((v: number) => player.setPlayerFlySpeed(v));
    gui.add(params, "playerAcceleration", 1, 100, 1).name("Acceleration").onChange((v: number) => player.playerAcceleration = v);
    gui.add(params, "playerDeceleration", 1, 100, 1).name("Deceleration").onChange((v: number) => player.playerDeceleration = v);
    gui.add(params, "timeScale", 0, 3, 0.05).name("Time Scale").onChange((v: number) => player.timeScale = v);
    gui.add(params, "minCamDistance", 0, 200, 1).onChange((v: number) => player.setMinCamDistance(v));
    gui.add(params, "maxCamDistance", 50, 1000, 1).onChange((v: number) => player.setMaxCamDistance(v));
    gui.add(params, "camLookAtHeightRatio", 0, 1, 0.01).onChange((v: number) => player.setCamLookAtHeightRatio(v));
    gui.add(params, "enableSpringCamera").name("Spring Camera").onChange((v: boolean) => player.cam.enableSpringCamera = v);
    gui.add(params, "springCameraTime", 0.01, 1, 0.01).name("Spring Time").onChange((v: number) => player.cam.springCameraTime = v);
    gui.add(params, "thirdMouseMode", { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }).onChange((v: string) => player.setThirdMouseMode(Number(v) as 0 | 1 | 2 | 3 | 4 | 5));
    gui.add(params, "enableZoom").onChange((v: boolean) => player.setEnableZoom(v));
    gui.add(params, "debug").onChange((v: boolean) => player.setDebug(v));
    gui.add(params, "enableOverShoulderView").onChange((v: boolean) => player.setOverShoulderView(v));
    gui.add(params, "centerRaycast").name("Center Raycast Debug");
}

main().catch((e) => console.error("初始化失败:", e));
