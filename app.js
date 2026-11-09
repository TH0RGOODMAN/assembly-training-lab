import * as THREE from 'three';
import { PARTS, LIMITS, createSession, startSession, evaluatePlacement, poseError, calculateScore, elapsedSeconds, buildResult, getAvailableParts } from './domain.mjs';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const HISTORY_KEY = 'vr-assembly-lab.results.v1';
let state = createSession('training');
let selectedId = null, previewing = false, dragging = false, orbiting = false, pointerOrigin = null;
let scene, camera, renderer, partsRoot, previewRoot, ghostRoot, hud, hudCanvas, hudContext, hudTexture, rig;
let lastHUD = 0, lastUI = 0, lastSavedResult = null, hoverId = null;
const models = new Map(), ghosts = new Map(), controllers = [], heldBy = new Map();
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), dragPlane = new THREE.Plane(), dragOffset = new THREE.Vector3();
const worldPosition = new THREE.Vector3(), worldQuaternion = new THREE.Quaternion();
const cameraTarget = new THREE.Vector3(0, 0.98, 0.04);
let orbit = { theta: 0.15, phi: 0.93, radius: 3.28 };
const initialPoses = [
  { p: [-1.03, 0.86, 0.53], a: 30 }, { p: [-0.54, 0.86, 0.53], a: -30 },
  { p: [0.25, 1.16, 0.63], a: 30 }, { p: [0.83, 1.16, 0.32], a: -45 }, { p: [1.12, 1.16, 0.57], a: 45 },
];
const errorText = {
  sequence: ['装配顺序需要调整', '请先装好两个支架，再放入转轴，最后安装锁紧盖。'],
  position: ['位置还需要对齐', '将零件移近目标轮廓；可以用方向键按钮微调，然后再次确认。'],
  orientation: ['姿态还需要调整', '位置已对齐，请旋转零件，使绿色标识与目标朝向一致。'],
  inactive: ['请先开始实验', '选择训练或考核模式，再点击“开始实验”。'],
};

