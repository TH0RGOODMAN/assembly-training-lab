import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS, LIMITS, createSession, startSession, evaluatePlacement, poseError, calculateScore, elapsedSeconds, buildResult, getAvailableParts } from '../domain.mjs';
const pose = p => ({ position: [...p.position], quaternion: [...p.quaternion] });
const start = () => startSession(createSession(), 1_000);
test('idle and installed submissions do not count as learner errors', () => {
  const idle = createSession(), p = PARTS[0]; assert.equal(evaluatePlacement(idle, p.id, pose(p)).state, idle);
  const placed = evaluatePlacement(start(), p.id, pose(p), 2_000).state;
  assert.equal(evaluatePlacement(placed, p.id, pose(p), 3_000).state, placed); assert.equal(placed.attempts.length, 1);
});
test('dependency graph allows same-stage parts in either order and freezes completion time', () => {
  let s = start(); assert.deepEqual(getAvailableParts(s).map(p => p.id), ['left-support', 'right-support']);
  for (const [i, id] of ['right-support', 'left-support', 'shaft', 'right-cap', 'left-cap'].entries()) {
    const result = evaluatePlacement(s, id, pose(PARTS.find(p => p.id === id)), 2_000 + i * 1_000); assert.equal(result.outcome.ok, true); s = result.state;
  }
  assert.equal(s.status, 'completed'); assert.equal(s.completedAt, 6_000); assert.equal(elapsedSeconds(s, 999_000), 5); assert.equal(calculateScore(s, 999_000).score, 100);
  assert.equal(buildResult(s).scoreIsFinal, true); assert.equal(s.attempts.length, 5);
});
test('sequence precedes position and orientation and counts one error per submission', () => {
  const s = start(), p = PARTS[2]; const r = evaluatePlacement(s, p.id, { position: [10, 10, 10], quaternion: [0, 1, 0, 0] }, 2_000);
  assert.equal(r.outcome.reason, 'sequence'); assert.deepEqual(r.state.errors, { sequence: 1, position: 0, orientation: 0 }); assert.equal(calculateScore(r.state, 2_000).score, 92); assert.equal(s.attempts.length, 0);
});
test('position at boundary is accepted, beyond boundary rejected', () => {
  const p = PARTS[0]; const at = pose(p); at.position[0] += LIMITS.position;
  assert.equal(evaluatePlacement(start(), p.id, at, 2_000).outcome.ok, true);
  at.position[0] += .0001; assert.equal(evaluatePlacement(start(), p.id, at, 2_000).outcome.reason, 'position');
});
test('orientation sign invariance, normalization and boundary behavior', () => {
  const p = PARTS[0]; assert.equal(poseError(p, { position: [...p.position], quaternion: [0, 0, 0, -3] }).angle, 0);
  const rotated = degrees => ({ position: [...p.position], quaternion: [0, Math.sin(degrees * Math.PI / 360), 0, Math.cos(degrees * Math.PI / 360)] });
  assert.equal(evaluatePlacement(start(), p.id, rotated(12), 2_000).outcome.ok, true);
  assert.equal(evaluatePlacement(start(), p.id, rotated(12.01), 2_000).outcome.reason, 'orientation');
});
test('malformed poses are rejected without changing state', () => {
  const s = start(), p = PARTS[0];
  for (const value of [null, {}, { position: [NaN, 0, 0], quaternion: [0, 0, 0, 1] }, { position: [...p.position], quaternion: [0, 0, 0, 0] }]) assert.equal(evaluatePlacement(s, p.id, value, 2_000).state, s);
});
test('score time boundary, deduction cap, floor, and unfinished result marking', () => {
  const s = start(); assert.equal(calculateScore(s, 210_999).timePenalty, 0); assert.equal(calculateScore(s, 211_000).timePenalty, 2); assert.equal(calculateScore(s, 999_000).timePenalty, 20);
  s.errors.sequence = 30; assert.equal(calculateScore(s, 999_000).score, 0); assert.equal(buildResult(s, 3_000).scoreIsFinal, false);
});
test('exports are detached snapshots and a fresh session has no old record', () => {
  const s = evaluatePlacement(start(), PARTS[0].id, pose(PARTS[0]), 2_000).state, output = buildResult(s, 3_000);
  output.errors.sequence = 4; output.installed.push('shaft'); output.attempts[0].outcome = 'edited';
  assert.equal(s.errors.sequence, 0); assert.equal(s.installed.length, 1); assert.equal(s.attempts[0].outcome, 'success');
  const fresh = createSession('assessment'); assert.equal(fresh.startedAt, null); assert.equal(fresh.installed.length, 0); assert.equal(fresh.attempts.length, 0);
});
