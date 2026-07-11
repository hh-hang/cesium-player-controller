import {
    Cartesian3, PerspectiveFrustum, Viewer, Math as CMath,
    Transforms, Matrix4, Model, ShadowMode,
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
    // glTF 模型在 ECEF 中的摆放点
    const modelLon = 139.7967;
    const modelLat = 35.7148;
    const modelHeight = 2;
    const position = Cartesian3.fromDegrees(modelLon, modelLat, modelHeight);

    // 以摆放点为原点的本地 ENU 坐标系矩阵
    const modelMatrix = Transforms.eastNorthUpToFixedFrame(position, undefined, new Matrix4());

    // 加载 glTF 模型作为可行走的世界
    const model = await Model.fromGltfAsync({
        url: `${import.meta.env.BASE_URL}glb/city_scene_tokyo.glb`,
        modelMatrix,
        shadows: ShadowMode.RECEIVE_ONLY,
        scale: 2,
    });
    viewer.scene.primitives.add(model);

    // 出生点
    // const initPos = Cartesian3.fromDegrees(modelLon, modelLat, modelHeight + 15);
    const initPos = new Cartesian3(-3959754.3178244657, 3346615.437621552, 3702553.121707884);

    // 地形平面
    const half = 0.006;
    const terrainRect: [number, number, number, number] = [
        CMath.toRadians(modelLon - half), CMath.toRadians(modelLat - half),
        CMath.toRadians(modelLon + half), CMath.toRadians(modelLat + half),
    ];

    // 飞行定位到模型上空
    viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(modelLon, modelLat, modelHeight + 200),
        duration: 1,
    });

    // 初始化玩家控制器
    const player = new playerController();
    await player.init({
        viewer,
        initPos,
        minCamDistance: 50,
        maxCamDistance: 300,
        camLookAtHeightRatio: 0.7,
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
            rotateY: -Math.PI / 2,
            facingOffset: Math.PI / 2,
        },
        staticCollider: [
            // glTF 模型碰撞
            {
                type: "gltf",
                url: `${import.meta.env.BASE_URL}glb/city_scene_tokyo.glb`,
                // 模型旋转（cesium加载glb时会默认将Y-up转换成Z-up，在这里额外加上旋转对齐cesium的默认转换）
                rotation: {
                    heading: -90,
                    pitch: 0,
                    roll: 90,
                },
                position,
                scale: 2,
            },
            // 地形兜底
            {
                type: "terrain",
                rectangle: terrainRect,
                resolution: 48,
            },
        ],
    });

    player.setJumpHeight(900);

    // 第一人称隐藏人物模型
    player.onViewChange = (isFirstPerson) => {
        const m = player.getPlayerModel();
        if (m) m.show = !isFirstPerson;
    };

    // 主循环
    viewer.scene.preUpdate.addEventListener(() => {
        player.update();
    });
}

main().catch((e) => console.error("初始化失败:", e));
