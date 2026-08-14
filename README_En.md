English | [中文](README.md)

# cesium-player-controller

> **Note:** Since CesiumJS cannot directly access 3D Tiles vertex coordinates via CPU, you can use the [collider-forge](https://github.com/hh-hang/collider-forge) tool to create colliders.

[![NPM Package][npm]][npm-url]
[![Github][github]][github-url]
[![X][x]][x-url]
[![Three.js](https://img.shields.io/badge/Three.js-player_controller-blue)](https://github.com/hh-hang/three-player-controller)

An out-of-the-box player controller for CesiumJS, providing character capsule collision, animations, first/third-person view switching, and camera collision avoidance.

# Example

[![Online Demo](https://github.com/hh-hang/cesium-player-controller/blob/main/example/public/imgs/preview.png)](https://hh-hang.github.io/cesium-player-controller/index.html)

# Installation

```bash
npm install cesium-player-controller @dimforge/rapier3d-compat
```

# Local Development

```bash
git clone https://github.com/hh-hang/cesium-player-controller.git
npm install
npm run dev
```

Access `http://localhost:5173/cesium-player-controller/` in your browser.

# Usage

```ts
import {
    Cartesian3,
    Cesium3DTileset,
    Viewer,
    Math as CMath,
    Cartographic,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { playerController } from "cesium-player-controller";

// Set up CesiumJS environment
const viewer = new Viewer("cesiumContainer", {
    timeline: false,
    animation: false,
});

// Load 3D Tiles scene
const tileset = await Cesium3DTileset.fromUrl("./tileset.json");
viewer.scene.primitives.add(tileset);
await viewer.flyTo(tileset);

// Set player spawn point
const center = tileset.boundingSphere.center;
const carto = Cartographic.fromCartesian(center);
const initPos = Cartesian3.fromDegrees(
    CMath.toDegrees(carto.longitude),
    CMath.toDegrees(carto.latitude),
    carto.height + 20,
);

// Core usage of playerController
const player = new playerController();

// Player control initialization
await player.init({
    viewer,   // Cesium Viewer instance
    initPos,  // Player initial coordinates, ECEF
    playerModelConfig: {
        url: "./glb/person.glb",   // Model path (GLB/GLTF)
        scale: 0.01,               // Model scale
        idleAnim: "idle",          // Idle animation name
        walkAnim: "walk",          // Walk animation name
        runAnim: "run",            // Run animation name
        jumpAnim: "jump",          // Jump animation name; or ["takeoff", "loop", "land"] for three-stage playback
    },
    // Static collider source
    staticCollider: {
        type: "gltf",
        url: "./glb/agi-hq.glb",
        position: center,
    },
});

// Vehicle controller initialization (optional)
await player.loadVehicleModel({
    url: "./glb/sedan.glb",                                        // Vehicle model URL
    position: Cartesian3.clone(initPos),                           // Vehicle position (ECEF)
    wheelsNames: ["Wheel_LF", "Wheel_RF", "Wheel_LR", "Wheel_RR"], // Order: front-left, front-right, rear-left, rear-right
    driverSeatPosition: new Cartesian3(-0.11, 0.19, 0.84),         // Driver seat, local coordinates
});

// Call per frame
viewer.scene.preUpdate.addEventListener(() => {
    player.update();
});
```

### Full Parameter Example

#### `init()`

```ts
await player.init({
    // Required
    viewer,   // Cesium Viewer instance
    initPos,  // Initial spawn point (ECEF)
    playerModelConfig: {
        url: "./glb/person.glb",   // Model path (GLB/GLTF)
        scale: 0.01,               // Model scale
        idleAnim: "idle",          // Idle animation name
        walkAnim: "walk",          // Walk animation name
        runAnim: "run",            // Run animation name
        jumpAnim: "jump",          // Jump animation name; or ["start", "loop", "land"] for three-stage playback

        // Directional animations (optional, reuses default animations if not provided)
        leftWalkAnim: "leftWalk",         // Defaults to walkAnim
        rightWalkAnim: "rightWalk",       // Defaults to walkAnim
        backwardAnim: "walkBack",         // Defaults to walkAnim
        flyAnim: "fly",                   // Defaults to idleAnim
        flyIdleAnim: "flyIdle",           // Defaults to idleAnim
        flyHoverForwardAnim: "flyFwd",    // Defaults to flyAnim
        flyHoverBackAnim: "flyBack",      // Defaults to flyIdleAnim
        flyHoverLeftAnim: "flyLeft",      // Defaults to flyIdleAnim
        flyHoverRightAnim: "flyRight",    // Defaults to flyIdleAnim
        flyHoverUpAnim: "flyUp",          // Defaults to flyIdleAnim
        flyHoverDownAnim: "flyDown",      // Defaults to flyIdleAnim
        drivingAnim: "driving",           // Driving animation; defaults to idleAnim

        // Physics parameters (optional)
        gravity: -2400,     // Gravity base value, scaled by 'scale'
        jumpHeight: 600,    // Jump height base value, scaled by 'scale'
        speed: 300,         // Movement speed base value, scaled by 'scale'
        flySpeed: 2100,     // Flight speed base value, scaled by 'scale'
        acceleration: 30,   // XZ acceleration response speed
        deceleration: 30,   // XZ deceleration response speed

        // Model parameters (optional)
        rotateY: 0,                            // Initial player orientation (radians)
        facingOffset: 0,                       // Model front axis correction (radians)
        firstPersonCameraOffset: [0, 0, 0],    // First-person camera local offset (x=right, y=forward, z=up, rotates with heading)
        capsuleRadiusRatio: 1,                 // Capsule radius multiplier
    },

    // Static collider source
    staticCollider: [
        // Terrain collision
        {
            type: "terrain",
            rectangle: [west, south, east, north], // Radians
            resolution: 64,
        },
        // Model collision
        {
            type: "gltf",
            url: `${import.meta.env.BASE_URL}glb/agi-hq.glb`,
            position: newCenter,
        },
    ],
    // Kinematic collider source
    kinematicCollider: {
        type: "gltf",
        url: "./glb/platform.glb",
        position: initPos,
        rotation: { heading: 0, pitch: 0, roll: 0 },
        scale: 1,
    },

    // Camera (optional)
    minCamDistance: 100,           // Third-person minimum camera distance
    maxCamDistance: 440,           // Third-person maximum camera distance
    camLookAtHeightRatio: 0.8,     // Camera look-at point height ratio, 0=bottom 1=top
    thirdMouseMode: 1,             // Mouse control mode 0-5, see field description
    enableZoom: false,             // Whether to allow scroll wheel zoom
    enableOverShoulderView: false, // Whether to enable over-the-shoulder view
    isFirstPerson: false,          // Whether to start in first-person view
    enableSpringCamera: false,     // Whether to enable spring camera
    springCameraTime: 0.05,        // Spring camera smoothing time (seconds), smaller means tighter follow

    // Other (optional)
    mouseSensitivity: 5,           // Mouse sensitivity
    timeScale: 1,                  // Time scale factor, < 1 for slow motion, > 1 for fast forward
    keyMap: {                      // Custom key bindings (defaults below; can rebind, array for multiple keys, or null to disable)
        forward: ["KeyW", "ArrowUp"],        // Move forward
        backward: ["KeyS", "ArrowDown"],     // Move backward
        left: ["KeyA", "ArrowLeft"],         // Move left
        right: ["KeyD", "ArrowRight"],       // Move right
        sprint: ["ShiftLeft", "ShiftRight"], // Sprint
        jump: ["Space"],                     // Jump
        toggleView: ["KeyV"],                // Toggle view (first/third person)
        toggleFly: ["KeyF"],                 // Toggle flight mode
        toggleVehicle: ["KeyE"],             // Enter / exit vehicle
    },
    isShowMobileControls: true,    // Whether to show virtual controls UI on mobile
    mobileControls: {              // Mobile button visibility and appearance
        joystick: true,             // Whether to show joystick, default true
        jump: {
            icon: "/jump.svg",
            // brakeIcon: "/brake.svg",
            right: 24,
            bottom: 32,
            size: 64,
        },
        fly: true,                  // Whether to show fly button, default true
        view: true,                 // Whether to show view toggle button, default true
        vehicle: true,
    },
});
```

#### `loadVehicleModel()`

```ts
await player.loadVehicleModel({
    // Required
    url: "./glb/sedan.glb",                                        // Vehicle model URL
    position: Cartesian3.clone(initPos),                           // Vehicle position (ECEF)
    wheelsNames: ["Wheel_LF", "Wheel_RF", "Wheel_LR", "Wheel_RR"], // Order: front-left, front-right, rear-left, rear-right
    driverSeatPosition: new Cartesian3(-0.11, 0.19, 0.84),         // Driver seat, local coordinates

    // Optional
    scale: 0.9,                                // Vehicle model scale, default 1
    driverSeatRotation: 0,                     // Driver-seat horizontal rotation (radians), default 0
    chassisRatio: 0.2,                         // Chassis height ratio, default 0.2
    suspensionRestLengthRatio: 0.2,            // Suspension rest length ratio, default 0.2
    followVehicleDirection: true,              // Camera follows vehicle direction while driving, default true
    mass: 1500,                                // Vehicle mass base value (kg), scaled by 'scale', default 1500
    maxSpeed: 300,                             // Top speed base value (km/h), scaled by 'scale', default 300
    acceleration: 8,                           // Acceleration base value (m/s²), scaled by 'scale', default 8
    deceleration: 8,                           // Braking deceleration base value (m/s²), scaled by 'scale', default 8
});
```

# API

## Lifecycle

| Method | Description |
| --- | --- |
| `init(opts, callback?)` | Initializes the controller, `callback` is executed after resources are loaded. |
| `update(delta)` | Updates movement, collision, camera, and animations every frame. |
| `destroy()` | Destroys the controller and removes event listeners. |
| `reset(pos?)` | Resets the character to a specified position or initial position. |
| `switchPlayerModel(model)` | Switches the character model at runtime, retaining current position and orientation. |
| `loadVehicleModel(opts)` | Loads a vehicle. Can be called multiple times for multiple vehicles. |
| `changeView()` | Toggles between first/third-person view. |
| `setFirstPersonCamera(vertAngle?)` | Directly enters first-person view, can specify initial vertical angle. |
| `setFirstPersonCameraOffset(offset)` | Sets the first-person camera local offset at runtime in `[right, forward, up]` order. |
| `addKinematicCollider(collider, source?)` | Registers a kinematic collider. |
| `removeKinematicCollider(source)` | Removes a registered kinematic collider. |
| `clearKinematicColliders()` | Removes all kinematic colliders. |

## Dynamic Objects

Objects that can be pushed by the character and are driven by gravity and collision (ball / box / cylinder / cone).

```ts
import { Cartesian3, Color, EllipsoidGeometry, GeometryInstance, Primitive,
    PerInstanceColorAppearance, ColorGeometryInstanceAttribute, VertexFormat } from "cesium";

// 1) Create a dynamic object (physics: a ball of radius 0.25)
const ball = player.addDynamicObject(spawnEcef, { kind: "ball", radius: 0.25 }, { density: 30, restitution: 0.3 });

// 2) Create the visual yourself and add it to the scene (built-in geometry here; could be Model.fromGltfAsync for a glb)
const sphere = new Primitive({
    geometryInstances: new GeometryInstance({
        geometry: new EllipsoidGeometry({ radii: new Cartesian3(0.25, 0.25, 0.25), vertexFormat: VertexFormat.POSITION_AND_NORMAL }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.ORANGE) },
    }),
    appearance: new PerInstanceColorAppearance(),
    asynchronous: false,
});
viewer.scene.primitives.add(sphere);

// 3) Bind the visual; the library syncs its pose every frame
ball.attachVisual(sphere);

// On removal: the library only removes physics; remove the visual yourself
player.removeDynamicObject(ball);
viewer.scene.primitives.remove(sphere);
```

| Method | Description |
| --- | --- |
| `addDynamicObject(positionEcef, shape, opts?)` | Creates a dynamic object and returns a `DynamicObject` handle. See [`DynamicShape`](#dynamicshape) for `shape` and [`DynamicBodyOpts`](#dynamicbodyopts) for `opts`. |
| `removeDynamicObject(obj)` | Removes a dynamic object (physics and debug wireframe only; remove the visual yourself). |
| `clearDynamicObjects()` | Removes all dynamic objects (same as above; clean up visuals yourself). |

`DynamicObject` handle methods:

| Method | Description |
| --- | --- |
| `attachVisual(visual)` | Binds an object with a `modelMatrix`; the library syncs its pose every frame. |
| `detachVisual()` | Unbinds the visual (does not dispose it, only stops syncing). |

## State Retrieval

| Method | Returns |
| --- | --- |
| `getPosition()` | Current character position, `Cartesian3` type. |
| `getVelocity()` | Current character velocity, returns `{ e, n, u }`. |
| `getIsFirstPerson()` | Whether currently in first-person view. |
| `getIsFlying()` | Whether currently in flight mode. |
| `getIsOnGround()` | Whether currently on the ground. |
| `getControllerMode()` | `0` for player mode, `1` for vehicle mode. |
| `getPlayerModel()` | Current loaded character model object. |
| `getPlayerCapsule()` | Character capsule dimensions. |
| `getActiveVehicle()` | The current vehicle instance in use. |
| `getAllVehicles()` | All loaded vehicle instances. |
| `getCollider()` | Rapier character collider. |
| `getCurrentPlayerAnimationName()` | Name of the currently playing animation clip, `null` if none. |
| `getCenterScreenRaycastHit()` | Raycast result from the center of the screen, suitable for aiming or interaction. |
| `getActiveKinematicCollider()` | The kinematic collider the player is currently standing on, `null` if not on one. |
| `getCurrentLocomotionSet()` | Name of the current locomotion set. |

## Input and Runtime Control

| Method | Description |
| --- | --- |
| `setInput(input)` | Injects external input state, suitable for gamepads or custom key systems. |
| `setKeyMap(map?)` | Customizes key bindings at runtime; restores default key bindings if not provided (see Custom Key Bindings). |
| `setMouseSensitivity(v)` | Sets mouse sensitivity. |
| `setPlayerScale(v)` | Dynamically modifies character scale and synchronizes collision parameters. |
| `setPlayerSpeed(v)` | Sets movement speed. |
| `setPlayerFlySpeed(v)` | Sets flight speed. |
| `setJumpHeight(v)` | Sets jump height. |
| `setGravity(v)` | Sets gravity. |
| `setMinCamDistance(v)` | Sets third-person minimum camera distance. |
| `setMaxCamDistance(v)` | Sets third-person maximum camera distance. |
| `setCamLookAtHeightRatio(v)` | Sets third-person camera look-at point height ratio (0=bottom, 1=top). |
| `setThirdMouseMode(v)` | Sets third-person mouse mode: `0 | 1 | 2 | 3 | 4 | 5`. |
| `setEnableZoom(v)` | Sets whether to allow camera zoom. |
| `setOverShoulderView(v)` | Toggles over-the-shoulder view offset. |
| `setDebug(v)` | Toggles collider debug display. |
| `setEnableToward(v)` | Toggles mouse-driven orientation/view updates. |

### Input Listening

After `init()` is complete, keyboard and mouse listeners are enabled by default and do not need to be called manually. The following two methods are used to temporarily disable and then re-enable listening at runtime.

```ts
player.offAllEvent(); // Disables keyboard and mouse input listening
player.onAllEvent();  // Re-enables keyboard and mouse input listening
```

### Default Key Bindings

| Action | Default Key | Function |
| --- | --- | --- |
| `forward` | `W` / `ArrowUp` | Move forward |
| `backward` | `S` / `ArrowDown` | Move backward |
| `left` | `A` / `ArrowLeft` | Move left |
| `right` | `D` / `ArrowRight` | Move right |
| `sprint` | `Shift` | Sprint |
| `jump` | `Space` | Jump |
| `toggleView` | `V` | Toggle view |
| `toggleFly` | `F` | Toggle flight mode |
| `toggleVehicle` | `E` | Enter / exit vehicle |
| - | Mouse movement / drag | Control view |

### Custom Key Bindings

Through `keyMap`, any action in the table above can be remapped to other keys, or an action can be disabled. Key names use `KeyboardEvent.code` (e.g., `"KeyE"`, `"ArrowUp"`, `"Space"`, note it's `"KeyE"` not `"e"`).

Each action has three possible values:

- **Not provided** -> Uses default key
- **String / String array** -> Replaces with specified key(s) (array can bind multiple keys)
- **`null`** -> Disables the action (no key will trigger it)

Configuration during initialization:

```ts
await player.init({
    // ...
    keyMap: {
        forward: "KeyE",          // Changes to E for forward (replaces default W / ↑)
        jump: null,               // Disables jump
        left: ["KeyA", "KeyJ"],   // Binds A and J simultaneously
        // Other actions not provided, retain default keys
    },
});
```

Switching key binding schemes at runtime:

```ts
player.setKeyMap({ forward: "KeyI", backward: "KeyK" }); // Applies new key bindings
player.setKeyMap();                                      // Restores all default key bindings
```

### `setInput`

```ts
player.setInput({
    moveX: number,         // Horizontal movement axis, range -1..1
    moveY: number,         // Vertical movement axis, range -1..1
    lookDeltaX: number,   // View horizontal increment, usually from mousemove's movementX
    lookDeltaY: number,   // View vertical increment, usually from mousemove's movementY
    jump: boolean,        // Jump, continuous state; controls ascent when flying
    shift: boolean,       // Sprint/accelerate, continuous state
    toggleView: boolean,  // Triggered, pass true to toggle first/third-person view
    toggleFly: boolean,   // Triggered, pass true to toggle flight mode
    toggleVehicle: boolean, // Triggered, pass true to enter / exit vehicle
});
```

## Animations

| Method | Description |
| --- | --- |
| `playPlayerAnimationByName(name)` | Plays character animation directly by animation clip name. |
| `registerAnimation(key, clipName, opts?)` | Registers a custom animation clip. |
| `playAnimation(key, opts?)` | Plays a registered custom animation. |
| `registerLocomotionSet(setName, map)` | Registers a set of locomotion animations to replace built-in locomotion animations. |
| `switchLocomotionSet(setName)` | Switches to the specified locomotion animation set. |

### `registerAnimation`

```ts
player.registerAnimation(key, clipName, {
    loop?: boolean,              // Whether to loop playback, default true
    timeScale?: number,          // Animation playback scale, default 1
    duration?: number,           // Animation playback duration, default 0
    clampWhenFinished?: boolean, // Whether to hold the last frame after playback, default false
    onFinished?: () => void,     // Triggered after animation playback finishes
});
```

### `playAnimation`

```ts
player.playAnimation(key, {
    force?: boolean,        // If true, forces replay from the beginning, even if already playing this animation
    returnToPrev?: boolean, // Only effective for one-shot animations, automatically restores previous animation state after playback
});
```

### `registerLocomotionSet`

Supported keys: `idle` | `walking` | `walking_backward` | `running` | `jumping` | `flyidle` | `flying`. Provided keys will replace corresponding built-in animations; unprovided keys will retain original animations.

```ts
player.registerLocomotionSet("combat", {
    idle: "CombatIdle",
    walking: "CombatWalk",
    walking_backward: "CombatBack",
    running: "CombatRun",
    jumping: "CombatJump",
    flyidle: "CombatFlyIdle",
    flying: "CombatFly",
});
```

## Events

```ts
player.onAnimationChange = (name) => {};       // Triggered when character's current animation changes
player.onBeforeViewChange = (isFirstPerson) => {}; // Triggered before first/third-person view switch
player.onViewChange = (isFirstPerson) => {};   // Triggered after first/third-person view switch
player.onGroundChange = (onGround) => {};      // Triggered when ground state changes
player.onVehicleEnter = (vehicle) => {};       // Triggered after entering a vehicle
player.onVehicleExit = (vehicle) => {};        // Triggered after exiting a vehicle
player.onTowardChange = (dx, dy, speed) => {}; // Triggered when orientation/view input updates
```

## Field Descriptions

### `PlayerControllerOptions`

| Field | Type | Required | Default Value | Description |
| --- | --- | --- | --- | --- |
| `viewer` | `Viewer` | Yes | - | Cesium Viewer instance. |
| `playerModelConfig` | `PlayerModelOptions` | Yes | - | Character model and parameter configuration. |
| `initPos` | `Cartesian3` | Yes | - | Initial spawn point (ECEF). |
| `staticCollider` | `ColliderSource \| ColliderSource[]` | No | - | Static collider source; if not provided, only uses basic ground detection. |
| `kinematicCollider` | `ColliderSource \| ColliderSource[]` | No | - | Kinematic colliders (movable platforms) registered during initialization. |
| `mouseSensitivity` | `number` | No | `5` | Mouse sensitivity. |
| `minCamDistance` | `number` | No | `100` | Third-person minimum camera distance. |
| `maxCamDistance` | `number` | No | `440` | Third-person maximum camera distance. |
| `camLookAtHeightRatio` | `number` | No | `0.8` | Third-person camera look-at point height ratio (0=capsule bottom, 1=top). |
| `thirdMouseMode` | `0 \| 1 \| 2 \| 3 \| 4 \| 5` | No | `1` | Third-person view mouse control mode (0: hide mouse, control orientation and view; 1: hide mouse, control view only; 2: show mouse, drag to control orientation and view; 3: show mouse, drag to control view only; 4: show mouse, drag to control view and character orientation follows camera horizontal direction; 5: hide mouse, control view and character orientation follows camera horizontal direction). |
| `enableZoom` | `boolean` | No | `false` | Whether to allow scroll wheel zoom. |
| `enableOverShoulderView` | `boolean` | No | `false` | Whether to enable over-the-shoulder view. |
| `isFirstPerson` | `boolean` | No | `false` | Whether to directly enter first-person view on initialization. |
| `enableSpringCamera` | `boolean` | No | `false` | Whether to enable spring camera. |
| `springCameraTime` | `number` | No | `0.05` | Spring smoothing time (seconds), smaller means tighter follow. |
| `timeScale` | `number` | No | `1` | Time scale factor, < 1 for slow motion, > 1 for fast forward. |
| `keyMap` | `KeyMap` | No | Default key bindings | Custom key mapping, see Custom Key Bindings. |
| `isShowMobileControls` | `boolean` | No | `true` | Whether to display virtual control UI on mobile. |
| `mobileControls` | `MobileControlsOptions` | No | All shown | Mobile button visibility, position, size, and image configuration. |

### `PlayerModelOptions`

| Field | Type | Required | Default Value | Description |
| --- | --- | --- | --- | --- |
| `url` | `string` | Yes | - | Character model path (GLB/GLTF). |
| `scale` | `number` | Yes | - | Character model scale. |
| `idleAnim` | `string` | Yes | - | Idle animation name. |
| `walkAnim` | `string` | Yes | - | Walk animation name. |
| `runAnim` | `string` | Yes | - | Run animation name. |
| `jumpAnim` | `string \| [string, string, string]` | Yes | - | Jump animation name. Pass a string for a single animation; pass a three-element array `[takeoff, loop, land]` for three-stage playback. |
| `leftWalkAnim` | `string` | No | `walkAnim` | Left walk animation name, defaults to `walkAnim` if not provided. |
| `rightWalkAnim` | `string` | No | `walkAnim` | Right walk animation name, defaults to `walkAnim` if not provided. |
| `backwardAnim` | `string` | No | `walkAnim` | Backward animation name, defaults to `walkAnim` if not provided. |
| `flyAnim` | `string` | No | `idleAnim` | Fly animation name, defaults to `idleAnim` if not provided. |
| `flyIdleAnim` | `string` | No | `idleAnim` | Fly idle animation name, defaults to `idleAnim` if not provided. |
| `flyHoverForwardAnim` | `string` | No | `flyAnim` | Hover animation name when flying forward. |
| `flyHoverBackAnim` | `string` | No | `flyIdleAnim` | Hover animation name when flying backward. |
| `flyHoverLeftAnim` | `string` | No | `flyIdleAnim` | Hover animation name when flying left. |
| `flyHoverRightAnim` | `string` | No | `flyIdleAnim` | Hover animation name when flying right. |
| `flyHoverUpAnim` | `string` | No | `flyIdleAnim` | Hover animation name when flying up. |
| `flyHoverDownAnim` | `string` | No | `flyIdleAnim` | Hover animation name when flying down. |
| `drivingAnim` | `string` | No | `idleAnim` | Driving animation name, defaults to `idleAnim` if not provided. |
| `gravity` | `number` | No | `-2400` | Gravity base value (scaled by `scale`). |
| `jumpHeight` | `number` | No | `600` | Jump height base value (scaled by `scale`). |
| `speed` | `number` | No | `300` | Movement speed base value (scaled by `scale`). |
| `flySpeed` | `number` | No | `2100` | Flight speed base value (scaled by `scale`). |
| `rotateY` | `number` | No | `0` | Initial character orientation (radians). |
| `facingOffset` | `number` | No | `0` | Model front axis correction (radians). |
| `firstPersonCameraOffset` | `[number, number, number]` | No | `[0,0,0]` | First-person camera local offset. Based on the capsule top, applied in the player heading frame (`x`=right, `y`=forward, `z`=up), rotates with `yaw`, scaled by `scale`. |
| `capsuleRadiusRatio` | `number` | No | `1` | Capsule radius multiplier. |
| `acceleration` | `number` | No | `30` | XZ acceleration response speed, higher value means faster acceleration. |
| `deceleration` | `number` | No | `30` | XZ deceleration response speed, higher value means faster stopping. |

### `ColliderSource`

| Type | Fields | Description |
| --- | --- | --- |
| `terrain` | `rectangle`, `resolution?` | Cesium terrain collider source, `rectangle` is `[west, south, east, north]` in radians. |
| `gltf` | `url`, `position?`, `rotation?`, `scale?`, `modelMatrix?` | glTF / GLB collider source. |

### `VehicleOptions`

| Field | Type | Required | Default Value | Description |
| --- | --- | --- | --- | --- |
| `url` | `string` | Yes | - | Vehicle model path (GLB/GLTF). |
| `position` | `Cartesian3` | Yes | - | Initial world position (ECEF). |
| `wheelsNames` | `string[]` | Yes | - | Wheel node names in order: front-left, front-right, rear-left, rear-right. |
| `scale` | `number` | No | `1` | Vehicle model scale. |
| `driverSeatPosition` | `Cartesian3` | Yes | - | Driver-seat capsule center in chassis-local coordinates. |
| `driverSeatRotation` | `number` | No | `0` | Horizontal driver-seat rotation relative to vehicle forward (radians). |
| `chassisRatio` | `number` | No | `0.2` | Chassis height ratio. |
| `suspensionRestLengthRatio` | `number` | No | `0.2` | Suspension rest length ratio. |
| `followVehicleDirection` | `boolean` | No | `true` | Whether the camera follows the vehicle direction while driving. |
| `mass` | `number` | No | `1500` | Vehicle mass base value (kg, scaled by `scale`). |
| `maxSpeed` | `number` | No | `300` | Top speed base value (km/h, scaled by `scale`). |
| `acceleration` | `number` | No | `8` | Acceleration base value (m/s², scaled by `scale`). |
| `deceleration` | `number` | No | `8` | Braking deceleration base value (m/s², scaled by `scale`). |

### `DynamicShape`

Collision shape of a dynamic object. Geometry parameters are in world scale (meters).

| `kind` | Fields | Description |
| --- | --- | --- |
| `ball` | `radius` | Sphere. |
| `box` | `half` | Box; `half` is the ENU half-extents `{ e, n, u }`. |
| `cylinder` | `halfHeight`, `radius` | Cylinder, axis along local Up. |
| `cone` | `halfHeight`, `radius` | Cone, axis along local Up (apex up). |

### `DynamicBodyOpts`

| Field | Type | Required | Default Value | Description |
| --- | --- | --- | --- | --- |
| `density` | `number` | No | `1` | Density; affects mass and push feel (mass = volume × density). |
| `restitution` | `number` | No | `0.2` | Restitution; `0` no bounce, `1` fully elastic. |
| `friction` | `number` | No | `0.6` | Friction. |
| `linearDamping` | `number` | No | `0.4` | Linear damping; higher stops sliding sooner. |
| `angularDamping` | `number` | No | `0.6` | Angular damping; higher stops spinning sooner. |

### `MobileControlsOptions`

| Field | Type | Required | Default Value | Description |
| --- | --- | --- | --- | --- |
| `joystick` | `boolean` | No | `true` | Whether to show joystick. |
| `jump` | `boolean \| JumpButtonOptions` | No | `true` | Jump/brake button. Pass `false` to hide it or an object to customize its image and layout. |
| `fly` | `boolean \| MobileButtonOptions` | No | `true` | Flight button; object form customizes position, size, and image. |
| `view` | `boolean \| MobileButtonOptions` | No | `true` | View button; object form customizes position, size, and image. |
| `vehicle` | `boolean \| MobileButtonOptions` | No | `true` | Enter/exit vehicle button. Pass `false` to hide it or an object to customize its image and layout. |

### `MobileButtonOptions` / `JumpButtonOptions`

| Field | Type | Required | Default Value | Description |
| --- | --- | --- | --- | --- |
| `left` / `right` | `number` | No | built-in position | Distance from the left or right edge in px. Setting `left` without `right` clears the default right position. |
| `top` / `bottom` | `number` | No | built-in position | Distance from the top or bottom edge in px. Setting `top` without `bottom` clears the default bottom position. |
| `size` | `number` | No | `56` | Circular button diameter in px. |
| `icon` | `string` | No | English label | Custom image URL. |
| `brakeIcon` | `string` | No | `BRAKE` label | Available only on `JumpButtonOptions`; sets the brake image URL used in vehicle mode. |

The mobile joystick outputs continuous `-1..1` direction axes for full 360° movement.

# Feedback

If you have any questions or good ideas, please feel free to submit an issue.

# Acknowledgements

CesiumJS

Rapier

[npm]: https://img.shields.io/npm/v/cesium-player-controller
[npm-url]: https://www.npmjs.com/package/cesium-player-controller
[github]: https://img.shields.io/badge/-hh--hang-181717?style=flat&logo=github&logoColor=white&labelColor=888
[github-url]: https://github.com/hh-hang
[x]: https://img.shields.io/badge/-vgyuvhang-000000?style=flat&logo=x&logoColor=white&labelColor=888
[x-url]: https://x.com/vgyuvhang
