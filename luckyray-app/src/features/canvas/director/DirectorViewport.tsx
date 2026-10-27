import { forwardRef, useLayoutEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { DirectorViewportHandle, DirectorViewportProps } from '../../../core/canvas/director/types';
import { applyDirectorCamera, applyDirectorTransform, boundedDirectorCamera, buildDirectorObject, directorAspect, directorCaptureSize, directorTransformPatch, directorViewportSize, disposeDirectorObject } from './directorGeometry';

import type { DirectorJointId, DirectorObject, DirectorRigPose, Vec3 } from '../../../core/canvas/director/types';
import { getObjectRigPose, setJointRotation, solveLimbIK } from '../../../core/canvas/director/rig';
import { applyDirectorRigPose, directorBoneRotation, directorIKLimb, directorJointWorldPosition, directorRenderableBounds, getDirectorRig, setDirectorRigHelpers, updateDirectorRigMarkerScale } from './directorRigGeometry';
import { buildDirectorCameraHelper, syncDirectorCameraHelper, cameraFromDirectorHelper } from './directorCameraGeometry';
import type { DirectorCamera } from '../../../core/canvas/director/types';
import { navigateDirectorCamera, type CameraMotion } from './directorCameraNavigation';
import { directorBoundsInRectangle, mergeDirectorSelection, type SelectionOperation } from './directorSelection';
import { DirectorPerformance } from './directorPerformance';

type Runtime = DirectorViewportHandle & { update: () => void };

/** Owns its entire WebGL lifecycle. The persistent document always stays outside the renderer. */
export const DirectorViewport = forwardRef<DirectorViewportHandle, DirectorViewportProps>(function DirectorViewport(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const runtime = useRef<Runtime | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useImperativeHandle(ref, () => ({
    capture: () => runtime.current?.capture() ?? Promise.reject(new Error('3D renderer is unavailable')),
    frameSelection: () => runtime.current?.frameSelection(),
    resetOrbit: () => runtime.current?.resetOrbit(),
    alignCameraToOrbit: () => runtime.current?.alignCameraToOrbit(),
  }), []);

  // Dispose document-bound controls before React removes their DOM root.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false, lost = false, frame = 0, width = 1, height = 1;
    let renderer: THREE.WebGLRenderer;
    const fail = (message: string) => {
      if (disposed) return;
      setFailure(message);
      latest.current.onError?.(message);
    };
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      fail(latest.current.english ? '3D preview needs WebGL 2. Your stage data is safe; enable graphics acceleration and try again.' : '3D 预览需要 WebGL 2。场景数据仍保留，请开启图形加速后重试。');
      return;
    }
    setFailure(null);
    latest.current.onError?.('');
    const canvas = renderer.domElement;
    const performanceStats = new DirectorPerformance();
    // Bounded local DevTools inspection; no persistence, telemetry or polling.
    Object.defineProperty(canvas, 'directorPerformance', { configurable: true, value: () => performanceStats.snapshot() });
    canvas.setAttribute('aria-label', latest.current.english ? '3D stage viewport' : '3D 导演台视图');
    canvas.tabIndex = 0;
    Object.assign(canvas.style, { display: 'block', position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', touchAction: 'none', outline: 'none' });
    element.appendChild(canvas);
    const thirds = document.createElement('div');
    thirds.setAttribute('aria-hidden', 'true');
    Object.assign(thirds.style, { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none', boxSizing: 'border-box', border: '1px solid rgba(255,255,255,.2)', backgroundImage: 'linear-gradient(to right, transparent calc(33.333% - .5px), rgba(255,255,255,.15) calc(33.333% - .5px), rgba(255,255,255,.15) calc(33.333% + .5px), transparent calc(33.333% + .5px), transparent calc(66.666% - .5px), rgba(255,255,255,.15) calc(66.666% - .5px), rgba(255,255,255,.15) calc(66.666% + .5px), transparent calc(66.666% + .5px)), linear-gradient(to bottom, transparent calc(33.333% - .5px), rgba(255,255,255,.15) calc(33.333% - .5px), rgba(255,255,255,.15) calc(33.333% + .5px), transparent calc(33.333% + .5px), transparent calc(66.666% - .5px), rgba(255,255,255,.15) calc(66.666% - .5px), rgba(255,255,255,.15) calc(66.666% + .5px), transparent calc(66.666% + .5px))' });
    element.appendChild(thirds);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    // Camera motion does not change directional-light shadows.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    const world = new THREE.Scene();
    const objects = new THREE.Group(); world.add(objects);
    const orbitCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    orbitCamera.position.set(7, 5, 8);
    const shotCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    const topCamera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.05, 500);
    topCamera.position.set(0, 30, 0); topCamera.up.set(0, 0, -1); topCamera.lookAt(0, 0, 0);
    const activeCamera = () => latest.current.mode === 'camera' ? shotCamera : latest.current.mode === 'top' ? topCamera : orbitCamera;
    const navigation = {
      orbit: new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(orbitCamera, canvas),
      camera: new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(shotCamera, canvas),
      top: new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(topCamera, canvas),
    };
    for (const control of Object.values(navigation)) {
      control.minDistance = 0.2; control.maxDistance = 150;
      control.minZoom = 0.15; control.maxZoom = 20;
      control.enableDamping = false; control.enabled = false;
      control.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      control.mouseButtons.LEFT = -1 as THREE.MOUSE;
    }
    navigation.camera.minDistance = .0001; navigation.camera.maxDistance = Infinity;
    navigation.orbit.target.set(0, 0.9, 0); navigation.orbit.update();
    navigation.top.enableRotate = false;
    let orbit = navigation[latest.current.mode]; orbit.enabled = true;
    const controls = new TransformControls(orbitCamera, canvas);
    controls.setSize(0.85);
    const gizmo = controls.getHelper(); world.add(gizmo);
    const poseTarget = new THREE.Group(); world.add(poseTarget);
    const selectionTarget = new THREE.Group(); world.add(selectionTarget);
    const selectionOutlines = new Map<string, THREE.BoxHelper>();
    const selectionBox = document.createElement('div'); selectionBox.dataset.directorSelectionBox = 'true';
    Object.assign(selectionBox.style, { position: 'absolute', pointerEvents: 'none', display: 'none', border: '1px solid #a6b5ff', background: 'rgba(126,146,255,.15)', zIndex: '2' }); element.appendChild(selectionBox);
    const selectedIds = () => latest.current.selectedIds ?? (latest.current.selectedId ? [latest.current.selectedId] : []);
    const selectionContext = () => JSON.stringify([latest.current.selectedId, selectedIds(), !!latest.current.cameraSelected, !!latest.current.poseEditing, latest.current.selectedJoint, latest.current.poseTool]);
    let groupGesture: { selection: string; sources: DirectorObject[]; matrix: THREE.Matrix4; originals: Map<string, THREE.Matrix4>; mode: DirectorViewportProps['mode']; transform: DirectorViewportProps['transform'] } | null = null;
    let shotGesture: { selection: string; source: DirectorCamera; preview: DirectorCamera; mode: CameraMotion; x: number; y: number; pointer: number; moved: boolean; transform: DirectorViewportProps['transform'] } | null = null;
    let wheelSelection = '';
    let wheelSource: DirectorCamera | null = null, wheelPreview: DirectorCamera | null = null, wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const cameraHelper = buildDirectorCameraHelper(); world.add(cameraHelper);
    let cameraGesture: { source: DirectorCamera; mode: DirectorViewportProps['mode']; transform: DirectorViewportProps['transform']; position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null;
    let poseGesture: { id: string; source: DirectorObject; joint: DirectorJointId; tool: string; before: DirectorRigPose; preview: DirectorRigPose } | null = null;
    const grid = new THREE.GridHelper(40, 40, '#8793a8', '#727b8b');
    grid.position.y = 0.006;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.22;
    world.add(grid);
    const outline = new THREE.BoxHelper(new THREE.Object3D(), '#b0bfff');
    world.add(outline);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: '#535963', roughness: 0.95 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMaterial);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.position.y = -0.005; world.add(ground);
    const ambient = new THREE.HemisphereLight('#ffffff', '#7c8597', 1); world.add(ambient);
    const key = new THREE.DirectionalLight('#ffffff', 3); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -18; key.shadow.camera.right = 18; key.shadow.camera.top = 18; key.shadow.camera.bottom = -18;
    key.shadow.camera.near = 0.1; key.shadow.camera.far = 80;
    key.shadow.normalBias = 0.025; key.shadow.bias = -0.0001;
    world.add(key); world.add(key.target);
    const fill = new THREE.DirectionalLight('#c9d8ff', 0.4); fill.position.set(-6, 4, -5); world.add(fill);
    const objectMap = new Map<string, { mesh: THREE.Group; signature: string }>();
    const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
    ray.params.Line.threshold = 0.06;
    let previousMode = latest.current.mode;
    let navigating = false;
    let navigationGesture: { control: typeof orbit; mode: DirectorViewportProps['mode']; source: DirectorCamera; position: THREE.Vector3; quaternion: THREE.Quaternion; up: THREE.Vector3; target: THREE.Vector3; zoom: number } | null = null;
    const savedOrbitTarget = new THREE.Vector3(0, 0.9, 0), savedTopTarget = new THREE.Vector3();
    let queuedAt = 0, outlineDirty = true;
    const draw = () => {
      frame = 0;
      if (disposed || lost) return;
      try {
        const started = performance.now();
        const selectedRoot = objectMap.get(latest.current.selectedId || '')?.mesh;
        if (outlineDirty && selectedRoot && outline.visible) outline.setFromObject(selectedRoot);
        objectMap.forEach(entry => updateDirectorRigMarkerScale(entry.mesh, activeCamera(), renderHeight || height, latest.current.selectedJoint));
        if (outlineDirty) selectionOutlines.forEach((helper, id) => { const mesh = objectMap.get(id)?.mesh; if (mesh && helper.visible) helper.setFromObject(mesh); });
        outlineDirty = false;
        const shadowUpdated = renderer.shadowMap.needsUpdate;
        renderer.render(world, activeCamera());
        performanceStats.record(started - queuedAt, performance.now() - started, shadowUpdated);
      } catch {
        lost = true;
        fail(latest.current.english ? '3D rendering stopped. Stage edits are preserved. Retry the preview.' : '3D 渲染已停止，场景编辑仍保留。请重试预览。');
      }
    };
    const invalidate = () => { if (!frame && !disposed && !lost) { queuedAt = performance.now(); frame = requestAnimationFrame(draw); } };
    let renderWidth = 0, renderHeight = 0;
    const resize = () => {
      if (disposed || lost) return;
      width = Math.max(1, element.clientWidth); height = Math.max(1, element.clientHeight);
      const size = directorViewportSize(width, height, latest.current.mode === 'camera' ? directorAspect(latest.current.scene.camera.aspect) : undefined);
      const nextWidth = Math.round(size.width), nextHeight = Math.round(size.height);
      if (nextWidth !== renderWidth || nextHeight !== renderHeight) {
        renderer.setSize(nextWidth, nextHeight, true);
        renderWidth = nextWidth; renderHeight = nextHeight; performanceStats.counts.resizes++;
      }
      thirds.style.width = `${Math.round(size.width)}px`; thirds.style.height = `${Math.round(size.height)}px`;
      thirds.style.display = latest.current.guides && latest.current.mode === 'camera' ? 'block' : 'none';
      orbitCamera.aspect = width / height; orbitCamera.updateProjectionMatrix();
      topCamera.left = -6 * width / height; topCamera.right = 6 * width / height;
      topCamera.top = 6; topCamera.bottom = -6; topCamera.updateProjectionMatrix();
      invalidate();
    };
    let previousObjects: DirectorViewportProps['scene']['objects'] | undefined;
    let previousLighting: DirectorViewportProps['scene']['lighting'] | undefined;
    let previousCamera: DirectorViewportProps['scene']['camera'] | undefined;
    let previousPresentation: DirectorViewportProps['scene']['presentation'];
    const update = () => {
      if (disposed || lost) return;
      const p = latest.current;
      if (shotGesture && (selectionContext() !== shotGesture.selection || p.mode !== 'camera' || p.scene.camera !== shotGesture.source || p.transform !== shotGesture.transform)) cancelGesture();
      if (wheelSource && (selectionContext() !== wheelSelection || p.mode !== 'camera' || p.scene.camera !== wheelSource)) cancelGesture();
      if (down && (down.selection !== selectionContext() || down.mode !== p.mode || down.objects !== p.scene.objects)) cancelGesture();
      if (groupGesture && (selectionContext() !== groupGesture.selection || p.mode !== groupGesture.mode || p.transform !== groupGesture.transform || groupGesture.sources.some(source => p.scene.objects.find(o => o.id === source.id) !== source || !selectedIds().includes(source.id)))) cancelGesture();
      if (navigationGesture && (p.mode !== navigationGesture.mode || (p.mode === 'camera' && p.scene.camera !== navigationGesture.source))) cancelGesture();
      if (cameraGesture && (p.scene.camera !== cameraGesture.source || !p.cameraSelected || p.mode !== cameraGesture.mode || p.transform !== cameraGesture.transform)) cancelGesture();
      if (poseGesture && (p.scene.objects.find(o => o.id === poseGesture!.id) !== poseGesture.source || !poseGesture.source.visible || poseGesture.source.locked || p.selectedId !== poseGesture.id || !p.poseEditing || p.selectedJoint !== poseGesture.joint || (p.poseTool ?? 'rotate') !== poseGesture.tool || previousMode !== p.mode || previousPresentation !== p.scene.presentation)) cancelGesture();
      if (previousCamera !== p.scene.camera) {
        const upChanged = JSON.stringify(previousCamera?.up ?? [0, 1, 0]) !== JSON.stringify(p.scene.camera.up ?? [0, 1, 0]);
        applyDirectorCamera(shotCamera, p.scene.camera);
        if (upChanged) rebuildCameraNavigation();
        previousCamera = p.scene.camera;
      }
      if (!cameraGesture) syncDirectorCameraHelper(cameraHelper, p.scene.camera);
      cameraHelper.visible = p.mode !== 'camera';
      if (previousObjects !== p.scene.objects || previousPresentation !== p.scene.presentation) {
      previousPresentation = p.scene.presentation;
      performanceStats.counts.sceneSyncs++; previousObjects = p.scene.objects;
      renderer.shadowMap.needsUpdate = true; outlineDirty = true;
      const wanted = new Set(p.scene.objects.map(object => object.id));
      for (const [id, entry] of objectMap) if (!wanted.has(id)) {
        if (controls.object) controls.detach();
        disposeDirectorObject(entry.mesh); objectMap.delete(id);
      }
      for (const object of p.scene.objects) {
        const signature = `${object.kind}|${object.color}|${p.scene.presentation?.mode === 'clay' ? p.scene.presentation.clayColor : ''}`;
        let entry = objectMap.get(object.id);
        if (!entry || entry.signature !== signature) {
          if (entry) { if (controls.object) controls.detach(); disposeDirectorObject(entry.mesh); }
          entry = { mesh: buildDirectorObject(object, p.scene.presentation?.mode === 'clay' ? p.scene.presentation.clayColor : undefined), signature }; objects.add(entry.mesh); objectMap.set(object.id, entry);
        }
        if (!(controls.dragging && (controls.object === entry.mesh || poseGesture?.id === object.id))) { applyDirectorTransform(entry.mesh, object); if (object.kind === 'actor') applyDirectorRigPose(entry.mesh, getObjectRigPose(object)); }
      }
      }
      if (previousLighting !== p.scene.lighting) {
      previousLighting = p.scene.lighting; renderer.shadowMap.needsUpdate = true;
      const lighting = p.scene.lighting;
      world.background = new THREE.Color(lighting.background);
      groundMaterial.color.set(lighting.ground);
      ambient.intensity = lighting.ambient; key.intensity = lighting.intensity; key.color.set(lighting.color);
      fill.intensity = lighting.ambient * 0.25;
      const az = THREE.MathUtils.degToRad(lighting.azimuth), el = THREE.MathUtils.degToRad(lighting.elevation);
      key.position.set(Math.sin(az) * Math.cos(el) * 20, Math.sin(el) * 20, Math.cos(az) * Math.cos(el) * 20);
      }
      if (p.mode !== previousMode) {
        if (previousMode === 'orbit') savedOrbitTarget.copy(orbit.target);
        if (previousMode === 'top') savedTopTarget.copy(orbit.target);
        previousMode = p.mode;
        orbit.enabled = false;
        orbit = navigation[p.mode]; orbit.enabled = !controls.dragging;
        orbit.target.copy(p.mode === 'orbit' ? savedOrbitTarget : p.mode === 'top' ? savedTopTarget : new THREE.Vector3(...p.scene.camera.target));
        orbit.update();
      } else if (p.mode === 'camera' && !controls.dragging) orbit.target.fromArray(p.scene.camera.target);
      orbit.enableRotate = p.mode !== 'top';
      controls.camera = activeCamera();
      const selected = p.scene.objects.find(object => object.id === p.selectedId);
      const multi = p.scene.objects.filter(object => selectedIds().includes(object.id) && object.visible && !object.locked);
      const selectedMesh = selected ? objectMap.get(selected.id)?.mesh : undefined;
      const posing = Boolean(p.poseEditing && selected?.kind === 'actor' && selected.visible && !selected.locked);
      objectMap.forEach((entry, id) => setDirectorRigHelpers(entry.mesh, posing && id === selected?.id, p.selectedJoint));
      if (p.cameraSelected && p.mode !== 'camera') {
        controls.setMode(p.transform === 'rotate' ? 'rotate' : 'translate'); controls.setSpace(p.transform === 'rotate' ? 'local' : 'world');
        if (controls.object !== cameraHelper) controls.attach(cameraHelper);
      } else if (multi.length > 1 && p.onTransforms) {
        if (!groupGesture) { const box = new THREE.Box3(); for (const object of multi) { const mesh = objectMap.get(object.id)?.mesh; if (mesh) box.union(directorRenderableBounds(mesh)); } selectionTarget.position.copy(box.getCenter(new THREE.Vector3())); selectionTarget.quaternion.identity(); selectionTarget.scale.setScalar(1); }
        controls.setMode(p.transform); controls.setSpace('world'); if (controls.object !== selectionTarget) controls.attach(selectionTarget);
      } else if (selectedMesh && selected?.visible && !selected.locked) {
        if (posing) {
          const bone = p.selectedJoint ? getDirectorRig(selectedMesh)?.bones.get(p.selectedJoint) : undefined;
          const limb = directorIKLimb(p.selectedJoint);
          if (bone && (p.poseTool !== 'ik' || limb)) {
            const target = p.poseTool === 'ik' ? poseTarget : bone;
            if (p.poseTool === 'ik' && !controls.dragging) poseTarget.position.copy(directorJointWorldPosition(selectedMesh, p.selectedJoint!));
            controls.setMode(p.poseTool === 'ik' ? 'translate' : 'rotate'); controls.setSpace(p.poseTool === 'ik' ? 'world' : 'local');
            if (controls.object !== target) controls.attach(target);
          } else controls.detach();
        } else { controls.setMode(p.transform); controls.setSpace('world'); if (controls.object !== selectedMesh) controls.attach(selectedMesh); }
      } else controls.detach();
      outline.visible = Boolean(selectedMesh && selected?.visible && p.guides && !posing);
      if (selectedMesh && outline.visible) outline.setFromObject(selectedMesh);
      for (const [id, helper] of selectionOutlines) if (!multi.some(o => o.id === id) || multi.length < 2) { helper.removeFromParent(); helper.geometry.dispose(); (helper.material as THREE.Material).dispose(); selectionOutlines.delete(id); }
      if (multi.length > 1) { outline.visible = false; for (const object of multi) { let helper = selectionOutlines.get(object.id); if (!helper) { helper = new THREE.BoxHelper(objectMap.get(object.id)!.mesh, '#b0bfff'); world.add(helper); selectionOutlines.set(object.id, helper); } helper.visible = p.guides; } }
      grid.visible = p.guides;
      resize(); invalidate();
    };
    const onOrbitStart = () => {
      navigating = true;
      navigationGesture = { control: orbit, mode: latest.current.mode, source: latest.current.scene.camera, position: orbit.object.position.clone(), quaternion: orbit.object.quaternion.clone(), up: orbit.object.up.clone(), target: orbit.target.clone(), zoom: orbit.object.zoom };
    };
    const onOrbitChange = () => invalidate();
    const onOrbitEnd = (event?: { target?: unknown }) => {
      if (event && (event.target !== orbit || !navigationGesture)) return;
      navigating = false; navigationGesture = null;
      if (latest.current.mode === 'camera' && !controls.dragging && (shotCamera.position.distanceToSquared(new THREE.Vector3(...latest.current.scene.camera.position)) > 1e-10 || orbit.target.distanceToSquared(new THREE.Vector3(...latest.current.scene.camera.target)) > 1e-10)) {
        const camera = boundedDirectorCamera(latest.current.scene.camera, shotCamera.position.toArray(), orbit.target.toArray());
        applyDirectorCamera(shotCamera, camera); orbit.target.fromArray(camera.target); orbit.update();
        if (latest.current.onCameraChange?.(camera) === false) { applyDirectorCamera(shotCamera, latest.current.scene.camera); orbit.target.fromArray(latest.current.scene.camera.target); orbit.update(); }
        syncDirectorCameraHelper(cameraHelper, latest.current.scene.camera);
      }
    };
    for (const control of Object.values(navigation)) { control.addEventListener('start', onOrbitStart); control.addEventListener('change', onOrbitChange); control.addEventListener('end', onOrbitEnd); }
    // OrbitControls caches its up-axis basis at construction. Rebuild only after
    // persisted roll changes, using public APIs rather than editing private fields.
    const rebuildCameraNavigation = () => {
      const old = navigation.camera, active = orbit === old;
      old.removeEventListener('start', onOrbitStart); old.removeEventListener('change', onOrbitChange); old.removeEventListener('end', onOrbitEnd); old.dispose();
      const next = new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(shotCamera, canvas);
      next.minDistance = .0001; next.maxDistance = Infinity; next.minZoom = 0.15; next.maxZoom = 20;
      next.enableDamping = false; next.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE; next.mouseButtons.LEFT = -1 as THREE.MOUSE; next.enabled = active && !controls.dragging;
      next.target.fromArray(latest.current.scene.camera.target); next.update();
      next.addEventListener('start', onOrbitStart); next.addEventListener('change', onOrbitChange); next.addEventListener('end', onOrbitEnd);
      navigation.camera = next; if (active) orbit = next;
    };
    const onDragging = (event: { value: unknown }) => { orbit.enabled = !event.value; invalidate(); };
    let cancellingTransform = false;
    const onTransformStart = () => {
      const p = latest.current, source = p.scene.objects.find(o => o.id === p.selectedId);
      if (controls.object === selectionTarget) { const sources = p.scene.objects.filter(o => selectedIds().includes(o.id) && o.visible && !o.locked); selectionTarget.updateMatrix(); groupGesture = { selection: selectionContext(), sources, mode: p.mode, transform: p.transform, matrix: selectionTarget.matrix.clone(), originals: new Map(sources.map(o => { const mesh = objectMap.get(o.id)!.mesh; mesh.updateMatrix(); return [o.id, mesh.matrix.clone()]; })) }; return; }
      if (p.cameraSelected && p.mode !== 'camera' && controls.object === cameraHelper) {
        cameraGesture = { source: p.scene.camera, mode: p.mode, transform: p.transform, position: cameraHelper.position.clone(), quaternion: cameraHelper.quaternion.clone() };
      } else if (p.poseEditing && source?.kind === 'actor' && source.visible && !source.locked && p.selectedJoint) {
        const before = getObjectRigPose(source);
        poseGesture = { id: source.id, source, joint: p.selectedJoint, tool: p.poseTool ?? 'rotate', before, preview: before };
      }
    };
    const onTransformEnd = () => {
      if (cancellingTransform) return;
      if (groupGesture) { const gesture = groupGesture; groupGesture = null;
        const patches = gesture.sources.map(source => ({ id: source.id, patch: directorTransformPatch(objectMap.get(source.id)!.mesh) }));
        const changed = patches.some(({ id, patch }) => { const source = gesture.sources.find(o => o.id === id)!; return JSON.stringify([patch.position, patch.rotation, patch.scale]) !== JSON.stringify([source.position, source.rotation, source.scale]); });
        if (changed && latest.current.onTransforms?.(patches) === false) for (const source of gesture.sources) applyDirectorTransform(objectMap.get(source.id)!.mesh, source);
        renderer.shadowMap.needsUpdate = true; outlineDirty = true; invalidate(); return;
      }
      if (cameraGesture) {
        const gesture = cameraGesture; cameraGesture = null;
        const p = latest.current;
        const valid = p.scene.camera === gesture.source && p.cameraSelected && p.mode === gesture.mode && p.transform === gesture.transform;
        const changed = cameraHelper.position.distanceToSquared(gesture.position) > 1e-12 || 1 - Math.abs(cameraHelper.quaternion.dot(gesture.quaternion)) > 1e-12;
        const camera = changed ? cameraFromDirectorHelper(cameraHelper, gesture.source) : gesture.source;
        const accepted = valid && (JSON.stringify(camera) === JSON.stringify(gesture.source) || p.onCameraChange?.(camera) !== false);
        const result = accepted ? camera : p.scene.camera;
        syncDirectorCameraHelper(cameraHelper, result); applyDirectorCamera(shotCamera, result);
        navigation.camera.target.fromArray(result.target); invalidate(); return;
      }
      if (poseGesture) {
        const gesture = poseGesture; poseGesture = null;
        const mesh = objectMap.get(gesture.id)?.mesh;
        const p = latest.current, source = p.scene.objects.find(item => item.id === gesture.id);
        const valid = source === gesture.source && source.visible && !source.locked && p.poseEditing && p.selectedId === source.id;
        if (mesh) {
          if (!valid) applyDirectorRigPose(mesh, gesture.before);
          else if (JSON.stringify(gesture.preview) !== JSON.stringify(gesture.before) && p.onTransform(source.id, { rig: gesture.preview }) === false) applyDirectorRigPose(mesh, gesture.before);
        }
      } else {
        const object = controls.object;
        const id = object?.userData.directorId as string;
        const source = latest.current.scene.objects.find(item => item.id === id);
        if (object && source?.visible && !source.locked) {
          const patch = directorTransformPatch(object); applyDirectorTransform(object, { ...source, ...patch });
          if (JSON.stringify([patch.position, patch.rotation, patch.scale]) !== JSON.stringify([source.position, source.rotation, source.scale]) && latest.current.onTransform(id, patch) === false) applyDirectorTransform(object, source);
        }
      }
      renderer.shadowMap.needsUpdate = true; invalidate();
    };
    const onObjectChange = () => {
      if (cancellingTransform) { invalidate(); return; }
      if (groupGesture) { selectionTarget.updateMatrix(); const delta = selectionTarget.matrix.clone().multiply(groupGesture.matrix.clone().invert());
        for (const source of groupGesture.sources) { const mesh = objectMap.get(source.id)!.mesh; delta.clone().multiply(groupGesture.originals.get(source.id)!).decompose(mesh.position, mesh.quaternion, mesh.scale); }
        renderer.shadowMap.needsUpdate = true; outlineDirty = true; invalidate(); return;
      }
      if (cameraGesture && !cancellingTransform) {
        applyDirectorCamera(shotCamera, cameraFromDirectorHelper(cameraHelper, cameraGesture.source));
        invalidate(); return;
      }
      if (poseGesture && !cancellingTransform) {
        const mesh = objectMap.get(poseGesture.id)?.mesh;
        if (mesh) {
          const limb = directorIKLimb(poseGesture.joint);
          poseGesture.preview = poseGesture.tool === 'ik' && limb ? solveLimbIK(poseGesture.before, limb, mesh.worldToLocal(poseTarget.position.clone()).toArray() as Vec3) : setJointRotation(poseGesture.before, poseGesture.joint, directorBoneRotation(mesh, poseGesture.joint));
          applyDirectorRigPose(mesh, poseGesture.preview);
        }
      }
      renderer.shadowMap.needsUpdate = true; outlineDirty = true; invalidate();
    };
    controls.addEventListener('mouseDown', onTransformStart);
    controls.addEventListener('objectChange', onObjectChange);
    controls.addEventListener('change', invalidate);
    controls.addEventListener('dragging-changed', onDragging);
    controls.addEventListener('mouseUp', onTransformEnd);
    let down: { selection: string; x: number; y: number; gizmo: boolean; pointer: number; mode: DirectorViewportProps['mode']; objects: DirectorObject[]; operation: SelectionOperation; ids: string[] } | null = null;
    let activePointer: number | null = null;
    const publishSelection = (hits: string[], operation: SelectionOperation, ids = selectedIds()) => { const next = mergeDirectorSelection(ids, hits, operation); if (latest.current.onSelectionChange) latest.current.onSelectionChange(next); else latest.current.onSelect(next[next.length - 1] ?? null); };
    const finishShot = () => {
      const gesture = shotGesture; shotGesture = null; navigating = false;
      if (!gesture) return;
      const accepted = gesture.moved && gesture.selection === selectionContext() && latest.current.mode === 'camera' && latest.current.scene.camera === gesture.source && JSON.stringify(gesture.preview) !== JSON.stringify(gesture.source) && latest.current.onCameraChange?.(gesture.preview) !== false;
      const result = accepted ? gesture.preview : latest.current.scene.camera; applyDirectorCamera(shotCamera, result); navigation.camera.target.fromArray(result.target); invalidate();
    };
    const finishWheel = () => {
      if (wheelTimer) clearTimeout(wheelTimer); wheelTimer = null;
      const source = wheelSource, preview = wheelPreview; wheelSource = null; wheelPreview = null; navigating = false;
      if (!source || !preview) return;
      const accepted = wheelSelection === selectionContext() && latest.current.mode === 'camera' && latest.current.scene.camera === source && JSON.stringify(preview) !== JSON.stringify(source) && latest.current.onCameraChange?.(preview) !== false;
      const result = accepted ? preview : latest.current.scene.camera; applyDirectorCamera(shotCamera, result); navigation.camera.target.fromArray(result.target); invalidate();
    };
    // Capture runs before Three's listeners; shot navigation never enters OrbitControls.
    const configureNavigation = (event: PointerEvent) => {
      if (event.button === 1 && latest.current.mode === 'top') navigation.top.mouseButtons.MIDDLE = event.shiftKey || event.ctrlKey || event.metaKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
      if (latest.current.mode !== 'camera' || (event.button === 0 && (controls.axis || latest.current.poseEditing)) || ![0, 1, 2].includes(event.button)) return;
      if (shotGesture || controls.dragging) return;
      const source = wheelSource ?? latest.current.scene.camera, preview = wheelPreview ?? source;
      if (wheelTimer) clearTimeout(wheelTimer); wheelTimer = null; wheelSource = null; wheelPreview = null;
      const mode: CameraMotion = event.button === 2 || event.shiftKey || (event.button === 0 && latest.current.transform !== 'rotate') ? 'pan' : 'look';
      shotGesture = { selection: selectionContext(), source, preview, mode, x: event.clientX, y: event.clientY, pointer: event.pointerId, moved: preview !== source, transform: latest.current.transform };
      if (event.button === 0) down = { selection: selectionContext(), x: event.clientX, y: event.clientY, gizmo: false, pointer: event.pointerId, mode: latest.current.mode, objects: latest.current.scene.objects, operation: event.ctrlKey || event.metaKey ? 'subtract' : event.shiftKey ? 'add' : 'replace', ids: [...selectedIds()] };
      navigating = true; activePointer = event.pointerId; canvas.focus({ preventScroll: true }); canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const cameraWheel = (event: WheelEvent) => {
      if (latest.current.mode !== 'camera') return;
      event.preventDefault(); event.stopImmediatePropagation(); if (shotGesture || controls.dragging) return;
      if (!wheelSource) { wheelSource = latest.current.scene.camera; wheelSelection = selectionContext(); }
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? renderHeight : 1);
      wheelPreview = navigateDirectorCamera(wheelPreview ?? wheelSource, 'dolly', 0, Math.max(-240, Math.min(240, pixels)), event.altKey);
      applyDirectorCamera(shotCamera, wheelPreview); navigation.camera.target.fromArray(wheelPreview.target); navigating = true; invalidate();
      if (wheelTimer) clearTimeout(wheelTimer); wheelTimer = setTimeout(finishWheel, 180);
    };
    const onDown = (event: PointerEvent) => {
      if (down || controls.dragging && event.button !== 0) return;
      activePointer = event.pointerId; canvas.focus({ preventScroll: true });
      if (event.button === 0) { down = { selection: selectionContext(), x: event.clientX, y: event.clientY, gizmo: Boolean(controls.axis) || controls.dragging, pointer: event.pointerId, mode: latest.current.mode, objects: latest.current.scene.objects, operation: event.ctrlKey || event.metaKey ? 'subtract' : event.shiftKey ? 'add' : 'replace', ids: [...selectedIds()] }; if (!down.gizmo) canvas.setPointerCapture?.(event.pointerId); }
    };
    const onMove = (event: PointerEvent) => {
      if (shotGesture && shotGesture.pointer === event.pointerId) {
        const g = shotGesture, dx = event.clientX - g.x, dy = event.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 3) return;
        g.moved = true; g.preview = navigateDirectorCamera(g.preview, g.mode, dx, dy, event.altKey); g.x = event.clientX; g.y = event.clientY;
        applyDirectorCamera(shotCamera, g.preview); navigation.camera.target.fromArray(g.preview.target); invalidate(); event.preventDefault(); return;
      }
      if (!down || down.pointer !== event.pointerId || down.gizmo || controls.dragging || down.mode === 'camera' || Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4) return;
      const hostRect = element.getBoundingClientRect();
      Object.assign(selectionBox.style, { display: 'block', left: `${Math.min(down.x, event.clientX) - hostRect.left}px`, top: `${Math.min(down.y, event.clientY) - hostRect.top}px`, width: `${Math.abs(event.clientX - down.x)}px`, height: `${Math.abs(event.clientY - down.y)}px` });
    };
    const onUp = (event: PointerEvent) => {
      if (shotGesture?.pointer === event.pointerId) { const click = !shotGesture.moved && down?.pointer === event.pointerId; finishShot(); if (!click) { down = null; activePointer = null; if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId); return; } }
      const start = down; if (!start || start.pointer !== event.pointerId) return; down = null; selectionBox.style.display = 'none'; activePointer = null;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (start.gizmo || controls.dragging || start.selection !== selectionContext()) return;
      const bounds = canvas.getBoundingClientRect();
      world.updateMatrixWorld(true); activeCamera().updateMatrixWorld();
      if (Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4) {
        if (start.mode === 'camera') return;
        const rect = { left: (Math.min(start.x, event.clientX) - bounds.left) / bounds.width * 2 - 1, right: (Math.max(start.x, event.clientX) - bounds.left) / bounds.width * 2 - 1, top: 1 - (Math.min(start.y, event.clientY) - bounds.top) / bounds.height * 2, bottom: 1 - (Math.max(start.y, event.clientY) - bounds.top) / bounds.height * 2 };
        const hits = latest.current.scene.objects.filter(o => o.visible && !o.locked && directorBoundsInRectangle(directorRenderableBounds(objectMap.get(o.id)!.mesh), activeCamera(), rect)).map(o => o.id);
        publishSelection(hits, start.operation, start.ids); return;
      }
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1); ray.setFromCamera(pointer, activeCamera());
      const visible = (o: THREE.Object3D) => { for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false; return true; };
      const eligible = latest.current.scene.objects.filter(o => o.visible && !o.locked).map(o => objectMap.get(o.id)!.mesh);
      const hits = ray.intersectObjects([...eligible, ...(cameraHelper.visible ? [cameraHelper] : [])], true).filter(hit => visible(hit.object));
      const hit = hits.find(hit => hit.object.userData.directorPoseHandle) ?? hits[0];
      if (hit?.object.userData.directorCamera) { latest.current.onCameraSelect?.(); return; }
      if (latest.current.poseEditing && hit) {
        let joint: THREE.Object3D | null = hit.object; while (joint && !joint.userData.directorJoint) joint = joint.parent;
        let actor: THREE.Object3D | null = hit.object; while (actor && !actor.userData.directorId) actor = actor.parent;
        const source = latest.current.scene.objects.find(o => o.id === actor?.userData.directorId);
        if (joint && source?.id === latest.current.selectedId && source.visible && !source.locked) { latest.current.onJointSelect?.(joint.userData.directorJoint); return; }
      }
      let object: THREE.Object3D | null = hit?.object ?? null; while (object && !object.userData.directorId) object = object.parent;
      publishSelection(object ? [object.userData.directorId] : [], start.operation, start.ids);
    };
    const cancelGesture = () => {
      down = null; selectionBox.style.display = 'none'; navigating = false; cancellingTransform = true;
      if (shotGesture || wheelSource) { shotGesture = null; wheelSource = null; wheelPreview = null; if (wheelTimer) clearTimeout(wheelTimer); wheelTimer = null; applyDirectorCamera(shotCamera, latest.current.scene.camera); navigation.camera.target.fromArray(latest.current.scene.camera.target); }
      const cancelledGroup = groupGesture; groupGesture = null;
      if (cancelledGroup) for (const source of cancelledGroup.sources) { const current = latest.current.scene.objects.find(o => o.id === source.id); const mesh = objectMap.get(source.id)?.mesh; if (mesh && current) applyDirectorTransform(mesh, current); }
      const cancelledNavigation = navigationGesture; navigationGesture = null;
      if (cancelledNavigation) {
        const n = cancelledNavigation, camera = n.control.object;
        if (n.mode === 'camera' && latest.current.scene.camera !== n.source) { applyDirectorCamera(shotCamera, latest.current.scene.camera); n.control.target.fromArray(latest.current.scene.camera.target); }
        else { camera.position.copy(n.position); camera.quaternion.copy(n.quaternion); camera.up.copy(n.up); camera.zoom = n.zoom; camera.updateProjectionMatrix(); n.control.target.copy(n.target); }
        n.control.update();
      }
      const gesture = poseGesture; poseGesture = null;
      const cancelledCamera = cameraGesture; cameraGesture = null;
      if (controls.dragging) { controls.reset(); controls.pointerUp(null); }
      if (cancelledCamera) { syncDirectorCameraHelper(cameraHelper, latest.current.scene.camera); applyDirectorCamera(shotCamera, latest.current.scene.camera); navigation.camera.target.fromArray(latest.current.scene.camera.target); }
      if (gesture) { const mesh = objectMap.get(gesture.id)?.mesh; if (mesh) applyDirectorRigPose(mesh, gesture.before); }
      else if (controls.object?.userData.directorId) { const source = latest.current.scene.objects.find(o => o.id === controls.object?.userData.directorId); if (source) applyDirectorTransform(controls.object, source); }
      cancellingTransform = false;
      if (activePointer !== null && canvas.hasPointerCapture?.(activePointer)) canvas.releasePointerCapture(activePointer);
      activePointer = null;
      controls.disconnect(); controls.connect(canvas);
      for (const control of Object.values(navigation)) { control.disconnect(); control.connect(canvas); }
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp);
      canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
      orbit.enabled = true; if (!cancelledCamera && !cancelledNavigation) renderer.shadowMap.needsUpdate = true; invalidate();
    };
    const clearDown = () => { cancelGesture(); update(); };
    const onLostCapture = (event: PointerEvent) => { if (event.pointerId === activePointer && (down || shotGesture || controls.dragging)) clearDown(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && (controls.dragging || poseGesture || cameraGesture || groupGesture || navigating || down)) { event.preventDefault(); event.stopPropagation(); clearDown(); } };
    window.addEventListener('keydown', onKey, true); window.addEventListener('blur', clearDown); canvas.addEventListener('blur', clearDown);
    // Three.js receives down/wheel on the canvas, but OrbitControls receives
    // move/up on ownerDocument. Do not strand its gesture before those listeners.
    const stop = (event: Event) => event.stopPropagation();
    const stopWheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); };
    const preventContext = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    const events = ['pointerdown', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend'];
    events.forEach(name => element.addEventListener(name, stop));
    element.addEventListener('wheel', stopWheel, { passive: false });
    element.addEventListener('contextmenu', preventContext);
    canvas.addEventListener('pointerdown', configureNavigation, true);
    canvas.addEventListener('wheel', cameraWheel, { capture: true, passive: false });
    canvas.addEventListener('pointermove', onMove); canvas.addEventListener('lostpointercapture', onLostCapture);
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', clearDown, true);
    const onContextLost = (event: Event) => {
      event.preventDefault(); cancelGesture(); lost = true;
      fail(latest.current.english ? 'Graphics context was lost. Stage data is preserved. Retry the preview.' : '图形上下文已丢失，场景数据仍保留。请重试预览。');
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    const observer = new ResizeObserver(resize); observer.observe(element);
    runtime.current = {
      update,
      capture: async () => {
        if (lost || disposed) throw new Error('3D preview is unavailable');
        if (controls.dragging || navigating) throw new Error(latest.current.english ? 'Finish moving the object before capture.' : '请先结束对象拖动，再保存镜头。');
        update();
        const size = directorCaptureSize(directorAspect(latest.current.scene.camera.aspect));
        const oldRatio = renderer.getPixelRatio();
        const helpers: THREE.Object3D[] = [grid, outline, gizmo, cameraHelper, ...selectionOutlines.values(), ...Array.from(objectMap.values()).flatMap(entry => getDirectorRig(entry.mesh)?.markers ?? [])]; const visibility = helpers.map(helper => helper.visible);
        try {
          helpers.forEach(helper => { helper.visible = false; });
          renderer.setPixelRatio(1); renderer.setSize(size.width, size.height, false);
          applyDirectorCamera(shotCamera, latest.current.scene.camera);
          renderer.render(world, shotCamera);
          const data = canvas.toDataURL('image/png');
          if (!data.startsWith('data:image/png;base64,')) throw new Error('Snapshot could not be encoded');
          return data;
        } finally {
          helpers.forEach((helper, index) => { helper.visible = visibility[index]; });
          renderer.setPixelRatio(oldRatio); renderWidth = 0; renderHeight = 0; resize(); if (frame) cancelAnimationFrame(frame); frame = 0; queuedAt = performance.now(); draw();
        }
      },
      frameSelection: () => {
        const selected = latest.current.cameraSelected && latest.current.mode !== 'camera' ? cameraHelper : objectMap.get(latest.current.selectedId || '')?.mesh;
        if (!selected || !selected.visible) return;
        const box = directorRenderableBounds(selected), center = box.getCenter(new THREE.Vector3()), dimensions = box.getSize(new THREE.Vector3());
        const camera = activeCamera(), radius = Math.max(0.3, dimensions.length() / 2);
        orbit.target.copy(center);
        if (camera instanceof THREE.PerspectiveCamera) {
          const direction = camera.position.clone().sub(center).normalize();
          if (direction.lengthSq() < 0.1) direction.set(1, 0.7, 1).normalize();
          const limitingFov = Math.min(camera.getEffectiveFOV(), THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * camera.aspect)));
          camera.position.copy(center).addScaledVector(direction, radius / Math.sin(THREE.MathUtils.degToRad(limitingFov) / 2) * 1.15);
        } else {
          camera.position.set(center.x, center.y + 30, center.z);
          topCamera.zoom = Math.max(0.15, Math.min(20, Math.min(12, 12 * width / height) / (radius * 2.5))); topCamera.updateProjectionMatrix();
        }
        orbit.update(); onOrbitEnd(); invalidate();
      },
      alignCameraToOrbit: () => {
        const target = latest.current.mode === 'orbit' ? orbit.target : savedOrbitTarget;
        const camera = boundedDirectorCamera({ ...latest.current.scene.camera, up: orbitCamera.up.toArray() as Vec3 }, orbitCamera.position.toArray(), target.toArray());
        applyDirectorCamera(shotCamera, camera); navigation.camera.target.fromArray(camera.target);
        if (latest.current.onCameraChange?.(camera) === false) { applyDirectorCamera(shotCamera, latest.current.scene.camera); navigation.camera.target.fromArray(latest.current.scene.camera.target); }
        invalidate();
      },
      resetOrbit: () => {
        orbitCamera.position.set(7, 5, 8); savedOrbitTarget.set(0, 0.9, 0);
        topCamera.position.set(0, 30, 0); topCamera.zoom = 1; topCamera.updateProjectionMatrix(); savedTopTarget.set(0, 0, 0);
        if (latest.current.mode === 'camera') applyDirectorCamera(shotCamera, latest.current.scene.camera);
        orbit.target.copy(latest.current.mode === 'top' ? savedTopTarget : latest.current.mode === 'orbit' ? savedOrbitTarget : new THREE.Vector3(...latest.current.scene.camera.target));
        orbit.update(); invalidate();
      },
    };
    // Initial camera selection must run even when mounted directly into shot/top view.
    controls.camera = activeCamera();
    orbit.target.copy(latest.current.mode === 'camera' ? new THREE.Vector3(...latest.current.scene.camera.target) : latest.current.mode === 'top' ? savedTopTarget : savedOrbitTarget);
    update();
    return () => {
      disposed = true; runtime.current = null;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      events.forEach(name => element.removeEventListener(name, stop));
      element.removeEventListener('wheel', stopWheel); element.removeEventListener('contextmenu', preventContext);
      canvas.removeEventListener('pointerdown', configureNavigation, true);
      canvas.removeEventListener('lostpointercapture', onLostCapture); canvas.removeEventListener('wheel', cameraWheel, true); canvas.removeEventListener('pointermove', onMove); if (wheelTimer) clearTimeout(wheelTimer);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', clearDown, true); canvas.removeEventListener('webglcontextlost', onContextLost);
      for (const control of Object.values(navigation)) { control.removeEventListener('start', onOrbitStart); control.removeEventListener('change', onOrbitChange); control.removeEventListener('end', onOrbitEnd); control.dispose(); }
      canvas.removeEventListener('blur', clearDown); window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', clearDown);
      controls.removeEventListener('mouseDown', onTransformStart); controls.removeEventListener('objectChange', onObjectChange); controls.removeEventListener('change', invalidate); controls.removeEventListener('dragging-changed', onDragging); controls.removeEventListener('mouseUp', onTransformEnd); controls.detach(); controls.dispose();
      gizmo.removeFromParent(); disposeDirectorObject(world); key.shadow.dispose();
      delete (canvas as HTMLCanvasElement & { directorPerformance?: unknown }).directorPerformance;
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); thirds.remove(); selectionBox.remove();
    };
  }, [generation]);

  useLayoutEffect(() => { runtime.current?.update(); }, [props.scene, props.selectedId, props.selectedIds, props.cameraSelected, props.mode, props.transform, props.guides, props.poseEditing, props.selectedJoint, props.poseTool]);
  return <div className="director-viewport" ref={host} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 220, overflow: 'hidden', background: '#171a20', isolation: 'isolate' }}>
    {failure && <div role="status" style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28, color: '#e5e7eb', background: '#20242d', textAlign: 'center' }}>
      <span>{failure}</span><button type="button" onClick={() => setGeneration(value => value + 1)}>{props.english ? 'Retry preview' : '重试预览'}</button>
    </div>}
  </div>;
});
export default DirectorViewport;
