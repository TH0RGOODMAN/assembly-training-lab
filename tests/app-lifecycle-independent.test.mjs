/**
 * Run the delivered app's actual lifecycle functions in an isolated Node VM.
 * Real Three.js scene matrices; synthetic controller poses; no WebGL or headset.
 * DOM rendering and ray-hit choice are stubbed so this does not claim UI/XR-device coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three.module.js';
import * as domain from '../domain.mjs';

const sourceURL = new URL('../app.js', import.meta.url);
const original = fs.readFileSync(sourceURL, 'utf8');
assert.match(original, /\nmain\(\);\s*$/);
const source = original.replace(/^import .*;\r?\n/gm, '').replace(/\nmain\(\);\s*$/, '\n');

function fixture() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { id, textContent: '', clientWidth: 1280, clientHeight: 720, close() {}, showModal() {}, querySelector() { return { textContent: '' }; } });
    return elements.get(id);
  }
  const context = vm.createContext({ THREE, ...domain, console, document: { getElementById: element }, Date });
  const harness = `
    // Only presentational functions and ray-hit selection are replaced.
    updateUI = () => {}; updateGhosts = () => {}; drawHUD = () => {};
    setFeedback = () => {}; completeSession = () => {};
    let forcedHitId = null;
    pickPart = () => forcedHitId ? { object: { userData: { partId: forcedHitId } }, distance: 1 } : undefined;
    raycaster.intersectObject = () => [];
    scene = new THREE.Scene(); partsRoot = new THREE.Group(); scene.add(partsRoot);
    camera = new THREE.PerspectiveCamera(43, 1280 / 720, .01, 100); scene.add(camera);
    hud = new THREE.Object3D(); scene.add(hud);
    for (const p of PARTS) { const obj = new THREE.Group(); obj.userData.partId = p.id; models.set(p.id, obj); partsRoot.add(obj); }
    const callbacks = new Map();
    const inputControllers = [new THREE.Group(), new THREE.Group()];
    renderer = { xr: { isPresenting: true, getController: i => inputControllers[i], getControllerGrip: () => new THREE.Group(), addEventListener: (name, callback) => callbacks.set(name, callback) } };
    resetModels(); createXRControllers(); state = startSession(createSession('training'), 1000);
    globalThis.api = {
      scene, partsRoot, camera, models, controllers, heldBy, callbacks, renderer, rig, raycaster,
      grab, release, releaseAll, getPose, resetSession, setControllerRay,
      getState: () => state, getSelected: () => selectedId,
      hit: id => { forcedHitId = id; },
      initialPoses,
    };
  `;
  vm.runInContext(source + harness, context, { filename: sourceURL.pathname });
  return context.api;
}

function assertVectorNear(actual, expected, tolerance = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < tolerance, `component ${i}: ${n} vs ${expected[i]}`));
}
function assertRotationNear(actual, expected, tolerance = 1e-10) {
  const a = new THREE.Quaternion(...actual), b = new THREE.Quaternion(...expected);
  assert.ok(1 - Math.abs(a.dot(b)) < tolerance, `${actual} vs ${expected}`);
}
function prepareController(api, index = 0) {
  const c = api.controllers[index]; c.position.set(.2 + index * .2, 1.2, -.3); c.rotation.set(.1, .25, -.05); api.scene.updateMatrixWorld(true); return c;
}
function setHeldToWorldPose(api, id, desiredPosition, desiredQuaternion) {
  const object = api.models.get(id), c = object.parent;
  c.updateWorldMatrix(true, false);
  object.position.copy(c.worldToLocal(new THREE.Vector3(...desiredPosition)));
  object.quaternion.copy(c.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(new THREE.Quaternion(...desiredQuaternion)));
  api.scene.updateMatrixWorld(true);
}

test('controller ray uses world translation and quaternion, including the common rig offset', () => {
  const api = fixture(), c = prepareController(api);
  api.setControllerRay(c);
  assertVectorNear(api.raycaster.ray.origin.toArray(), [.2, 1.2, .85]);
  const expected = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()));
  assertVectorNear(api.raycaster.ray.direction.toArray(), expected.toArray());
  assert.ok(Math.abs(api.raycaster.ray.direction.length() - 1) < 1e-12);
});

test('grab preserves world pose; subsequent controller translation and rotation carry the part', () => {
  const api = fixture(), c = prepareController(api), id = 'left-support';
  const before = api.getPose(id);
  api.hit(id); api.grab(c);
  assert.equal(api.models.get(id).parent, c);
  assert.equal(api.heldBy.get(id), c);
  assertVectorNear(api.getPose(id).position, before.position);
  assertRotationNear(api.getPose(id).quaternion, before.quaternion);
  const object = api.models.get(id); const localMatrix = object.matrix.clone();
  c.position.add(new THREE.Vector3(.13, .22, -.17)); c.rotateY(.3); c.updateWorldMatrix(true, false);
  const expectedMatrix = c.matrixWorld.clone().multiply(localMatrix);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); expectedMatrix.decompose(p, q, s);
  assertVectorNear(api.getPose(id).position, p.toArray());
  assertRotationNear(api.getPose(id).quaternion, q.toArray());
  assert.ok(new THREE.Vector3(...api.getPose(id).position).distanceTo(new THREE.Vector3(...before.position)) > .1);
});

test('a second controller cannot take ownership of the already-held part', () => {
  const api = fixture(), a = prepareController(api, 0), b = prepareController(api, 1);
  api.hit('left-support'); api.grab(a); api.grab(b);
  assert.equal(api.models.get('left-support').parent, a);
  assert.equal(api.heldBy.size, 1);
  assert.equal(b.userData.heldPart, undefined);
});

test('release preserves current world pose and clears all holding references', () => {
  const api = fixture(), c = prepareController(api), id = 'left-support';
  api.hit(id); api.grab(c); c.position.add(new THREE.Vector3(.2, .1, -.1)); c.rotateY(-.25);
  const pose = api.getPose(id); api.release(c, false, false);
  assert.equal(api.models.get(id).parent, api.partsRoot);
  assertVectorNear(api.getPose(id).position, pose.position);
  assertRotationNear(api.getPose(id).quaternion, pose.quaternion);
  assert.equal(api.heldBy.size, 0);
  assert.equal(c.userData.heldPart, undefined);
  assert.equal(c.userData.beforeGrab, undefined);
});

test('release evaluates the real world pose, installs at target, and does not penalize duplicate release', () => {
  const api = fixture(), c = prepareController(api), id = 'left-support', target = domain.PARTS.find(p => p.id === id);
  api.hit(id); api.grab(c);
  setHeldToWorldPose(api, id, target.position, target.quaternion);
  api.release(c, true);
  assert.equal(api.getState().installed.includes(id), true);
  assert.equal(api.getState().attempts.length, 1);
  assert.equal(api.getState().attempts[0].outcome, 'success');
  assert.equal(api.models.get(id).parent, api.partsRoot);
  assertVectorNear(api.getPose(id).position, target.position);
  assertRotationNear(api.getPose(id).quaternion, target.quaternion);
  api.release(c, true);
  assert.equal(api.getState().attempts.length, 1);
});

test('disconnect restores the pre-grab pose without submitting or changing score errors', () => {
  const api = fixture(), c = prepareController(api), id = 'left-support';
  const before = api.getPose(id); api.hit(id); api.grab(c); c.position.add(new THREE.Vector3(1, 1, 1));
  c.dispatchEvent({ type: 'disconnected' });
  assert.equal(api.models.get(id).parent, api.partsRoot);
  assertVectorNear(api.getPose(id).position, before.position);
  assertRotationNear(api.getPose(id).quaternion, before.quaternion);
  assert.equal(api.heldBy.size, 0);
  assert.equal(api.getState().attempts.length, 0);
  assert.equal(Object.values(api.getState().errors).reduce((a, b) => a + b), 0);
});

test('reset while both controllers hold different parts returns an idle, empty, switchable session', () => {
  const api = fixture(), a = prepareController(api, 0), b = prepareController(api, 1);
  api.hit('left-support'); api.grab(a); api.hit('right-support'); api.grab(b);
  a.position.add(new THREE.Vector3(.7, .2, .9)); b.position.add(new THREE.Vector3(-.2, .7, .1));
  api.resetSession('assessment');
  assert.equal(api.getState().mode, 'assessment');
  assert.equal(api.getState().status, 'idle');
  assert.equal(api.getState().startedAt, null);
  assert.equal(api.getState().installed.length, 0);
  assert.equal(api.getState().attempts.length, 0);
  assert.equal(api.heldBy.size, 0);
  assert.equal(api.getSelected(), null);
  for (const [i, part] of domain.PARTS.entries()) {
    assert.equal(api.models.get(part.id).parent, api.partsRoot);
    assertVectorNear(api.getPose(part.id).position, api.initialPoses[i].p);
  }
  for (const c of api.controllers) assert.equal(c.userData.heldPart, undefined);
});

test('session start shares the camera/controller rig; session end restores desktop camera and releases without score changes', () => {
  const api = fixture();
  api.callbacks.get('sessionstart')();
  assert.equal(api.camera.parent, api.rig);
  assert.equal(api.controllers[0].parent, api.rig);
  const c = prepareController(api), id = 'left-support', before = api.getPose(id);
  api.hit(id); api.grab(c); c.position.add(new THREE.Vector3(.9, .3, .6));
  api.renderer.xr.isPresenting = false; api.callbacks.get('sessionend')();
  assert.equal(api.camera.parent, api.scene);
  assert.equal(api.camera.fov, 43);
  assertVectorNear(api.getPose(id).position, before.position);
  assertRotationNear(api.getPose(id).quaternion, before.quaternion);
  assert.equal(api.heldBy.size, 0);
  assert.equal(api.getState().attempts.length, 0);
});
