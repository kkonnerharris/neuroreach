// Live WebGL view of the PyBullet work cell. PyBullet (sim/server.py) owns the physics; this
// file only draws. Robot links use the real URDF meshes from pybullet_data; the computers,
// shipping boxes and infeed conveyor are detailed models sized exactly to their PyBullet
// collision shapes, and everything moves with the link poses streamed at 30 Hz.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import * as BGU from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { Sfx } from "./sound.js";

const GEOM = { SPHERE: 2, BOX: 3, CYLINDER: 4, MESH: 5, PLANE: 6, CAPSULE: 7 };
const C = { bg: 0x0c0f0e, lime: 0xd7ff3a, kuka: 0xff6a00, white: 0xeef1ef, graphite: 0x1f2426, steel: 0x9aa3a0 };
// Sizes mirror sim/arm.py so every model matches its collision shape.
const PART = { x: 0.035, y: 0.05, z: 0.055 };
const BOX = { inner: 0.17, wall: 0.008, h: 0.2 };
const INFEED = { x: 0.62, hx: 0.16, hy: 0.22, top: 0.16 };

const host = document.getElementById("arena");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
host.prepend(renderer.domElement);
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.bg);
scene.fog = new THREE.Fog(C.bg, 5, 11);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

// PyBullet is z-up; everything from the sim lives under this root so raw coordinates work.
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

const camera = new THREE.PerspectiveCamera(36, 1, 0.02, 40);
let camBaseFov = 36;
const HOME_CAM = { pos: new THREE.Vector3(2.0, 1.55, 0.35), target: new THREE.Vector3(0.05, 0.22, 0) };
camera.position.copy(HOME_CAM.pos);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME_CAM.target);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.8;
controls.maxDistance = 4.5;
controls.maxPolarAngle = Math.PI * 0.47;
controls.enablePan = false;
renderer.domElement.addEventListener("dblclick", () => { if (!controls.enabled) return; camera.position.copy(HOME_CAM.pos); controls.target.copy(HOME_CAM.target); });

// ---------------------------------------------------------------- lighting
scene.add(new THREE.HemisphereLight(0xe4ece8, 0x0c0f0e, 0.3));
const key = new THREE.DirectionalLight(0xfff4e8, 2.6);
key.position.set(1.8, 3.4, 1.2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: 0.5, far: 8 });
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.015;
key.shadow.radius = 4;
scene.add(key);
const fill = new THREE.DirectionalLight(0xbfe6ff, 0.55);
fill.position.set(-2.2, 1.4, -1.8);
scene.add(fill);
for (const z of [-0.7, 0.7]) { // overhead light bars: long soft highlights on the robot's paint
  const bar = new THREE.RectAreaLight(0xffffff, 3.5, 2.4, 0.18);
  bar.position.set(0, 2.4, z);
  bar.lookAt(0, 0, z);
  scene.add(bar);
}

// ---------------------------------------------------------------- textures (generated, no downloads)
function canvasTex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}
const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
const concreteTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = "#2a2f2d"; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) { const v = 34 + rand() * 22; g.fillStyle = `rgba(${v},${v + 4},${v + 2},${0.25 + rand() * 0.3})`; g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2); }
  for (let i = 0; i < 14; i++) { const r = 40 + rand() * 120; const gr = g.createRadialGradient(rand() * w, rand() * h, 0, rand() * w, rand() * h, r); gr.addColorStop(0, "rgba(255,255,255,0.025)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, w, h); }
  g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 2; g.strokeRect(0, 0, w, h); // slab seams
}, [6, 6]);
const kraft = (print) => canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = "#b8895a"; g.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 6) { g.fillStyle = `rgba(90,60,30,${0.05 + rand() * 0.05})`; g.fillRect(x, 0, 2, h); } // corrugation
  for (let i = 0; i < 5000; i++) { g.fillStyle = `rgba(${rand() < 0.5 ? "70,45,20" : "230,200,160"},${rand() * 0.12})`; g.fillRect(rand() * w, rand() * h, 1, 1 + rand() * 3); }
  if (!print) return;
  g.fillStyle = "rgba(60,35,15,0.78)"; g.strokeStyle = "rgba(60,35,15,0.78)";
  g.font = "700 46px 'IBM Plex Sans', Arial, sans-serif"; g.textAlign = "center";
  g.fillText("NEUROREACH", w / 2, h * 0.42);
  g.font = "500 26px 'IBM Plex Mono', monospace"; g.fillText("1 × DESKTOP COMPUTER", w / 2, h * 0.52);
  g.lineWidth = 6; // "this side up" arrows
  for (const x of [w * 0.2, w * 0.8]) { g.beginPath(); g.moveTo(x, h * 0.86); g.lineTo(x, h * 0.66); g.moveTo(x - 22, h * 0.72); g.lineTo(x, h * 0.64); g.lineTo(x + 22, h * 0.72); g.stroke(); }
  g.strokeRect(w * 0.36, h * 0.62, w * 0.28, h * 0.24); g.font = "600 22px 'IBM Plex Mono', monospace"; g.fillText("FRAGILE", w / 2, h * 0.76);
});
const beltTex = canvasTex(64, 256, (g, w, h) => {
  g.fillStyle = "#151819"; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 16) { g.fillStyle = "#202526"; g.fillRect(0, y, w, 7); }
}, [1, 6]);

// ---------------------------------------------------------------- materials
const mats = {
  kuka: new THREE.MeshPhysicalMaterial({ color: 0xf06a10, roughness: 0.36, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 0.25, sheenColor: new THREE.Color(0xffb27a) }),
  white: new THREE.MeshPhysicalMaterial({ color: 0xe9ece9, roughness: 0.42, metalness: 0.0, clearcoat: 0.45, clearcoatRoughness: 0.3 }),
  graphite: new THREE.MeshPhysicalMaterial({ color: 0x1c2023, roughness: 0.4, metalness: 0.75, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
  seal: new THREE.MeshStandardMaterial({ color: 0x0d0f10, roughness: 0.75, metalness: 0.1 }),
  alu: new THREE.MeshPhysicalMaterial({ color: 0xc8cdcf, roughness: 0.28, metalness: 1, clearcoat: 0.2 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc4cac7, roughness: 0.3, metalness: 1 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x111314, roughness: 0.85, metalness: 0 }),
  floor: new THREE.MeshStandardMaterial({ map: concreteTex, color: 0xb9c2bd, roughness: 0.62, metalness: 0.05 }),
  pcShell: new THREE.MeshPhysicalMaterial({ color: 0x2a2f33, roughness: 0.35, metalness: 0.75, clearcoat: 0.4 }),
  pcFront: new THREE.MeshStandardMaterial({ color: 0x0f1213, roughness: 0.25, metalness: 0.3 }),
  vent: new THREE.MeshStandardMaterial({ color: 0x07090a, roughness: 0.9 }),
  kraftPrint: new THREE.MeshStandardMaterial({ map: kraft(true), roughness: 0.92, metalness: 0 }),
  kraft: new THREE.MeshStandardMaterial({ map: kraft(false), roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
  tape: new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.35, metalness: 0, transparent: true, opacity: 0.85 }),
  belt: new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.8 }),
  steelTray: new THREE.MeshStandardMaterial({ color: C.steel, roughness: 0.4, metalness: 0.7 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xb08a00, roughness: 0.85 }),
  glow: new THREE.MeshBasicMaterial({ color: C.lime, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
};
const shadowed = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

// ---------------------------------------------------------------- environment
const factoryItems = [];
const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), mats.floor);
factoryItems.push(floor);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const deco = new THREE.Group(); // floor markings, z-up inside the world frame
world.add(deco); factoryItems.push(deco);
function stripe(x, y, w, h) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mats.yellow); m.position.set(x, y, 0.0015); m.receiveShadow = true; deco.add(m); }
const X0 = -1.05, X1 = 1.85, Y = 1.05, LW = 0.022; // safety walkway lines around the cell
stripe((X0 + X1) / 2, Y, X1 - X0, LW); stripe((X0 + X1) / 2, -Y, X1 - X0, LW);
stripe(X0, 0, LW, 2 * Y);
const baseRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.225, 64), mats.yellow);
baseRing.position.z = 0.0015; deco.add(baseRing);
// back wall with light strips, far behind the cell
const wall = new THREE.Mesh(new THREE.PlaneGeometry(14, 4), new THREE.MeshStandardMaterial({ color: 0x141817, roughness: 0.9 }));
wall.position.set(-3.2, 0, 2); wall.rotation.set(Math.PI / 2, Math.PI / 2, 0); world.add(wall); factoryItems.push(wall);
const wallStrips = [];
for (let i = -4; i <= 4; i++) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 1.6), new THREE.MeshBasicMaterial({ color: 0x9fd8ff }));
  s.position.set(-3.18, i * 1.4, 1.9); s.rotation.set(Math.PI / 2, Math.PI / 2, 0); world.add(s); factoryItems.push(s); wallStrips.push(s);
}

