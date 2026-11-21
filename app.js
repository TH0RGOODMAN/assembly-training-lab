import * as THREE from 'three';
import { PARTS, LIMITS, createSession, startSession, evaluatePlacement, poseError, calculateScore, elapsedSeconds, buildResult, getAvailableParts } from './domain.mjs';

const $ = id => (typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null);
const viewport = $('viewport');
const HISTORY_KEY = 'vr-assembly-lab.results.v1';

let state = createSession('training');
let selectedId = null, previewing = false, dragging = false, orbiting = false, pointerOrigin = null;
let scene, camera, renderer, partsRoot, previewRoot, ghostRoot, guideGroup, effectsGroup, hud, hudCanvas, hudContext, hudTexture, rig;
let lastHUD = 0, lastUI = 0, lastPerf = 0, lastFrameAt = 0, lastSavedResult = null, hoverId = null;
let soundEnabled = true, perfVisible = false, audioCtx = null;
let explodeFactor = 0, targetExplode = 0, demoPlaying = false, demoStage = 0, demoElapsed = 0;
// A staged pose remains authoritative while paused; null selects the free explode slider.
let demoProgress = null;

const models = new Map(), ghosts = new Map(), previewParts = new Map();
const controllers = [], heldBy = new Map();
const snapAnimations = new Map(), shakeAnimations = new Map(), pulseRings = [];
const perfSamples = [];
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), dragPlane = new THREE.Plane(), dragOffset = new THREE.Vector3();
const worldPosition = new THREE.Vector3(), worldQuaternion = new THREE.Quaternion();
const tempVecA = new THREE.Vector3(), tempVecB = new THREE.Vector3();
const cameraTarget = new THREE.Vector3(0, 0.99, 0.02);
const targetLookAt = new THREE.Vector3(0, 0.99, 0.02);
let orbit = { theta: 0.24, phi: 0.96, radius: 3.18 };
let targetOrbit = { theta: 0.24, phi: 0.96, radius: 3.18 };
let cameraEasing = false;

const initialPoses = [
  { p: [-1.03, 0.86, 0.53], a: 30 },
  { p: [-0.54, 0.86, 0.53], a: -30 },
  { p: [0.25, 1.16, 0.63], a: 30 },
  { p: [0.83, 1.16, 0.32], a: -45 },
  { p: [1.12, 1.16, 0.57], a: 45 },
];
const explodedOffsets = {
  'left-support': [-0.22, 0.0, 0.0],
  'right-support': [0.22, 0.0, 0.0],
  'shaft': [0.0, 0.32, 0.0],
  'left-cap': [-0.36, 0.32, 0.0],
  'right-cap': [0.36, 0.32, 0.0],
};
const demoCaptions = [
  '爆炸拆解全览：5 个活动零件与固定基座构成三阶段同轴装配体系',
  '阶段一（左/右支架）：先将两侧支架就位并固定于安装基座（左右可互换）',
  '阶段二（中心转轴）：两侧支架完成后，将中心转轴同轴穿入轴承孔',
  '阶段三（两侧锁紧盖）：最后将左右锁紧盖沿轴端装入，完成整机装配',
];
const errorText = {
  sequence: ['装配顺序需要调整', '请先装好两个支架，再放入转轴，最后安装锁紧盖。'],
  position: ['位置还需要对齐', '将零件移近目标轮廓；可借助 3D 引导线和方向按钮微调后再次确认。'],
  orientation: ['姿态还需要调整', '位置已对齐，请旋转零件，使青绿色方向箭头与目标基准一致。'],
  inactive: ['请先开始实验', '选择训练或考核模式，再点击“开始实验”。'],
};

