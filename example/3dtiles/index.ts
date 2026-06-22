import {
    Cartesian3, Cesium3DTileset, Ion, PerspectiveFrustum, Viewer, Math as CMath, Cartographic, ShadowMode,
    DirectionalLight, Transforms, Matrix4, Color, Entity
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { playerController } from "cesium-player-controller";
import { GUI } from "lil-gui";

Ion.defaultAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJmMzgwMGY3ZS1jOTMwLTQyNmQtOTkyNS03MDE4ZjlkYmY0MTYiLCJpZCI6MjIzMDk3LCJpYXQiOjE3MTg3NjgwNTN9.FcpK7jiFPzWZL8m6VxRbG7ly8LMecpXnDAMZJX_UehM";

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

async function main() {
    // 加载 3D Tiles
    const tileset = await Cesium3DTileset.fromUrl("https://pelican-public.s3.amazonaws.com/3dtiles/agi-hq/tileset.json");
    tileset.shadows = ShadowMode.RECEIVE_ONLY; // 仅接收阴影
    viewer.scene.primitives.add(tileset);

    // 中心点笛卡尔
    const center = tileset.boundingSphere.center.clone();

    // 沿本地 U 方向下移 heightOffset
    const heightOffset = -300;
    const enu = Transforms.eastNorthUpToFixedFrame(center, undefined, new Matrix4());
    const newCenter = Matrix4.multiplyByPoint(enu, new Cartesian3(0, 0, heightOffset), new Cartesian3());

    // 写入 tileset 矩阵
    const offset = Cartesian3.subtract(newCenter, center, new Cartesian3());
    tileset.modelMatrix = Matrix4.fromTranslation(offset, new Matrix4());

    // 新中心经纬度
    const carto = Cartographic.fromCartesian(newCenter);
    // 初始点
    const spawnLon = CMath.toDegrees(carto.longitude);
    const spawnLat = CMath.toDegrees(carto.latitude);
    // const spawnHeight = carto.height + 20;
    // const initPos = Cartesian3.fromDegrees(spawnLon, spawnLat, spawnHeight);
    const initPos = new Cartesian3(1216376.1904561715, -4736210.644582202, 4081328.951494063);

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
            runAnim: "Jog_Fwd_Loop",
            jumpAnim: ["Jump_Start", "Jump_Loop", "Jump_Land"],
            flyAnim: "fly",
            flyIdleAnim: "flyIdle",
            flyHoverForwardAnim: "flyHoverForward",
            flyHoverBackAnim: "flyHoverBack",
            flyHoverLeftAnim: "flyHoverLeft",
            flyHoverRightAnim: "flyHoverRight",
            flyHoverUpAnim: "flyHoverUp",
            rotateY: - Math.PI / 2,
            facingOffset: Math.PI / 2,
        },
        // 静态碰撞源
        staticCollider: [
            // 地形碰撞
            {
                type: "terrain",
                rectangle: terrainRect,
                resolution: 48,
            },
            // 模型碰撞
            {
                type: "gltf",
                url: `${import.meta.env.BASE_URL}glb/agi-hq.glb`,
                position: newCenter,
            },
        ],
    });

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
    let last = performance.now();
    viewer.scene.preUpdate.addEventListener(() => {
        const now = performance.now();
        const delta = (now - last) / 1000;
        last = now;
        player.update(delta);
        updateCenterRaycast();
    });

    initGUI(player);
}

// GUI 调试面板
function initGUI(player: playerController) {
    const gui = new GUI({ title: "Debug Panel", width: 280 });
    gui.close();
    Object.assign(gui.domElement.style, { position: "fixed", top: "12px", right: "12px", zIndex: "9999" });

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