// infeed conveyor (the physics infeed is the pedestal; the belt continues out of the cell)
const conveyor = new THREE.Group();
world.add(conveyor); factoryItems.push(conveyor);
{
  const len = 1.5, x0 = INFEED.x - INFEED.hx, cx = x0 + len / 2, w = 0.34;
  const frame = shadowed(new THREE.Mesh(new RoundedBoxGeometry(len, w + 0.06, 0.1, 3, 0.012), mats.graphite));
  frame.position.set(cx, 0, INFEED.top - 0.06); conveyor.add(frame);
  const belt = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.04, w), mats.belt);
  belt.position.set(cx, 0, INFEED.top + 0.0005); belt.rotation.z = Math.PI / 2; belt.receiveShadow = true; conveyor.add(belt);
  for (const s of [-1, 1]) {
    const rail = shadowed(new THREE.Mesh(new THREE.BoxGeometry(len, 0.012, 0.035), mats.chrome));
    rail.position.set(cx, s * (w / 2 + 0.02), INFEED.top + 0.012); conveyor.add(rail);
  }
  for (const x of [x0 + 0.03, x0 + len - 0.03]) {
    const roller = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, w + 0.04, 24), mats.chrome));
    roller.position.set(x, 0, INFEED.top - 0.03); conveyor.add(roller);
  }
  for (const x of [x0 + 0.1, x0 + len - 0.1]) for (const s of [-1, 1]) {
    const leg = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, INFEED.top - 0.1), mats.graphite));
    leg.position.set(x, s * w / 2, (INFEED.top - 0.1) / 2); conveyor.add(leg);
  }
  const stop = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.015, w, 0.03), mats.yellow)); // end stop at the pick point
  stop.position.set(x0 + 0.01, 0, INFEED.top + 0.015); conveyor.add(stop);
}

// target marker: pulsing floor ring + bobbing chevron over whichever bin the job needs
const marker = new THREE.Group();
const mRing = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.3, 64), mats.glow);
mRing.position.z = 0.003;
const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.09, 4), new THREE.MeshStandardMaterial({ color: C.lime, emissive: C.lime, emissiveIntensity: 1.4 }));
chevron.rotation.x = -Math.PI / 2; // point down (-z)
marker.add(mRing, chevron);
marker.visible = false;
world.add(marker);

// ---------------------------------------------------------------- detailed models
function computerModel(rgba) {
  const g = new THREE.Group();
  const shell = shadowed(new THREE.Mesh(new RoundedBoxGeometry(2 * PART.x, 2 * PART.y, 2 * PART.z, 3, 0.006), mats.pcShell));
  g.add(shell);
  const front = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.004, 2 * PART.y - 0.008, 2 * PART.z - 0.008, 2, 0.002), mats.pcFront));
  front.position.x = PART.x + 0.0005; g.add(front);
  const order = new THREE.Color(rgba[0], rgba[1], rgba[2]).convertSRGBToLinear();
  const led = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.003, 16), new THREE.MeshStandardMaterial({ color: order, emissive: order, emissiveIntensity: 2.2 }));
  led.rotation.z = Math.PI / 2; led.position.set(PART.x + 0.003, 0, PART.z - 0.016); g.add(led);
  for (let i = 0; i < 2; i++) { // drive bays
    const bay = new THREE.Mesh(new THREE.BoxGeometry(0.002, 2 * PART.y - 0.03, 0.006), mats.vent);
    bay.position.set(PART.x + 0.003, 0, PART.z - 0.035 - i * 0.012); g.add(bay);
  }
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) { // side vents
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.002, 0.004), mats.vent);
    v.position.set(-0.004, s * (PART.y + 0.0005), -0.02 + i * 0.008); g.add(v);
  }
  const sticker = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.05), new THREE.MeshStandardMaterial({ color: order, roughness: 0.5 }));
  sticker.position.z = PART.z + 0.0008; g.add(sticker); // order sticker on top, visible from the camera
  return g;
}

function shippingBox() {
  const g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  const { inner: i, wall: w, h } = BOX, o = i + w;
  const floorP = shadowed(new THREE.Mesh(new THREE.BoxGeometry(2 * o, 2 * o, w), mats.kraft));
  floorP.position.z = w / 2; body.add(floorP);
  for (const [x, y, sx, sy] of [[i + w / 2, 0, w, 2 * o], [-i - w / 2, 0, w, 2 * o], [0, i + w / 2, 2 * o, w], [0, -i - w / 2, 2 * o, w]]) {
    const wallM = shadowed(new THREE.Mesh(new THREE.BoxGeometry(sx, sy, h), [mats.kraftPrint, mats.kraftPrint, mats.kraftPrint, mats.kraftPrint, mats.kraft, mats.kraft]));
    wallM.position.set(x, y, h / 2); body.add(wallM);
  }
  const flaps = [];
  for (const [ax, sign] of [["x", 1], ["x", -1], ["y", 1], ["y", -1]]) { // hinged at each top edge
    const hinge = new THREE.Group();
    const len = ax === "x" ? i : i; // flap reaches the box centre when closed
    hinge.position.set(ax === "x" ? sign * o : 0, ax === "y" ? sign * o : 0, h);
    const flap = shadowed(new THREE.Mesh(new THREE.BoxGeometry(ax === "x" ? len : 2 * o, ax === "y" ? len : 2 * o, 0.004), mats.kraft));
    flap.position.set(ax === "x" ? -sign * len / 2 : 0, ax === "y" ? -sign * len / 2 : 0, 0);
    hinge.add(flap);
    hinge.userData = { ax, sign };
    flaps.push(hinge); body.add(hinge);
  }
  const tape = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2 * o + 0.004, 0.002), mats.tape);
  tape.position.z = h + 0.005; tape.visible = false; body.add(tape);
  const api = {
    group: g, body, flaps, tape, open: 1, // 1 = flaps folded out, 0 = closed
    setOpen(t) {
      this.open = t;
      for (const f of flaps) { // closed: flat over the opening; open: folded out and down 110 degrees
        const a = t * THREE.MathUtils.degToRad(110) * f.userData.sign;
        f.rotation.set(f.userData.ax === "y" ? -a : 0, f.userData.ax === "x" ? a : 0, 0);
      }
    },
  };
  api.setOpen(1);
  return api;
}

function suctionTool() {
  const g = new THREE.Group(); // local +z points from flange to suction tip (tool axis)
  const flange = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 32), mats.chrome));
  flange.rotation.x = Math.PI / 2; flange.position.z = -0.016; g.add(flange);
  const pts = [];
  for (let k = 0; k <= 12; k++) pts.push(new THREE.Vector2(0.014 + 0.003 * Math.sin(k * 1.6) + (k > 8 ? (k - 8) * 0.004 : 0), k * 0.0025));
  const bellows = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 32), mats.rubber));
  bellows.rotation.x = Math.PI / 2; bellows.position.z = -0.006; g.add(bellows);
  const led = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.0028, 10, 48), ledMat); // status ring
  led.position.z = -0.026; g.add(led);
  const ledGlow = new THREE.PointLight(0xffffff, 0, 0.35, 2); ledGlow.position.z = -0.01; g.add(ledGlow);
  g.userData.ledGlow = ledGlow; toolLed.glow = ledGlow;
  return g;
}
// The wrist LED tells you what the headset/robot is doing: soft white idle, cyan reading your
// brain signal, green acting on it, red when the intention didn't match.
const ledMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffffff, emissiveIntensity: 0.6 });
const toolLed = { color: new THREE.Color(0xffffff), until: 0, glow: null };
window.addEventListener("sfx", (e) => {
  const c = { scan: 0x4fe3d1, ok: 0x9be35a, fail: 0xff5d6c }[e.detail];
  if (c) { toolLed.color.setHex(c); toolLed.until = performance.now() + (e.detail === "scan" ? 9000 : 1600); }
});
// machined detail on the real URDF links: dark seals and brushed caps at every joint
function jointDetail(linkIndex) {
  const g = new THREE.Group();
  const r = [0.1, 0.085, 0.085, 0.08, 0.075, 0.068, 0.062, 0.05][linkIndex] ?? 0.07;
  const seal = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0045, 10, 64), mats.seal);
  g.add(seal);
  return g;
}