let brushedTexture = null;
let guideParts = null;
let explodeLines = null;

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
function queryAll(selector) {
  return typeof document !== 'undefined' && document.querySelectorAll ? document.querySelectorAll(selector) : [];
}
function setFeedback(title, detail, kind = '') {
  const box = $('feedback');
  if (!box) return;
  box.className = `feedback ${kind}`;
  box.replaceChildren();
  const strong = document.createElement('strong'), span = document.createElement('span');
  strong.textContent = title;
  span.textContent = detail;
  box.append(strong, span);
}
function fmtTime(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
function playSound(kind) {
  if (!soundEnabled || typeof window === 'undefined') return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t = audioCtx.currentTime;
    const tone = (freq, start, dur, gainVal, type = 'triangle', endFreq = null) => {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t + start);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + start + dur);
      gain.gain.setValueAtTime(0.0001, t + start);
      gain.gain.exponentialRampToValueAtTime(gainVal, t + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t + start);
      osc.stop(t + start + dur + 0.02);
    };
    if (kind === 'select') tone(680, 0, 0.045, 0.035, 'sine', 760);
    else if (kind === 'snap') {
      tone(520, 0, 0.075, 0.07, 'triangle', 740);
      tone(880, 0.05, 0.13, 0.055, 'sine', 1046);
    } else if (kind === 'error') {
      tone(235, 0, 0.09, 0.06, 'sawtooth', 195);
      tone(190, 0.1, 0.11, 0.055, 'sawtooth', 165);
    } else if (kind === 'complete') {
      tone(523.25, 0, 0.16, 0.06, 'sine');
      tone(659.25, 0.11, 0.18, 0.06, 'sine');
      tone(783.99, 0.22, 0.26, 0.07, 'triangle');
      tone(1046.5, 0.34, 0.34, 0.065, 'sine');
    }
  } catch { /* Ignore autoplay or unavailable audio context errors. */ }
}
function triggerHaptic(controller, intensity = 0.45, duration = 60) {
  try {
    const actuator = controller?.userData?.inputSource?.gamepad?.hapticActuators?.[0];
    if (actuator && typeof actuator.pulse === 'function') actuator.pulse(intensity, duration);
  } catch { /* Haptics are optional and device-dependent. */ }
}
function getBrushedTexture() {
  if (brushedTexture || typeof document === 'undefined' || !document.createElement) return brushedTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 2) {
    const v = 182 + ((y * 37) % 42);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, y, 256, 1);
  }
  for (let i = 0; i < 180; i++) {
    const x = (i * 53) % 256, y = (i * 29) % 256, w = 24 + (i % 64);
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.12)' : 'rgba(60,70,80,0.08)';
    ctx.fillRect(x, y, w, 1);
  }
  brushedTexture = new THREE.CanvasTexture(c);
  brushedTexture.wrapS = brushedTexture.wrapT = THREE.RepeatWrapping;
  brushedTexture.repeat.set(2, 2);
  return brushedTexture;
}
function createStudioEnvironment(activeRenderer) {
  try {
    const pmrem = new THREE.PMREMGenerator(activeRenderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x182b36);
    const panel = (w, h, color, pos, look = [0, 0, 0]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(...pos);
      m.lookAt(...look);
      envScene.add(m);
    };
    panel(12, 8, 0xf2fbff, [0, 7, 0], [0, 0, 0]);
    panel(8, 5, 0x9ce2d8, [-7, 3.5, 4], [0, 1, 0]);
    panel(8, 5, 0xffdfc2, [7, 3.5, -3], [0, 1, 0]);
    panel(10, 4, 0x7cb8cf, [0, 3, 7], [0, 1, 0]);
    panel(10, 4, 0x304c5a, [0, -5, 0], [0, 0, 0]);
    const rt = pmrem.fromScene(envScene, 0.04);
    pmrem.dispose();
    return rt.texture;
  } catch {
    return null;
  }
}
function createBackdropTexture() {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(256, 150, 20, 256, 256, 390);
  grad.addColorStop(0, '#213d4b');
  grad.addColorStop(0.52, '#142834');
  grad.addColorStop(1, '#0b171f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function createWorkbenchMatTexture() {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 640;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createLinearGradient(0, 0, 0, 640);
  grad.addColorStop(0, '#36555f');
  grad.addColorStop(0.55, '#2f4c56');
  grad.addColorStop(1, '#28424b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 640);

  // Subtle metric grid across the ESD assembly mat
  ctx.strokeStyle = 'rgba(176, 224, 222, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 32; x < 1024; x += 32) {
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, 620); ctx.stroke();
  }
  for (let y = 20; y < 640; y += 32) {
    ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(1004, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(130, 218, 200, 0.18)';
  ctx.lineWidth = 1.5;
  for (let x = 128; x < 1024; x += 128) {
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, 620); ctx.stroke();
  }
  for (let y = 116; y < 640; y += 128) {
    ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(1004, y); ctx.stroke();
  }
  // Outer calibrated frame
  ctx.strokeStyle = 'rgba(132, 220, 200, 0.34)';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, 984, 600);
  // Zone divider line between Assembly Zone (top) and Parts Tray (bottom)
  ctx.strokeStyle = 'rgba(105, 214, 188, 0.32)';
  ctx.setLineDash([12, 8]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(36, 354); ctx.lineTo(988, 354); ctx.stroke();
  ctx.setLineDash([]);
  // Coordinate scale ticks along left & bottom
  ctx.fillStyle = 'rgba(165, 212, 214, 0.45)';
  ctx.font = '600 13px "Segoe UI", sans-serif';
  ctx.fillText('UNIT: mm  ·  TOLERANCE: ±55 mm / ±12°', 36, 46);
  ctx.fillText('STAGE 01–03  ·  COAXIAL ASSEMBLY JIG', 725, 46);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function material(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.35, ...extra });
}
function mesh(geometry, mat, parent, position = [0, 0, 0]) {
  const item = new THREE.Mesh(geometry, mat);
  item.position.set(...position);
  item.castShadow = true;
  item.receiveShadow = true;
  parent.add(item);
  return item;
}
function box(parent, size, position, mat) {
  return mesh(new THREE.BoxGeometry(...size), mat, parent, position);
}
function cylinderX(parent, radius, length, position, mat, segments = 40) {
  const m = mesh(new THREE.CylinderGeometry(radius, radius, length, segments), mat, parent, position);
  m.rotation.z = Math.PI / 2;
  return m;
}
function createArrowBadge(parent, mat, position, scale = 1) {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.028 * scale);
  shape.lineTo(0.024 * scale, 0.012 * scale);
  shape.lineTo(0.010 * scale, 0.012 * scale);
  shape.lineTo(0.010 * scale, 0.032 * scale);
  shape.lineTo(-0.010 * scale, 0.032 * scale);
  shape.lineTo(-0.010 * scale, 0.012 * scale);
  shape.lineTo(-0.024 * scale, 0.012 * scale);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.008 * scale, bevelEnabled: true, bevelSize: 0.0015, bevelThickness: 0.0015, bevelSegments: 2 });
  const arrow = mesh(geo, mat, parent, position);
  arrow.rotation.x = Math.PI / 2;
  return arrow;
}
function labelTexture(text, color = '#c7ece5', background = null, width = 768, height = 128) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
  ctx.fillStyle = color;
  let fontSize = Math.round(height * 0.42);
  ctx.font = `600 ${fontSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
  const maxW = width * 0.90;
  const measured = ctx.measureText(text).width;
  if (measured > maxW) {
    fontSize = Math.max(16, Math.floor(fontSize * (maxW / measured)));
    ctx.font = `600 ${fontSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function flatLabel(parent, text, position, width = 0.34, color = '#c7ece5') {
  const m = mesh(
    new THREE.PlaneGeometry(width, width / 6),
    new THREE.MeshBasicMaterial({ map: labelTexture(text, color), transparent: true, depthWrite: false }),
    parent,
    position,
  );
  m.rotation.x = -Math.PI / 2;
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}
function makePart(part) {
  const group = new THREE.Group();
  group.userData.partId = part.id;
  const visualRoot = new THREE.Group();
  group.add(visualRoot);
  group.userData.visualRoot = visualRoot;

  const brush = getBrushedTexture();
  const steel = material(0xaec6d2, { metalness: 0.62, roughness: 0.28, roughnessMap: brush || null });
  const brightSteel = material(0xcce0e8, { metalness: 0.68, roughness: 0.22, roughnessMap: brush || null });
  const dark = material(0x2e4957, { metalness: 0.56, roughness: 0.34 });
  const gunmetal = material(0x1f3540, { metalness: 0.58, roughness: 0.38 });
  const bronze = material(0xc99654, { metalness: 0.64, roughness: 0.28 });
  const teal = material(0x1ca68e, { metalness: 0.35, roughness: 0.26, emissive: 0x05221c });
  const brass = material(0xe6b46e, { metalness: 0.58, roughness: 0.28, roughnessMap: brush || null });

  if (part.id.includes('support')) {
    // Stepped machined baseplate with chamfered upper pad
    box(visualRoot, [0.23, 0.044, 0.28], [0, 0.022, 0], dark);
    box(visualRoot, [0.206, 0.012, 0.254], [0, 0.05, 0], gunmetal);

    // Extruded arch upright with beveled edges & precision shaft bore (y = 0.30, r = 0.061)
    const shape = new THREE.Shape();
    shape.moveTo(-0.106, 0.055);
    shape.lineTo(0.106, 0.055);
    shape.lineTo(0.106, 0.342);
    shape.quadraticCurveTo(0.106, 0.415, 0.036, 0.415);
    shape.lineTo(-0.036, 0.415);
    shape.quadraticCurveTo(-0.106, 0.415, -0.106, 0.342);
    shape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0.30, 0.061, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const upright = mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 0.048, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.0045, bevelThickness: 0.0045, curveSegments: 36 }),
      steel,
      visualRoot,
      [-0.024, 0, 0],
    );
    upright.rotation.y = Math.PI / 2;

    // Stepped bearing collar & satin bronze inner bushing sleeve (clear of r=0.042 shaft)
    const collarRing = new THREE.TorusGeometry(0.064, 0.009, 14, 36);
    for (const side of [-0.028, 0.028]) {
      const cMesh = mesh(collarRing, brightSteel, visualRoot, [side, 0.30, 0]);
      cMesh.rotation.y = Math.PI / 2;
    }
    const bushing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.058, 0.062, 36, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xc99654, metalness: 0.64, roughness: 0.28, side: THREE.DoubleSide }),
    );
    bushing.position.set(0, 0.30, 0);
    bushing.rotation.z = Math.PI / 2;
    bushing.castShadow = true;
    bushing.receiveShadow = true;
    visualRoot.add(bushing);

    // Side structural gusset stiffener ribs
    const ribShape = new THREE.Shape();
    ribShape.moveTo(0, 0);
    ribShape.lineTo(0.062, 0);
    ribShape.lineTo(0, 0.135);
    ribShape.closePath();
    const ribGeo = new THREE.ExtrudeGeometry(ribShape, { depth: 0.016, bevelEnabled: true, bevelSize: 0.002, bevelThickness: 0.002, bevelSegments: 2 });
    for (const sx of [-1, 1]) {
      const rib = mesh(ribGeo, dark, visualRoot, [sx * 0.026, 0.055, -0.008]);
      if (sx < 0) rib.rotation.y = Math.PI;
    }

    // 4 machined socket-head mounting bolts + washers
    for (const sx of [-0.08, 0.08]) {
      for (const sz of [-0.098, 0.098]) {
        mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.004, 18), brightSteel, visualRoot, [sx, 0.058, sz]);
        mesh(new THREE.CylinderGeometry(0.0115, 0.0115, 0.011, 6), gunmetal, visualRoot, [sx, 0.065, sz]);
      }
    }

    // Precision machined teal 3D directional arrow key on top of bracket
    box(visualRoot, [0.058, 0.007, 0.08], [0, 0.422, -0.004], dark);
    createArrowBadge(visualRoot, teal, [0, 0.431, -0.002], 1.12);
    flatLabel(visualRoot, part.id.startsWith('left') ? 'L ↑' : 'R ↑', [0, 0.061, 0.072], 0.17, '#99ebd0');
  } else if (part.id === 'shaft') {
    // Precision brushed stainless main shaft with chamfered ends
    cylinderX(visualRoot, 0.042, 0.94, [0, 0, 0], brightSteel, 48);
    for (const sx of [-1, 1]) {
      const endBevel = mesh(new THREE.CylinderGeometry(sx > 0 ? 0.036 : 0.042, sx > 0 ? 0.042 : 0.036, 0.024, 36), brightSteel, visualRoot, [sx * 0.482, 0, 0]);
      endBevel.rotation.z = Math.PI / 2;
      // Subtle axial retaining grooves near shaft ends
      cylinderX(visualRoot, 0.0445, 0.012, [sx * 0.435, 0, 0], bronze, 36);
      // Bearing seat journals aligning inside bracket bores (x = ±0.36)
      cylinderX(visualRoot, 0.045, 0.064, [sx * 0.36, 0, 0], steel, 36);
    }
    // Dual stepped anodized bearing spacer collars
    for (const sx of [-0.18, 0.18]) {
      cylinderX(visualRoot, 0.058, 0.068, [sx, 0, 0], dark, 40);
      cylinderX(visualRoot, 0.061, 0.014, [sx - 0.022, 0, 0], gunmetal, 40);
      cylinderX(visualRoot, 0.061, 0.014, [sx + 0.022, 0, 0], gunmetal, 40);
    }
    // Central teal positioning ring & raised keyway arrow bar
    cylinderX(visualRoot, 0.053, 0.03, [0, 0, 0], teal, 40);
    box(visualRoot, [0.28, 0.011, 0.015], [0, 0.045, 0], teal);
    createArrowBadge(visualRoot, teal, [0, 0.056, 0], 0.72);
  } else {
    // Machined satin-brass hexagonal locking cap with inner retaining collar and recessed end-pin
    const sign = part.id.startsWith('left') ? -1 : 1;
    cylinderX(visualRoot, 0.074, 0.044, [0, 0, 0], brass, 6);
    cylinderX(visualRoot, 0.062, 0.014, [sign * -0.025, 0, 0], bronze, 24);
    cylinderX(visualRoot, 0.052, 0.018, [sign * 0.028, 0, 0], dark, 24);
    cylinderX(visualRoot, 0.024, 0.068, [0, 0, 0], brightSteel, 24);
    cylinderX(visualRoot, 0.013, 0.072, [0, 0, 0], gunmetal, 6);
    // Raised teal orientation key + micro directional chevron on top face
    box(visualRoot, [0.04, 0.008, 0.022], [0, 0.068, 0], teal);
    createArrowBadge(visualRoot, teal, [0, 0.077, 0], 0.56);
  }

  group.traverse(o => { if (o.isMesh) o.userData.partId = part.id; });
  return group;
}
function createStage() {
  const floor = material(0x11222b, { roughness: 0.92, metalness: 0.08 });
  mesh(new THREE.PlaneGeometry(200, 200), floor, scene).rotation.x = -Math.PI / 2;

  const table = new THREE.Group();
  scene.add(table);

  const frameMat = material(0x213844, { roughness: 0.72, metalness: 0.34 });
  const railMat = material(0x52737f, { roughness: 0.36, metalness: 0.58 });
  const legMat = material(0x192d38, { roughness: 0.65, metalness: 0.38 });
  const accentMat = material(0x1f8e7d, { roughness: 0.38, metalness: 0.42 });

  // Structural workbench body + brushed perimeter trim rails
  box(table, [2.86, 0.078, 1.78], [0, 0.816, 0.06], frameMat);
  const matTex = createWorkbenchMatTexture();
  const topMat = material(0xffffff, { map: matTex, roughness: 0.76, metalness: 0.14 });
  box(table, [2.76, 0.01, 1.68], [0, 0.858, 0.06], topMat);

  // Anodized perimeter side guards & front instrument bar
  box(table, [2.88, 0.022, 0.028], [0, 0.855, 0.945], railMat);
  box(table, [2.88, 0.022, 0.028], [0, 0.855, -0.825], railMat);
  box(table, [0.028, 0.022, 1.80], [-1.43, 0.855, 0.06], railMat);
  box(table, [0.028, 0.022, 1.80], [1.43, 0.855, 0.06], railMat);
  box(table, [2.42, 0.018, 0.014], [0, 0.815, 0.955], accentMat);

  // Heavy industrial legs, leveling feet & structural crossbars
  for (const x of [-1.18, 1.18]) {
    for (const z of [-0.58, 0.66]) {
      box(table, [0.08, 0.76, 0.08], [x, 0.395, z], legMat);
      mesh(new THREE.CylinderGeometry(0.052, 0.058, 0.022, 16), railMat, table, [x, 0.011, z]);
    }
  }
  box(table, [2.42, 0.075, 0.065], [0, 0.17, -0.58], legMat);
  box(table, [0.065, 0.075, 1.24], [-1.18, 0.17, 0.04], legMat);
  box(table, [0.065, 0.075, 1.24], [1.18, 0.17, 0.04], legMat);
  box(table, [2.42, 0.048, 0.032], [0, 0.67, 0.84], accentMat);

  // Machined aluminum installation baseplate (scene fixture, not an assessed part)
  const baseMat = material(0x5d7e86, { roughness: 0.34, metalness: 0.56, roughnessMap: getBrushedTexture() || null });
  const baseBevel = material(0x415f69, { roughness: 0.42, metalness: 0.48 });
  box(table, [1.50, 0.016, 0.62], [0, 0.852, -0.21], baseBevel);
  box(table, [1.46, 0.012, 0.58], [0, 0.861, -0.21], baseMat);
  for (const x of [-0.67, 0.67]) {
    for (const z of [-0.45, 0.03]) {
      mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.004, 16), railMat, table, [x, 0.868, z]);
      mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 6), legMat, table, [x, 0.872, z]);
    }
  }
  // Engraved mounting pockets & center axis marking on baseplate
  const axisLineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.62, 0.869, -0.21),
    new THREE.Vector3(0.62, 0.869, -0.21),
  ]);
  const axisLine = new THREE.Line(axisLineGeo, new THREE.LineDashedMaterial({ color: 0x8de6cd, dashSize: 0.03, gapSize: 0.02, transparent: true, opacity: 0.62 }));
  axisLine.computeLineDistances();
  table.add(axisLine);

  for (const p of PARTS.slice(0, 2)) {
    box(table, [0.25, 0.002, 0.30], [p.position[0], 0.868, p.position[2]], material(0x3a5861, { roughness: 0.5, metalness: 0.35 }));
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.254, 0.002, 0.304)),
      new THREE.LineBasicMaterial({ color: 0x8de8cc, transparent: true, opacity: 0.82 }),
    );
    edge.position.set(p.position[0], 0.87, p.position[2]);
    table.add(edge);
    flatLabel(table, p.id.startsWith('left') ? 'L 支架位' : 'R 支架位', [p.position[0], 0.871, -0.43], 0.28, '#d4f5ec');
  }
  flatLabel(table, '安装基座  /  ASSEMBLY JIG', [0, 0.871, -0.59], 0.78, '#b6dce0');
  flatLabel(table, '零件准备区  /  PARTS TRAY', [-0.92, 0.871, 0.81], 0.66, '#93bac2');

  // Sleek machined part cradles in the preparation zone
  const cradleDark = material(0x223842, { roughness: 0.55, metalness: 0.4 });
  const cradleTop = material(0x4c747a, { roughness: 0.38, metalness: 0.45 });
  for (let i = 0; i < PARTS.length; i++) {
    const pose = initialPoses[i];
    if (i < 2) {
      box(table, [0.32, 0.008, 0.38], [pose.p[0], 0.865, pose.p[2]], cradleDark);
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.322, 0.009, 0.382)),
        new THREE.LineBasicMaterial({ color: 0x629ea1, transparent: true, opacity: 0.45 }),
      );
      border.position.set(pose.p[0], 0.866, pose.p[2]);
      table.add(border);
      flatLabel(table, `0${i + 1}`, [pose.p[0], 0.871, pose.p[2] + 0.165], 0.12, '#86c4be');
    } else if (i === 2) {
      // Twin precision V-block cradle saddles for the shaft
      for (const x of [-0.07, 0.56]) {
        box(table, [0.09, 0.215, 0.14], [x, 0.972, 0.63], cradleDark);
        box(table, [0.10, 0.022, 0.13], [x, 1.09, 0.63], cradleTop);
        box(table, [0.095, 0.025, 0.022], [x, 1.112, 0.578], accentMat);
        box(table, [0.095, 0.025, 0.022], [x, 1.112, 0.682], accentMat);
      }
      flatLabel(table, '03 转轴', [0.25, 0.871, 0.77], 0.26, '#86c4be');
    } else {
      // Stepped cylindrical/hex pedestals for locking caps
      mesh(new THREE.CylinderGeometry(0.078, 0.088, 0.215, 24), cradleDark, table, [pose.p[0], 0.97, pose.p[2]]);
      mesh(new THREE.CylinderGeometry(0.072, 0.078, 0.018, 24), cradleTop, table, [pose.p[0], 1.086, pose.p[2]]);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.056, 0.068, 24),
        new THREE.MeshBasicMaterial({ color: 0x64d6b7, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pose.p[0], 1.097, pose.p[2]);
      table.add(ring);
      flatLabel(table, `0${i + 1}`, [pose.p[0], 0.871, pose.p[2] + 0.135], 0.12, '#86c4be');
    }
  }

  const grid = new THREE.GridHelper(22, 44, 0x2a5462, 0x1b3744);
  grid.position.y = 0.002;
  scene.add(grid);
}
function createGhostForPart(part) {
  const ghost = makePart(part);
  ghost.position.set(...part.position);
  ghost.quaternion.set(...part.quaternion);
  const fillMat = new THREE.MeshBasicMaterial({
    color: 0x64e6be, transparent: true, opacity: 0.17, depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x7ef2cf, transparent: true, opacity: 0.56, depthWrite: false,
  });
  const wireOverlays = [];
  ghost.traverse(o => {
    if (o.isMesh) {
      o.material = fillMat;
      o.castShadow = false;
      o.receiveShadow = false;
      if (o.geometry && o.geometry.type !== 'PlaneGeometry') {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), edgeMat);
        o.add(edges);
        wireOverlays.push(edges);
      }
    }
  });
  ghost.userData.fillMat = fillMat;
  ghost.userData.edgeMat = edgeMat;
  ghost.userData.wireOverlays = wireOverlays;
  return ghost;
}
function createParts() {
  partsRoot = new THREE.Group();
  ghostRoot = new THREE.Group();
  previewRoot = new THREE.Group();
  effectsGroup = new THREE.Group();
  scene.add(partsRoot, ghostRoot, previewRoot, effectsGroup);
  previewRoot.visible = false;

  for (const part of PARTS) {
    const model = makePart(part);
    models.set(part.id, model);
    partsRoot.add(model);

    const ghost = createGhostForPart(part);
    ghosts.set(part.id, ghost);
    ghostRoot.add(ghost);

    const example = makePart(part);
    example.position.set(...part.position);
    example.quaternion.set(...part.quaternion);
    previewParts.set(part.id, example);
    previewRoot.add(example);
  }

  // Orthogonal mechanical axial trajectory guides for Exploded View inside previewRoot
  explodeLines = new THREE.Group();
  const makeDash = (pts, color, opacity = 0.72) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p)));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 0.032, gapSize: 0.022, transparent: true, opacity }));
    line.computeLineDistances();
    explodeLines.add(line);
  };
  // Horizontal slide paths for left/right supports on the baseplate
  makeDash([[-0.58, 1.08, -0.21], [-0.36, 1.08, -0.21]], 0x6ce5c4, 0.78);
  makeDash([[0.58, 1.08, -0.21], [0.36, 1.08, -0.21]], 0x6ce5c4, 0.78);
  // Vertical lift path for center shaft from bore axis (y=1.16) to exploded axis (y=1.48)
  makeDash([[0, 1.16, -0.21], [0, 1.48, -0.21]], 0x6ce5c4, 0.82);
  // Upper coaxial line connecting exploded caps and shaft at y=1.48
  makeDash([[-0.88, 1.48, -0.21], [0.88, 1.48, -0.21]], 0xf0c98a, 0.75);
  // Lower coaxial bore centerline through assembled supports at y=1.16
  makeDash([[-0.72, 1.16, -0.21], [0.72, 1.16, -0.21]], 0x9bd7e6, 0.56);
  explodeLines.visible = false;
  previewRoot.add(explodeLines);

  resetModels();
}
function createSpatialGuides() {
  guideGroup = new THREE.Group();
  guideGroup.visible = false;
  scene.add(guideGroup);

  const tetherGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const tetherMat = new THREE.LineBasicMaterial({ color: 0x5ce0c0, transparent: true, opacity: 0.88 });
  const tetherLine = new THREE.Line(tetherGeo, tetherMat);
  guideGroup.add(tetherLine);

  const dropGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const dropMat = new THREE.LineBasicMaterial({ color: 0x7bcde0, transparent: true, opacity: 0.55 });
  const dropLine = new THREE.Line(dropGeo, dropMat);
  guideGroup.add(dropLine);

  const dropRingMat = new THREE.MeshBasicMaterial({ color: 0x7bcde0, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false });
  const dropRing = new THREE.Mesh(new THREE.RingGeometry(0.032, 0.042, 32), dropRingMat);
  dropRing.rotation.x = -Math.PI / 2;
  guideGroup.add(dropRing);

  // 55 mm tolerance zone ring around the target anchor (literally R = LIMITS.position)
  const tolRingMat = new THREE.MeshBasicMaterial({ color: 0x5ce0c0, side: THREE.DoubleSide, transparent: true, opacity: 0.42, depthWrite: false });
  const tolRing = new THREE.Mesh(new THREE.RingGeometry(LIMITS.position - 0.008, LIMITS.position, 40), tolRingMat);
  tolRing.rotation.x = -Math.PI / 2;
  guideGroup.add(tolRing);

  // Coaxial reference axis through the two bracket bores (y = 1.16, z = -0.21)
  const coaxGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.74, 1.16, -0.21),
    new THREE.Vector3(0.74, 1.16, -0.21),
  ]);
  const coaxMat = new THREE.LineDashedMaterial({ color: 0x6ce5c4, dashSize: 0.035, gapSize: 0.025, transparent: true, opacity: 0.65 });
  const coaxialLine = new THREE.Line(coaxGeo, coaxMat);
  coaxialLine.computeLineDistances();
  guideGroup.add(coaxialLine);

  guideParts = { tetherLine, tetherMat, dropLine, dropMat, dropRing, dropRingMat, tolRing, tolRingMat, coaxialLine };
}
function updateSpatialGuides(time = 0) {
  if (!guideGroup || !guideParts) return;
  const active = state.mode === 'training' && state.status === 'running' && selectedId && !state.installed.includes(selectedId) && !previewing;
  guideGroup.visible = !!active;
  if (!active) return;

  const part = PARTS.find(p => p.id === selectedId);
  const model = models.get(selectedId);
  if (!part || !model) { guideGroup.visible = false; return; }

  const pose = getPose(selectedId);
  const err = poseError(part, pose);
  const seqOk = part.prerequisites.every(id => state.installed.includes(id));
  const posOk = err.position <= LIMITS.position + 1e-10;
  const angOk = err.angle <= LIMITS.angle + 1e-9;

  const hex = !seqOk ? 0xf59e0b : (posOk && angOk) ? 0x2ef0a7 : posOk ? 0x45c8f5 : 0x5ce0c0;
  guideParts.tetherMat.color.setHex(hex);
  guideParts.tolRingMat.color.setHex(hex);

  // Visual height center (support bore is +0.20 above base; shaft/caps centered at root)
  const yBias = part.id.includes('support') ? 0.22 : 0;
  tempVecA.set(pose.position[0], pose.position[1] + yBias, pose.position[2]);
  tempVecB.set(part.position[0], part.position[1] + yBias, part.position[2]);

  const tPos = guideParts.tetherLine.geometry.attributes.position;
  tPos.setXYZ(0, tempVecA.x, tempVecA.y, tempVecA.z);
  tPos.setXYZ(1, tempVecB.x, tempVecB.y, tempVecB.z);
  tPos.needsUpdate = true;
  guideParts.tetherLine.visible = err.position > 0.004;

  // Height drop-line from part down to workbench tabletop (y = 0.869)
  const tableY = 0.869;
  const dPos = guideParts.dropLine.geometry.attributes.position;
  dPos.setXYZ(0, pose.position[0], Math.max(tableY, pose.position[1]), pose.position[2]);
  dPos.setXYZ(1, pose.position[0], tableY, pose.position[2]);
  dPos.needsUpdate = true;
  guideParts.dropLine.visible = pose.position[1] > tableY + 0.015;
  guideParts.dropRing.position.set(pose.position[0], tableY + 0.002, pose.position[2]);
  guideParts.dropRing.visible = true;

  // 55 mm tolerance zone ring projected on table or at target elevation
  const pulse = 1 + 0.05 * Math.sin(time * 0.005);
  guideParts.tolRing.position.set(part.position[0], Math.max(tableY + 0.003, part.position[1] - (part.id.includes('support') ? 0 : 0.075)), part.position[2]);
  guideParts.tolRing.scale.setScalar(pulse);
  guideParts.tolRingMat.opacity = posOk && angOk ? 0.72 : 0.38;

  // Coaxial bore centerline helpful for stage 2 & 3 parts
  guideParts.coaxialLine.visible = part.stage >= 2;

  // Update active ghost colors
  const ghost = ghosts.get(selectedId);
  if (ghost?.userData?.fillMat) {
    ghost.userData.fillMat.color.setHex(hex);
    ghost.userData.edgeMat.color.setHex(hex);
    ghost.userData.fillMat.opacity = posOk && angOk ? 0.25 + 0.05 * Math.sin(time * 0.007) : 0.16 + 0.03 * Math.sin(time * 0.004);
  }
}
function spawnPulseRing(position, colorHex = 0x3bf0b6) {
  if (!effectsGroup) return;
  const mat = new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.078, 36), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(position[0], Math.max(0.874, position[1] + 0.01), position[2]);
  effectsGroup.add(ring);
  pulseRings.push({ mesh: ring, mat, start: nowMs(), duration: 580 });
}
function scheduleSnapAnimation(id, fromWorldPos, fromWorldQuat) {
  const obj = models.get(id);
  const vr = obj?.userData?.visualRoot;
  if (!vr) return;
  obj.updateWorldMatrix(true, false);
  const invQuat = obj.getWorldQuaternion(new THREE.Quaternion()).invert();
  const localPos = obj.worldToLocal(fromWorldPos.clone());
  const localQuat = invQuat.multiply(fromWorldQuat.clone());
  vr.position.copy(localPos);
  vr.quaternion.copy(localQuat);
  snapAnimations.set(id, { vr, fromPos: localPos, fromQuat: localQuat, start: nowMs(), duration: 380 });
}
function scheduleShakeAnimation(id) {
  const obj = models.get(id);
  const vr = obj?.userData?.visualRoot;
  if (!vr) return;
  shakeAnimations.set(id, { vr, start: nowMs(), duration: 320 });
}
function updateAnimations(now) {
  for (const [id, anim] of snapAnimations.entries()) {
    const t = Math.min(1, (now - anim.start) / anim.duration);
    const ease = 1 - Math.pow(1 - t, 3);
    anim.vr.position.lerpVectors(anim.fromPos, tempVecA.set(0, 0, 0), ease);
    anim.vr.quaternion.slerpQuaternions(anim.fromQuat, worldQuaternion.identity(), ease);
    if (t >= 1) {
      anim.vr.position.set(0, 0, 0);
      anim.vr.quaternion.identity();
      snapAnimations.delete(id);
    }
  }
  for (const [id, anim] of shakeAnimations.entries()) {
    const t = Math.min(1, (now - anim.start) / anim.duration);
    if (t >= 1) {
      anim.vr.position.set(0, 0, 0);
      shakeAnimations.delete(id);
    } else {
      anim.vr.position.set(Math.sin(t * Math.PI * 6) * (1 - t) * 0.018, 0, 0);
    }
  }
  for (let i = pulseRings.length - 1; i >= 0; i--) {
    const p = pulseRings[i];
    const t = Math.min(1, (now - p.start) / p.duration);
    const ease = 1 - Math.pow(1 - t, 2);
    p.mesh.scale.setScalar(1 + ease * 2.4);
    p.mat.opacity = (1 - t) * 0.85;
    if (t >= 1) {
      effectsGroup.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
      pulseRings.splice(i, 1);
    }
  }
}
function applyPreviewPoses(factor, stageOverride = null) {
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const smooth = v => v * v * (3 - 2 * v);
  for (const part of PARTS) {
    const item = previewParts.get(part.id);
    if (!item) continue;
    let f = factor;
    if (stageOverride !== null) {
      // stageOverride in [0, 3]: 0 = all exploded; 1 = stage 1 installed; 2 = stage 1+2 installed; 3 = all assembled
      if (part.stage === 1) f = 1 - smooth(clamp01(stageOverride));
      else if (part.stage === 2) f = 1 - smooth(clamp01(stageOverride - 1));
      else f = 1 - smooth(clamp01(stageOverride - 2));
    }
    const off = explodedOffsets[part.id];
    item.position.set(
      part.position[0] + off[0] * f,
      part.position[1] + off[1] * f,
      part.position[2] + off[2] * f,
    );
    item.quaternion.set(...part.quaternion);
  }
  if (explodeLines) {
    explodeLines.visible = stageOverride !== null ? stageOverride < 2.95 : factor > 0.03;
  }
}
function updateShowcaseDemo(dtSec) {
  if (!previewing) return;
  if (demoPlaying) {
    demoElapsed += dtSec;
    const cycle = 9.2;
    if (demoElapsed >= cycle) {
      demoElapsed = cycle;
      demoPlaying = false;
      const playBtn = $('demoPlayBtn');
      if (playBtn) playBtn.textContent = '重新演示 ▶';
    }
    // 0..1.4s hold exploded -> 1.4..3.8s stage 1 -> 3.8..6.4s stage 2 -> 6.4..8.8s stage 3
    let progress = 0;
    if (demoElapsed < 1.4) progress = 0;
    else if (demoElapsed < 3.8) progress = (demoElapsed - 1.4) / 2.4;
    else if (demoElapsed < 6.4) progress = 1 + (demoElapsed - 3.8) / 2.6;
    else progress = 2 + Math.min(1, (demoElapsed - 6.4) / 2.4);

    demoProgress = progress;
    applyPreviewPoses(0, demoProgress);
    const stageIdx = progress < 0.05 ? 0 : progress < 1.05 ? 1 : progress < 2.05 ? 2 : 3;
    demoStage = stageIdx;
    const cap = $('showcaseCaption');
    if (cap) cap.textContent = demoCaptions[stageIdx];
    const slider = $('explodeSlider'), val = $('explodeValue');
    const approxExplode = Math.round((1 - progress / 3) * 100);
    if (slider) slider.value = String(approxExplode);
    if (val) val.textContent = `${approxExplode}%`;
  } else if (demoProgress !== null) {
    applyPreviewPoses(0, demoProgress);
  } else {
    explodeFactor += (targetExplode - explodeFactor) * Math.min(1, dtSec * 12);
    applyPreviewPoses(explodeFactor, null);
  }
}
function setExplodePercent(pct) {
  demoPlaying = false;
  demoProgress = null;
  demoElapsed = 0;
  demoStage = 0;
  const playBtn = $('demoPlayBtn');
  if (playBtn) playBtn.textContent = '分步演示 ▶';
  targetExplode = Math.max(0, Math.min(100, Number(pct))) / 100;
  explodeFactor = targetExplode;
  applyPreviewPoses(explodeFactor, null);
  const slider = $('explodeSlider'), val = $('explodeValue'), cap = $('showcaseCaption');
  if (slider) slider.value = String(Math.round(targetExplode * 100));
  if (val) val.textContent = `${Math.round(targetExplode * 100)}%`;
  if (cap) {
    cap.textContent = targetExplode < 0.05
      ? '成品合装态 · 拖动滑块观察爆炸拆解，或播放三阶段装配演示'
      : targetExplode > 0.85
        ? demoCaptions[0]
        : `爆炸拆解展开 ${Math.round(targetExplode * 100)}% · 观察支架、转轴与锁紧盖的同轴装配路径`;
  }
}
function toggleDemoPlay() {
  if (!previewing) return;
  if (demoPlaying) {
    demoPlaying = false;
    const playBtn = $('demoPlayBtn');
    if (playBtn) playBtn.textContent = '继续演示 ▶';
    return;
  }
  if (demoElapsed >= 9.2) demoElapsed = 0;
  demoPlaying = true;
  const playBtn = $('demoPlayBtn');
  if (playBtn) playBtn.textContent = '暂停演示 ⏸';
  playSound('select');
}
function stepShowcaseStage() {
  if (!previewing) return;
  demoPlaying = false;
  const playBtn = $('demoPlayBtn');
  if (playBtn) playBtn.textContent = '分步演示 ▶';
  demoStage = (demoStage + 1) % 4;
  const progress = demoStage;
  demoProgress = progress;
  demoElapsed = [0, 3.8, 6.4, 9.2][demoStage];
  applyPreviewPoses(0, progress);
  const approxExplode = Math.round((1 - progress / 3) * 100);
  targetExplode = approxExplode / 100;
  explodeFactor = targetExplode;
  const slider = $('explodeSlider'), val = $('explodeValue'), cap = $('showcaseCaption');
  if (slider) slider.value = String(approxExplode);
  if (val) val.textContent = `${approxExplode}%`;
  if (cap) cap.textContent = demoCaptions[demoStage];
  playSound('select');
}
function resetModels() {
  releaseAll();
  snapAnimations.clear();
  shakeAnimations.clear();
  PARTS.forEach((part, i) => {
    const obj = models.get(part.id);
    if (!obj) return;
    obj.position.set(...initialPoses[i].p);
    obj.rotation.set(0, THREE.MathUtils.degToRad(initialPoses[i].a), 0);
    obj.scale.setScalar(1);
    if (obj.userData?.visualRoot) {
      obj.userData.visualRoot.position.set(0, 0, 0);
      obj.userData.visualRoot.quaternion.identity();
    }
  });
  selectedId = null;
  dragging = false;
  hoverId = null;
  updateGhosts();
}
function updateCamera() {
  if (!camera) return;
  camera.position.set(
    cameraTarget.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    cameraTarget.y + orbit.radius * Math.cos(orbit.phi),
    cameraTarget.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
  );
  camera.lookAt(cameraTarget);
}
function setCamera(view, instant = false) {
  if (renderer?.xr?.isPresenting) return;
  const presets = {
    top: { theta: 0, phi: 0.08, radius: 3.16, look: [0, 0.94, 0.04] },
    front: { theta: 0, phi: 1.24, radius: 3.05, look: [0, 1.02, -0.05] },
    side: { theta: 1.48, phi: 1.12, radius: 3.12, look: [0, 1.02, -0.05] },
    perspective: { theta: 0.24, phi: 0.96, radius: 3.18, look: [0, 0.99, 0.02] },
  };
  const preset = presets[view] || presets.perspective;
  targetOrbit = { theta: preset.theta, phi: preset.phi, radius: preset.radius };
  targetLookAt.set(...preset.look);
  if (instant) {
    orbit = { ...targetOrbit };
    cameraTarget.copy(targetLookAt);
    cameraEasing = false;
    updateCamera();
  } else {
    cameraEasing = true;
  }
  queryAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}
