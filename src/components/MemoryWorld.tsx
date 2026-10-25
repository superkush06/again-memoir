import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import type { Memory, Participant, Pose, SceneSpec } from "../types";
import { buildAvatar, disposeObject } from "../scene/diorama";
import {
  buildReconstruction,
  type Reconstruction,
} from "../scene/reconstruction";
import {
  constrainToWorldEnclosure,
  insideWorldEnclosure,
} from "../scene/world-bounds";
import "../scene/world.css";
import { insideObstacle, moveOutsideObstacle } from "../scene/world-collisions";
import type { BodyShapeChoice } from "../scene/body-shape-controller";
import { buildVideoReconstruction } from "../scene/video-world";
import { PropInteraction } from "../scene/prop-interaction";
import { buildPaperAtmosphere } from "../scene/paper-atmosphere";

interface MemoryWorldProps {
  memory: Memory | null;
  scene: SceneSpec | null;
  participants: Participant[];
  onPose?: (pose: Pose) => void;
  onSelectMemory?: (id: string) => void;
  onClose?: () => void;
  onReady?: () => void;
}

type NavigationMode = "walk" | "inspect";
type Viewpoint = "front" | "side" | "behind";
type WalkDirection = "forward" | "backward" | "left" | "right";

export function MemoryWorld({
  memory,
  scene: spec,
  participants,
  onPose,
  onSelectMemory,
  onClose,
  onReady,
}: MemoryWorldProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const vrButtonRef = useRef<HTMLDivElement>(null);
  const participantsRef = useRef(participants);
  const poseCallbackRef = useRef(onPose);
  const selectCallbackRef = useRef(onSelectMemory);
  const readyCallbackRef = useRef(onReady);
  const resetRef = useRef<() => void>(() => {});
  const viewpointRef = useRef<(view: Viewpoint) => void>(() => {});
  const navigationModeRef = useRef<NavigationMode>("walk");
  const changeModeRef = useRef<(mode: NavigationMode) => void>(() => {});
  const heldMovementRef = useRef(new Set<WalkDirection>());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playRef = useRef<() => Promise<void>>(async () => {});
  const seekRef = useRef<(time: number) => void>(() => {});
  const resetPropsRef = useRef<() => void>(() => {});
  const objectModeRef = useRef(false);
  const updateContentRef = useRef<
    (memory: Memory | null, scene: SceneSpec | null) => void
  >(() => {});
  const depthRef = useRef(1.25);
  const pointModeRef = useRef(false);
  const geometryUpdateRef = useRef<() => void>(() => {});
  const bodyShapeRef = useRef<(choice: BodyShapeChoice) => Promise<void>>(
    async () => {},
  );
  const [hasBodyShapes, setHasBodyShapes] = useState(false);
  const [bodyShape, setBodyShape] = useState<BodyShapeChoice>("photo-fit");
  const [bodyShapeLoading, setBodyShapeLoading] = useState(false);
  const [bodyShapeError, setBodyShapeError] = useState("");
  const [depthAmount, setDepthAmount] = useState(1.25);
  const [pointMode, setPointMode] = useState(false);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>("walk");
  const [viewpoint, setViewpoint] = useState<Viewpoint>("front");
  const [unavailable, setUnavailable] = useState(false);
  const [loadingImage, setLoadingImage] = useState(true);
  const [imageError, setImageError] = useState("");
  const [poseSummary, setPoseSummary] = useState("");
  const [inVR, setInVR] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [propCount, setPropCount] = useState(0);
  const [moveObjects, setMoveObjects] = useState(false);
  const [heldProp, setHeldProp] = useState("");
  // Room snapshots arrive at pose frequency. Equivalent JSON must not recreate an XR session.
  const contentKey = JSON.stringify([memory, spec]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);
  useEffect(() => {
    poseCallbackRef.current = onPose;
  }, [onPose]);
  useEffect(() => {
    selectCallbackRef.current = onSelectMemory;
  }, [onSelectMemory]);
  useEffect(() => {
    readyCallbackRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const mount = mountRef.current;
    const vrMount = vrButtonRef.current;
    if (!mount || !vrMount) return;
    let disposed = false;
    setUnavailable(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      setUnavailable(true);
      setLoadingImage(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    // PCF supports a wider filter radius for a gently softened silhouette.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    renderer.domElement.setAttribute(
      "aria-label",
      "Walk through the reconstructed memory. Drag to look around. Use W A S D or the movement buttons to walk. Switch to Inspect to orbit.",
    );
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.tabIndex = 0;
    mount.appendChild(renderer.domElement);

    const world = new THREE.Scene();
    world.background = new THREE.Color("#10131a");
    // Neutral illumination preserves the sampled clothing palette. Directional
    // shading and ground shadows make complete bodies readable from every side.
    world.add(new THREE.HemisphereLight("#ffffff", "#929292", 1.15));
    const sunlight = new THREE.DirectionalLight("#ffffff", 1.7);
    sunlight.position.set(4.5, 7, -7);
    sunlight.castShadow = true;
    sunlight.shadow.mapSize.set(2048, 2048);
    sunlight.shadow.radius = 3;
    sunlight.shadow.camera.left = -7;
    sunlight.shadow.camera.right = 7;
    sunlight.shadow.camera.top = 7;
    sunlight.shadow.camera.bottom = -7;
    sunlight.shadow.camera.near = 0.1;
    sunlight.shadow.camera.far = 30;
    sunlight.shadow.bias = -0.00015;
    sunlight.shadow.normalBias = 0.008;
    sunlight.target.position.set(0, 0, -4);
    world.add(sunlight.target);
    world.add(sunlight);
    world.add(new THREE.AmbientLight("#ffffff", 0.25));
    const rearFill = new THREE.DirectionalLight("#ffffff", 0.75);
    rearFill.position.set(-4, 4, -9);
    rearFill.target.position.set(0, 1, -4);
    world.add(rearFill, rearFill.target);
    const camera = new THREE.PerspectiveCamera(64, 1, 0.04, 100);
    const rig = new THREE.Group();
    world.add(rig);
    rig.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.minDistance = 0.4;
    controls.maxDistance = 20;
    controls.maxPolarAngle = Math.PI * 0.9;
    controls.minPolarAngle = 0.1;
    controls.enablePan = true;
    controls.panSpeed = 0.7;
    controls.rotateSpeed = 0.36;
    controls.zoomSpeed = 0.6;
    let reconstruction:
      (Reconstruction & { updateTime?: (time: number) => void }) | undefined;
    let paperAtmosphere: THREE.Group | undefined;
    let propInteraction: PropInteraction | undefined;
    let lookingPointer: number | null = null;
    let previousPointerX = 0;
    let previousPointerY = 0;
    const desktopGrabAnchor = new THREE.Group();
    world.add(desktopGrabAnchor);
    const lookRotation = new THREE.Euler(0, 0, 0, "YXZ");
    let lookYaw = 0;
    let lookPitch = 0;
    const readLookRotation = () => {
      lookRotation.setFromQuaternion(camera.quaternion, "YXZ");
      lookYaw = lookRotation.y;
      lookPitch = lookRotation.x;
    };
    const changeMode = (mode: NavigationMode) => {
      navigationModeRef.current = mode;
      if (renderer.xr.isPresenting) return;
      if (mode === "inspect") {
        const target = reconstruction?.navigation.target;
        if (target) controls.target.fromArray(target);
        else
          controls.target
            .copy(camera.position)
            .add(
              camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(5),
            );
        controls.enabled = !objectModeRef.current;
        controls.update();
      } else {
        controls.enabled = false;
        readLookRotation();
      }
    };
    changeModeRef.current = changeMode;
    let activeMemory = memory;
    let imageAspect = 1.5;
    let projectionFov = 60;
    const fitView = () => {
      const framing = Math.max(1, imageAspect / camera.aspect);
      camera.fov = Math.min(
        100,
        2 *
          THREE.MathUtils.radToDeg(
            Math.atan(
              Math.tan(THREE.MathUtils.degToRad(projectionFov / 2)) * framing,
            ),
          ) +
          4,
      );
      camera.updateProjectionMatrix();
    };
    const showViewpoint = (view: Viewpoint) => {
      if (renderer.xr.isPresenting) return;
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
      if (!renderer.xr.isPresenting) {
        const navigation = reconstruction?.navigation;
        const fallback = {
          front: [0, 1.6, 0],
          side: [6, 1.8, -5],
          behind: [0, 1.8, -13],
        };
        camera.position.fromArray(navigation?.[view] ?? fallback[view]);
        controls.target.fromArray(
          (view === "front" ? navigation?.frontTarget : undefined) ??
            navigation?.target ?? [0, 1.6, -5.2],
        );
        camera.lookAt(controls.target);
        readLookRotation();
        if (navigationModeRef.current === "inspect") controls.update();
        // Background browser tabs can suspend animation frames while models
        // finish loading. Publish the ready view immediately rather than
        // leaving a blank canvas until the tab receives focus.
        renderer.render(world, camera);
      }
      setViewpoint(view);
    };
    viewpointRef.current = showViewpoint;
    const resetView = () => showViewpoint("front");
    resetRef.current = resetView;
    resetView();
    let videoTexture: THREE.VideoTexture | undefined;
    let loadedKey = "";
    let generation = 0;
    const clearMedia = () => {
      if (
        lookingPointer !== null &&
        renderer.domElement.hasPointerCapture(lookingPointer)
      )
        renderer.domElement.releasePointerCapture(lookingPointer);
      lookingPointer = null;
      renderer.domElement.classList.remove("is-looking");
      propInteraction?.releaseAll();
      propInteraction = undefined;
      resetPropsRef.current = () => {};
      if (videoRef.current) {
        videoRef.current.onloadedmetadata = null;
        videoRef.current.onloadeddata = null;
        videoRef.current.ontimeupdate = null;
        videoRef.current.onerror = null;
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
        videoRef.current = null;
      }
      playRef.current = async () => {};
      seekRef.current = () => {};
      videoTexture?.dispose();
      videoTexture = undefined;
      if (reconstruction) {
        world.remove(reconstruction.group);
        reconstruction.dispose();
        reconstruction = undefined;
      }
      if (paperAtmosphere) {
        world.remove(paperAtmosphere);
        disposeObject(paperAtmosphere);
        paperAtmosphere = undefined;
      }
    };
    geometryUpdateRef.current = () => {
      propInteraction?.releaseAll();
      setHeldProp("");
      reconstruction?.setStrength(depthRef.current);
      reconstruction?.setPointMode(pointModeRef.current);
    };
    bodyShapeRef.current = async (choice) => {
      const current = reconstruction;
      if (!current?.hasBodyShapes) return;
      setBodyShapeLoading(true);
      setBodyShapeError("");
      try {
        const installed = await current.setBodyShape(choice);
        if (installed && !disposed && current === reconstruction) {
          setBodyShape(choice);
          // Keep the viewpoint while updating the new body's collision bounds.
          clampToWorld(camera.position);
        }
      } catch {
        if (!disposed && current === reconstruction)
          setBodyShapeError(
            "That shape could not load. Your current view is still available.",
          );
      } finally {
        if (!disposed && current === reconstruction) setBodyShapeLoading(false);
      }
    };
    const replaceContent = (
      nextMemory: Memory | null,
      nextSpec: SceneSpec | null,
    ) => {
      const nextKey = JSON.stringify([nextMemory, nextSpec]);
      if (nextKey === loadedKey) return;
      loadedKey = nextKey;
      activeMemory = nextMemory;
      const thisGeneration = ++generation;
      clearMedia();
      setHasBodyShapes(false);
      setBodyShape("photo-fit");
      setBodyShapeLoading(false);
      setBodyShapeError("");
      setLoadingImage(Boolean(nextMemory && nextSpec?.reconstruction));
      setPoseSummary("");
      setImageError(
        nextMemory && !nextSpec?.reconstruction
          ? "This memory’s depth reconstruction is not ready yet. Cast it into 3D to generate its geometry."
          : "",
      );
      setPlaying(false);
      setMuted(true);
      setVideoTime(0);
      setVideoDuration(nextSpec?.reconstruction?.video?.duration ?? 0);
      setPropCount(0);
      setHeldProp("");
      setMoveObjects(false);
      objectModeRef.current = false;
      if (!nextMemory || !nextSpec?.reconstruction) return;
      const input = nextSpec.reconstruction;
      imageAspect = input.width / input.height;
      projectionFov = input.fov;
      fitView();
      resetView();
      const stale = () => disposed || thisGeneration !== generation;
      const worldInput = {
        ...input,
        mediaType: nextMemory.mediaType,
        strength: depthRef.current,
        sceneEnvironment: [
          nextSpec.environment,
          nextMemory.description,
          ...nextMemory.tags,
        ].join(" "),
      };
      const build = input.video
        ? buildVideoReconstruction({ ...worldInput, video: input.video })
        : buildReconstruction(worldInput);
      void build
        .then((result) => {
          if (stale()) {
            result.dispose();
            return;
          }
          reconstruction = result;
          setHasBodyShapes(result.hasBodyShapes);
          const fitted = Number(result.group.userData.poseFittedBodies ?? 0);
          const total = Number(result.group.userData.poseEstimatedBodies ?? 0);
          setPoseSummary(
            total > 0
              ? ` · ${fitted}/${total} detected people pose-fitted`
              : "",
          );
          world.add(result.group);
          paperAtmosphere = buildPaperAtmosphere(result.navigation);
          paperAtmosphere.visible = renderer.xr.isPresenting;
          world.add(paperAtmosphere);
          propInteraction = new PropInteraction(result.props);
          setPropCount(result.props.length);
          resetPropsRef.current = () => {
            propInteraction?.reset();
            reconstruction?.setStrength(depthRef.current);
            setHeldProp("");
            renderer.render(world, camera);
          };
          result.setPointMode(pointModeRef.current);
          resetView();
          setLoadingImage(false);
          renderer.render(world, camera);
          readyCallbackRef.current?.();
          if (nextMemory.mediaType === "video") {
            const video = document.createElement("video");
            video.crossOrigin = "anonymous";
            video.playsInline = true;
            video.loop = true;
            video.muted = true;
            video.preload = "metadata";
            video.src = nextMemory.url;
            videoRef.current = video;
            videoTexture = new THREE.VideoTexture(video);
            videoTexture.colorSpace = THREE.SRGBColorSpace;
            video.onloadedmetadata = () => {
              if (!stale() && Number.isFinite(video.duration))
                setVideoDuration(video.duration);
            };
            video.onloadeddata = () => {
              if (!stale() && videoTexture) {
                result.setTexture(videoTexture);
                renderer.render(world, camera);
              }
            };
            video.ontimeupdate = () => {
              if (!stale()) setVideoTime(video.currentTime);
            };
            video.onerror = () => {
              if (!stale()) {
                setPlaying(false);
                setImageError(
                  "This video could not be decoded. Try an MP4 with H.264 video or a WebM file.",
                );
              }
            };
            seekRef.current = (time) => {
              if (stale() || !Number.isFinite(time)) return;
              const duration = Number.isFinite(video.duration)
                ? video.duration
                : (input.video?.duration ?? 0);
              video.currentTime = Math.max(0, Math.min(duration, time));
              reconstruction?.updateTime?.(video.currentTime);
              setVideoTime(video.currentTime);
            };
            playRef.current = async () => {
              if (video.paused) {
                try {
                  await video.play();
                  if (stale()) {
                    video.pause();
                    return;
                  }
                  if (videoTexture) result.setTexture(videoTexture);
                  setPlaying(true);
                  setImageError("");
                } catch {
                  if (!stale())
                    setImageError(
                      "Video playback could not start. The reconstructed still and original are available.",
                    );
                }
              } else {
                video.pause();
                setPlaying(false);
              }
            };
          }
        })
        .catch((error) => {
          if (!stale()) {
            setLoadingImage(false);
            readyCallbackRef.current?.();
            setImageError(
              error instanceof Error
                ? error.message
                : "The depth reconstruction could not load.",
            );
          }
        });
    };
    updateContentRef.current = replaceContent;
    replaceContent(memory, spec);

    const xrButton = VRButton.createButton(renderer, {
      optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
    });
    vrMount.appendChild(xrButton);
    const sessionStart = () => {
      propInteraction?.releaseAll();
      setHeldProp("");
      controls.enabled = false;
      const start = reconstruction?.navigation.front ?? [0, 1.6, 0];
      const target = reconstruction?.navigation.frontTarget ??
        reconstruction?.navigation.target ?? [0, 1.6, -5.2];
      rig.position.set(start[0], 0, start[2]);
      rig.rotation.set(
        0,
        Math.atan2(target[0] - start[0], -(target[2] - start[2])),
        0,
      );
      // The headset supplies eye height and look direction in local-floor XR.
      camera.position.set(0, 0, 0);
      camera.rotation.set(0, 0, 0);
      if (paperAtmosphere) paperAtmosphere.visible = true;
      setInVR(true);
    };
    const sessionEnd = () => {
      propInteraction?.releaseAll();
      setHeldProp("");
      controls.enabled = navigationModeRef.current === "inspect";
      if (paperAtmosphere) paperAtmosphere.visible = false;
      setInVR(false);
      resetView();
    };
    renderer.xr.addEventListener("sessionstart", sessionStart);
    renderer.xr.addEventListener("sessionend", sessionEnd);

    const raycaster = new THREE.Raycaster();
    const rotationMatrix = new THREE.Matrix4();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.06);
    const targetPoint = new THREE.Vector3();
    const worldPosition = new THREE.Vector3();
    const worldRotation = new THREE.Quaternion();
    const viewerPosition = new THREE.Vector3();
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.2, 32),
      new THREE.MeshBasicMaterial({
        color: "#e6d6c0",
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8,
      }),
    );
    reticle.rotation.x = -Math.PI / 2;
    reticle.visible = false;
    world.add(reticle);
    const controllers = [
      renderer.xr.getController(0),
      renderer.xr.getController(1),
    ];
    const grips = [
      renderer.xr.getControllerGrip(0),
      renderer.xr.getControllerGrip(1),
    ];
    grips.forEach((grip) => rig.add(grip));
    const controllerHandlers: {
      select: () => void;
      grab: () => void;
      release: () => void;
    }[] = [];
    const withinWorld = (point: THREE.Vector3) => {
      const bounds = reconstruction?.navigation.bounds;
      return (
        point.x >= (bounds?.min[0] ?? -15) - 1 &&
        point.x <= (bounds?.max[0] ?? 15) + 1 &&
        point.z >= (bounds?.min[2] ?? -30) - 1 &&
        point.z <= (bounds?.max[2] ?? 6) + 1 &&
        insideWorldEnclosure(point)
      );
    };
    const hitsSubject = (point: THREE.Vector3, eyeHeight = point.y) =>
      reconstruction?.navigation.obstacles?.some((obstacle) =>
        insideObstacle(point, obstacle, eyeHeight),
      ) ?? false;
    const clampToWorld = (point: THREE.Vector3) => {
      const bounds = reconstruction?.navigation.bounds;
      point.x = THREE.MathUtils.clamp(
        point.x,
        (bounds?.min[0] ?? -15) - 1,
        (bounds?.max[0] ?? 15) + 1,
      );
      point.z = THREE.MathUtils.clamp(
        point.z,
        (bounds?.min[2] ?? -30) - 1,
        (bounds?.max[2] ?? 6) + 1,
      );
      point.y = THREE.MathUtils.clamp(
        point.y,
        0.45,
        Math.max(8, bounds?.max[1] ?? 8),
      );
      // Small horizontal steps slide around completed subjects, preserving free walking.
      for (let pass = 0; pass < 3; pass++) {
        for (const obstacle of reconstruction?.navigation.obstacles ?? []) {
          moveOutsideObstacle(point, obstacle);
        }
      }
      constrainToWorldEnclosure(point);
    };
    const controllerTarget = (controller: THREE.Group) => {
      rotationMatrix.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotationMatrix);
      return (
        raycaster.ray.intersectPlane(floorPlane, targetPoint) &&
        raycaster.ray.origin.distanceTo(targetPoint) < 12 &&
        withinWorld(targetPoint) &&
        !hitsSubject(targetPoint, 1.6)
      );
    };
    controllers.forEach((controller, index) => {
      rig.add(controller);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(),
          new THREE.Vector3(0, 0, -1),
        ]),
        new THREE.LineBasicMaterial({
          color: "#ead4ac",
          transparent: true,
          opacity: 0.45,
        }),
      );
      line.scale.z = 8;
      controller.add(line);
      const select = () => {
        if (
          propInteraction?.holding(grips[index]) ||
          propInteraction?.holding(controller)
        )
          return;
        const hasFloorTarget = controllerTarget(controller);
        // Downward pointing teleports even when the reconstructed image covers the floor.
        if (hasFloorTarget && raycaster.ray.direction.y < -0.3) {
          renderer.xr.getCamera().getWorldPosition(worldPosition);
          rig.position.x += targetPoint.x - worldPosition.x;
          rig.position.z += targetPoint.z - worldPosition.z;
        } else if (
          reconstruction &&
          raycaster.intersectObject(reconstruction.surface).length &&
          activeMemory
        ) {
          selectCallbackRef.current?.(activeMemory.id);
          if (activeMemory.mediaType === "video") void playRef.current();
        }
      };
      const grab = () => {
        if (activeMemory?.mediaType !== "image") return;
        controllerTarget(controller);
        const hit = propInteraction?.pick(raycaster);
        const anchor = grips[index].visible ? grips[index] : controller;
        if (hit && propInteraction?.grab(hit.prop, anchor))
          setHeldProp(hit.prop.label);
      };
      const release = () => {
        propInteraction?.release(grips[index]);
        propInteraction?.release(controller);
        setHeldProp("");
      };
      controller.addEventListener("selectstart", select);
      controller.addEventListener("squeezestart", grab);
      controller.addEventListener("squeezeend", release);
      controller.addEventListener("disconnected", release);
      controllerHandlers.push({ select, grab, release });
    });

    const keys = new Set<string>();
    const keyDown = (event: KeyboardEvent) => {
      if (
        document.activeElement !== renderer.domElement ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (
        [
          "w",
          "a",
          "s",
          "d",
          "q",
          "e",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(key)
      ) {
        keys.add(key);
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    };
    const clearKeys = () => {
      propInteraction?.release(desktopGrabAnchor);
      setHeldProp("");
      keys.clear();
      heldMovementRef.current.clear();
      if (
        lookingPointer !== null &&
        renderer.domElement.hasPointerCapture(lookingPointer)
      )
        renderer.domElement.releasePointerCapture(lookingPointer);
      lookingPointer = null;
      renderer.domElement.classList.remove("is-looking");
    };
    const objectDragPlane = new THREE.Plane();
    const objectDragPoint = new THREE.Vector3();
    const pointerRay = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
    };
    const beginLook = (event: PointerEvent) => {
      renderer.domElement.focus({ preventScroll: true });
      if (
        objectModeRef.current &&
        !renderer.xr.isPresenting &&
        event.button === 0
      ) {
        pointerRay(event);
        const hit = propInteraction?.pick(raycaster, 12);
        if (hit) {
          desktopGrabAnchor.position.copy(hit.point);
          objectDragPlane.setFromNormalAndCoplanarPoint(
            camera.getWorldDirection(new THREE.Vector3()),
            hit.point,
          );
          if (propInteraction?.grab(hit.prop, desktopGrabAnchor)) {
            lookingPointer = event.pointerId;
            setHeldProp(hit.prop.label);
            renderer.domElement.setPointerCapture(event.pointerId);
          }
        }
        return;
      }
      if (
        navigationModeRef.current !== "walk" ||
        renderer.xr.isPresenting ||
        event.button !== 0 ||
        lookingPointer !== null
      )
        return;
      lookingPointer = event.pointerId;
      previousPointerX = event.clientX;
      previousPointerY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
      renderer.domElement.classList.add("is-looking");
    };
    const lookAround = (event: PointerEvent) => {
      if (
        event.pointerId === lookingPointer &&
        propInteraction?.holding(desktopGrabAnchor)
      ) {
        pointerRay(event);
        if (raycaster.ray.intersectPlane(objectDragPlane, objectDragPoint)) {
          desktopGrabAnchor.position.copy(objectDragPoint);
          renderer.render(world, camera);
        }
        return;
      }
      if (
        event.pointerId !== lookingPointer ||
        navigationModeRef.current !== "walk"
      )
        return;
      lookYaw -= (event.clientX - previousPointerX) * 0.004;
      lookPitch = THREE.MathUtils.clamp(
        lookPitch - (event.clientY - previousPointerY) * 0.004,
        -Math.PI * 0.47,
        Math.PI * 0.47,
      );
      camera.quaternion.setFromEuler(lookRotation.set(lookPitch, lookYaw, 0));
      previousPointerX = event.clientX;
      previousPointerY = event.clientY;
    };
    const stopLook = (event: PointerEvent) => {
      if (event.pointerId !== lookingPointer) return;
      propInteraction?.release(desktopGrabAnchor);
      setHeldProp("");
      lookingPointer = null;
      renderer.domElement.classList.remove("is-looking");
      if (renderer.domElement.hasPointerCapture(event.pointerId))
        renderer.domElement.releasePointerCapture(event.pointerId);
    };
    const stepForward = (event: WheelEvent) => {
      if (navigationModeRef.current !== "walk" || renderer.xr.isPresenting)
        return;
      event.preventDefault();
      const stride = camera.getWorldDirection(new THREE.Vector3());
      stride.y = 0;
      if (stride.lengthSq() > 0)
        camera.position.addScaledVector(
          stride.normalize(),
          -Math.sign(event.deltaY) * 0.35,
        );
      clampToWorld(camera.position);
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", clearKeys);
    renderer.domElement.addEventListener("pointerdown", beginLook);
    renderer.domElement.addEventListener("pointermove", lookAround);
    renderer.domElement.addEventListener("pointerup", stopLook);
    renderer.domElement.addEventListener("pointercancel", stopLook);
    renderer.domElement.addEventListener("lostpointercapture", stopLook);
    renderer.domElement.addEventListener("wheel", stepForward, {
      passive: false,
    });
    renderer.domElement.addEventListener("blur", clearKeys);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();
    const avatars = new Map<string, THREE.Group>();
    let lastPoseTime = 0;
    let lastFrameTime = 0;
    let snapTurnReady = true;
    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      fitView();
      renderer.setSize(width, height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    const contextLost = (event: Event) => {
      event.preventDefault();
      setUnavailable(true);
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);

    renderer.setAnimationLoop((time) => {
      if (disposed) return;
      if (videoRef.current)
        reconstruction?.updateTime?.(videoRef.current.currentTime);
      const delta = Math.min((time - lastFrameTime) / 1000 || 0.016, 0.1);
      lastFrameTime = time;
      if (!renderer.xr.isPresenting) {
        const held = heldMovementRef.current;
        if (keys.size || held.size) {
          camera.getWorldDirection(forward);
          forward.y = 0;
          forward.normalize();
          right.crossVectors(forward, camera.up).normalize();
          movement.set(0, 0, 0);
          if (keys.has("w") || keys.has("ArrowUp") || held.has("forward"))
            movement.add(forward);
          if (keys.has("s") || keys.has("ArrowDown") || held.has("backward"))
            movement.sub(forward);
          if (keys.has("d") || keys.has("ArrowRight") || held.has("right"))
            movement.add(right);
          if (keys.has("a") || keys.has("ArrowLeft") || held.has("left"))
            movement.sub(right);
          if (keys.has("e")) movement.y += 1;
          if (keys.has("q")) movement.y -= 1;
          movement.normalize().multiplyScalar(delta * 2.2);
          worldPosition.copy(camera.position);
          camera.position.add(movement);
          clampToWorld(camera.position);
          controls.target.add(
            movement.subVectors(camera.position, worldPosition),
          );
        }
        controls.enabled =
          navigationModeRef.current === "inspect" && !objectModeRef.current;
        if (controls.enabled) controls.update();
      }
      reticle.visible = false;
      if (renderer.xr.isPresenting) {
        const session = renderer.xr.getSession();
        for (const source of session?.inputSources ?? []) {
          const axes = source.gamepad?.axes;
          if (!axes || axes.length < 2) continue;
          const horizontal = axes.length >= 4 ? axes[2] : axes[0];
          const vertical = axes.length >= 4 ? axes[3] : axes[1];
          if (
            source.handedness === "left" &&
            Math.hypot(horizontal, vertical) > 0.15
          ) {
            renderer.xr.getCamera().getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
            right.crossVectors(forward, camera.up).normalize();
            movement
              .copy(forward)
              .multiplyScalar(-vertical)
              .addScaledVector(right, horizontal);
            movement.multiplyScalar(delta * 1.8);
            renderer.xr.getCamera().getWorldPosition(worldPosition);
            targetPoint.copy(worldPosition).add(movement);
            clampToWorld(targetPoint);
            rig.position.x += targetPoint.x - worldPosition.x;
            rig.position.z += targetPoint.z - worldPosition.z;
          }
          if (source.handedness === "right") {
            if (Math.abs(horizontal) < 0.3) snapTurnReady = true;
            else if (Math.abs(horizontal) > 0.7 && snapTurnReady) {
              snapTurnReady = false;
              renderer.xr.getCamera().getWorldPosition(worldPosition);
              const turn = (-Math.sign(horizontal) * Math.PI) / 6;
              rig.position
                .sub(worldPosition)
                .applyAxisAngle(camera.up, turn)
                .add(worldPosition);
              rig.rotation.y += turn;
            }
          }
        }
        for (const [index, controller] of controllers.entries()) {
          if (
            controller.visible &&
            !propInteraction?.holding(grips[index]) &&
            !propInteraction?.holding(controller) &&
            controllerTarget(controller) &&
            raycaster.ray.direction.y < -0.3
          ) {
            reticle.visible = true;
            reticle.position.copy(targetPoint);
            reticle.position.y = 0.065;
            break;
          }
        }
      }
      const currentParticipants = participantsRef.current;
      const currentIds = new Set(
        currentParticipants.map((person) => person.id),
      );
      (renderer.xr.isPresenting
        ? renderer.xr.getCamera()
        : camera
      ).getWorldPosition(viewerPosition);
      for (const [id, avatar] of avatars) {
        if (!currentIds.has(id)) {
          world.remove(avatar);
          disposeObject(avatar);
          avatars.delete(id);
        }
      }
      currentParticipants.forEach((person, index) => {
        let avatar = avatars.get(person.id);
        if (!avatar) {
          avatar = buildAvatar(person);
          avatar.position.set(2 + index * 0.5, 1.6, 0);
          world.add(avatar);
          avatars.set(person.id, avatar);
        }
        if (
          person.pose?.position.every(Number.isFinite) &&
          person.pose.rotation.every(Number.isFinite)
        ) {
          avatar.position.lerp(
            new THREE.Vector3(...person.pose.position),
            Math.min(delta * 12, 1),
          );
          avatar.quaternion.slerp(
            new THREE.Quaternion(...person.pose.rotation).normalize(),
            Math.min(delta * 12, 1),
          );
        }
        // Guests can share a starting viewpoint; keep their heads outside the local camera.
        avatar.visible = avatar.position.distanceToSquared(viewerPosition) >= 1;
        const label = avatar.userData.label as THREE.Mesh;
        (renderer.xr.isPresenting
          ? renderer.xr.getCamera()
          : camera
        ).getWorldQuaternion(worldRotation);
        avatar
          .getWorldQuaternion(label.quaternion)
          .invert()
          .multiply(worldRotation);
      });
      renderer.render(world, camera);
      // Rendering updates headset matrices from the current XRFrame before the pose is sent.
      if (time - lastPoseTime >= 100) {
        lastPoseTime = time;
        const activeCamera = renderer.xr.isPresenting
          ? renderer.xr.getCamera()
          : camera;
        activeCamera.getWorldPosition(worldPosition);
        activeCamera.getWorldQuaternion(worldRotation);
        poseCallbackRef.current?.({
          position: [worldPosition.x, worldPosition.y, worldPosition.z],
          rotation: [
            worldRotation.x,
            worldRotation.y,
            worldRotation.z,
            worldRotation.w,
          ],
        });
      }
    });
    return () => {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      controllers.forEach((controller, index) => {
        const handlers = controllerHandlers[index];
        controller.removeEventListener("selectstart", handlers.select);
        controller.removeEventListener("squeezestart", handlers.grab);
        controller.removeEventListener("squeezeend", handlers.release);
        controller.removeEventListener("disconnected", handlers.release);
      });
      renderer.xr.removeEventListener("sessionstart", sessionStart);
      renderer.xr.removeEventListener("sessionend", sessionEnd);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      renderer.domElement.removeEventListener("pointerdown", beginLook);
      renderer.domElement.removeEventListener("pointermove", lookAround);
      renderer.domElement.removeEventListener("pointerup", stopLook);
      renderer.domElement.removeEventListener("pointercancel", stopLook);
      renderer.domElement.removeEventListener("lostpointercapture", stopLook);
      renderer.domElement.removeEventListener("wheel", stepForward);
      renderer.domElement.removeEventListener("blur", clearKeys);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clearKeys);
      const session = renderer.xr.getSession();
      if (session) void session.end().catch(() => {});
      clearMedia();
      updateContentRef.current = () => {};
      geometryUpdateRef.current = () => {};
      bodyShapeRef.current = async () => {};
      resetRef.current = () => {};
      viewpointRef.current = () => {};
      changeModeRef.current = () => {};
      heldMovementRef.current.clear();
      disposeObject(world);
      renderer.dispose();
      renderer.domElement.remove();
      xrButton.remove();
    };
  }, []);

  useEffect(() => {
    updateContentRef.current(memory, spec);
  }, [contentKey]);

  return (
    <section
      className={`memory-world memory-world--${navigationMode}${memory?.mediaType === "video" ? " memory-world--video" : ""}`}
      aria-label="Immersive reconstructed memory"
    >
      <div ref={mountRef} className="memory-world__canvas" />
      {unavailable && (
        <div className="memory-world__fallback">
          {memory && (
            <img src={memory.thumbnailUrl || memory.url} alt={memory.title} />
          )}
          <p>
            The 3D viewer needs WebGL. Enable hardware acceleration to explore
            the reconstructed photograph.
          </p>
        </div>
      )}
      <div className="memory-world__heading">
        <div className="memory-world__eyebrow">
          {inVR
            ? "Inside your memory"
            : memory?.mediaType === "video"
              ? "Step into a moving memory"
              : "A world from your photograph"}
        </div>
        <h2 className="memory-world__title">
          {memory?.title ?? "A moment, made into a place."}
        </h2>
        <p className="memory-world__subtitle">
          {memory?.mediaType === "video" ? "Video colors" : "Photo colors"}
          {poseSummary} · Hidden surfaces inferred
          {memory?.mediaType === "video"
            ? spec?.reconstruction?.video
              ? " · Sampled depth follows playback · Objects locked"
              : " · Geometry from one video frame · Objects locked"
            : propCount > 0
              ? ` · ${propCount} movable objects`
              : ""}
        </p>
        {memory && (
          <div className="memory-world__media-actions">
            <a href={memory.url} target="_blank" rel="noreferrer">
              View original ↗
            </a>
            {memory.mediaType === "video" && (
              <>
                <button
                  type="button"
                  disabled={loadingImage}
                  onClick={() => void playRef.current()}
                >
                  {playing ? "Pause video" : "Play video"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !muted;
                    if (videoRef.current) videoRef.current.muted = next;
                    setMuted(next);
                  }}
                >
                  {muted ? "Sound off" : "Sound on"}
                </button>
              </>
            )}
          </div>
        )}
        {memory?.mediaType === "video" && videoDuration > 0 && (
          <label className="memory-world__video-timeline">
            <span>
              {Math.floor(videoTime / 60)}:
              {Math.floor(videoTime % 60)
                .toString()
                .padStart(2, "0")}{" "}
              / {Math.floor(videoDuration / 60)}:
              {Math.floor(videoDuration % 60)
                .toString()
                .padStart(2, "0")}
            </span>
            <input
              type="range"
              min="0"
              max={videoDuration}
              step="0.05"
              value={Math.min(videoTime, videoDuration)}
              aria-label="Video playback position"
              disabled={loadingImage}
              onChange={(event) => seekRef.current(Number(event.target.value))}
            />
          </label>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          className="memory-world__close"
          onClick={onClose}
          aria-label="Close reconstructed memory"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      )}
      {participants.length > 0 && (
        <div
          className={`memory-world__badge ${onClose ? "memory-world__badge--with-close" : ""}`}
        >
          {participants.length + 1} here together
        </div>
      )}
      {loadingImage && !unavailable && (
        <div className="memory-world__loading" role="status">
          <span className="memory-world__spinner" />
          Building the space around your memory
        </div>
      )}
      {imageError && !unavailable && (
        <div className="memory-world__image-note" role="status">
          {imageError} You can still view the original above.
        </div>
      )}
      {!unavailable && !loadingImage && !imageError && (
        <>
          {!inVR && (
            <div
              className="memory-world__navigation"
              aria-label="Explore the memory"
            >
              <div
                className="memory-world__mode"
                role="group"
                aria-label="Navigation mode"
              >
                {(["walk", "inspect"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={navigationMode === mode}
                    onClick={() => {
                      setNavigationMode(mode);
                      changeModeRef.current(mode);
                    }}
                  >
                    {mode === "walk" ? "Walk" : "Inspect"}
                  </button>
                ))}
              </div>
              <div
                className="memory-world__viewpoints"
                role="group"
                aria-label="Move to a viewpoint"
              >
                {(["front", "side", "behind"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={viewpoint === view}
                    onClick={() => viewpointRef.current(view)}
                  >
                    {view === "front"
                      ? "Front"
                      : view === "side"
                        ? "Side"
                        : "Behind"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="memory-world__depth-controls">
            {memory?.mediaType === "image" && propCount > 0 && (
              <div className="memory-world__object-controls">
                <button
                  type="button"
                  aria-pressed={moveObjects}
                  disabled={pointMode}
                  onClick={() => {
                    const enabled = !moveObjects;
                    objectModeRef.current = enabled;
                    setMoveObjects(enabled);
                  }}
                >
                  {moveObjects ? "Moving objects" : "Move objects"}
                </button>
                <button type="button" onClick={() => resetPropsRef.current()}>
                  Reset objects
                </button>
                <span role="status">
                  {heldProp
                    ? `Holding ${heldProp}`
                    : moveObjects
                      ? "Drag an object to place it"
                      : "In VR: point and hold grip"}
                </span>
              </div>
            )}
            {hasBodyShapes && (
              <div className="memory-world__body-shape">
                <label htmlFor="memory-body-shape">Body shape</label>
                <select
                  id="memory-body-shape"
                  value={bodyShape}
                  disabled={bodyShapeLoading}
                  aria-busy={bodyShapeLoading}
                  onChange={(event) =>
                    void bodyShapeRef.current(
                      event.target.value as BodyShapeChoice,
                    )
                  }
                >
                  <option value="photo-fit">Photo fit</option>
                  <option value="slim">Slender</option>
                  <option value="average">Average</option>
                  <option value="broad">Broader</option>
                </select>
                <span role="status">
                  {bodyShapeLoading
                    ? "Fitting the photograph…"
                    : bodyShapeError}
                </span>
              </div>
            )}
            <label htmlFor="memory-depth">
              Depth <span>{depthAmount.toFixed(2)}×</span>
            </label>
            <input
              id="memory-depth"
              type="range"
              min="0.35"
              max="2"
              step="0.05"
              value={depthAmount}
              onChange={(event) => {
                const value = Number(event.target.value);
                depthRef.current = value;
                setDepthAmount(value);
                geometryUpdateRef.current();
              }}
              aria-label="Reconstructed depth amount"
            />
            <button
              type="button"
              aria-pressed={pointMode}
              onClick={() => {
                const next = !pointMode;
                if (next) {
                  objectModeRef.current = false;
                  setMoveObjects(false);
                }
                pointModeRef.current = next;
                setPointMode(next);
                geometryUpdateRef.current();
              }}
            >
              {pointMode ? "Point cloud" : "Solid world"}
            </button>
          </div>
          {navigationMode === "walk" && !inVR && (
            <div
              className="memory-world__movement"
              role="group"
              aria-label="Hold to walk"
            >
              {(
                [
                  ["forward", "↑", "Walk forward"],
                  ["left", "←", "Walk left"],
                  ["backward", "↓", "Walk backward"],
                  ["right", "→", "Walk right"],
                ] as const
              ).map(([direction, arrow, label]) => (
                <button
                  key={direction}
                  className={`memory-world__move memory-world__move--${direction}`}
                  type="button"
                  aria-label={label}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    mountRef.current
                      ?.querySelector("canvas")
                      ?.focus({ preventScroll: true });
                    heldMovementRef.current.add(direction);
                  }}
                  onPointerUp={(event) => {
                    heldMovementRef.current.delete(direction);
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                  }}
                  onPointerCancel={() =>
                    heldMovementRef.current.delete(direction)
                  }
                  onLostPointerCapture={() =>
                    heldMovementRef.current.delete(direction)
                  }
                  onKeyDown={(event) => {
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      heldMovementRef.current.add(direction);
                    }
                  }}
                  onKeyUp={() => heldMovementRef.current.delete(direction)}
                  onBlur={() => heldMovementRef.current.delete(direction)}
                >
                  {arrow}
                </button>
              ))}
              <span>Hold to walk</span>
            </div>
          )}
        </>
      )}
      {!unavailable && (
        <div className="memory-world__footer">
          <div className="memory-world__instructions">
            <strong>
              {inVR
                ? "Left stick to walk · Right stick to turn"
                : moveObjects
                  ? "Drag an object to move it · Release to place"
                  : navigationMode === "walk"
                    ? "Drag to look · WASD or arrows to walk"
                    : "Drag to orbit · Pinch or scroll to approach"}
            </strong>
            <br />
            {inVR
              ? memory?.mediaType === "video"
                ? "Trigger on the video to play/pause. Objects stay fixed."
                : "Hold grip to pick up objects; release to place. Trigger teleports."
              : moveObjects
                ? "Reset objects restores the photograph’s arrangement."
                : navigationMode === "walk"
                  ? "Explore every side. Q / E moves down / up."
                  : "Inspect the shapes, then walk through them."}{" "}
            <button
              type="button"
              className="memory-world__reset"
              onClick={() => resetRef.current()}
            >
              Reset view
            </button>
          </div>
        </div>
      )}
      <div className="memory-world__vr" ref={vrButtonRef}>
        <span>Quest · first-person</span>
      </div>
    </section>
  );
}

export default MemoryWorld;
