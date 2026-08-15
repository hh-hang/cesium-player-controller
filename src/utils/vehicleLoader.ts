import {
    Axis, Cartesian3, getBaseUri, Matrix3, Matrix4, Model,
} from "cesium";
import type { Scene } from "cesium";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsSystem } from "../systems/PhysicsSystem";
import type { VehicleInstance, VehicleOptions } from "../types";
import { getGltfModelInfo } from "./gltfGeometry";
import { createVehicleController, type WheelInfo } from "./vehicleController";

export type VehicleLoaderContext = {
    physics: PhysicsSystem;
    scene: Scene;
    RAPIER: typeof RAPIER;
    vehicleParams: {
        debug: { showPhysicsBox: boolean };
        chassis: { mass: number; linearDamping: number; angularDamping: number };
        model: { rotation: number };
        power: { acceleration: number; deceleration: number; maxSpeed: number };
        steering: { maxSteerAngle: number; steerTime: number; steerReturnTimeSlow: number; steerReturnTimeFast: number };
        followVehicleDirection: boolean;
    };
    vehicleLength: number;
};

// ==================== 工具函数 ====================

// 构建原 glTF(Y-up)到车辆视觉局部(Z-up)的坐标校正矩阵
function createModelAxisMatrix(rotation: number): Matrix4 {
    const rotationZ = Matrix3.fromRotationZ(rotation, new Matrix3());
    const rotation4 = Matrix4.fromRotationTranslation(rotationZ, Cartesian3.ZERO, new Matrix4());
    const yUpToZUp = Matrix3.fromArray([
        1, 0, 0,
        0, 0, 1,
        0, -1, 0,
    ], 0, new Matrix3());
    const yUpToZUp4 = Matrix4.fromRotationTranslation(yUpToZUp, Cartesian3.ZERO, new Matrix4());
    return Matrix4.multiply(rotation4, yUpToZUp4, new Matrix4());
}

// 构建车辆视觉局部(Z-up)到 Rapier 车辆局部(Y-up)的坐标矩阵
function createCorrectedToRapierMatrix(): Matrix4 {
    const rotation = Matrix3.fromArray([
        1, 0, 0,
        0, 0, -1,
        0, 1, 0,
    ], 0, new Matrix3());
    return Matrix4.fromRotationTranslation(rotation, Cartesian3.ZERO, new Matrix4());
}

// 等待 Cesium 模型 ready
function waitForModelReady(model: Model): Promise<void> {
    if (model.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const onReady = model.readyEvent.addEventListener(() => { onReady(); onErr(); resolve(); });
        const onErr = model.errorEvent.addEventListener((e: any) => { onReady(); onErr(); reject(e); });
    });
}

// ==================== 主函数 ====================

