import {
    BoundingSphere, Cartesian3, Color, ColorGeometryInstanceAttribute,
    ComponentDatatype, Geometry, GeometryAttribute, GeometryInstance,
    Matrix3, Matrix4, PerInstanceColorAppearance, Primitive, PrimitiveType,
} from "cesium";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { playerController } from "../playerController";
import { initRapier } from "./PhysicsSystem";
import { loadVehicleModel as loadVehicleModelUtil } from "../utils/vehicleLoader";
import type { VehicleInstance, VehicleOptions } from "../types";

export class VehicleSystem {
    private ctrl: playerController; // 主控制器引用

    list: VehicleInstance[] = []; // 车辆实例列表
    active: VehicleInstance | null = null; // 当前乘坐车辆
    vehicleLength = 6; // 车辆模型归一化后的最大边长度
    RAPIER: typeof RAPIER | null = null; // 物理引擎模块
    params = {
        debug: { showPhysicsBox: false }, // 调试显示
        chassis: { mass: 1500, linearDamping: 0.05, angularDamping: 0.5 }, // 车身参数
        model: { rotation: -Math.PI / 2 }, // 模型旋转
        power: { acceleration: 8, deceleration: 8, maxSpeed: 300 }, // 动力参数
        steering: { maxSteerAngle: Math.PI / 4, steerSpeed: 0.5, steerReturnSpeed: 1 }, // 转向参数
        followVehicleDirection: true, // 相机跟随方向
    };

    // ==================== 防卡死自动脱困 ====================
    stuckTimer = 0; // 卡住计时器
    stuckSpeedThreshold = 0.5; // 视为"几乎不动"的水平速度阈值
    stuckTimeThreshold = 1; // 持续多久判定卡住（秒）
    stuckHopRatio = 0.5; // 脱困向上冲量对应的抬升高度 = 车高 × 此值

    boardingPadding = 0.25; // 上车范围在车身包围圆外增加的余量
    parkingCreepThreshold = 0.05; // 驻车状态下清除低速蠕动的水平速度阈值