function focusSelectedPart() {
  if (renderer?.xr?.isPresenting || !selectedId || !models.has(selectedId)) return;
  const pose = getPose(selectedId);
  targetLookAt.set(pose.position[0], pose.position[1] + (selectedId.includes('support') ? 0.18 : 0), pose.position[2]);
  targetOrbit = { theta: 0.34, phi: 1.02, radius: 1.85 };
  cameraEasing = true;
  queryAll('[data-view]').forEach(b => b.classList.remove('active'));
  playSound('select');
}
function updateGhosts() {
  if (!ghostRoot) return;
  ghostRoot.visible = state.mode === 'training' && !previewing && state.status !== 'completed';
  for (const part of PARTS) {
    const g = ghosts.get(part.id);
    if (!g) continue;
    g.visible = !state.installed.includes(part.id) && (selectedId ? part.id === selectedId : true);
    if (g.userData?.fillMat && (!selectedId || part.id !== selectedId)) {
      g.userData.fillMat.color.setHex(0x64e6be);
      g.userData.edgeMat.color.setHex(0x7ef2cf);
      g.userData.fillMat.opacity = 0.16;
    }
  }
  if (partsRoot) partsRoot.visible = !previewing;
  if (previewRoot) previewRoot.visible = previewing;
  if (guideGroup && !ghostRoot.visible) guideGroup.visible = false;
  updateSpatialGuides(nowMs());
}
function selectPart(id) {
  if (previewing || state.installed.includes(id)) return;
  const changed = selectedId !== id;
  selectedId = id;
  if (changed) playSound('select');
  updateGhosts();
  updateUI(true);
}
function getPose(id) {
  const obj = models.get(id);
  obj.updateWorldMatrix(true, false);
  obj.getWorldPosition(worldPosition);
  obj.getWorldQuaternion(worldQuaternion);
  return { position: worldPosition.toArray(), quaternion: worldQuaternion.toArray() };
}
function updateUI(force = false) {
  const now = Date.now();
  if (!force && now - lastUI < 100) return;
  lastUI = now;
  const timerEl = $('timer');
  if (!timerEl) return;

  timerEl.textContent = fmtTime(elapsedSeconds(state, now));
  const result = calculateScore(state, now);
  $('score').replaceChildren(document.createTextNode(result.score));
  const small = document.createElement('small');
  small.textContent = ' / 100';
  $('score').append(small);
  $('scoreLabel').textContent = state.status === 'completed' ? '最终分数' : '当前分数';
  $('progressCount').textContent = `${state.installed.length} / 5`;
  $('progressFill').style.width = `${state.installed.length * 20}%`;

  const currentStage = PARTS.find(p => !state.installed.includes(p.id))?.stage;
  queryAll('[data-stage]').forEach(step => {
    const stageParts = PARTS.filter(p => p.stage === Number(step.dataset.stage));
    const count = stageParts.filter(p => state.installed.includes(p.id)).length;
    step.classList.toggle('complete', count === stageParts.length);
    step.classList.toggle('current', Number(step.dataset.stage) === currentStage);
    step.querySelector('small').textContent = `${count} / ${stageParts.length}`;
    if (Number(step.dataset.stage) === currentStage) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });

  for (const type of ['sequence', 'position', 'orientation']) $(`${type}Errors`).textContent = state.errors[type];
  $('trainingMode').classList.toggle('active', state.mode === 'training');
  $('assessmentMode').classList.toggle('active', state.mode === 'assessment');
  $('trainingMode').disabled = state.status === 'running';
  $('assessmentMode').disabled = state.status === 'running';
  $('modeDescription').textContent = state.mode === 'training'
    ? '显示全息目标轮廓、3D 空间引导线与实时容差提示，逐步掌握装配流程。'
    : '隐藏目标轮廓、3D 引导线与实时偏差，独立完成装配并记录成绩。';
  $('startBtn').disabled = state.status === 'running';
  $('startBtn').innerHTML = state.status === 'running'
    ? '实验进行中 <span>●</span>'
    : state.status === 'completed'
      ? '再练习一次 <span>→</span>'
      : '开始实验 <span>→</span>';

  const canEdit = state.status === 'running' && selectedId && !state.installed.includes(selectedId) && !heldBy.has(selectedId) && !previewing && !renderer?.xr?.isPresenting;
  $('placeBtn').disabled = !canEdit;
  queryAll('[data-nudge],[data-rotate],#rotationAxis').forEach(b => b.disabled = !canEdit);
  const focusBtn = $('focusBtn');
  if (focusBtn) focusBtn.disabled = !selectedId || previewing || !!renderer?.xr?.isPresenting;

  $('previewBtn').disabled = state.mode === 'assessment' && state.status === 'running';
  $('previewBtn').textContent = previewing ? '返回操作' : '结构展示';
  $('previewBtn').classList.toggle('active', previewing);
  if ($('showcaseBar')) $('showcaseBar').hidden = !previewing;
  if ($('sceneBottom')) $('sceneBottom').hidden = previewing;
  if ($('sceneMode') && !renderer?.xr?.isPresenting) {
    $('sceneMode').textContent = previewing ? '结构展示模式' : '桌面操作';
  }

  const part = PARTS.find(p => p.id === selectedId);
  const showChecks = state.status === 'running' && state.mode === 'training' && part && !state.installed.includes(selectedId) && !previewing;
  $('alignmentChecks').hidden = !showChecks;
  if (showChecks) {
    const error = poseError(part, getPose(selectedId));
    const sequenceReady = part.prerequisites.every(id => state.installed.includes(id));
    const posReady = error.position <= LIMITS.position + 1e-10;
    const angReady = error.angle <= LIMITS.angle + 1e-9;
    for (const [id, ready, label] of [
      ['sequenceCheck', sequenceReady, '工序'],
      ['positionCheck', posReady, '位置'],
      ['orientationCheck', angReady, '朝向'],
    ]) {
      $(id).textContent = `${ready ? '✓' : '○'} ${label}${ready ? '符合' : '待调整'}`;
      $(id).classList.toggle('ready', ready);
    }
    const posFill = $('posMeterFill'), angFill = $('angMeterFill');
    if (posFill) {
      const pct = Math.max(6, Math.min(100, Math.round((1 - Math.min(error.position, 0.8) / 0.8) * 100)));
      posFill.style.width = `${posReady ? 100 : pct}%`;
      posFill.classList.toggle('ready', posReady);
    }
    if (angFill) {
      const pct = Math.max(6, Math.min(100, Math.round((1 - Math.min(error.angle, 90) / 90) * 100)));
      angFill.style.width = `${angReady ? 100 : pct}%`;
      angFill.classList.toggle('ready', angReady);
    }
  }

  $('selectedName').textContent = previewing
    ? '结构展示（不计成绩）'
    : part ? part.name : state.status === 'completed' ? '全部装配完成' : '尚未选择';

  if (previewing) {
    $('poseInfo').textContent = '可自由环视缩放、拖动爆炸滑块或播放分步装配演示';
  } else if (part && models.has(selectedId) && state.mode === 'training' && !state.installed.includes(selectedId)) {
    const pose = getPose(selectedId), error = poseError(part, pose);
    const dy = (part.position[1] - pose.position[1]) * 1000;
    $('poseInfo').textContent = `距离 ${Math.round(error.position * 1000)} mm · 姿态 ${Math.round(error.angle)}° · 高度${Math.abs(dy) < 1 ? '已对齐' : `${dy > 0 ? '需升' : '需降'} ${Math.round(Math.abs(dy))} mm`}`;
  } else {
    $('poseInfo').textContent = state.status === 'completed'
      ? '可以环视观察成品组件，或导出本次结构化 JSON 记录'
      : state.mode === 'assessment'
        ? '考核模式：隐藏全部空间辅助，根据结构基准独立对齐'
        : '开始实验后，点击实验台零件或右侧任务卡片';
  }

  const available = getAvailableParts(state).map(p => p.id);
  for (const p of PARTS) {
    const card = $(`part-${p.id}`), done = state.installed.includes(p.id);
    if (!card) continue;
    card.classList.toggle('selected', selectedId === p.id && !done);
    card.classList.toggle('done', done);
    card.disabled = done || previewing;
    card.querySelector('.part-icon').textContent = done ? '✓' : p.id.includes('support') ? 'Π' : p.id === 'shaft' ? '━' : '⬡';
    card.querySelector('.part-state').textContent = done ? '已完成' : selectedId === p.id ? '已选择' : available.includes(p.id) ? '可装配' : '待前置';
  }
}
function buildPartList() {
  const list = $('partsList');
  if (!list) return;
  for (const [i, part] of PARTS.entries()) {
    const button = document.createElement('button');
    button.id = `part-${part.id}`;
    button.className = 'part-card';
    const icon = document.createElement('span');
    icon.className = 'part-icon';
    const copy = document.createElement('span');
    copy.className = 'part-copy';
    const title = document.createElement('strong');
    title.textContent = `${String(i + 1).padStart(2, '0')}  ${part.name}`;
    const sub = document.createElement('small');
    sub.textContent = part.stage === 1 ? '阶段一 · 固定支撑结构' : part.stage === 2 ? '阶段二 · 穿入中心转轴' : '阶段三 · 固定轴端';
    copy.append(title, sub);
    const status = document.createElement('span');
    status.className = 'part-state';
    button.append(icon, copy, status);
    button.addEventListener('click', () => selectPart(part.id));
    list.append(button);
  }
}
function canMove() {
  return state.status === 'running' && selectedId && !state.installed.includes(selectedId) && !heldBy.has(selectedId) && !previewing && !renderer?.xr?.isPresenting;
}
function nudge(axis, sign, fast = false) {
  if (!canMove()) return;
  const obj = models.get(selectedId);
  obj.position[axis] += sign * (fast ? 0.05 : 0.01);
  clampPart(obj);
  updateSpatialGuides(nowMs());
  updateUI(true);
}
function clampPart(obj) {
  obj.position.x = THREE.MathUtils.clamp(obj.position.x, -1.46, 1.46);
  obj.position.z = THREE.MathUtils.clamp(obj.position.z, -0.76, 1.06);
  obj.position.y = THREE.MathUtils.clamp(obj.position.y, 0.86, 1.72);
}
function rotatePart(sign) {
  if (!canMove()) return;
  const axis = $('rotationAxis').value;
  const v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  models.get(selectedId).rotateOnWorldAxis(v, sign * Math.PI / 12);
  updateSpatialGuides(nowMs());
  updateUI(true);
}
function attemptPlacement(id = selectedId, sourceController = null) {
  if (!id || previewing || heldBy.has(id)) return;
  const obj = models.get(id);
  const prePose = getPose(id);
  const result = evaluatePlacement(state, id, prePose);
  state = result.state;
  if (result.outcome.ok) {
    const part = PARTS.find(p => p.id === id);
    const fromPos = new THREE.Vector3(...prePose.position);
    const fromQuat = new THREE.Quaternion(...prePose.quaternion);
    partsRoot.attach(obj);
    obj.position.set(...part.position);
    obj.quaternion.set(...part.quaternion);
    scheduleSnapAnimation(id, fromPos, fromQuat);
    spawnPulseRing(part.position, 0x3bf0b6);
    triggerHaptic(sourceController, 0.82, 95);

    const nextParts = getAvailableParts(state).map(p => p.name).join('或');
    setFeedback(
      `${part.name}装配成功`,
      state.status === 'completed'
        ? '全部五个零件已精准入位，可以环视检查成品或导出本次 JSON 记录。'
        : `已平滑锁定至目标位姿。接下来可安装${nextParts}。`,
      'success',
    );
    selectedId = null;
    if (state.status === 'completed') {
      playSound('complete');
      completeSession();
    } else {
      playSound('snap');
    }
  } else if (errorText[result.outcome.reason]) {
    const [title, standardDetail] = errorText[result.outcome.reason];
    const pending = PARTS.find(p => p.id === id)?.prerequisites
      .filter(dep => !state.installed.includes(dep))
      .map(dep => PARTS.find(p => p.id === dep).name)
      .join('和');
    const detail = result.outcome.reason === 'sequence'
      ? `请先安装${pending}，再回来安装这个零件。`
      : state.mode === 'assessment' && result.outcome.reason === 'position'
        ? '将零件移近对应安装位置；可以用方向键按钮微调，然后再次确认。'
        : standardDetail;
    const hint = state.mode === 'training' && result.outcome.valid
      ? ` 当前偏差 ${Math.round(result.outcome.position * 1000)} mm / ${Math.round(result.outcome.angle)}°。`
      : '';
    setFeedback(title, detail + hint, 'warning');
    scheduleShakeAnimation(id);
    playSound('error');
    triggerHaptic(sourceController, 0.55, 120);
  }
  updateGhosts();
  updateUI(true);
  drawHUD();
}
function readHistory() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value.filter(x => x && x.status === 'completed' && typeof x.score === 'number').slice(0, 5) : [];
  } catch { return []; }
}
function clearHistory() {
  if (typeof localStorage !== 'undefined') {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  }
  updateHistory();
  setFeedback('本机历史记录已清除', '浏览器中保存的历史完成记录已清空，不影响当前实验状态。');
}
function updateHistory() {
  const list = $('historyList'), count = $('historyCount'), clearBtn = $('clearHistoryBtn');
  if (!list || !count) return;
  const items = readHistory();
  count.textContent = items.length;
  if (clearBtn) clearBtn.hidden = items.length === 0;
  list.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '完成一次实验后，这里会显示本机记录。';
    list.append(p);
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const label = document.createElement('span');
    label.textContent = `${new Date(item.completedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${item.mode === 'assessment' ? '考核' : '训练'}`;
    const value = document.createElement('strong');
    value.textContent = `${item.score} 分 · ${fmtTime(item.elapsedSeconds)}`;
    row.append(label, value);
    list.append(row);
  }
}
function completeSession() {
  const result = buildResult(state);
  lastSavedResult = result;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify([result, ...readHistory()].slice(0, 5)));
    } catch {
      setFeedback('实验已完成', '浏览器未允许本地保存，请使用“导出记录”保存本次成绩。', 'success');
    }
  }
  updateHistory();
  $('finalScore').textContent = result.score;
  $('resultSummary').textContent = `${state.mode === 'training' ? '训练模式' : '考核模式'} · 已完成 5 / 5 · 用时 ${fmtTime(result.elapsedSeconds)}`;
  $('resultDetails').replaceChildren();
  const lines = [
    `顺序错误 ${state.errors.sequence} 次 · 位置错误 ${state.errors.position} 次 · 姿态错误 ${state.errors.orientation} 次`,
    `操作扣分 ${result.deductions.errors} 分 · 时间扣分 ${result.deductions.time} 分`,
    `本次共提交 ${state.attempts.length} 次装配操作，导出 JSON 可复核每次位姿误差。`,
  ];
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    $('resultDetails').append(div);
  }
  if (!renderer?.xr?.isPresenting) $('resultDialog')?.showModal?.();
}
function exportRecord(useCompleted = false) {
  const record = useCompleted && lastSavedResult ? lastSavedResult : buildResult(state);
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = `装配记录_${record.mode}_${record.status}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function resetSession(mode = state.mode, start = false) {
  releaseAll();
  previewing = false;
  demoPlaying = false;
  demoProgress = null;
  demoElapsed = 0;
  demoStage = 0;
  state = createSession(mode);
  if (start) state = startSession(state);
  resetModels();
  $('resultDialog')?.close?.();
  setFeedback(
    start ? '实验已开始' : '准备好开始了吗？',
    start ? startHint() : '可先点“结构展示”查看爆炸拆解与分步动画，再点击“开始实验”按支架 → 转轴 → 锁紧盖完成装配。',
  );
  updateGhosts();
  updateUI(true);
  drawHUD();
}
function startHint() {
  return state.mode === 'training'
    ? '先选择左支架或右支架。参考 3D 引导线拖动到全息轮廓处，Q / E 旋转后按 Enter 确认。'
    : '先选择左支架或右支架。根据安装基座位置与零件方向独立对齐后按 Enter 确认。';
}
function beginSession() {
  if (state.status === 'completed') { resetSession(state.mode, true); return; }
  previewing = false;
  demoPlaying = false;
  state = startSession(state);
  playSound('select');
  setFeedback('实验已开始', startHint());
  updateGhosts();
  updateUI(true);
  drawHUD();
}
function togglePreview() {
  if (renderer?.xr?.isPresenting || (state.mode === 'assessment' && state.status === 'running')) return;
  dragging = false;
  previewing = !previewing;
  demoPlaying = false;
  if (previewing) {
    demoElapsed = 0;
    demoStage = 0;
    setExplodePercent(0);
    setCamera('perspective');
  }
  playSound('select');
  updateGhosts();
  updateUI(true);
  setFeedback(
    previewing ? '已进入三维结构展示模式' : '已返回交互实验台',
    previewing
      ? '可拖动底部“爆炸拆解”滑块或点击“分步演示”展示三阶段装配结构；本模式不计入实验成绩。'
      : state.status === 'running'
        ? '继续选择零件，拖动并调整姿态后确认装配。'
        : '点击“开始实验”即可开展实操练习或考核。',
  );
}
function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
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
    pointerOrigin = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 2 || e.button === 1) { orbiting = true; cameraEasing = false; return; }
    if (e.button !== 0 || previewing) return;
    pointerRay(e);
    const hit = pickPart();
    if (hit) {
      const id = hit.object.userData.partId;
      selectPart(id);
      if (state.status !== 'running') {
        setFeedback('零件已选中', state.mode === 'training' ? '点击右侧“开始实验”，然后拖动到目标轮廓处。' : '点击右侧“开始实验”，然后拖动到安装区对应位置。');
        return;
      }
      const obj = models.get(id);
      dragPlane.set(new THREE.Vector3(0, 1, 0), -obj.position.y);
      const point = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane, point)) {
        dragOffset.copy(obj.position).sub(point);
        dragging = true;
      }
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (renderer.xr.isPresenting) return;
    if (orbiting && pointerOrigin) {
      orbit.theta -= (e.clientX - pointerOrigin.x) * 0.006;
      orbit.phi = THREE.MathUtils.clamp(orbit.phi - (e.clientY - pointerOrigin.y) * 0.005, 0.08, 1.42);
      targetOrbit = { ...orbit };
      pointerOrigin = { x: e.clientX, y: e.clientY };
      updateCamera();
      return;
    }
    pointerRay(e);
    if (dragging && canMove()) {
      const point = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane, point)) {
        const obj = models.get(selectedId);
        obj.position.copy(point).add(dragOffset);
        clampPart(obj);
        updateUI();
      }
    } else {
      const hit = previewing ? null : pickPart();
      hoverId = hit?.object.userData.partId || null;
      canvas.style.cursor = hit ? 'grab' : orbiting ? 'grabbing' : 'default';
    }
  });
  const endPointer = () => { dragging = false; orbiting = false; pointerOrigin = null; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  canvas.addEventListener('wheel', e => {
    if (renderer.xr.isPresenting) return;
    e.preventDefault();
    cameraEasing = false;
    orbit.radius = THREE.MathUtils.clamp(orbit.radius + e.deltaY * 0.0025, 1.55, 5.6);
    targetOrbit.radius = orbit.radius;
    updateCamera();
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea') || $('helpDialog').open || $('resultDialog').open || renderer.xr.isPresenting) return;
    if (e.key === '?') { $('helpDialog').showModal(); return; }
    const key = e.key.toLowerCase();
    const moves = {
      w: ['z', -1], s: ['z', 1], a: ['x', -1], d: ['x', 1], r: ['y', 1], f: ['y', -1],
      arrowup: ['z', -1], arrowdown: ['z', 1], arrowleft: ['x', -1], arrowright: ['x', 1],
    };
    if (moves[key] && canMove()) { e.preventDefault(); nudge(...moves[key], e.shiftKey); }
    if ((key === 'q' || key === 'e') && canMove()) { e.preventDefault(); rotatePart(key === 'q' ? -1 : 1); }
    if (e.key === 'Enter' && canMove() && !e.repeat) { e.preventDefault(); attemptPlacement(); }
  });
}
function wireUI() {
  buildPartList();
  $('helpBtn').onclick = () => $('helpDialog').showModal();
  queryAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).close());
  queryAll('dialog').forEach(d => d.addEventListener('click', e => {
    if (e.target === d) {
      const rect = d.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) d.close();
    }
  }));
  $('trainingMode').onclick = () => { if (state.status !== 'running') resetSession('training'); };
  $('assessmentMode').onclick = () => { if (state.status !== 'running') resetSession('assessment'); };
  $('startBtn').onclick = beginSession;
  $('resetBtn').onclick = () => resetSession(state.mode);
  $('exportBtn').onclick = () => exportRecord();
  $('resultExport').onclick = () => exportRecord(true);
  $('placeBtn').onclick = () => attemptPlacement();
  $('previewBtn').onclick = togglePreview;
  if ($('focusBtn')) $('focusBtn').onclick = focusSelectedPart;
  if ($('soundBtn')) {
    $('soundBtn').onclick = () => {
      soundEnabled = !soundEnabled;
      $('soundBtn').textContent = soundEnabled ? '音效 开' : '音效 关';
      $('soundBtn').classList.toggle('active', soundEnabled);
      $('soundBtn').setAttribute('aria-pressed', String(soundEnabled));
      if (soundEnabled) playSound('select');
    };
  }
  if ($('perfBtn')) {
    $('perfBtn').onclick = () => {
      perfVisible = !perfVisible;
      $('perfOverlay').hidden = !perfVisible;
      $('perfBtn').classList.toggle('active', perfVisible);
      $('perfBtn').setAttribute('aria-pressed', String(perfVisible));
      if (perfVisible) {
        lastPerf = 0;
        updatePerfMonitor(nowMs(), 16.7, true);
      }
    };
  }
  if ($('explodeSlider')) $('explodeSlider').addEventListener('input', e => setExplodePercent(e.target.value));
  if ($('demoPlayBtn')) $('demoPlayBtn').onclick = toggleDemoPlay;
  if ($('demoStepBtn')) $('demoStepBtn').onclick = stepShowcaseStage;
  if ($('demoResetBtn')) $('demoResetBtn').onclick = () => setExplodePercent(0);
  if ($('clearHistoryBtn')) $('clearHistoryBtn').onclick = clearHistory;

  queryAll('[data-view]').forEach(b => b.onclick = () => setCamera(b.dataset.view));
  queryAll('[data-nudge]').forEach(b => b.onclick = e => nudge(b.dataset.nudge[0], b.dataset.nudge[1] === '+' ? 1 : -1, e.shiftKey));
  queryAll('[data-rotate]').forEach(b => b.onclick = () => rotatePart(Number(b.dataset.rotate)));
}

// Spatial 3D panel rendered onto a CanvasTexture so status and controls remain crisp inside a headset.
function createHUD() {
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = 1024; hudCanvas.height = 640;
  hudContext = hudCanvas.getContext('2d');
  hudTexture = new THREE.CanvasTexture(hudCanvas);
  hudTexture.colorSpace = THREE.SRGBColorSpace;
  hud = new THREE.Mesh(
    new THREE.PlaneGeometry(1.22, 0.7625),
    new THREE.MeshBasicMaterial({ map: hudTexture, side: THREE.DoubleSide }),
  );
  hud.position.set(0, 1.60, -0.94);
  hud.visible = false;
  scene.add(hud);
  drawHUD();
}
function drawHUD(hoverBtn = -1) {
  if (!hudContext) return;
  const ctx = hudContext;
  ctx.fillStyle = '#112630';
  ctx.fillRect(0, 0, 1024, 640);
  ctx.strokeStyle = '#336b75';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, 1008, 624);

  ctx.fillStyle = '#5ee0be';
  ctx.font = '600 22px "Microsoft YaHei", sans-serif';
  ctx.fillText('VIRTUAL ASSEMBLY LAB  ·  WEBXR SPATIAL HUD', 42, 48);

  ctx.fillStyle = '#effaf8';
  ctx.font = '700 40px "Microsoft YaHei", sans-serif';
  ctx.fillText('双支架转轴组件装配训练', 42, 104);

  // Stage progress badges
  const stages = [
    { n: '1 支架', ids: ['left-support', 'right-support'] },
    { n: '2 转轴', ids: ['shaft'] },
    { n: '3 锁紧盖', ids: ['left-cap', 'right-cap'] },
  ];
  stages.forEach((st, i) => {
    const done = st.ids.filter(id => state.installed.includes(id)).length;
    const ok = done === st.ids.length;
    const x = 42 + i * 316;
    ctx.fillStyle = ok ? '#185449' : '#1b3844';
    ctx.fillRect(x, 128, 296, 46);
    ctx.fillStyle = ok ? '#7cf0cb' : '#b8d4db';
    ctx.font = '600 22px "Microsoft YaHei", sans-serif';
    ctx.fillText(`${ok ? '✓' : '○'} ${st.n}  (${done}/${st.ids.length})`, x + 18, 159);
  });

  ctx.font = '24px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#a4c4cb';
  ctx.fillText(`${state.mode === 'training' ? '训练模式' : '考核模式'}   用时 ${fmtTime(elapsedSeconds(state))}   进度 ${state.installed.length}/5   分数 ${calculateScore(state).score}`, 42, 214);

  ctx.fillStyle = '#def0ee';
  ctx.font = '24px "Microsoft YaHei", sans-serif';
  const next = getAvailableParts(state).map(p => p.name).join(' / ');
  ctx.fillText(
    state.status === 'completed'
      ? '装配完成！退出 VR 后可在桌面端导出完整 JSON 记录。'
      : state.status === 'idle'
        ? '控制器射线指向下方“开始实验”并按扳机开始。'
        : `当前可装配：${next}`,
    42, 260,
  );

  ctx.fillStyle = '#86aab5';
  ctx.font = '21px "Microsoft YaHei", sans-serif';
  ctx.fillText('按住扳机抓取并旋转零件，松开扳机即提交判定（支持手柄触觉脉冲反馈）。', 42, 302);
  ctx.fillText(`分类错误：顺序 ${state.errors.sequence}  ·  位置 ${state.errors.position}  ·  姿态 ${state.errors.orientation}`, 42, 340);

  const feedback = $('feedback')?.querySelector('strong')?.textContent || '';
  ctx.fillStyle = '#8ce4c6';
  ctx.font = '600 26px "Microsoft YaHei", sans-serif';
  ctx.fillText(feedback, 42, 388);

  if (selectedId && state.mode === 'training' && models.has(selectedId)) {
    const p = PARTS.find(part => part.id === selectedId);
    const error = poseError(p, getPose(selectedId));
    const okPos = error.position <= LIMITS.position + 1e-10;
    const okAng = error.angle <= LIMITS.angle + 1e-9;
    ctx.font = '22px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = okPos && okAng ? '#5cf0bf' : '#b7d4da';
    ctx.fillText(
      `当前件：${p.name}  距离 ${Math.round(error.position * 1000)} mm (${okPos ? '合格' : '≤55'})  姿态 ${Math.round(error.angle)}° (${okAng ? '合格' : '≤12°'})`,
      42, 434,
    );
  }

  const buttons = [
    { x: 42, text: state.status === 'running' ? '重新开始' : state.status === 'completed' ? '再练习一次' : '开始实验' },
    { x: 356, text: state.mode === 'training' ? '切换考核' : '切换训练' },
    { x: 670, text: '退出 VR' },
  ];
  for (const [index, b] of buttons.entries()) {
    const disabled = index === 1 && state.status === 'running';
    const hovered = hoverBtn === index && !disabled;
    ctx.fillStyle = disabled ? '#243a44' : hovered ? '#24a58f' : index === 0 ? '#167d6d' : '#315461';
    ctx.fillRect(b.x, 474, 282, 85);
    if (hovered) {
      ctx.strokeStyle = '#9cf5da';
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x + 2, 476, 278, 81);
    }
    ctx.fillStyle = disabled ? '#718c94' : '#f1fbf9';
    ctx.font = '600 27px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.text, b.x + 141, 527);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = '#6a94a0';
  ctx.font = '19px "Microsoft YaHei", sans-serif';
  ctx.fillText('同阶段左右件可交换先后 · 训练轮廓与 3D 引导线仅在训练模式显示', 42, 606);
  hudTexture.needsUpdate = true;
}
function setControllerRay(controller) {
  controller.updateWorldMatrix(true, false);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(new THREE.Quaternion())).normalize();
}
function hudButtonAtUV(uv) {
  if (!uv) return -1;
  const x = uv.x * 1024, y = (1 - uv.y) * 640;
  if (y < 474 || y > 559) return -1;
  if (x >= 42 && x <= 324) return 0;
  if (x >= 356 && x <= 638) return 1;
  if (x >= 670 && x <= 952) return 2;
  return -1;
}
function activateHUD(uv, controller = null) {
  const idx = hudButtonAtUV(uv);
  if (idx === -1) return;
  triggerHaptic(controller, 0.3, 35);
  if (idx === 0) {
    if (state.status === 'running') resetSession(state.mode);
    else beginSession();
  } else if (idx === 1 && state.status !== 'running') {
    resetSession(state.mode === 'training' ? 'assessment' : 'training');
  } else if (idx === 2) {
    renderer.xr.getSession()?.end();
  }
  drawHUD();
}
function grab(controller) {
  if (!renderer.xr.isPresenting) return;
  setControllerRay(controller);
  const hudHit = raycaster.intersectObject(hud, false)[0], hit = pickPart();
  if (hudHit && (!hit || hudHit.distance < hit.distance)) { activateHUD(hudHit.uv, controller); return; }
  if (state.status !== 'running' || !hit) return;
  const id = hit.object.userData.partId;
  if (heldBy.has(id) || controller.userData.heldPart) return;
  const obj = models.get(id);
  heldBy.set(id, controller);
  controller.userData.heldPart = id;
  controller.userData.beforeGrab = { position: obj.position.clone(), quaternion: obj.quaternion.clone() };
  controller.attach(obj);
  selectedId = id;
  triggerHaptic(controller, 0.35, 35);
  playSound('select');
  updateGhosts();
  updateUI(true);
  drawHUD();
}
function release(controller, evaluate = true, restore = false) {
  const id = controller.userData.heldPart;
  if (!id) return;
  const obj = models.get(id);
  partsRoot.attach(obj);
  if (restore && controller.userData.beforeGrab) {
    obj.position.copy(controller.userData.beforeGrab.position);
    obj.quaternion.copy(controller.userData.beforeGrab.quaternion);
  }
  heldBy.delete(id);
  delete controller.userData.heldPart;
  delete controller.userData.beforeGrab;
  if (evaluate) {
    attemptPlacement(id, controller);
    if (!state.installed.includes(id)) clampPart(obj);
  }
}
function releaseAll() {
  for (const c of controllers) release(c, false, true);
  heldBy.clear();
}
function createXRControllers() {
  rig = new THREE.Group();
  rig.position.set(0, 0, 1.15);
  scene.add(rig);
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    controllers.push(controller);
    rig.add(controller);
    const rayMat = new THREE.LineBasicMaterial({ color: i === 0 ? 0x67e3bd : 0x81baff });
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      rayMat,
    );
    line.name = 'ray';
    line.scale.z = 3;
    controller.add(line);

    const reticle = new THREE.Mesh(
      new THREE.SphereGeometry(0.011, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x80f5cf }),
    );
    reticle.name = 'reticle';
    reticle.visible = false;
    controller.add(reticle);

    const grip = renderer.xr.getControllerGrip(i);
    rig.add(grip);
    const proxy = mesh(new THREE.CylinderGeometry(0.017, 0.024, 0.10, 12), material(i === 0 ? 0x61ad94 : 0x678eae), grip);
    proxy.rotation.x = Math.PI / 2;

    controller.addEventListener('connected', e => { controller.userData.inputSource = e.data; });
    controller.addEventListener('selectstart', () => grab(controller));
    controller.addEventListener('selectend', () => release(controller, true));
    controller.addEventListener('disconnected', () => {
      delete controller.userData.inputSource;
      release(controller, false, true);
    });
  }
  renderer.xr.addEventListener('sessionstart', () => {
    releaseAll();
    previewing = false;
    demoPlaying = false;
    dragging = false;
    orbiting = false;
    $('helpDialog')?.close?.();
    $('resultDialog')?.close?.();
    // Camera and controller poses must share the same floor-origin offset.
    rig.add(camera);
    rig.updateMatrixWorld(true);
    hud.visible = true;
    $('sceneMode').textContent = 'VR 头显操作';
    $('vrBtn').textContent = '退出 VR';
    updateGhosts();
    updateUI(true);
    drawHUD();
  });
  renderer.xr.addEventListener('sessionend', () => {
    releaseAll();
    hud.visible = false;
    dragging = false;
    orbiting = false;
    scene.add(camera);
    camera.fov = 43;
    camera.aspect = viewport.clientWidth / viewport.clientHeight;
    camera.updateProjectionMatrix();
    $('sceneMode').textContent = '桌面操作';
    $('vrBtn').textContent = '进入 VR';
    updateCamera();
    updateGhosts();
    updateUI(true);
    if (state.status === 'completed') $('resultDialog')?.showModal?.();
  });
}
async function setupXR() {
  if (!window.isSecureContext || !navigator.xr) {
    $('xrStatus').textContent = '桌面模式可用';
    $('vrBtn').title = '此浏览器或环境未提供 WebXR；电脑操作可完整完成实验。';
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported('immersive-vr');
    $('xrStatus').textContent = supported ? '已检测到 VR 支持' : '桌面模式可用';
    $('xrStatus').classList.toggle('available', supported);
    $('vrBtn').disabled = !supported;
    $('vrBtn').title = supported ? '进入连接的 VR 设备' : '未检测到兼容头显；电脑操作可完整完成实验。';
    $('vrBtn').onclick = async () => {
      const session = renderer.xr.getSession();
      if (session) { await session.end(); return; }
      let requestedSession;
      $('vrBtn').disabled = true;
      try {
        requestedSession = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
        await renderer.xr.setSession(requestedSession);
      } catch (error) {
        if (requestedSession) { try { await requestedSession.end(); } catch { /* ignore */ } }
        setFeedback('暂时无法进入 VR', '请确认头显连接、浏览器权限及安全地址。当前可继续使用桌面模式。', 'warning');
        console.warn('WebXR session:', error);
      } finally {
        $('vrBtn').disabled = false;
      }
    };
  } catch (error) {
    $('xrStatus').textContent = '桌面模式可用';
    console.warn('WebXR capability:', error);
  }
}
function updatePerfMonitor(now, dtMs, force = false) {
  if (!perfVisible || !renderer) return;
  if (dtMs > 0 && dtMs < 2000) {
    perfSamples.push(dtMs);
    if (perfSamples.length > 30) perfSamples.shift();
  }
  if (!force && now - lastPerf < 280) return;
  lastPerf = now;
  const avgMs = perfSamples.length ? perfSamples.reduce((a, b) => a + b, 0) / perfSamples.length : dtMs;
  const fps = avgMs > 0 ? Math.min(240, Math.round(1000 / avgMs)) : 0;
  if ($('perfFps')) $('perfFps').textContent = String(fps);
  if ($('perfMs')) $('perfMs').textContent = `${avgMs.toFixed(1)} ms`;
  if ($('perfCalls')) $('perfCalls').textContent = String(renderer.info.render.calls);
  if ($('perfTris')) $('perfTris').textContent = renderer.info.render.triangles.toLocaleString('zh-CN');
}
function renderFrame(time) {
  const now = nowMs();
  const rawDt = lastFrameAt ? now - lastFrameAt : 16.7;
  const dtMs = Math.min(100, rawDt);
  lastFrameAt = now;
  const dtSec = dtMs / 1000;

  if (cameraEasing && !renderer.xr.isPresenting) {
    const k = Math.min(1, dtSec * 8.5);
    orbit.theta += (targetOrbit.theta - orbit.theta) * k;
    orbit.phi += (targetOrbit.phi - orbit.phi) * k;
    orbit.radius += (targetOrbit.radius - orbit.radius) * k;
    cameraTarget.lerp(targetLookAt, k);
    updateCamera();
    if (
      Math.abs(orbit.theta - targetOrbit.theta) < 0.002
      && Math.abs(orbit.phi - targetOrbit.phi) < 0.002
      && Math.abs(orbit.radius - targetOrbit.radius) < 0.004
      && cameraTarget.distanceTo(targetLookAt) < 0.004
    ) {
      orbit = { ...targetOrbit };
      cameraTarget.copy(targetLookAt);
      cameraEasing = false;
      updateCamera();
    }
  }

  updateAnimations(now);
  updateShowcaseDemo(dtSec);
  updateSpatialGuides(now);

  let hudHover = -1;
  if (renderer.xr.isPresenting) {
    for (const [idx, controller] of controllers.entries()) {
      setControllerRay(controller);
      const hit = pickPart();
      const hudHit = raycaster.intersectObject(hud)[0];
      const dist = Math.min(hit?.distance ?? 3, hudHit?.distance ?? 3, 3);
      const ray = controller.getObjectByName('ray');
      const reticle = controller.getObjectByName('reticle');
      if (ray) {
        ray.scale.z = dist;
        ray.material.color.setHex(hit || hudHit ? 0x4df5bd : idx === 0 ? 0x67e3bd : 0x81baff);
      }
      if (reticle) {
        reticle.visible = !!(hit || hudHit);
        reticle.position.set(0, 0, -dist);
      }
      if (hudHit && (!hit || hudHit.distance < hit.distance)) {
        const bIdx = hudButtonAtUV(hudHit.uv);
        if (bIdx !== -1) hudHover = bIdx;
      }
    }
    if (time - lastHUD > 200) { drawHUD(hudHover); lastHUD = time; }
  }

  // Highlight selected, hovered, or error-shaking parts without mutating instructional colours
  for (const [id, model] of models) {
    const isShaking = shakeAnimations.has(id);
    const isActive = !state.installed.includes(id) && (id === selectedId || id === hoverId);
    model.traverse(o => {
      if (o.isMesh && o.material?.emissive) {
        o.material.emissive.setHex(isShaking ? 0x4f220e : isActive ? 0x134237 : 0x000000);
      }
    });
  }

  updateUI();
  renderer.render(scene, camera);
  updatePerfMonitor(now, rawDt);
}
async function main() {
  wireUI();
  updateHistory();
  try {
    scene = new THREE.Scene();
    const bgTex = createBackdropTexture();
    scene.background = bgTex || new THREE.Color(0x132632);
    scene.fog = new THREE.Fog(0x11222c, 8.5, 22);

    camera = new THREE.PerspectiveCamera(43, 1, 0.01, 100);
    updateCamera();

    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '可交互的三维装配实验台');
    viewport.prepend(renderer.domElement);

    const envTex = createStudioEnvironment(renderer);
    if (envTex) {
      scene.environment = envTex;
      scene.environmentIntensity = 0.78;
    }

    // Balanced 3-point industrial studio lighting
    scene.add(new THREE.HemisphereLight(0xd9f2f7, 0x1e333e, 1.55));
    const key = new THREE.DirectionalLight(0xf7fcff, 3.1);
    key.position.set(-2.2, 5.2, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -2.8;
    key.shadow.camera.right = 2.8;
    key.shadow.camera.top = 2.8;
    key.shadow.camera.bottom = -2.8;
    key.shadow.normalBias = 0.018;
    key.shadow.bias = -0.0004;
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xffdfbf, 1.45);
    rim.position.set(3.2, 2.8, -2.5);
    scene.add(rim);

    const fill = new THREE.DirectionalLight(0x7ac3dc, 1.2);
    fill.position.set(2.4, 1.6, 2.8);
    scene.add(fill);

    createStage();
    createParts();
    createSpatialGuides();
    createHUD();
    createXRControllers();
    installDesktopControls();

    new ResizeObserver(() => {
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }).observe(viewport);

    updateUI(true);
    setCamera('perspective', true);
    renderer.setAnimationLoop(renderFrame);
    await setupXR();
  } catch (error) {
    console.error(error);
    $('sceneFallback').hidden = false;
    $('startBtn').disabled = true;
    $('vrBtn').disabled = true;
    $('xrStatus').textContent = '三维视图未启动';
    setFeedback('三维视图未能启动', `${error.message}。请通过 HTTP(S) 地址访问，并在支持 WebGL 的现代浏览器中打开。`, 'warning');
  }
}
main();
