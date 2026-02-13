import * as THREE from "three";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";

const RENDER_SCALE = 0.5;

const canvas = document.getElementById("game-canvas");
const statusEl = document.getElementById("status");
const ff7UiEl = document.getElementById("ff7-ui");
const ff7NameEl = document.getElementById("ff7-name");
const ff7TextEl = document.getElementById("ff7-text");

function setStatus(text) {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setDialogueLine(speaker, text) {
  if (ff7NameEl) {
    ff7NameEl.textContent = speaker;
  }
  if (ff7TextEl) {
    ff7TextEl.textContent = text;
  }
}

function setDialogueVisible(visible) {
  if (!ff7UiEl) {
    return;
  }
  ff7UiEl.classList.toggle("hidden", !visible);
}

const bgm = new Audio("./public/assets/audio/tifa-theme.mp3");
bgm.loop = true;
bgm.volume = 0.45;
bgm.preload = "auto";
let bgmStarted = false;

const CUTSCENE_TRACK_URL = "./public/assets/audio/feel-special.mp3";
const CUTSCENE_TRACK_START = 52;
let bgmPausedAt = 0;
let cutsceneTrackActive = false;
const webAudio = {
  ctx: null,
  gain: null,
  buffer: null,
  loadingPromise: null,
  source: null,
};

function ensureAudioContext() {
  if (webAudio.ctx) {
    return webAudio.ctx;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return null;
  }

  webAudio.ctx = new AudioCtx();
  webAudio.gain = webAudio.ctx.createGain();
  webAudio.gain.gain.value = 0.55;
  webAudio.gain.connect(webAudio.ctx.destination);
  return webAudio.ctx;
}

async function ensureCutsceneBuffer() {
  if (webAudio.buffer) {
    return webAudio.buffer;
  }
  if (webAudio.loadingPromise) {
    return webAudio.loadingPromise;
  }

  const ctx = ensureAudioContext();
  if (!ctx) {
    throw new Error("Web Audio API is unavailable.");
  }

  webAudio.loadingPromise = fetch(CUTSCENE_TRACK_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load cutscene track: ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .then((arrayBuffer) => ctx.decodeAudioData(arrayBuffer.slice(0)))
    .then((decodedBuffer) => {
      webAudio.buffer = decodedBuffer;
      webAudio.loadingPromise = null;
      return decodedBuffer;
    })
    .catch((error) => {
      webAudio.loadingPromise = null;
      throw error;
    });

  return webAudio.loadingPromise;
}

function stopCutsceneSource() {
  if (!webAudio.source) {
    return;
  }
  try {
    webAudio.source.stop();
  } catch {
    // Ignore source stop errors.
  }
  try {
    webAudio.source.disconnect();
  } catch {
    // Ignore source disconnect errors.
  }
  webAudio.source = null;
}

function startBgmIfNeeded() {
  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  if (!webAudio.buffer && !webAudio.loadingPromise) {
    ensureCutsceneBuffer().catch(() => {});
  }

  if (bgmStarted) {
    return;
  }
  bgmStarted = true;
  bgm.play().catch(() => {
    bgmStarted = false;
  });
}

function startCutsceneTrack() {
  if (cutsceneTrackActive) {
    return;
  }

  cutsceneTrackActive = true;
  bgmPausedAt = bgm.currentTime || 0;
  bgm.pause();

  const recoverToBgm = () => {
    cutsceneTrackActive = false;
    stopCutsceneSource();
    bgm.currentTime = bgmPausedAt;
    bgm.play().catch(() => {
      bgmStarted = false;
    });
  };

  const ctx = ensureAudioContext();
  if (!ctx) {
    recoverToBgm();
    return;
  }

  const resumePromise = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
  resumePromise
    .then(() => ensureCutsceneBuffer())
    .then((buffer) => {
      if (!cutsceneTrackActive) {
        return;
      }

      stopCutsceneSource();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(webAudio.gain);
      webAudio.source = source;

      const maxOffset = Math.max(0, buffer.duration - 0.05);
      const startOffset = Math.min(CUTSCENE_TRACK_START, maxOffset);
      source.start(0, startOffset);

      source.onended = () => {
        if (webAudio.source === source) {
          webAudio.source = null;
        }
      };
    })
    .catch(() => {
      recoverToBgm();
    });
}

function stopCutsceneTrackAndResumeBgm() {
  if (!cutsceneTrackActive) {
    return;
  }

  cutsceneTrackActive = false;
  stopCutsceneSource();
  bgm.currentTime = bgmPausedAt;
  bgm.play().catch(() => {
    bgmStarted = false;
  });
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa54b7d);
scene.fog = new THREE.Fog(0xa54b7d, 16, 58);

const camera = new THREE.PerspectiveCamera(
  52,
  4 / 3,
  0.1,
  120,
);
camera.position.set(0, 1.75, -4.2);

const hemisphere = new THREE.HemisphereLight(0xffd0e4, 0x2f1322, 0.95);
scene.add(hemisphere);

const sun = new THREE.DirectionalLight(0xffb9d6, 0.68);
sun.position.set(-10, 15, -6);
scene.add(sun);

const keyState = {};
const worldBounds = 24;
const GRAVITY = 18;
const JUMP_SPEED = 7.3;
const cameraUpAxis = new THREE.Vector3(0, 1, 0);
const cameraFollowOffset = new THREE.Vector3(0, 1.75, -4.2);
const cameraLookOffset = new THREE.Vector3(0, 1.15, 0);
const tmpTarget = new THREE.Vector3();
const tmpDesiredCameraPos = new THREE.Vector3();
const tmpOffset = new THREE.Vector3();
const tmpLookYawVec = new THREE.Vector3();
const tmpCutsceneTarget = new THREE.Vector3();
const tmpCutsceneCamPos = new THREE.Vector3();
const tmpCutsceneOffset = new THREE.Vector3();

function resizeRenderer() {
  const displayWidth = Math.max(1, Math.floor(canvas.clientWidth));
  const displayHeight = Math.max(1, Math.floor(canvas.clientHeight));
  const renderWidth = Math.max(320, Math.round(displayWidth * RENDER_SCALE));
  const renderHeight = Math.max(180, Math.round(displayHeight * RENDER_SCALE));

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    renderer.setSize(renderWidth, renderHeight, false);
  }
  camera.aspect = displayWidth / displayHeight;
  camera.updateProjectionMatrix();
}

const player = {
  yaw: Math.PI,
  visualYaw: Math.PI,
  speed: 4,
  turnSpeed: 2.8,
  verticalVelocity: 0,
  onGround: true,
  position: new THREE.Vector3(0, 0, 0),
};
let jumpQueued = false;

const playerRig = new THREE.Object3D();
scene.add(playerRig);

let tifaModel = null;
let tifaBaseY = 0;
let roseAssets = null;

const cloudNpc = {
  rig: new THREE.Object3D(),
  model: null,
  baseY: 0,
  position: new THREE.Vector3(5.6, 0, 2.6),
  talkRadius: 2.2,
  replayResetRadius: 7.5,
};
scene.add(cloudNpc.rig);
cloudNpc.rig.position.copy(cloudNpc.position);

const cutsceneScript = [
  { speaker: "Cloud", text: "Hello Andrea Zhang, we've been waiting for you" },
  { speaker: "Tifa", text: "Who's Andrea?" },
  { speaker: "Cloud", text: "The person behind the screen" },
  { speaker: "Tifa", text: "Oh oh yeah Cloud, I remember now" },
  { speaker: "Cloud & Tifa", text: "1" },
  { speaker: "Cloud & Tifa", text: "2" },
  { speaker: "Cloud & Tifa", text: "3" },
  { speaker: "Cloud & Tifa", text: "Will you be my valentine!!!", spin: true },
];

const cutsceneState = {
  active: false,
  done: false,
  stepIndex: -1,
  stepElapsed: 0,
  advanceRequested: false,
  spinning: false,
  spinElapsed: 0,
  spinBaseTifaYaw: 0,
  spinBaseCloudYaw: 0,
};

function updateTifaPose(forwardInput, dt, elapsed) {
  if (!tifaModel) {
    return;
  }

  const isMoving = Math.abs(forwardInput) > 0.02;
  const bob = isMoving ? Math.sin(elapsed * 14) * 0.055 : 0;
  tifaModel.position.y = tifaBaseY + bob;
}

function updateCloudPose(elapsed) {
  if (!cloudNpc.model) {
    return;
  }
  cloudNpc.model.position.y = cloudNpc.baseY + Math.sin(elapsed * 3.4) * 0.025;
}

function faceYaw(fromPos, toPos) {
  tmpLookYawVec.copy(toPos).sub(fromPos);
  return Math.atan2(-tmpLookYawVec.x, -tmpLookYawVec.z);
}

function startCloudCutscene() {
  if (cutsceneState.active || cutsceneState.done || !tifaModel || !cloudNpc.model) {
    return;
  }

  cutsceneState.active = true;
  cutsceneState.stepIndex = -1;
  cutsceneState.stepElapsed = 0;
  cutsceneState.advanceRequested = false;
  cutsceneState.spinning = false;
  cutsceneState.spinElapsed = 0;
  advanceCutsceneStep();
}

function advanceCutsceneStep() {
  cutsceneState.stepIndex += 1;
  if (cutsceneState.stepIndex >= cutsceneScript.length) {
    endCloudCutscene();
    return;
  }

  const step = cutsceneScript[cutsceneState.stepIndex];
  cutsceneState.stepElapsed = 0;
  cutsceneState.advanceRequested = false;
  cutsceneState.spinning = !!step.spin;
  cutsceneState.spinElapsed = 0;
  setDialogueLine(step.speaker, step.text);
  setDialogueVisible(true);

  if (cutsceneState.spinning) {
    cutsceneState.spinBaseTifaYaw = faceYaw(player.position, camera.position);
    cutsceneState.spinBaseCloudYaw = faceYaw(cloudNpc.rig.position, camera.position);
    startCutsceneTrack();
  }
}

function endCloudCutscene() {
  cutsceneState.active = false;
  cutsceneState.done = true;
  cutsceneState.spinning = false;
  setDialogueVisible(false);
  stopCutsceneTrackAndResumeBgm();
}

function updateCutscene(dt, elapsed) {
  if (!cutsceneState.active || !cloudNpc.model || !tifaModel) {
    return;
  }

  const cloudPos = cloudNpc.rig.position;
  const tifaPos = player.position;

  if (cutsceneState.spinning) {
    cutsceneState.spinElapsed += dt;
    const spinSpeed = 8.6;
    const turnToCameraTime = 0.55;

    if (cutsceneState.spinElapsed < turnToCameraTime) {
      player.visualYaw = dampAngle(
        player.visualYaw,
        cutsceneState.spinBaseTifaYaw,
        24,
        dt,
      );
      cloudNpc.rig.rotation.y = dampAngle(
        cloudNpc.rig.rotation.y,
        cutsceneState.spinBaseCloudYaw,
        24,
        dt,
      );
    } else {
      const spinTime = cutsceneState.spinElapsed - turnToCameraTime;
      player.visualYaw = cutsceneState.spinBaseTifaYaw + spinTime * spinSpeed;
      cloudNpc.rig.rotation.y = cutsceneState.spinBaseCloudYaw + spinTime * spinSpeed;
    }
  } else {
    const tifaToCloud = faceYaw(tifaPos, cloudPos);
    const cloudToTifa = faceYaw(cloudPos, tifaPos);
    player.visualYaw = dampAngle(player.visualYaw, tifaToCloud, 11, dt);
    cloudNpc.rig.rotation.y = dampAngle(cloudNpc.rig.rotation.y, cloudToTifa, 11, dt);
  }

  updateVerticalMotion(dt, false);

  playerRig.position.copy(player.position);
  playerRig.rotation.y = player.visualYaw;
  updateTifaPose(0, dt, elapsed);

  cutsceneState.stepElapsed += dt;
  const canAdvance = cutsceneState.stepElapsed > 0.12;
  if (cutsceneState.advanceRequested && canAdvance) {
    advanceCutsceneStep();
  }
}

function updateCutsceneCamera(dt) {
  const cloudPos = cloudNpc.rig.position;
  tmpCutsceneTarget.copy(player.position).add(cloudPos).multiplyScalar(0.5);
  tmpCutsceneTarget.y = 1.25;

  const pairYaw = Math.atan2(cloudPos.x - player.position.x, cloudPos.z - player.position.z);
  tmpCutsceneOffset.set(0, 1.75, -5.2).applyAxisAngle(cameraUpAxis, pairYaw + 0.95);
  tmpCutsceneCamPos.copy(tmpCutsceneTarget).add(tmpCutsceneOffset);

  const blend = 1 - Math.exp(-7 * dt);
  camera.position.lerp(tmpCutsceneCamPos, blend);
  camera.lookAt(tmpCutsceneTarget);
}

window.addEventListener("keydown", (event) => {
  startBgmIfNeeded();

  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat && !cutsceneState.active) {
      jumpQueued = true;
    }
  }

  if (cutsceneState.active && (event.code === "Enter" || event.code === "KeyE")) {
    cutsceneState.advanceRequested = true;
    event.preventDefault();
  }

  keyState[event.code] = true;
  if (event.code.startsWith("Arrow")) {
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  keyState[event.code] = false;
});
window.addEventListener("resize", resizeRenderer);
window.addEventListener("pointerdown", () => {
  startBgmIfNeeded();
  if (cutsceneState.active) {
    cutsceneState.advanceRequested = true;
  }
});

