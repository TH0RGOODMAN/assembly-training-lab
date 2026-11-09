import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS, LIMITS, createSession, startSession, elapsedSeconds, poseError, getAvailableParts, evaluatePlacement, calculateScore, buildResult } from '../domain.mjs';

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const part = id => PARTS.find(p => p.id === id);
const pose = id => ({ position: [...part(id).position], quaternion: [...part(id).quaternion] });
const begin = mode => startSession(createSession(mode), T0);
const submit = (state, id, time = T0 + 1000, transform = pose(id)) => evaluatePlacement(state, id, transform, time);
function finish(mode = 'training', reverseStage1 = false, reverseStage3 = false) {
  const order = [ ...(reverseStage1 ? ['right-support', 'left-support'] : ['left-support', 'right-support']), 'shaft', ...(reverseStage3 ? ['right-cap', 'left-cap'] : ['left-cap', 'right-cap']) ];
  let state = begin(mode);
  order.forEach((id, i) => {
    const result = submit(state, id, T0 + (i + 1) * 1000);
    assert.equal(result.outcome.ok, true, `${mode}: ${id} should be accepted`);
    state = result.state;
  });
  return state;
}

test('workflow: both same-stage orders finish in either training or assessment', () => {
  for (const mode of ['training', 'assessment']) for (const a of [true, false]) for (const b of [true, false]) {
    const result = finish(mode, a, b);
    assert.equal(result.status, 'completed');
    assert.equal(result.installed.length, 5);
    assert.equal(new Set(result.installed).size, 5);
    assert.equal(result.attempts.length, 5);
    assert.equal(calculateScore(result, T0 + 24 * 3600_000).score, 100);
  }
});

test('dependencies: shaft requires both supports, caps require shaft, rejected attempt never installs', () => {
  let state = begin('training');
  assert.deepEqual(getAvailableParts(state).map(p => p.id).sort(), ['left-support', 'right-support']);
  for (const id of ['shaft', 'left-cap', 'right-cap']) {
    const rejected = submit(state, id);
    assert.equal(rejected.outcome.reason, 'sequence');
    assert.deepEqual(rejected.state.installed, []);
  }
  state = submit(state, 'left-support').state;
  assert.equal(submit(state, 'shaft').outcome.reason, 'sequence');
  state = submit(state, 'right-support').state;
  assert.deepEqual(getAvailableParts(state).map(p => p.id), ['shaft']);
  state = submit(state, 'shaft').state;
  assert.deepEqual(getAvailableParts(state).map(p => p.id).sort(), ['left-cap', 'right-cap']);
});

test('distance: Euclidean metric includes all axes and its tolerance boundary is inclusive', () => {
  const id = 'left-support', base = pose(id);
  const shift = d => ({ ...base, position: base.position.map(v => v + d / Math.sqrt(3)) });
  assert.ok(Math.abs(poseError(part(id), shift(LIMITS.position)).position - LIMITS.position) < 1e-12);
  assert.equal(submit(begin('training'), id, T0 + 1000, shift(LIMITS.position)).outcome.ok, true);
  assert.equal(submit(begin('training'), id, T0 + 1000, shift(LIMITS.position + 1e-6)).outcome.reason, 'position');
});

test('orientation: q, -q and normalized/scaled representations give the same angle', () => {
  const id = 'left-support', base = pose(id);
  const radians = 37 * Math.PI / 180;
  const q = [Math.sin(radians / 2), 0, 0, Math.cos(radians / 2)];
  for (const multiplier of [1, -1, 7, -0.2]) {
    const error = poseError(part(id), { ...base, quaternion: q.map(v => v * multiplier) });
    assert.ok(Math.abs(error.angle - 37) < 1e-10);
  }
  assert.equal(poseError(part(id), { ...base, quaternion: [0, 1, 0, 0] }).angle, 180);
});

test('orientation: 12 degrees around each axis is accepted; slight excess is rejected', () => {
  const id = 'left-support';
  for (let axis = 0; axis < 3; axis++) for (const deg of [12, -12, 12.001, -12.001]) {
    const radians = deg * Math.PI / 180;
    const q = [0, 0, 0, Math.cos(radians / 2)];
    q[axis] = Math.sin(radians / 2);
    const outcome = submit(begin('training'), id, T0 + 1000, { ...pose(id), quaternion: q }).outcome;
    assert.equal(outcome.ok, Math.abs(deg) === 12);
    if (Math.abs(deg) > 12) assert.equal(outcome.reason, 'orientation');
  }
});

test('two geometric conditions: perfect position cannot bypass orientation and vice versa', () => {
  const id = 'left-support';
  assert.equal(submit(begin('training'), id, T0 + 1000, { ...pose(id), quaternion: [0, 1, 0, 0] }).outcome.reason, 'orientation');
  assert.equal(submit(begin('training'), id, T0 + 1000, { ...pose(id), position: [20, 20, 20] }).outcome.reason, 'position');
});