    private chassisMatrix = new Matrix4();
    private inverseChassisMatrix = new Matrix4();
    private scratchPoint = new Cartesian3();
    private scratchLocal = new Cartesian3();
    private scratchForward = new Cartesian3();
    private scratchUp = new Cartesian3();
    private scratchDown = new Cartesian3();
    private scratchDownEnu = new Cartesian3(0, 0, -1);
    private scratchRotation = new Matrix3();
    private scratchDriverForward = new Cartesian3();

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
    }

    // 由车身水平包围圆和人物胶囊半径推算上车范围
    boardingRadius(v: VehicleInstance): number {
        return Math.hypot(v.halfExtents.x, v.halfExtents.z)
            + this.ctrl.capsuleInfo.radius
            + this.boardingPadding;
    }

    // 返回人物到车辆中心的水平距离，高度超出车辆邻域时返回 Infinity
    boardingDistance(v: VehicleInstance, positionEcef: Cartesian3): number {
        this.ctrl.physics.getDynamicModelMatrix(v.chassisBody, this.chassisMatrix);
        Matrix4.inverseTransformation(this.chassisMatrix, this.inverseChassisMatrix);
        Matrix4.multiplyByPoint(this.inverseChassisMatrix, positionEcef, this.scratchLocal);
        const verticalLimit = v.halfExtents.y + this.ctrl.capsuleInfo.height;
        if (Math.abs(this.scratchLocal.y) > verticalLimit) return Infinity;
        return Math.hypot(this.scratchLocal.x, this.scratchLocal.z);
    }

    // 是否处于车辆中心的上车范围内
    isInBoardingRange(v: VehicleInstance, positionEcef: Cartesian3): boolean {
        return this.boardingDistance(v, positionEcef) <= this.boardingRadius(v);
    }

    // 加载车辆模型
    async load(opts: VehicleOptions): Promise<VehicleInstance | undefined> {
        try {
            this.RAPIER ??= await initRapier();
            const instance = await loadVehicleModelUtil(opts, {
                physics: this.ctrl.physics,
                scene: this.ctrl.viewer.scene,
                RAPIER: this.RAPIER,
                vehicleParams: this.params,
                vehicleLength: this.vehicleLength,
            });

            instance.physicsBoxPrimitive = this.createPhysicsBox(instance);
            this.ctrl.viewer.scene.primitives.add(instance.physicsBoxPrimitive);
            this.list.push(instance);
            this.syncVehicleVisual(instance);
            this.syncDebugVisibility(this.ctrl.getDebug());
            return instance;
        } catch (e) {
            console.error("加载车辆模型失败:", e);
            return undefined;
        }
    }

    // 触发上车流程
    enter() {
        if (!this.list.length || this.ctrl.controllerMode === 1) return;

        // 查找最近可上车的车辆
        let nearest: VehicleInstance | null = null;
        let nearestDist = Infinity;
        for (const v of this.list) {
            const dist = this.boardingDistance(v, this.ctrl.getPosition());
            if (dist <= this.boardingRadius(v) && dist < nearestDist) {
                nearestDist = dist;
                nearest = v;
            }
        }

        if (!nearest) return;
        // 车辆移动中不允许上车
        const vel = nearest.chassisBody.linvel();
        if (Math.hypot(vel.x, vel.z) > 0.1) return;
        this.releaseParkingBrake(nearest);
        this.stuckTimer = 0;
        this.active = nearest;
        const c = this.ctrl;
        c.controllerMode = 1;
        c.resetVelocity();
        c.physics.setCharacterCollisionEnabled(false);
        c.mobileControls?.syncControllerModeBtn(1);
        c.cam.setOverShoulder(false);
        c.animation.playByName("driving");
        c.syncMountedPlayer(nearest);
        c.syncDebugVisibility();
        c.onVehicleEnter?.(nearest);
    }

    // 触发下车流程
    exit() {
        const c = this.ctrl;
        const v = this.active;
        if (!v) return;

        this.applyParkingBrake(v, c.getCurrentDelta() || 1 / 60);
        this.stuckTimer = 0;
        this.findExitPosition(v, this.scratchPoint);
        this.getDriverForward(v, this.scratchForward);
        c.controllerMode = 0;
        c.mobileControls?.syncControllerModeBtn(0);
        c.cam.setOverShoulder(c.enableOverShoulderView);
        c.leaveVehicleAt(this.scratchPoint, this.scratchForward);
        c.animation.playByName("idle");
        c.syncDebugVisibility();
        c.onVehicleExit?.(v);
    }

    // 物理步进前更新车辆控制器
    preparePhysics(delta: number) {
        if (!this.RAPIER) return;
        if (this.ctrl.controllerMode === 1 && this.active) this.applyDriving(delta, this.active);
    }

    // 物理步进后同步车辆视觉
    finishPhysics(delta: number) {
        const charCollider = this.ctrl.physics.charCollider;
        const charPushCollider = this.ctrl.physics.charPushCollider;
        for (const v of this.list) {
            const parked = this.ctrl.controllerMode !== 1 || this.active !== v;
            if (parked) this.applyParkingBrake(v, delta);
            v.vehicleController.updateVehicle(
                delta,
                undefined,
                undefined,
                collider => collider !== charCollider && collider !== charPushCollider,
            );
            const vel = v.chassisBody.linvel();
            const speed = Math.hypot(vel.x, vel.z);
            const max = v.maxSpeed / 3.6;
            if (speed > max) {
                const s = max / speed;
                v.chassisBody.setLinvel({ x: vel.x * s, y: vel.y, z: vel.z * s }, true);
            } else if (parked && speed > 0 && speed <= this.parkingCreepThreshold) {
                let hasWheelContact = false;
                for (let i = 0; i < v.vehicleController.numWheels(); i++) {
                    if (v.vehicleController.wheelIsInContact(i)) { hasWheelContact = true; break; }
                }
                if (hasWheelContact) v.chassisBody.setLinvel({ x: 0, y: vel.y, z: 0 }, true);
            }
            this.syncVehicleVisual(v);
        }
        if (this.ctrl.controllerMode === 1 && this.active) this.ctrl.syncMountedPlayer(this.active);
    }

    // 更新车辆驾驶
    private applyDriving(delta: number, v: VehicleInstance) {
        const c = this.ctrl;
        const { vehicleController, chassisBody } = v;

        // 坡度补偿
        const rotation = chassisBody.rotation();
        const forward = this.rotateVectorByQuaternion(v.forwardLocal, rotation, this.scratchForward);
        const slopeAngle = Math.asin(Math.max(-1, Math.min(1, forward.y)));
        const factor = (slopeAngle < -0.05 && c.input.fwd) ? -Math.sin(slopeAngle) * 10 : 1;

        // 驱动力
        const wheelCount = Math.max(1, vehicleController.numWheels());
        const accelerateForce = chassisBody.mass() * v.acceleration / wheelCount;
        const engineForce = (Number(c.input.fwd) - Number(c.input.bkd)) * accelerateForce * factor;
        for (let i = 0; i < vehicleController.numWheels(); i++) vehicleController.setWheelEngineForce(i, engineForce);

        // 制动
        const wheelBrake = Number(c.input.space) * chassisBody.mass() * v.deceleration / wheelCount * delta;
        for (let i = 0; i < vehicleController.numWheels(); i++) vehicleController.setWheelBrake(i, wheelBrake);

        // 转向
        const currentSteering = vehicleController.wheelSteering(0) || 0;
        const steerDir = Number(c.input.lft) - Number(c.input.rgt);
        const steerSpeed = steerDir === 0 ? this.params.steering.steerReturnSpeed : this.params.steering.steerSpeed;
        const targetSteering = this.params.steering.maxSteerAngle * steerDir;
        const steering = currentSteering + (targetSteering - currentSteering) * (1 - Math.pow(1 - steerSpeed, delta));
        vehicleController.setWheelSteering(0, steering);
        vehicleController.setWheelSteering(1, steering);

        // 漂移摩擦
        const driftFriction = ((c.input.rgt || c.input.lft) && c.input.shift) ? 0.5 : 2;
        vehicleController.setWheelSideFrictionStiffness(2, driftFriction);
        vehicleController.setWheelSideFrictionStiffness(3, driftFriction);

        // 防卡死自动脱困：有油门却长时间几乎不动，沿行进方向施加向上+前向冲量顶离
        const linv = chassisBody.linvel();
        if ((c.input.fwd || c.input.bkd) && Math.hypot(linv.x, linv.z) < this.stuckSpeedThreshold) {
            this.stuckTimer += delta;
        } else {
            this.stuckTimer = 0;
        }
        if (this.stuckTimer > this.stuckTimeThreshold) {
            const g = 9.81;
            const vUp = Math.sqrt(2 * g * v.size.h * this.stuckHopRatio); // 抬升到约车高×ratio 所需的起跳速度
            const mass = chassisBody.mass();
            const dir = c.input.bkd ? -1 : 1;
            // 车身水平前向（局部 +X，与坡度补偿一致）
            const fl = Math.hypot(forward.x, forward.z);
            const fx = fl > 0.001 ? forward.x / fl : 0;
            const fz = fl > 0.001 ? forward.z / fl : 0;
            chassisBody.applyImpulse({ x: fx * dir * mass * vUp * 0.6, y: mass * vUp, z: fz * dir * mass * vUp * 0.6 }, true);
            this.stuckTimer = 0;
        }

        // 翻车自动复位
        const vehicleUp = this.rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, rotation, this.scratchUp);
        if (vehicleUp.y < 0) {
            const t = chassisBody.translation();
            chassisBody.setTranslation({ x: t.x, y: t.y + v.size.h, z: t.z }, true);
            chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
            chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
    }

    // 计算车身外侧的可用下车位置
    private findExitPosition(v: VehicleInstance, out: Cartesian3): Cartesian3 {
        this.ctrl.physics.getDynamicModelMatrix(v.chassisBody, this.chassisMatrix);
        Cartesian3.multiplyByScalar(v.driverSeatPosition, v.scale, this.scratchLocal);
        const seatX = Math.max(-v.halfExtents.x, Math.min(v.halfExtents.x, this.scratchLocal.x));
        const side = this.scratchLocal.z >= 0 ? 1 : -1;
        const clearance = this.ctrl.capsuleInfo.radius + this.boardingPadding;
        const sideOffset = v.halfExtents.z + clearance;
        const endOffset = v.halfExtents.x + clearance;
        const candidates = [
            { x: seatX, z: side * sideOffset },
            { x: seatX, z: -side * sideOffset },
            { x: endOffset, z: 0 },
            { x: -endOffset, z: 0 },
        ];
        let groundedFallback: Cartesian3 | null = null;
        this.ctrl.frame.enuVectorToEcef(this.scratchDownEnu, this.scratchDown);

        for (const candidate of candidates) {
            this.scratchLocal.x = candidate.x;
            this.scratchLocal.y = v.halfExtents.y + this.ctrl.capsuleInfo.height + 0.5;
            this.scratchLocal.z = candidate.z;
            Matrix4.multiplyByPoint(this.chassisMatrix, this.scratchLocal, out);
            const hit = this.ctrl.physics.raycastEcefHit(
                out,
                this.scratchDown,
                v.size.h + this.ctrl.capsuleInfo.height * 3 + 2,
                v.chassisBody,
            );
            if (!hit) continue;
            Cartesian3.add(
                hit.point,
                Cartesian3.multiplyByScalar(this.scratchDown, -this.ctrl.getCapsuleGroundHeight(), out),
                out,
            );
            groundedFallback ??= Cartesian3.clone(out, new Cartesian3());
            if (this.ctrl.physics.isCharacterPositionFree(out, v.chassisBody)) return out;
        }

        if (groundedFallback) return Cartesian3.clone(groundedFallback, out);
        this.scratchLocal.x = seatX;
        this.scratchLocal.y = -v.halfExtents.y + this.ctrl.getCapsuleGroundHeight();
        this.scratchLocal.z = side * sideOffset;
        return Matrix4.multiplyByPoint(this.chassisMatrix, this.scratchLocal, out);
    }

    // 同步单辆车的模型、车轮和调试盒
    private syncVehicleVisual(v: VehicleInstance) {
        this.ctrl.physics.getDynamicModelMatrix(v.chassisBody, this.chassisMatrix);
        Matrix4.multiply(this.chassisMatrix, v.visualLocalMatrix, v.model.modelMatrix);
        v.updateWheelVisuals();
        if (v.physicsBoxPrimitive) Matrix4.clone(this.chassisMatrix, v.physicsBoxPrimitive.modelMatrix);
    }

    // 取车辆 ECEF 中心点
    getPosition(v: VehicleInstance, out = new Cartesian3()): Cartesian3 {
        const t = v.chassisBody.translation();
        return this.ctrl.frame.rapierToEcef(t.x, t.y, t.z, out);
    }

    // 取车辆 ECEF 前向
    getForward(v: VehicleInstance, out = new Cartesian3()): Cartesian3 {
        this.ctrl.physics.getDynamicModelMatrix(v.chassisBody, this.chassisMatrix);
        Matrix4.multiplyByPointAsVector(this.chassisMatrix, v.forwardLocal, out);
        return Cartesian3.normalize(out, out);
    }

    // 取驾驶位 ECEF 前向
    getDriverForward(v: VehicleInstance, out = new Cartesian3()): Cartesian3 {
        this.ctrl.physics.getDynamicModelMatrix(v.chassisBody, this.chassisMatrix);
        Matrix3.fromRotationY(v.driverSeatRotation, this.scratchRotation);
        Matrix3.multiplyByVector(this.scratchRotation, v.forwardLocal, this.scratchDriverForward);
        Matrix4.multiplyByPointAsVector(this.chassisMatrix, this.scratchDriverForward, out);
        return Cartesian3.normalize(out, out);
    }

    // 取车辆 ECEF 上向
    getUp(v: VehicleInstance, out = new Cartesian3()): Cartesian3 {
        this.ctrl.physics.getDynamicModelMatrix(v.chassisBody, this.chassisMatrix);
        out.x = this.chassisMatrix[4];
        out.y = this.chassisMatrix[5];
        out.z = this.chassisMatrix[6];
        return Cartesian3.normalize(out, out);
    }

    // 同步物理调试盒显隐
    syncDebugVisibility(show: boolean) {
        this.params.debug.showPhysicsBox = show && this.ctrl.controllerMode === 1;
        for (const v of this.list) if (v.physicsBoxPrimitive) v.physicsBoxPrimitive.show = this.params.debug.showPhysicsBox;
    }

    // 销毁全部车辆
    destroy() {
        for (const v of this.list) {
            if (v.physicsBoxPrimitive) this.ctrl.viewer.scene.primitives.remove(v.physicsBoxPrimitive);
            this.ctrl.viewer.scene.primitives.remove(v.model);
            v.destroyVehicleController();
            this.ctrl.physics.world.removeRigidBody(v.chassisBody);
        }
        this.list = [];
        this.active = null;
    }

    // 清除活动车辆的驱动力
    stopActive() {
        if (this.active) {
            this.applyParkingBrake(this.active, this.ctrl.getCurrentDelta() || 1 / 60);
            this.stuckTimer = 0;
        }
    }

    // 对无人车辆施加四轮驻车制动
    private applyParkingBrake(v: VehicleInstance, delta: number) {
        const wheelCount = Math.max(1, v.vehicleController.numWheels());
        const brake = v.chassisBody.mass() * v.deceleration / wheelCount * delta;
        for (let i = 0; i < wheelCount; i++) {
            v.vehicleController.setWheelEngineForce(i, 0);
            v.vehicleController.setWheelBrake(i, brake);
            v.vehicleController.setWheelSideFrictionStiffness(i, 2);
        }
    }

    // 解除四轮驻车制动
    private releaseParkingBrake(v: VehicleInstance) {
        for (let i = 0; i < v.vehicleController.numWheels(); i++) v.vehicleController.setWheelBrake(i, 0);
    }

    // 创建车辆碰撞盒调试图元
    private createPhysicsBox(v: VehicleInstance): Primitive {
        const h = v.halfExtents;
        const corners: Cartesian3[] = [];
        for (const x of [-h.x, h.x]) for (const y of [-h.y, h.y]) for (const z of [-h.z, h.z]) corners.push(new Cartesian3(x, y, z));
        const edges = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
        const values = new Float64Array((edges.length + 3) * 6);
        let offset = 0;
        for (const [a, b] of edges) {
            const p1 = corners[a], p2 = corners[b];
            values[offset++] = p1.x; values[offset++] = p1.y; values[offset++] = p1.z;
            values[offset++] = p2.x; values[offset++] = p2.y; values[offset++] = p2.z;
        }
        const seat = Cartesian3.multiplyByScalar(v.driverSeatPosition, v.scale, new Cartesian3());
        const markerRadius = Math.max(0.08, Math.min(0.2, v.size.w * 0.05));
        for (const axis of ["x", "y", "z"] as const) {
            const start = Cartesian3.clone(seat, new Cartesian3());
            const end = Cartesian3.clone(seat, new Cartesian3());
            start[axis] -= markerRadius;
            end[axis] += markerRadius;
            values[offset++] = start.x; values[offset++] = start.y; values[offset++] = start.z;
            values[offset++] = end.x; values[offset++] = end.y; values[offset++] = end.z;
        }
        return new Primitive({
            geometryInstances: new GeometryInstance({
                geometry: new Geometry({
                    attributes: {
                        position: new GeometryAttribute({
                            componentDatatype: ComponentDatatype.DOUBLE,
                            componentsPerAttribute: 3,
                            values,
                        }),
                    } as any,
                    primitiveType: PrimitiveType.LINES,
                    boundingSphere: BoundingSphere.fromVertices(values as any),
                }),
                attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE) },
            }),
            appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
            asynchronous: false,
            show: false,
        });
    }

    // 用四元数旋转向量
    private rotateVectorByQuaternion(
        vector: { x: number; y: number; z: number },
        q: { x: number; y: number; z: number; w: number },
        out: Cartesian3,
    ): Cartesian3 {
        const ix = q.w * vector.x + q.y * vector.z - q.z * vector.y;
        const iy = q.w * vector.y + q.z * vector.x - q.x * vector.z;
        const iz = q.w * vector.z + q.x * vector.y - q.y * vector.x;
        const iw = -q.x * vector.x - q.y * vector.y - q.z * vector.z;
        out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
        out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
        out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
        return out;
    }
}