// ---------------------------------------------------------------- home scene (first person at a dining table)
// The PyBullet ground plane is the table top (z = 0); the room floor is 0.74 m below it.
const texLoader = new THREE.TextureLoader();
function photo(url, onLoad) {
  return texLoader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; onLoad?.(t); }, undefined, () => {});
}
const woodFallback = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = "#c49a6c"; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 2) { g.fillStyle = `rgba(110,70,35,${0.04 + 0.06 * Math.abs(Math.sin(y * 0.05 + Math.sin(y * 0.013) * 3))})`; g.fillRect(0, y, w, 2); }
});
const home = new THREE.Group();
home.visible = false;
world.add(home);
const TABLE = { x0: -0.45, x1: 1.1, y: 0.8, top: 0 };
const tableMat = new THREE.MeshStandardMaterial({ map: woodFallback, roughness: 0.55, metalness: 0 });
photo("assets/oak-table.jpg", (t) => { tableMat.map = t; tableMat.needsUpdate = true; });
{
  const top = shadowed(new THREE.Mesh(new RoundedBoxGeometry(TABLE.x1 - TABLE.x0, 2 * TABLE.y, 0.04, 3, 0.01), tableMat));
  top.position.set((TABLE.x0 + TABLE.x1) / 2, 0, -0.0205); home.add(top);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.6 });
  for (const x of [TABLE.x0 + 0.08, TABLE.x1 - 0.08]) for (const y of [-TABLE.y + 0.08, TABLE.y - 0.08]) {
    const leg = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.72), legMat));
    leg.position.set(x, y, -0.4); home.add(leg);
  }
  const floorWood = woodFallback.clone(); floorWood.repeat.set(5, 5); floorWood.needsUpdate = true;
  const roomFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ map: floorWood, color: 0x8a7058, roughness: 0.7 }));
  roomFloor.name = "roomFloor"; roomFloor.position.z = -0.74; roomFloor.receiveShadow = true; home.add(roomFloor);
  const backdropMat = new THREE.MeshBasicMaterial({ color: 0xd9d3c8, toneMapped: false, fog: false });
  photo("assets/home-backdrop.jpg", (t) => { backdropMat.map = t; backdropMat.color.set(0xffffff); backdropMat.needsUpdate = true; });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(10.4, 5.85), backdropMat);
  backdrop.name = "backdrop";
  backdrop.position.set(-1.9, 0, 1.0); // kitchen counter in the photo lines up just above table height backdrop.rotation.set(Math.PI / 2, Math.PI / 2, 0); home.add(backdrop); // faces +x, upright
  const linen = canvasTex(256, 256, (g, w, h) => { // woven linen placemat
    g.fillStyle = "#8c9389"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 3) { g.fillStyle = `rgba(255,255,255,${0.04 + rand() * 0.05})`; g.fillRect(i, 0, 1, h); g.fillStyle = `rgba(0,0,0,${0.04 + rand() * 0.05})`; g.fillRect(0, i, w, 1); }
    g.strokeStyle = "rgba(60,64,58,0.5)"; g.lineWidth = 3; g.strokeRect(8, 8, w - 16, h - 16);
  }, [2, 3]);
  const placemat = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.42, 0.003, 2, 0.0015), new THREE.MeshStandardMaterial({ map: linen, roughness: 1 }));
  placemat.position.set(0.9, 0, 0.0016); placemat.receiveShadow = true; home.add(placemat); // the person's place
}
const warehouseBackdrop = new THREE.MeshBasicMaterial({ color: 0x141817, toneMapped: false, fog: false });
photo("assets/warehouse-backdrop.jpg", (t) => { warehouseBackdrop.map = t; warehouseBackdrop.color.set(0x8a8f8c); warehouseBackdrop.needsUpdate = true; wallStrips.forEach((w) => world.remove(w)); });
wall.material = warehouseBackdrop; wall.scale.set(1, 1.6, 1); wall.position.z = 3.2;

const ceramic = new THREE.MeshPhysicalMaterial({ color: 0xf4f2ee, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
function mugModel() {
  const g = new THREE.Group(); // local z up, centred on the 4 x 10 cm cylinder
  const pts = [new THREE.Vector2(0, -0.05), new THREE.Vector2(0.036, -0.05), new THREE.Vector2(0.04, -0.045), new THREE.Vector2(0.04, 0.05), new THREE.Vector2(0.036, 0.05), new THREE.Vector2(0.036, -0.04), new THREE.Vector2(0, -0.04)];
  const body = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 48), ceramic));
  body.rotation.x = Math.PI / 2; g.add(body);
  const handle = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.006, 12, 32, Math.PI * 1.2), ceramic));
  handle.rotation.set(Math.PI / 2, 0, -Math.PI * 0.6); handle.position.set(0, 0.04, 0.002); g.add(handle);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.035, 32), new THREE.MeshPhysicalMaterial({ color: 0x2b170c, roughness: 0.15, clearcoat: 1 }));
  coffee.position.z = 0.036; g.add(coffee);
  return g;
}
function appleModel(rgba = [0.8, 0.1, 0.12, 1]) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.038, 40, 28);
  const pos = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const k = 1 - 0.18 * Math.exp(-((v.y - 0.038) ** 2) / 0.00008) - 0.1 * Math.exp(-((v.y + 0.038) ** 2) / 0.0001); pos.setXYZ(i, v.x * k, v.y * 0.94, v.z * k); }
  geo.computeVertexNormals();
  const apple = shadowed(new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: col(rgba), roughness: 0.28, clearcoat: 0.7, clearcoatRoughness: 0.2, sheen: 0.3, sheenColor: new THREE.Color(0xff8a5c) })));
  apple.rotation.x = Math.PI / 2; g.add(apple);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0025, 0.018, 8), new THREE.MeshStandardMaterial({ color: 0x4a3218 }));
  stem.rotation.x = Math.PI / 2; stem.position.z = 0.04; g.add(stem);
  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshStandardMaterial({ color: 0x3c7a2a, roughness: 0.6 }));
  leaf.scale.set(1, 0.45, 0.12); leaf.position.set(0.008, 0.004, 0.046); leaf.rotation.z = 0.6; g.add(leaf);
  return g;
}
function plateModel() {
  const pts = [new THREE.Vector2(0, -0.008), new THREE.Vector2(0.07, -0.008), new THREE.Vector2(0.1, -0.002), new THREE.Vector2(0.11, 0.008), new THREE.Vector2(0.104, 0.008), new THREE.Vector2(0.07, -0.003), new THREE.Vector2(0, -0.003)];
  const m = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 64), ceramic));
  m.rotation.x = Math.PI / 2;
  const g = new THREE.Group(); g.add(m); return g;
}
const phoneScreen = canvasTex(256, 512, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#0f2a22"); gr.addColorStop(1, "#071510"); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = "#e8efe9"; g.textAlign = "center"; g.font = "600 30px 'IBM Plex Sans', Arial"; g.fillText("Incoming call", w / 2, 120);
  g.font = "400 22px 'IBM Plex Sans', Arial"; g.fillStyle = "#9fb3a8"; g.fillText("Mom", w / 2, 160);
  g.fillStyle = "#2ecc71"; g.beginPath(); g.arc(w / 2, h - 110, 42, 0, Math.PI * 2); g.fill();
});
function phoneModel() {
  const g = new THREE.Group(), inner = new THREE.Group(); g.add(inner);
  inner.add(shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.076, 0.15, 0.012, 4, 0.006), new THREE.MeshPhysicalMaterial({ color: 0x15171a, roughness: 0.3, metalness: 0.6, clearcoat: 1 }))));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.14), new THREE.MeshStandardMaterial({ map: phoneScreen, emissive: 0xffffff, emissiveMap: phoneScreen, emissiveIntensity: 0.9, roughness: 0.1 }));
  screen.position.z = 0.0062; screen.rotation.z = Math.PI / 2; inner.add(screen);
  g.userData.inner = inner; g.userData.screen = screen;
  return g;
}
const lampLight = new THREE.PointLight(0xffd29a, 0, 2.5, 1.6);
lampLight.castShadow = true; lampLight.shadow.mapSize.set(512, 512);
let bulbMat = null;
function lampModel() {
  const g = new THREE.Group(); // body origin = centre of the 4 cm base disc
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.35, metalness: 0.8 });
  const base = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.072, 0.04, 48), metal)); base.rotation.x = Math.PI / 2; g.add(base);
  const button = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.006, 32), new THREE.MeshStandardMaterial({ color: C.lime, emissive: C.lime, emissiveIntensity: 0.6 }));
  button.rotation.x = Math.PI / 2; button.position.z = 0.022; g.add(button);
  const stem = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.34, 16), metal)); stem.rotation.x = Math.PI / 2; stem.position.set(0.04, 0, 0.19); g.add(stem);
  const shade = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.11, 0.13, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0xefe6d6, roughness: 0.8, side: THREE.DoubleSide, emissive: 0xffd29a, emissiveIntensity: 0 })));
  shade.rotation.x = Math.PI / 2; shade.position.set(0.04, 0, 0.36); g.add(shade);
  bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xffd29a, emissiveIntensity: 0 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.025, 20, 14), bulbMat); bulb.position.set(0.04, 0, 0.33); g.add(bulb);
  lampLight.position.set(0.04, 0, 0.3); g.add(lampLight);
  g.userData.shade = shade;
  return g;
}


