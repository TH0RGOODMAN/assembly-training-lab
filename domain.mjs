/** Pure domain rules. Distances are metres, angles degrees, times Unix milliseconds. */
export const LIMITS = Object.freeze({ position: 0.055, angle: 12, targetSeconds: 180 });
export const PARTS = Object.freeze([
  { id: 'left-support', name: '左支架', short: '支架 L', stage: 1, position: [-0.36, 0.86, -0.21], quaternion: [0, 0, 0, 1], prerequisites: [] },
  { id: 'right-support', name: '右支架', short: '支架 R', stage: 1, position: [0.36, 0.86, -0.21], quaternion: [0, 0, 0, 1], prerequisites: [] },
  { id: 'shaft', name: '转轴', short: '转轴', stage: 2, position: [0, 1.16, -0.21], quaternion: [0, 0, 0, 1], prerequisites: ['left-support', 'right-support'] },
  { id: 'left-cap', name: '左锁紧盖', short: '锁紧盖 L', stage: 3, position: [-0.52, 1.16, -0.21], quaternion: [0, 0, 0, 1], prerequisites: ['shaft'] },
  { id: 'right-cap', name: '右锁紧盖', short: '锁紧盖 R', stage: 3, position: [0.52, 1.16, -0.21], quaternion: [0, 0, 0, 1], prerequisites: ['shaft'] },
].map(p => Object.freeze({ ...p, position: Object.freeze(p.position), quaternion: Object.freeze(p.quaternion), prerequisites: Object.freeze(p.prerequisites) })));

export function createSession(mode = 'training') {
  if (!['training', 'assessment'].includes(mode)) throw new TypeError('Unknown mode');
  return { mode, status: 'idle', startedAt: null, completedAt: null, installed: [], attempts: [], errors: { sequence: 0, position: 0, orientation: 0 } };
}
export function startSession(state, now = Date.now()) {
  if (state.status !== 'idle') return state;
  if (!Number.isFinite(now)) throw new TypeError('Invalid time');
  return { ...state, status: 'running', startedAt: now };
}
export function elapsedSeconds(state, now = Date.now()) {
  if (state.startedAt === null) return 0;
  return Math.max(0, ((state.completedAt ?? now) - state.startedAt) / 1000);
}
export function poseError(part, pose) {
  if (!pose || !Array.isArray(pose.position) || pose.position.length !== 3 || !Array.isArray(pose.quaternion) || pose.quaternion.length !== 4 || ![...pose.position, ...pose.quaternion].every(Number.isFinite)) return { position: Infinity, angle: Infinity, valid: false };
  const norm = Math.hypot(...pose.quaternion);
  if (norm < 1e-12) return { position: Infinity, angle: Infinity, valid: false };
  const position = Math.hypot(...part.position.map((v, i) => v - pose.position[i]));
  const dot = part.quaternion.reduce((s, q, i) => s + q * pose.quaternion[i] / norm, 0);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
  return { position, angle, valid: true };
}
export function getAvailableParts(state) {
  return PARTS.filter(p => !state.installed.includes(p.id) && p.prerequisites.every(id => state.installed.includes(id)));
}
export function evaluatePlacement(state, id, pose, now = Date.now()) {
  const part = PARTS.find(p => p.id === id);
  if (!part) return { state, outcome: { ok: false, reason: 'unknown' } };
  if (state.status !== 'running') return { state, outcome: { ok: false, reason: 'inactive' } };
  if (state.installed.includes(id)) return { state, outcome: { ok: false, reason: 'installed' } };
  const error = poseError(part, pose);
  // An invalid programmatic input is not a learner mistake and never changes a score.
  if (!error.valid || !Number.isFinite(now)) return { state, outcome: { ok: false, reason: 'invalid' } };
  const reason = !part.prerequisites.every(p => state.installed.includes(p)) ? 'sequence' : error.position > LIMITS.position + 1e-10 ? 'position' : error.angle > LIMITS.angle + 1e-9 ? 'orientation' : 'success';
  const ok = reason === 'success';
  const installed = ok ? [...state.installed, id] : [...state.installed];
  const errors = { ...state.errors };
  if (!ok) errors[reason]++;
  const attempt = { partId: id, at: new Date(now).toISOString(), elapsedSeconds: Number(elapsedSeconds(state, now).toFixed(3)), outcome: reason, positionErrorM: Number(error.position.toFixed(6)), angleErrorDeg: Number(error.angle.toFixed(4)) };
  const next = { ...state, installed, errors, attempts: [...state.attempts, attempt], status: installed.length === PARTS.length ? 'completed' : 'running', completedAt: installed.length === PARTS.length ? now : null };
  return { state: next, outcome: { ok, reason, ...error } };
}
export function calculateScore(state, now = Date.now()) {
  const seconds = elapsedSeconds(state, now);
  const timePenalty = Math.min(20, Math.floor(Math.max(0, seconds - LIMITS.targetSeconds) / 30) * 2);
  const errorPenalty = 8 * state.errors.sequence + 3 * state.errors.position + 3 * state.errors.orientation;
  return { score: Math.max(0, 100 - errorPenalty - timePenalty), errorPenalty, timePenalty, seconds };
}
export function buildResult(state, now = Date.now()) {
  const score = calculateScore(state, now);
  return {
    schemaVersion: '1.0', application: 'VR机械装配训练系统', mode: state.mode,
    status: state.status, startedAt: state.startedAt === null ? null : new Date(state.startedAt).toISOString(),
    completedAt: state.completedAt === null ? null : new Date(state.completedAt).toISOString(),
    exportedAt: new Date(now).toISOString(), elapsedSeconds: Number(score.seconds.toFixed(3)),
    completedParts: state.installed.length, totalParts: PARTS.length,
    score: score.score, scoreIsFinal: state.status === 'completed',
    deductions: { errors: score.errorPenalty, time: score.timePenalty },
    errors: { ...state.errors }, thresholds: { positionM: LIMITS.position, angleDeg: LIMITS.angle, targetSeconds: LIMITS.targetSeconds },
    installed: [...state.installed], attempts: state.attempts.map(a => ({ ...a })),
    notice: '课程原型；吸附和评分为教学规则，不代表工程公差、物理接触或真实操作能力认证。',
  };
}