function setFeedback(title, detail, kind = '') {
  const box = $('feedback');
  box.className = `feedback ${kind}`;
  box.replaceChildren();
  const strong = document.createElement('strong'), span = document.createElement('span');
  strong.textContent = title; span.textContent = detail; box.append(strong, span);
}
function fmtTime(seconds) {
  const whole = Math.floor(seconds); return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
function material(color, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.3, ...extra }); }
function mesh(geometry, mat, parent, position = [0, 0, 0]) {
  const item = new THREE.Mesh(geometry, mat); item.position.set(...position); item.castShadow = true; item.receiveShadow = true; parent.add(item); return item;
}
function box(parent, size, position, mat) { return mesh(new THREE.BoxGeometry(...size), mat, parent, position); }
function cylinderX(parent, radius, length, position, mat, segments = 40) {
  const m = mesh(new THREE.CylinderGeometry(radius, radius, length, segments), mat, parent, position); m.rotation.z = Math.PI / 2; return m;
}
function labelTexture(text, color = '#badbd8', background = null, width = 512, height = 128) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d'); if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
  ctx.fillStyle = color; ctx.font = `600 ${height * .38}px "Microsoft YaHei", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
function flatLabel(parent, text, position, width = .34, color) {
  const m = mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({ map: labelTexture(text, color), transparent: true, depthWrite: false }), parent, position);
  m.rotation.x = -Math.PI / 2; m.castShadow = false; return m;
}
function makePart(part) {
  const group = new THREE.Group(); group.userData.partId = part.id;
  const steel = material(0x97b2be, { metalness: .7, roughness: .25 });
  const dark = material(0x314d5a, { metalness: .65, roughness: .32 });
  const teal = material(0x1f9a85, { metalness: .4, roughness: .32 });
  const orange = material(0xeab474, { metalness: .45, roughness: .35 });
  if (part.id.includes('support')) {
    box(group, [.22, .055, .27], [0, .0275, 0], dark);
    const shape = new THREE.Shape();
    shape.moveTo(-.106, .055); shape.lineTo(.106, .055); shape.lineTo(.106, .345); shape.quadraticCurveTo(.106, .415, .036, .415); shape.lineTo(-.036, .415); shape.quadraticCurveTo(-.106, .415, -.106, .345); shape.closePath();
    const hole = new THREE.Path(); hole.absarc(0, .30, .061, 0, Math.PI * 2, true); shape.holes.push(hole);
    const upright = mesh(new THREE.ExtrudeGeometry(shape, { depth: .047, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .004, bevelThickness: .004, curveSegments: 32 }), steel, group, [-.0235, 0, 0]); upright.rotation.y = Math.PI / 2;
    for (const sx of [-.075, .075]) for (const sz of [-.092, .092]) mesh(new THREE.CylinderGeometry(.012, .012, .009, 6), dark, group, [sx, .059, sz]);
    // A visible direction marker makes the otherwise partly symmetric orientation task explicit.
    box(group, [.052, .008, .07], [0, .423, -.008], teal);
    flatLabel(group, part.id.startsWith('left') ? 'L ↑' : 'R ↑', [0, .064, .064], .17, '#90dbbf');
  } else if (part.id === 'shaft') {
    cylinderX(group, .042, .98, [0, 0, 0], steel);
    cylinderX(group, .057, .07, [-.18, 0, 0], dark);
    cylinderX(group, .057, .07, [.18, 0, 0], dark);
    cylinderX(group, .052, .027, [0, 0, 0], teal);
    box(group, [.27, .009, .013], [0, .044, 0], teal);
  } else {
    cylinderX(group, .072, .046, [0, 0, 0], orange, 6);
    cylinderX(group, .05, .016, [part.id.startsWith('left') ? -.03 : .03, 0, 0], dark);
    cylinderX(group, .019, .063, [0, 0, 0], steel, 24);
    box(group, [.038, .006, .02], [0, .067, 0], teal);
  }
  group.traverse(o => { if (o.isMesh) o.userData.partId = part.id; });
  return group;
}
function createStage() {
  const floor = material(0x142732, { roughness: 1, metalness: 0 });
  mesh(new THREE.PlaneGeometry(200, 200), floor, scene).rotation.x = -Math.PI / 2;
  const table = new THREE.Group(); scene.add(table);
  const board = material(0x28444c, { roughness: .86, metalness: .12 });
  box(table, [2.82, .075, 1.75], [0, .816, .06], board);
  box(table, [2.75, .009, 1.68], [0, .858, .06], material(0x3c5960, { roughness: .86, metalness: .1 }));
  const legMat = material(0x1a303d);
  for (const x of [-1.13, 1.13]) for (const z of [-.56, .63]) box(table, [.075, .77, .075], [x, .4, z], legMat);
  box(table, [2.36, .08, .07], [0, .16, -.56], legMat);
  box(table, [2.36, .05, .035], [0, .67, .82], material(0x3c7b79));
  // The installation base is part of the environment and is not one of the five assessed pieces.
  box(table, [1.47, .023, .59], [0, .847, -.21], material(0x557878));
  for (const x of [-.66, .66]) for (const z of [-.45, .03]) mesh(new THREE.CylinderGeometry(.017, .017, .005, 6), legMat, table, [x, .863, z]);
  for (const p of PARTS.slice(0, 2)) {
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(.24, .001, .29)), new THREE.LineBasicMaterial({ color: 0x9ed5bb, transparent: true, opacity: .7 }));
    edge.position.set(p.position[0], .864, p.position[2]); table.add(edge);
    flatLabel(table, p.id.startsWith('left') ? 'L' : 'R', [p.position[0], .865, -.425], .13, '#c7ece2');
  }
  flatLabel(table, '安装区  /  ASSEMBLY', [0, .866, -.58], .70, '#a4c5c7');
  flatLabel(table, '零件准备区', [-.96, .866, .78], .39, '#8baeb5');
  for (let i = 0; i < PARTS.length; i++) {
    const pose = initialPoses[i];
    if (i < 2) box(table, [.30, .008, .38], [pose.p[0], .865, pose.p[2]], material(0x2f4d56));
    else if (i === 2) {
      for (const x of [-.07, .56]) { box(table, [.08, .21, .12], [x, .974, .63], legMat); box(table, [.09, .035, .11], [x, 1.089, .63], material(0x507778)); }
    } else {
      box(table, [.13, .23, .14], [pose.p[0], .975, pose.p[2]], legMat);
      box(table, [.13, .018, .14], [pose.p[0], 1.098, pose.p[2]], material(0x507778));
    }
  }
  const grid = new THREE.GridHelper(20, 40, 0x264a56, 0x203b47); grid.position.y = .002; scene.add(grid);
}
function createParts() {
  partsRoot = new THREE.Group(); ghostRoot = new THREE.Group(); previewRoot = new THREE.Group(); scene.add(partsRoot, ghostRoot, previewRoot); previewRoot.visible = false;
  for (const part of PARTS) {
    const model = makePart(part); models.set(part.id, model); partsRoot.add(model);
    const ghost = makePart(part); ghost.position.set(...part.position); ghost.quaternion.set(...part.quaternion);
    ghost.traverse(o => { if (o.isMesh) { o.material = new THREE.MeshBasicMaterial({ color: 0x79e4b3, transparent: true, opacity: .19, depthWrite: false }); o.castShadow = false; o.receiveShadow = false; } });
    ghosts.set(part.id, ghost); ghostRoot.add(ghost);
    const example = makePart(part); example.position.set(...part.position); example.quaternion.set(...part.quaternion); previewRoot.add(example);
  }
  resetModels();
}
function resetModels() {
  releaseAll();
  PARTS.forEach((part, i) => { const obj = models.get(part.id); obj.position.set(...initialPoses[i].p); obj.rotation.set(0, THREE.MathUtils.degToRad(initialPoses[i].a), 0); obj.scale.setScalar(1); });
  selectedId = null; dragging = false; hoverId = null; updateGhosts();
}
function updateCamera() {
  const aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  const radius = orbit.radius * Math.max(1, 1.3 / aspect);
  camera.position.set(cameraTarget.x + radius * Math.sin(orbit.phi) * Math.sin(orbit.theta), cameraTarget.y + radius * Math.cos(orbit.phi), cameraTarget.z + radius * Math.sin(orbit.phi) * Math.cos(orbit.theta));
  camera.lookAt(cameraTarget);
}
function setCamera(view) {
  if (renderer?.xr.isPresenting) return;
  orbit = view === 'top' ? { theta: 0, phi: .065, radius: 3.14 } : view === 'front' ? { theta: 0, phi: 1.26, radius: 3.13 } : { theta: .15, phi: .93, radius: 3.28 };
  updateCamera(); document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
function updateGhosts() {
  if (!ghostRoot) return;
  ghostRoot.visible = state.mode === 'training' && !previewing && state.status !== 'completed';
  for (const part of PARTS) ghosts.get(part.id).visible = !state.installed.includes(part.id) && (selectedId ? part.id === selectedId : true);
  if (partsRoot) partsRoot.visible = !previewing;
  if (previewRoot) previewRoot.visible = previewing;
}
function selectPart(id) {
  if (previewing || state.installed.includes(id)) return;
  selectedId = id; updateGhosts(); updateUI(true);
}
function getPose(id) {
  const obj = models.get(id); obj.updateWorldMatrix(true, false); obj.getWorldPosition(worldPosition); obj.getWorldQuaternion(worldQuaternion);
  return { position: worldPosition.toArray(), quaternion: worldQuaternion.toArray() };
}
function updateUI(force = false) {
  const now = Date.now(); if (!force && now - lastUI < 100) return; lastUI = now;
  $('timer').textContent = fmtTime(elapsedSeconds(state, now));
  const result = calculateScore(state, now);
  $('score').replaceChildren(document.createTextNode(result.score)); const small = document.createElement('small'); small.textContent = ' / 100'; $('score').append(small);
  $('scoreLabel').textContent = state.status === 'completed' ? '最终分数' : '当前分数';
  $('progressCount').textContent = `${state.installed.length} / 5`; $('progressFill').style.width = `${state.installed.length * 20}%`;
  const currentStage = PARTS.find(p => !state.installed.includes(p.id))?.stage;
  document.querySelectorAll('[data-stage]').forEach(step => {
    const stageParts = PARTS.filter(p => p.stage === Number(step.dataset.stage));
    const count = stageParts.filter(p => state.installed.includes(p.id)).length;
    step.classList.toggle('complete', count === stageParts.length);
    step.classList.toggle('current', Number(step.dataset.stage) === currentStage);
    step.querySelector('small').textContent = `${count} / ${stageParts.length}`;
    if (Number(step.dataset.stage) === currentStage) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  for (const type of ['sequence', 'position', 'orientation']) $(`${type}Errors`).textContent = state.errors[type];
  $('trainingMode').classList.toggle('active', state.mode === 'training'); $('assessmentMode').classList.toggle('active', state.mode === 'assessment');
  $('trainingMode').disabled = state.status === 'running'; $('assessmentMode').disabled = state.status === 'running';
  $('modeDescription').textContent = state.mode === 'training' ? '显示目标轮廓与对齐提示，逐步掌握装配方法。' : '隐藏目标轮廓与实时偏差，独立完成装配并记录成绩。';
  $('startBtn').disabled = state.status === 'running'; $('startBtn').innerHTML = state.status === 'running' ? '实验进行中 <span>●</span>' : state.status === 'completed' ? '再练习一次 <span>→</span>' : '开始实验 <span>→</span>';
  const canEdit = state.status === 'running' && selectedId && !state.installed.includes(selectedId) && !heldBy.has(selectedId) && !previewing && !renderer?.xr.isPresenting;
  $('placeBtn').disabled = !canEdit;
  document.querySelectorAll('[data-nudge],[data-rotate],#rotationAxis').forEach(b => b.disabled = !canEdit);
  $('previewBtn').disabled = state.mode === 'assessment' && state.status === 'running';
  $('previewBtn').textContent = previewing ? '返回操作' : '成品示意'; $('previewBtn').classList.toggle('active', previewing);
  const part = PARTS.find(p => p.id === selectedId);
  $('alignmentChecks').hidden = !(state.status === 'running' && state.mode === 'training' && part && !state.installed.includes(selectedId) && !previewing);
  if (!$('alignmentChecks').hidden) {
    const error = poseError(part, getPose(selectedId));
    const sequenceReady = part.prerequisites.every(id => state.installed.includes(id));
    for (const [id, ready, label] of [['sequenceCheck', sequenceReady, '工序'], ['positionCheck', error.position <= LIMITS.position + 1e-10, '位置'], ['orientationCheck', error.angle <= LIMITS.angle + 1e-9, '朝向']]) {
      $(id).textContent = `${ready ? '✓' : '○'} ${label}${ready ? '符合' : '待调整'}`;
      $(id).classList.toggle('ready', ready);
    }
  }
  $('selectedName').textContent = previewing ? '成品示意（不计成绩）' : part ? part.name : state.status === 'completed' ? '全部装配完成' : '尚未选择';
  if (previewing) $('poseInfo').textContent = '观察组件结构后，点击“返回操作”继续';
  else if (part && models.has(selectedId) && state.mode === 'training' && !state.installed.includes(selectedId)) {
    const pose = getPose(selectedId), error = poseError(part, pose);
    const dy = (part.position[1] - pose.position[1]) * 1000;
    $('poseInfo').textContent = `距离 ${Math.round(error.position * 1000)} mm · 姿态 ${Math.round(error.angle)}° · 高度${Math.abs(dy) < 1 ? '已对齐' : `${dy > 0 ? '需升' : '需降'} ${Math.round(Math.abs(dy))} mm`}`;
  } else $('poseInfo').textContent = state.status === 'completed' ? '可以环视观察组件，或导出本次记录' : state.mode === 'assessment' ? '考核模式：根据安装区和零件方向独立对齐' : '开始实验后，点击零件或右侧列表';
  const available = getAvailableParts(state).map(p => p.id);
  for (const part of PARTS) {
    const card = $(`part-${part.id}`), done = state.installed.includes(part.id);
    if (!card) continue;
    card.classList.toggle('selected', selectedId === part.id && !done); card.classList.toggle('done', done); card.disabled = done || previewing;
    card.querySelector('.part-icon').textContent = done ? '✓' : part.id.includes('support') ? 'Π' : part.id === 'shaft' ? '━' : '⬡';
    card.querySelector('.part-state').textContent = done ? '已完成' : selectedId === part.id ? '已选择' : available.includes(part.id) ? '可装配' : '待前置';
  }
}
function buildPartList() {
  for (const [i, part] of PARTS.entries()) {
    const button = document.createElement('button'); button.id = `part-${part.id}`; button.className = 'part-card';
    const icon = document.createElement('span'); icon.className = 'part-icon';
    const copy = document.createElement('span'); copy.className = 'part-copy';
    const title = document.createElement('strong'); title.textContent = `${String(i + 1).padStart(2, '0')}  ${part.name}`;
    const sub = document.createElement('small'); sub.textContent = part.stage === 1 ? '阶段一 · 固定支撑结构' : part.stage === 2 ? '阶段二 · 穿入中心转轴' : '阶段三 · 固定轴端'; copy.append(title, sub);
    const status = document.createElement('span'); status.className = 'part-state'; button.append(icon, copy, status); button.addEventListener('click', () => selectPart(part.id)); $('partsList').append(button);
  }
}
function canMove() { return state.status === 'running' && selectedId && !state.installed.includes(selectedId) && !heldBy.has(selectedId) && !previewing && !renderer.xr.isPresenting; }
function nudge(axis, sign, fast = false) {
  if (!canMove()) return;
  const obj = models.get(selectedId); obj.position[axis] += sign * (fast ? .05 : .01); clampPart(obj); updateUI(true);
}
function clampPart(obj) { obj.position.x = THREE.MathUtils.clamp(obj.position.x, -1.46, 1.46); obj.position.z = THREE.MathUtils.clamp(obj.position.z, -.76, 1.06); obj.position.y = THREE.MathUtils.clamp(obj.position.y, .86, 1.72); }
function rotatePart(sign) {
  if (!canMove()) return;
  const axis = $('rotationAxis').value, v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  models.get(selectedId).rotateOnWorldAxis(v, sign * Math.PI / 12); updateUI(true);
}
function attemptPlacement(id = selectedId) {
  if (!id || previewing || heldBy.has(id)) return;
  const result = evaluatePlacement(state, id, getPose(id)); state = result.state;
  if (result.outcome.ok) {
    const part = PARTS.find(p => p.id === id), obj = models.get(id); partsRoot.attach(obj); obj.position.set(...part.position); obj.quaternion.set(...part.quaternion);
    const nextParts = getAvailableParts(state).map(p => p.name).join('或');
    setFeedback(`${part.name}装配成功`, state.status === 'completed' ? '全部五个零件已安装，可以查看得分与导出操作记录。' : `已固定到安装位置。接下来安装${nextParts}。`, 'success');
    selectedId = null;
    if (state.status === 'completed') completeSession();
  } else if (errorText[result.outcome.reason]) {
    const [title, standardDetail] = errorText[result.outcome.reason];
    const pending = PARTS.find(p => p.id === id)?.prerequisites.filter(dep => !state.installed.includes(dep)).map(dep => PARTS.find(p => p.id === dep).name).join('和');
    const detail = result.outcome.reason === 'sequence' ? `先安装${pending}，再回来安装这个零件。` : state.mode === 'assessment' && result.outcome.reason === 'position' ? '将零件移近对应安装位置；可以用方向键按钮微调，然后再次确认。' : standardDetail;
    const hint = state.mode === 'training' && result.outcome.valid ? ` 当前偏差 ${Math.round(result.outcome.position * 1000)} mm / ${Math.round(result.outcome.angle)}°。` : '';
    setFeedback(title, detail + hint, 'warning');
  }
  updateGhosts(); updateUI(true); drawHUD();
}
function readHistory() {
  try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(value) ? value.filter(x => x && x.status === 'completed' && typeof x.score === 'number').slice(0, 5) : []; } catch { return []; }
}
function updateHistory() {
  const items = readHistory(); $('historyCount').textContent = items.length; $('historyList').replaceChildren();
  if (!items.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '完成一次实验后，这里会显示本机记录。'; $('historyList').append(p); }
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'history-item';
    const label = document.createElement('span'); label.textContent = `${new Date(item.completedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${item.mode === 'assessment' ? '考核' : '训练'}`;
    const value = document.createElement('strong'); value.textContent = `${item.score} 分 · ${fmtTime(item.elapsedSeconds)}`; row.append(label, value); $('historyList').append(row);
  }
}
function completeSession() {
  const result = buildResult(state); lastSavedResult = result;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify([result, ...readHistory()].slice(0, 5))); } catch { setFeedback('实验已完成', '浏览器未允许本地保存，请使用“导出记录”保存本次成绩。', 'success'); }
  updateHistory(); $('finalScore').textContent = result.score;
  $('resultSummary').textContent = `${state.mode === 'training' ? '训练模式' : '考核模式'} · 已完成 5 / 5 · 用时 ${fmtTime(result.elapsedSeconds)}`;
  $('resultDetails').replaceChildren();
  const lines = [`顺序错误 ${state.errors.sequence} 次 · 位置错误 ${state.errors.position} 次 · 姿态错误 ${state.errors.orientation} 次`, `操作扣分 ${result.deductions.errors} 分 · 时间扣分 ${result.deductions.time} 分`, `本次共提交 ${state.attempts.length} 次装配操作。`];
  for (const line of lines) { const div = document.createElement('div'); div.textContent = line; $('resultDetails').append(div); }
  if (!renderer.xr.isPresenting) $('resultDialog').showModal();
}
function exportRecord(useCompleted = false) {
  const record = useCompleted && lastSavedResult ? lastSavedResult : buildResult(state);
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `装配记录_${record.mode}_${record.status}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function resetSession(mode = state.mode, start = false) {
  releaseAll(); previewing = false; state = createSession(mode); if (start) state = startSession(state);
  resetModels(); $('resultDialog').close(); setFeedback(start ? '实验已开始' : '准备好开始了吗？', start ? startHint() : '先装左右支架，再安装转轴，最后固定两侧锁紧盖。');
  updateGhosts(); updateUI(true); drawHUD();
}
function startHint() { return state.mode === 'training' ? '先选择左支架或右支架。拖动到绿色轮廓处，Q / E 旋转后，按 Enter 确认。' : '先选择左支架或右支架。拖动到安装区对应位置，调整朝向后，按 Enter 确认。'; }
function beginSession() {
  if (state.status === 'completed') { resetSession(state.mode, true); return; }
  previewing = false; state = startSession(state); setFeedback('实验已开始', startHint()); updateGhosts(); updateUI(true); drawHUD();
}
function togglePreview() {
  if (renderer.xr.isPresenting || (state.mode === 'assessment' && state.status === 'running')) return;
  dragging = false; previewing = !previewing; updateGhosts(); updateUI(true);
  setFeedback(previewing ? '正在观察成品示意' : '已返回实验台', previewing ? '观察完整组件与安装方向。此示意不会改变进度或成绩；再次点击“返回操作”。' : state.status === 'running' ? '继续选择零件，拖动、调整姿态，再确认装配。' : '点击“开始实验”即可实际操作。');
}
function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1); raycaster.setFromCamera(pointer, camera);
}
function pickPart() {
  const targets = [...models.entries()].filter(([id]) => !state.installed.includes(id) && !heldBy.has(id)).map(([, model]) => model);
  return raycaster.intersectObjects(targets, true)[0];
}
function installDesktopControls() {
  const canvas = renderer.domElement;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    if (renderer.xr.isPresenting) return;
    pointerOrigin = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId);
    if (e.button === 2 || e.button === 1) { orbiting = true; return; }
    if (e.button !== 0 || previewing) return;
    pointerRay(e); const hit = pickPart();
    if (hit) {
      const id = hit.object.userData.partId; selectPart(id);
      if (state.status !== 'running') { setFeedback('零件已选中', state.mode === 'training' ? '点击右侧“开始实验”，然后拖动到目标轮廓处。' : '点击右侧“开始实验”，然后拖动到安装区对应位置。'); return; }
      const obj = models.get(id); dragPlane.set(new THREE.Vector3(0, 1, 0), -obj.position.y);
      const point = new THREE.Vector3(); if (raycaster.ray.intersectPlane(dragPlane, point)) { dragOffset.copy(obj.position).sub(point); dragging = true; }
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (renderer.xr.isPresenting) return;
    if (orbiting && pointerOrigin) { orbit.theta -= (e.clientX - pointerOrigin.x) * .006; orbit.phi = THREE.MathUtils.clamp(orbit.phi - (e.clientY - pointerOrigin.y) * .005, .08, 1.42); pointerOrigin = { x: e.clientX, y: e.clientY }; updateCamera(); return; }
    pointerRay(e);
    if (dragging && canMove()) { const point = new THREE.Vector3(); if (raycaster.ray.intersectPlane(dragPlane, point)) { const obj = models.get(selectedId); obj.position.copy(point).add(dragOffset); clampPart(obj); updateUI(); } }
    else { const hit = previewing ? null : pickPart(); hoverId = hit?.object.userData.partId || null; canvas.style.cursor = hit ? 'grab' : orbiting ? 'grabbing' : 'default'; }
  });
  const endPointer = () => { dragging = false; orbiting = false; pointerOrigin = null; };
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer); canvas.addEventListener('lostpointercapture', endPointer);
  canvas.addEventListener('wheel', e => { if (renderer.xr.isPresenting) return; e.preventDefault(); orbit.radius = THREE.MathUtils.clamp(orbit.radius + e.deltaY * .0025, 2.2, 5.6); updateCamera(); }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea') || $('helpDialog').open || $('resultDialog').open || renderer.xr.isPresenting) return;
    if (e.key === '?') { $('helpDialog').showModal(); return; }
    const key = e.key.toLowerCase();
    const moves = { w: ['z', -1], s: ['z', 1], a: ['x', -1], d: ['x', 1], r: ['y', 1], f: ['y', -1], arrowup: ['z', -1], arrowdown: ['z', 1], arrowleft: ['x', -1], arrowright: ['x', 1] };
    if (moves[key] && canMove()) { e.preventDefault(); nudge(...moves[key], e.shiftKey); }
    if ((key === 'q' || key === 'e') && canMove()) { e.preventDefault(); rotatePart(key === 'q' ? -1 : 1); }
    if (e.key === 'Enter' && canMove() && !e.repeat) { e.preventDefault(); attemptPlacement(); }
  });
}
function wireUI() {
  buildPartList();
  $('helpBtn').onclick = () => $('helpDialog').showModal();
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) { const rect = d.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) d.close(); } }));
  $('trainingMode').onclick = () => { if (state.status !== 'running') resetSession('training'); };
  $('assessmentMode').onclick = () => { if (state.status !== 'running') resetSession('assessment'); };
  $('startBtn').onclick = beginSession; $('resetBtn').onclick = () => resetSession(state.mode);
  $('exportBtn').onclick = () => exportRecord(); $('resultExport').onclick = () => exportRecord(true); $('placeBtn').onclick = () => attemptPlacement();
  $('previewBtn').onclick = togglePreview;
  $('clearHistoryBtn').onclick = () => {
    try { localStorage.removeItem(HISTORY_KEY); updateHistory(); }
    catch { setFeedback('暂时无法清除历史', '浏览器限制了本地存储访问，可通过浏览器站点设置清除。', 'warning'); }
  };
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setCamera(b.dataset.view));
  document.querySelectorAll('[data-nudge]').forEach(b => b.onclick = e => nudge(b.dataset.nudge[0], b.dataset.nudge[1] === '+' ? 1 : -1, e.shiftKey));
  document.querySelectorAll('[data-rotate]').forEach(b => b.onclick = () => rotatePart(Number(b.dataset.rotate)));
}