// ---------------------------------------------------------------- more household objects (sized to their PyBullet shapes)
const col = (rgba) => new THREE.Color(rgba[0], rgba[1], rgba[2]).convertSRGBToLinear();
function pillsModel(rgba) { // amber pill bottle, 2.8 cm radius x 8 cm, white child-proof cap
  const g = new THREE.Group();
  const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.062, 32), new THREE.MeshPhysicalMaterial({ color: col(rgba), roughness: 0.15, transmission: 0.35, thickness: 0.01, clearcoat: 1 })));
  body.rotation.x = Math.PI / 2; body.position.z = -0.009; g.add(body);
  const cap = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.029, 0.029, 0.018, 32), new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.5 })));
  cap.rotation.x = Math.PI / 2; cap.position.z = 0.031; g.add(cap);
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0275, 0.0275, 0.03, 32, 1, true, 0, Math.PI * 1.3), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }));
  label.rotation.x = Math.PI / 2; label.position.z = -0.008; g.add(label);
  return g;
}
function bookModel(rgba) { // hardcover 14 x 20 x 3 cm
  const g = new THREE.Group();
  g.add(shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.14, 0.2, 0.03, 2, 0.003), new THREE.MeshStandardMaterial({ color: col(rgba), roughness: 0.6 }))));
  const pages = new THREE.Mesh(new THREE.BoxGeometry(0.132, 0.19, 0.024), new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.9 }));
  pages.position.x = 0.006; g.add(pages);
  return g;
}
function stackModel() { // a stack of three books, 16 x 22 x 10 cm in total
  const g = new THREE.Group(), cols = [0x7a2a2a, 0x2f5d4a, 0xc9a24a];
  cols.forEach((c, i) => {
    const b = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.16 - i * 0.008, 0.22 - i * 0.012, 0.032, 2, 0.003), new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 })));
    b.position.z = -0.05 + 0.017 + i * 0.033; b.rotation.z = (i - 1) * 0.06; g.add(b);
  });
  return g;
}
function remoteModel() { // 4.4 x 15 x 2 cm
  const g = new THREE.Group();
  g.add(shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.044, 0.15, 0.02, 3, 0.008), new THREE.MeshPhysicalMaterial({ color: 0x17181a, roughness: 0.35, clearcoat: 0.6 }))));
  const power = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 16), new THREE.MeshStandardMaterial({ color: 0xd8342c, emissive: 0x6a0f0a }));
  power.rotation.x = Math.PI / 2; power.position.set(0, 0.055, 0.011); g.add(power);
  for (let r = 0; r < 4; r++) for (let c = -1; c <= 1; c++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.003, 12), new THREE.MeshStandardMaterial({ color: 0x3a3c40 }));
    b.rotation.x = Math.PI / 2; b.position.set(c * 0.011, 0.02 - r * 0.014, 0.0105); g.add(b);
  }
  return g;
}
function trayModel() { // wooden tray 18 x 26 cm with a low rim
  const g = new THREE.Group(), wood = new THREE.MeshStandardMaterial({ map: woodFallback, color: 0x9b6b42, roughness: 0.6 });
  const base = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.18, 0.26, 0.016, 2, 0.004), wood)); g.add(base);
  for (const [x, y, sx, sy] of [[0.087, 0, 0.006, 0.26], [-0.087, 0, 0.006, 0.26], [0, 0.127, 0.18, 0.006], [0, -0.127, 0.18, 0.006]]) {
    const rim = shadowed(new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.025), wood)); rim.position.set(x, y, 0.012); g.add(rim);
  }
  return g;
}
function bowlModel() { // ceramic bowl; the physics body is its 3.5 cm base
  const pts = [new THREE.Vector2(0, -0.0175), new THREE.Vector2(0.04, -0.0175), new THREE.Vector2(0.075, 0.01), new THREE.Vector2(0.09, 0.035), new THREE.Vector2(0.086, 0.036), new THREE.Vector2(0.07, 0.012), new THREE.Vector2(0.035, -0.008), new THREE.Vector2(0, -0.008)];
  const m = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 64), new THREE.MeshPhysicalMaterial({ color: 0x3d6b8a, roughness: 0.2, clearcoat: 1 })));
  m.rotation.x = Math.PI / 2;
  const g = new THREE.Group(); g.add(m); return g;
}
function glassModel() { // drinking glass with water, 3.2 cm radius x 11 cm
  const g = new THREE.Group();
  const pts = [new THREE.Vector2(0, -0.055), new THREE.Vector2(0.03, -0.055), new THREE.Vector2(0.032, 0.055), new THREE.Vector2(0.03, 0.055), new THREE.Vector2(0.028, -0.048), new THREE.Vector2(0, -0.048)];
  const glass = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, transmission: 1, thickness: 0.004, ior: 1.5, transparent: true }));
  glass.rotation.x = Math.PI / 2; glass.castShadow = true; g.add(glass);
  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.0275, 0.0265, 0.07, 32), new THREE.MeshPhysicalMaterial({ color: 0xcfe8ff, roughness: 0.05, transmission: 0.9, thickness: 0.05, ior: 1.33, transparent: true }));
  water.rotation.x = Math.PI / 2; water.position.z = -0.012; g.add(water);
  return g;
}
function coasterModel() {
  const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.006, 40), new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.95 })));
  m.rotation.x = Math.PI / 2;
  const g = new THREE.Group(); g.add(m); return g;
}
// the TV hangs on the side wall of the room (visual only); it switches on when the remote is pressed
const tvScreenMat = new THREE.MeshStandardMaterial({ color: 0x050607, emissive: 0x000000, roughness: 0.15, metalness: 0.4 });
const tvShow = canvasTex(512, 288, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#1e6fd9"); gr.addColorStop(0.5, "#7b3fe4"); gr.addColorStop(1, "#ff8a3d");
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,0.9)"; g.font = "700 46px 'IBM Plex Sans', Arial"; g.textAlign = "center"; g.fillText("NATURE · LIVE", w / 2, h / 2 + 14);
});
const tv = new THREE.Group();
{
  const frame = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.98, 0.56, 2, 0.008), new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.4, metalness: 0.5 })));
  tv.add(frame);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.52), tvScreenMat);
  screen.rotation.set(Math.PI / 2, Math.PI / 2, 0); screen.position.x = 0.016; tv.add(screen);
  tv.position.set(0.55, -1.25, 0.45); tv.rotation.z = Math.PI / 2; // on the left wall, facing into the room
  tv.visible = false;
  home.add(tv);
}
const tvLight = new THREE.PointLight(0x8aa8ff, 0, 2.2, 1.5);
tvLight.position.set(0.55, -1.05, 0.45); home.add(tvLight);


