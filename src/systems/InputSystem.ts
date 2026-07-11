import { ScreenSpaceEventHandler, ScreenSpaceEventType, KeyboardEventModifier } from "cesium";
import type { playerController } from "../playerController";
import type { KeyAction, KeyMap } from "../types";

// 默认键位表（动作 -> KeyboardEvent.code 列表）
const defaultKeyMap: Record<KeyAction, string[]> = {
    forward: ["KeyW", "ArrowUp"],
    backward: ["KeyS", "ArrowDown"],
    left: ["KeyA", "ArrowLeft"],
    right: ["KeyD", "ArrowRight"],
    sprint: ["ShiftLeft", "ShiftRight"],
    jump: ["Space"],
    toggleView: ["KeyV"],
    toggleFly: ["KeyF"],
};

export class InputSystem {
    private ctrl: playerController; // 主控制器引用

    fwd = false; // 前进键
    bkd = false; // 后退键
    lft = false; // 左移键
    rgt = false; // 右移键
    space = false; // 跳跃键
    shift = false; // 加速键

    private keyFwd = false;
    private keyBkd = false;
    private keyLft = false;
    private keyRgt = false;
    private analogMoveX = 0;
    private analogMoveY = 0;

    private boundKeydown = (e: KeyboardEvent) => this.onKeydown(e); // 键盘按下绑定
    private boundKeyup = (e: KeyboardEvent) => this.onKeyup(e); // 键盘抬起绑定
    private boundMouseMove = (e: MouseEvent) => this.onMouseMove(e); // 鼠标移动绑定
    private boundMouseClick = (e: MouseEvent) => {
        if (e.target === this.ctrl.viewer.canvas) this.ctrl.cam.setPointerLock(); // 鼠标点击绑定
    };
    private boundBlur = () => this.resetKeys(); // 页面失焦时重置按键状态

    private dragging = false; // 是否正在拖拽
    private ssceHandler?: ScreenSpaceEventHandler; // Cesium 拖拽输入处理器
    private codeToAction = new Map<string, KeyAction>(); // 键码 -> 动作 反查表

    constructor(ctrl: playerController) {
        this.ctrl = ctrl;
        this.buildKeyMap();
    }

    // 构建键码：动作 反查表：未传的动作用默认键，传 string/数组则覆盖，传 null 则禁用
    buildKeyMap(userMap?: KeyMap) {
        this.codeToAction.clear(); // 清空旧表
        for (const action of Object.keys(defaultKeyMap) as KeyAction[]) {
            let codes: string[];
            if (userMap && action in userMap) {
                const v = userMap[action];
                if (v == null) continue; // null：禁用该动作
                codes = Array.isArray(v) ? v : [v]; // 覆盖默认键
            } else {
                codes = defaultKeyMap[action]; // 未传：用默认键
            }
            for (const code of codes) this.codeToAction.set(code, action);
        }
    }

    // 程序化输入接口
    setInput(input: Partial<{
        moveX: number; moveY: number;
        lookDeltaX: number; lookDeltaY: number;
        jump: boolean; shift: boolean;
        toggleView: boolean; toggleFly: boolean;
    }>) {
        const c = this.ctrl;

        // 连续移动轴，供摇杆或手柄输入使用。
        let moveChanged = false;
        if (typeof input.moveX === "number") {
            this.analogMoveX = Math.max(-1, Math.min(1, input.moveX));
            moveChanged = true;
        }
        if (typeof input.moveY === "number") {
            this.analogMoveY = Math.max(-1, Math.min(1, input.moveY));
            moveChanged = true;
        }
        if (moveChanged) {
            this.syncDirectionFlags();
            c.animation.setAnimationByPressed();
        }

        // 视角朝向
        if (typeof input.lookDeltaX === "number" && typeof input.lookDeltaY === "number") {
            c.cam.setToward(input.lookDeltaX, input.lookDeltaY, 0.002);
        }

        // 持续状态
        if (typeof input.jump === "boolean") this.applyAction("jump", input.jump);
        if (typeof input.shift === "boolean") this.applyAction("sprint", input.shift);

        // 触发式切换
        if (input.toggleView) this.applyAction("toggleView", true);
        if (input.toggleFly) this.applyAction("toggleFly", true);
    }

