import {
    Cartesian3, Cesium3DTileset, PerspectiveFrustum, Viewer, Math as CMath, Cartographic
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { playerController } from "cesium-player-controller";

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

async function main() {
    // 加载 3DGS
    const tileset = await Cesium3DTileset.fromIonAssetId(3667783);
    viewer.scene.primitives.add(tileset);

    // 中心点笛卡尔
    const center = tileset.boundingSphere.center.clone();
    const carto = Cartographic.fromCartesian(center);
    const spawnLon = CMath.toDegrees(carto.longitude);
    const spawnLat = CMath.toDegrees(carto.latitude);

    // 出生点
    // const initPos = Cartesian3.fromDegrees(spawnLon, spawnLat, carto.height + 10);
    const initPos = new Cartesian3(1240932.6384013514, -4727397.212936234, 4084119.2500427295);

    // 地形平面
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
        minCamDistance: 50,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.7,
        enableOverShoulderView: true,
        enableSpringCamera: true,
        springCameraTime: 0.07,
        playerModelConfig: {
            url: `${import.meta.env.BASE_URL}glb/UAL1_Standard.glb`,
            scale: 0.01,
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
            rotateY: 0,
            facingOffset: Math.PI / 2,
        },
        staticCollider: [
            {
                type: "terrain",
                rectangle: terrainRect,
                resolution: 48,
            },
            {
                type: "gltf",
                url: `${import.meta.env.BASE_URL}glb/3667783.glb`,
                position: center,
                scale: 100,
            },
        ],
    });

    player.setJumpHeight(900);

    // 第一人称隐藏人物模型
    player.onViewChange = (isFirstPerson) => {
        const model = player.getPlayerModel();
        if (model) model.show = !isFirstPerson;
    };

    // 主循环
    let last = performance.now();
    viewer.scene.preUpdate.addEventListener(() => {
        const now = performance.now();
        const delta = (now - last) / 1000;
        last = now;
        player.update(delta);
    });
}

main().catch((e) => console.error("初始化失败:", e));