// This panel is a scene mesh so its text and controls remain visible inside a headset.
function createHUD() {
  hudCanvas = document.createElement('canvas'); hudCanvas.width = 1024; hudCanvas.height = 640; hudContext = hudCanvas.getContext('2d');
  hudTexture = new THREE.CanvasTexture(hudCanvas); hudTexture.colorSpace = THREE.SRGBColorSpace;
  hud = new THREE.Mesh(new THREE.PlaneGeometry(1.18, .7375), new THREE.MeshBasicMaterial({ map: hudTexture, side: THREE.DoubleSide }));
  hud.position.set(0, 1.59, -.94); hud.visible = false; scene.add(hud); drawHUD();
}
function drawHUD() {
  if (!hudContext) return;
  const ctx = hudContext; ctx.fillStyle = '#142b36'; ctx.fillRect(0, 0, 1024, 640);
  ctx.fillStyle = '#65d8b6'; ctx.font = '600 25px "Microsoft YaHei",sans-serif'; ctx.fillText('VIRTUAL ASSEMBLY LAB', 42, 50);
  ctx.fillStyle = '#eefaf8'; ctx.font = '600 42px "Microsoft YaHei",sans-serif'; ctx.fillText('双支架转轴组件', 42, 110);
  ctx.font = '25px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#a4c4cb'; ctx.fillText(`${state.mode === 'training' ? '训练模式' : '考核模式'}    ${fmtTime(elapsedSeconds(state))}    已完成 ${state.installed.length}/5    ${calculateScore(state).score} 分`, 42, 162);
  ctx.fillStyle = '#d7eae8'; ctx.font = '24px "Microsoft YaHei",sans-serif';
  const next = getAvailableParts(state).map(p => p.name).join(' / ');
  ctx.fillText(state.status === 'completed' ? '装配完成！可退出 VR 导出完整记录。' : state.status === 'idle' ? '射线指向“开始实验”，按一下扳机。' : `下一步：${next}`, 42, 215);
  ctx.fillStyle = '#82a7b2'; ctx.font = '22px "Microsoft YaHei",sans-serif';
  ctx.fillText('按住扳机抓取零件，移动并旋转手柄；松开即确认。', 42, 265);
  ctx.fillText(`错误：顺序 ${state.errors.sequence} / 位置 ${state.errors.position} / 姿态 ${state.errors.orientation}`, 42, 308);
  const feedback = $('feedback').querySelector('strong')?.textContent || '';
  ctx.fillStyle = '#8fdfc1'; ctx.font = '26px "Microsoft YaHei",sans-serif'; ctx.fillText(feedback, 42, 360);
  if (selectedId && state.mode === 'training') { const p = PARTS.find(p => p.id === selectedId); const error = poseError(p, getPose(selectedId)); ctx.font = '22px "Microsoft YaHei",sans-serif'; ctx.fillStyle = '#adcbd0'; ctx.fillText(`${p.name}  距离 ${Math.round(error.position * 1000)} mm / 姿态 ${Math.round(error.angle)}°  （容差55 mm / 12°）`, 42, 410); }
  const buttons = [{ x: 42, text: state.status === 'running' ? '重新开始' : state.status === 'completed' ? '再练习一次' : '开始实验' }, { x: 356, text: state.mode === 'training' ? '切换考核' : '切换训练' }, { x: 670, text: '退出 VR' }];
  for (const [index, b] of buttons.entries()) { ctx.fillStyle = index === 1 && state.status === 'running' ? '#263f48' : index === 0 ? '#167d6d' : '#345560'; ctx.fillRect(b.x, 474, 282, 85); ctx.fillStyle = index === 1 && state.status === 'running' ? '#718c94' : '#effaf7'; ctx.font = '600 27px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center'; ctx.fillText(b.text, b.x + 141, 527); ctx.textAlign = 'left'; }
  ctx.fillStyle = '#668f9b'; ctx.font = '19px "Microsoft YaHei",sans-serif'; ctx.fillText('同阶段左右件可交换先后。训练轮廓仅是对齐提示。', 42, 607);
  hudTexture.needsUpdate = true;
}
function setControllerRay(controller) {
  controller.updateWorldMatrix(true, false);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
}
function activateHUD(uv) {
  const x = uv.x * 1024, y = (1 - uv.y) * 640;
  if (y < 474 || y > 559) return;
  if (x >= 42 && x <= 324) { if (state.status === 'running') resetSession(state.mode); else beginSession(); }
  else if (x >= 356 && x <= 638 && state.status !== 'running') resetSession(state.mode === 'training' ? 'assessment' : 'training');
  else if (x >= 670 && x <= 952) renderer.xr.getSession()?.end();
  drawHUD();
}
function grab(controller) {
  if (!renderer.xr.isPresenting) return;
  setControllerRay(controller);
  const hudHit = raycaster.intersectObject(hud, false)[0], hit = pickPart();
  if (hudHit && (!hit || hudHit.distance < hit.distance)) { activateHUD(hudHit.uv); return; }
  if (state.status !== 'running' || !hit) return;
  const id = hit.object.userData.partId;
  if (heldBy.has(id) || controller.userData.heldPart) return;
  const obj = models.get(id); heldBy.set(id, controller); controller.userData.heldPart = id;
  controller.userData.beforeGrab = { position: obj.position.clone(), quaternion: obj.quaternion.clone() };
  controller.attach(obj); selectedId = id; updateGhosts(); updateUI(true); drawHUD();
}
function release(controller, evaluate = true, restore = false) {
  const id = controller.userData.heldPart; if (!id) return;
  const obj = models.get(id); partsRoot.attach(obj);
  if (restore && controller.userData.beforeGrab) { obj.position.copy(controller.userData.beforeGrab.position); obj.quaternion.copy(controller.userData.beforeGrab.quaternion); }
  heldBy.delete(id); delete controller.userData.heldPart; delete controller.userData.beforeGrab;
  if (evaluate) {
    attemptPlacement(id);
    if (!state.installed.includes(id)) clampPart(obj);
  }
}
function releaseAll() { for (const c of controllers) release(c, false, true); heldBy.clear(); }
function createXRControllers() {
  rig = new THREE.Group(); rig.position.set(0, 0, 1.15); scene.add(rig);
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i); controllers.push(controller); rig.add(controller);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: i === 0 ? 0x67e3bd : 0x81baff })); line.name = 'ray'; line.scale.z = 3; controller.add(line);
    const grip = renderer.xr.getControllerGrip(i); rig.add(grip);
    const proxy = mesh(new THREE.CylinderGeometry(.017, .024, .10, 12), material(i === 0 ? 0x61ad94 : 0x678eae), grip); proxy.rotation.x = Math.PI / 2;
    controller.addEventListener('selectstart', () => grab(controller));
    controller.addEventListener('selectend', () => release(controller, true));
    controller.addEventListener('disconnected', () => release(controller, false, true));
  }
  renderer.xr.addEventListener('sessionstart', () => {
    releaseAll(); previewing = false; dragging = false; orbiting = false; $('helpDialog').close(); $('resultDialog').close();
    // Camera and controller poses must share the same floor-origin offset.
    rig.add(camera); rig.updateMatrixWorld(true);
    hud.visible = true; $('sceneMode').textContent = 'VR 头显操作'; $('vrBtn').textContent = '退出 VR'; updateGhosts(); updateUI(true); drawHUD();
  });
  renderer.xr.addEventListener('sessionend', () => {
    releaseAll(); hud.visible = false; dragging = false; orbiting = false;
    scene.add(camera); camera.fov = 43; camera.aspect = viewport.clientWidth / viewport.clientHeight; camera.updateProjectionMatrix();
    $('sceneMode').textContent = '桌面操作'; $('vrBtn').textContent = '进入 VR'; updateCamera(); updateGhosts(); updateUI(true);
    if (state.status === 'completed') $('resultDialog').showModal();
  });
}
async function setupXR() {
  if (!window.isSecureContext || !navigator.xr) { $('xrStatus').textContent = '桌面模式可用'; $('vrBtn').title = '此浏览器或环境未提供 WebXR；电脑操作可完整完成实验。'; return; }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    $('xrStatus').textContent = supported ? '已检测到 VR 支持' : '桌面模式可用'; $('xrStatus').classList.toggle('available', supported); $('vrBtn').disabled = !supported;
    $('vrBtn').title = supported ? '进入连接的 VR 设备' : '未检测到兼容头显；电脑操作可完整完成实验。';
    $('vrBtn').onclick = async () => {
      const session = renderer.xr.getSession(); if (session) { await session.end(); return; }
      let requestedSession;
      $('vrBtn').disabled = true;
      try { requestedSession = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] }); await renderer.xr.setSession(requestedSession); }
      catch (error) {
        if (requestedSession) { try { await requestedSession.end(); } catch { /* The browser may already have ended a failed session. */ } }
        setFeedback('暂时无法进入 VR', '请确认头显连接、浏览器权限及安全地址。当前可继续使用桌面模式。', 'warning'); console.warn('WebXR session:', error);
      } finally { $('vrBtn').disabled = false; }
    };
  } catch (error) { $('xrStatus').textContent = '桌面模式可用'; console.warn('WebXR capability:', error); }
}
function renderFrame(time) {
  if (renderer.xr.isPresenting) {
    for (const controller of controllers) {
      setControllerRay(controller); const hit = pickPart(); const hudHit = raycaster.intersectObject(hud)[0];
      controller.getObjectByName('ray').scale.z = Math.min(hit?.distance ?? 3, hudHit?.distance ?? 3, 3);
    }
    if (time - lastHUD > 250) { drawHUD(); lastHUD = time; }
  }
  // Emission highlights the selected actual part without changing the instructional model colours.
  for (const [id, model] of models) model.traverse(o => { if (o.isMesh && o.material.emissive) o.material.emissive.setHex(!state.installed.includes(id) && (id === selectedId || id === hoverId) ? 0x123c31 : 0x000000); });
  updateUI(); renderer.render(scene, camera);
}
async function main() {
  wireUI(); updateHistory();
  try {
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x122630); scene.fog = new THREE.Fog(0x122630, 7, 18);
    camera = new THREE.PerspectiveCamera(43, 1, .01, 100); updateCamera();
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
    renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor'); renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute('aria-label', '可交互的三维装配实验台'); viewport.prepend(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xc6ecf0, 0x253840, 2.1));
    const key = new THREE.DirectionalLight(0xf2fffc, 4); key.position.set(-2, 5, 2); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 3; key.shadow.camera.bottom = -3; key.shadow.normalBias = .02; scene.add(key);
    const fill = new THREE.DirectionalLight(0x74b2cb, 1.8); fill.position.set(3, 2, -2); scene.add(fill);
    createStage(); createParts(); createHUD(); createXRControllers(); installDesktopControls();
    new ResizeObserver(() => { const width = viewport.clientWidth, height = viewport.clientHeight; if (!width || !height) return; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); if (!renderer.xr.isPresenting) updateCamera(); }).observe(viewport);
    updateUI(true); setCamera('perspective'); renderer.setAnimationLoop(renderFrame); await setupXR();
  } catch (error) {
    console.error(error); $('sceneFallback').hidden = false; $('startBtn').disabled = true; $('vrBtn').disabled = true; $('xrStatus').textContent = '三维视图未启动'; setFeedback('三维视图未能启动', `${error.message}。请使用配套启动脚本，并在支持 WebGL 的现代浏览器中打开。`, 'warning');
  }
}
main();
