
import {
    Asset,
    BoundingBox,
    Color,
    FlyController,
    Pose,
    Mat4,
    OrbitController,
    Vec2,
    Vec3
} from 'playcanvas';

import { AnimController } from './controllers/anim-controller.js';
import { easeOut } from './core/math.js';
import { AppController } from './input.js';
import { Picker } from './picker.js';
import { chunkCompressedPly } from './chunker.js'; // added for runtime tiling

/** @import { InputController } from 'playcanvas' */

const PITCH_RANGE = new Vec2(-90, 90);

const pose = new Pose();

/**
 * Creates a rotation animation track
 *
 * @param {Pose} initial - The initial pose of the camera.
 * @param {number} [keys] - The number of keys in the animation.
 * @param {number} [duration] - The duration of the animation in seconds.
 * @returns {object} - The animation track object containing position and target keyframes.
 */
const createRotateTrack = (initial, keys = 12, duration = 20) => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const position = [];
    const target = [];

    const initialTarget = new Vec3();
    initial.getFocus(initialTarget);

    const mat = new Mat4();
    const vec = new Vec3();
    const dif = new Vec3(
        initial.position.x - initialTarget.x,
        initial.position.y - initialTarget.y,
        initial.position.z - initialTarget.z
    );

    for (let i = 0; i < keys; ++i) {
        mat.setFromEulerAngles(0, -i / keys * 360, 0);
        mat.transformPoint(dif, vec);

        position.push(initialTarget.x + vec.x);
        position.push(initialTarget.y + vec.y);
        position.push(initialTarget.z + vec.z);

        target.push(initialTarget.x);
        target.push(initialTarget.y);
        target.push(initialTarget.z);
    }

    return {
        name: 'rotate',
        duration,
        frameRate: 1,
        target: 'camera',
        loopMode: 'repeat',
        interpolation: 'spline',
        keyframes: {
            times,
            values: {
                position,
                target
            }
        }
    };
};