// ---------------------------------------------------------------- afternoon objects
const chargeRingMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x9be35a, emissiveIntensity: 0 });
function chargerModel() { // 5.5 cm radius x 1 cm pad
  const g = new THREE.Group();
  const pad = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.057, 0.01, 48), new THREE.MeshPhysicalMaterial({ color: 0xf2f2f0, roughness: 0.35, clearcoat: 0.6 })));
  pad.rotation.x = Math.PI / 2; g.add(pad);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.0025, 8, 48), chargeRingMat);
  ring.position.z = 0.0052; g.add(ring);
  return g;
}
function canModel() { // watering can, 7 x 12 x 10 cm body
  const g = new THREE.Group(), metal = new THREE.MeshPhysicalMaterial({ color: 0xf1f0ec, roughness: 0.3, metalness: 0.2, clearcoat: 0.6 });
  g.add(shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.11, 0.1, 3, 0.02), metal)));
  const spout = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.01, 0.12, 12), metal));
  spout.position.set(0, 0.096, 0.018); spout.rotation.x = 0.7; g.add(spout); // leaves the side, angled 40 deg up
  const rose = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.008, 0.02, 16), metal));
  rose.position.set(0, 0.142, 0.057); rose.rotation.x = 0.7; g.add(rose);
  const handle = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 24, Math.PI), metal));
  handle.rotation.set(0, Math.PI / 2, 0); handle.position.set(0, -0.02, 0.05); g.add(handle);
  return g;
}
const droplets = new THREE.Group();
let plantLeaves = null;
function plantModel() { // terracotta pot 7 cm radius x 11 cm with a leafy plant
  const g = new THREE.Group();
  const pot = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.11, 32), new THREE.MeshStandardMaterial({ color: 0xb8673f, roughness: 0.85 })));
  pot.rotation.x = Math.PI / 2; g.add(pot);
  const soil = new THREE.Mesh(new THREE.CircleGeometry(0.064, 24), new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 }));
  soil.position.z = 0.05; g.add(soil);
  plantLeaves = new THREE.Group(); plantLeaves.position.z = 0.05;
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7d3a, roughness: 0.6, side: THREE.DoubleSide });
  for (let i = 0; i < 9; i++) {
    const leaf = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), leafMat));
    leaf.scale.set(0.45, 1, 0.12);
    const a = (i / 9) * Math.PI * 2, tilt = 0.6 + (i % 3) * 0.25;
    leaf.position.set(Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0.05 + (i % 3) * 0.02);
    leaf.rotation.set(Math.sin(a) * tilt, -Math.cos(a) * tilt, a);
    plantLeaves.add(leaf);
  }
  g.add(plantLeaves);
  const dropMat = new THREE.MeshPhysicalMaterial({ color: 0xbfe3ff, transmission: 0.9, roughness: 0.05, transparent: true });
  for (let i = 0; i < 24; i++) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), dropMat); d.userData.seed = Math.random(); droplets.add(d); }
  droplets.position.z = 0.12; droplets.visible = false; g.add(droplets);
  return g;
}
function keysModel() { // 6 x 9 cm bunch on a leather fob
  const g = new THREE.Group(), brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.3, metalness: 1 });
  const ring = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0022, 8, 24), new THREE.MeshStandardMaterial({ color: 0xcfd3d2, metalness: 1, roughness: 0.25 })));
  ring.position.set(0, 0.022, 0.002); g.add(ring);
  for (const [dx, rot] of [[-0.008, 0.25], [0.008, -0.2]]) {
    const key = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.05, 0.003, 2, 0.001), brass));
    key.position.set(dx, -0.006, 0.002); key.rotation.z = rot; g.add(key);
  }
  const fob = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.024, 0.04, 0.005, 3, 0.002), new THREE.MeshStandardMaterial({ color: 0x6b3d22, roughness: 0.7 })));
  fob.position.set(0.018, 0.034, 0.001); fob.rotation.z = -0.4; g.add(fob);
  return g;
}
function treatModel() { // bone-shaped biscuit, 5 x 2.4 cm
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0xb87b3e, roughness: 0.85 });
  const shaft = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.034, 12), m)); shaft.rotation.z = Math.PI / 2; g.add(shaft);
  for (const x of [-0.019, 0.019]) for (const y of [-0.006, 0.006]) { const k = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.0075, 12, 8), m)); k.position.set(x, y, 0); g.add(k); }
  return g;
}
function dogBowlModel() { // stainless bowl; physics body is its 3 cm base
  const pts = [new THREE.Vector2(0, -0.015), new THREE.Vector2(0.08, -0.015), new THREE.Vector2(0.095, 0.02), new THREE.Vector2(0.09, 0.021), new THREE.Vector2(0.068, -0.006), new THREE.Vector2(0, -0.006)];
  const m = shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, 64), new THREE.MeshStandardMaterial({ color: 0xd9dcdd, roughness: 0.18, metalness: 1 })));
  m.rotation.x = Math.PI / 2;
  const g = new THREE.Group(); g.add(m); return g;
}

// ---------------------------------------------------------------- robot meshes
const objLoader = new OBJLoader();
const meshCache = new Map();
function loadMesh(url) {
  if (!meshCache.has(url)) {
    meshCache.set(url, new Promise((res, rej) => objLoader.load(url, (o) => {
      const geoms = [];
      o.traverse((m) => {
        if (!m.isMesh) return;
        let geo = m.geometry;
        geo.deleteAttribute("normal");
        try { geo = BGU.toCreasedNormals(geo, THREE.MathUtils.degToRad(35)); } catch { geo.computeVertexNormals(); }
        geoms.push(geo);
      });
      res(geoms);
    }, undefined, rej)));
  }
  return meshCache.get(url);
}
function robotMaterial(rgba) {
  const [r, g, b] = rgba;
  if (r > 0.8 && g < 0.6) return mats.kuka;
  if (r < 0.3 && g < 0.3 && b < 0.3) return mats.graphite;
  return mats.white;
}

// ---------------------------------------------------------------- bodies
const bodies = new Map(); // id -> { role, links: [Group], target, primed, isTarget, model }

function buildGeneric(v, mat) {
  const holder = new THREE.Group();
  holder.position.fromArray(v.pos);
  holder.quaternion.fromArray(v.orn);
  const add = (geom) => { const m = shadowed(new THREE.Mesh(geom, mat)); holder.add(m); return m; };
  if (v.type === GEOM.BOX) add(new THREE.BoxGeometry(v.dims[0], v.dims[1], v.dims[2]));
  else if (v.type === GEOM.CYLINDER || v.type === GEOM.CAPSULE) add(new THREE.CylinderGeometry(v.dims[1], v.dims[1], v.dims[0], 40)).rotation.x = Math.PI / 2;
  else if (v.type === GEOM.SPHERE) add(new THREE.SphereGeometry(v.dims[0], 32, 16));
  else if (v.type === GEOM.MESH && v.mesh) loadMesh(v.mesh).then((gs) => gs.forEach((geo) => add(geo).scale.fromArray(v.dims))).catch(() => {});
  return holder;
}

function build(b, links) {
  const role = b.role, base = links[0];
  if (role === "part") { base.add(computerModel(b.visuals[0]?.rgba || [0.8, 0.8, 0.8])); return null; }
  if (role === "bin-left" || role === "bin-right") { const box = shippingBox(); base.add(box.group); return box; }
  if (role === "tool") { base.add(suctionTool()); return null; }
  if (role === "infeed" || role === "fixture") return null; // drawn by the conveyor model
  const objs = { "obj-mug": mugModel, "obj-apple": appleModel, "obj-plate": plateModel, "obj-phone": phoneModel, "obj-lamp": lampModel,
    "obj-pills": pillsModel, "obj-book": bookModel, "obj-stack": stackModel, "obj-remote": remoteModel, "obj-tray": trayModel,
    "obj-bowl": bowlModel, "obj-glass": glassModel, "obj-coaster": coasterModel,
    "obj-charger": chargerModel, "obj-can": canModel, "obj-plant": plantModel, "obj-keys": keysModel, "obj-treat": treatModel, "obj-dogbowl": dogBowlModel };
  if (objs[role]) { const m = objs[role](b.visuals[0]?.rgba || [1, 1, 1, 1]); base.add(m); return m; }
  for (const v of b.visuals) {
    const mat = role === "robot" ? robotMaterial(v.rgba) : role.startsWith("bin") ? mats.steelTray : new THREE.MeshStandardMaterial({ color: new THREE.Color(...v.rgba.slice(0, 3)), roughness: 0.6 });
    links[v.link + 1].add(buildGeneric(v, mat));
  }
  return null;
}