test('invalid, duplicate and inactive requests are not learner errors and do not mutate state', () => {
  const id = 'left-support';
  for (const badPose of [null, {}, { position: [0, 0], quaternion: [0, 0, 0, 1] }, { ...pose(id), position: [NaN, 0, 0] }, { ...pose(id), quaternion: [0, 0, 0, 0] }]) {
    const state = begin('training'), before = structuredClone(state);
    assert.equal(submit(state, id, T0 + 1000, badPose).outcome.reason, 'invalid');
    assert.deepEqual(state, before);
    assert.equal(calculateScore(state).errorPenalty, 0);
  }
  const idle = createSession('training');
  assert.equal(submit(idle, id).outcome.reason, 'inactive');
  const installed = submit(begin('training'), id).state;
  const duplicate = submit(installed, id);
  assert.equal(duplicate.outcome.reason, 'installed');
  assert.deepEqual(duplicate.state, installed);
  const done = finish();
  assert.equal(submit(done, id).outcome.reason, 'inactive');
  assert.deepEqual(submit(done, id).state, done);
});

test('failure accounting: one highest-priority error per rejected submission; immutable input', () => {
  const initial = begin('assessment'), snapshot = structuredClone(initial);
  const seq = submit(initial, 'shaft', T0 + 1000, { position: [100, 100, 100], quaternion: [0, 1, 0, 0] });
  assert.deepEqual(initial, snapshot);
  assert.deepEqual(seq.state.errors, { sequence: 1, position: 0, orientation: 0 });
  const pos = submit(seq.state, 'left-support', T0 + 2000, { position: [100, 100, 100], quaternion: [0, 1, 0, 0] });
  const rot = submit(pos.state, 'left-support', T0 + 3000, { ...pose('left-support'), quaternion: [0, 1, 0, 0] });
  assert.deepEqual(rot.state.errors, { sequence: 1, position: 1, orientation: 1 });
  assert.equal(rot.state.attempts.length, 3);
  assert.equal(calculateScore(rot.state, T0 + 3000).score, 86);
});

test('time deductions: target + full intervals, 20-point cap, and final elapsed time freeze', () => {
  const state = begin('assessment');
  for (const [seconds, expected] of [[0, 0], [180, 0], [209.999, 0], [210, 2], [240, 4], [479.999, 18], [480, 20], [5000, 20]]) {
    assert.equal(calculateScore(state, T0 + seconds * 1000).timePenalty, expected, `${seconds} seconds`);
  }
  const completed = finish('assessment');
  assert.equal(elapsedSeconds(completed, T0 + 1000_000), 5);
  assert.equal(calculateScore(completed, T0 + 1000_000).timePenalty, 0);
});

test('score clamps to zero and a reset creates separate, empty session state', () => {
  let state = begin('training');
  for (let i = 1; i <= 20; i++) state = submit(state, 'shaft', T0 + i * 1000).state;
  assert.equal(calculateScore(state, T0 + 1000_000).score, 0);
  const reset = createSession('assessment');
  assert.equal(reset.status, 'idle');
  assert.deepEqual(reset.installed, []);
  assert.deepEqual(reset.attempts, []);
  assert.deepEqual(reset.errors, { sequence: 0, position: 0, orientation: 0 });
  assert.equal(state.attempts.length, 20);
});

test('export distinguishes incomplete progress from final score and preserves observed attempts', () => {
  const incomplete = submit(begin('assessment'), 'left-support', T0 + 3000).state;
  const exported = buildResult(incomplete, T0 + 7000);
  assert.equal(exported.mode, 'assessment');
  assert.equal(exported.status, 'running');
  assert.equal(exported.scoreIsFinal, false);
  assert.equal(exported.completedAt, null);
  assert.equal(exported.completedParts, 1);
  assert.equal(exported.elapsedSeconds, 7);
  assert.equal(exported.attempts[0].elapsedSeconds, 3);
  const roundTrip = JSON.parse(JSON.stringify(buildResult(finish(), T0 + 8000)));
  assert.equal(roundTrip.scoreIsFinal, true);
  assert.equal(roundTrip.elapsedSeconds, 5);
  assert.equal(roundTrip.attempts.length, 5);
  assert.equal(roundTrip.startedAt, '2026-10-12T12:00:00.000Z');
  assert.equal(roundTrip.completedAt, '2026-10-12T12:00:05.000Z');
  assert.equal(roundTrip.exportedAt, '2026-10-12T12:00:08.000Z');
  assert.match(roundTrip.notice, /教学规则/);
});

test('export is detached: later consumer edits cannot alter training state or frozen configuration', () => {
  const state = finish(), before = structuredClone(state);
  const result = buildResult(state, T0 + 10_000);
  result.installed.pop();
  result.errors.sequence = 100;
  result.attempts[0].outcome = 'tampered';
  result.thresholds.positionM = 999;
  assert.deepEqual(state, before);
  assert.equal(LIMITS.position, 0.055);
  assert.equal(PARTS[0].position[0], -0.36);
});
