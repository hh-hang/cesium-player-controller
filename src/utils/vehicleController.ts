import {
    Cartesian3, Matrix3, Matrix4, Quaternion,
} from "cesium";
import type { ModelNode } from "cesium";
import type { World } from "@dimforge/rapier3d-compat";

export type WheelInfo = {
    axleCs: Cartesian3;
    suspensionRestLength: number;
    position: Cartesian3;
    radius: number;
    node: ModelNode;
    baseOrientationScale: Matrix4;
    rootFromDesired: Matrix4;
    parentWorldInverse: Matrix4;
    nodeMatrix: Matrix4;
};

// 创建车辆控制器
export function createVehicleController(
    world: World,
    chassisBody: any,
    wheelsInfo: WheelInfo[],
) {
    const vehicle = world.createVehicleController(chassisBody);
    const suspensionDirection = new Cartesian3(0, -1, 0);

    // 注册每个轮子的物理参数
    wheelsInfo.forEach((wheel, index) => {
        vehicle.addWheel(wheel.position, suspensionDirection, wheel.axleCs, wheel.suspensionRestLength, wheel.radius);
        vehicle.setWheelChassisConnectionPointCs(index, wheel.position); // 连接点
        vehicle.setWheelDirectionCs(index, suspensionDirection); // 悬挂方向
        vehicle.setWheelAxleCs(index, wheel.axleCs); // 轮轴方向
        vehicle.setWheelSuspensionRestLength(index, wheel.suspensionRestLength); // 静止长度
        vehicle.setWheelRadius(index, wheel.radius); // 轮胎半径
        vehicle.setWheelMaxSuspensionTravel(index, wheel.suspensionRestLength); // 最大行程
        vehicle.setWheelSuspensionStiffness(index, 250); // 悬挂刚度
        vehicle.setWheelSuspensionCompression(index, 6); // 压缩阻尼
        vehicle.setWheelSuspensionRelaxation(index, 6); // 回弹阻尼
        vehicle.setWheelMaxSuspensionForce(index, 10000); // 最大作用力
        vehicle.setWheelBrake(index, 0); // 制动
        vehicle.setWheelSteering(index, 0); // 转向角
        vehicle.setWheelEngineForce(index, 0); // 驱动力
        vehicle.setWheelFrictionSlip(index, 20); // 纵向抓地
        vehicle.setWheelSideFrictionStiffness(index, 2); // 侧向摩擦
    });

    const up = new Cartesian3(0, 1, 0);
    const wheelAxle = new Cartesian3();
    const wheelSteeringQuat = new Quaternion();
    const wheelRotationQuat = new Quaternion();
    const wheelSteeringRot = new Matrix3();
    const wheelRotationRot = new Matrix3();
    const wheelSteeringMat = new Matrix4();
    const wheelRotationMat = new Matrix4();
    const wheelTranslationMat = new Matrix4();
    const desired = new Matrix4();
    const scratch = new Matrix4();

    // 同步轮子视觉旋转
    function updateWheelVisuals() {
        for (const [index, wheel] of wheelsInfo.entries()) {
            try {
                const wheelAxleCs = vehicle.wheelAxleCs(index) ?? wheel.axleCs;
                const connection = vehicle.wheelChassisConnectionPointCs(index) ?? wheel.position;
                const suspension = vehicle.wheelSuspensionLength(index) ?? 0;
                const steering = vehicle.wheelSteering(index) ?? 0;
                const rotationRad = vehicle.wheelRotation(index) ?? 0;

                // 悬挂压缩偏移
                Matrix4.fromTranslation(
                    new Cartesian3(connection.x, connection.y - suspension, connection.z),
                    wheelTranslationMat,
                );
                // 转向 * 自转
                Quaternion.fromAxisAngle(up, steering, wheelSteeringQuat);
                Cartesian3.fromElements(wheelAxleCs.x, wheelAxleCs.y, wheelAxleCs.z, wheelAxle);
                Quaternion.fromAxisAngle(wheelAxle, rotationRad, wheelRotationQuat);
                Matrix3.fromQuaternion(wheelSteeringQuat, wheelSteeringRot);
                Matrix3.fromQuaternion(wheelRotationQuat, wheelRotationRot);
                Matrix4.fromRotationTranslation(wheelSteeringRot, Cartesian3.ZERO, wheelSteeringMat);
                Matrix4.fromRotationTranslation(wheelRotationRot, Cartesian3.ZERO, wheelRotationMat);
                Matrix4.multiply(wheelTranslationMat, wheelSteeringMat, desired);
                Matrix4.multiply(desired, wheelRotationMat, desired);
                Matrix4.multiply(desired, wheel.baseOrientationScale, desired);
                Matrix4.multiply(wheel.rootFromDesired, desired, scratch);
                Matrix4.multiply(wheel.parentWorldInverse, scratch, wheel.nodeMatrix);
                wheel.node.matrix = wheel.nodeMatrix;
            } catch (e) {}
        }
    }

    // 销毁车辆控制器
    function destroy() {
        try { world.removeVehicleController(vehicle); } catch { }
    }

    return { vehicle, updateWheelVisuals, destroy };
}