function applyScene(sc) {
  const seen = new Set();
  for (const [id, b] of Object.entries(sc.bodies)) {
    if (b.role === "plane") continue;
    seen.add(id);
    // bins keep their model across target highlighting; parts rebuild when repainted
    const sig = b.role + JSON.stringify(b.visuals.map((v) => [v.link, v.type, v.mesh, b.role.startsWith("bin") ? 0 : v.rgba]));
    const isTarget = b.role.startsWith("bin") && b.visuals.some((v) => v.rgba[1] > 0.95 && v.rgba[0] > 0.8);
    const cur = bodies.get(id);
    if (cur && cur.sig === sig) { cur.isTarget = isTarget; continue; }
    if (cur) cur.links.forEach((g) => world.remove(g));
    const maxLink = Math.max(-1, ...b.visuals.map((v) => v.link));
    const links = Array.from({ length: maxLink + 2 }, () => { const g = new THREE.Group(); world.add(g); return g; });
    const model = build(b, links);
    bodies.set(id, { role: b.role, links, sig, target: cur?.target, primed: !!cur?.primed, isTarget, model });
  }
  for (const [id, b] of bodies) if (!seen.has(id)) { b.links.forEach((g) => world.remove(g)); bodies.delete(id); }
}

// ---------------------------------------------------------------- snapshot interpolation
// PyBullet sends link poses ~50x/s with its own sim clock. We render ~100 ms behind the newest
// snapshot and blend between the two that bracket that moment: motion stays fluid at any
// frame rate and network jitter disappears (the standard technique for networked games).
const SNAP_DELAY = 0.1;
const snaps = [];
let clockOffset = null; // sim time - local time, smoothed
function applyPoses(t, poses) {
  const local = performance.now() / 1000;
  const off = t - local;
  clockOffset = clockOffset === null || Math.abs(off - clockOffset) > 0.5 ? off : clockOffset * 0.97 + off * 0.03;
  if (snaps.length && t <= snaps[snaps.length - 1].t) snaps.length = 0; // sim clock restarted
  snaps.push({ t, poses });
  while (snaps.length > 40) snaps.shift();
}
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), va = new THREE.Vector3();
function interpolatePoses(now) {
  if (!snaps.length) return;
  const rt = now / 1000 + clockOffset - SNAP_DELAY;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i - 1].t > rt) i--;
  const b = snaps[i], a = i > 0 ? snaps[i - 1] : b;
  const k = b.t > a.t ? THREE.MathUtils.clamp((rt - a.t) / (b.t - a.t), 0, 1) : 1;
  for (const [id, linksB] of Object.entries(b.poses)) {
    const body = bodies.get(id);
    if (!body) continue;
    const linksA = a.poses[id] || linksB;
    for (let j = 0; j < linksB.length; j++) {
      const g = body.links[j];
      if (!g) continue;
      const pa = linksA[j] || linksB[j], pb = linksB[j];
      g.position.set(pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k);
      qa.set(pa[3], pa[4], pa[5], pa[6]); qb.set(pb[3], pb[4], pb[5], pb[6]);
      g.quaternion.copy(qa).slerp(qb, k);
    }
  }
}

// ---------------------------------------------------------------- box shipping animation
const shipping = []; // {box, t0, dir}
window.addEventListener("box-ship", (e) => {
  const b = [...bodies.values()].find((x) => x.role === `bin-${e.detail}`);
  if (!b?.model) return;
  const p = b.links[0].position;
  shipping.push({ box: b.model, t0: performance.now(), dir: new THREE.Vector2(p.x, p.y).normalize() });
  sfx.play("tape");
});
function animateShipping(now) {
  for (let k = shipping.length - 1; k >= 0; k--) {
    const s = shipping[k], t = (now - s.t0) / 1000, box = s.box;
    // 0-0.6 s fold flaps shut, 0.6-0.9 tape, 1.0-1.9 slide out of the cell, 1.9-2.6 a fresh open box rises in
    box.setOpen(t < 0.6 ? 1 - THREE.MathUtils.smootherstep(t, 0, 0.6) : t < 1.9 ? 0 : THREE.MathUtils.smootherstep(t, 1.9, 2.6));
    box.tape.visible = t >= 0.6 && t < 1.9;
    box.tape.scale.y = THREE.MathUtils.clamp((t - 0.6) / 0.3, 0.01, 1);
    const out = t < 1.0 ? 0 : t < 1.9 ? THREE.MathUtils.smootherstep(t, 1.0, 1.9) * 1.6 : 0;
    box.body.position.set(s.dir.x * out, s.dir.y * out, t >= 1.9 && t < 2.6 ? -0.2 * (1 - THREE.MathUtils.smootherstep(t, 1.9, 2.6)) : 0);
    if (t > 2.6) { box.body.position.set(0, 0, 0); box.setOpen(1); box.tape.visible = false; shipping.splice(k, 1); }
  }
}

// ---------------------------------------------------------------- zone labels
const tags = [...document.querySelectorAll(".zone-tag")];
const v3 = new THREE.Vector3();
function placeTags() {
  const rect = renderer.domElement.getBoundingClientRect();
  for (const tag of tags) {
    const zone = tag.dataset.zone, role = zone === "rest" ? "infeed" : `bin-${zone}`;
    const b = [...bodies.values()].find((x) => x.role === role);
    if (!b || !b.links[0] || curScene === "home") { tag.style.opacity = 0; continue; }
    b.links[0].getWorldPosition(v3);
    v3.y += zone === "rest" ? 0.24 : zone === "left" || zone === "right" ? 0.3 : 0.1;
    v3.project(camera);
    tag.style.left = `${(v3.x * 0.5 + 0.5) * rect.width}px`;
    tag.style.top = `${(-v3.y * 0.5 + 0.5) * rect.height}px`;
    tag.style.opacity = v3.z < 1 ? 1 : 0;
    tag.classList.toggle("target", b.isTarget === true);
  }
}

// ---------------------------------------------------------------- sound
const sfx = new Sfx();
window.__sfx = sfx;
["pointerdown", "keydown"].forEach((ev) => window.addEventListener(ev, () => sfx.unlock(), { capture: true }));
window.addEventListener("sfx", (e) => sfx.play(e.detail));
const muteBtn = document.getElementById("mute");
function syncMute() { if (muteBtn) { muteBtn.textContent = sfx.muted ? "🔇" : "🔊"; muteBtn.title = sfx.muted ? "Sound off" : "Sound on"; muteBtn.setAttribute("aria-pressed", sfx.muted); } }
muteBtn?.addEventListener("click", () => { sfx.unlock(); sfx.setMuted(!sfx.muted); syncMute(); });
syncMute();
let prevHolding = false, prevLamp = false, prevTv = false;
function soundEvents(st) {
  if (st.holding && !prevHolding) sfx.play("grab");
  if (!st.holding && prevHolding) { sfx.play("release"); setTimeout(() => sfx.play("thud"), 380); }
  if (st.lampOn && !prevLamp) sfx.play("click");
  if (st.flags?.tv && !prevTv) { sfx.play("click"); setTimeout(() => sfx.play("level"), 200); }
  prevTv = !!st.flags?.tv;
  prevHolding = !!st.holding; prevLamp = !!st.lampOn;
  sfx.ring(st.level === "phone" && st.step === 0 && st.phase !== "loading");
}

// ---------------------------------------------------------------- connection
const off = document.getElementById("feed-off");
let simPhase = "";
function connect() {
  if (!location.protocol.startsWith("http")) { off.hidden = false; return; }
  const es = new EventSource("/api/events");
  es.addEventListener("scene", (e) => applyScene(JSON.parse(e.data)));
  es.addEventListener("pose", (e) => {
    const d = JSON.parse(e.data);
    applyPoses(d.t, d.poses);
    simPhase = d.state?.phase || "";
    if (d.state) { applyState(d.state); soundEvents(d.state); }
    off.hidden = true;
    window.dispatchEvent(new CustomEvent("sim-state", { detail: d.state }));
  });
  es.onerror = () => { off.hidden = false; window.dispatchEvent(new CustomEvent("sim-state", { detail: null })); };
}
connect();