class Viewer {
    constructor(app, entity, events, state, settings, params) {
        const { background, camera } = settings;
        const { graphicsDevice } = app;

        this.app = app;
        this.entity = entity;
        this.events = events;
        this.state = state;
        this.settings = settings;

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // apply camera animation settings
        entity.camera.clearColor = new Color(background.color);
        entity.camera.fov = camera.fov;

        // handle horizontal fov on canvas resize
        const updateHorizontalFov = () => {
            this.entity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
        };
        graphicsDevice.on('resizecanvas', () => {
            updateHorizontalFov();
            app.renderNextFrame = true;
        });
        updateHorizontalFov();

        // track camera changes
        const prevProj = new Mat4();
        const prevWorld = new Mat4();

        app.on('framerender', () => {
            const world = this.entity.getWorldTransform();
            const proj = this.entity.camera.projectionMatrix;
            const nearlyEquals = (a, b, epsilon = 1e-4) => {
                return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
            };

            if (params.ministats) {
                app.renderNextFrame = true;
            }

            if (!app.autoRender && !app.renderNextFrame) {
                if (!nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }
        });

        events.on('hqMode:changed', (value) => {
            graphicsDevice.maxPixelRatio = value ? window.devicePixelRatio : 1;
            app.renderNextFrame = true;
        });
        graphicsDevice.maxPixelRatio = state.hqMode ? window.devicePixelRatio : 1;
    }

    // initialize the viewer once gsplat asset is finished loading (so we know its bound etc)
    async initialize() {
        const { app, entity, events, state, settings } = this;

        // get the gsplat
        const gsplat = app.root.findComponent('gsplat');

        // calculate scene bounding box
        const bbox = gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

        // create an anim camera
        // calculate the orbit camera frame position
        const framePose = (() => {
            const sceneSize = bbox.halfExtents.length();
            const distance = sceneSize / Math.sin(entity.camera.fov / 180 * Math.PI * 0.5);
            return new Pose().look(
                new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
                bbox.center
            );
        })();

        // calculate the orbit camera reset position
        const resetPose = (() => {
            const { position, target } = settings.camera;
            return new Pose().look(
                new Vec3(position ?? [2, 1, 2]),
                new Vec3(target ?? [0, 0, 0])
            );
        })();

        // calculate the user camera start position (the pose we'll use if there is no animation)
        const useReset = settings.camera.position || settings.camera.target || bbox.halfExtents.length() > 100;
        const userStart = (useReset ? resetPose : framePose).clone();

        // if camera doesn't intersect the scene, assume it's an object we're
        // viewing
        const isObjectExperience = !bbox.containsPoint(userStart.position);

        // create the cameras
        const animCamera = ((initial, isObjectExperience) => {
            const { animTracks, camera } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && camera.startAnim === 'animTrack') {
                const track = animTracks.find(track => track.name === camera.animTrack);
                if (track) {
                    return AnimController.fromTrack(track);
                }
            } else if (isObjectExperience) {
                // create basic rotation animation if no anim track is specified
                return AnimController.fromTrack(createRotateTrack(initial));
            }
            return null;
        })(userStart, isObjectExperience);
        const orbitCamera = (() => {
            const orbitCamera = new OrbitController();

            orbitCamera.pitchRange = PITCH_RANGE;

            return orbitCamera;
        })();
        const flyCamera = (() => {
            const flyCamera = new FlyController();

            flyCamera.pitchRange = PITCH_RANGE;

            return flyCamera;
        })();

        /**
         * @param {'orbit' | 'anim' | 'fly'} cameraMode - the camera mode to get
         * @returns {InputController} the camera instance for the given mode
         */
        const getCamera = (cameraMode) => {
            switch (cameraMode) {
                case 'orbit': return orbitCamera;
                case 'anim': return animCamera;
                case 'fly': return flyCamera;
            }
        };

        // set the global animation flag
        state.hasAnimation = !!animCamera;
        state.animationDuration = animCamera ? animCamera.cursor.duration : 0;
        if (animCamera) {
            state.cameraMode = 'anim';
        }

        // this pose stores the current camera position. it will be blended/smoothed
        // toward the current active camera
        const activePose = new Pose();

        // create controller
        // set move speed based on scene size, within reason
        const controller = new AppController(app.graphicsDevice.canvas, entity.camera);
        controller.moveSpeed = Math.max(0.05, Math.min(1, bbox.halfExtents.length() * 0.0001)) * 60;

        if (state.cameraMode === 'anim') {
            //  first frame of the animation
            activePose.copy(animCamera.update(controller.frame, 0));
        } else {
            // user start position
            activePose.copy(userStart);
        }

        // place all user cameras at the start position
        orbitCamera.attach(activePose, false);
        flyCamera.attach(activePose, false);

        // transition time between cameras
        let transitionTimer = 0;

        // the previous camera we're transitioning away from
        const prevPose = new Pose();
        let prevCamera = null;
        let prevCameraMode = 'orbit';

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            const doReset = (pose) => {
                switch (state.cameraMode) {
                    case 'orbit': {
                        orbitCamera.attach(pose, true);
                        break;
                    }
                    case 'fly': {
                        flyCamera.attach(pose, true);
                        break;
                    }
                    case 'anim': {
                        state.cameraMode = prevCameraMode;
                        break;
                    }
                }
            };

            switch (eventName) {
                case 'frame':
                    doReset(framePose);
                    break;
                case 'reset':
                    doReset(resetPose);
                    break;
                case 'cancel':
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = prevCameraMode;
                    }
                    break;
            }
        });

        // application update
        app.on('update', (deltaTime) => {

            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            // update input controller
            controller.update(deltaTime, state.cameraMode, activePose.distance);

            // update touch joystick UI
            if (state.cameraMode === 'fly') {
                events.fire('touchJoystickUpdate', controller.joystick.base, controller.joystick.stick);
            }

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' ?
                (state.animationPaused ? 0 : deltaTime * transitionTimer) :
                deltaTime;

            // update camera
            pose.copy(getCamera(state.cameraMode).update(controller.frame, dt));

            // blend camera smoothly during transitions
            if (transitionTimer < 1) {
                transitionTimer = Math.min(1, transitionTimer + deltaTime);
                if (transitionTimer < 1 && prevCamera) {
                    pose.lerp(prevPose, pose, easeOut(transitionTimer));
                }
            }

            // apply to camera
            activePose.copy(pose);
            entity.setPosition(activePose.position);
            entity.setEulerAngles(activePose.angles);

            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = animCamera.cursor.value;
            }
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevPose.copy(activePose);
            prevCamera = getCamera(prev);
            prevCamera.detach();

            switch (value) {
                case 'orbit':
                case 'fly':
                    getCamera(value).attach(pose, false);
                    break;
            }

            // reset camera transition timer
            transitionTimer = 0;
        });

        events.on('setAnimationTime', (time) => {
            if (animCamera) {
                animCamera.cursor.value = time;

                // switch to animation camera if we're not already there
                if (state.cameraMode !== 'anim') {
                    state.cameraMode = 'anim';
                }
            }
        });

        // pick orbit camera focus point on double click
        let picker = null;
        events.on('inputEvent', async (eventName, event) => {
            if (state.cameraMode === 'orbit' && eventName === 'dblclick') {
                if (!picker) {
                    picker = new Picker(app, entity);
                }
                const result = await picker.pick(event.offsetX, event.offsetY);
                if (result) {
                    orbitCamera.attach(pose.look(activePose.position, result), true);
                }
            }
        });

        // -------- load & chunk model -------------------------------------
        const tiles = await chunkCompressedPly('./assets/model.splat.compressed.ply', 40000);
        const tileEntities = [];

        // create assets / entities
        tiles.forEach((t, i) => {
            const a = new Asset(`tile-${i}`, 'gsplat', { url: '' }, { buffer: t.buffer });
            app.assets.add(a);
            a.once('load', () => {
                const e = new entity();
                e.addComponent('gsplat', { asset: a });
                // @ts-ignore custom cache field
                e._bbox = t.bbox;
                app.root.addChild(e);
                tileEntities.push(e);
            });
            app.assets.load(a);
        });

        // budgeted resort driver
        const MAX_TILES_PER_FRAME = 6;
        let frameId = 0;
        app.on('framerender', () => {
            if (!app.xr.active) return;
            const camPos = entity.getPosition();
            const camDir = entity.forward;

            tileEntities.forEach(te => {
                // @ts-ignore custom '_bbox'
                const bb = te._bbox;
                const d = Math.hypot(
                    bb.min[0] - camPos.x,
                    bb.min[1] - camPos.y,
                    bb.min[2] - camPos.z);
                // @ts-ignore custom field
                te._pri = 1e5 / (d * d + 1) + ((frameId - (te._last || 0)) * 0.2);
            });
            tileEntities.sort((a, b) => {
                // @ts-ignore
                return b._pri - a._pri;
            });

            let spent = 0;
            for (const te of tileEntities) {
                const srt = te.gsplat.sorter;
                if (!srt.busy && spent < MAX_TILES_PER_FRAME) {
                    srt.setCamera(camPos, camDir);
                    // @ts-ignore
                    te._last = frameId; spent++;
                }
            }
            frameId++;
        });

        // position camera
        entity.setPosition(activePose.position);
        entity.setEulerAngles(activePose.angles);

        // 'updated' event for each tile – any one triggers a frame render
        app.once('assets:load:end', () => {
            tileEntities.forEach(te =>
                te.gsplat.sorter.on('updated', () => app.renderNextFrame = true));
        });

        // request frame render when ready
        app.renderNextFrame = true;

        // we're ready to render once the first sort has completed
        state.readyToRender = true;

        // wait for the first valid frame to complete rendering
        const frameHandle = app.on('frameend', () => {
            frameHandle.off();

            events.fire('firstFrame');

            // emit first frame event on window
            window.firstFrame?.();
        });
    }
}

export { Viewer };