function createGroundTexture() {
  const texCanvas = document.createElement("canvas");
  texCanvas.width = 64;
  texCanvas.height = 64;
  const ctx = texCanvas.getContext("2d");

  ctx.fillStyle = "#8f4566";
  ctx.fillRect(0, 0, 64, 64);

  for (let y = 0; y < 64; y += 8) {
    for (let x = 0; x < 64; x += 8) {
      const evenTile = ((x + y) / 8) % 2 === 0;
      ctx.fillStyle = evenTile ? "#bd5f8b" : "#9c4e74";
      ctx.fillRect(x, y, 8, 8);
    }
  }

  ctx.fillStyle = "#f7c6da";
  for (let i = 0; i < 16; i += 1) {
    const px = (i * 13) % 64;
    const py = (i * 19) % 64;
    ctx.fillRect(px, py, 2, 2);
  }

  const tex = new THREE.CanvasTexture(texCanvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function applyPs1MaterialEffects(material, options = {}) {
  if (!material) {
    return;
  }
  const enableVertexSnap = options.enableVertexSnap ?? true;

  const materialId = `${material.name || ""} ${material.map?.name || ""}`;
  const isFaceOverlay = /(eye|mouth|aahcMaterial|aahdMaterial|aaheMaterial)/i.test(
    materialId,
  );

  material.flatShading = true;
  material.dithering = true;
  material.side = THREE.DoubleSide;

  if (material.map) {
    material.map.minFilter = THREE.NearestFilter;
    material.map.magFilter = THREE.NearestFilter;
    material.map.generateMipmaps = false;
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.map.needsUpdate = true;
  }

  material.alphaTest = isFaceOverlay ? 0.2 : 0;
  material.transparent = isFaceOverlay;
  material.depthWrite = true;

  if (enableVertexSnap) {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        vec4 projected = projectionMatrix * mvPosition;
        float snapStrength = 180.0;
        projected.xy = floor(projected.xy * snapStrength) / snapStrength;
        gl_Position = projected;
        `,
      );
    };
    material.customProgramCacheKey = () => "ps1-snap-on";
  } else {
    material.onBeforeCompile = () => {};
    material.customProgramCacheKey = () => "ps1-snap-off";
  }

  material.needsUpdate = true;
}

function applyPs1MeshEffects(mesh, options = {}) {
  if (!mesh.isMesh) {
    return;
  }

  const hasVertexColorData = !!mesh.geometry?.getAttribute("color");

  if (Array.isArray(mesh.material)) {
    mesh.material.forEach((mat) => {
      if ("vertexColors" in mat) {
        mat.vertexColors = hasVertexColorData;
      }
      applyPs1MaterialEffects(mat, options);
    });
    return;
  }

  if ("vertexColors" in mesh.material) {
    mesh.material.vertexColors = hasVertexColorData;
  }
  applyPs1MaterialEffects(mesh.material, options);
}

function createEnvironment() {
  const groundMaterial = new THREE.MeshLambertMaterial({
    map: createGroundTexture(),
  });
  applyPs1MaterialEffects(groundMaterial);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), groundMaterial);
  ground.rotation.x = -Math.PI * 0.5;
  scene.add(ground);

  const heartTexture = createHeartTexture();
  const heartSignMaterial = new THREE.SpriteMaterial({
    map: heartTexture,
    transparent: true,
    depthWrite: false,
    color: 0xffffff,
  });

  const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
  const ribbonGeo = new THREE.BoxGeometry(1, 1, 1);
  const bowGeo = new THREE.SphereGeometry(0.24, 6, 5);
  const buildingColors = [0x9f3d65, 0xb25c86, 0x7a3350, 0xc977a0, 0x8e3558];
  const ribbonColors = [0xfec5dd, 0xffd8ec, 0xf9a7ca];

  for (let gx = -4; gx <= 4; gx += 2) {
    for (let gz = -4; gz <= 4; gz += 2) {
      if (Math.abs(gx) <= 1 && Math.abs(gz) <= 1) {
        continue;
      }

      const px = gx * 4.6;
      const pz = gz * 4.6;

      const widthDepth = 2.35 + ((Math.abs(gx + gz) % 3) * 0.3);
      const height = 1.7 + ((Math.abs(gx * 5 + gz * 3) % 4) * 0.42);

      const baseMat = new THREE.MeshLambertMaterial({
        color: buildingColors[Math.abs(gx * 3 + gz * 7) % buildingColors.length],
      });
      const ribbonMat = new THREE.MeshLambertMaterial({
        color: ribbonColors[Math.abs(gx * 11 + gz * 13) % ribbonColors.length],
      });
      const bowMat = new THREE.MeshLambertMaterial({ color: 0xff7cae });
      applyPs1MaterialEffects(baseMat);
      applyPs1MaterialEffects(ribbonMat);
      applyPs1MaterialEffects(bowMat);

      const base = new THREE.Mesh(buildingGeo, baseMat);
      base.scale.set(widthDepth, height, widthDepth);
      base.position.set(px, height * 0.5, pz);
      scene.add(base);

      const ribbonA = new THREE.Mesh(ribbonGeo, ribbonMat);
      ribbonA.scale.set(widthDepth * 1.02, height * 1.01, 0.2);
      ribbonA.position.set(px, height * 0.5, pz);
      scene.add(ribbonA);

      const ribbonB = new THREE.Mesh(ribbonGeo, ribbonMat);
      ribbonB.scale.set(0.2, height * 1.01, widthDepth * 1.02);
      ribbonB.position.set(px, height * 0.5, pz);
      scene.add(ribbonB);

      const bowL = new THREE.Mesh(bowGeo, bowMat);
      bowL.position.set(px - 0.22, height + 0.24, pz);
      bowL.scale.set(0.62, 0.42, 0.48);
      scene.add(bowL);

      const bowR = new THREE.Mesh(bowGeo, bowMat);
      bowR.position.set(px + 0.22, height + 0.24, pz);
      bowR.scale.set(0.62, 0.42, 0.48);
      scene.add(bowR);

      const sign = new THREE.Sprite(heartSignMaterial.clone());
      sign.position.set(px, height + 0.9, pz);
      sign.scale.set(0.95, 0.95, 0.95);
      const hue = 0.92 + Math.random() * 0.05;
      sign.material.color.setHSL(hue, 0.58, 0.7);
      scene.add(sign);
    }
  }

  for (let i = 0; i < 80; i += 1) {
    const heart = new THREE.Sprite(heartSignMaterial.clone());
    const px = (Math.random() - 0.5) * 64;
    const pz = (Math.random() - 0.5) * 64;
    const nearCenter = Math.abs(px) < 5.5 && Math.abs(pz) < 5.5;
    if (nearCenter) {
      i -= 1;
      continue;
    }

    const scale = 0.52 + Math.random() * 1.15;
    heart.position.set(px, 4.6 + Math.random() * 4.3, pz);
    heart.scale.set(scale, scale, scale);

    const hue = 0.9 + Math.random() * 0.1;
    const sat = 0.45 + Math.random() * 0.3;
    const light = 0.62 + Math.random() * 0.24;
    heart.material.color.setHSL((hue + 1) % 1, sat, Math.min(0.9, light));
    scene.add(heart);
  }

  for (let i = 0; i < 95; i += 1) {
    const angle = (i / 95) * Math.PI * 2;
    const radius = 7.8 + ((i % 7) * 1.45) + Math.random() * 0.55;
    const px = Math.cos(angle) * radius + (Math.random() - 0.5) * 0.45;
    const pz = Math.sin(angle) * radius + (Math.random() - 0.5) * 0.45;
    const scale = 0.74 + Math.random() * 0.52;
    createRoseProp(px, pz, scale);
  }
}

function createHeartTexture() {
  const size = 64;
  const texCanvas = document.createElement("canvas");
  texCanvas.width = size;
  texCanvas.height = size;
  const ctx = texCanvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, "#ffd8e9");
  gradient.addColorStop(1, "#ff4f97");

  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.82);
  ctx.bezierCurveTo(size * 0.18, size * 0.62, size * 0.12, size * 0.34, size * 0.3, size * 0.22);
  ctx.bezierCurveTo(size * 0.42, size * 0.12, size * 0.5, size * 0.24, size * 0.5, size * 0.3);
  ctx.bezierCurveTo(size * 0.5, size * 0.24, size * 0.58, size * 0.12, size * 0.7, size * 0.22);
  ctx.bezierCurveTo(size * 0.88, size * 0.34, size * 0.82, size * 0.62, size * 0.5, size * 0.82);
  ctx.closePath();

  ctx.fillStyle = gradient;
  ctx.fill();

  const tex = new THREE.CanvasTexture(texCanvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function getRoseAssets() {
  if (roseAssets) {
    return roseAssets;
  }

  const stemMaterial = new THREE.MeshLambertMaterial({ color: 0x2f8a4e });
  const leafMaterial = new THREE.MeshLambertMaterial({ color: 0x4fbf6e });
  const bloomMaterial = new THREE.MeshLambertMaterial({ color: 0xc9144a });
  const petalMaterial = new THREE.MeshLambertMaterial({ color: 0xf2487f });
  applyPs1MaterialEffects(stemMaterial);
  applyPs1MaterialEffects(leafMaterial);
  applyPs1MaterialEffects(bloomMaterial);
  applyPs1MaterialEffects(petalMaterial);

  roseAssets = {
    stemGeometry: new THREE.CylinderGeometry(0.045, 0.055, 0.9, 5),
    leafGeometryA: new THREE.ConeGeometry(0.12, 0.22, 4),
    leafGeometryB: new THREE.ConeGeometry(0.11, 0.2, 4),
    bloomGeometry: new THREE.IcosahedronGeometry(0.2, 0),
    petalGeometry: new THREE.IcosahedronGeometry(0.1, 0),
    stemMaterial,
    leafMaterial,
    bloomMaterial,
    petalMaterial,
  };

  return roseAssets;
}

function createRoseProp(x, z, scale = 1) {
  const assets = getRoseAssets();

  const stem = new THREE.Mesh(assets.stemGeometry, assets.stemMaterial);
  stem.position.set(x, 0.45 * scale, z);
  stem.scale.set(scale, scale, scale);
  scene.add(stem);

  const leafA = new THREE.Mesh(assets.leafGeometryA, assets.leafMaterial);
  leafA.position.set(x - 0.09 * scale, 0.54 * scale, z + 0.09 * scale);
  leafA.rotation.set(Math.PI * 0.5, 0.7, Math.PI * 0.15);
  leafA.scale.set(scale, scale, scale);
  scene.add(leafA);

  const leafB = new THREE.Mesh(assets.leafGeometryB, assets.leafMaterial);
  leafB.position.set(x + 0.11 * scale, 0.64 * scale, z - 0.08 * scale);
  leafB.rotation.set(Math.PI * 0.5, -0.9, -Math.PI * 0.1);
  leafB.scale.set(scale, scale, scale);
  scene.add(leafB);

  const bloomCore = new THREE.Mesh(assets.bloomGeometry, assets.bloomMaterial);
  bloomCore.position.set(x, 0.98 * scale, z);
  bloomCore.scale.set(scale, scale, scale);
  scene.add(bloomCore);

  const petal1 = new THREE.Mesh(assets.petalGeometry, assets.petalMaterial);
  petal1.position.set(x + 0.1 * scale, 1.03 * scale, z + 0.03 * scale);
  petal1.scale.set(1.1 * scale, 1.1 * scale, 1.1 * scale);
  scene.add(petal1);

  const petal2 = new THREE.Mesh(assets.petalGeometry, assets.petalMaterial);
  petal2.position.set(x - 0.09 * scale, 1.0 * scale, z - 0.06 * scale);
  petal2.scale.set(scale, scale, scale);
  scene.add(petal2);

  const petal3 = new THREE.Mesh(assets.petalGeometry, assets.petalMaterial);
  petal3.position.set(x + 0.01 * scale, 1.08 * scale, z - 0.1 * scale);
  petal3.scale.set(scale, scale, scale);
  scene.add(petal3);
}

function fitModelToPlayerHeight(modelRoot, targetHeight) {
  modelRoot.updateMatrixWorld(true);
  const initialBounds = new THREE.Box3().setFromObject(modelRoot);
  const initialSize = new THREE.Vector3();
  initialBounds.getSize(initialSize);

  if (initialSize.y <= Number.EPSILON) {
    return;
  }

  const scale = targetHeight / initialSize.y;
  modelRoot.scale.multiplyScalar(scale);

  modelRoot.updateMatrixWorld(true);
  const scaledBounds = new THREE.Box3().setFromObject(modelRoot);
  const center = new THREE.Vector3();
  scaledBounds.getCenter(center);

  modelRoot.position.x -= center.x;
  modelRoot.position.z -= center.z;
  modelRoot.position.y -= scaledBounds.min.y;
}

function orientModelUpright(modelRoot) {
  const trials = [
    new THREE.Euler(0, 0, 0),
    new THREE.Euler(-Math.PI * 0.5, 0, 0),
    new THREE.Euler(Math.PI * 0.5, 0, 0),
    new THREE.Euler(0, 0, -Math.PI * 0.5),
    new THREE.Euler(0, 0, Math.PI * 0.5),
  ];

  const originalPosition = modelRoot.position.clone();
  let bestRotation = trials[0];
  let bestScore = -Infinity;

  for (const candidate of trials) {
    modelRoot.rotation.set(candidate.x, candidate.y, candidate.z);
    modelRoot.position.copy(originalPosition);
    modelRoot.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    bounds.getSize(size);

    const horizontalSpan = Math.max(size.x, size.z, 1e-6);
    const score = size.y / horizontalSpan;
    if (Number.isFinite(score) && score > bestScore) {
      bestScore = score;
      bestRotation = candidate;
    }
  }

  modelRoot.rotation.set(bestRotation.x, bestRotation.y, bestRotation.z);
  modelRoot.position.copy(originalPosition);
  modelRoot.updateMatrixWorld(true);
}

function cloneMaterialTree(material) {
  if (Array.isArray(material)) {
    return material.map((mat) => (mat?.clone ? mat.clone() : mat));
  }
  return material?.clone ? material.clone() : material;
}

function bakeColladaToStaticGroup(colladaScene) {
  const baked = new THREE.Group();
  colladaScene.updateMatrixWorld(true);

  colladaScene.traverse((object3d) => {
    if (!object3d.isMesh || !object3d.geometry) {
      return;
    }

    const bakedGeometry = object3d.geometry.clone();
    bakedGeometry.applyMatrix4(object3d.matrixWorld);

    const bakedMaterial = cloneMaterialTree(object3d.material);
    const bakedMesh = new THREE.Mesh(bakedGeometry, bakedMaterial);
    bakedMesh.name = object3d.name;
    baked.add(bakedMesh);
  });

  return baked;
}

function loadTifaModel() {
  const loader = new ColladaLoader();
  const modelPath = "./public/assets/characters/tifa/Tifa/Tifa.dae";

  loader.load(
    modelPath,
    (collada) => {
      const model = bakeColladaToStaticGroup(collada.scene);
      model.traverse((object3d) => {
        // Disable vertex snapping on the character; with this COLLADA it can
        // collapse visible detail into a blob.
        applyPs1MeshEffects(object3d, { enableVertexSnap: false });
      });

      orientModelUpright(model);
      fitModelToPlayerHeight(model, 1.8);
      model.rotation.y += Math.PI;

      tifaBaseY = model.position.y;
      tifaModel = model;
      playerRig.add(model);

      setStatus("Loaded. Hover-walk active. Move with WASD / Arrow keys.");
    },
    (progressEvent) => {
      if (!progressEvent.total) {
        return;
      }
      const ratio = progressEvent.loaded / progressEvent.total;
      const percentage = Math.min(100, Math.round(ratio * 100));
      setStatus(`Loading Tifa model... ${percentage}%`);
    },
    (error) => {
      setStatus("Model failed to load. Check console and asset path.");
      console.error("Tifa model load error:", error);
    },
  );
}

function loadCloudModel() {
  const loader = new ColladaLoader();
  const modelPath = "./public/assets/characters/cloud/Cloud/Cloud.dae";

  loader.load(
    modelPath,
    (collada) => {
      const model = bakeColladaToStaticGroup(collada.scene);
      model.traverse((object3d) => {
        applyPs1MeshEffects(object3d, { enableVertexSnap: false });
      });

      orientModelUpright(model);
      fitModelToPlayerHeight(model, 1.82);
      model.rotation.y += Math.PI;

      cloudNpc.baseY = model.position.y;
      cloudNpc.model = model;
      cloudNpc.rig.add(model);
      cloudNpc.rig.position.copy(cloudNpc.position);
      cloudNpc.rig.rotation.y = faceYaw(cloudNpc.rig.position, player.position);
    },
    undefined,
    (error) => {
      console.error("Cloud model load error:", error);
    },
  );
}

function getAxis(positiveKey, negativeKey) {
  const pos = keyState[positiveKey] ? 1 : 0;
  const neg = keyState[negativeKey] ? 1 : 0;
  return pos - neg;
}

function dampAngle(current, target, sharpness, dt) {
  const blend = 1 - Math.exp(-sharpness * dt);
  const delta = Math.atan2(
    Math.sin(target - current),
    Math.cos(target - current),
  );
  return current + delta * blend;
}

function updateVerticalMotion(dt, allowJump = true) {
  if (allowJump && jumpQueued && player.onGround) {
    player.verticalVelocity = JUMP_SPEED;
    player.onGround = false;
  }
  jumpQueued = false;

  player.verticalVelocity -= GRAVITY * dt;
  player.position.y += player.verticalVelocity * dt;

  if (player.position.y <= 0) {
    player.position.y = 0;
    player.verticalVelocity = 0;
    player.onGround = true;
  }
}

function updatePlayer(dt, elapsed) {
  const forwardInput = getAxis("KeyW", "KeyS") || getAxis("ArrowUp", "ArrowDown");
  const turnInput = getAxis("KeyD", "KeyA") || getAxis("ArrowRight", "ArrowLeft");
  const prevX = player.position.x;
  const prevZ = player.position.z;

  player.yaw -= turnInput * player.turnSpeed * dt;
  const moveDistance = forwardInput * player.speed * dt;

  player.position.x += Math.sin(player.yaw) * moveDistance;
  player.position.z += Math.cos(player.yaw) * moveDistance;

  player.position.x = THREE.MathUtils.clamp(
    player.position.x,
    -worldBounds,
    worldBounds,
  );
  player.position.z = THREE.MathUtils.clamp(
    player.position.z,
    -worldBounds,
    worldBounds,
  );

  const moveX = player.position.x - prevX;
  const moveZ = player.position.z - prevZ;
  const moveLenSq = moveX * moveX + moveZ * moveZ;
  if (moveLenSq > 1e-7) {
    // This model's forward axis is flipped relative to world forward.
    const targetVisualYaw = Math.atan2(-moveX, -moveZ);
    player.visualYaw = dampAngle(player.visualYaw, targetVisualYaw, 18, dt);
  }

  updateVerticalMotion(dt, true);

  playerRig.position.copy(player.position);
  playerRig.rotation.y = player.visualYaw;
  updateTifaPose(forwardInput, dt, elapsed);
}

function checkCutsceneTrigger() {
  if (cutsceneState.active || !tifaModel || !cloudNpc.model) {
    return;
  }

  const dx = player.position.x - cloudNpc.rig.position.x;
  const dz = player.position.z - cloudNpc.rig.position.z;
  const distSq = dx * dx + dz * dz;

  if (cutsceneState.done) {
    const resetDistSq = cloudNpc.replayResetRadius * cloudNpc.replayResetRadius;
    if (distSq >= resetDistSq) {
      cutsceneState.done = false;
    }
    return;
  }

  if (distSq <= cloudNpc.talkRadius * cloudNpc.talkRadius) {
    startCloudCutscene();
  }
}

function updateCamera(dt) {
  tmpTarget.copy(player.position).add(cameraLookOffset);

  tmpOffset.copy(cameraFollowOffset).applyAxisAngle(cameraUpAxis, player.yaw);
  tmpDesiredCameraPos.copy(tmpTarget).add(tmpOffset);

  const followBlend = 1 - Math.exp(-8 * dt);
  camera.position.lerp(tmpDesiredCameraPos, followBlend);
  camera.lookAt(tmpTarget);
}

function animate() {
  let last = performance.now() * 0.001;

  function frame(nowMs) {
    const now = nowMs * 0.001;
    const dt = Math.min(0.05, now - last);
    last = now;

    if (cutsceneState.active) {
      updateCutscene(dt, now);
      updateCutsceneCamera(dt);
    } else {
      updatePlayer(dt, now);
      updateCamera(dt);
      checkCutsceneTrigger();
    }

    updateCloudPose(now);
    renderer.render(scene, camera);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

createEnvironment();
resizeRenderer();
loadTifaModel();
loadCloudModel();
animate();