// ---------------------------------------------------------------- 360 panorama (home scene)
// kie.ai-generated equirectangular kitchen: wraps around the viewer and lights the scene, so
// reflections on the robot, mug and phone come from the same room you see.
const PANO_YAW = Math.PI; // turn so the kitchen windows sit behind the robot
let panoSphere = null, panoEnv = null;
const factoryEnv = scene.environment;
// The photo is an ultra-wide (~180 deg) shot, not a full sphere, so it is mounted the way film
// sets hang a backing: a 240-degree curved cylinder around the seat, centred behind the robot.
// The head-turn limits keep its edges out of view.
const PANO = { r: 3.4, arc: THREE.MathUtils.degToRad(240), aspect: 3122 / 1338, horizon: 0.0, turn: THREE.MathUtils.degToRad(64) };
photo("assets/pano.jpg", (t) => {
  const envTex = t.clone(); envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.needsUpdate = true;
  panoEnv = pmrem.fromEquirectangular(envTex).texture;
  const h = (PANO.r * PANO.arc) / PANO.aspect;
  const geo = new THREE.CylinderGeometry(PANO.r, PANO.r, h, 128, 1, true, Math.PI * 1.5 - PANO.arc / 2, PANO.arc);
  panoSphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, toneMapped: false, fog: false }));
  panoSphere.scale.x = -1; // seen from inside: un-mirror
  panoSphere.position.set(CAMS.home.eye.x, CAMS.home.eye.y + PANO.horizon, CAMS.home.eye.z);
  panoSphere.rotation.y = PANO.turn; // put the kitchen (left part of the photo) behind the robot
  panoSphere.visible = curScene === "home";
  scene.add(panoSphere);
  for (const n of ["backdrop", "roomFloor"]) { const o = home.getObjectByName(n); if (o) o.visible = false; }
  if (curScene === "home") { scene.environment = panoEnv; scene.fog = null; }
});

// ---------------------------------------------------------------- scene presets + first-person camera
const CAMS = {
  // first person: seated at the table, eyes ~50 cm above the table top
  home: { eye: new THREE.Vector3(1.4, 0.5, 0.0), look: new THREE.Vector3(0.1, 0.3, 0), fov: 54 },
  packing: { pos: new THREE.Vector3(2.0, 1.55, 0.35), target: new THREE.Vector3(0.05, 0.22, 0), fov: 36 },
};
const fp = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, baseYaw: 0, basePitch: 0, userAt: -1e9, dragging: false, fovT: 54 };
{ const d = CAMS.home.look.clone().sub(CAMS.home.eye); fp.baseYaw = Math.atan2(d.z, d.x); fp.basePitch = Math.atan2(d.y, Math.hypot(d.x, d.z)); }
fp.yaw = fp.tYaw = fp.baseYaw; fp.pitch = fp.tPitch = fp.basePitch;
const cv = renderer.domElement;
cv.addEventListener("pointerdown", (e) => { if (curScene !== "home") return; fp.dragging = true; fp.lx = e.clientX; fp.ly = e.clientY; cv.setPointerCapture(e.pointerId); });
cv.addEventListener("pointermove", (e) => {
  if (!fp.dragging) return;
  fp.tYaw += (e.clientX - fp.lx) * 0.0032; fp.tPitch -= (e.clientY - fp.ly) * 0.0028;
  fp.tYaw = THREE.MathUtils.clamp(fp.tYaw, fp.baseYaw - 1.25, fp.baseYaw + 1.25);
  fp.tPitch = THREE.MathUtils.clamp(fp.tPitch, -1.0, 0.45);
  fp.lx = e.clientX; fp.ly = e.clientY; fp.userAt = performance.now();
});
cv.addEventListener("pointerup", () => (fp.dragging = false));
cv.addEventListener("wheel", (e) => { if (curScene !== "home") return; e.preventDefault(); fp.fovT = THREE.MathUtils.clamp(fp.fovT + Math.sign(e.deltaY) * 3, 34, 62); }, { passive: false });
cv.addEventListener("dblclick", () => { fp.tYaw = fp.baseYaw; fp.tPitch = fp.basePitch; fp.fovT = CAMS.home.fov; fp.userAt = -1e9; });

let curScene = "", simState = {};
const defaultBg = scene.background.clone();
function applyState(st) {
  simState = st;
  const sc = st.scene || "packing";
  if (sc === curScene) return;
  curScene = sc;
  const isHome = sc === "home";
  host.classList.add("fading"); setTimeout(() => host.classList.remove("fading"), 650); // hide the rebuild
  factoryItems.forEach((o) => (o.visible = !isHome));
  home.visible = isHome;
  if (panoSphere) panoSphere.visible = isHome;
  scene.background = isHome ? new THREE.Color(0xd8d2c6) : defaultBg;
  scene.environment = isHome && panoEnv ? panoEnv : factoryEnv;
  scene.fog = isHome ? (panoSphere ? null : new THREE.Fog(0xd8d2c6, 3, 7)) : new THREE.Fog(C.bg, 5, 11);
  key.color.set(isHome ? 0xfff1dc : 0xfff4e8);
  key.position.set(isHome ? -1.6 : 1.8, isHome ? 2.6 : 3.4, isHome ? -1.2 : 1.2);
  controls.enabled = !isHome;
  if (isHome) { fp.yaw = fp.tYaw = fp.baseYaw; fp.pitch = fp.tPitch = fp.basePitch; fp.fovT = CAMS.home.fov; camBaseFov = CAMS.home.fov; }
  else { const c = CAMS.packing; HOME_CAM.pos.copy(c.pos); HOME_CAM.target.copy(c.target); camera.position.copy(c.pos); controls.target.copy(c.target); camBaseFov = c.fov; }
  resize();
}
let focusRole = null;
window.addEventListener("sim-focus", (e) => { focusRole = e.detail; });