// 加载车辆模型
export async function loadVehicleModel(
    opts: VehicleOptions,
    ctx: VehicleLoaderContext,
): Promise<VehicleInstance> {
    const { physics, scene, RAPIER, vehicleParams, vehicleLength } = ctx;
    const world = physics.world;

    const scale = opts.scale ?? 1;
    const chassisRatio = opts.chassisRatio ?? 0.2;
    const suspensionRestLengthRatio = opts.suspensionRestLengthRatio ?? 0.2;
    const mass = (opts.mass ?? vehicleParams.chassis.mass) * scale;
    const maxSpeed = (opts.maxSpeed ?? vehicleParams.power.maxSpeed) * scale;
    const acceleration = (opts.acceleration ?? vehicleParams.power.acceleration) * scale;
    const deceleration = (opts.deceleration ?? vehicleParams.power.deceleration) * scale;

    vehicleParams.followVehicleDirection = opts.followVehicleDirection ?? true;

    const response = await fetch(opts.url);
    if (!response.ok) throw new Error(`fetch 模型失败: ${opts.url} HTTP ${response.status}`);
    const glbBytes = await response.arrayBuffer();
    const modelAxis = createModelAxisMatrix(vehicleParams.model.rotation);
    const info = await getGltfModelInfo(glbBytes, opts.url, opts.wheelsNames, modelAxis);

    // 计算模型缩放比
    const modelScale = vehicleLength / Math.max(info.size.x, info.size.y, info.size.z);
    const uniformScale = modelScale * scale;
    const correctedToRapier = createCorrectedToRapierMatrix();
    const rapierToCorrected = Matrix4.inverseTransformation(correctedToRapier, new Matrix4());
    const inverseModelAxis = Matrix4.inverseTransformation(modelAxis, new Matrix4());
    const center = new Cartesian3(info.center.x, info.center.y, info.center.z);
    const centerTranslation = Matrix4.fromTranslation(center, new Matrix4());
    const inverseScale = Matrix4.fromUniformScale(1 / uniformScale, new Matrix4());
    const scaleMatrix = Matrix4.fromUniformScale(uniformScale, new Matrix4());
    const negativeCenter = Matrix4.fromTranslation(Cartesian3.negate(center, new Cartesian3()), new Matrix4());

    // 车辆视觉矩阵 = 底盘位姿 * 坐标轴交换 * 缩放 * 居中 * 模型旋转
    const visualLocalMatrix = Matrix4.multiply(correctedToRapier, scaleMatrix, new Matrix4());
    Matrix4.multiply(visualLocalMatrix, negativeCenter, visualLocalMatrix);
    const modelRotation = Matrix3.fromRotationZ(vehicleParams.model.rotation, new Matrix3());
    Matrix4.multiplyByMatrix3(visualLocalMatrix, modelRotation, visualLocalMatrix);
    const initialChassisMatrix = physics.composeRigidBodyModelMatrix(opts.position, undefined, new Matrix4());
    const initialModelMatrix = Matrix4.multiply(initialChassisMatrix, visualLocalMatrix, new Matrix4());

    const model = await Model.fromGltfAsync({
        url: new Uint8Array(glbBytes) as any,
        basePath: getBaseUri(opts.url),
        modelMatrix: initialModelMatrix,
        scene,
        upAxis: Axis.Y,
        forwardAxis: Axis.X,
    });
    scene.primitives.add(model);
    try {
        await waitForModelReady(model);
    } catch (e) {
        scene.primitives.remove(model);
        throw e;
    }

    // 收集轮子世界变换信息
    let wheelRadius = 0, suspensionRestLength = 0, chassisHeight = 0, wheelSizeInit = false;
    const wheelsInfo: WheelInfo[] = [];
    const rootFromDesired = Matrix4.multiply(inverseModelAxis, centerTranslation, new Matrix4());
    Matrix4.multiply(rootFromDesired, inverseScale, rootFromDesired);
    Matrix4.multiply(rootFromDesired, rapierToCorrected, rootFromDesired);

    for (const name of opts.wheelsNames) {
        const nodeInfo = info.nodes.get(name);
        let node;
        try { node = model.getNode(name); } catch { node = undefined; }
        if (!nodeInfo || !node || !Number.isFinite(nodeInfo.min[0])) {
            console.warn(`未找到轮子: ${name}`);
            continue;
        }

        // 只计算一次轮子尺寸
        if (!wheelSizeInit) {
            const wheelSize = {
                x: (nodeInfo.max[0] - nodeInfo.min[0]) * uniformScale,
                y: (nodeInfo.max[1] - nodeInfo.min[1]) * uniformScale,
                z: (nodeInfo.max[2] - nodeInfo.min[2]) * uniformScale,
            };
            wheelRadius = Math.max(wheelSize.x, wheelSize.y, wheelSize.z) / 2;
            suspensionRestLength = wheelRadius * 2 * suspensionRestLengthRatio;
            chassisHeight = wheelRadius * 2 * chassisRatio;
            wheelSizeInit = true;
        }

        const correctedWorld = Matrix4.multiply(modelAxis, nodeInfo.worldMatrix, new Matrix4());
        const correctedPos = Matrix4.getTranslation(correctedWorld, new Cartesian3());
        Cartesian3.subtract(correctedPos, center, correctedPos);
        Cartesian3.multiplyByScalar(correctedPos, uniformScale, correctedPos);
        const position = Matrix4.multiplyByPointAsVector(correctedToRapier, correctedPos, new Cartesian3());

        // 记录轮子原始世界旋转/缩放,供每帧在 Cesium 节点层级中重建包装组效果
        Matrix4.setTranslation(correctedWorld, Cartesian3.ZERO, correctedWorld);
        const baseOrientationScale = Matrix4.multiply(scaleMatrix, correctedWorld, new Matrix4());
        Matrix4.multiply(correctedToRapier, baseOrientationScale, baseOrientationScale);

        wheelsInfo.push({
            axleCs: new Cartesian3(0, 0, -1),
            suspensionRestLength,
            position,
            radius: wheelRadius,
            node,
            baseOrientationScale,
            rootFromDesired: Matrix4.clone(rootFromDesired, new Matrix4()),
            parentWorldInverse: Matrix4.inverseTransformation(nodeInfo.parentWorldMatrix, new Matrix4()),
            nodeMatrix: new Matrix4(),
        });
    }

    if (wheelsInfo.length !== 4) {
        scene.primitives.remove(model);
        throw new Error(`车辆需要 4 个有效车轮节点,当前找到 ${wheelsInfo.length} 个`);
    }

    // 按左前、右前、左后、右后轮中心推算车辆前向
    const frontCenter = Cartesian3.midpoint(wheelsInfo[0].position, wheelsInfo[1].position, new Cartesian3());
    const rearCenter = Cartesian3.midpoint(wheelsInfo[2].position, wheelsInfo[3].position, new Cartesian3());
    const forwardLocal = Cartesian3.subtract(frontCenter, rearCenter, new Cartesian3());
    forwardLocal.y = 0;
    if (Cartesian3.magnitudeSquared(forwardLocal) < 1e-8) Cartesian3.clone(Cartesian3.UNIT_X, forwardLocal);
    else Cartesian3.normalize(forwardLocal, forwardLocal);

    // 车身视觉下移半个底盘高度，车轮节点保持在悬挂连接点
    const visualShift = Matrix4.fromTranslation(new Cartesian3(0, -chassisHeight / 2, 0), new Matrix4());
    Matrix4.multiply(visualShift, visualLocalMatrix, visualLocalMatrix);
    const inverseVisualShift = Matrix4.fromTranslation(new Cartesian3(0, chassisHeight / 2, 0), new Matrix4());
    for (const wheel of wheelsInfo) {
        Matrix4.multiply(wheel.rootFromDesired, inverseVisualShift, wheel.rootFromDesired);
    }

    // 创建车身物理碰撞体
    const halfExtents = {
        x: info.size.x * uniformScale * 0.5 * 0.95,
        y: info.size.z * uniformScale * 0.5 - chassisHeight / 2,
        z: info.size.y * uniformScale * 0.5 * 0.95,
    };
    const p = physics.frame.ecefToRapier(opts.position);
    const chassisBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(p.x, p.y, p.z)
            .setLinearDamping(vehicleParams.chassis.linearDamping)
            .setAngularDamping(vehicleParams.chassis.angularDamping)
            .setCanSleep(true),
    );
    const gravity = Math.abs(world.gravity.y) || 9.81;
    chassisBody.setGravityScale(9.81 / gravity, true);
    world.createCollider(
        RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
            .setMass(mass),
        chassisBody,
    );

    const { vehicle, updateWheelVisuals, destroy } = createVehicleController(world, chassisBody, wheelsInfo);

    return {
        model,
        chassisBody,
        vehicleController: vehicle,
        updateWheelVisuals,
        destroyVehicleController: destroy,
        visualLocalMatrix,
        scale,
        modelScale,
        driverSeatPosition: Cartesian3.clone(opts.driverSeatPosition, new Cartesian3()),
        driverSeatRotation: opts.driverSeatRotation ?? 0,
        forwardLocal,
        chassisRatio,
        suspensionRestLengthRatio,
        size: {
            l: Math.max(info.size.x, info.size.y) * uniformScale,
            w: Math.min(info.size.x, info.size.y) * uniformScale,
            h: info.size.z * uniformScale,
        },
        halfExtents: new Cartesian3(halfExtents.x, halfExtents.y, halfExtents.z),
        mass,
        maxSpeed,
        acceleration,
        deceleration,
        followVehicleDirection: opts.followVehicleDirection ?? true,
    };
}