    // 绑定输入事件
    bindEvents() {
        this.ctrl.isupdate = true;
        this.ctrl.cam.setPointerLock();
        window.addEventListener("keydown", this.boundKeydown);
        window.addEventListener("keyup", this.boundKeyup);
        window.addEventListener("mousemove", this.boundMouseMove);
        window.addEventListener("click", this.boundMouseClick);
        window.addEventListener("blur", this.boundBlur);

        // 非锁定模式（2/3/4）的拖拽旋转：走 Cesium 输入管线。
        const handler = new ScreenSpaceEventHandler(this.ctrl.viewer.canvas);
        const modifiers: (KeyboardEventModifier | undefined)[] = [
            undefined, KeyboardEventModifier.SHIFT
        ];
        for (const m of modifiers) {
            handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.onDragStart(e), ScreenSpaceEventType.LEFT_DOWN, m);
            handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => this.onDragMove(e), ScreenSpaceEventType.MOUSE_MOVE, m);
            handler.setInputAction(() => this.onDragEnd(), ScreenSpaceEventType.LEFT_UP, m);
            // 滚轮缩放最大镜头距
            handler.setInputAction((delta: number) => this.ctrl.cam.zoomByWheel(delta), ScreenSpaceEventType.WHEEL, m);
        }

        this.ssceHandler = handler;
    }

    // 解绑输入事件
    unbindEvents() {
        this.ctrl.isupdate = false;
        document.exitPointerLock?.();
        this.dragging = false;
        window.removeEventListener("keydown", this.boundKeydown);
        window.removeEventListener("keyup", this.boundKeyup);
        window.removeEventListener("mousemove", this.boundMouseMove);
        window.removeEventListener("click", this.boundMouseClick);
        window.removeEventListener("blur", this.boundBlur);

        this.ssceHandler?.destroy();
        this.ssceHandler = undefined;
    }

    // 重置所有按键状态
    private resetKeys() {
        this.keyFwd = this.keyBkd = this.keyLft = this.keyRgt = false;
        this.analogMoveX = this.analogMoveY = 0;
        this.syncDirectionFlags();
        this.space = false;
        this.shift = false;
        this.dragging = false;
        this.ctrl.animation.setAnimationByPressed();
    }

    // 统一动作派发
    private applyAction(action: KeyAction, pressed: boolean) {
        const c = this.ctrl;
        switch (action) {
            // 前进
            case "forward": this.keyFwd = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 后退
            case "backward": this.keyBkd = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 左移
            case "left": this.keyLft = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 右移
            case "right": this.keyRgt = pressed; this.syncDirectionFlags(); c.animation.setAnimationByPressed(); break;
            // 冲刺
            case "sprint": this.shift = pressed; c.animation.setAnimationByPressed(); break;
            // 跳跃
            case "jump":
                if (pressed) {
                    this.space = true;
                    if (c.isFlying) { c.animation.setAnimationByPressed(); return; } // 飞行中仅切动画
                    if (!c.playerIsOnGround) return; // 不在地面不能跳
                    if (c.animation.isJumping()) return; // 跳跃中不重复触发
                    c.animation.startJump();
                    c.requestJump();
                    c.setOnGround(false); // 跳跃后设置为不在地面
                } else {
                    this.space = false;
                    if (c.isFlying) c.animation.setAnimationByPressed();
                }
                break;
            // 切换第一 / 第三人称视角
            case "toggleView":
                if (pressed) c.cam.changeView();
                break;
            // 切换飞行模式
            case "toggleFly":
                if (pressed) {
                    c.isFlying = !c.isFlying;
                    if (c.isFlying) c.resetVelocity();
                    c.animation.setAnimationByPressed();
                    if (!c.isFlying && !c.playerIsOnGround) c.animation.startJump(true);
                }
                break;
        }
    }

    // 模拟输入优先；无模拟输入时返回键盘方向轴。
    getMoveAxes() {
        if (this.analogMoveX !== 0 || this.analogMoveY !== 0) {
            return { x: this.analogMoveX, y: this.analogMoveY };
        }
        return {
            x: Number(this.keyRgt) - Number(this.keyLft),
            y: Number(this.keyFwd) - Number(this.keyBkd),
        };
    }

    // 保留方向布尔状态，供动画和飞行分支使用。
    private syncDirectionFlags() {
        const threshold = 0.2;
        this.fwd = this.keyFwd || this.analogMoveY > threshold;
        this.bkd = this.keyBkd || this.analogMoveY < -threshold;
        this.lft = this.keyLft || this.analogMoveX < -threshold;
        this.rgt = this.keyRgt || this.analogMoveX > threshold;
    }

    // 键盘按下处理
    private onKeydown(e: KeyboardEvent) {
        const action = this.codeToAction.get(e.code);
        if (action) this.applyAction(action, true);
    }

    // 键盘抬起处理
    private onKeyup(e: KeyboardEvent) {
        const action = this.codeToAction.get(e.code);
        if (action) this.applyAction(action, false);
    }

    // 鼠标移动处理：锁定模式（0/1/5、第一人称）下指针已锁，移动即转相机
    private onMouseMove(e: MouseEvent) {
        if (document.pointerLockElement) {
            this.ctrl.cam.setToward(e.movementX, e.movementY, 0.0001);
        }
    }

    // 非锁定模式（2/3/4）左键拖拽开始
    private onDragStart(_e: ScreenSpaceEventHandler.PositionedEvent) {
        // 锁定模式下拖拽交给 pointerLock + window mousemove，这里只管非锁定
        if (document.pointerLockElement) return;
        this.dragging = true;
    }

    // 非锁定模式左键拖拽移动：转相机
    private onDragMove(e: ScreenSpaceEventHandler.MotionEvent) {
        if (!this.dragging || document.pointerLockElement) return;
        // Cesium MotionEvent 自带 start（上次）→ end（本次）位移，直接用更可靠（不会跨回调丢帧）
        const dx = e.endPosition.x - e.startPosition.x;
        const dy = e.endPosition.y - e.startPosition.y;
        this.ctrl.cam.setToward(dx, dy, 0.001);
    }

    // 非锁定模式左键拖拽结束
    private onDragEnd() {
        this.dragging = false;
    }
}