const gaze = new THREE.Vector3(), eyeW = new THREE.Vector3();
function updateFirstPerson(now, dt) {
  // attention: glance toward what matters (the held object, else the step's object) unless the user is looking around
  let want = null;
  const robot = [...bodies.values()].find((b) => b.role === "robot");
  if (simState.level === "tv" && simState.flags?.tv) want = tv; // the show is on: look at it
  else if (simState.holding && robot) want = robot.links[robot.links.length - 1];
  else if (focusRole) want = [...bodies.values()].find((b) => b.role === focusRole)?.links[0];
  if (want && now - fp.userAt > 2500) {
    want.getWorldPosition(gaze);
    const d = gaze.sub(CAMS.home.eye);
    const y = Math.atan2(d.z, d.x), p = Math.atan2(d.y, Math.hypot(d.x, d.z));
    const dy = Math.atan2(Math.sin(y - fp.baseYaw), Math.cos(y - fp.baseYaw)); // shortest turn, no wraparound
    const pull = want === tv ? 0.9 : 0.45;
    fp.tYaw = fp.baseYaw + dy * pull; fp.tPitch = fp.basePitch + (p - fp.basePitch) * pull;
  } else if (now - fp.userAt > 6000) { fp.tYaw = fp.baseYaw; fp.tPitch = fp.basePitch; }
  const k = 1 - Math.exp(-dt * (fp.dragging ? 14 : 2.6)); // critically damped head turn
  fp.yaw += (fp.tYaw - fp.yaw) * k; fp.pitch += (fp.tPitch - fp.pitch) * k;
  // breathing: a few millimetres of rise and fall, a hint of sway
  const s = now / 1000;
  eyeW.copy(CAMS.home.eye); eyeW.y += Math.sin(s * 1.25) * 0.004; eyeW.z += Math.sin(s * 0.55) * 0.003;
  camera.position.copy(eyeW);
  gaze.set(Math.cos(fp.pitch) * Math.cos(fp.yaw), Math.sin(fp.pitch), Math.cos(fp.pitch) * Math.sin(fp.yaw)).add(eyeW);
  camera.lookAt(gaze);
  camera.fov += (fp.fovT - camera.fov) * (1 - Math.exp(-dt * 6));
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- post-processing + adaptive quality
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, vignette: { value: 0.28 }, grain: { value: 0.03 }, warm: { value: 0.0 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time, vignette, grain, warm; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      col = mix(col, col * vec3(1.04, 1.0, 0.95), warm);                       // warm grade
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);                       // gentle S-curve
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.85);
      col *= mix(1.0 - vignette, 1.0, smoothstep(0.78, 0.2, length(d)));         // lens vignette
      col += (hash(vUv * 1400.0 + fract(time) * 91.0) - 0.5) * grain;            // film grain
      gl_FragColor = vec4(col, c.a);
    }`,
};
const rtarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, rtarget);
composer.addPass(new RenderPass(scene, camera));
let gtao = null;
try {
  gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.updateGtaoMaterial({ radius: 0.18, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
} catch (err) { gtao = null; console.warn("GTAO unavailable", err); }
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.4, 0.96);
composer.addPass(bloom);
const bokeh = new BokehPass(scene, camera, { focus: 1.0, aperture: 0.0016, maxblur: 0.0065 });
composer.addPass(bokeh);
composer.addPass(new OutputPass());
const grade = new ShaderPass(GradeShader);
composer.addPass(grade);

let quality = 2; // 2 = full, 1 = no AO / lower res, 0 = minimal
function setQuality(q) {
  quality = q;
  renderer.setPixelRatio(q === 2 ? Math.min(devicePixelRatio, 1.75) : q === 1 ? Math.min(devicePixelRatio, 1.25) : 1);
  if (gtao) gtao.enabled = q === 2;
  bloom.enabled = q >= 1;
  grade.uniforms.grain.value = q >= 1 ? 0.03 : 0;
  lampLight.castShadow = q >= 1;
  resize();
}
const frameTimes = [];
function watchPerformance(ms) {
  frameTimes.push(ms);
  if (frameTimes.length < 120) return;
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  frameTimes.length = 0;
  if (avg > 24 && quality > 0) setQuality(quality - 1); // under ~40 fps: trade effects for smoothness
}

// ---------------------------------------------------------------- loop
let last = performance.now();
const prevTool = new THREE.Vector3(), toolW = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const ms = now - last, dt = Math.min(0.05, ms / 1000); last = now;
  watchPerformance(ms);
  interpolatePoses(now);
  // servo sound follows the real speed of the tool
  const robot = [...bodies.values()].find((b) => b.role === "robot");
  if (robot) {
    robot.links[robot.links.length - 1].getWorldPosition(toolW);
    sfx.servo(dt > 0 ? toolW.distanceTo(prevTool) / dt : 0);
    prevTool.copy(toolW);
  }
  const ease = (rate) => 1 - Math.exp(-dt * rate); // frame-rate independent smoothing
  // the belt runs while a new computer is being fed in
  if (simPhase === "spawning") beltTex.offset.y -= dt * 1.4;
  // home details: the lamp, the ringing phone, the dusk in the "Lights" level
  const lampOn = !!simState.lampOn, dusk = simState.level === "lamp" && !lampOn;
  lampLight.intensity += ((lampOn ? 3.2 : 0) - lampLight.intensity) * ease(5);
  if (bulbMat) bulbMat.emissiveIntensity = lampLight.intensity * 1.2;
  if (curScene === "home") {
    key.intensity += ((dusk ? 0.45 : 2.2) - key.intensity) * ease(2.5);
    renderer.toneMappingExposure += ((dusk ? 0.5 : 1.0) - renderer.toneMappingExposure) * ease(2.5);
    grade.uniforms.warm.value = 1;
    if (panoSphere) panoSphere.material.color.setScalar(THREE.MathUtils.clamp(renderer.toneMappingExposure, 0.45, 1));
  } else { key.intensity = 2.6; renderer.toneMappingExposure = 1.05; grade.uniforms.warm.value = 0; }
  const tvLevel = simState.level === "tv", tvOn = !!simState.flags?.tv;
  tv.visible = curScene === "home" && tvLevel;
  tvScreenMat.emissiveMap = tvOn ? tvShow : null; tvScreenMat.map = tvOn ? tvShow : null; tvScreenMat.needsUpdate = tvOn !== tv.userData.on;
  tv.userData.on = tvOn;
  tvScreenMat.emissive.setHex(tvOn ? 0xffffff : 0x000000);
  tvScreenMat.emissiveIntensity = tvOn ? 0.9 + 0.08 * Math.sin(now / 90) : 0;
  tvLight.intensity += ((tvOn && tvLevel ? 1.6 : 0) - tvLight.intensity) * ease(4);
  // afternoon effects: charger ring pulses, the plant gets water and perks up
  const fl = simState.flags || {};
  chargeRingMat.emissiveIntensity += ((fl.charging ? 1.4 + 0.6 * Math.sin(now / 300) : 0) - chargeRingMat.emissiveIntensity) * ease(6);
  const pouring = simState.level === "plant" && simState.step === 1 && simState.phase === "acting";
  droplets.visible = pouring;
  if (pouring) droplets.children.forEach((d) => { const t = (now / 600 + d.userData.seed) % 1; d.position.set(Math.sin(d.userData.seed * 40) * 0.02, Math.cos(d.userData.seed * 40) * 0.02, 0.06 - t * 0.09); });
  if (plantLeaves) { const up = fl.watered ? 1 : 0.72; plantLeaves.scale.z += (up - plantLeaves.scale.z) * ease(1.5); plantLeaves.children.forEach((l) => (l.material.color.setHex(fl.watered ? 0x4f9a46 : 0x5f7d3a))); }
  const phone = [...bodies.values()].find((b) => b.role === "obj-phone");
  if (phone?.model) {
    const ringing = simState.level === "phone" && simState.step === 0;
    phone.model.userData.inner.position.x = ringing && Math.sin(now / 40) > 0.3 ? Math.sin(now / 9) * 0.0015 : 0;
    phone.model.userData.screen.material.emissiveIntensity = ringing ? 0.7 + 0.3 * Math.sin(now / 180) : 0.15;
  }
  // target marker: the bin for packing, or the object the current step acts on at home
  const tb = curScene === "home"
    ? [...bodies.values()].find((b) => b.role === focusRole && b.links[0])
    : [...bodies.values()].find((b) => b.isTarget && b.links[0]);
  marker.visible = !!tb && !(curScene === "home" && simState.holding);
  if (tb) {
    marker.position.set(tb.links[0].position.x, tb.links[0].position.y, 0);
    const s = Math.sin(now / 320);
    mats.glow.opacity = 0.45 + 0.25 * s;
    chevron.position.z = (tb.role === "bin-left" || tb.role === "bin-right" ? BOX.h : tb.role === "obj-lamp" ? 0.45 : 0.1) + (curScene === "home" ? 0.08 : 0.2) + 0.03 * s;
    marker.scale.setScalar(curScene === "home" ? 0.45 : 1);
  }
  // packing only uses BOX A / BOX B: keep the rear trays out of the picture there
  const packing = document.body.dataset.view === "task" || document.body.classList.contains("simple");
  for (const b of bodies.values()) if (b.role === "bin-fists" || b.role === "bin-feet") b.links.forEach((g) => (g.visible = !packing));
  animateShipping(now);
  if (curScene === "home") updateFirstPerson(now, dt); else controls.update();
  grade.uniforms.time.value = now / 1000;
  // lens: focus on the robot's wrist (or the step's object), only in the first-person scene
  bokeh.enabled = quality === 2 && curScene === "home";
  if (bokeh.enabled) {
    const fr = [...bodies.values()].find((b) => b.role === "robot");
    const fo = focusRole && [...bodies.values()].find((b) => b.role === focusRole);
    const tgt = simState.holding || !fo ? fr?.links[fr.links.length - 1] : fo.links[0];
    if (tgt) { tgt.getWorldPosition(gaze); const d = camera.position.distanceTo(gaze); bokeh.uniforms.focus.value += (d - bokeh.uniforms.focus.value) * ease(4); }
  }
  // wrist status LED
  const ledTarget = performance.now() < toolLed.until ? toolLed.color : new THREE.Color(0xffffff);
  ledMat.emissive.lerp(ledTarget, ease(8));
  ledMat.emissiveIntensity = performance.now() < toolLed.until ? 2.2 + 0.6 * Math.sin(now / 120) : 0.7;
  if (toolLed.glow) { toolLed.glow.color.copy(ledMat.emissive); toolLed.glow.intensity = ledMat.emissiveIntensity * 0.25; }
  composer.render();
  placeTags();
}
function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio?.(renderer.getPixelRatio());
  composer.setSize(w, h);
  bloom.setSize(w, h);
  gtao?.setSize?.(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  camera.aspect = w / h;
  if (curScene !== "home") camera.fov = w / h < 1.1 ? camBaseFov + 12 : camBaseFov;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
setQuality(2);
requestAnimationFrame(frame);
