import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CELL, COLS, ROWS } from "./grid";
import { TILE, type PlacedTile } from "./tiles";
import { TOWERS } from "./types";

export type Terrain3DTower = {
  x: number; y: number; gx: number; gy: number; def: number; level: number; aim: number;
  stake?: boolean; sanctuary?: boolean; hqFireLv?: number; hqFortifyLv?: number;
  hqTurretAtk?: number[]; hqCannonAtk?: number; hqCharge?: number; hqBuildFlash?: number;
  hp: number; maxHp: number; range?: number; selected?: boolean; image?: HTMLImageElement | null;
};

export type Terrain3DShot = {
  x: number; y: number; tx: number; ty: number; color: string; speed?: number; sanctuary?: boolean;
};

export type Terrain3DRing = {
  x: number; y: number; r: number; max: number; color: string; life: number;
};

export type Terrain3DEnemy = {
  x: number; y: number; r: number; hp: number; maxHp: number; hurt: number;
  face: number; image?: HTMLImageElement | null; color: string; boss?: boolean;
};

export type Terrain3DSnapshot = {
  placed: PlacedTile[];
  heights: number[];
  blocked: Set<string>;
  towers: Terrain3DTower[];
  enemies: Terrain3DEnemy[];
  shots: Terrain3DShot[];
  rings: Terrain3DRing[];
  placement?: { gx: number; gy: number; height: number; valid: boolean; snapped?: boolean } | null;
  /** 聖地力量 0..1；只強化符印與開拓邊界的視覺，不會替未取得地塊解除黑霧。 */
  sanctuaryPower?: number;
  mapMode: "expand" | "layout";
};

export type Terrain3DCellHit = { gx: number; gy: number; height: number };

export type Terrain3DApi = {
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number } | null;
  /** 回傳實際命中的地表格與高度，所有放置模式共用，不再透過世界座標二次反算格子。 */
  screenToCellPrecise: (clientX: number, clientY: number) => Terrain3DCellHit | null;
  /** 相容用世界座標介面；內部同樣以精確格子命中為依據。 */
  screenToWorldPrecise: (clientX: number, clientY: number) => { x: number; y: number } | null;
  pickTower: (clientX: number, clientY: number) => number | null;
  focus: (x: number, y: number) => void;
  reset: () => void;
};

type Props = {
  snapshotRef: { current: () => Terrain3DSnapshot };
  apiRef: { current: Terrain3DApi | null };
};

const HEIGHT_STEP = 0.42;
// 美術方向：海岸奇幻 × 魔導遺跡。地形偏自然暖色，建築以深海藍、青綠晶體與柔金作識別。
const MATERIALS = {
  road: "#405968",
  low: "#6d8c72",
  mid: "#91a58a",
  high: "#c7b78e",
  stone: "#ded7c3",
  ivory: "#f0e8d4",
  blue: "#17475a",
  roof: "#267c86",
  gold: "#bd9250",
  brightGold: "#f2d89b",
  crystal: "#53d7dc",
};

function clearGroup(group: any) {
  group.traverse((node: any) => {
    if (node.geometry && !node.userData?.sharedGeometry) node.geometry.dispose();
  });
  group.clear();
}

function groundTop(height: number) {
  return 0.14 + Math.max(0, Math.min(3, height)) * HEIGHT_STEP;
}

export const Terrain3DMap = memo(function Terrain3DMap({ snapshotRef, apiRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: any;
    let controls: any;
    let animationFrame = 0;
    let disposed = false;
    let altDown = false;
    let lastBuildAt = 0;
    let lastTerrainKey = "";
    let lastTerrainHeightsRef: number[] | null = null;
    let lastTerrainBlockedRef: Set<string> | null = null;
    let lastTerrainPlacedRef: PlacedTile[] | null = null;
    let lastTerrainMapMode: "expand" | "layout" | null = null;
    let lastBuildingKey = "";

    const scene = new THREE.Scene();
    scene.background = null;
    // 黑潮環境霧延伸至遠海；前景開啟地塊仍清晰，遠方未探索海域逐漸沉入深淵色霧。
    const atmosphericFog = new THREE.Fog("#111a2b", 96, 430);
    scene.fog = atmosphericFog;

    // 程序化可平鋪微表面：不依賴外部貼圖，石材與水面共用少量 GPU 資源。
    const makeSurfaceDataTexture = (size: number, sample: (u: number, v: number) => number) => {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const value = Math.max(0, Math.min(255, Math.round(sample(x / size, y / size))));
        const index = (y * size + x) * 4;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
      }
      const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return texture;
    };
    const tau = Math.PI * 2;
    const surfaceReliefMap = makeSurfaceDataTexture(128, (u, v) => {
      const broad = Math.sin(tau * (u * 3 + v * 2)) * 0.42 + Math.cos(tau * (v * 4 - u * 2)) * 0.32;
      const grain = Math.sin(tau * (u * 19 + v * 13)) * 0.2 + Math.cos(tau * (u * 31 - v * 27)) * 0.13;
      const pores = Math.sin(tau * (u * 47 + v * 37)) * 0.08 + Math.cos(tau * (u * 59 - v * 43)) * 0.07;
      return 128 + (broad + grain + pores) * 30;
    });
    const surfaceRoughnessMap = makeSurfaceDataTexture(128, (u, v) => {
      const patches = Math.sin(tau * (u * 4 + v * 3)) * 0.45 + Math.cos(tau * (u * 5 - v * 2)) * 0.3;
      const grain = Math.sin(tau * (u * 17 + v * 23)) * 0.25 + Math.cos(tau * (u * 29 - v * 31)) * 0.18;
      return 176 + (patches + grain) * 42;
    });
    const waterBumpMap = makeSurfaceDataTexture(128, (u, v) => {
      const longWave = Math.sin(tau * (u * 3 + v * 2.2 + Math.sin(v * tau * 2) * 0.12));
      const crossWave = Math.cos(tau * (v * 5 - u * 1.4 + Math.sin(u * tau * 3) * 0.08));
      const fineWave = Math.sin(tau * (u * 13 + v * 9)) * 0.18;
      return 128 + (longWave * 0.48 + crossWave * 0.38 + fineWave) * 22;
    });
    waterBumpMap.repeat.set(5, 5);

    // 環境反射球：讓金屬、晶體和水面能反射天光，而不是只靠金屬度變暗。
    const environmentCanvas = document.createElement("canvas");
    environmentCanvas.width = 512;
    environmentCanvas.height = 256;
    const environmentContext = environmentCanvas.getContext("2d");
    if (environmentContext) {
      const skyGradient = environmentContext.createLinearGradient(0, 0, 0, 256);
      skyGradient.addColorStop(0, "#55758b");
      skyGradient.addColorStop(0.34, "#91a99f");
      skyGradient.addColorStop(0.52, "#d1c5a3");
      skyGradient.addColorStop(0.7, "#527d82");
      skyGradient.addColorStop(1, "#173f50");
      environmentContext.fillStyle = skyGradient;
      environmentContext.fillRect(0, 0, 512, 256);
      const sunGlow = environmentContext.createRadialGradient(356, 86, 2, 356, 86, 78);
      sunGlow.addColorStop(0, "rgba(255,235,190,0.92)");
      sunGlow.addColorStop(0.22, "rgba(255,220,170,0.38)");
      sunGlow.addColorStop(1, "rgba(255,220,170,0)");
      environmentContext.fillStyle = sunGlow;
      environmentContext.fillRect(270, 0, 170, 170);
      environmentContext.globalAlpha = 0.18;
      environmentContext.fillStyle = "#e2e4cf";
      for (let band = 0; band < 5; band++) environmentContext.fillRect(20 + band * 83, 104 + band % 2 * 8, 58, 2);
      environmentContext.globalAlpha = 1;
    }
    const environmentTexture = new THREE.CanvasTexture(environmentCanvas);
    environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
    environmentTexture.colorSpace = THREE.SRGBColorSpace;
    environmentTexture.needsUpdate = true;
    scene.environment = environmentTexture;

    // 塔座接觸陰影使用徑向透明貼圖，補上建築與地面的重量感。
    const contactShadowCanvas = document.createElement("canvas");
    contactShadowCanvas.width = 128;
    contactShadowCanvas.height = 128;
    const contactShadowContext = contactShadowCanvas.getContext("2d");
    if (contactShadowContext) {
      const gradient = contactShadowContext.createRadialGradient(64, 64, 8, 64, 64, 64);
      gradient.addColorStop(0, "rgba(7,17,22,0.48)");
      gradient.addColorStop(0.48, "rgba(7,17,22,0.25)");
      gradient.addColorStop(0.78, "rgba(7,17,22,0.09)");
      gradient.addColorStop(1, "rgba(7,17,22,0)");
      contactShadowContext.fillStyle = gradient;
      contactShadowContext.fillRect(0, 0, 128, 128);
    }
    const contactShadowTexture = new THREE.CanvasTexture(contactShadowCanvas);
    contactShadowTexture.colorSpace = THREE.SRGBColorSpace;
    contactShadowTexture.needsUpdate = true;
    const contactShadowGeometry = new THREE.CircleGeometry(1, 48);

    // 柔和的海天漸層穹頂：由深海青過渡到暖霧色，再到高空藍綠。
    const skyGeometry = new THREE.SphereGeometry(900, 40, 24);
    const skyPositions = skyGeometry.getAttribute("position");
    const skyColors = new Float32Array(skyPositions.count * 3);
    const skyBottom = new THREE.Color("#173e4b");
    const skyHorizon = new THREE.Color("#9ab7a4");
    const skyZenith = new THREE.Color("#365c72");
    const skyColor = new THREE.Color();
    for (let i = 0; i < skyPositions.count; i++) {
      const height = THREE.MathUtils.clamp((skyPositions.getY(i) / 900 + 1) * 0.5, 0, 1);
      if (height < 0.5) skyColor.lerpColors(skyBottom, skyHorizon, height * 2);
      else skyColor.lerpColors(skyHorizon, skyZenith, (height - 0.5) * 2);
      skyColors[i * 3] = skyColor.r;
      skyColors[i * 3 + 1] = skyColor.g;
      skyColors[i * 3 + 2] = skyColor.b;
    }
    skyGeometry.setAttribute("color", new THREE.BufferAttribute(skyColors, 3));
    const skyMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      toneMapped: false,
    });
    const skyDome = new THREE.Mesh(skyGeometry, skyMaterial);
    skyDome.position.set(COLS / 2, -10, ROWS / 2);
    skyDome.renderOrder = -1000;
    skyDome.frustumCulled = false;
    scene.add(skyDome);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1200);
    const terrainRoot = new THREE.Group();
    const buildingRoot = new THREE.Group();
    const actorRoot = new THREE.Group();
    const effectRoot = new THREE.Group();
    scene.add(terrainRoot, buildingRoot, actorRoot, effectRoot);

    scene.add(new THREE.HemisphereLight("#e8f4e9", "#263e3b", 1.28));
    scene.add(new THREE.AmbientLight("#9bbab2", 0.31));

    // 主光源以地圖中心為目標，讓不同地塊區域都能得到一致方向的立體陰影。
    const sun = new THREE.DirectionalLight("#ffe0b6", 2.55);
    sun.position.set(COLS / 2 - 32, 48, ROWS / 2 + 28);
    sun.target.position.set(COLS / 2, 0, ROWS / 2);
    scene.add(sun.target);
    sun.castShadow = true;
    sun.shadow.radius = 3;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 230;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -112;
    sun.shadow.camera.right = 112;
    sun.shadow.camera.top = 112;
    sun.shadow.camera.bottom = -112;
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.00016;
    scene.add(sun);

    // 海面冷色補光與背側輪廓光不投影，避免額外增加陰影貼圖成本。
    const seaFill = new THREE.DirectionalLight("#79cbd0", 0.52);
    seaFill.position.set(COLS / 2 + 42, 22, ROWS / 2 - 36);
    seaFill.target.position.set(COLS / 2, 0, ROWS / 2);
    scene.add(seaFill.target);
    seaFill.castShadow = false;
    scene.add(seaFill);
    const ridgeFill = new THREE.DirectionalLight("#b4d8c8", 0.24);
    ridgeFill.position.set(COLS / 2 + 34, 34, ROWS / 2 + 52);
    ridgeFill.target.position.set(COLS / 2, 0, ROWS / 2);
    scene.add(ridgeFill.target);
    ridgeFill.castShadow = false;
    scene.add(ridgeFill);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    // 快速平面映射供一般滑鼠移動使用；真正點擊時只射線測試這些地表實例網格。
    const terrainCellHeights = new Map<string, number>();
    const terrainHeightAt = (gx: number, gy: number, heights: number[]) =>
      terrainCellHeights.get(gx + "," + gy) ?? Math.max(0, Math.min(3, heights[gy * COLS + gx] ?? 0));
    const terrainPickMeshes: any[] = [];
    const terrainPickPlanes = [0, 1, 2, 3].map(
      (height) => new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundTop(height)),
    );
    const floorPlane = terrainPickPlanes[0];
    const textureCache = new Map<HTMLImageElement, any>();
    const towerAccentMaterials = new Map<string, any>();
    const getTowerAccentMaterial = (color: string) => {
      const key = /^#[0-9a-f]{6}$/i.test(color) ? color : "#78cfe8";
      let material = towerAccentMaterials.get(key);
      if (!material) {
        material = new THREE.MeshPhysicalMaterial({
          color: key,
          metalness: 0.46,
          roughness: 0.3,
          roughnessMap: surfaceRoughnessMap,
          clearcoat: 0.52,
          clearcoatRoughness: 0.22,
          envMapIntensity: 0.92,
          emissive: key,
          emissiveIntensity: 0.16,
        });
        towerAccentMaterials.set(key, material);
      }
      return material;
    };
    const rings: any[] = [];
    const gems: any[] = [];
    const waterRippleEntries: { x: number; z: number; phase: number; speed: number }[] = [];
    let waterRippleMesh: any = null;
    const waterGlintEntries: { x: number; z: number; phase: number; rot: number; scale: number }[] = [];
    let waterGlintMesh: any = null;
    const fireflyEntries: { x: number; z: number; y: number; phase: number; radius: number; scale: number }[] = [];
    let fireflyMesh: any = null;
    const blackMistEntries: { x: number; z: number; y: number; phase: number; rot: number; scaleX: number; scaleZ: number; driftX: number; driftZ: number }[] = [];
    let blackMistMesh: any = null;
    const blackMistCloudEntries: { x: number; z: number; phase: number; scaleX: number; scaleZ: number; driftX: number; driftZ: number }[] = [];
    let blackMistCloudMesh: any = null;
    const blackMistVeilEntries: { x: number; z: number; y: number; phase: number; rot: number; scaleX: number; scaleY: number; driftX: number; driftZ: number }[] = [];
    let blackMistVeilMesh: any = null;
    const blackMistDummy = new THREE.Object3D();
    const blackMistCloudDummy = new THREE.Object3D();
    const blackMistVeilDummy = new THREE.Object3D();
    const landmarkLights: { light: THREE.PointLight; phase: number; intensity: number }[] = [];
    const updateLandmarkLights = (time: number) => {
      for (const entry of landmarkLights) {
        entry.light.intensity = entry.intensity * (0.88 + Math.sin(time * 0.0016 + entry.phase) * 0.12);
      }
    };
    const waterRippleDummy = new THREE.Object3D();
    const waterGlintDummy = new THREE.Object3D();
    const fireflyDummy = new THREE.Object3D();
    const turretGroups: { group: any; tower: Terrain3DTower; index: number; flash: any; baseY: number; baseZ: number }[] = [];
    const installationAnimations: { group: any; targetY: number; age: number; duration: number; fromScale: number }[] = [];
    const installationRings: { mesh: any; material: any; age: number; duration: number }[] = [];
    const buildFlashEffects: { mesh: any; material: any; tower: Terrain3DTower }[] = [];
    const chargeCores: { mesh: any; material: any; tower: Terrain3DTower }[] = [];
    const towerSprites: any[] = [];
    const enemySprites: any[] = [];
    const enemyHealthBars: { back: any; fill: any }[] = [];
    const shotNodes: any[] = [];
    const ringNodes: any[] = [];
    // 三股交錯的尾流共用單一幾何與 draw call：中央亮核、兩側細流，像高速掠過時拉開的氣流絲。
    const projectileWakeGeometry = new THREE.BufferGeometry();
    projectileWakeGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
      -0.095, 0, 0.08,  0.095, 0, 0.08,  0, 0, -1.12,
      -0.205, 0, 0.025, -0.17, 0, 0.025, -0.095, 0, -0.86,
       0.17, 0, 0.025,  0.205, 0, 0.025,  0.095, 0, -0.86,
    ], 3));
    projectileWakeGeometry.setAttribute("uv", new THREE.Float32BufferAttribute([
      0, 0, 1, 0, 0.5, 1,
      0, 0, 1, 0, 0.5, 1,
      0, 0, 1, 0, 0.5, 1,
    ], 2));
    projectileWakeGeometry.setAttribute("color", new THREE.Float32BufferAttribute([
      1, 1, 1, 1, 1, 1, 1, 1, 1,
      0.48, 0.72, 0.86, 0.48, 0.72, 0.86, 0.62, 0.82, 0.92,
      0.48, 0.72, 0.86, 0.48, 0.72, 0.86, 0.62, 0.82, 0.92,
    ], 3));
    projectileWakeGeometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    projectileWakeGeometry.computeVertexNormals();
    projectileWakeGeometry.computeBoundingSphere();
    projectileWakeGeometry.userData.sharedGeometry = true;
    const projectileWakeUniforms = { time: { value: 0 } };
    const installProjectileWakeFlow = (material: THREE.MeshBasicMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uProjectileWakeTime = projectileWakeUniforms.time;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vProjectileWakeUv;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvProjectileWakeUv = uv;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vProjectileWakeUv;\nuniform float uProjectileWakeTime;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float wakePulse = 0.8 + 0.2 * sin(vProjectileWakeUv.y * 15.0 - uProjectileWakeTime * 7.0);
          float wakeTaper = 1.0 - smoothstep(0.76, 1.0, vProjectileWakeUv.y);
          diffuseColor.rgb *= wakePulse;
          diffuseColor.a *= wakeTaper;`,
        );
      };
      material.customProgramCacheKey = () => "tide-projectile-wake-flow-v1";
    };
    // 程序化黑霧貼圖：柔邊噪聲雲，不依賴外部圖檔，並以單一 InstancedMesh 控制效能。
    const blackMistSize = 64;
    const blackMistPixels = new Uint8Array(blackMistSize * blackMistSize * 4);
    for (let y = 0; y < blackMistSize; y++) for (let x = 0; x < blackMistSize; x++) {
      const u = (x + 0.5) / blackMistSize * 2 - 1;
      const v = (y + 0.5) / blackMistSize * 2 - 1;
      const radius = Math.sqrt(u * u * 0.78 + v * v * 1.22);
      const edge = Math.max(0, 1 - radius);
      const turbulence = 0.72
        + Math.sin(x * 0.39 + y * 0.13) * 0.11
        + Math.sin(y * 0.31 - x * 0.17) * 0.09;
      const alpha = Math.max(0, Math.min(255, Math.round(Math.pow(edge, 1.65) * turbulence * 255)));
      const index = (y * blackMistSize + x) * 4;
      blackMistPixels[index] = 255;
      blackMistPixels[index + 1] = 255;
      blackMistPixels[index + 2] = 255;
      blackMistPixels[index + 3] = alpha;
    }
    const blackMistTexture = new THREE.DataTexture(blackMistPixels, blackMistSize, blackMistSize, THREE.RGBAFormat);
    blackMistTexture.colorSpace = THREE.SRGBColorSpace;
    blackMistTexture.needsUpdate = true;

    // 全世界深淵霧幕：覆蓋可探索範圍並延伸至遠海；遮罩只依實際已取得的地塊更新。
    const blackMistFieldSize = 512;
    const blackMistFieldWidth = COLS + 180;
    const blackMistFieldDepth = ROWS + 180;
    const blackMistFieldPixels = new Uint8Array(blackMistFieldSize * blackMistFieldSize * 4);
    const blackMistFieldMaskPixels = new Uint8Array(blackMistFieldSize * blackMistFieldSize * 4);
    for (let y = 0; y < blackMistFieldSize; y++) for (let x = 0; x < blackMistFieldSize; x++) {
      const u = x / blackMistFieldSize;
      const v = y / blackMistFieldSize;
      const broad = Math.sin(tau * (u * 3.1 + Math.sin(v * tau * 1.7) * 0.22)) * 0.42
        + Math.cos(tau * (v * 2.7 - u * 1.9)) * 0.34;
      const medium = Math.sin(tau * (u * 8.3 + v * 5.7)) * 0.16
        + Math.cos(tau * (v * 11.1 - u * 6.2)) * 0.12;
      const fine = Math.sin(tau * (u * 23 + v * 19)) * 0.06
        + Math.cos(tau * (v * 29 - u * 17)) * 0.05;
      const density = THREE.MathUtils.clamp(0.76 + broad * 0.16 + medium * 0.12 + fine, 0.48, 0.96);
      const index = (y * blackMistFieldSize + x) * 4;
      const shade = Math.round(166 + density * 89);
      blackMistFieldPixels[index] = shade;
      blackMistFieldPixels[index + 1] = shade;
      blackMistFieldPixels[index + 2] = shade;
      blackMistFieldPixels[index + 3] = 255;
      blackMistFieldMaskPixels[index] = 255;
      blackMistFieldMaskPixels[index + 1] = 255;
      blackMistFieldMaskPixels[index + 2] = 255;
      blackMistFieldMaskPixels[index + 3] = 255;
    }
    const blackMistFieldTexture = new THREE.DataTexture(
      blackMistFieldPixels, blackMistFieldSize, blackMistFieldSize, THREE.RGBAFormat,
    );
    blackMistFieldTexture.colorSpace = THREE.SRGBColorSpace;
    blackMistFieldTexture.wrapS = THREE.RepeatWrapping;
    blackMistFieldTexture.wrapT = THREE.RepeatWrapping;
    blackMistFieldTexture.magFilter = THREE.LinearFilter;
    blackMistFieldTexture.minFilter = THREE.LinearMipmapLinearFilter;
    blackMistFieldTexture.generateMipmaps = true;
    blackMistFieldTexture.repeat.set(4.2, 4.2);
    blackMistFieldTexture.needsUpdate = true;

    const blackMistFieldMaskTexture = new THREE.DataTexture(
      blackMistFieldMaskPixels, blackMistFieldSize, blackMistFieldSize, THREE.RGBAFormat,
    );
    blackMistFieldMaskTexture.wrapS = THREE.ClampToEdgeWrapping;
    blackMistFieldMaskTexture.wrapT = THREE.ClampToEdgeWrapping;
    blackMistFieldMaskTexture.magFilter = THREE.LinearFilter;
    blackMistFieldMaskTexture.minFilter = THREE.LinearFilter;
    blackMistFieldMaskTexture.needsUpdate = true;

    // 黑霧退散遮罩：只辨識真正已放置的地塊；聖地力量不再把未開拓海域變成安全區。
    // 以 tile slot 建立緊湊 occupancy，再將聯通地塊視為一整片陸地，避免相鄰地塊接縫重新冒霧。
    // 512² 遮罩只在地形資料變更時更新，不放進 30Hz 動畫迴圈。
    const refreshBlackMistRevealMask = (placed: PlacedTile[], enabled: boolean) => {
      const slotMinX = Math.floor((COLS / 2 - blackMistFieldWidth / 2) / TILE) - 1;
      const slotMinZ = Math.floor((ROWS / 2 - blackMistFieldDepth / 2) / TILE) - 1;
      const slotCols = Math.ceil(blackMistFieldWidth / TILE) + 4;
      const slotRows = Math.ceil(blackMistFieldDepth / TILE) + 4;
      const openedSlots = new Uint8Array(slotCols * slotRows);
      if (enabled) {
        for (const tile of placed) {
          const sx = tile.tc - slotMinX;
          const sz = tile.tr - slotMinZ;
          if (sx >= 0 && sx < slotCols && sz >= 0 && sz < slotRows) {
            openedSlots[sz * slotCols + sx] = 1;
          }
        }
      }
      const isOpened = (tc: number, tr: number) => {
        const sx = tc - slotMinX;
        const sz = tr - slotMinZ;
        return sx >= 0 && sx < slotCols && sz >= 0 && sz < slotRows
          && openedSlots[sz * slotCols + sx] === 1;
      };
      const feather = 2.25;
      for (let py = 0; py < blackMistFieldSize; py++) {
        const v = (py + 0.5) / blackMistFieldSize;
        const worldZ = (0.5 - v) * blackMistFieldDepth + ROWS / 2;
        const tr = Math.floor(worldZ / TILE);
        const localZ = worldZ - tr * TILE;
        for (let px = 0; px < blackMistFieldSize; px++) {
          const u = (px + 0.5) / blackMistFieldSize;
          const worldX = (u - 0.5) * blackMistFieldWidth + COLS / 2;
          const tc = Math.floor(worldX / TILE);
          const localX = worldX - tc * TILE;
          let signedDistance = feather;
          if (isOpened(tc, tr)) {
            // 地塊內側：只對外露邊緣做柔化；與另一塊已開拓地相接的邊不會出現黑霧縫。
            let inwardDistance = feather;
            if (!isOpened(tc - 1, tr)) inwardDistance = Math.min(inwardDistance, localX);
            if (!isOpened(tc + 1, tr)) inwardDistance = Math.min(inwardDistance, TILE - localX);
            if (!isOpened(tc, tr - 1)) inwardDistance = Math.min(inwardDistance, localZ);
            if (!isOpened(tc, tr + 1)) inwardDistance = Math.min(inwardDistance, TILE - localZ);
            signedDistance = -Math.min(feather, inwardDistance);
          } else {
            // 未開拓側：只檢查相鄰 3×3 tile slots，讓霧線在新地塊外側自然羽化。
            let nearest = feather;
            for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
              const nx = tc + dx;
              const nz = tr + dz;
              if (!isOpened(nx, nz)) continue;
              const left = nx * TILE;
              const top = nz * TILE;
              const gapX = worldX < left ? left - worldX : worldX > left + TILE ? worldX - left - TILE : 0;
              const gapZ = worldZ < top ? top - worldZ : worldZ > top + TILE ? worldZ - top - TILE : 0;
              nearest = Math.min(nearest, Math.hypot(gapX, gapZ));
            }
            signedDistance = Math.min(feather, nearest);
          }
          const fogAlpha = THREE.MathUtils.smoothstep(signedDistance, -feather, feather);
          const index = (py * blackMistFieldSize + px) * 4;
          blackMistFieldMaskPixels[index] = 255;
          blackMistFieldMaskPixels[index + 1] = Math.round(fogAlpha * 255);
          blackMistFieldMaskPixels[index + 2] = 255;
          blackMistFieldMaskPixels[index + 3] = 255;
        }
      }
      blackMistFieldMaskTexture.needsUpdate = true;
    };

    const foliageWindUniform = { value: 0 };
    const pollenUniforms = { time: { value: 0 } };
    const sanctuarySigilUniforms = { time: { value: 0 }, power: { value: 0.18 } };
    const roadGuideUniforms = {
      time: { value: 0 },
      origin: { value: new THREE.Vector2(COLS / 2, ROWS / 2) },
      power: { value: 0.18 },
    };
    const shoreFoamUniforms = { time: { value: 0 } };
    const cliffStrataUniforms = { time: { value: 0 } };
    const blackMistFrontUniforms = { time: { value: 0 }, power: { value: 0.12 } };
    const blackMistVeilUniforms = { time: { value: 0 } };
    const shared = {
      blackMist: new THREE.MeshBasicMaterial({
        color: "#182038",
        map: blackMistTexture,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      blackMistVeil: new THREE.MeshBasicMaterial({
        color: "#1b2944",
        map: blackMistTexture,
        transparent: true,
        opacity: 0.46,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
      blackMistField: new THREE.MeshBasicMaterial({
        color: "#10182b",
        map: blackMistFieldTexture,
        alphaMap: blackMistFieldMaskTexture,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      blackMistCloud: new THREE.MeshBasicMaterial({
        color: "#080e1e",
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
      stone: new THREE.MeshStandardMaterial({ color: MATERIALS.stone, roughness: 0.84, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.026 }),
      ivory: new THREE.MeshStandardMaterial({ color: MATERIALS.ivory, roughness: 0.72, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.014 }),
      blue: new THREE.MeshPhysicalMaterial({ color: MATERIALS.blue, metalness: 0.3, roughness: 0.36, clearcoat: 0.48, clearcoatRoughness: 0.24, envMapIntensity: 0.82 }),
      roof: new THREE.MeshPhysicalMaterial({ color: MATERIALS.roof, metalness: 0.28, roughness: 0.34, clearcoat: 0.3, clearcoatRoughness: 0.28, envMapIntensity: 0.78 }),
      gold: new THREE.MeshPhysicalMaterial({ color: MATERIALS.gold, metalness: 0.74, roughness: 0.28, roughnessMap: surfaceRoughnessMap, clearcoat: 0.58, clearcoatRoughness: 0.22, envMapIntensity: 1.16 }),
      brightGold: new THREE.MeshPhysicalMaterial({ color: MATERIALS.brightGold, metalness: 0.72, roughness: 0.2, roughnessMap: surfaceRoughnessMap, clearcoat: 0.82, clearcoatRoughness: 0.13, envMapIntensity: 1.28, emissive: "#754c16", emissiveIntensity: 0.18 }),
      crystal: new THREE.MeshPhysicalMaterial({ color: MATERIALS.crystal, metalness: 0.28, roughness: 0.16, clearcoat: 0.82, clearcoatRoughness: 0.08, envMapIntensity: 1.28, emissive: "#008fe8", emissiveIntensity: 1.0 }),
      chargeCrystal: new THREE.MeshPhysicalMaterial({ color: "#8af4e8", metalness: 0.22, roughness: 0.13, clearcoat: 0.9, clearcoatRoughness: 0.06, envMapIntensity: 1.35, emissive: "#00a89c", emissiveIntensity: 0.8 }),
      glass: new THREE.MeshPhysicalMaterial({ color: "#0e3945", roughness: 0.2, metalness: 0.12, clearcoat: 0.92, clearcoatRoughness: 0.08, envMapIntensity: 1.05, emissive: "#0a6070", emissiveIntensity: 0.42 }),
      terrain: [
        new THREE.MeshStandardMaterial({ color: MATERIALS.road, roughness: 0.96, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.012 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.low, roughness: 0.95, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.018 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.mid, roughness: 0.93, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.021 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.high, roughness: 0.91, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.024 }),
      ],
      cliff: new THREE.MeshStandardMaterial({ color: "#344c4c", roughness: 0.98, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.034 }),
      cliffBand: new THREE.MeshStandardMaterial({ color: "#637c6b", roughness: 0.94, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.022 }),
      cliffBandLight: new THREE.MeshStandardMaterial({ color: "#9a9f7d", roughness: 0.91, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.019 }),
      cliffCap: new THREE.MeshStandardMaterial({ color: "#d0c49b", roughness: 0.84, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.022 }),
      rockDetail: new THREE.MeshStandardMaterial({ color: "#8b927d", roughness: 0.98, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.03 }),
      terrainMoss: new THREE.MeshStandardMaterial({ color: "#66856a", roughness: 0.99, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.01 }),
      terrainStrata: new THREE.MeshStandardMaterial({ color: "#c0b99d", roughness: 0.96, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.018 }),
      terrainInlay: new THREE.MeshStandardMaterial({ color: "#e1d0a6", roughness: 0.82, metalness: 0.08 }),
      biomeSeam: new THREE.MeshStandardMaterial({ color: "#c7b99a", roughness: 0.96, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.012 }),
      roadMedallion: new THREE.MeshPhysicalMaterial({ color: "#b99a68", metalness: 0.58, roughness: 0.3, clearcoat: 0.48, clearcoatRoughness: 0.2, envMapIntensity: 1.05 }),
      tidalSand: new THREE.MeshPhysicalMaterial({ color: "#819d94", metalness: 0.06, roughness: 0.42, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.009, clearcoat: 0.34, clearcoatRoughness: 0.3 }),
      beachPebble: new THREE.MeshStandardMaterial({ color: "#a9a58e", roughness: 0.94, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.018 }),
      roadPaver: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.97, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.016 }),
      roadWear: new THREE.MeshStandardMaterial({ color: "#344d58", roughness: 1, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.008 }),
      roadEdge: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.021 }),
      foundationStone: new THREE.MeshStandardMaterial({ color: "#b5b29f", roughness: 0.96, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.021 }),
      foundationGold: new THREE.MeshPhysicalMaterial({ color: "#c5a56c", metalness: 0.62, roughness: 0.32, roughnessMap: surfaceRoughnessMap, clearcoat: 0.56, clearcoatRoughness: 0.22, envMapIntensity: 1.08 }),
      ruinStone: new THREE.MeshStandardMaterial({ color: "#a7a18d", roughness: 0.98, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.028 }),
      ruinShadow: new THREE.MeshStandardMaterial({ color: "#596c64", roughness: 0.94 }),
      runeGlow: new THREE.MeshPhysicalMaterial({
        color: "#79d9c8",
        metalness: 0.22,
        roughness: 0.27,
        clearcoat: 0.58,
        clearcoatRoughness: 0.18,
        envMapIntensity: 1.05,
        emissive: "#147b70",
        emissiveIntensity: 0.72,
      }),
      rampStep: new THREE.MeshStandardMaterial({ color: "#c0b69b", roughness: 0.96, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.019 }),
      coastGrass: new THREE.MeshStandardMaterial({ color: "#86a98b", roughness: 0.98, bumpMap: surfaceReliefMap, bumpScale: 0.01 }),
      limestoneVein: new THREE.MeshStandardMaterial({ color: "#d7d0b9", roughness: 0.93, bumpMap: surfaceReliefMap, bumpScale: 0.012 }),
      ancientEtch: new THREE.MeshStandardMaterial({
        color: "#8acdc0",
        metalness: 0.12,
        roughness: 0.42,
        emissive: "#165c57",
        emissiveIntensity: 0.36,
      }),
      driftwood: new THREE.MeshStandardMaterial({ color: "#796c59", roughness: 0.99, bumpMap: surfaceReliefMap, bumpScale: 0.018 }),
      ridgePeak: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.98, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.028 }),
      caveShadow: new THREE.MeshBasicMaterial({
        color: "#102c34",
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
      caveRim: new THREE.MeshStandardMaterial({ color: "#68786e", roughness: 0.99, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.028 }),
      bridgeStone: new THREE.MeshStandardMaterial({ color: "#c0b69b", roughness: 0.96, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.022 }),
      bridgeTrim: new THREE.MeshPhysicalMaterial({ color: "#b99560", metalness: 0.54, roughness: 0.36, roughnessMap: surfaceRoughnessMap, clearcoat: 0.48, clearcoatRoughness: 0.24, envMapIntensity: 1.02 }),
      grass: new THREE.MeshStandardMaterial({ color: "#83a878", roughness: 0.96 }),
      grassBlade: new THREE.MeshStandardMaterial({
        color: "#ffffff", vertexColors: true, roughness: 0.9, side: THREE.DoubleSide,
        bumpMap: surfaceReliefMap, bumpScale: 0.004,
      }),
      treeBark: new THREE.MeshStandardMaterial({ color: "#6e5943", roughness: 0.98, bumpMap: surfaceReliefMap, bumpScale: 0.018 }),
      foliageWind: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.94, bumpMap: surfaceReliefMap, bumpScale: 0.008, side: THREE.DoubleSide }),
      meadowBloom: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.72, emissive: "#473b20", emissiveIntensity: 0.06 }),
      roadGuide: new THREE.MeshStandardMaterial({
        color: "#ffffff", roughness: 0.78, metalness: 0.12,
        emissive: "#1c6e70", emissiveIntensity: 0.12,
      }),
      sanctuarySigil: new THREE.MeshBasicMaterial({
        color: "#76f5d6",
        transparent: true,
        opacity: 0.76,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
      terrainCrystal: new THREE.MeshStandardMaterial({
        color: "#55a6a2",
        metalness: 0.22,
        roughness: 0.34,
        emissive: "#1d6865",
        emissiveIntensity: 0.18,
      }),
      floor: new THREE.MeshPhysicalMaterial({ color: "#123b49", metalness: 0.22, roughness: 0.25, bumpMap: waterBumpMap, bumpScale: 0.022, clearcoat: 0.72, clearcoatRoughness: 0.16, envMapIntensity: 1.18 }),
      seaShelf: new THREE.MeshPhysicalMaterial({ color: "#28636a", metalness: 0.14, roughness: 0.29, bumpMap: waterBumpMap, bumpScale: 0.016, clearcoat: 0.66, clearcoatRoughness: 0.2, envMapIntensity: 1.12 }),
      shoreSand: new THREE.MeshStandardMaterial({ color: "#d9c49a", roughness: 0.97, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.016 }),
      shoreFoam: new THREE.MeshBasicMaterial({ color: "#b9e6d8", transparent: true, opacity: 0.76, depthWrite: false }),
      waterRipple: new THREE.MeshBasicMaterial({ color: "#c7eee0", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
      waterGlint: new THREE.MeshBasicMaterial({ color: "#d8f3e4", transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
      firefly: new THREE.MeshBasicMaterial({ color: "#b5f3d7", transparent: true, opacity: 0.48, depthWrite: false, toneMapped: false }),
      pollen: new THREE.MeshBasicMaterial({
        color: "#fff3ce", transparent: true, opacity: 0.46,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
      rockCrack: new THREE.MeshStandardMaterial({ color: "#263c3b", roughness: 1, bumpMap: surfaceReliefMap, bumpScale: 0.012 }),
      rockCrackEdge: new THREE.MeshStandardMaterial({ color: "#8f9075", roughness: 0.96, bumpMap: surfaceReliefMap, bumpScale: 0.008 }),
      contactShadow: new THREE.MeshBasicMaterial({
        map: contactShadowTexture,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
      cliffLip: new THREE.MeshStandardMaterial({ color: "#c9b58b", roughness: 0.92, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.022 }),
      cliffFacet: new THREE.MeshStandardMaterial({ color: "#718071", roughness: 0.98, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.028 }),
      reefRock: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.98, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.025 }),
      reefCoral: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.88, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.014 }),
      heightRim: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.93, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.02 }),
      ramp: new THREE.MeshStandardMaterial({ color: "#aeb49c", roughness: 0.95, roughnessMap: surfaceRoughnessMap, bumpMap: surfaceReliefMap, bumpScale: 0.02 }),
    };

    // 黑霧淨界前緣：已開拓遮罩決定退霧範圍，GPU 只在地塊外緣疊加潮汐光澤。
    const installBlackMistFront = (material: THREE.MeshBasicMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uMistTime = blackMistFrontUniforms.time;
        shader.uniforms.uMistPower = blackMistFrontUniforms.power;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vMistFieldUv;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvMistFieldUv = uv;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vMistFieldUv;\nuniform float uMistTime;\nuniform float uMistPower;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <alphamap_fragment>",
          `#include <alphamap_fragment>
          // alphaMap 的綠色通道來自已取得地塊遮罩；只有地塊外緣形成流動的潮汐亮線。
          float mistRevealMask = texture2D(alphaMap, vAlphaMapUv).g;
          float revealEdge = 1.0 - smoothstep(0.035, 0.24, abs(mistRevealMask - 0.5));
          float edgePulse = 0.78 + 0.22 * sin(
            uMistTime * 1.25 + vMistFieldUv.x * 34.0 + sin(vMistFieldUv.y * 29.0) * 1.8
          );
          diffuseColor.rgb += vec3(0.035, 0.13, 0.15)
            * revealEdge * edgePulse * (0.12 + uMistPower * 0.2);`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          // 多尺度深淵流紋在 GPU 內緩慢翻湧，避免霧面像靜止色塊。
          float abyssCurrentA = sin(vMistFieldUv.x * 18.0
            + sin(vMistFieldUv.y * 11.0 - uMistTime * 0.12) * 2.6 - uMistTime * 0.08);
          float abyssCurrentB = cos(vMistFieldUv.y * 23.0 - vMistFieldUv.x * 9.0 + uMistTime * 0.065);
          float abyssFlow = smoothstep(0.16, 0.92, abyssCurrentA * 0.5 + 0.5)
            * smoothstep(0.04, 0.96, abyssCurrentB * 0.5 + 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb,
            diffuseColor.rgb * vec3(0.76, 0.88, 1.16), abyssFlow * 0.22);
          diffuseColor.rgb += vec3(0.012, 0.02, 0.048)
            * abyssFlow * (0.24 + uMistPower * 0.18);
          diffuseColor.a *= 0.94 + 0.06 * (0.5 + 0.5 * sin(
            vMistFieldUv.x * 31.0 + vMistFieldUv.y * 19.0 - uMistTime * 0.16));`,
        );
      };
      material.customProgramCacheKey = () => "tide-black-mist-tile-front-v3";
    };
    installBlackMistFront(shared.blackMistField);

    // 聖地地面符印與道路導光使用材質內動畫；不額外建立逐顆動畫物件。
    const installSanctuarySigil = (material: THREE.MeshBasicMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uSigilTime = sanctuarySigilUniforms.time;
        shader.uniforms.uSigilPower = sanctuarySigilUniforms.power;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vSanctuaryUv;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvSanctuaryUv = position.xy / 10.8 + 0.5;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vSanctuaryUv;\nuniform float uSigilTime;\nuniform float uSigilPower;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          vec2 sigilPoint = (vSanctuaryUv - 0.5) * 2.0;
          float sigilRadius = length(sigilPoint);
          float sigilAngle = atan(sigilPoint.y, sigilPoint.x) + uSigilTime * 0.12;
          float outerRing = 1.0 - smoothstep(0.012, 0.035, abs(sigilRadius - 0.91));
          float middleRing = 1.0 - smoothstep(0.01, 0.026, abs(sigilRadius - 0.72));
          float innerRing = 1.0 - smoothstep(0.008, 0.024, abs(sigilRadius - 0.42));
          float tickMask = smoothstep(0.47, 0.54, sigilRadius) * (1.0 - smoothstep(0.68, 0.76, sigilRadius));
          float runeTicks = 1.0 - smoothstep(0.045, 0.13, abs(sin(sigilAngle * 4.0)));
          float travelingRune = 1.0 - smoothstep(0.015, 0.11, abs(sin(sigilAngle * 0.5)));
          float corePulse = exp(-sigilRadius * sigilRadius * 18.0) * (0.6 + 0.4 * sin(uSigilTime * 1.4));
          float edgeFade = 1.0 - smoothstep(0.94, 1.0, sigilRadius);
          float rootBand = smoothstep(0.24, 0.38, sigilRadius) * (1.0 - smoothstep(0.93, 1.0, sigilRadius));
          float rootMain = 1.0 - smoothstep(0.035, 0.13, abs(sin(sigilAngle * 4.0 + sin(sigilRadius * 13.0) * 0.32)));
          float rootBranch = 1.0 - smoothstep(0.04, 0.16, abs(sin(sigilAngle * 8.0 + sin(sigilRadius * 17.0 + uSigilTime * 0.16) * 0.58)));
          float rootVeins = (rootMain * 0.12 + rootBranch * 0.055) * rootBand;
          float sigilPattern = outerRing * 0.38 + middleRing * 0.2 + innerRing * 0.12
            + runeTicks * tickMask * 0.22 + travelingRune * outerRing * 0.26
            + corePulse * 0.08 + rootVeins;
          float sigilBreath = 0.82 + 0.18 * sin(uSigilTime * 0.9 + sigilRadius * 5.0);
          diffuseColor.a *= clamp(sigilPattern, 0.0, 1.0) * edgeFade
            * sigilBreath * (0.38 + uSigilPower * 0.62);
          diffuseColor.rgb *= 0.82 + uSigilPower * 0.3;
          diffuseColor.rgb += vec3(0.018, 0.095, 0.078) * rootVeins * (0.4 + uSigilPower * 0.5);`,
        );
      };
      material.customProgramCacheKey = () => "tide-sanctuary-sigil-v1";
    };
    const installRoadFlow = (material: THREE.MeshStandardMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uRoadFlowTime = roadGuideUniforms.time;
        shader.uniforms.uRoadFlowOrigin = roadGuideUniforms.origin;
        shader.uniforms.uRoadFlowPower = roadGuideUniforms.power;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vRoadFlowUv;\nvarying vec3 vRoadFlowWorldPosition;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vRoadFlowUv = vec2(position.x / 0.34 + 0.5, position.z / 0.038 + 0.5);
          vec4 roadWorldPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            roadWorldPosition = instanceMatrix * roadWorldPosition;
          #endif
          roadWorldPosition = modelMatrix * roadWorldPosition;
          vRoadFlowWorldPosition = roadWorldPosition.xyz;`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vRoadFlowUv;\nvarying vec3 vRoadFlowWorldPosition;\nuniform float uRoadFlowTime;\nuniform vec2 uRoadFlowOrigin;\nuniform float uRoadFlowPower;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float roadDistanceFromSanctuary = length(vRoadFlowWorldPosition.xz - uRoadFlowOrigin);
          float roadWave = cos(roadDistanceFromSanctuary * 0.55 - uRoadFlowTime * 1.1);
          float roadPulse = pow(max(0.0, roadWave), 18.0);
          float roadFlowPhase = fract(vRoadFlowUv.x - uRoadFlowTime * 0.18);
          float localFlow = pow(max(0.0, 1.0 - abs(roadFlowPhase - 0.5) * 2.0), 12.0);
          diffuseColor.rgb += vec3(0.028, 0.12, 0.105)
            * (roadPulse * (0.65 + uRoadFlowPower * 0.55) + localFlow * 0.16);`,
        );
      };
      material.customProgramCacheKey = () => "tide-road-flow-sanctuary-pulse-v2";
    };
    const installTerrainSurface = (material: THREE.MeshStandardMaterial, height: number) => {
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vTerrainWorldPosition;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vec4 terrainWorldPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            terrainWorldPosition = instanceMatrix * terrainWorldPosition;
          #endif
          terrainWorldPosition = modelMatrix * terrainWorldPosition;
          vTerrainWorldPosition = terrainWorldPosition.xyz;`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vTerrainWorldPosition;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          // 世界座標噪聲跨越地塊連續取樣，讓草土、岩層與微型礦斑不再沿方格邊界切斷。
          vec2 terrainWorld = vTerrainWorldPosition.xz;
          float broadMottle = sin(terrainWorld.x * 0.17 + sin(terrainWorld.y * 0.11 + ${height.toFixed(1)} * 0.3) * 2.0)
            * cos(terrainWorld.y * 0.21 - terrainWorld.x * 0.07);
          float middleGrain = sin(terrainWorld.x * 1.31 + cos(terrainWorld.y * 1.07) * 1.4 + ${height.toFixed(1)})
            * cos(terrainWorld.y * 1.57 - terrainWorld.x * 0.63);
          float fineGrain = sin(terrainWorld.x * 7.3 + terrainWorld.y * 5.9)
            * cos(terrainWorld.y * 8.1 - terrainWorld.x * 3.7);
          float lichenField = smoothstep(0.12, 0.78, broadMottle * 0.5 + 0.5 + middleGrain * 0.045);
          float mineralSpeck = pow(max(0.0, sin(terrainWorld.x * 0.73 + terrainWorld.y * 0.51 + ${height.toFixed(1)})
            * cos(terrainWorld.y * 0.67 - terrainWorld.x * 0.39)), 10.0);
          float terrainColorNoise = broadMottle * 0.5 + 0.5 + middleGrain * 0.08;
          float sunlitMeadow = smoothstep(0.2, 0.86,
            sin(terrainWorld.x * 0.095 + terrainWorld.y * 0.12)
            * cos(terrainWorld.y * 0.073 - terrainWorld.x * 0.051) * 0.5 + 0.5);
          float richMoss = smoothstep(0.28, 0.82, terrainColorNoise) * (1.0 - sunlitMeadow * 0.34);
          float windScour = smoothstep(0.54, 0.94,
            sin(terrainWorld.x * 0.31 - terrainWorld.y * 0.27 + middleGrain) * 0.5 + 0.5);
          float mineralLode = mineralSpeck * ${height >= 2 ? "0.46" : "0.16"};
          diffuseColor.rgb *= 0.968 + broadMottle * 0.026 + middleGrain * 0.016 + fineGrain * 0.006;
          diffuseColor.rgb *= mix(vec3(1.055, 1.015, 0.89), vec3(0.91, 1.075, 0.93),
            richMoss * ${height >= 1 ? "0.34" : "0.12"});
          diffuseColor.rgb *= mix(vec3(1.045, 1.025, 0.91), vec3(0.91, 1.015, 1.075),
            windScour * ${height >= 2 ? "0.42" : "0.18"});
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.045, 0.88),
            sunlitMeadow * ${height === 0 ? "0.08" : "0.2"});
          diffuseColor.rgb += vec3(0.035, 0.042, 0.032) * mineralLode;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.88, 1.06, 1.12),
            lichenField * ${height >= 1 ? "0.068" : "0.02"});`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          float terrainRoughnessGrain = sin(vTerrainWorldPosition.x * 5.4 + vTerrainWorldPosition.z * 4.7)
            * cos(vTerrainWorldPosition.z * 6.2 - vTerrainWorldPosition.x * 2.9);
          roughnessFactor = clamp(roughnessFactor + terrainRoughnessGrain * 0.018, 0.0, 1.0);`,
        );
      };
      material.customProgramCacheKey = () => "tide-terrain-world-mottle-v1-" + height;
    };
    const installBlackMistVeil = (material: THREE.MeshBasicMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uMistVeilTime = blackMistVeilUniforms.time;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nuniform float uMistVeilTime;\nvarying vec2 vMistVeilUv;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vMistVeilUv = uv;
          // 霧幕本身有輕微起伏，避免像直立貼片；形變留在 GPU，不增加 CPU 逐片更新。
          transformed.x += sin(position.y * 4.2 + position.x * 2.1 + uMistVeilTime * 0.22) * 0.014;
          transformed.y += sin(position.x * 5.8 - uMistVeilTime * 0.17 + position.y * 1.6) * 0.018;`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nuniform float uMistVeilTime;\nvarying vec2 vMistVeilUv;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float veilBaseFade = smoothstep(0.015, 0.2, vMistVeilUv.y);
          float veilTopFade = 1.0 - smoothstep(0.7, 1.0, vMistVeilUv.y);
          float veilStrand = 0.91 + 0.09 * sin(vMistVeilUv.x * 18.0 - uMistVeilTime * 0.24
            + sin(vMistVeilUv.y * 8.0) * 1.7);
          diffuseColor.a *= veilBaseFade * veilTopFade * veilStrand;
          diffuseColor.rgb *= mix(vec3(0.72, 0.82, 1.02), vec3(0.92, 0.98, 1.12), vMistVeilUv.y);`,
        );
      };
      material.customProgramCacheKey = () => "tide-black-mist-3d-veil-v1";
    };
    installSanctuarySigil(shared.sanctuarySigil);
    installRoadFlow(shared.roadGuide);
    for (let height = 0; height < shared.terrain.length; height++) {
      installTerrainSurface(shared.terrain[height], height);
    }
    installBlackMistVeil(shared.blackMistVeil);

    // 海面焦散：兩組交錯波紋在材質內運算，不建立額外粒子或平面。
    // 透過共用 uniform 驅動深海與淺灘，讓遠景水域也有連續的潮汐流動感。
    const oceanSurfaceUniforms = { time: { value: 0 } };
    const installOceanSurface = (material: THREE.MeshPhysicalMaterial, cacheKey: string, isShelf = false) => {
      const shelfGradient = isShelf
        ? "float shelfEdgeDistance = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));\n"
          + "float shelfWaterBlend = smoothstep(0.008, 0.2, shelfEdgeDistance);\n"
          + "diffuseColor.rgb = mix(vec3(0.025, 0.075, 0.098), diffuseColor.rgb, shelfWaterBlend);\n"
          + "diffuseColor.rgb += vec3(0.006, 0.024, 0.03) * (1.0 - shelfWaterBlend) * 0.35;"
        : "";
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uOceanTime = oceanSurfaceUniforms.time;
        // 細分海面頂點沿法線做低幅度長波形變，真正改變剪影而非只改變貼圖顏色。
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nuniform float uOceanTime;\nvarying vec2 vOceanLocal;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vOceanLocal = position.xy;
          float swellA = sin(position.x * 0.055 + position.y * 0.039 + uOceanTime * 0.34);
          float swellB = sin(position.y * 0.083 - position.x * 0.026 - uOceanTime * 0.23);
          float capillary = sin((position.x + position.y) * 0.12 + uOceanTime * 0.52);
          transformed.z += swellA * 0.082 + swellB * 0.036 + capillary * 0.009;`,
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
          float normalPhaseA = position.x * 0.055 + position.y * 0.039 + uOceanTime * 0.34;
          float normalPhaseB = position.y * 0.083 - position.x * 0.026 - uOceanTime * 0.23;
          float normalPhaseC = (position.x + position.y) * 0.12 + uOceanTime * 0.52;
          float swellDx = 0.082 * 0.055 * cos(normalPhaseA)
            - 0.036 * 0.026 * cos(normalPhaseB)
            + 0.009 * 0.12 * cos(normalPhaseC);
          float swellDy = 0.082 * 0.039 * cos(normalPhaseA)
            + 0.036 * 0.083 * cos(normalPhaseB)
            + 0.009 * 0.12 * cos(normalPhaseC);
          objectNormal.xy += vec2(-swellDx, -swellDy);`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nuniform float uOceanTime;\nvarying vec2 vOceanLocal;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          ${shelfGradient}
#ifdef USE_UV
          vec2 tideUv = vUv * vec2(17.0, 13.0);
          float tideA = abs(sin(tideUv.x + sin(tideUv.y * 0.72 - uOceanTime * 0.34) * 1.25 - uOceanTime * 0.42));
          float tideB = abs(sin(tideUv.y * 1.18 - tideUv.x * 0.43 + cos(tideUv.x * 0.64 + uOceanTime * 0.27) * 0.9));
          float tideCaustic = pow(1.0 - smoothstep(0.025, 0.34, tideA * tideB), 3.0);
          diffuseColor.rgb += vec3(0.018, 0.072, 0.074) * tideCaustic;
#endif
          float swellSheen = pow(max(0.0, 0.5 + 0.5 * sin(vOceanLocal.x * 0.055 + vOceanLocal.y * 0.039 + uOceanTime * 0.34)), 7.0);
          diffuseColor.rgb += vec3(0.012, 0.038, 0.04) * swellSheen;`,
        );
      };
      material.customProgramCacheKey = () => cacheKey;
    };
    installOceanSurface(shared.floor, "tide-ocean-floor-caustics-v1");
    installOceanSurface(shared.seaShelf, "tide-ocean-shelf-caustics-v2", true);

    // 海岸浪沫：沿實例世界座標產生不同相位，讓浪花沿岸流動，而非整條海岸同步閃爍。
    const installShoreFoamFlow = (material: THREE.MeshBasicMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uShoreFoamTime = shoreFoamUniforms.time;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vShoreFoamUv;\nvarying float vShoreFoamPhase;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvShoreFoamUv = vec2(position.x, position.z);\n#ifdef USE_INSTANCING\nvShoreFoamPhase = dot(instanceMatrix[3].xz, vec2(0.19, 0.13));\n#else\nvShoreFoamPhase = dot(position.xz, vec2(0.19, 0.13));\n#endif",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vShoreFoamUv;\nvarying float vShoreFoamPhase;\nuniform float uShoreFoamTime;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          [
            "#include <color_fragment>",
            "float shoreFlowA = 0.5 + 0.5 * sin(vShoreFoamUv.x * 18.0 - uShoreFoamTime * 1.25 + vShoreFoamPhase);",
            "float shoreFlowB = 0.5 + 0.5 * sin(vShoreFoamUv.x * 31.0 + vShoreFoamUv.y * 8.0 - uShoreFoamTime * 0.72 + vShoreFoamPhase * 1.7);",
            "float foamCrest = smoothstep(0.72, 0.98, shoreFlowA * (0.72 + shoreFlowB * 0.28));",
            "diffuseColor.rgb += vec3(0.075, 0.16, 0.135) * foamCrest;",
            "diffuseColor.a *= 0.88 + foamCrest * 0.12;",
          ].join("\n"),
        );
      };
      material.customProgramCacheKey = () => "tide-shore-foam-flow-v1";
    };
    installShoreFoamFlow(shared.shoreFoam);

    // 崖壁使用材質內的細層理與緩慢礦脈光，不添加額外幾何，也不影響地形碰撞。
    const installCliffStrata = (material: THREE.MeshStandardMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uCliffStrataTime = cliffStrataUniforms.time;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vCliffStrataUv;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvCliffStrataUv = uv;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vCliffStrataUv;\nuniform float uCliffStrataTime;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          [
            "#include <color_fragment>",
            "float strataWarp = sin(vCliffStrataUv.x * 13.0 + sin(vCliffStrataUv.y * 8.0) * 1.4);",
            "float strataLine = 1.0 - smoothstep(0.018, 0.075, abs(fract(vCliffStrataUv.y * 9.0 + strataWarp * 0.018) - 0.5));",
            "float strataBreak = smoothstep(0.18, 0.82, sin(vCliffStrataUv.x * 21.0 + sin(vCliffStrataUv.y * 17.0) * 2.1) * 0.5 + 0.5);",
            "float mineralVein = pow(max(0.0, sin(vCliffStrataUv.x * 26.0 - uCliffStrataTime * 0.22 + vCliffStrataUv.y * 5.0)), 18.0);",
            "diffuseColor.rgb *= 0.94 + strataLine * strataBreak * 0.09;",
            "diffuseColor.rgb += vec3(0.018, 0.065, 0.052) * mineralVein * strataBreak * 0.55;",
          ].join("\n"),
        );
      };
      material.customProgramCacheKey = () => "tide-cliff-strata-mineral-v1";
    };
    installCliffStrata(shared.cliff);

    // 草、花、樹冠與蘑菇共用頂點風場；每個實例只在 GPU 彎曲頂端，不逐物件跑動畫.
    const installFoliageWind = (material: THREE.MeshStandardMaterial, cacheKey: string) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uFoliageTime = foliageWindUniform;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          `#include <common>
uniform float uFoliageTime;
varying float vFoliageGust;`,
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
vFoliageGust = 0.0;
#ifdef USE_INSTANCING
        float foliagePhase = dot(instanceMatrix[3].xz, vec2(0.17, 0.13));
        float foliageMask = smoothstep(-0.28, 0.52, position.y);
        vec2 windDirection = normalize(vec2(0.86, 0.42));
        float windTravel = dot(instanceMatrix[3].xz, windDirection);
        float broadGust = sin(uFoliageTime * 0.42 + dot(instanceMatrix[3].xz, vec2(0.031, 0.019)));
        float travelingGust = sin(windTravel * 0.115 - uFoliageTime * 1.08);
        float gustStrength = 0.42 + 0.34 * smoothstep(-0.65, 0.88, broadGust)
          + 0.24 * smoothstep(-0.56, 0.78, travelingGust);
        vFoliageGust = gustStrength * smoothstep(-0.5, 0.72, travelingGust);
        float foliageWave = sin(uFoliageTime * 1.35 + foliagePhase + position.y * 2.8);
        float foliageFlutter = sin(uFoliageTime * 2.4 + foliagePhase * 1.73 + position.y * 5.2) * 0.22;
        float foliageSway = (foliageWave + foliageFlutter) * gustStrength;
        float gustLean = smoothstep(-0.18, 0.78, travelingGust) * foliageMask;
        transformed.x += (foliageSway * 0.092 + gustLean * 0.026) * foliageMask;
        transformed.z += (cos(uFoliageTime * 0.91 + foliagePhase * 1.27 + position.y * 1.8)
          + foliageFlutter * 0.45 + gustLean * 0.34) * 0.048 * foliageMask;
#endif`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\\nvarying float vFoliageGust;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float windLightCatch = smoothstep(0.12, 0.96, vFoliageGust);
          diffuseColor.rgb *= 1.0 + vec3(0.026, 0.048, 0.018) * windLightCatch;`,
        );
      };
      material.customProgramCacheKey = () => cacheKey;
    };
    installFoliageWind(shared.foliageWind, "tide-foliage-wind-v1");
    installFoliageWind(shared.grass, "tide-grass-stem-wind-v1");
    installFoliageWind(shared.grassBlade, "tide-grass-blade-wind-v2");
    installFoliageWind(shared.meadowBloom, "tide-meadow-bloom-wind-v1");
    installFoliageWind(shared.coastGrass, "tide-coast-reed-wind-v1");
    installFoliageWind(shared.reefCoral, "tide-reef-coral-current-v1");

    // 花粉與草籽以少量實例漂浮；GPU 風場控制輕微三維漂移，不逐粒更新矩陣。
    const installPollenDrift = (material: THREE.MeshBasicMaterial) => {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uPollenTime = pollenUniforms.time;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <common>",
          "#include <common>\\nuniform float uPollenTime;\\nvarying float vPollenPhase;",
        );
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float pollenPhase = 0.0;
          #ifdef USE_INSTANCING
            pollenPhase = dot(instanceMatrix[3].xz, vec2(0.13, 0.19));
          #endif
          vPollenPhase = pollenPhase;
          transformed.x += sin(uPollenTime * 0.62 + pollenPhase) * 0.082;
          transformed.y += cos(uPollenTime * 0.86 + pollenPhase * 1.37) * 0.065;
          transformed.z += sin(uPollenTime * 0.51 + pollenPhase * 0.83) * 0.074;`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <common>",
          "#include <common>\\nuniform float uPollenTime;\\nvarying float vPollenPhase;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float pollenTwinkle = 0.76 + 0.24 * (0.5 + 0.5 * sin(uPollenTime * 2.1 + vPollenPhase));
          diffuseColor.rgb *= 0.82 + pollenTwinkle * 0.36;
          diffuseColor.a *= pollenTwinkle;`,
        );
      };
      material.customProgramCacheKey = () => "tide-pollen-drift-twinkle-v1";
    };
    installPollenDrift(shared.pollen);

    // 所有地形區塊共用 4 種高度幾何，避免切塊後重複建立數百份相同頂點資料。
    const terrainGeometries = [0, 1, 2, 3].map(
      (height) => new THREE.BoxGeometry(0.98, groundTop(height), 0.98),
    );

    // 透明命中盒只供 Raycaster 使用，完全不參與顯示與深度寫入；保證 HQ 屋頂／城牆容易選取。
    const buildingHitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const getTexture = (image: HTMLImageElement) => {
      let texture = textureCache.get(image);
      if (!texture) {
        texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        textureCache.set(image, texture);
      }
      return texture;
    };

    const addContactShadow = (parent: any, radius: number) => {
      const shadow = new THREE.Mesh(contactShadowGeometry, shared.contactShadow);
      shadow.userData.sharedGeometry = true;
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.006;
      shadow.scale.set(radius, radius, 1);
      shadow.renderOrder = 0;
      shadow.castShadow = false;
      shadow.frustumCulled = false;
      parent.add(shadow);
      return shadow;
    };

    const addBox = (parent: any, sx: number, sy: number, sz: number, x: number, y: number, z: number, material: any) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const addCylinder = (parent: any, top: number, bottom: number, height: number, x: number, y: number, z: number, material: any, sides = 12) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, sides), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const makeCrystal = (parent: any, x: number, y: number, z: number, size: number) => {
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(size, 1), shared.crystal);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      gems.push(mesh);
      return mesh;
    };

    const addCornerInstallationRing = (parent: any, x: number, z: number) => {
      const material = new THREE.MeshBasicMaterial({ color: "#ffe2a0", transparent: true, opacity: 0.95, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.045, 8, 32), material);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(x, 2.49, z);
      mesh.scale.setScalar(0.2);
      parent.add(mesh);
      installationRings.push({ mesh, material, age: 0, duration: 0.92 });
    };

    const makeCannon = (parent: any, scale = 1) => {
      const cannon = new THREE.Group();
      parent.add(cannon);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.76 * scale, 0.28 * scale, 0.66 * scale), shared.blue);
      base.position.y = 0.17 * scale;
      base.castShadow = true;
      cannon.add(base);

      // 炮尾能源匣、炮身護軌與金屬束環，讓主炮和角樓炮塔都有明確的機械結構。
      const breech = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * scale, 0.29 * scale, 0.3 * scale, 14), shared.blue);
      breech.rotation.x = Math.PI / 2;
      breech.position.set(0, 0.47 * scale, -0.2 * scale);
      breech.castShadow = true;
      cannon.add(breech);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.095 * scale, 0.12 * scale, 0.64 * scale), shared.brightGold);
        rail.position.set(side * 0.235 * scale, 0.39 * scale, 0.34 * scale);
        rail.castShadow = true;
        cannon.add(rail);
        const powerCell = new THREE.Mesh(new THREE.OctahedronGeometry(0.075 * scale, 0), shared.crystal);
        powerCell.position.set(side * 0.29 * scale, 0.37 * scale, 0.5 * scale);
        cannon.add(powerCell);
      }
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * scale, 0.23 * scale, 1.08 * scale, 14), shared.gold);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.47 * scale, 0.34 * scale);
      barrel.castShadow = true;
      cannon.add(barrel);
      for (const z of [0.02, 0.34, 0.66]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.19 * scale, 0.032 * scale, 7, 18), shared.brightGold);
        band.rotation.x = Math.PI / 2;
        band.position.set(0, 0.47 * scale, z * scale);
        cannon.add(band);
      }
      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.22 * scale, 0.055 * scale, 8, 20), shared.brightGold);
      muzzle.rotation.x = Math.PI / 2;
      muzzle.position.set(0, 0.47 * scale, 0.88 * scale);
      cannon.add(muzzle);
      const muzzleCore = new THREE.Mesh(new THREE.SphereGeometry(0.105 * scale, 10, 8), shared.crystal);
      muzzleCore.position.set(0, 0.47 * scale, 0.9 * scale);
      cannon.add(muzzleCore);
      const flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.23 * scale, 10, 8),
        new THREE.MeshBasicMaterial({ color: "#fff0b2", transparent: true, opacity: 0.9 }),
      );
      flash.position.set(0, 0.47 * scale, 1.02 * scale);
      flash.visible = false;
      cannon.add(flash);
      cannon.userData.muzzleFlash = flash;
      return cannon;
    };

    const createSanctuary = (tower: Terrain3DTower, heights: number[], animateTurrets: boolean, animateMainUpgrade: boolean) => {
      const root = new THREE.Group();
      root.position.set(tower.x / CELL, groundTop(heights[tower.gy * COLS + tower.gx] ?? 0), tower.y / CELL);
      addContactShadow(root, 3.34);
      // 儀式廣場的流動符印：刻紋由 Shader 驅動，貼著地面展開、不遮擋本陣模型。
      const sanctuarySigil = new THREE.Mesh(
        new THREE.PlaneGeometry(10.8, 10.8),
        shared.sanctuarySigil,
      );
      sanctuarySigil.rotation.x = -Math.PI / 2;
      sanctuarySigil.position.y = 0.046;
      sanctuarySigil.renderOrder = 1;
      sanctuarySigil.castShadow = false;
      sanctuarySigil.receiveShadow = false;
      root.add(sanctuarySigil);
      // 六乘六格石造基座，金邊和階層清楚標示建築佔地
      addBox(root, 6.05, 0.24, 6.05, 0, 0.12, 0, shared.blue);
      addBox(root, 5.8, 0.16, 5.8, 0, 0.31, 0, shared.gold);
      addBox(root, 5.52, 0.24, 5.52, 0, 0.49, 0, shared.ivory);
      addBox(root, 4.9, 0.2, 4.9, 0, 0.69, 0, shared.roof);

      // 四向城牆與角柱
      const wy = 1.08;
      addBox(root, 4.55, 0.74, 0.32, 0, wy, -2.26, shared.stone);
      addBox(root, 4.55, 0.74, 0.32, 0, wy, 2.26, shared.stone);
      addBox(root, 0.32, 0.74, 4.55, -2.26, wy, 0, shared.stone);
      addBox(root, 0.32, 0.74, 4.55, 2.26, wy, 0, shared.stone);
      for (const side of [-1, 1]) for (const offset of [-1.55, 1.55]) {
        addBox(root, 0.14, 0.88, 0.14, side * 2.27, 1.15, offset, shared.gold);
        addBox(root, 0.14, 0.88, 0.14, offset, 1.15, side * 2.27, shared.gold);
      }
      // 城垛：四面牆頂都有獨立齒狀石塊，近距離環視仍能讀出防禦結構。
      for (const sign of [-1, 1]) {
        for (let i = -2; i <= 2; i++) {
          addBox(root, 0.48, 0.2, 0.34, i * 0.82, 1.55, sign * 2.25, shared.ivory);
          addBox(root, 0.34, 0.2, 0.48, sign * 2.25, 1.55, i * 0.82, shared.ivory);
        }
      }
      // 深色窗縫與正面大門，讓牆面不再只是平整石盒。
      for (const sign of [-1, 1]) for (const offset of [-1.35, 0, 1.35]) {
        const slit = addBox(root, 0.12, 0.27, 0.025, offset, 1.05, sign * 2.435, shared.glass);
        slit.castShadow = false;
      }
      addBox(root, 0.78, 0.68, 0.08, 0, 0.98, 2.49, shared.blue);
      addBox(root, 0.52, 0.47, 0.035, 0, 0.98, 2.55, shared.gold);
      addBox(root, 0.33, 0.37, 0.035, 0, 0.98, 2.58, shared.glass);

      // 本陣入口增加半圓石拱、內側金屬收邊與中央徽記，入口仍保持原有開口寬度。
      const entryArch = new THREE.Mesh(
        new THREE.TorusGeometry(0.58, 0.075, 8, 32, Math.PI),
        shared.ruinStone,
      );
      entryArch.position.set(0, 1.31, 2.64);
      entryArch.castShadow = true;
      entryArch.receiveShadow = true;
      root.add(entryArch);
      const entryArchTrim = new THREE.Mesh(
        new THREE.TorusGeometry(0.49, 0.024, 6, 32, Math.PI),
        shared.brightGold,
      );
      entryArchTrim.position.set(0, 1.31, 2.705);
      root.add(entryArchTrim);
      for (const side of [-1, 1]) {
        addBox(root, 0.16, 0.78, 0.18, side * 0.56, 1.12, 2.62, shared.ivory);
        addBox(root, 0.25, 0.09, 0.22, side * 0.56, 1.54, 2.62, shared.bridgeTrim);
        addBox(root, 0.21, 0.07, 0.21, side * 0.56, 0.69, 2.62, shared.foundationGold);
      }
      const entryEmblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), shared.chargeCrystal);
      entryEmblem.position.set(0, 1.91, 2.66);
      entryEmblem.scale.set(1, 1.18, 0.48);
      entryEmblem.castShadow = false;
      root.add(entryEmblem);
      gems.push(entryEmblem);

      // 牆面轉角增加同材質石造扶壁，讓本陣從斜角觀看更有厚重支撐感。
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        addBox(root, 0.38, 0.74, 0.38, sx * 2.17, 1.12, sz * 2.17, shared.ivory);
        addBox(root, 0.45, 0.085, 0.45, sx * 2.17, 1.52, sz * 2.17, shared.brightGold);
        addBox(root, 0.42, 0.07, 0.42, sx * 2.17, 0.72, sz * 2.17, shared.foundationGold);
      }


      // 城牆外側增加八枚潮汐徽記：低矮浮雕與晶核，不改變城牆、入口或基地佔地。
      const wallCrests = [
        { x: -0.82, y: 1.17, z: 2.455, rot: 0, nx: 0, nz: 1 },
        { x: 0.82, y: 1.17, z: 2.455, rot: 0, nx: 0, nz: 1 },
        { x: -0.82, y: 1.17, z: -2.455, rot: Math.PI, nx: 0, nz: -1 },
        { x: 0.82, y: 1.17, z: -2.455, rot: Math.PI, nx: 0, nz: -1 },
        { x: 2.455, y: 1.17, z: -0.82, rot: Math.PI / 2, nx: 1, nz: 0 },
        { x: 2.455, y: 1.17, z: 0.82, rot: Math.PI / 2, nx: 1, nz: 0 },
        { x: -2.455, y: 1.17, z: -0.82, rot: -Math.PI / 2, nx: -1, nz: 0 },
        { x: -2.455, y: 1.17, z: 0.82, rot: -Math.PI / 2, nx: -1, nz: 0 },
      ];
      for (const crest of wallCrests) {
        const plate = addBox(
          root, 0.38, 0.48, 0.055,
          crest.x + crest.nx * 0.024, crest.y, crest.z + crest.nz * 0.024, shared.blue,
        );
        plate.rotation.y = crest.rot;
        plate.castShadow = false;
        const frame = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 6, 24), shared.brightGold);
        frame.position.set(crest.x + crest.nx * 0.065, crest.y, crest.z + crest.nz * 0.065);
        frame.rotation.y = crest.rot;
        root.add(frame);
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.095, 0), shared.chargeCrystal);
        gem.position.set(crest.x + crest.nx * 0.085, crest.y, crest.z + crest.nz * 0.085);
        gem.scale.set(1, 1.16, 0.72);
        root.add(gem);
        gems.push(gem);
      }

      // 牆面金屬收邊、窗框、立柱與石階，避免近距離環視時只看到大塊方形牆體。
      for (const sign of [-1, 1]) {
        addBox(root, 4.55, 0.055, 0.36, 0, 0.78, sign * 2.26, shared.gold);
        addBox(root, 4.55, 0.045, 0.36, 0, 1.43, sign * 2.26, shared.gold);
        addBox(root, 0.36, 0.055, 4.55, sign * 2.26, 0.78, 0, shared.gold);
        addBox(root, 0.36, 0.045, 4.55, sign * 2.26, 1.43, 0, shared.gold);

        for (const offset of [-1.25, 1.25]) {
          addBox(root, 0.29, 0.42, 0.07, offset, 1.13, sign * 2.44, shared.gold);
          addBox(root, 0.19, 0.29, 0.025, offset, 1.13, sign * 2.49, shared.glass);
          addBox(root, 0.34, 0.045, 0.10, offset, 0.9, sign * 2.45, shared.brightGold);

          addBox(root, 0.07, 0.42, 0.29, sign * 2.44, 1.13, offset, shared.gold);
          addBox(root, 0.025, 0.29, 0.19, sign * 2.49, 1.13, offset, shared.glass);
          addBox(root, 0.10, 0.045, 0.34, sign * 2.45, 0.9, offset, shared.brightGold);
        }
        for (const offset of [-1.92, 1.92]) {
          addBox(root, 0.16, 0.82, 0.14, offset, 1.08, sign * 2.43, shared.blue);
          addBox(root, 0.2, 0.08, 0.18, offset, 1.52, sign * 2.43, shared.brightGold);
          addBox(root, 0.14, 0.82, 0.16, sign * 2.43, 1.08, offset, shared.blue);
          addBox(root, 0.18, 0.08, 0.2, sign * 2.43, 1.52, offset, shared.brightGold);
        }
      }
      addBox(root, 1.0, 0.12, 0.2, 0, 0.7, 2.62, shared.ivory);
      addBox(root, 1.1, 0.1, 0.2, 0, 0.6, 2.81, shared.stone);
      addBox(root, 1.18, 0.09, 0.18, 0, 0.51, 2.94, shared.stone);

      // 本陣基座外緣加上三面石刻邊飾；入口側保留完整石階與通行視線。
      for (const sign of [-1, 1]) {
        addBox(root, 0.22, 0.045, 0.46, sign * 2.6, 0.635, -2.6, shared.foundationStone);
        addBox(root, 0.22, 0.045, 0.46, sign * 2.6, 0.635, 2.6, shared.foundationStone);
        addBox(root, 0.5, 0.045, 0.22, 0, 0.635, -2.6, shared.foundationStone);
        const sideInlay = addBox(root, 0.055, 0.018, 0.28, sign * 2.6, 0.669, -2.6, shared.foundationGold);
        sideInlay.castShadow = false;
      }
      for (const x of [-2.6, 2.6]) {
        const cornerSeal = new THREE.Mesh(new THREE.OctahedronGeometry(0.085, 0), shared.foundationGold);
        cornerSeal.position.set(x, 0.69, -2.6);
        cornerSeal.scale.set(1.1, 0.42, 1.1);
        root.add(cornerSeal);
      }

      // 聖地地坪加入雙層潮汐封印與八枚定位晶釘，讓核心區從斜視角也清楚可辨。
      const sanctuaryOuterSeal = new THREE.Mesh(
        new THREE.TorusGeometry(1.82, 0.025, 6, 64),
        shared.foundationGold,
      );
      sanctuaryOuterSeal.rotation.x = Math.PI / 2;
      sanctuaryOuterSeal.position.y = 0.812;
      sanctuaryOuterSeal.castShadow = false;
      root.add(sanctuaryOuterSeal);
      const sanctuaryInnerSeal = new THREE.Mesh(
        new THREE.TorusGeometry(1.62, 0.012, 5, 64),
        shared.runeGlow,
      );
      sanctuaryInnerSeal.rotation.x = Math.PI / 2;
      sanctuaryInnerSeal.position.y = 0.814;
      sanctuaryInnerSeal.castShadow = false;
      root.add(sanctuaryInnerSeal);
      for (let mark = 0; mark < 8; mark++) {
        const angle = (mark / 8) * Math.PI * 2;
        const sealGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.052, 0), shared.chargeCrystal);
        sealGem.position.set(Math.cos(angle) * 1.82, 0.846, Math.sin(angle) * 1.82);
        sealGem.scale.set(0.82, 1.25, 0.82);
        sealGem.castShadow = false;
        root.add(sealGem);
      }

      // 聖地外圈儀式庭：石環、八枚低矮晶釘與通往正門的踏石，形成建築與地景的銜接。
      const sanctuaryOuterWalk = new THREE.Mesh(
        new THREE.TorusGeometry(5.05, 0.035, 6, 112),
        shared.foundationGold,
      );
      sanctuaryOuterWalk.rotation.x = Math.PI / 2;
      sanctuaryOuterWalk.position.y = 0.035;
      sanctuaryOuterWalk.castShadow = false;
      sanctuaryOuterWalk.receiveShadow = false;
      root.add(sanctuaryOuterWalk);

      // 外環改成可辨識的儀式石徑：32 塊放射狀踏石搭配細金屬嵌條，讓聖地與周圍草地有完整的建築邊界。
      const plazaPaverCount = 32;
      const plazaPavers = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.82, 0.055, 0.62),
        shared.foundationStone,
        plazaPaverCount,
      );
      const plazaInlays = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.34, 0.012, 0.052),
        shared.foundationGold,
        plazaPaverCount,
      );
      const plazaDummy = new THREE.Object3D();
      const plazaTint = new THREE.Color();
      for (let i = 0; i < plazaPaverCount; i++) {
        const angle = (i / plazaPaverCount) * Math.PI * 2;
        const radius = 4.58 + Math.sin(i * 2.31) * 0.035;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        plazaDummy.position.set(x, 0.052, z);
        plazaDummy.rotation.set(0, -angle, 0);
        plazaDummy.scale.set(0.94 + (i % 3) * 0.035, 1, 0.92 + (i % 4) * 0.035);
        plazaDummy.updateMatrix();
        plazaPavers.setMatrixAt(i, plazaDummy.matrix);
        plazaTint.set(i % 4 === 0 ? "#c7b999" : i % 3 === 0 ? "#aeb5a2" : "#9eaa9e");
        plazaPavers.setColorAt(i, plazaTint);

        plazaDummy.position.set(x, 0.086, z);
        plazaDummy.rotation.set(0, -angle, 0);
        plazaDummy.scale.set(0.9, 1, 1);
        plazaDummy.updateMatrix();
        plazaInlays.setMatrixAt(i, plazaDummy.matrix);
      }
      plazaPavers.instanceMatrix.needsUpdate = true;
      plazaInlays.instanceMatrix.needsUpdate = true;
      if (plazaPavers.instanceColor) plazaPavers.instanceColor.needsUpdate = true;
      plazaPavers.castShadow = false;
      plazaPavers.receiveShadow = true;
      plazaInlays.castShadow = false;
      plazaInlays.receiveShadow = false;
      root.add(plazaPavers, plazaInlays);

      const sanctuaryInnerWalk = new THREE.Mesh(
        new THREE.TorusGeometry(4.72, 0.014, 5, 112),
        shared.runeGlow,
      );
      sanctuaryInnerWalk.rotation.x = Math.PI / 2;
      sanctuaryInnerWalk.position.y = 0.038;
      sanctuaryInnerWalk.castShadow = false;
      root.add(sanctuaryInnerWalk);
      for (let marker = 0; marker < 8; marker++) {
        const angle = (marker / 8) * Math.PI * 2 + Math.PI / 8;
        const x = Math.cos(angle) * 5.05;
        const z = Math.sin(angle) * 5.05;
        const plinth = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.22, 0.13, 8),
          shared.foundationStone,
        );
        plinth.position.set(x, 0.09, z);
        plinth.castShadow = false;
        plinth.receiveShadow = true;
        root.add(plinth);
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.105, 0), shared.chargeCrystal);
        crystal.position.set(x, 0.26, z);
        crystal.scale.set(0.8, 1.35, 0.8);
        crystal.castShadow = false;
        root.add(crystal);
        gems.push(crystal);
      }
      const approachStones = new THREE.Group();
      for (let step = 0; step < 5; step++) {
        const stone = new THREE.Mesh(
          new THREE.BoxGeometry(0.78, 0.055, 0.4),
          shared.bridgeStone,
        );
        stone.position.set((step % 2 === 0 ? -0.035 : 0.035), 0.045, 3.22 + step * 0.49);
        stone.rotation.y = (step % 2 === 0 ? -1 : 1) * 0.025;
        stone.castShadow = false;
        stone.receiveShadow = true;
        approachStones.add(stone);
      }
      root.add(approachStones);

      // 中央聖殿、藍色穹頂和高聳水晶尖塔
      addCylinder(root, 1.03, 1.18, 1.52, 0, 1.64, -0.28, shared.ivory, 12);
      addCylinder(root, 1.12, 1.12, 0.18, 0, 2.46, -0.28, shared.gold, 12);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.08, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), shared.roof);
      dome.position.set(0, 2.5, -0.28);
      dome.castShadow = true;
      root.add(dome);
      addCylinder(root, 0.46, 0.62, 0.62, 0, 3.28, -0.28, shared.gold, 10);
      const spire = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.15, 8), shared.gold);
      spire.position.set(0, 4.12, -0.28);
      spire.castShadow = true;
      root.add(spire);
      const heartCrystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.53, 1), shared.chargeCrystal);
      heartCrystal.position.set(0, 4.82, -0.28);
      heartCrystal.castShadow = true;
      root.add(heartCrystal);
      gems.push(heartCrystal);
      chargeCores.push({ mesh: heartCrystal, material: shared.chargeCrystal, tower });
      // 水晶核心外側懸浮兩道不同傾角的能量軌道，與地面符印形成上下呼應。
      const heartOrbitInner = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.018, 6, 64),
        shared.runeGlow,
      );
      heartOrbitInner.position.set(0, 4.82, -0.28);
      heartOrbitInner.rotation.set(Math.PI / 2 - 0.34, 0.22, 0.18);
      heartOrbitInner.castShadow = false;
      root.add(heartOrbitInner);
      rings.push(heartOrbitInner);
      const heartOrbitOuter = new THREE.Mesh(
        new THREE.TorusGeometry(0.98, 0.014, 5, 72),
        shared.brightGold,
      );
      heartOrbitOuter.position.set(0, 4.82, -0.28);
      heartOrbitOuter.rotation.set(Math.PI / 2 + 0.48, -0.38, -0.22);
      heartOrbitOuter.castShadow = false;
      root.add(heartOrbitOuter);
      rings.push(heartOrbitOuter);

      // 主殿四面柱與金色飛簷，強化建築層次。
      for (const side of [-1, 1]) {
        addCylinder(root, 0.12, 0.15, 1.15, side * 1.22, 1.9, -0.28, shared.gold, 8);
        addCylinder(root, 0.12, 0.15, 1.15, -0.28, 1.9, side * 1.22, shared.gold, 8);
      }
      addCylinder(root, 1.42, 1.42, 0.12, 0, 2.62, -0.28, shared.brightGold, 12);

      // 主炮始終存在，使用金屬炮身＋藍色晶體砲口
      const mainGunMount = new THREE.Group();
      mainGunMount.position.set(0, 1.92, 0.82);
      mainGunMount.rotation.y = Math.atan2(Math.cos(tower.aim), Math.sin(tower.aim));
      const mainCannon = makeCannon(mainGunMount, (tower.hqFireLv ?? 0) >= 2 ? 1.52 : 1.2);
      mainCannon.position.y = 0.12;
      if (animateMainUpgrade) {
        mainCannon.scale.setScalar(0.72);
        installationAnimations.push({ group: mainCannon, targetY: 0.12, age: 0, duration: 0.72, fromScale: 0.72 });
      }
      root.add(mainGunMount);
      turretGroups.push({
        group: mainGunMount, tower, index: -1, flash: mainCannon.userData.muzzleFlash,
        baseY: 1.92, baseZ: 0.82,
      });

      const mainRing = new THREE.Group();
      mainRing.position.set(0, 2.08, 0.82);
      const ringMesh = new THREE.Mesh(new THREE.TorusGeometry((tower.hqFireLv ?? 0) >= 2 ? 1.08 : 0.88, 0.065, 10, 48), shared.brightGold);
      ringMesh.rotation.x = Math.PI / 2;
      mainRing.add(ringMesh);
      root.add(mainRing);
      rings.push(mainRing);

      // 四座角樓先有空砲座；購買火力後才安裝砲塔和炮管
      const corners = [[-2.28, -2.28], [2.28, -2.28], [-2.28, 2.28], [2.28, 2.28]];
      for (const [cx, cz] of corners) {
        addCylinder(root, 0.56, 0.69, 1.02, cx, 1.59, cz, shared.stone, 10);
        addCylinder(root, 0.6, 0.66, 0.13, cx, 2.16, cz, shared.gold, 10);
        addCylinder(root, 0.48, 0.58, 0.2, cx, 2.29, cz, shared.roof, 10);
        addCylinder(root, 0.53, 0.53, 0.065, cx, 2.41, cz, shared.brightGold, 10);
        const spin = new THREE.Group();
        spin.position.set(cx, 2.49, cz);
        const runeRing = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.055, 8, 28), shared.brightGold);
        runeRing.rotation.x = Math.PI / 2;
        spin.add(runeRing);
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), shared.crystal);
        gem.position.y = 0.06;
        spin.add(gem);
        for (let mark = 0; mark < 4; mark++) {
          const angle = (mark * Math.PI) / 2;
          const rune = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), shared.brightGold);
          rune.position.set(Math.cos(angle) * 0.35, 0.018, Math.sin(angle) * 0.35);
          spin.add(rune);
        }
        root.add(spin);
        rings.push(spin);
        gems.push(gem);

        if ((tower.hqFireLv ?? 0) >= 1) {
          const mount = new THREE.Group();
          mount.position.set(cx, 2.19, cz);
          const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.46, 0.3, 12), shared.blue);
          base.position.y = 0.18;
          base.castShadow = true;
          mount.add(base);
          const crown = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.055, 8, 24), shared.gold);
          crown.rotation.x = Math.PI / 2;
          crown.position.y = 0.36;
          mount.add(crown);
          const cannon = makeCannon(mount, 0.78);
          cannon.position.y = 0.28;
          mount.rotation.y = Math.atan2(Math.cos(tower.aim), Math.sin(tower.aim));
          root.add(mount);
          const turretIndex = corners.findIndex(([x, z]) => x === cx && z === cz);
          if (animateTurrets) {
            mount.scale.setScalar(0.015);
            mount.position.y = 3.02;
            installationAnimations.push({ group: mount, targetY: 2.19, age: 0, duration: 0.88 + turretIndex * 0.06, fromScale: 0.015 });
            addCornerInstallationRing(root, cx, cz);
          }
          turretGroups.push({
            group: mount, tower, index: turretIndex, flash: cannon.userData.muzzleFlash,
            baseY: 2.19, baseZ: cz,
          });
        }
      }

      // 升級回饋環：隨 HQ build flash 展開後淡出。
      const buildMaterial = new THREE.MeshBasicMaterial({ color: "#ffe0a0", transparent: true, opacity: 0, side: THREE.DoubleSide });
      const buildRing = new THREE.Mesh(new THREE.TorusGeometry(2.72, 0.075, 8, 64), buildMaterial);
      buildRing.rotation.x = Math.PI / 2;
      buildRing.position.y = 0.34;
      root.add(buildRing);
      buildFlashEffects.push({ mesh: buildRing, material: buildMaterial, tower });

      // 城牆加固會逐層出現金屬護條
      for (let i = 0; i < Math.min(5, tower.hqFortifyLv ?? 0); i++) {
        const y = 1.49 + i * 0.055;
        addBox(root, 4.78, 0.052, 0.38, 0, y, -2.25, shared.gold);
        addBox(root, 4.78, 0.052, 0.38, 0, y, 2.25, shared.gold);
        addBox(root, 0.38, 0.052, 4.78, -2.25, y, 0, shared.gold);
        addBox(root, 0.38, 0.052, 4.78, 2.25, y, 0, shared.gold);
      }
      buildingRoot.add(root);
    };

    const createStake = (tower: Terrain3DTower, heights: number[]) => {
      const root = new THREE.Group();
      root.position.set(tower.x / CELL, groundTop(terrainHeightAt(tower.gx, tower.gy, heights)), tower.y / CELL);
      addContactShadow(root, 0.66);
      addBox(root, 0.96, 0.075, 0.96, 0, 0.0375, 0, shared.foundationStone);
      const stakeSeal = new THREE.Mesh(new THREE.TorusGeometry(0.54, 0.026, 6, 24), shared.foundationGold);
      stakeSeal.rotation.x = Math.PI / 2;
      stakeSeal.position.y = 0.08;
      root.add(stakeSeal);
      addBox(root, 0.78, 0.16, 0.78, 0, 0.08, 0, shared.gold);
      addCylinder(root, 0.22, 0.34, 0.72, 0, 0.48, 0, shared.stone, 8);
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.25, 0), shared.crystal);
      crystal.position.y = 0.95;
      root.add(crystal);
      buildingRoot.add(root);
    };

    const createTowerBase = (tower: Terrain3DTower, heights: number[]) => {
      const root = new THREE.Group();
      root.position.set(tower.x / CELL, groundTop(terrainHeightAt(tower.gx, tower.gy, heights)), tower.y / CELL);
      addContactShadow(root, 1.08);
      const level = Math.max(1, Math.min(8, tower.level || 1));
      const definition = TOWERS[tower.def];
      const accent = getTowerAccentMaterial(definition?.color ?? "#78cfe8");
      const special = definition?.special ?? "high";
      const levelLift = Math.min(0.18, (level - 1) * 0.026);
      const radius = 0.66 + Math.min(0.08, (level - 1) * 0.012);

      // 塔座下方加一圈薄石造承台，只露出建築底緣，避免擴張到相鄰格。
      const foundation = addCylinder(root, 0.83, 0.91, 0.08, 0, 0.04, 0, shared.foundationStone, 12);
      foundation.receiveShadow = true;
      const foundationTrim = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.022, 6, 36), shared.foundationGold);
      foundationTrim.rotation.x = Math.PI / 2;
      foundationTrim.position.y = 0.083;
      root.add(foundationTrim);
      for (const [x, z, rot] of [[0.86, 0, 0], [-0.86, 0, 0], [0, 0.86, Math.PI / 2], [0, -0.86, Math.PI / 2]] as const) {
        const anchorStone = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.045, 0.11), shared.foundationStone);
        anchorStone.position.set(x, 0.087, z);
        anchorStone.rotation.y = rot;
        anchorStone.castShadow = false;
        root.add(anchorStone);
        const bolt = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), shared.foundationGold);
        bolt.position.set(x, 0.119, z);
        bolt.scale.set(1, 0.48, 1);
        root.add(bolt);
      }

      // 每種塔在承台外緣有自己的建築模組：冰晶、焰柱、觀測翼、花瓣、根刺、護盾、導電節點等。
      let baseModuleGeometry: THREE.BufferGeometry;
      if (special === "slow") baseModuleGeometry = new THREE.OctahedronGeometry(0.13, 0);
      else if (special === "burn") baseModuleGeometry = new THREE.ConeGeometry(0.105, 0.24, 5);
      else if (special === "range") baseModuleGeometry = new THREE.BoxGeometry(0.28, 0.06, 0.12);
      else if (special === "rapid") baseModuleGeometry = new THREE.BoxGeometry(0.23, 0.05, 0.085);
      else if (special === "aoe") baseModuleGeometry = new THREE.DodecahedronGeometry(0.12, 0);
      else if (special === "root") baseModuleGeometry = new THREE.ConeGeometry(0.1, 0.23, 5);
      else if (special === "break") baseModuleGeometry = new THREE.BoxGeometry(0.18, 0.18, 0.075);
      else if (special === "chain") baseModuleGeometry = new THREE.SphereGeometry(0.095, 8, 8);
      else if (special === "pierce") baseModuleGeometry = new THREE.ConeGeometry(0.09, 0.28, 4);
      else if (special === "execute") baseModuleGeometry = new THREE.BoxGeometry(0.09, 0.24, 0.085);
      else if (special === "ultimate") baseModuleGeometry = new THREE.OctahedronGeometry(0.15, 1);
      else baseModuleGeometry = new THREE.TorusGeometry(0.135, 0.024, 5, 24);
      const baseModules = new THREE.InstancedMesh(baseModuleGeometry, accent, 4);
      const baseDummy = new THREE.Object3D();
      for (let i = 0; i < 4; i++) {
        const angle = Math.PI / 4 + i * Math.PI / 2;
        baseDummy.position.set(Math.cos(angle) * 0.73, 0.205, Math.sin(angle) * 0.73);
        baseDummy.rotation.set(special === "high" ? Math.PI / 2 : 0, angle + Math.PI / 2, 0);
        baseDummy.scale.set(1, special === "range" || special === "rapid" ? 1 : 1.12, 1);
        baseDummy.updateMatrix();
        baseModules.setMatrixAt(i, baseDummy.matrix);
      }
      baseModules.instanceMatrix.needsUpdate = true;
      baseModules.castShadow = false;
      baseModules.receiveShadow = true;
      root.add(baseModules);

      // 分層八角底座：深藍承重層、金屬壓邊、淺石平台。
      addCylinder(root, radius, radius + 0.16, 0.2, 0, 0.1, 0, shared.blue, 12);
      addCylinder(root, radius * 0.94, radius * 0.94, 0.075, 0, 0.238, 0, shared.gold, 12);
      addCylinder(root, radius * 0.82, radius * 0.9, 0.15, 0, 0.34, 0, shared.stone, 10);
      addCylinder(root, 0.48, 0.55, 0.5 + levelLift, 0, 0.66 + levelLift / 2, 0, shared.ivory, 10);
      addCylinder(root, 0.55, 0.55, 0.075, 0, 0.93 + levelLift, 0, shared.blue, 12);
      addCylinder(root, 0.51, 0.51, 0.035, 0, 0.982 + levelLift, 0, accent, 12);

      const lowerTrim = new THREE.Mesh(new THREE.TorusGeometry(0.61, 0.035, 8, 40), shared.gold);
      lowerTrim.rotation.x = Math.PI / 2;
      lowerTrim.position.y = 0.28;
      root.add(lowerTrim);
      const upperTrim = new THREE.Mesh(new THREE.TorusGeometry(0.53, 0.035, 8, 40), accent);
      upperTrim.rotation.x = Math.PI / 2;
      upperTrim.position.y = 0.91 + levelLift;
      root.add(upperTrim);

      // 四角立柱與頂框把角色展示位包成真正的防禦塔建築；保留中央輪廓，不遮住既有角色 Sprite。
      const frameCorners = [[-0.82, -0.78], [0.82, -0.78], [-0.82, 0.78], [0.82, 0.78]];
      for (const [x, z] of frameCorners) {
        addBox(root, 0.14, 1.62 + levelLift * 0.35, 0.14, x, 1.68 + levelLift * 0.18, z, shared.blue);
        addBox(root, 0.2, 0.09, 0.2, x, 1.02 + levelLift * 0.18, z, shared.gold);
        addBox(root, 0.19, 0.075, 0.19, x, 2.47 + levelLift * 0.18, z, shared.brightGold);
        addBox(root, 0.19, 0.11, 0.19, x, 2.58 + levelLift * 0.18, z, accent);
      }
      // 頂部四向橫樑與屋簷，讓低角度環視能看到建築的厚度。
      for (const sign of [-1, 1]) {
        addBox(root, 1.72, 0.12, 0.14, 0, 2.56 + levelLift * 0.18, sign * 0.78, shared.blue);
        addBox(root, 0.14, 0.12, 1.72, sign * 0.82, 2.56 + levelLift * 0.18, 0, shared.blue);
        addBox(root, 1.82, 0.055, 0.2, 0, 2.64 + levelLift * 0.18, sign * 0.78, shared.gold);
        addBox(root, 0.2, 0.055, 1.82, sign * 0.82, 2.64 + levelLift * 0.18, 0, shared.gold);
      }
      // 背側冠飾與塔種能量徽記，從斜角仍能辨認各塔的屬性。
      const crest = new THREE.Group();
      crest.position.set(0, 2.78 + levelLift * 0.18, -0.82);
      const crestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.09), shared.blue);
      crest.add(crestPlate);
      const crestEdge = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 6, 24), shared.brightGold);
      crestEdge.position.z = 0.06;
      crest.add(crestEdge);
      const crestGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 1), accent);
      crestGem.position.z = 0.12;
      crest.add(crestGem);
      root.add(crest);
      gems.push(crestGem);

      // 塔種專屬冠飾：把元素屬性變成可從遠處辨認的上半部輪廓，不遮住角色 Sprite。
      const apexY = 3.02 + levelLift * 0.2;
      const addCrownGem = (x: number, y: number, z: number, size: number, material: any = accent) => {
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(size, 1), material);
        gem.position.set(x, y, z);
        gem.castShadow = true;
        root.add(gem);
        gems.push(gem);
        return gem;
      };
      const addCrownSpire = (x: number, z: number, height: number, width: number, material: any = accent) => {
        const spire = new THREE.Mesh(new THREE.ConeGeometry(width, height, 6), material);
        spire.position.set(x, apexY + height * 0.38, z);
        spire.castShadow = true;
        root.add(spire);
        return spire;
      };
      const addCrownBeam = (
        sx: number, sy: number, sz: number,
        x: number, y: number, z: number,
        rotationZ = 0, material: any = shared.gold,
      ) => {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
        beam.position.set(x, y, z);
        beam.rotation.z = rotationZ;
        beam.castShadow = true;
        root.add(beam);
        return beam;
      };

      if (special === "slow") {
        // 寒霜：雙側冰晶尖塔，形成冷冽的冠角。
        addCrownSpire(-0.48, -0.86, 0.62, 0.13);
        addCrownSpire(0.48, -0.86, 0.62, 0.13);
        addCrownBeam(0.82, 0.075, 0.1, 0, apexY + 0.28, -0.86, 0, shared.brightGold);
        addCrownGem(0, apexY + 0.43, -0.86, 0.12);
      } else if (special === "burn") {
        // 赤焰：三段火舌向上竄升，中央最高，外側略向外張。
        const flameHeights = [0.42, 0.68, 0.42];
        for (let i = 0; i < 3; i++) {
          const x = (i - 1) * 0.27;
          const flame = addCrownSpire(x, -0.88, flameHeights[i], i === 1 ? 0.15 : 0.11);
          flame.rotation.z = (i - 1) * -0.18;
        }
        addCrownGem(0, apexY + 0.58, -0.88, 0.09, shared.brightGold);
      } else if (special === "range") {
        // 潮歌：望遠鏡式觀測鏡，長桿與透鏡突出射程意象。
        addCrownBeam(0.11, 0.62, 0.11, 0.48, apexY + 0.2, -0.84, 0, shared.blue);
        const lens = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.035, 8, 28), shared.brightGold);
        lens.position.set(0.48, apexY + 0.52, -0.84);
        root.add(lens);
        rings.push(lens);
        const lensCore = new THREE.Mesh(new THREE.CircleGeometry(0.145, 20), accent);
        lensCore.position.set(0.48, apexY + 0.52, -0.79);
        root.add(lensCore);
        addCrownGem(0.48, apexY + 0.52, -0.72, 0.075, shared.brightGold);
      } else if (special === "rapid") {
        // 疾羽：羽片扇冠，輪廓向兩側展開。
        for (let i = 0; i < 5; i++) {
          const offset = i - 2;
          const feather = addCrownBeam(
            0.105, 0.56 - Math.abs(offset) * 0.09, 0.075,
            offset * 0.17, apexY + 0.22 + (2 - Math.abs(offset)) * 0.055, -0.86,
            offset * -0.16, accent,
          );
          feather.rotation.x = offset * 0.08;
        }
        addCrownGem(0, apexY + 0.5, -0.86, 0.1, shared.brightGold);
      } else if (special === "aoe") {
        // 花繚：六瓣環冠，中心晶體代表擴散核心。
        for (let i = 0; i < 6; i++) {
          const angle = (i * Math.PI) / 3;
          const petal = addCrownGem(
            Math.cos(angle) * 0.3,
            apexY + 0.2,
            -0.86 + Math.sin(angle) * 0.3,
            0.13,
          );
          petal.scale.set(0.78, 1.45, 0.72);
          petal.rotation.z = Math.cos(angle) * 0.28;
        }
        addCrownGem(0, apexY + 0.3, -0.86, 0.14, shared.brightGold);
      } else if (special === "root") {
        // 縛影：枝杈向外生長，像古樹根冠。
        for (const side of [-1, 1]) {
          const branch = addCrownBeam(0.075, 0.62, 0.075, side * 0.34, apexY + 0.2, -0.86, side * -0.46, shared.blue);
          branch.scale.set(1, 1, 1);
          const leaf = addCrownGem(side * 0.52, apexY + 0.47, -0.86, 0.12);
          leaf.scale.set(0.78, 1.45, 0.72);
        }
        addCrownGem(0, apexY + 0.12, -0.86, 0.13, shared.brightGold);
      } else if (special === "break") {
        // 聖輝：盾形徽冠，將破盾定位做成穩重、對稱的輪廓。
        addCrownBeam(0.48, 0.48, 0.09, 0, apexY + 0.19, -0.86, 0, shared.blue);
        addCrownBeam(0.34, 0.34, 0.055, 0, apexY + 0.19, -0.8, 0, accent);
        addCrownBeam(0.07, 0.54, 0.07, 0, apexY + 0.2, -0.74, 0, shared.brightGold);
        addCrownGem(0, apexY + 0.53, -0.86, 0.11, shared.brightGold);
      } else if (special === "chain") {
        // 璃鏈：分岔導電桿和節點，暗示能量會向多目標跳躍。
        addCrownBeam(0.075, 0.58, 0.075, 0, apexY + 0.19, -0.86, 0, shared.gold);
        for (const side of [-1, 1]) {
          addCrownBeam(0.065, 0.4, 0.065, side * 0.22, apexY + 0.36, -0.86, side * -0.52, accent);
          const node = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 8), shared.brightGold);
          node.position.set(side * 0.36, apexY + 0.51, -0.86);
          root.add(node);
          gems.push(node);
        }
        addCrownGem(0, apexY + 0.52, -0.86, 0.1);
      } else if (special === "pierce") {
        // 霞貫：筆直長槍冠，突出直線穿透的方向感。
        addCrownSpire(0, -0.86, 0.86, 0.095, shared.brightGold);
        addCrownBeam(0.48, 0.08, 0.08, 0, apexY + 0.08, -0.86, 0, shared.blue);
        addCrownGem(0, apexY + 0.62, -0.86, 0.09);
      } else if (special === "execute") {
        // 背光：交錯雙刃，呈現處決印記。
        addCrownBeam(0.11, 0.72, 0.07, -0.15, apexY + 0.2, -0.86, -0.42, accent);
        addCrownBeam(0.11, 0.72, 0.07, 0.15, apexY + 0.2, -0.86, 0.42, shared.brightGold);
        addCrownGem(0, apexY + 0.18, -0.78, 0.13);
      } else if (special === "ultimate") {
        // 究極：光環包覆核心，兩側高階晶體形成冠冕。
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 8, 40), shared.brightGold);
        halo.position.set(0, apexY + 0.28, -0.9);
        root.add(halo);
        rings.push(halo);
        for (const side of [-1, 1]) {
          addCrownGem(side * 0.42, apexY + 0.2, -0.86, 0.17);
        }
        addCrownGem(0, apexY + 0.28, -0.82, 0.22, shared.chargeCrystal);
      } else {
        // 銀月：月環托起中央星晶，作為基礎高傷塔的識別冠飾。
        const moonRing = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.035, 8, 36), shared.brightGold);
        moonRing.position.set(0, apexY + 0.16, -0.9);
        root.add(moonRing);
        rings.push(moonRing);
        addCrownGem(0, apexY + 0.16, -0.82, 0.2);
        addCrownGem(-0.34, apexY - 0.02, -0.86, 0.085, shared.brightGold);
        addCrownGem(0.34, apexY - 0.02, -0.86, 0.085, shared.brightGold);
      }

      // 四根角柱托住角色展示位，頂端以各塔專屬色的水晶標示屬性。
      for (let i = 0; i < 4; i++) {
        const angle = Math.PI / 4 + (i * Math.PI) / 2;
        const x = Math.cos(angle) * 0.47;
        const z = Math.sin(angle) * 0.47;
        addCylinder(root, 0.065, 0.085, 0.52 + levelLift, x, 0.54 + levelLift / 2, z, shared.blue, 8);
        addCylinder(root, 0.09, 0.09, 0.055, x, 0.82 + levelLift, z, shared.brightGold, 8);
        const crystal = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.105 + Math.min(0.045, (level - 1) * 0.006), 1),
          accent,
        );
        crystal.position.set(x, 0.91 + levelLift, z);
        crystal.castShadow = true;
        root.add(crystal);
        gems.push(crystal);
      }

      // 不同塔種使用不同的底座紋章；不改角色 Sprite 或戰鬥判定。
      const motifY = 0.47 + levelLift;
      if (special === "slow") {
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          const shard = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 5), accent);
          shard.position.set(Math.cos(a) * 0.31, motifY + 0.08, Math.sin(a) * 0.31);
          shard.rotation.z = Math.cos(a) * -0.18;
          shard.castShadow = true;
          root.add(shard);
        }
      } else if (special === "burn") {
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          const flame = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.34, 6), accent);
          flame.position.set(Math.cos(a) * 0.32, motifY + 0.1, Math.sin(a) * 0.32);
          flame.rotation.z = Math.cos(a) * -0.28;
          root.add(flame);
        }
      } else if (special === "range") {
        const sightRing = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.035, 8, 36), accent);
        sightRing.rotation.x = Math.PI / 2;
        sightRing.position.y = motifY + 0.06;
        root.add(sightRing);
        addCylinder(root, 0.045, 0.065, 0.36, 0, motifY + 0.19, -0.28, shared.gold, 8);
      } else if (special === "rapid") {
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          const fin = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.26, 0.32), accent);
          fin.position.set(Math.cos(a) * 0.34, motifY + 0.08, Math.sin(a) * 0.34);
          fin.rotation.y = a;
          root.add(fin);
        }
      } else if (special === "aoe") {
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          const petal = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), accent);
          petal.position.set(Math.cos(a) * 0.35, motifY + 0.06, Math.sin(a) * 0.35);
          petal.scale.set(0.72, 1.35, 0.72);
          root.add(petal);
        }
      } else if (special === "root") {
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          const thorn = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.36, 5), accent);
          thorn.position.set(Math.cos(a) * 0.37, motifY + 0.08, Math.sin(a) * 0.37);
          thorn.rotation.z = Math.cos(a) * -0.48;
          thorn.rotation.x = Math.sin(a) * 0.48;
          root.add(thorn);
        }
      } else if (special === "break") {
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          const shield = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, 0.065), accent);
          shield.position.set(Math.cos(a) * 0.37, motifY + 0.07, Math.sin(a) * 0.37);
          shield.rotation.y = -a;
          root.add(shield);
        }
      } else if (special === "chain") {
        const conductorRing = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.025, 6, 36), accent);
        conductorRing.rotation.x = Math.PI / 2;
        conductorRing.position.y = motifY + 0.08;
        root.add(conductorRing);
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          const node = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 8), accent);
          node.position.set(Math.cos(a) * 0.38, motifY + 0.08, Math.sin(a) * 0.38);
          root.add(node);
        }
      } else if (special === "pierce") {
        const spear = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.48, 6), accent);
        spear.rotation.x = Math.PI / 2;
        spear.position.set(0, motifY + 0.08, 0.34);
        root.add(spear);
        addBox(root, 0.1, 0.12, 0.55, 0, motifY, 0.06, shared.gold);
      } else if (special === "execute") {
        for (const side of [-1, 1]) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.42), accent);
          blade.position.set(side * 0.25, motifY + 0.08, 0);
          blade.rotation.z = side * -0.32;
          root.add(blade);
        }
      } else if (special === "ultimate") {
        for (const side of [-1, 1]) {
          const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 1), accent);
          crystal.position.set(side * 0.34, motifY + 0.1, 0);
          crystal.rotation.z = side * 0.42;
          crystal.scale.set(0.8, 1.55, 0.8);
          root.add(crystal);
          gems.push(crystal);
        }
      } else {
        const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.17, 1), accent);
        crown.position.set(0, motifY + 0.1, 0);
        crown.scale.set(0.8, 1.35, 0.8);
        root.add(crown);
        gems.push(crown);
      }

      // 中高階塔增加旋轉能量環；高階塔再加第二層，升級差異在遠距離也看得出來。
      if (level >= 3) {
        const tierRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.76, 0.026, 6, 48),
          accent,
        );
        tierRing.rotation.x = Math.PI / 2;
        tierRing.position.y = 0.43;
        root.add(tierRing);
        rings.push(tierRing);
      }
      if (level >= 6) {
        const upperTierRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.58, 0.022, 6, 48),
          shared.brightGold,
        );
        upperTierRing.rotation.x = Math.PI / 2;
        upperTierRing.position.y = 1.08 + levelLift;
        root.add(upperTierRing);
        rings.push(upperTierRing);
      }

      // 升級刻度：每升一級增加一枚金色徽記，最高顯示七枚。
      const markCount = Math.min(7, level - 1);
      for (let i = 0; i < markCount; i++) {
        const angle = (i / Math.max(1, markCount)) * Math.PI * 2;
        const mark = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), shared.brightGold);
        mark.position.set(Math.cos(angle) * 0.72, 0.26, Math.sin(angle) * 0.72);
        root.add(mark);
      }

      buildingRoot.add(root);
    };

    const rebuildTerrain = (data: Terrain3DSnapshot) => {
      refreshBlackMistRevealMask(data.placed, data.mapMode === "expand");
      clearGroup(terrainRoot);
      terrainCellHeights.clear();
      terrainPickMeshes.length = 0;
      blackMistEntries.length = 0;
      blackMistMesh = null;
      blackMistCloudEntries.length = 0;
      blackMistCloudMesh = null;
      waterRippleMesh = null;
      waterRippleEntries.length = 0;
      waterGlintMesh = null;
      waterGlintEntries.length = 0;
      fireflyMesh = null;
      fireflyEntries.length = 0;
      blackMistVeilMesh = null;
      blackMistVeilEntries.length = 0;
      landmarkLights.length = 0;
      // 地形按 2×2 地塊切成可視區塊；鏡頭外的遠端地塊可整批被 frustum culling 跳過。
      const terrainChunkSize = TILE * 2;
      const terrainChunks = new Map<string, { byHeight: { x: number; z: number; h: number }[][] }>();
      const tileCells = new Map<string, { x: number; z: number; h: number }>();

      const addCell = (gx: number, gy: number) => {
        const key = gx + "," + gy;
        if (tileCells.has(key)) return;
        const blocked = data.blocked.has(key);
        let h = data.heights[gy * COLS + gx] ?? 0;
        if (data.mapMode === "expand" && !data.placed.length && blocked && h === 0) h = 1;
        // 擴張模式 blocked=false 是怪物道路，必須保持平地；完整關卡則依 heights 保留可建造高地。
        if (data.mapMode === "expand" && !blocked) h = 0;
        h = Math.max(0, Math.min(3, h | 0));
        const cell = { x: gx + 0.5, z: gy + 0.5, h };
        tileCells.set(key, cell);
        terrainCellHeights.set(key, h);
        const chunkX = Math.floor(gx / terrainChunkSize);
        const chunkY = Math.floor(gy / terrainChunkSize);
        const chunkKey = chunkX + "," + chunkY;
        let chunk = terrainChunks.get(chunkKey);
        if (!chunk) {
          chunk = { byHeight: [[], [], [], []] };
          terrainChunks.set(chunkKey, chunk);
        }
        chunk.byHeight[h].push(cell);
      };

      if (data.mapMode === "expand" && data.placed.length) {
        for (const tile of data.placed) {
          for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) {
            addCell(tile.tc * TILE + c, tile.tr * TILE + r);
          }
        }
      } else {
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) addCell(c, r);
      }

      // 依目前真正已鋪設的地塊計算海域中心與尺寸；擴張時海岸同步外推，不把 200×200 空棋盤當成島嶼。
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const cell of tileCells.values()) {
        minX = Math.min(minX, cell.x - 0.5);
        minZ = Math.min(minZ, cell.z - 0.5);
        maxX = Math.max(maxX, cell.x + 0.5);
        maxZ = Math.max(maxZ, cell.z + 0.5);
      }
      const mapCenterX = Number.isFinite(minX) ? (minX + maxX) / 2 : COLS / 2;
      const mapCenterZ = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : ROWS / 2;
      const mapWidth = Number.isFinite(minX) ? Math.max(1, maxX - minX) : TILE;
      const mapDepth = Number.isFinite(minZ) ? Math.max(1, maxZ - minZ) : TILE;

      // 以地塊外緣、海岸距離與低頻座標場分出五種區域，整張地圖保持固定且可重現。
      const edgeCellKeys = new Set<string>();
      const coastBandKeys = new Set<string>();
      const biomeDirections = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (const cell of tileCells.values()) {
        const gx = Math.floor(cell.x);
        const gy = Math.floor(cell.z);
        const key = gx + "," + gy;
        if (biomeDirections.some(([dc, dr]) => !tileCells.has((gx + dc) + "," + (gy + dr)))) {
          edgeCellKeys.add(key);
          coastBandKeys.add(key);
        }
      }
      for (const key of edgeCellKeys) {
        const [gx, gy] = key.split(",").map(Number);
        for (const [dc, dr] of biomeDirections) {
          const neighborKey = (gx + dc) + "," + (gy + dr);
          if (tileCells.has(neighborKey)) coastBandKeys.add(neighborKey);
        }
      }
      const terrainRegionCache = new Map<string, string>();
      const terrainRegion = (cell: { x: number; z: number; h: number }) => {
        const key = Math.floor(cell.x) + "," + Math.floor(cell.z);
        const cached = terrainRegionCache.get(key);
        if (cached) return cached;
        let region = "meadow";
        if (cell.h === 0 && data.mapMode === "expand" && !data.blocked.has(key)) {
          region = "road";
        } else if (cell.h > 0 && coastBandKeys.has(key)) {
          region = "coast";
        } else {
          const nx = (cell.x - mapCenterX) / mapWidth;
          const nz = (cell.z - mapCenterZ) / mapDepth;
          const mossField =
            Math.sin(nx * 13.1 + nz * 5.3 + 0.7) * 0.5 +
            Math.cos(nz * 12.4 - nx * 4.8) * 0.5;
          const ridgeField =
            Math.sin(nx * 8.2 - nz * 12.6 + 1.2) * 0.5 +
            Math.cos((nx + nz) * 10.5) * 0.5;
          const relicField =
            Math.sin(nx * 10.6 + nz * 9.4 + 2.2) * 0.5 +
            Math.cos(nx * 7.1 - nz * 13.7) * 0.5;
          if (cell.h >= 2 && relicField > 0.48) region = "ancient";
          else if (cell.h >= 2 && ridgeField > -0.05) region = "limestone";
          else if (cell.h >= 1 && mossField > -0.2) region = "moss";
        }
        terrainRegionCache.set(key, region);
        return region;
      };
      const protectedBuildings = data.towers.map((tower) => ({
        x: tower.x / CELL,
        z: tower.y / CELL,
        radius: tower.sanctuary ? 4.4 : 1.18,
      }));

      // 每格岩面依區域加入微色偏：海岸偏沙金、苔地偏冷綠、石灰岩偏暖白、遺跡偏灰青。
      const regionTint: Record<string, [number, number, number]> = {
        road: [1, 1, 1],
        coast: [1.055, 1.015, 0.9],
        moss: [0.9, 1.065, 0.89],
        limestone: [1.075, 1.035, 0.94],
        ancient: [0.94, 0.96, 0.91],
        meadow: [0.985, 1.0, 0.96],
      };

      // 每格岩面保留些微色差，讓平台不再像單色網格。
      for (const chunk of terrainChunks.values()) {
        for (let h = 0; h <= 3; h++) {
          const list = chunk.byHeight[h];
          if (!list.length) continue;
          const top = groundTop(h);
          const mesh = new THREE.InstancedMesh(
            terrainGeometries[h],
            shared.terrain[h],
            list.length,
          );
          mesh.userData.sharedGeometry = true;
          const matrix = new THREE.Matrix4();
          const tint = new THREE.Color();
          for (let i = 0; i < list.length; i++) {
            const cell = list[i];
            const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
            const shade = 0.92 + seed * 0.1;
            const palette = regionTint[terrainRegion(cell)] ?? regionTint.meadow;
            matrix.makeTranslation(cell.x, top / 2, cell.z);
            mesh.setMatrixAt(i, matrix);
            tint.setRGB(shade * palette[0], shade * palette[1], shade * palette[2]);
            mesh.setColorAt(i, tint);
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.castShadow = h > 0;
          mesh.receiveShadow = true;
          mesh.computeBoundingSphere();
          mesh.frustumCulled = true;
          // InstancedMesh 的 instanceId 與 list 索引一致，直接保存對應的世界格座標。
          mesh.userData.pickCells = list.map((cell) => ({
            gx: Math.floor(cell.x),
            gy: Math.floor(cell.z),
            height: cell.h,
          }));
          terrainPickMeshes.push(mesh);
          terrainRoot.add(mesh);
        }
      }

      // 生態區交界以少量貼地石縫與植被色階銜接，避免地貌像硬切換色塊。
      const biomeSeamCells: { x: number; z: number; y: number; rot: number; tint: string; scale: number }[] = [];
      const seamDirections = [
        { dc: 1, dr: 0, rot: Math.PI / 2 },
        { dc: 0, dr: 1, rot: 0 },
      ];
      const seamTint = (a: string, b: string) => {
        const regions = a + "|" + b;
        if (regions.includes("coast")) return "#cdbb93";
        if (regions.includes("moss")) return "#8ba17c";
        if (regions.includes("limestone")) return "#c8c1a8";
        if (regions.includes("ancient")) return "#9da99b";
        return "#9aab9b";
      };
      for (const cell of tileCells.values()) {
        if (biomeSeamCells.length >= 520) break;
        const gx = Math.floor(cell.x);
        const gy = Math.floor(cell.z);
        const region = terrainRegion(cell);
        if (region === "road") continue;
        for (const direction of seamDirections) {
          const neighbor = tileCells.get((gx + direction.dc) + "," + (gy + direction.dr));
          if (!neighbor || neighbor.h !== cell.h) continue;
          const nextRegion = terrainRegion(neighbor);
          if (nextRegion === region || nextRegion === "road") continue;
          const x = cell.x + direction.dc * 0.5;
          const z = cell.z + direction.dr * 0.5;
          if (protectedBuildings.some((building) => Math.hypot(x - building.x, z - building.z) < building.radius + 0.38)) continue;
          const seed = Math.abs(Math.sin(cell.x * 81.7 + cell.z * 47.3 + direction.dc * 19.1) * 29171.7) % 1;
          if (seed < 0.52) continue;
          biomeSeamCells.push({
            x: x + (seed - 0.5) * 0.08,
            z: z + (0.5 - seed) * 0.08,
            y: groundTop(cell.h) + 0.012,
            rot: direction.rot,
            tint: seamTint(region, nextRegion),
            scale: 0.52 + seed * 0.43,
          });
          if (biomeSeamCells.length >= 520) break;
        }
      }
      if (biomeSeamCells.length) {
        const seams = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.72, 0.012, 0.034),
          shared.biomeSeam,
          biomeSeamCells.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < biomeSeamCells.length; i++) {
          const seam = biomeSeamCells[i];
          dummy.position.set(seam.x, seam.y, seam.z);
          dummy.rotation.set(0, seam.rot, 0);
          dummy.scale.set(seam.scale, 1, 0.78 + seam.scale * 0.18);
          dummy.updateMatrix();
          seams.setMatrixAt(i, dummy.matrix);
          tint.set(seam.tint);
          seams.setColorAt(i, tint);
        }
        seams.instanceMatrix.needsUpdate = true;
        if (seams.instanceColor) seams.instanceColor.needsUpdate = true;
        seams.castShadow = false;
        seams.receiveShadow = false;
        terrainRoot.add(seams);
      }

      // 擴張地圖的道路格保持原有高度與碰撞資料，只在表面加石板鋪面。
      // 每格一片低矮石板，靠色差與細縫建立行進方向；道路外緣以窄石沿收邊。
      if (data.mapMode === "expand") {
        const roadCells = Array.from(tileCells.values()).filter((cell) =>
          !data.blocked.has(Math.floor(cell.x) + "," + Math.floor(cell.z)),
        );
        if (roadCells.length) {
          const pavers = new THREE.InstancedMesh(
            new THREE.BoxGeometry(0.92, 0.026, 0.92),
            shared.roadPaver,
            roadCells.length,
          );
          const dummy = new THREE.Object3D();
          const tint = new THREE.Color();
          for (let i = 0; i < roadCells.length; i++) {
            const cell = roadCells[i];
            const seed = Math.abs(Math.sin(cell.x * 53.7 + cell.z * 91.3) * 27183.41) % 1;
            dummy.position.set(cell.x, groundTop(0) + 0.014, cell.z);
            dummy.rotation.y = Math.floor(seed * 4) * (Math.PI / 2);
            dummy.scale.set(0.96 + seed * 0.045, 1, 0.95 + ((seed * 3.71) % 1) * 0.045);
            dummy.updateMatrix();
            pavers.setMatrixAt(i, dummy.matrix);
            tint.set(seed > 0.78 ? "#82949a" : seed > 0.42 ? "#667d88" : "#536b78");
            pavers.setColorAt(i, tint);
          }
          pavers.instanceMatrix.needsUpdate = true;
          if (pavers.instanceColor) pavers.instanceColor.needsUpdate = true;
          pavers.castShadow = false;
          pavers.receiveShadow = true;
          terrainRoot.add(pavers);

          // 使用少量嵌入式磨痕打破每片石板的制式感；固定種子、單一 InstancedMesh，上限 240。
          const wornPaverCells = roadCells.filter((cell) => {
            const seed = Math.abs(Math.sin(cell.x * 83.7 + cell.z * 47.1) * 21731.91) % 1;
            return seed > 0.89;
          }).slice(0, 240);
          if (wornPaverCells.length) {
            const roadWear = new THREE.InstancedMesh(
              new THREE.BoxGeometry(0.22, 0.009, 0.018),
              shared.roadWear,
              wornPaverCells.length,
            );
            const wearDummy = new THREE.Object3D();
            const wearTint = new THREE.Color();
            for (let i = 0; i < wornPaverCells.length; i++) {
              const cell = wornPaverCells[i];
              const seed = Math.abs(Math.sin(cell.x * 83.7 + cell.z * 47.1) * 21731.91) % 1;
              wearDummy.position.set(
                cell.x + (seed - 0.5) * 0.34,
                groundTop(0) + 0.031,
                cell.z + (Math.abs(Math.sin(seed * 41.3)) - 0.5) * 0.34,
              );
              wearDummy.rotation.y = Math.floor(seed * 4) * (Math.PI / 2) + (seed - 0.5) * 0.16;
              wearDummy.scale.set(0.58 + seed * 0.72, 1, 0.72 + seed * 0.5);
              wearDummy.updateMatrix();
              roadWear.setMatrixAt(i, wearDummy.matrix);
              wearTint.set(seed > 0.955 ? "#a8aa93" : "#263e49");
              roadWear.setColorAt(i, wearTint);
            }
            roadWear.instanceMatrix.needsUpdate = true;
            if (roadWear.instanceColor) roadWear.instanceColor.needsUpdate = true;
            roadWear.castShadow = false;
            roadWear.receiveShadow = false;
            terrainRoot.add(roadWear);
          }

          const roadEdges: { x: number; z: number; rot: number; shade: string }[] = [];
          const edgeDirs = [
            { dc: 0, dr: -1, dx: 0, dz: -0.46, rot: 0 },
            { dc: 1, dr: 0, dx: 0.46, dz: 0, rot: Math.PI / 2 },
            { dc: 0, dr: 1, dx: 0, dz: 0.46, rot: 0 },
            { dc: -1, dr: 0, dx: -0.46, dz: 0, rot: Math.PI / 2 },
          ];
          for (const cell of roadCells) {
            const gx = Math.floor(cell.x);
            const gy = Math.floor(cell.z);
            for (const dir of edgeDirs) {
              const neighborKey = (gx + dir.dc) + "," + (gy + dir.dr);
              const neighbor = tileCells.get(neighborKey);
              if (!neighbor || !data.blocked.has(neighborKey)) continue;
              const seed = Math.abs(Math.sin(cell.x * 37.1 + cell.z * 61.9 + dir.rot * 11) * 19371.7) % 1;
              roadEdges.push({
                x: cell.x + dir.dx,
                z: cell.z + dir.dz,
                rot: dir.rot,
                shade: seed > 0.55 ? "#9aab9e" : "#748b8d",
              });
            }
          }
          const roadJunctions = roadCells.filter((cell) => {
            const gx = Math.floor(cell.x);
            const gy = Math.floor(cell.z);
            const connected = [
              tileCells.has(gx + "," + (gy - 1)) && !data.blocked.has(gx + "," + (gy - 1)),
              tileCells.has((gx + 1) + "," + gy) && !data.blocked.has((gx + 1) + "," + gy),
              tileCells.has(gx + "," + (gy + 1)) && !data.blocked.has(gx + "," + (gy + 1)),
              tileCells.has((gx - 1) + "," + gy) && !data.blocked.has((gx - 1) + "," + gy),
            ].filter(Boolean).length;
            return connected >= 3;
          }).slice(0, 120);
          if (roadJunctions.length) {
            const medallionRings = new THREE.InstancedMesh(
              new THREE.TorusGeometry(0.18, 0.016, 5, 24),
              shared.roadMedallion,
              roadJunctions.length,
            );
            const medallionCenters = new THREE.InstancedMesh(
              new THREE.CircleGeometry(0.12, 16),
              shared.terrainInlay,
              roadJunctions.length,
            );
            const marker = new THREE.Object3D();
            for (let i = 0; i < roadJunctions.length; i++) {
              const cell = roadJunctions[i];
              marker.position.set(cell.x, groundTop(0) + 0.036, cell.z);
              marker.rotation.set(Math.PI / 2, 0, 0);
              marker.updateMatrix();
              medallionRings.setMatrixAt(i, marker.matrix);
              marker.position.y = groundTop(0) + 0.029;
              marker.scale.setScalar(0.78);
              marker.updateMatrix();
              medallionCenters.setMatrixAt(i, marker.matrix);
            }
            medallionRings.instanceMatrix.needsUpdate = true;
            medallionCenters.instanceMatrix.needsUpdate = true;
            medallionRings.castShadow = false;
            medallionCenters.castShadow = false;
            terrainRoot.add(medallionRings, medallionCenters);
          }

          // 長直道路加入稀疏導向刻線，分辨主路方向；所有刻線均為單一批次網格。
          const roadGuideCells = roadCells.filter((cell) => {
            const gx = Math.floor(cell.x);
            const gy = Math.floor(cell.z);
            const north = tileCells.has(gx + "," + (gy - 1)) && !data.blocked.has(gx + "," + (gy - 1));
            const east = tileCells.has((gx + 1) + "," + gy) && !data.blocked.has((gx + 1) + "," + gy);
            const south = tileCells.has(gx + "," + (gy + 1)) && !data.blocked.has(gx + "," + (gy + 1));
            const west = tileCells.has((gx - 1) + "," + gy) && !data.blocked.has((gx - 1) + "," + gy);
            const straight = (east && west) || (north && south);
            const seed = Math.abs(Math.sin(cell.x * 29.1 + cell.z * 53.7) * 24681.3) % 1;
            return straight && seed > 0.68;
          }).slice(0, 360);
          if (roadGuideCells.length) {
            const guides = new THREE.InstancedMesh(
              new THREE.BoxGeometry(0.34, 0.012, 0.038),
              shared.roadGuide,
              roadGuideCells.length,
            );
            const guideDummy = new THREE.Object3D();
            const guideTint = new THREE.Color();
            for (let i = 0; i < roadGuideCells.length; i++) {
              const cell = roadGuideCells[i];
              const gx = Math.floor(cell.x);
              const gy = Math.floor(cell.z);
              const vertical =
                tileCells.has(gx + "," + (gy - 1)) && !data.blocked.has(gx + "," + (gy - 1)) &&
                tileCells.has(gx + "," + (gy + 1)) && !data.blocked.has(gx + "," + (gy + 1));
              const seed = Math.abs(Math.sin(cell.x * 29.1 + cell.z * 53.7) * 24681.3) % 1;
              guideDummy.position.set(cell.x, groundTop(0) + 0.034, cell.z);
              guideDummy.rotation.y = vertical ? Math.PI / 2 : 0;
              guideDummy.scale.set(0.82 + seed * 0.3, 1, 1);
              guideDummy.updateMatrix();
              guides.setMatrixAt(i, guideDummy.matrix);
              guideTint.set(seed > 0.84 ? "#d5c59c" : "#aab7ad");
              guides.setColorAt(i, guideTint);
            }
            guides.instanceMatrix.needsUpdate = true;
            if (guides.instanceColor) guides.instanceColor.needsUpdate = true;
            guides.castShadow = false;
            guides.receiveShadow = false;
            terrainRoot.add(guides);
          }

          // 主路偶爾嵌入微型金屬路標，與路口圓章形成一致的魔導道路識別。
          const roadWaymarkCandidates = roadCells.filter((cell) => {
            const seed = Math.abs(Math.sin(cell.x * 67.1 + cell.z * 31.7) * 21871.3) % 1;
            return seed > 0.965;
          });
          const waymarkCount = Math.min(140, roadWaymarkCandidates.length);
          if (waymarkCount > 0) {
            const waymarks = new THREE.InstancedMesh(
              new THREE.OctahedronGeometry(0.034, 0),
              shared.roadMedallion,
              waymarkCount,
            );
            const waymarkDummy = new THREE.Object3D();
            const waymarkTint = new THREE.Color();
            for (let i = 0; i < waymarkCount; i++) {
              const cell = roadWaymarkCandidates[Math.floor((i + 0.5) * roadWaymarkCandidates.length / waymarkCount)];
              const seed = Math.abs(Math.sin(cell.x * 67.1 + cell.z * 31.7) * 21871.3) % 1;
              waymarkDummy.position.set(cell.x, groundTop(0) + 0.052, cell.z);
              waymarkDummy.rotation.set(seed * 0.2, seed * Math.PI * 2, seed * 0.16);
              waymarkDummy.scale.set(1.0 + seed * 0.3, 0.82 + seed * 0.24, 1.0 + seed * 0.3);
              waymarkDummy.updateMatrix();
              waymarks.setMatrixAt(i, waymarkDummy.matrix);
              waymarkTint.set(seed > 0.72 ? "#d8c48f" : "#8fb1a7");
              waymarks.setColorAt(i, waymarkTint);
            }
            waymarks.instanceMatrix.needsUpdate = true;
            if (waymarks.instanceColor) waymarks.instanceColor.needsUpdate = true;
            waymarks.castShadow = false;
            waymarks.receiveShadow = false;
            terrainRoot.add(waymarks);
          }

          // 道路外側的潮汐路燈：只放在道路與高地交界，燈座不侵入路面，也不建立額外即時光源。
          const lampCandidates: { x: number; z: number; y: number; seed: number }[] = [];
          const lampKeys = new Set<string>();
          const lampDirections = [
            { dc: 0, dr: -1, dx: 0, dz: -1 },
            { dc: 1, dr: 0, dx: 1, dz: 0 },
            { dc: 0, dr: 1, dx: 0, dz: 1 },
            { dc: -1, dr: 0, dx: -1, dz: 0 },
          ];
          for (const cell of roadCells) {
            if (lampCandidates.length >= 48) break;
            const gx = Math.floor(cell.x);
            const gy = Math.floor(cell.z);
            for (const direction of lampDirections) {
              const neighborKey = (gx + direction.dc) + "," + (gy + direction.dr);
              const neighbor = tileCells.get(neighborKey);
              if (!neighbor || !data.blocked.has(neighborKey) || neighbor.h <= 0) continue;
              const lampKey = gx + "," + gy + ":" + direction.dc + "," + direction.dr;
              if (lampKeys.has(lampKey)) continue;
              const seed = Math.abs(Math.sin(cell.x * 71.7 + cell.z * 39.1 + direction.dc * 17.3 + direction.dr * 29.1) * 24137.7) % 1;
              if (seed < 0.968) continue;
              // 燈座完全落在道路外側高地，避免底座侵入石板通行面。
              const x = cell.x + direction.dx * 0.68;
              const z = cell.z + direction.dz * 0.68;
              if (protectedBuildings.some((building) => Math.hypot(x - building.x, z - building.z) < building.radius + 0.42)) continue;
              lampKeys.add(lampKey);
              lampCandidates.push({ x, z, y: groundTop(neighbor.h), seed });
              if (lampCandidates.length >= 48) break;
            }
          }
          if (lampCandidates.length) {
            const lampBases = new THREE.InstancedMesh(
              new THREE.CylinderGeometry(0.16, 0.21, 0.13, 8),
              shared.foundationStone,
              lampCandidates.length,
            );
            const lampPosts = new THREE.InstancedMesh(
              new THREE.CylinderGeometry(0.035, 0.055, 0.44, 6),
              shared.foundationGold,
              lampCandidates.length,
            );
            const lampCores = new THREE.InstancedMesh(
              new THREE.OctahedronGeometry(0.105, 1),
              shared.chargeCrystal,
              lampCandidates.length,
            );
            const lampCaps = new THREE.InstancedMesh(
              new THREE.ConeGeometry(0.15, 0.16, 6),
              shared.bridgeTrim,
              lampCandidates.length,
            );
            const lampDummy = new THREE.Object3D();
            for (let i = 0; i < lampCandidates.length; i++) {
              const lamp = lampCandidates[i];
              lampDummy.position.set(lamp.x, lamp.y + 0.075, lamp.z);
              lampDummy.rotation.set(0, lamp.seed * Math.PI * 2, 0);
              lampDummy.scale.setScalar(0.9 + lamp.seed * 0.2);
              lampDummy.updateMatrix();
              lampBases.setMatrixAt(i, lampDummy.matrix);

              lampDummy.position.y = lamp.y + 0.34;
              lampDummy.scale.set(1, 1, 1);
              lampDummy.updateMatrix();
              lampPosts.setMatrixAt(i, lampDummy.matrix);

              lampDummy.position.y = lamp.y + 0.63;
              lampDummy.rotation.set(0, lamp.seed * Math.PI * 2, 0);
              lampDummy.scale.setScalar(0.82 + lamp.seed * 0.18);
              lampDummy.updateMatrix();
              lampCores.setMatrixAt(i, lampDummy.matrix);

              lampDummy.position.y = lamp.y + 0.82;
              lampDummy.scale.set(0.9 + lamp.seed * 0.18, 0.82 + lamp.seed * 0.18, 0.9 + lamp.seed * 0.18);
              lampDummy.updateMatrix();
              lampCaps.setMatrixAt(i, lampDummy.matrix);
            }
            for (const mesh of [lampBases, lampPosts, lampCores, lampCaps]) {
              mesh.instanceMatrix.needsUpdate = true;
              mesh.castShadow = false;
              mesh.receiveShadow = false;
              terrainRoot.add(mesh);
            }
          }

          if (roadEdges.length) {
            const curbs = new THREE.InstancedMesh(
              new THREE.BoxGeometry(0.9, 0.052, 0.075),
              shared.roadEdge,
              roadEdges.length,
            );
            for (let i = 0; i < roadEdges.length; i++) {
              const edge = roadEdges[i];
              dummy.position.set(edge.x, groundTop(0) + 0.027, edge.z);
              dummy.rotation.set(0, edge.rot, 0);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();
              curbs.setMatrixAt(i, dummy.matrix);
              tint.set(edge.shade);
              curbs.setColorAt(i, tint);
            }
            curbs.instanceMatrix.needsUpdate = true;
            if (curbs.instanceColor) curbs.instanceColor.needsUpdate = true;
            curbs.castShadow = false;
            curbs.receiveShadow = true;
            terrainRoot.add(curbs);
          }
        }
      }

      // 雙層海面：近岸較淺、外海較深；全部位於地塊底面以下，不介入地形碰撞或道路判定。
      const expandMode = data.mapMode === "expand";
      const seaCenterX = expandMode ? COLS / 2 : mapCenterX;
      const seaCenterZ = expandMode ? ROWS / 2 : mapCenterZ;
      const deepSeaWidth = expandMode ? COLS + 240 : mapWidth + 72;
      const deepSeaDepth = expandMode ? ROWS + 240 : mapDepth + 72;
      const shelfSeaWidth = expandMode ? COLS + 104 : mapWidth + 28;
      const shelfSeaDepth = expandMode ? ROWS + 104 : mapDepth + 28;
      const deepWaterSegmentsX = Math.min(160, Math.max(24, Math.ceil(deepSeaWidth / 4)));
      const deepWaterSegmentsY = Math.min(160, Math.max(24, Math.ceil(deepSeaDepth / 4)));
      const shelfWaterSegmentsX = Math.min(128, Math.max(24, Math.ceil(shelfSeaWidth / 4)));
      const shelfWaterSegmentsY = Math.min(128, Math.max(24, Math.ceil(shelfSeaDepth / 4)));
      const deepWater = new THREE.Mesh(
        new THREE.PlaneGeometry(deepSeaWidth, deepSeaDepth, deepWaterSegmentsX, deepWaterSegmentsY),
        shared.floor,
      );
      deepWater.rotation.x = -Math.PI / 2;
      deepWater.position.set(seaCenterX, -0.34, seaCenterZ);
      deepWater.receiveShadow = false;
      const shelfWater = new THREE.Mesh(
        new THREE.PlaneGeometry(shelfSeaWidth, shelfSeaDepth, shelfWaterSegmentsX, shelfWaterSegmentsY),
        shared.seaShelf,
      );
      shelfWater.rotation.x = -Math.PI / 2;
      shelfWater.position.set(seaCenterX, -0.285, seaCenterZ);
      shelfWater.receiveShadow = false;
      terrainRoot.add(deepWater, shelfWater);

      // 黑霧底層覆蓋整張棋盤，只有已取得地塊的遮罩區域會退霧；其餘海域持續被深淵侵染。
      if (expandMode) {
        const blackMistField = new THREE.Mesh(
          new THREE.PlaneGeometry(blackMistFieldWidth, blackMistFieldDepth),
          shared.blackMistField,
        );
        blackMistField.rotation.x = -Math.PI / 2;
        blackMistField.position.set(COLS / 2, -0.235, ROWS / 2);
        blackMistField.renderOrder = 1;
        blackMistField.frustumCulled = false;
        blackMistField.castShadow = false;
        blackMistField.receiveShadow = false;
        terrainRoot.add(blackMistField);

        // 低成本 3D 深淵雲團：沿整個世界與外圍海域疏散分布，置於地表下方，不遮住已解鎖地塊。
        const cloudPositions = 10;
        const cloudMargin = 72;
        for (let row = 0; row < cloudPositions; row++) {
          for (let col = 0; col < cloudPositions; col++) {
            const seed = Math.abs(Math.sin((col + 1) * 127.1 + (row + 3) * 311.7) * 43758.5453) % 1;
            if (seed < 0.2) continue;
            const x = -cloudMargin + ((col + 0.5) / cloudPositions) * (COLS + cloudMargin * 2);
            const z = -cloudMargin + ((row + 0.5) / cloudPositions) * (ROWS + cloudMargin * 2);
            if (tileCells.has(Math.floor(x) + "," + Math.floor(z))) continue;
            const scaleSeed = Math.abs(Math.sin(x * 17.3 + z * 31.7) * 19341.7) % 1;
            blackMistCloudEntries.push({
              x, z,
              phase: seed * 19.3 + scaleSeed * 7.1,
              scaleX: 8 + scaleSeed * 13,
              scaleZ: 7 + seed * 12,
              driftX: (seed - 0.5) * 0.45,
              driftZ: (scaleSeed - 0.5) * 0.45,
            });
          }
        }
        if (blackMistCloudEntries.length) {
          blackMistCloudMesh = new THREE.InstancedMesh(
            new THREE.SphereGeometry(1, 10, 7),
            shared.blackMistCloud,
            blackMistCloudEntries.length,
          );
          blackMistCloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          for (let i = 0; i < blackMistCloudEntries.length; i++) {
            const cloud = blackMistCloudEntries[i];
            blackMistCloudDummy.position.set(cloud.x, -0.145, cloud.z);
            blackMistCloudDummy.scale.set(cloud.scaleX, 0.19, cloud.scaleZ);
            blackMistCloudDummy.rotation.y = cloud.phase;
            blackMistCloudDummy.updateMatrix();
            blackMistCloudMesh.setMatrixAt(i, blackMistCloudDummy.matrix);
          }
          blackMistCloudMesh.instanceMatrix.needsUpdate = true;
          blackMistCloudMesh.frustumCulled = false;
          blackMistCloudMesh.renderOrder = 1;
          blackMistCloudMesh.castShadow = false;
          blackMistCloudMesh.receiveShadow = false;
          terrainRoot.add(blackMistCloudMesh);
        }
      }


      // 海平線外的低矮島礁剪影：固定在地塊包圍盒之外，提供遠景尺度而不佔用地圖格。
      const horizonSites = Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2 + 0.18;
        const directionX = Math.cos(angle);
        const directionZ = Math.sin(angle);
        const seed = Math.abs(Math.sin(i * 19.7 + mapCenterX * 0.31 + mapCenterZ * 0.17) * 28391.7) % 1;
        return {
          // 八方位分別越過對應邊界 9.5 格；對角點同時離開 X／Z 邊界，確保大型地圖也不落在陸地角落。
          x: mapCenterX + (Math.abs(directionX) < 0.35 ? 0 : Math.sign(directionX) * (mapWidth * 0.5 + 9.5)),
          z: mapCenterZ + (Math.abs(directionZ) < 0.35 ? 0 : Math.sign(directionZ) * (mapDepth * 0.5 + 9.5)),
          angle,
          seed,
        };
      });
      if (horizonSites.length) {
        const horizonBases = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(1, 0),
          shared.reefRock,
          horizonSites.length,
        );
        const horizonStacks = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(1, 0),
          shared.cliffFacet,
          horizonSites.length * 2,
        );
        const horizonCaps = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.6, 1, 5),
          shared.ridgePeak,
          horizonSites.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < horizonSites.length; i++) {
          const site = horizonSites[i];
          dummy.position.set(site.x, -0.17, site.z);
          dummy.rotation.set(0.08 * Math.sin(site.angle), site.angle, 0.08 * Math.cos(site.angle));
          dummy.scale.set(1.5 + site.seed * 0.9, 0.38 + site.seed * 0.2, 1.15 + site.seed * 0.7);
          dummy.updateMatrix();
          horizonBases.setMatrixAt(i, dummy.matrix);
          tint.set(site.seed > 0.55 ? "#647d78" : "#4c6c70");
          horizonBases.setColorAt(i, tint);

          for (let stack = 0; stack < 2; stack++) {
            const index = i * 2 + stack;
            const scale = (stack === 0 ? 0.75 : 0.48) + site.seed * (stack === 0 ? 0.45 : 0.32);
            const offset = stack === 0 ? -0.38 : 0.42;
            dummy.position.set(
              site.x + Math.cos(site.angle + stack * 1.9) * offset,
              0.22 + scale * 0.34,
              site.z + Math.sin(site.angle + stack * 1.9) * offset,
            );
            dummy.rotation.set(0.12 * Math.sin(site.angle), site.angle + stack * 0.8, 0.1 * Math.cos(site.angle));
            dummy.scale.set(scale * 0.72, scale * 1.18, scale * 0.78);
            dummy.updateMatrix();
            horizonStacks.setMatrixAt(index, dummy.matrix);
            tint.set(stack === 0 ? "#8b9688" : "#71877f");
            horizonStacks.setColorAt(index, tint);
          }

          dummy.position.set(site.x + Math.cos(site.angle) * 0.1, 0.72 + site.seed * 0.38, site.z - Math.sin(site.angle) * 0.1);
          dummy.rotation.set(0.1, site.angle, -0.08);
          dummy.scale.set(0.72 + site.seed * 0.28, 0.82 + site.seed * 0.35, 0.72 + site.seed * 0.28);
          dummy.updateMatrix();
          horizonCaps.setMatrixAt(i, dummy.matrix);
        }
        for (const mesh of [horizonBases, horizonStacks, horizonCaps]) {
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          terrainRoot.add(mesh);
        }
      }

      terrainRoot.add(deepWater, shelfWater);

      // 外露地塊的岸線：沙色石沿收邊，海面再以稀疏泡沫切出水陸交界。
      // 僅處理已放置地塊的非道路格，並避開現有建築 footprint。
      const coastDirections = [
        { dc: 0, dr: -1, dx: 0, dz: -1, rot: 0 },
        { dc: 1, dr: 0, dx: 1, dz: 0, rot: Math.PI / 2 },
        { dc: 0, dr: 1, dx: 0, dz: 1, rot: 0 },
        { dc: -1, dr: 0, dx: -1, dz: 0, rot: Math.PI / 2 },
      ];
      const coastEdges: { x: number; z: number; h: number; dx: number; dz: number; rot: number; seed: number }[] = [];
      for (const cell of tileCells.values()) {
        const gx = Math.floor(cell.x);
        const gy = Math.floor(cell.z);
        if (!data.blocked.has(gx + "," + gy)) continue;
        const nearBuilding = protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius,
        );
        if (nearBuilding) continue;
        for (const direction of coastDirections) {
          const neighbor = tileCells.get((gx + direction.dc) + "," + (gy + direction.dr));
          if (neighbor) continue;
          const seed = Math.abs(Math.sin(cell.x * 71.3 + cell.z * 43.9 + direction.rot * 13) * 28411.73) % 1;
          coastEdges.push({
            x: cell.x, z: cell.z, h: cell.h,
            dx: direction.dx, dz: direction.dz, rot: direction.rot, seed,
          });
        }
      }
      // 全地圖侵染已由單一霧幕負責；岸線只保留少量局部漂霧，避免逐格建立大量動畫實例。
      if (data.mapMode === "expand" && coastEdges.length) {
        const fogEdges = coastEdges.filter((edge) => edge.seed > 0.12).slice(0, 128);
        if (fogEdges.length) {
          blackMistMesh = new THREE.InstancedMesh(
            new THREE.PlaneGeometry(1, 1),
            shared.blackMist,
            fogEdges.length * 2,
          );
          blackMistMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          const fogTint = new THREE.Color();
          let instance = 0;
          for (const edge of fogEdges) {
            for (let layer = 0; layer < 2; layer++) {
              // 兩層漂霧都維持在海面高度：已開啟地塊的地表／岩壁會遮住霧，不再污染亮地。
              const outward = layer === 0 ? 0.24 : 0.72;
              const tangent = (edge.seed - 0.5) * 0.54 + (layer === 0 ? -0.12 : 0.14);
              const x = edge.x + edge.dx * outward + (edge.dz !== 0 ? tangent : 0);
              const z = edge.z + edge.dz * outward + (edge.dx !== 0 ? tangent : 0);
              const scaleX = layer === 0 ? 1.32 + edge.seed * 0.76 : 1.55 + edge.seed * 1.12;
              const scaleZ = layer === 0 ? 0.96 + edge.seed * 0.42 : 0.98 + edge.seed * 0.58;
              const y = -0.218 + layer * 0.008;
              blackMistEntries.push({
                x, z, y,
                phase: edge.seed * 17.3 + layer * 2.1,
                rot: edge.rot,
                scaleX,
                scaleZ,
                driftX: edge.dx === 0 ? (edge.seed - 0.5) * 0.1 : edge.dx,
                driftZ: edge.dz === 0 ? (0.5 - edge.seed) * 0.1 : edge.dz,
              });
              blackMistDummy.position.set(x, y, z);
              blackMistDummy.rotation.set(-Math.PI / 2, edge.rot, 0);
              blackMistDummy.scale.set(scaleX, scaleZ, 1);
              blackMistDummy.updateMatrix();
              blackMistMesh.setMatrixAt(instance, blackMistDummy.matrix);
              fogTint.set(edge.seed > 0.76 ? "#293149" : edge.seed > 0.42 ? "#1c263d" : "#111b30");
              blackMistMesh.setColorAt(instance, fogTint);
              instance++;
            }
          }
          blackMistMesh.instanceMatrix.needsUpdate = true;
          if (blackMistMesh.instanceColor) blackMistMesh.instanceColor.needsUpdate = true;
          blackMistMesh.frustumCulled = false;
          blackMistMesh.renderOrder = 2;
          blackMistMesh.castShadow = false;
          blackMistMesh.receiveShadow = false;
          terrainRoot.add(blackMistMesh);
        }

        const veilCandidates = coastEdges.filter((edge) => edge.seed > 0.24);
        const veilCount = Math.min(72, veilCandidates.length);
        if (veilCount > 0) {
          blackMistVeilMesh = new THREE.InstancedMesh(
            new THREE.PlaneGeometry(1, 1),
            shared.blackMistVeil,
            veilCount,
          );
          blackMistVeilMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          const veilTint = new THREE.Color();
          for (let i = 0; i < veilCount; i++) {
            const edge = veilCandidates[Math.min(veilCandidates.length - 1, Math.floor((i + 0.5) * veilCandidates.length / veilCount))];
            const scaleX = 2.35 + edge.seed * 2.15;
            const scaleY = 1.15 + edge.seed * 1.3;
            const x = edge.x + edge.dx * 0.46;
            const z = edge.z + edge.dz * 0.46;
            const y = 0.64 + edge.seed * 0.52;
            const phase = edge.seed * 17.1 + i * 0.37;
            blackMistVeilEntries.push({
              x, z, y, phase, rot: edge.rot, scaleX, scaleY,
              driftX: edge.dx, driftZ: edge.dz,
            });
            blackMistVeilDummy.position.set(x, y, z);
            blackMistVeilDummy.rotation.set(0, edge.rot, 0);
            blackMistVeilDummy.scale.set(scaleX, scaleY, 1);
            blackMistVeilDummy.updateMatrix();
            blackMistVeilMesh.setMatrixAt(i, blackMistVeilDummy.matrix);
            veilTint.set(edge.seed > 0.72 ? "#34405b" : "#202b46");
            blackMistVeilMesh.setColorAt(i, veilTint);
          }
          blackMistVeilMesh.instanceMatrix.needsUpdate = true;
          if (blackMistVeilMesh.instanceColor) blackMistVeilMesh.instanceColor.needsUpdate = true;
          blackMistVeilMesh.frustumCulled = false;
          blackMistVeilMesh.renderOrder = 3;
          blackMistVeilMesh.castShadow = false;
          blackMistVeilMesh.receiveShadow = false;
          terrainRoot.add(blackMistVeilMesh);
        }
      }

      if (coastEdges.length) {
        const sand = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.94, 0.032, 0.14),
          shared.shoreSand,
          coastEdges.length,
        );
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < coastEdges.length; i++) {
          const edge = coastEdges[i];
          matrix.makeRotationY(edge.rot);
          matrix.setPosition(
            edge.x + edge.dx * 0.385,
            groundTop(edge.h) + 0.012,
            edge.z + edge.dz * 0.385,
          );
          sand.setMatrixAt(i, matrix);
        }
        sand.instanceMatrix.needsUpdate = true;
        sand.receiveShadow = true;
        terrainRoot.add(sand);

        // 沙沿內側增加潮濕暗沙帶，再用小卵石將草地／岩面與海水柔和銜接。
        const wetEdges = coastEdges.filter((edge) => edge.seed > 0.16);
        if (wetEdges.length) {
          const wetBand = new THREE.InstancedMesh(
            new THREE.BoxGeometry(0.78, 0.012, 0.075),
            shared.tidalSand,
            wetEdges.length,
          );
          const wetDummy = new THREE.Object3D();
          const wetTint = new THREE.Color();
          for (let i = 0; i < wetEdges.length; i++) {
            const edge = wetEdges[i];
            wetDummy.position.set(
              edge.x + edge.dx * 0.255,
              groundTop(edge.h) + 0.024,
              edge.z + edge.dz * 0.255,
            );
            wetDummy.rotation.y = edge.rot;
            wetDummy.scale.set(0.68 + edge.seed * 0.28, 1, 0.82);
            wetDummy.updateMatrix();
            wetBand.setMatrixAt(i, wetDummy.matrix);
            wetTint.set(edge.seed > 0.68 ? "#a4b3a0" : "#718f89");
            wetBand.setColorAt(i, wetTint);
          }
          wetBand.instanceMatrix.needsUpdate = true;
          if (wetBand.instanceColor) wetBand.instanceColor.needsUpdate = true;
          wetBand.castShadow = false;
          wetBand.receiveShadow = false;
          terrainRoot.add(wetBand);
        }

        const pebbleEdges = coastEdges.filter((edge) => edge.seed > 0.68).slice(0, 260);
        if (pebbleEdges.length) {
          const pebbles = new THREE.InstancedMesh(
            new THREE.DodecahedronGeometry(0.052, 0),
            shared.beachPebble,
            pebbleEdges.length,
          );
          const pebbleDummy = new THREE.Object3D();
          const pebbleTint = new THREE.Color();
          for (let i = 0; i < pebbleEdges.length; i++) {
            const edge = pebbleEdges[i];
            const along = (edge.seed - 0.5) * 0.5;
            pebbleDummy.position.set(
              edge.x + edge.dx * (0.64 + edge.seed * 0.06) + (edge.dz !== 0 ? along : 0),
              -0.19,
              edge.z + edge.dz * (0.64 + edge.seed * 0.06) + (edge.dx !== 0 ? along : 0),
            );
            pebbleDummy.rotation.set(edge.seed * 0.4, edge.seed * Math.PI * 2, edge.seed * 0.3);
            pebbleDummy.scale.set(0.8 + edge.seed * 0.6, 0.62 + edge.seed * 0.45, 0.75 + edge.seed * 0.55);
            pebbleDummy.updateMatrix();
            pebbles.setMatrixAt(i, pebbleDummy.matrix);
            pebbleTint.set(edge.seed > 0.85 ? "#c5b89d" : "#738b83");
            pebbles.setColorAt(i, pebbleTint);
          }
          pebbles.instanceMatrix.needsUpdate = true;
          if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
          pebbles.castShadow = false;
          pebbles.receiveShadow = false;
          terrainRoot.add(pebbles);
        }

        // 礁岩與淺海珊瑚沿岸稀疏分布，只是遠景環境物件，不加入建造格或路徑資料。
        const reefEdges = coastEdges.filter((edge) => edge.seed > 0.54);
        if (reefEdges.length) {
          const reefRocks = new THREE.InstancedMesh(
            new THREE.DodecahedronGeometry(0.24, 0),
            shared.reefRock,
            reefEdges.length,
          );
          const coralEdges = reefEdges.filter((edge) => edge.seed > 0.79);
          const reefCorals = coralEdges.length
            ? new THREE.InstancedMesh(
                new THREE.ConeGeometry(0.085, 0.26, 5),
                shared.reefCoral,
                coralEdges.length,
              )
            : null;
          const dummy = new THREE.Object3D();
          const tint = new THREE.Color();
          for (let i = 0; i < reefEdges.length; i++) {
            const edge = reefEdges[i];
            const along = (edge.seed - 0.5) * 0.38;
            dummy.position.set(
              edge.x + edge.dx * (1.32 + edge.seed * 0.2) + (edge.dz !== 0 ? along : 0),
              -0.22,
              edge.z + edge.dz * (1.32 + edge.seed * 0.2) + (edge.dx !== 0 ? along : 0),
            );
            dummy.rotation.set(edge.seed * 0.16, edge.seed * Math.PI * 2, (edge.seed - 0.5) * 0.2);
            dummy.scale.set(0.62 + edge.seed * 0.48, 0.58 + edge.seed * 0.42, 0.62 + edge.seed * 0.38);
            dummy.updateMatrix();
            reefRocks.setMatrixAt(i, dummy.matrix);
            tint.set(edge.seed > 0.78 ? "#718e7b" : "#496c6b");
            reefRocks.setColorAt(i, tint);
          }
          reefRocks.instanceMatrix.needsUpdate = true;
          if (reefRocks.instanceColor) reefRocks.instanceColor.needsUpdate = true;
          reefRocks.castShadow = false;
          reefRocks.receiveShadow = false;
          terrainRoot.add(reefRocks);

          if (reefCorals) {
            for (let i = 0; i < coralEdges.length; i++) {
              const edge = coralEdges[i];
              const along = (edge.seed - 0.5) * 0.3;
              dummy.position.set(
                edge.x + edge.dx * 1.12 + (edge.dz !== 0 ? along : 0),
                -0.105,
                edge.z + edge.dz * 1.12 + (edge.dx !== 0 ? along : 0),
              );
              dummy.rotation.set(0, edge.seed * Math.PI * 2, (edge.seed - 0.5) * 0.28);
              dummy.scale.set(0.78 + edge.seed * 0.2, 0.76 + edge.seed * 0.34, 0.78 + edge.seed * 0.2);
              dummy.updateMatrix();
              reefCorals.setMatrixAt(i, dummy.matrix);
              tint.set(edge.seed > 0.9 ? "#d69b84" : "#a87880");
              reefCorals.setColorAt(i, tint);
            }
            reefCorals.instanceMatrix.needsUpdate = true;
            if (reefCorals.instanceColor) reefCorals.instanceColor.needsUpdate = true;
            reefCorals.castShadow = false;
            reefCorals.receiveShadow = false;
            terrainRoot.add(reefCorals);
          }
        }

        const foamEdges = coastEdges.filter((edge) => edge.seed > 0.38);
        if (foamEdges.length) {
          const foam = new THREE.InstancedMesh(
            new THREE.BoxGeometry(0.42, 0.012, 0.045),
            shared.shoreFoam,
            foamEdges.length,
          );
          for (let i = 0; i < foamEdges.length; i++) {
            const edge = foamEdges[i];
            matrix.makeRotationY(edge.rot);
            matrix.setPosition(
              edge.x + edge.dx * 0.635,
              -0.263,
              edge.z + edge.dz * 0.635,
            );
            foam.setMatrixAt(i, matrix);
          }
          foam.instanceMatrix.needsUpdate = true;
          foam.castShadow = false;
          foam.receiveShadow = false;
          terrainRoot.add(foam);
        }


        // 第二道破碎浪沫落在更外側的淺海，長度與間距不規則，讓岸線呈現兩層潮汐節奏。
        const outerFoamEdges = coastEdges.filter((edge) => edge.seed > 0.24).slice(0, 520);
        if (outerFoamEdges.length) {
          const outerFoam = new THREE.InstancedMesh(
            new THREE.BoxGeometry(0.26, 0.01, 0.026),
            shared.shoreFoam,
            outerFoamEdges.length,
          );
          const foamDummy = new THREE.Object3D();
          for (let i = 0; i < outerFoamEdges.length; i++) {
            const edge = outerFoamEdges[i];
            foamDummy.position.set(
              edge.x + edge.dx * (0.96 + edge.seed * 0.12),
              -0.259 + edge.seed * 0.006,
              edge.z + edge.dz * (0.96 + edge.seed * 0.12),
            );
            foamDummy.rotation.y = edge.rot;
            foamDummy.scale.set(0.65 + edge.seed * 0.7, 1, 0.72 + edge.seed * 0.45);
            foamDummy.updateMatrix();
            outerFoam.setMatrixAt(i, foamDummy.matrix);
          }
          outerFoam.instanceMatrix.needsUpdate = true;
          outerFoam.castShadow = false;
          outerFoam.receiveShadow = false;
          terrainRoot.add(outerFoam);
        }

        // 少量潮汐微光環沿岸緩慢擴散；集中在單一 InstancedMesh，不逐個建立動畫物件。
        const rippleCandidates = coastEdges.filter((edge) => edge.seed > 0.64);
        const rippleCount = Math.min(18, rippleCandidates.length);
        if (rippleCount > 0) {
          waterRippleMesh = new THREE.InstancedMesh(
            new THREE.TorusGeometry(0.2, 0.009, 5, 28),
            shared.waterRipple,
            rippleCount,
          );
          waterRippleMesh.frustumCulled = false;
          for (let i = 0; i < rippleCount; i++) {
            const edge = rippleCandidates[Math.min(
              rippleCandidates.length - 1,
              Math.floor(((i + 0.5) * rippleCandidates.length) / rippleCount),
            )];
            waterRippleEntries.push({
              x: edge.x + edge.dx * 1.22,
              z: edge.z + edge.dz * 1.22,
              phase: edge.seed,
              speed: 0.72 + edge.seed * 0.42,
            });
          }
          terrainRoot.add(waterRippleMesh);
        }

        // 淺海反光碎片隨潮汐緩慢漂移；集中在單一批次，避免逐粒子建立物件。
        const glintCandidates = coastEdges.filter((edge) => edge.seed > 0.3);
        const glintCount = Math.min(64, glintCandidates.length);
        if (glintCount > 0) {
          waterGlintMesh = new THREE.InstancedMesh(
            new THREE.PlaneGeometry(0.42, 0.038),
            shared.waterGlint,
            glintCount,
          );
          waterGlintMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          for (let i = 0; i < glintCount; i++) {
            const edge = glintCandidates[Math.min(glintCandidates.length - 1, Math.floor((i + 0.5) * glintCandidates.length / glintCount))];
            const distance = 1.85 + edge.seed * 3.25;
            const x = edge.x + edge.dx * distance + edge.dz * (edge.seed - 0.5) * 0.9;
            const z = edge.z + edge.dz * distance + edge.dx * (0.5 - edge.seed) * 0.9;
            const phase = edge.seed * 19.7 + i * 0.61;
            const rot = edge.rot + (edge.seed - 0.5) * 0.5;
            const scale = 0.62 + edge.seed * 0.82;
            waterGlintEntries.push({ x, z, phase, rot, scale });
            waterGlintDummy.position.set(x, -0.246, z);
            waterGlintDummy.rotation.set(-Math.PI / 2, rot, 0);
            waterGlintDummy.scale.set(scale, 1, 1);
            waterGlintDummy.updateMatrix();
            waterGlintMesh.setMatrixAt(i, waterGlintDummy.matrix);
          }
          waterGlintMesh.instanceMatrix.needsUpdate = true;
          waterGlintMesh.frustumCulled = false;
          waterGlintMesh.castShadow = false;
          waterGlintMesh.receiveShadow = false;
          terrainRoot.add(waterGlintMesh);
        }

        // 海岸補少量漂流木與岸邊草簇，固定上限避免沿線物件過密。
        const driftwoodEdges = coastEdges.filter((edge) => edge.seed > 0.94).slice(0, 22);
        if (driftwoodEdges.length) {
          const driftwood = new THREE.InstancedMesh(
            new THREE.CylinderGeometry(0.035, 0.055, 0.58, 6),
            shared.driftwood,
            driftwoodEdges.length,
          );
          const dummy = new THREE.Object3D();
          for (let i = 0; i < driftwoodEdges.length; i++) {
            const edge = driftwoodEdges[i];
            const along = (edge.seed - 0.5) * 0.46;
            dummy.position.set(
              edge.x + edge.dx * 1.06 + (edge.dz !== 0 ? along : 0),
              -0.235,
              edge.z + edge.dz * 1.06 + (edge.dx !== 0 ? along : 0),
            );
            dummy.rotation.set(Math.PI / 2 + (edge.seed - 0.5) * 0.18, edge.rot, edge.seed * 0.25);
            dummy.scale.set(0.78 + edge.seed * 0.5, 0.9 + edge.seed * 0.35, 0.78 + edge.seed * 0.3);
            dummy.updateMatrix();
            driftwood.setMatrixAt(i, dummy.matrix);
          }
          driftwood.instanceMatrix.needsUpdate = true;
          driftwood.castShadow = false;
          driftwood.receiveShadow = false;
          terrainRoot.add(driftwood);
        }

        const shoreReedEdges = coastEdges.filter((edge) => edge.seed > 0.86).slice(0, 140);
        if (shoreReedEdges.length) {
          const reeds = new THREE.InstancedMesh(
            new THREE.ConeGeometry(0.045, 0.2, 5),
            shared.coastGrass,
            shoreReedEdges.length * 2,
          );
          const dummy = new THREE.Object3D();
          const tint = new THREE.Color();
          for (let i = 0; i < shoreReedEdges.length; i++) {
            const edge = shoreReedEdges[i];
            for (let blade = 0; blade < 2; blade++) {
              const index = i * 2 + blade;
              const side = blade === 0 ? -1 : 1;
              dummy.position.set(
                edge.x - edge.dx * 0.33 + edge.dz * side * 0.13,
                groundTop(edge.h) + 0.09,
                edge.z - edge.dz * 0.33 + edge.dx * side * 0.13,
              );
              dummy.rotation.set(edge.dz * 0.18, edge.seed * Math.PI * 2 + blade, -edge.dx * 0.18);
              dummy.scale.set(0.78 + edge.seed * 0.32, 0.72 + blade * 0.15, 0.78 + edge.seed * 0.32);
              dummy.updateMatrix();
              reeds.setMatrixAt(index, dummy.matrix);
              tint.set(blade === 0 ? "#a0b78d" : "#6c967d");
              reeds.setColorAt(index, tint);
            }
          }
          reeds.instanceMatrix.needsUpdate = true;
          if (reeds.instanceColor) reeds.instanceColor.needsUpdate = true;
          reeds.castShadow = false;
          reeds.receiveShadow = false;
          terrainRoot.add(reeds);
        }
      }

        // 外海偶爾露出高聳海蝕柱，補足島嶼外輪廓；固定最多 12 組。
        const seaStackEdges = coastEdges.filter((edge) => edge.seed > 0.982).slice(0, 12);
        if (seaStackEdges.length) {
          const seaStacks = new THREE.InstancedMesh(
            new THREE.DodecahedronGeometry(0.34, 0),
            shared.reefRock,
            seaStackEdges.length * 2,
          );
          const dummy = new THREE.Object3D();
          const tint = new THREE.Color();
          for (let i = 0; i < seaStackEdges.length; i++) {
            const edge = seaStackEdges[i];
            const x = edge.x + edge.dx * 1.82;
            const z = edge.z + edge.dz * 1.82;
            dummy.position.set(x, -0.05, z);
            dummy.rotation.set(edge.seed * 0.32, edge.seed * Math.PI * 2, (edge.seed - 0.5) * 0.18);
            dummy.scale.set(1.05, 1.85 + edge.seed * 0.55, 0.92);
            dummy.updateMatrix();
            seaStacks.setMatrixAt(i * 2, dummy.matrix);
            tint.set("#4e6e6d");
            seaStacks.setColorAt(i * 2, tint);

            dummy.position.set(x + edge.dz * 0.22, 0.28, z - edge.dx * 0.22);
            dummy.rotation.set(edge.seed * 0.24, edge.seed * Math.PI * 2 + 0.6, 0.16);
            dummy.scale.set(0.74, 0.92 + edge.seed * 0.32, 0.72);
            dummy.updateMatrix();
            seaStacks.setMatrixAt(i * 2 + 1, dummy.matrix);
            tint.set("#71877c");
            seaStacks.setColorAt(i * 2 + 1, tint);
          }
          seaStacks.instanceMatrix.needsUpdate = true;
          if (seaStacks.instanceColor) seaStacks.instanceColor.needsUpdate = true;
          seaStacks.castShadow = false;
          seaStacks.receiveShadow = false;
          terrainRoot.add(seaStacks);
        }

      // 高地表面散布少量低矮岩屑，破除棋盤格般的單調感，不遮擋道路或建築。
      const rockCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const seed = Math.abs(Math.sin(cell.x * 91.7 + cell.z * 43.3) * 24634.6345) % 1;
        if (seed <= 0.86) return false;
        // 建築與塔座周圍保留空地，岩屑也設上限避免大地圖增加過多 draw workload。
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.7,
        );
      }).slice(0, 1500);
      if (rockCells.length) {
        const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.075, 0), shared.rockDetail, rockCells.length);
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < rockCells.length; i++) {
          const cell = rockCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          dummy.position.set(
            cell.x + (seed - 0.5) * 0.62,
            groundTop(cell.h) + 0.025,
            cell.z + (Math.abs(Math.sin(seed * 83.1)) - 0.5) * 0.62,
          );
          dummy.rotation.set(seed * 0.7, seed * Math.PI * 2, seed * 0.45);
          dummy.scale.setScalar(0.55 + seed * 0.55);
          dummy.updateMatrix();
          rocks.setMatrixAt(i, dummy.matrix);
          tint.set(seed > 0.55 ? "#aab6ae" : "#687d83");
          rocks.setColorAt(i, tint);
        }
        rocks.instanceMatrix.needsUpdate = true;
        if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
        rocks.castShadow = true;
        rocks.receiveShadow = true;
        terrainRoot.add(rocks);
      }

      // 草叢沿草甸與苔地的低頻生態帶聚集；海岸、石灰岩與古遺跡保留較裸露的地貌。
      // 低頻場決定草叢斑塊，高頻固定種子決定單格是否長草，避免平均撒滿棋盤。
      const grassCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const region = terrainRegion(cell);
        if (region !== "meadow" && region !== "moss") return false;
        const patchField = Math.sin(cell.x * 0.19 + Math.cos(cell.z * 0.11) * 1.7)
          + Math.cos(cell.z * 0.16 - cell.x * 0.08);
        if (patchField < -0.28) return false;
        const seed = Math.abs(Math.sin(cell.x * 63.7 + cell.z * 29.3) * 18341.73) % 1;
        if (seed < 0.925) return false;
        return !data.towers.some((tower) => {
          const tx = tower.x / CELL;
          const tz = tower.y / CELL;
          const clearance = tower.sanctuary ? 4.1 : 1.05;
          return Math.hypot(cell.x - tx, cell.z - tz) < clearance;
        }) && !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.38,
        );
      }).slice(0, 1600);
      if (grassCells.length) {
        // 彎曲漸尖的葉片取代圓錐草刺；三片葉組成一簇，並共用樹冠風場材質。
        const bladeGeometry = new THREE.BufferGeometry();
        bladeGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
          -0.052, 0, 0, 0.052, 0, 0,
          -0.037, 0.12, 0.012, 0.037, 0.12, 0.012,
          -0.018, 0.23, 0.038, 0.018, 0.23, 0.038,
          0, 0.32, 0.066,
        ], 3));
        // 葉片由根部深綠漸層至尖端暖金，再乘上每株的生態色，讓草叢更有層次。
        bladeGeometry.setAttribute("color", new THREE.Float32BufferAttribute([
          0.19, 0.31, 0.22, 0.19, 0.31, 0.22,
          0.36, 0.56, 0.29, 0.36, 0.56, 0.29,
          0.62, 0.72, 0.39, 0.62, 0.72, 0.39,
          0.88, 0.83, 0.53,
        ], 3));
        bladeGeometry.setIndex([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 4, 6, 5]);
        bladeGeometry.computeVertexNormals();
        bladeGeometry.computeBoundingSphere();
        const bladeCount = grassCells.length * 3;
        const grass = new THREE.InstancedMesh(
          bladeGeometry,
          shared.grassBlade,
          bladeCount,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        const meadowBladePalette = ["#4f8359", "#78a45f", "#a6bb70", "#d1bd77"];
        const mossBladePalette = ["#426f65", "#5d8b72", "#8ba36e", "#aebe83"];
        for (let i = 0; i < grassCells.length; i++) {
          const cell = grassCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let blade = 0; blade < 3; blade++) {
            const index = i * 3 + blade;
            const angle = seed * Math.PI * 2 + blade * (Math.PI * 2 / 3);
            const radius = 0.08 + seed * 0.08;
            dummy.position.set(
              cell.x + Math.cos(angle) * radius,
              groundTop(cell.h) + 0.012,
              cell.z + Math.sin(angle) * radius,
            );
            dummy.rotation.set(
              Math.cos(angle) * 0.11,
              angle,
              Math.sin(angle) * -0.11,
            );
            const mossPatch = terrainRegion(cell) === "moss";
            const heightVariation = 0.72 + ((seed * 7.3 + blade * 0.31) % 1) * 0.52;
            dummy.scale.set(
              0.76 + seed * 0.34,
              heightVariation + (mossPatch ? 0.08 : 0),
              0.76 + seed * 0.34,
            );
            dummy.updateMatrix();
            grass.setMatrixAt(index, dummy.matrix);
            const bladePalette = mossPatch ? mossBladePalette : meadowBladePalette;
            const paletteIndex = Math.floor(seed * bladePalette.length + blade * 1.7) % bladePalette.length;
            tint.set(bladePalette[paletteIndex]);
            grass.setColorAt(index, tint);
          }
        }
        grass.instanceMatrix.needsUpdate = true;
        if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
        grass.computeBoundingSphere();
        grass.castShadow = false;
        grass.receiveShadow = false;
        terrainRoot.add(grass);
      }

      // 草甸與苔地加入成簇的海岸林木；樹冠以頂點風場輕晃，不逐棵建立動畫。
      const groveCandidates = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 1 || cell.h > 2) return false;
        const region = terrainRegion(cell);
        if (region !== "meadow" && region !== "moss") return false;
        const key = Math.floor(cell.x) + "," + Math.floor(cell.z);
        if (coastBandKeys.has(key)) return false;
        const seed = Math.abs(Math.sin(cell.x * 37.7 + cell.z * 71.3) * 31871.9) % 1;
        if (seed < 0.986) return false;
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 1.75,
        );
      });
      const groveCount = Math.min(84, groveCandidates.length);
      const groveCells = groveCount
        ? Array.from({ length: groveCount }, (_, i) =>
            groveCandidates[Math.min(groveCandidates.length - 1, Math.floor((i + 0.5) * groveCandidates.length / groveCount))],
          )
        : [];
      if (groveCells.length) {
        const trunks = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.075, 0.13, 0.88, 7),
          shared.treeBark,
          groveCells.length,
        );
        const rootFlare = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.025, 0.072, 0.42, 5),
          shared.treeBark,
          groveCells.length * 3,
        );
        const sideCanopies = new THREE.InstancedMesh(
          new THREE.IcosahedronGeometry(0.31, 0),
          shared.foliageWind,
          groveCells.length * 2,
        );
        const lowerCanopies = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.55, 0),
          shared.foliageWind,
          groveCells.length,
        );
        const upperCanopies = new THREE.InstancedMesh(
          new THREE.IcosahedronGeometry(0.39, 0),
          shared.foliageWind,
          groveCells.length,
        );
        const groveDummy = new THREE.Object3D();
        const groveTint = new THREE.Color();
        for (let i = 0; i < groveCells.length; i++) {
          const cell = groveCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const angle = seed * Math.PI * 2;
          const scale = 0.82 + seed * 0.34;
          groveDummy.position.set(cell.x, groundTop(cell.h) + 0.44 * scale, cell.z);
          groveDummy.rotation.set(0, angle, 0);
          groveDummy.scale.set(0.86 + seed * 0.2, scale, 0.86 + seed * 0.2);
          groveDummy.updateMatrix();
          trunks.setMatrixAt(i, groveDummy.matrix);

          // 三條短根向地表鋪開，讓樹幹扎根在土壤裡，而不是圓柱直接插入草地。
          for (let root = 0; root < 3; root++) {
            const rootAngle = angle + root * (Math.PI * 2 / 3) + 0.18;
            groveDummy.position.set(
              cell.x + Math.cos(rootAngle) * 0.16,
              groundTop(cell.h) + 0.12,
              cell.z + Math.sin(rootAngle) * 0.16,
            );
            groveDummy.rotation.set(
              Math.cos(rootAngle) * 0.82,
              rootAngle,
              -Math.sin(rootAngle) * 0.82,
            );
            groveDummy.scale.set(0.9, 0.72 + seed * 0.22, 0.9);
            groveDummy.updateMatrix();
            rootFlare.setMatrixAt(i * 3 + root, groveDummy.matrix);
          }

          groveDummy.position.set(cell.x, groundTop(cell.h) + 0.91 * scale, cell.z);
          groveDummy.rotation.set(seed * 0.08, angle, (seed - 0.5) * 0.08);
          groveDummy.scale.set(0.9 + seed * 0.16, 0.9 + seed * 0.18, 0.9 + seed * 0.16);
          groveDummy.updateMatrix();
          lowerCanopies.setMatrixAt(i, groveDummy.matrix);
          groveTint.set(terrainRegion(cell) === "moss" ? "#527b62" : "#5e8969");
          lowerCanopies.setColorAt(i, groveTint);

          // 左右兩側補出不對稱樹冠，打破單一球狀樹型，並與主樹冠共用風場。
          for (let side = 0; side < 2; side++) {
            const sideAngle = angle + (side === 0 ? 1.18 : -1.04);
            groveDummy.position.set(
              cell.x + Math.cos(sideAngle) * 0.34 * scale,
              groundTop(cell.h) + (0.98 + side * 0.16) * scale,
              cell.z + Math.sin(sideAngle) * 0.34 * scale,
            );
            groveDummy.rotation.set((seed - 0.5) * 0.2, sideAngle, (seed - 0.5) * 0.18);
            groveDummy.scale.set(0.78 + seed * 0.16, 0.78 + (1 - side) * 0.14, 0.78 + seed * 0.16);
            groveDummy.updateMatrix();
            sideCanopies.setMatrixAt(i * 2 + side, groveDummy.matrix);
            groveTint.set(terrainRegion(cell) === "moss"
              ? (side === 0 ? "#426f5a" : "#70936b")
              : (side === 0 ? "#527e60" : "#93ad72"));
            sideCanopies.setColorAt(i * 2 + side, groveTint);
          }

          groveDummy.position.set(cell.x + Math.cos(angle) * 0.06, groundTop(cell.h) + 1.34 * scale, cell.z + Math.sin(angle) * 0.06);
          groveDummy.rotation.set(0, angle + 0.42, 0);
          groveDummy.scale.set(0.72 + seed * 0.12, 0.72 + seed * 0.16, 0.72 + seed * 0.12);
          groveDummy.updateMatrix();
          upperCanopies.setMatrixAt(i, groveDummy.matrix);
          groveTint.set(seed > 0.62 ? "#9eb879" : "#7ea873");
          upperCanopies.setColorAt(i, groveTint);
        }
        for (const mesh of [trunks, rootFlare, lowerCanopies, sideCanopies, upperCanopies]) {
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          terrainRoot.add(mesh);
        }
      }

      // 林地邊緣的低矮灌木叢：以不同葉形與尺寸打散樹木之間的空白，避免植被只剩單株模型。
      const shrubCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 1 || cell.h > 2) return false;
        const region = terrainRegion(cell);
        if (region !== "meadow" && region !== "moss") return false;
        const key = Math.floor(cell.x) + "," + Math.floor(cell.z);
        if (coastBandKeys.has(key)) return false;
        const seed = Math.abs(Math.sin(cell.x * 59.3 + cell.z * 23.7) * 21791.3) % 1;
        if (seed < 0.944) return false;
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 1.05,
        );
      }).slice(0, 360);
      if (shrubCells.length) {
        const shrubs = new THREE.InstancedMesh(
          new THREE.IcosahedronGeometry(0.15, 0),
          shared.foliageWind,
          shrubCells.length * 3,
        );
        const shrubDummy = new THREE.Object3D();
        const shrubTint = new THREE.Color();
        for (let i = 0; i < shrubCells.length; i++) {
          const cell = shrubCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let leaf = 0; leaf < 3; leaf++) {
            const angle = seed * Math.PI * 2 + leaf * (Math.PI * 2 / 3);
            const radius = leaf === 0 ? 0.02 : 0.15 + seed * 0.08;
            shrubDummy.position.set(
              cell.x + Math.cos(angle) * radius,
              groundTop(cell.h) + 0.105 + (leaf === 0 ? 0.015 : 0),
              cell.z + Math.sin(angle) * radius,
            );
            shrubDummy.rotation.set(seed * 0.18, angle, (seed - 0.5) * 0.16);
            shrubDummy.scale.set(
              (leaf === 0 ? 1.0 : 0.78) + seed * 0.22,
              (leaf === 0 ? 0.82 : 0.72) + leaf * 0.09,
              (leaf === 0 ? 1.0 : 0.78) + seed * 0.18,
            );
            shrubDummy.updateMatrix();
            shrubs.setMatrixAt(i * 3 + leaf, shrubDummy.matrix);
            const mossy = terrainRegion(cell) === "moss";
            shrubTint.set(mossy
              ? (leaf === 1 ? "#8caa78" : "#496e5c")
              : (leaf === 1 ? "#a5b978" : "#648a68"));
            shrubs.setColorAt(i * 3 + leaf, shrubTint);
          }
        }
        shrubs.instanceMatrix.needsUpdate = true;
        if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
        shrubs.castShadow = false;
        shrubs.receiveShadow = false;
        terrainRoot.add(shrubs);
      }

      // 苔地以羽狀蕨葉填補樹叢下層：單一自訂葉片幾何、多實例批次，風動沿用 GPU 材質。
      const fernCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 1 || cell.h > 2 || terrainRegion(cell) !== "moss") return false;
        const key = Math.floor(cell.x) + "," + Math.floor(cell.z);
        if (coastBandKeys.has(key)) return false;
        const seed = Math.abs(Math.sin(cell.x * 73.1 + cell.z * 41.9) * 29371.7) % 1;
        if (seed < 0.966) return false;
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.92,
        );
      }).slice(0, 72);
      if (fernCells.length) {
        const fernPositions: number[] = [];
        const fernIndices: number[] = [];
        const addFernTriangle = (a: number[], b: number[], c: number[]) => {
          const start = fernPositions.length / 3;
          fernPositions.push(...a, ...b, ...c);
          fernIndices.push(start, start + 1, start + 2);
        };
        // 中央葉脈與六對漸小羽片組成一片弧形蕨葉；雙面材質使其在斜視角仍可讀。
        const stemRows: { y: number; z: number }[] = [];
        for (let pair = 0; pair <= 6; pair++) {
          const t = pair / 6;
          stemRows.push({ y: 0.025 + t * 0.39, z: t * t * 0.13 });
        }
        for (let pair = 0; pair < 6; pair++) {
          const a = stemRows[pair];
          const b = stemRows[pair + 1];
          const halfWidth = 0.006;
          addFernTriangle([-halfWidth, a.y, a.z], [halfWidth, a.y, a.z], [-halfWidth, b.y, b.z]);
          addFernTriangle([halfWidth, a.y, a.z], [halfWidth, b.y, b.z], [-halfWidth, b.y, b.z]);
        }
        for (let pair = 0; pair < 6; pair++) {
          const t = (pair + 1) / 7;
          const y = 0.045 + t * 0.34;
          const z = t * t * 0.12;
          const spread = 0.15 * (1.0 - t * 0.42);
          for (const side of [-1, 1]) {
            const base = [0, y, z];
            const shoulder = [side * spread * 0.72, y + 0.032, z + 0.035];
            const tip = [side * spread, y + 0.066, z + 0.092];
            const inner = [side * spread * 0.34, y + 0.045, z + 0.074];
            addFernTriangle(base, shoulder, inner);
            addFernTriangle(shoulder, tip, inner);
          }
        }
        const fernGeometry = new THREE.BufferGeometry();
        fernGeometry.setAttribute("position", new THREE.Float32BufferAttribute(fernPositions, 3));
        fernGeometry.setIndex(fernIndices);
        fernGeometry.computeVertexNormals();
        fernGeometry.computeBoundingSphere();
        const fernFrondsPerCell = 5;
        const ferns = new THREE.InstancedMesh(
          fernGeometry,
          shared.foliageWind,
          fernCells.length * fernFrondsPerCell,
        );
        const fernDummy = new THREE.Object3D();
        const fernTint = new THREE.Color();
        for (let i = 0; i < fernCells.length; i++) {
          const cell = fernCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let frond = 0; frond < fernFrondsPerCell; frond++) {
            const index = i * fernFrondsPerCell + frond;
            const angle = seed * Math.PI * 2 + frond * (Math.PI * 2 / fernFrondsPerCell);
            const scale = 0.72 + seed * 0.34 + (frond % 2) * 0.08;
            fernDummy.position.set(
              cell.x + Math.cos(angle) * 0.055,
              groundTop(cell.h) + 0.018,
              cell.z + Math.sin(angle) * 0.055,
            );
            fernDummy.rotation.set((seed - 0.5) * 0.1, angle, (0.5 - seed) * 0.09);
            fernDummy.scale.set(scale, scale, scale);
            fernDummy.updateMatrix();
            ferns.setMatrixAt(index, fernDummy.matrix);
            fernTint.set(frond % 3 === 0 ? "#9ab878" : frond % 2 === 0 ? "#628e6b" : "#47775f");
            ferns.setColorAt(index, fernTint);
          }
        }
        ferns.instanceMatrix.needsUpdate = true;
        if (ferns.instanceColor) ferns.instanceColor.needsUpdate = true;
        ferns.computeBoundingSphere();
        ferns.castShadow = false;
        ferns.receiveShadow = false;
        terrainRoot.add(ferns);
      }

      // 苔地零星長出成簇蘑菇，提供近景尺度變化；數量固定上限，不加入逐物件動畫。
      const mushroomCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 1 || terrainRegion(cell) !== "moss") return false;
        if (protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.9,
        )) return false;
        const seed = Math.abs(Math.sin(cell.x * 37.1 + cell.z * 91.7) * 21873.5) % 1;
        return seed > 0.982;
      }).slice(0, 64);
      if (mushroomCells.length) {
        const mushroomStems = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.018, 0.028, 0.11, 5),
          shared.ivory,
          mushroomCells.length,
        );
        const mushroomCaps = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.075, 0),
          shared.meadowBloom,
          mushroomCells.length,
        );
        const mushroomDummy = new THREE.Object3D();
        const mushroomTint = new THREE.Color();
        for (let i = 0; i < mushroomCells.length; i++) {
          const cell = mushroomCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const angle = seed * Math.PI * 2;
          const x = cell.x + Math.cos(angle) * 0.18;
          const z = cell.z + Math.sin(angle) * 0.18;
          mushroomDummy.position.set(x, groundTop(cell.h) + 0.055, z);
          mushroomDummy.rotation.set(0, angle, (seed - 0.5) * 0.16);
          mushroomDummy.scale.setScalar(0.78 + seed * 0.32);
          mushroomDummy.updateMatrix();
          mushroomStems.setMatrixAt(i, mushroomDummy.matrix);
          mushroomDummy.position.y = groundTop(cell.h) + 0.135;
          mushroomDummy.scale.set(0.9 + seed * 0.32, 0.65 + seed * 0.2, 0.9 + seed * 0.32);
          mushroomDummy.updateMatrix();
          mushroomCaps.setMatrixAt(i, mushroomDummy.matrix);
          mushroomTint.set(seed > 0.66 ? "#e8d3a6" : seed > 0.33 ? "#c9b98f" : "#b3d4b8");
          mushroomCaps.setColorAt(i, mushroomTint);
        }
        mushroomStems.instanceMatrix.needsUpdate = true;
        mushroomCaps.instanceMatrix.needsUpdate = true;
        if (mushroomCaps.instanceColor) mushroomCaps.instanceColor.needsUpdate = true;
        mushroomStems.castShadow = false;
        mushroomCaps.castShadow = false;
        mushroomStems.receiveShadow = false;
        mushroomCaps.receiveShadow = false;
        terrainRoot.add(mushroomStems, mushroomCaps);
      }

      // 苔地與古代刻紋附近漂浮少量潮光微粒；單一動態實例批次，模擬林間螢火與遺跡能量。
      const moteCandidates = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const region = terrainRegion(cell);
        if (region !== "moss" && region !== "ancient") return false;
        const seed = Math.abs(Math.sin(cell.x * 31.7 + cell.z * 73.9) * 29171.7) % 1;
        if (seed < 0.88) return false;
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.8,
        );
      });
      const moteCount = Math.min(42, moteCandidates.length);
      if (moteCount > 0) {
        fireflyMesh = new THREE.InstancedMesh(
          new THREE.OctahedronGeometry(0.028, 0),
          shared.firefly,
          moteCount,
        );
        fireflyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let i = 0; i < moteCount; i++) {
          const cell = moteCandidates[Math.min(moteCandidates.length - 1, Math.floor((i + 0.5) * moteCandidates.length / moteCount))];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const phase = seed * Math.PI * 2 + i * 0.73;
          const radius = 0.12 + seed * 0.2;
          const scale = 0.72 + seed * 0.7;
          const entry = {
            x: cell.x + Math.cos(phase) * radius,
            z: cell.z + Math.sin(phase) * radius,
            y: groundTop(cell.h) + 0.32 + seed * 0.34,
            phase,
            radius: 0.08 + seed * 0.13,
            scale,
          };
          fireflyEntries.push(entry);
          fireflyDummy.position.set(entry.x, entry.y, entry.z);
          fireflyDummy.scale.setScalar(scale);
          fireflyDummy.updateMatrix();
          fireflyMesh.setMatrixAt(i, fireflyDummy.matrix);
        }
        fireflyMesh.instanceMatrix.needsUpdate = true;
        fireflyMesh.frustumCulled = false;
        fireflyMesh.renderOrder = 4;
        fireflyMesh.castShadow = false;
        fireflyMesh.receiveShadow = false;
        terrainRoot.add(fireflyMesh);
      }

      // 風會把花粉與草籽從草甸帶起來；只放在草甸、苔地，並限制數量及避開建築。
      const pollenCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const region = terrainRegion(cell);
        if (region !== "meadow" && region !== "moss") return false;
        const seed = Math.abs(Math.sin(cell.x * 57.1 + cell.z * 23.7) * 34781.3) % 1;
        if (seed < 0.965) return false;
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.58,
        );
      });
      const pollenCount = Math.min(144, pollenCells.length);
      if (pollenCount > 0) {
        const pollenMesh = new THREE.InstancedMesh(
          new THREE.IcosahedronGeometry(0.021, 0),
          shared.pollen,
          pollenCount,
        );
        const pollenDummy = new THREE.Object3D();
        const pollenTint = new THREE.Color();
        const pollenPalette = ["#fff0b1", "#f1c4d6", "#b8eee2", "#cbdcff", "#f6d6a0"];
        for (let i = 0; i < pollenCount; i++) {
          const cell = pollenCells[Math.min(pollenCells.length - 1,
            Math.floor((i + 0.5) * pollenCells.length / pollenCount))];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const phase = seed * Math.PI * 2 + i * 0.71;
          pollenDummy.position.set(
            cell.x + Math.cos(phase) * 0.26,
            groundTop(cell.h) + 0.42 + seed * 0.68,
            cell.z + Math.sin(phase) * 0.26,
          );
          const scale = 0.62 + seed * 0.68;
          pollenDummy.scale.set(scale, 0.72 + seed * 0.5, scale);
          pollenDummy.rotation.set(seed * 1.8, phase, seed * 1.4);
          pollenDummy.updateMatrix();
          pollenMesh.setMatrixAt(i, pollenDummy.matrix);
          pollenTint.set(pollenPalette[Math.floor(seed * pollenPalette.length)]);
          pollenMesh.setColorAt(i, pollenTint);
        }
        pollenMesh.instanceMatrix.needsUpdate = true;
        if (pollenMesh.instanceColor) pollenMesh.instanceColor.needsUpdate = true;
        pollenMesh.frustumCulled = false;
        pollenMesh.renderOrder = 4;
        pollenMesh.castShadow = false;
        pollenMesh.receiveShadow = false;
        terrainRoot.add(pollenMesh);
      }

      // 草甸與苔地改為三朵一簇的野花組合；花莖與花冠都共用 GPU 風場。
      const flowerCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const region = terrainRegion(cell);
        if (region !== "meadow" && region !== "moss") return false;
        const seed = Math.abs(Math.sin(cell.x * 47.3 + cell.z * 89.1) * 28173.7) % 1;
        if (seed < 0.987) return false;
        return !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.72,
        );
      }).slice(0, 180);
      if (flowerCells.length) {
        const bloomPerCell = 3;
        const bloomCount = flowerCells.length * bloomPerCell;
        const stems = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.018, 0.14, 5),
          shared.grass,
          bloomCount,
        );
        // 五瓣橢圓花冠＋獨立花心；每種零件各一個實例批次，不再用單顆球體代表整朵花。
        const flowerPetals = new THREE.InstancedMesh(
          new THREE.SphereGeometry(0.042, 7, 5),
          shared.meadowBloom,
          bloomCount * 5,
        );
        const flowerCenters = new THREE.InstancedMesh(
          new THREE.SphereGeometry(0.019, 7, 5),
          shared.foundationGold,
          bloomCount,
        );
        const flowerDummy = new THREE.Object3D();
        const flowerTint = new THREE.Color();
        const flowerPalette = ["#f0d49a", "#d9b5c4", "#b4d9ca", "#e8dfb9"];
        for (let i = 0; i < flowerCells.length; i++) {
          const cell = flowerCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let bloom = 0; bloom < bloomPerCell; bloom++) {
            const index = i * bloomPerCell + bloom;
            const angle = seed * Math.PI * 2 + bloom * (Math.PI * 2 / bloomPerCell);
            const radius = bloom === 0 ? 0.015 : 0.145 + seed * 0.055;
            const x = cell.x + Math.cos(angle) * radius;
            const z = cell.z + Math.sin(angle) * radius;
            const scale = bloom === 0 ? 1.0 : 0.72 + seed * 0.2;
            flowerDummy.position.set(x, groundTop(cell.h) + 0.06, z);
            flowerDummy.rotation.set((seed - 0.5) * 0.12, angle, (seed - 0.5) * 0.14);
            flowerDummy.scale.set(scale, 0.82 + seed * 0.18, scale);
            flowerDummy.updateMatrix();
            stems.setMatrixAt(index, flowerDummy.matrix);

            const headY = groundTop(cell.h) + (bloom === 0 ? 0.145 : 0.116 + seed * 0.018);
            const flowerScale = (0.72 + seed * 0.2) * (bloom === 0 ? 1.0 : 0.82);
            const petalColor = flowerPalette[(Math.floor(seed * 17) + bloom) % flowerPalette.length];
            flowerTint.set(petalColor);
            for (let petal = 0; petal < 5; petal++) {
              const petalAngle = (petal / 5) * Math.PI * 2 + seed * 0.36;
              flowerDummy.position.set(
                x + Math.sin(petalAngle) * 0.035 * flowerScale,
                headY,
                z + Math.cos(petalAngle) * 0.035 * flowerScale,
              );
              flowerDummy.rotation.set(
                (seed - 0.5) * 0.16,
                petalAngle,
                (seed - 0.5) * 0.12,
              );
              flowerDummy.scale.set(
                flowerScale * 0.82,
                flowerScale * 0.34,
                flowerScale * 1.34,
              );
              flowerDummy.updateMatrix();
              flowerPetals.setMatrixAt(index * 5 + petal, flowerDummy.matrix);
              flowerPetals.setColorAt(index * 5 + petal, flowerTint);
            }
            flowerDummy.position.set(x, headY + 0.012, z);
            flowerDummy.rotation.set(0, seed * Math.PI * 2, 0);
            flowerDummy.scale.setScalar(flowerScale * 0.72);
            flowerDummy.updateMatrix();
            flowerCenters.setMatrixAt(index, flowerDummy.matrix);
          }
        }
        stems.instanceMatrix.needsUpdate = true;
        flowerPetals.instanceMatrix.needsUpdate = true;
        flowerCenters.instanceMatrix.needsUpdate = true;
        if (flowerPetals.instanceColor) flowerPetals.instanceColor.needsUpdate = true;
        stems.castShadow = false;
        flowerPetals.castShadow = false;
        flowerCenters.castShadow = false;
        stems.receiveShadow = false;
        flowerPetals.receiveShadow = false;
        flowerCenters.receiveShadow = false;
        terrainRoot.add(stems, flowerPetals, flowerCenters);
      }

      // 高台邊緣偶爾露出低矮的海蝕礦晶，密度刻意偏低，避免水元素搶過建築主體。
      const mineralCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 2) return false;
        const gx = Math.floor(cell.x);
        const gy = Math.floor(cell.z);
        const edge = [
          tileCells.get(gx + "," + (gy - 1)),
          tileCells.get((gx + 1) + "," + gy),
          tileCells.get(gx + "," + (gy + 1)),
          tileCells.get((gx - 1) + "," + gy),
        ].some((neighbor) => !neighbor || neighbor.h < cell.h);
        const seed = Math.abs(Math.sin(cell.x * 51.7 + cell.z * 97.3) * 36431.71) % 1;
        return edge && seed > 0.91;
      });
      if (mineralCells.length) {
        const minerals = new THREE.InstancedMesh(
          new THREE.OctahedronGeometry(0.065, 0),
          shared.terrainCrystal,
          mineralCells.length * 2,
        );
        const dummy = new THREE.Object3D();
        for (let i = 0; i < mineralCells.length; i++) {
          const cell = mineralCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let shard = 0; shard < 2; shard++) {
            const index = i * 2 + shard;
            dummy.position.set(
              cell.x + (shard === 0 ? -0.09 : 0.1) + (seed - 0.5) * 0.08,
              groundTop(cell.h) + 0.07 + shard * 0.035,
              cell.z + (shard === 0 ? 0.07 : -0.08),
            );
            dummy.rotation.set(seed * 0.5, seed * Math.PI * 2 + shard, seed * 0.4);
            dummy.scale.set(0.82 + seed * 0.35, 1.0 + shard * 0.48, 0.82 + seed * 0.35);
            dummy.updateMatrix();
            minerals.setMatrixAt(index, dummy.matrix);
          }
        }
        minerals.instanceMatrix.needsUpdate = true;
        minerals.castShadow = true;
        minerals.receiveShadow = true;
        terrainRoot.add(minerals);
      }

      // 高地頂面依等級加入不同材質語彙：1 級苔痕、2 級岩層線、3 級石板刻線。
      // 細節使用 InstancedMesh，並在既有塔座／聖地周圍留白，不影響建塔判定。
      const detailIsClear = (cell: { x: number; z: number }, margin = 1.25) =>
        !protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + margin,
        );
      const mossCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 1 || terrainRegion(cell) !== "moss" || !detailIsClear(cell)) return false;
        const seed = Math.abs(Math.sin(cell.x * 29.7 + cell.z * 81.3) * 18431.7) % 1;
        return seed > 0.76;
      });
      if (mossCells.length) {
        const moss = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.095, 0),
          shared.terrainMoss,
          mossCells.length * 2,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < mossCells.length; i++) {
          const cell = mossCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let patch = 0; patch < 2; patch++) {
            const index = i * 2 + patch;
            const angle = seed * Math.PI * 2 + patch * 1.9;
            const radius = 0.12 + seed * 0.15;
            dummy.position.set(
              cell.x + Math.cos(angle) * radius,
              groundTop(cell.h) + 0.012,
              cell.z + Math.sin(angle) * radius,
            );
            dummy.rotation.set(0, angle, (seed - 0.5) * 0.08);
            dummy.scale.set(1.35 + seed * 0.45, 0.14, 0.68 + patch * 0.16);
            dummy.updateMatrix();
            moss.setMatrixAt(index, dummy.matrix);
            tint.set(patch === 0 ? (seed > 0.55 ? "#789875" : "#54775e") : "#91a477");
            moss.setColorAt(index, tint);
          }
        }
        moss.instanceMatrix.needsUpdate = true;
        if (moss.instanceColor) moss.instanceColor.needsUpdate = true;
        moss.castShadow = false;
        moss.receiveShadow = false;
        terrainRoot.add(moss);
      }

      // 苔地補少量扇形蕨葉，保持低矮並限制數量，不遮住塔身與角色。
      const fernFanCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 1 || terrainRegion(cell) !== "moss" || !detailIsClear(cell, 1.35)) return false;
        const seed = Math.abs(Math.sin(cell.x * 83.1 + cell.z * 27.9) * 31917.7) % 1;
        return seed > 0.972;
      }).slice(0, 420);
      if (fernFanCells.length) {
        const ferns = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.042, 0.23, 5),
          shared.coastGrass,
          fernFanCells.length * 3,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < fernFanCells.length; i++) {
          const cell = fernFanCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let leaf = 0; leaf < 3; leaf++) {
            const angle = seed * Math.PI * 2 + leaf * (Math.PI * 2 / 3);
            dummy.position.set(
              cell.x + Math.cos(angle) * 0.18,
              groundTop(cell.h) + 0.105,
              cell.z + Math.sin(angle) * 0.18,
            );
            dummy.rotation.set(Math.cos(angle) * 0.22, angle, Math.sin(angle) * -0.22);
            dummy.scale.set(0.78 + seed * 0.25, 0.72 + leaf * 0.1, 0.78 + seed * 0.25);
            dummy.updateMatrix();
            ferns.setMatrixAt(i * 3 + leaf, dummy.matrix);
            tint.set(leaf === 1 ? "#a6b985" : seed > 0.5 ? "#719b75" : "#5c8468");
            ferns.setColorAt(i * 3 + leaf, tint);
          }
        }
        ferns.instanceMatrix.needsUpdate = true;
        if (ferns.instanceColor) ferns.instanceColor.needsUpdate = true;
        ferns.castShadow = false;
        ferns.receiveShadow = false;
        terrainRoot.add(ferns);
      }

      const strataCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 2 || terrainRegion(cell) !== "limestone" || !detailIsClear(cell)) return false;
        const seed = Math.abs(Math.sin(cell.x * 47.1 + cell.z * 19.7) * 29341.3) % 1;
        return seed > 0.73;
      });
      if (strataCells.length) {
        const strata = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.43, 0.014, 0.024),
          shared.terrainStrata,
          strataCells.length * 2,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < strataCells.length; i++) {
          const cell = strataCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const angle = seed * Math.PI * 2;
          for (let line = 0; line < 2; line++) {
            const offset = (line === 0 ? -1 : 1) * (0.055 + seed * 0.025);
            dummy.position.set(
              cell.x + Math.sin(angle) * offset,
              groundTop(cell.h) + 0.014,
              cell.z + Math.cos(angle) * offset,
            );
            dummy.rotation.set(0, angle, 0);
            dummy.scale.set(line === 0 ? 1 : 0.72 + seed * 0.16, 1, 1);
            dummy.updateMatrix();
            const index = i * 2 + line;
            strata.setMatrixAt(index, dummy.matrix);
            tint.set(line === 0 ? "#d1c9ad" : "#9b9b83");
            strata.setColorAt(index, tint);
          }
        }
        strata.instanceMatrix.needsUpdate = true;
        if (strata.instanceColor) strata.instanceColor.needsUpdate = true;
        strata.castShadow = false;
        strata.receiveShadow = false;
        terrainRoot.add(strata);
      }

      // 石灰岩區補細長白色礦脈，貼近地表且只在高地出現，形成明確的岩脊紋理。
      const veinCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 2 || terrainRegion(cell) !== "limestone" || !detailIsClear(cell, 1.4)) return false;
        const seed = Math.abs(Math.sin(cell.x * 57.3 + cell.z * 71.9) * 27391.11) % 1;
        return seed > 0.93;
      }).slice(0, 360);
      if (veinCells.length) {
        const veins = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.58, 0.012, 0.026),
          shared.limestoneVein,
          veinCells.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < veinCells.length; i++) {
          const cell = veinCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const angle = seed * Math.PI * 2;
          dummy.position.set(
            cell.x + Math.cos(angle) * 0.08,
            groundTop(cell.h) + 0.018,
            cell.z + Math.sin(angle) * 0.08,
          );
          dummy.rotation.y = angle;
          dummy.scale.set(0.65 + seed * 0.5, 1, 0.75 + seed * 0.35);
          dummy.updateMatrix();
          veins.setMatrixAt(i, dummy.matrix);
          tint.set(seed > 0.55 ? "#e5dfca" : "#b9c4b0");
          veins.setColorAt(i, tint);
        }
        veins.instanceMatrix.needsUpdate = true;
        if (veins.instanceColor) veins.instanceColor.needsUpdate = true;
        veins.castShadow = false;
        veins.receiveShadow = false;
        terrainRoot.add(veins);
      }

      // 石灰岩山脊的尖峰露頭：只在高地與石灰岩區出現，保持低於防禦塔輪廓。
      const peakCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 2 || terrainRegion(cell) !== "limestone" || !detailIsClear(cell, 1.9)) return false;
        const seed = Math.abs(Math.sin(cell.x * 87.1 + cell.z * 53.9) * 23817.3) % 1;
        return seed > 0.965;
      }).slice(0, 96);
      if (peakCells.length) {
        const peaks = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.14, 0.72, 5),
          shared.ridgePeak,
          peakCells.length * 2,
        );
        const peakBases = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.18, 0),
          shared.cliffFacet,
          peakCells.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < peakCells.length; i++) {
          const cell = peakCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const angle = seed * Math.PI * 2;
          for (let spire = 0; spire < 2; spire++) {
            const index = i * 2 + spire;
            const height = (spire === 0 ? 0.48 : 0.3) + seed * (spire === 0 ? 0.28 : 0.2);
            const radius = spire === 0 ? 0.12 : 0.21;
            const x = cell.x + Math.cos(angle + spire * 2.2) * radius;
            const z = cell.z + Math.sin(angle + spire * 2.2) * radius;
            dummy.position.set(x, groundTop(cell.h) + height * 0.5, z);
            dummy.rotation.set((seed - 0.5) * 0.14, angle + spire, (seed - 0.5) * 0.18);
            dummy.scale.set(0.82 + seed * 0.34, height / 0.72, 0.82 + seed * 0.28);
            dummy.updateMatrix();
            peaks.setMatrixAt(index, dummy.matrix);
            tint.set(spire === 0 ? (seed > 0.55 ? "#e3ddc9" : "#c9c6b4") : "#aeb5a8");
            peaks.setColorAt(index, tint);
          }
          dummy.position.set(cell.x, groundTop(cell.h) + 0.055, cell.z);
          dummy.rotation.set(seed * 0.25, angle, (seed - 0.5) * 0.2);
          dummy.scale.set(1.2, 0.42 + seed * 0.25, 1.05);
          dummy.updateMatrix();
          peakBases.setMatrixAt(i, dummy.matrix);
          tint.set("#899187");
          peakBases.setColorAt(i, tint);
        }
        peaks.instanceMatrix.needsUpdate = true;
        peakBases.instanceMatrix.needsUpdate = true;
        if (peaks.instanceColor) peaks.instanceColor.needsUpdate = true;
        if (peakBases.instanceColor) peakBases.instanceColor.needsUpdate = true;
        peaks.castShadow = true;
        peakBases.castShadow = false;
        terrainRoot.add(peaks, peakBases);
      }

      const engravedCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 3 || terrainRegion(cell) !== "limestone" || !detailIsClear(cell, 1.45)) return false;
        const seed = Math.abs(Math.sin(cell.x * 73.9 + cell.z * 37.1) * 31781.9) % 1;
        return seed > 0.72;
      });
      if (engravedCells.length) {
        // 三段式石板刻線形成開口方框，斜向觀看仍能讀出 3 級平台的精緻岩面。
        const rails = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.46, 0.014, 0.022),
          shared.terrainInlay,
          engravedCells.length * 2,
        );
        const ends = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.022, 0.014, 0.25),
          shared.terrainInlay,
          engravedCells.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < engravedCells.length; i++) {
          const cell = engravedCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const angle = seed * Math.PI * 2;
          for (let rail = 0; rail < 2; rail++) {
            const offset = rail === 0 ? -0.13 : 0.13;
            dummy.position.set(
              cell.x + Math.sin(angle) * offset,
              groundTop(cell.h) + 0.016,
              cell.z + Math.cos(angle) * offset,
            );
            dummy.rotation.set(0, angle, 0);
            dummy.scale.set(0.88 + seed * 0.12, 1, 1);
            dummy.updateMatrix();
            rails.setMatrixAt(i * 2 + rail, dummy.matrix);
            tint.set(rail === 0 ? "#eadbb8" : "#bba982");
            rails.setColorAt(i * 2 + rail, tint);
          }
          const endOffset = 0.205;
          dummy.position.set(
            cell.x + Math.cos(angle) * endOffset,
            groundTop(cell.h) + 0.016,
            cell.z - Math.sin(angle) * endOffset,
          );
          dummy.rotation.set(0, angle, 0);
          dummy.updateMatrix();
          ends.setMatrixAt(i, dummy.matrix);
          tint.set("#d5c49d");
          ends.setColorAt(i, tint);
        }
        rails.instanceMatrix.needsUpdate = true;
        ends.instanceMatrix.needsUpdate = true;
        if (rails.instanceColor) rails.instanceColor.needsUpdate = true;
        if (ends.instanceColor) ends.instanceColor.needsUpdate = true;
        rails.castShadow = false;
        rails.receiveShadow = false;
        ends.castShadow = false;
        ends.receiveShadow = false;
        terrainRoot.add(rails, ends);
      }

      // 古代區的淺刻符文嵌在石面上，幾乎與地表齊平，不阻擋建塔或單位移動。
      const etchCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h < 2 || terrainRegion(cell) !== "ancient" || !detailIsClear(cell, 1.55)) return false;
        const seed = Math.abs(Math.sin(cell.x * 67.1 + cell.z * 41.7) * 22817.9) % 1;
        return seed > 0.975;
      }).slice(0, 72);
      if (etchCells.length) {
        const etches = new THREE.InstancedMesh(
          new THREE.TorusGeometry(0.2, 0.009, 4, 24),
          shared.ancientEtch,
          etchCells.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < etchCells.length; i++) {
          const cell = etchCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          dummy.position.set(cell.x, groundTop(cell.h) + 0.016, cell.z);
          dummy.rotation.set(Math.PI / 2, seed * Math.PI * 2, 0);
          dummy.scale.set(0.72 + seed * 0.55, 0.72 + seed * 0.55, 0.72 + seed * 0.55);
          dummy.updateMatrix();
          etches.setMatrixAt(i, dummy.matrix);
          tint.set(seed > 0.55 ? "#a0e0c9" : "#6eaea0");
          etches.setColorAt(i, tint);
        }
        etches.instanceMatrix.needsUpdate = true;
        if (etches.instanceColor) etches.instanceColor.needsUpdate = true;
        etches.castShadow = false;
        etches.receiveShadow = false;
        terrainRoot.add(etches);
      }

      // 稀疏古代遺跡：完整地圖只落在障礙格，擴張地圖移至島外淺海，保留所有可建造平台。
      const ruinSites: { x: number; z: number; h: number; seed: number; baseY?: number }[] = [];
      const ruinNeighborOffsets = [
        [0, -1], [1, 0], [0, 1], [-1, 0],
        [-1, -1], [1, -1], [1, 1], [-1, 1],
      ];

      if (data.mapMode === "layout") {
        // 自訂／完整關卡只把遺跡放在 blocked 障礙格，保留所有可建造平台的空間。
        for (const cell of tileCells.values()) {
          if (cell.h < 2) continue;
          const gx = Math.floor(cell.x);
          const gy = Math.floor(cell.z);
          const key = gx + "," + gy;
          if (!data.blocked.has(key)) continue;
          const seed = Math.abs(Math.sin(cell.x * 39.7 + cell.z * 83.1) * 31871.23) % 1;
          if (seed < 0.9915) continue;
          const tooCloseToBuilding = protectedBuildings.some((building) =>
            Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 2.65,
          );
          if (tooCloseToBuilding) continue;
          const neighbors = ruinNeighborOffsets.map(([dc, dr]) =>
            tileCells.get((gx + dc) + "," + (gy + dr)),
          );
          if (neighbors.filter((neighbor) => neighbor && neighbor.h >= cell.h).length < 3) continue;
          if (ruinSites.some((site) => Math.hypot(cell.x - site.x, cell.z - site.z) < 5.4)) continue;
          ruinSites.push({ x: cell.x, z: cell.z, h: cell.h, seed });
          if (ruinSites.length >= 22) break;
        }
      } else {
        // 擴張模式的陸地幾乎全是可建格；古遺跡改放在島外淺海，避免佔住任何可建造高地。
        const offshoreCandidates = coastEdges.filter((edge) => edge.seed > 0.57);
        for (const edge of offshoreCandidates) {
          const x = edge.x + edge.dx * 1.62 + edge.dz * (edge.seed - 0.5) * 0.28;
          const z = edge.z + edge.dz * 1.62 + edge.dx * (edge.seed - 0.5) * 0.28;
          const tooCloseToBuilding = protectedBuildings.some((building) =>
            Math.hypot(x - building.x, z - building.z) < building.radius + 2.2,
          );
          if (tooCloseToBuilding) continue;
          if (ruinSites.some((site) => Math.hypot(x - site.x, z - site.z) < 5.6)) continue;
          ruinSites.push({ x, z, h: 0, baseY: -0.34, seed: edge.seed });
          if (ruinSites.length >= 14) break;
        }
      }


      // 同高度障礙地形上的遺跡群，以斷續石道連成小型古代聖域；沿線逐格檢查，絕不跨入可建造平台。

      // 區域遠景地標：完整地圖使用高地燈塔，擴張地圖則將燈塔放在島外淺海。
      // 陸上燈塔周圍八格必須全為同高度 blocked 障礙面，確保基座不侵入可建造平台。
      const beaconSites: { x: number; z: number; y: number; seed: number; offshore: boolean }[] = [];
      if (data.mapMode === "layout") {
        for (const cell of tileCells.values()) {
          if (cell.h < 2 || beaconSites.length >= 3) continue;
          const gx = Math.floor(cell.x);
          const gy = Math.floor(cell.z);
          const key = gx + "," + gy;
          if (!data.blocked.has(key)) continue;
          if (terrainRegion(cell) !== "limestone" && terrainRegion(cell) !== "ancient") continue;
          const neighbors = ruinNeighborOffsets.map(([dc, dr]) => {
            const neighborKey = (gx + dc) + "," + (gy + dr);
            const neighbor = tileCells.get(neighborKey);
            return !!neighbor && data.blocked.has(neighborKey) && neighbor.h === cell.h;
          });
          if (!neighbors.every(Boolean)) continue;
          const seed = Math.abs(Math.sin(cell.x * 43.7 + cell.z * 91.3) * 28931.17) % 1;
          if (seed < 0.982) continue;
          if (protectedBuildings.some((building) =>
            Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 6.2,
          )) continue;
          if (ruinSites.some((site) => Math.hypot(cell.x - site.x, cell.z - site.z) < 7.5)) continue;
          if (beaconSites.some((site) => Math.hypot(cell.x - site.x, cell.z - site.z) < 15)) continue;
          beaconSites.push({ x: cell.x, z: cell.z, y: groundTop(cell.h), seed, offshore: false });
        }
      } else {
        const offshoreBeaconEdges = coastEdges.filter((edge) => edge.seed > 0.88);
        for (const edge of offshoreBeaconEdges) {
          if (beaconSites.length >= 3) break;
          const x = edge.x + edge.dx * (2.75 + edge.seed * 0.3);
          const z = edge.z + edge.dz * (2.75 + edge.seed * 0.3);
          if (protectedBuildings.some((building) =>
            Math.hypot(x - building.x, z - building.z) < building.radius + 4.5,
          )) continue;
          if (ruinSites.some((site) => Math.hypot(x - site.x, z - site.z) < 6.8)) continue;
          if (beaconSites.some((site) => Math.hypot(x - site.x, z - site.z) < 13)) continue;
          beaconSites.push({ x, z, y: -0.34, seed: edge.seed, offshore: true });
        }
      }

      const ruinCauseways: { x: number; z: number; rot: number; length: number; y: number }[] = [];
      if (data.mapMode === "layout" && ruinSites.length > 1) {
        for (let i = 0; i < ruinSites.length && ruinCauseways.length < 6; i++) {
          const a = ruinSites[i];
          let best: { site: typeof a; distance: number } | null = null;
          for (let j = i + 1; j < ruinSites.length; j++) {
            const b = ruinSites[j];
            if (a.h !== b.h) continue;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const distance = Math.hypot(dx, dz);
            if (distance < 6.2 || distance > 10.8 || (best && distance >= best.distance)) continue;
            let safeCorridor = true;
            const steps = Math.ceil(distance * 2.2);
            for (let step = 0; step <= steps; step++) {
              const t = step / steps;
              const x = a.x + dx * t;
              const z = a.z + dz * t;
              const gx = Math.floor(x);
              const gy = Math.floor(z);
              const key = gx + "," + gy;
              const cell = tileCells.get(key);
              if (!cell || !data.blocked.has(key) || cell.h !== a.h) {
                safeCorridor = false;
                break;
              }
              if (protectedBuildings.some((building) => {
                const px = x - building.x;
                const pz = z - building.z;
                return Math.hypot(px, pz) < building.radius + 0.65;
              })) {
                safeCorridor = false;
                break;
              }
            }
            if (safeCorridor) best = { site: b, distance };
          }
          if (!best) continue;
          const b = best.site;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const distance = best.distance;
          ruinCauseways.push({
            x: (a.x + b.x) * 0.5,
            z: (a.z + b.z) * 0.5,
            rot: Math.atan2(-dz, dx),
            length: distance - 1.45,
            y: groundTop(a.h),
          });
        }
      }

      const ruinWallSites: { x: number; z: number; y: number; rot: number; width: number; height: number; seed: number }[] = [];
      const ruinOuterRingSites: { x: number; z: number; y: number; angle: number }[] = [];
      if (ruinSites.length) {
        const plinths = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1.08, 0.13, 1.08),
          shared.ruinShadow,
          ruinSites.length,
        );
        const columns = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.19, 0.25, 1, 8),
          shared.ruinStone,
          ruinSites.length * 2,
        );
        const runeSlabs = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.34, 0.92, 0.18),
          shared.ruinStone,
          ruinSites.length,
        );
        const runeRings = new THREE.InstancedMesh(
          new THREE.TorusGeometry(0.65, 0.018, 5, 32),
          shared.runeGlow,
          ruinSites.length,
        );
        const runeLines = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.15, 0.026, 0.018),
          shared.runeGlow,
          ruinSites.length * 3,
        );
        const rubble = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.18, 0),
          shared.ruinShadow,
          ruinSites.length * 3,
        );
        const lintels = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.82, 0.13, 0.22),
          shared.ruinStone,
          ruinSites.length,
        );
        const gateArches = new THREE.InstancedMesh(
          new THREE.TorusGeometry(0.58, 0.065, 7, 24, Math.PI),
          shared.ruinStone,
          ruinSites.length,
        );
        const ruinMoss = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.045, 0.12, 5),
          shared.grass,
          ruinSites.length * 4,
        );
        const pillarFootings = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.22, 0.28, 0.12, 8),
          shared.foundationStone,
          ruinSites.length * 2,
        );
        const wallSegments = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          shared.ruinStone,
          ruinSites.length * 4,
        );
        const wallPosts = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.105, 0.15, 0.36, 6),
          shared.ruinStone,
          ruinSites.length * 8,
        );
        const outerRings = new THREE.InstancedMesh(
          new THREE.TorusGeometry(0.88, 0.025, 5, 36),
          shared.runeGlow,
          ruinSites.length,
        );
        let pillarFootingCount = 0;
        let wallCount = 0;
        let wallPostCount = 0;
        let outerRingCount = 0;
        let lintelCount = 0;
        let gateCount = 0;
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < ruinSites.length; i++) {
          const site = ruinSites[i];
          const top = site.baseY ?? groundTop(site.h);
          const angle = site.seed * Math.PI * 2;
          const variant = Math.abs(Math.sin(site.x * 17.1 + site.z * 31.7) * 29171.3) % 1;
          // 陸上古遺跡配置最多 4 盞微弱符文光；海中遺跡保留材質自發光即可。
          if (site.baseY === undefined && i % 2 === 0 && landmarkLights.filter((entry) => entry.phase >= 10).length < 4) {
            const glow = new THREE.PointLight("#62d5bd", 0.36 + variant * 0.08, 7.2, 2);
            glow.position.set(site.x, top + 1.1, site.z);
            glow.castShadow = false;
            terrainRoot.add(glow);
            landmarkLights.push({ light: glow, phase: 10 + i * 0.63, intensity: 0.36 + variant * 0.08 });
          }
          dummy.position.set(site.x, top + 0.065, site.z);
          dummy.rotation.set(0, angle, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          plinths.setMatrixAt(i, dummy.matrix);
          tint.set(variant > 0.72 ? "#c2b99e" : "#8e927f");
          plinths.setColorAt(i, tint);

          dummy.position.set(site.x, top + 0.145, site.z);
          dummy.rotation.set(Math.PI / 2, angle, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          runeRings.setMatrixAt(i, dummy.matrix);
          tint.set(variant > 0.82 ? "#9ae6ca" : "#5fa99a");
          runeRings.setColorAt(i, tint);

          // 一根完整、一根折斷傾斜的柱身，讓遺跡輪廓不會像整齊排列的複製品。
          const pillarData = [
            { x: -0.38, z: -0.12, height: 0.98 + variant * 0.24, lean: 0.035, tint: "#b8b09a" },
            { x: 0.39, z: 0.16, height: 0.42 + variant * 0.3, lean: 0.18 + variant * 0.2, tint: "#8e9586" },
          ];
          for (let p = 0; p < pillarData.length; p++) {
            const pillar = pillarData[p];
            const index = i * 2 + p;
            dummy.position.set(
              site.x + pillar.x * Math.cos(angle) - pillar.z * Math.sin(angle),
              top + pillar.height * 0.5 + 0.13,
              site.z + pillar.x * Math.sin(angle) + pillar.z * Math.cos(angle),
            );
            dummy.rotation.set(pillar.lean * 0.45, angle + (p ? 0.42 : 0), pillar.lean);
            dummy.scale.set(1, pillar.height, 1);
            dummy.updateMatrix();
            columns.setMatrixAt(index, dummy.matrix);
            tint.set(pillar.tint);
            columns.setColorAt(index, tint);

            // 每根石柱都有一層外擴柱腳，避免柱身像直接插在石板上。
            const footingX = site.x + pillar.x * Math.cos(angle) - pillar.z * Math.sin(angle);
            const footingZ = site.z + pillar.x * Math.sin(angle) + pillar.z * Math.cos(angle);
            dummy.position.set(footingX, top + 0.065, footingZ);
            dummy.rotation.set(0, angle, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            pillarFootings.setMatrixAt(pillarFootingCount++, dummy.matrix);
          }

          // 破損圍牆只延伸到同高度的 blocked 障礙格，不會跨進可建造平台。
          const wallDirections = [
            { dc: 0, dr: -1, dx: 0, dz: -1, rot: 0 },
            { dc: 1, dr: 0, dx: 1, dz: 0, rot: Math.PI / 2 },
            { dc: 0, dr: 1, dx: 0, dz: 1, rot: 0 },
            { dc: -1, dr: 0, dx: -1, dz: 0, rot: Math.PI / 2 },
          ];
          for (const direction of wallDirections) {
            const neighborKey = (Math.floor(site.x) + direction.dc) + "," + (Math.floor(site.z) + direction.dr);
            const neighbor = tileCells.get(neighborKey);
            if (site.baseY === undefined && (!neighbor || !data.blocked.has(neighborKey) || neighbor.h !== site.h)) continue;
            const wallX = site.x + direction.dx * 1.16;
            const wallZ = site.z + direction.dz * 1.16;
            if (protectedBuildings.some((building) => Math.hypot(wallX - building.x, wallZ - building.z) < building.radius + 0.32)) continue;
            const wallSeed = Math.abs(Math.sin(site.x * 51.7 + site.z * 29.1 + direction.dc * 17.3 + direction.dr * 31.9) * 21481.7) % 1;
            if (wallSeed < 0.18 || wallCount >= ruinSites.length * 4) continue;
            const wallHeight = 0.2 + wallSeed * 0.18;
            const wallWidth = 0.54 + wallSeed * 0.22;
            ruinWallSites.push({
              x: wallX,
              z: wallZ,
              y: top + wallHeight * 0.5,
              rot: direction.rot,
              width: wallWidth,
              height: wallHeight,
              seed: wallSeed,
            });
            wallCount++;
          }

          // 四面鄰格皆為同高度障礙地形時才補外圈儀式環，避免碰觸可建造格。
          const ringNeighbors = ruinNeighborOffsets.map(([dc, dr]) => {
            const key = (Math.floor(site.x) + dc) + "," + (Math.floor(site.z) + dr);
            const neighbor = tileCells.get(key);
            return !!neighbor && data.blocked.has(key) && neighbor.h === site.h;
          });
          if (site.baseY !== undefined || ringNeighbors.every(Boolean)) {
            ruinOuterRingSites.push({ x: site.x, z: site.z, y: top + 0.11, angle });
          }

          if (site.baseY === undefined && variant > 0.68) {
            dummy.position.set(site.x, top + 0.78, site.z);
            dummy.rotation.set(0, angle, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            gateArches.setMatrixAt(gateCount, dummy.matrix);
            tint.set(variant > 0.86 ? "#d1c6a9" : "#969889");
            gateArches.setColorAt(gateCount, tint);
            gateCount++;
          }

          if (variant > 0.58) {
            dummy.position.set(site.x, top + 1.18, site.z);
            dummy.rotation.set(0, angle - Math.atan2(0.28, 0.77), (site.seed - 0.5) * 0.06);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            lintels.setMatrixAt(lintelCount, dummy.matrix);
            tint.set("#b5ad98");
            lintels.setColorAt(lintelCount, tint);
            lintelCount++;
          }

          // 符文石面向略偏外側；三道青綠刻痕以微弱自發光辨識古代遺跡。
          const runeX = site.x + 0.58 * Math.cos(angle) - 0.42 * Math.sin(angle);
          const runeZ = site.z + 0.58 * Math.sin(angle) + 0.42 * Math.cos(angle);
          dummy.position.set(runeX, top + 0.46, runeZ);
          dummy.rotation.set(0.035, angle + 0.18, -0.035);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          runeSlabs.setMatrixAt(i, dummy.matrix);
          tint.set("#c1b69b");
          runeSlabs.setColorAt(i, tint);

          for (let mark = 0; mark < 3; mark++) {
            const lineIndex = i * 3 + mark;
            const markY = top + (mark === 0 ? 0.36 : mark === 1 ? 0.52 : 0.68);
            dummy.position.set(
              runeX + Math.sin(angle + 0.18) * 0.096,
              markY,
              runeZ + Math.cos(angle + 0.18) * 0.096,
            );
            dummy.rotation.set(0, angle + 0.18, mark === 1 ? 0.18 : -0.12);
            dummy.scale.set(mark === 1 ? 0.72 : 1, 1, 1);
            dummy.updateMatrix();
            runeLines.setMatrixAt(lineIndex, dummy.matrix);
          }

          for (let rock = 0; rock < 3; rock++) {
            const rockIndex = i * 3 + rock;
            const rockAngle = angle + rock * (Math.PI * 2 / 3) + 0.3;
            const radius = 0.68 + ((site.seed * (rock + 3.7)) % 1) * 0.12;
            dummy.position.set(
              site.x + Math.cos(rockAngle) * radius,
              top + 0.055,
              site.z + Math.sin(rockAngle) * radius,
            );
            dummy.rotation.set(site.seed * 0.5, rockAngle, (site.seed - 0.5) * 0.3);
            dummy.scale.set(0.9 + site.seed * 0.4, 0.46 + rock * 0.12, 0.8 + site.seed * 0.3);
            dummy.updateMatrix();
            rubble.setMatrixAt(rockIndex, dummy.matrix);
          }

          for (let tuft = 0; tuft < 4; tuft++) {
            const tuftIndex = i * 4 + tuft;
            const tuftAngle = angle + tuft * (Math.PI / 2) + 0.32;
            const tuftRadius = 0.73;
            dummy.position.set(
              site.x + Math.cos(tuftAngle) * tuftRadius,
              top + 0.12,
              site.z + Math.sin(tuftAngle) * tuftRadius,
            );
            dummy.rotation.set(Math.cos(tuftAngle) * 0.18, tuftAngle, Math.sin(tuftAngle) * -0.18);
            dummy.scale.set(0.82, 0.62 + (tuft % 2) * 0.12, 0.82);
            dummy.updateMatrix();
            ruinMoss.setMatrixAt(tuftIndex, dummy.matrix);
            tint.set(tuft % 2 ? "#8da77a" : "#6d9274");
            ruinMoss.setColorAt(tuftIndex, tint);
          }
        }
        lintels.count = lintelCount;
        gateArches.count = gateCount;
        pillarFootings.count = pillarFootingCount;
        wallSegments.count = wallCount;
        wallPosts.count = wallCount * 2;
        outerRings.count = ruinOuterRingSites.length;
        const wallDummy = new THREE.Object3D();
        for (let i = 0; i < ruinWallSites.length; i++) {
          const wall = ruinWallSites[i];
          wallDummy.position.set(wall.x, wall.y, wall.z);
          wallDummy.rotation.set(0, wall.rot, 0);
          wallDummy.scale.set(wall.width, wall.height, 0.18);
          wallDummy.updateMatrix();
          wallSegments.setMatrixAt(i, wallDummy.matrix);
          for (let end = 0; end < 2; end++) {
            const sign = end === 0 ? -1 : 1;
            wallDummy.position.set(
              wall.x + Math.cos(wall.rot) * sign * wall.width * 0.42,
              wall.y + 0.045,
              wall.z - Math.sin(wall.rot) * sign * wall.width * 0.42,
            );
            wallDummy.rotation.set(0, wall.rot, 0);
            wallDummy.scale.set(1, 1, 1);
            wallDummy.updateMatrix();
            wallPosts.setMatrixAt(i * 2 + end, wallDummy.matrix);
          }
        }
        for (let i = 0; i < ruinOuterRingSites.length; i++) {
          const ring = ruinOuterRingSites[i];
          wallDummy.position.set(ring.x, ring.y, ring.z);
          wallDummy.rotation.set(Math.PI / 2, ring.angle, 0);
          wallDummy.scale.set(1, 1, 1);
          wallDummy.updateMatrix();
          outerRings.setMatrixAt(i, wallDummy.matrix);
        }
        for (const mesh of [plinths, columns, runeSlabs, runeLines, runeRings, rubble, lintels, gateArches, ruinMoss, pillarFootings, wallSegments, wallPosts, outerRings]) {
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          mesh.castShadow =
            mesh === columns || mesh === runeSlabs || mesh === lintels || mesh === wallSegments || mesh === wallPosts;
          mesh.receiveShadow = true;
          terrainRoot.add(mesh);
        }
      }


      if (ruinCauseways.length) {
        const causewayPieces: { x: number; z: number; rot: number; length: number; y: number }[] = [];
        const causewayRails: { x: number; z: number; rot: number; length: number; y: number }[] = [];
        for (const causeway of ruinCauseways) {
          const count = Math.max(3, Math.min(8, Math.ceil(causeway.length / 1.35)));
          const spacing = causeway.length / count;
          const pieceLength = spacing * 0.78;
          for (let i = 0; i < count; i++) {
            const along = -causeway.length * 0.5 + spacing * (i + 0.5);
            const x = causeway.x + Math.cos(causeway.rot) * along;
            const z = causeway.z - Math.sin(causeway.rot) * along;
            causewayPieces.push({
              x, z, rot: causeway.rot, length: pieceLength, y: causeway.y + 0.065,
            });
            for (const side of [-1, 1]) {
              causewayRails.push({
                x: x + Math.sin(causeway.rot) * side * 0.43,
                z: z + Math.cos(causeway.rot) * side * 0.43,
                rot: causeway.rot,
                length: pieceLength * 0.88,
                y: causeway.y + 0.145,
              });
            }
          }
        }
        const decks = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1), shared.bridgeStone, causewayPieces.length,
        );
        const inlays = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1), shared.foundationGold, causewayPieces.length,
        );
        const rails = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1), shared.ruinStone, causewayRails.length,
        );
        const dummy = new THREE.Object3D();
        for (let i = 0; i < causewayPieces.length; i++) {
          const piece = causewayPieces[i];
          dummy.position.set(piece.x, piece.y, piece.z);
          dummy.rotation.set(0, piece.rot, 0);
          dummy.scale.set(piece.length, 0.13, 0.84);
          dummy.updateMatrix();
          decks.setMatrixAt(i, dummy.matrix);
          dummy.position.y = piece.y + 0.075;
          dummy.scale.set(piece.length * 0.62, 0.018, 0.045);
          dummy.updateMatrix();
          inlays.setMatrixAt(i, dummy.matrix);
        }
        for (let i = 0; i < causewayRails.length; i++) {
          const rail = causewayRails[i];
          dummy.position.set(rail.x, rail.y, rail.z);
          dummy.rotation.set(0, rail.rot, 0);
          dummy.scale.set(rail.length, 0.14, 0.075);
          dummy.updateMatrix();
          rails.setMatrixAt(i, dummy.matrix);
        }
        for (const mesh of [decks, inlays, rails]) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = mesh === decks || mesh === rails;
          mesh.receiveShadow = true;
          terrainRoot.add(mesh);
        }
      }


      if (beaconSites.length) {
        const beaconBases = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.36, 0.48, 0.22, 8),
          shared.foundationStone,
          beaconSites.length,
        );
        const beaconShafts = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.16, 0.22, 1.28, 8),
          shared.blue,
          beaconSites.length,
        );
        const beaconCollars = new THREE.InstancedMesh(
          new THREE.TorusGeometry(0.27, 0.038, 6, 24),
          shared.brightGold,
          beaconSites.length,
        );
        const beaconCrowns = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.34, 0.44, 6),
          shared.gold,
          beaconSites.length,
        );
        const beaconCrystals = new THREE.InstancedMesh(
          new THREE.OctahedronGeometry(0.245, 1),
          shared.chargeCrystal,
          beaconSites.length,
        );
        const beaconFins = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.052, 0.42, 4),
          shared.foundationGold,
          beaconSites.length * 4,
        );
        const dummy = new THREE.Object3D();
        for (let i = 0; i < beaconSites.length; i++) {
          const site = beaconSites[i];
          const baseY = site.y;
          dummy.position.set(site.x, baseY + 0.11, site.z);
          dummy.rotation.set(0, site.seed * Math.PI * 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          beaconBases.setMatrixAt(i, dummy.matrix);

          dummy.position.set(site.x, baseY + 0.82, site.z);
          dummy.rotation.set(0, site.seed * Math.PI * 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          beaconShafts.setMatrixAt(i, dummy.matrix);

          dummy.position.set(site.x, baseY + 1.42, site.z);
          dummy.rotation.set(Math.PI / 2, site.seed * Math.PI * 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          beaconCollars.setMatrixAt(i, dummy.matrix);

          dummy.position.set(site.x, baseY + 1.72, site.z);
          dummy.rotation.set(0, site.seed * Math.PI * 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          beaconCrowns.setMatrixAt(i, dummy.matrix);

          dummy.position.set(site.x, baseY + 2.08, site.z);
          dummy.rotation.set(0, site.seed * Math.PI * 2, 0);
          dummy.scale.set(1, 1.16, 0.86);
          dummy.updateMatrix();
          beaconCrystals.setMatrixAt(i, dummy.matrix);

          for (let fin = 0; fin < 4; fin++) {
            const angle = site.seed * Math.PI * 2 + fin * Math.PI / 2;
            dummy.position.set(
              site.x + Math.cos(angle) * 0.29,
              baseY + 1.86,
              site.z + Math.sin(angle) * 0.29,
            );
            dummy.rotation.set(0.12 * Math.cos(angle), angle, 0.12 * Math.sin(angle));
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            beaconFins.setMatrixAt(i * 4 + fin, dummy.matrix);
          }
          if (i < 3) {
            const glow = new THREE.PointLight(site.offshore ? "#8bdde0" : "#8de8ce", site.offshore ? 0.48 : 0.56, 8.5, 2);
            glow.position.set(site.x, baseY + 2.32, site.z);
            glow.castShadow = false;
            terrainRoot.add(glow);
            landmarkLights.push({ light: glow, phase: 30 + i * 1.7, intensity: site.offshore ? 0.48 : 0.56 });
          }
        }
        for (const mesh of [beaconBases, beaconShafts, beaconCollars, beaconCrowns, beaconCrystals, beaconFins]) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = mesh === beaconShafts || mesh === beaconCrowns || mesh === beaconFins;
          mesh.receiveShadow = true;
          terrainRoot.add(mesh);
        }
      }

      // 古代石橋只生成在完整／自訂地圖的障礙地形上；道路與可建造格一律不會被覆蓋。
      const bridgeSites: { x: number; z: number; rot: number; deckY: number; lowY: number }[] = [];
      if (data.mapMode === "layout") {
        const bridgeAxes = [
          { dc: 1, dr: 0, rot: 0 },
          { dc: 0, dr: 1, rot: Math.PI / 2 },
        ];
        for (const cell of tileCells.values()) {
          const gx = Math.floor(cell.x);
          const gy = Math.floor(cell.z);
          const centerKey = gx + "," + gy;
          if (!data.blocked.has(centerKey) || cell.h > 1) continue;
          const nearBuilding = protectedBuildings.some((building) =>
            Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 2.2,
          );
          if (nearBuilding) continue;
          for (const axis of bridgeAxes) {
            const aKey = (gx - axis.dc) + "," + (gy - axis.dr);
            const bKey = (gx + axis.dc) + "," + (gy + axis.dr);
            const a = tileCells.get(aKey);
            const b = tileCells.get(bKey);
            if (!a || !b || !data.blocked.has(aKey) || !data.blocked.has(bKey)) continue;
            if (a.h < 2 || a.h !== b.h) continue;
            if (bridgeSites.some((site) => Math.hypot(cell.x - site.x, cell.z - site.z) < 9)) continue;
            bridgeSites.push({
              x: cell.x,
              z: cell.z,
              rot: axis.rot,
              deckY: groundTop(a.h) + 0.06,
              lowY: groundTop(cell.h),
            });
            if (bridgeSites.length >= 5) break;
          }
          if (bridgeSites.length >= 5) break;
        }
      }
      if (bridgeSites.length) {
        const decks = new THREE.InstancedMesh(
          new THREE.BoxGeometry(2.62, 0.14, 0.92),
          shared.bridgeStone,
          bridgeSites.length,
        );
        const parapets = new THREE.InstancedMesh(
          new THREE.BoxGeometry(2.58, 0.18, 0.085),
          shared.ruinStone,
          bridgeSites.length * 2,
        );
        const supports = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.24, 1, 0.24),
          shared.cliff,
          bridgeSites.length * 2,
        );
        const trim = new THREE.InstancedMesh(
          new THREE.BoxGeometry(2.42, 0.025, 0.035),
          shared.bridgeTrim,
          bridgeSites.length * 2,
        );
        const planks = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.11, 0.022, 0.78),
          shared.foundationStone,
          bridgeSites.length * 7,
        );
        const dummy = new THREE.Object3D();
        for (let i = 0; i < bridgeSites.length; i++) {
          const site = bridgeSites[i];
          dummy.position.set(site.x, site.deckY - 0.07, site.z);
          dummy.rotation.set(0, site.rot, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          decks.setMatrixAt(i, dummy.matrix);

          for (let side = 0; side < 2; side++) {
            const sign = side === 0 ? -1 : 1;
            dummy.position.set(
              site.x + Math.sin(site.rot) * sign * 0.38,
              site.deckY + 0.09,
              site.z + Math.cos(site.rot) * sign * 0.38,
            );
            dummy.rotation.set(0, site.rot, 0);
            dummy.updateMatrix();
            parapets.setMatrixAt(i * 2 + side, dummy.matrix);

            dummy.position.set(
              site.x + Math.cos(site.rot) * 0.92,
              site.lowY + (site.deckY - site.lowY) * 0.5,
              site.z - Math.sin(site.rot) * 0.92,
            );
            dummy.scale.set(1, Math.max(0.08, site.deckY - site.lowY), 1);
            dummy.rotation.set(0, site.rot, 0);
            dummy.updateMatrix();
            supports.setMatrixAt(i * 2 + side, dummy.matrix);

            dummy.position.set(
              site.x + Math.sin(site.rot) * sign * 0.385,
              site.deckY + 0.185,
              site.z + Math.cos(site.rot) * sign * 0.385,
            );
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, site.rot, 0);
            dummy.updateMatrix();
            trim.setMatrixAt(i * 2 + side, dummy.matrix);
          }

          for (let plank = 0; plank < 7; plank++) {
            const along = (plank - 3) * 0.33;
            dummy.position.set(
              site.x + Math.cos(site.rot) * along,
              site.deckY + 0.014,
              site.z - Math.sin(site.rot) * along,
            );
            dummy.rotation.set(0, site.rot, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            planks.setMatrixAt(i * 7 + plank, dummy.matrix);
          }
        }
        for (const mesh of [decks, parapets, supports, trim, planks]) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = mesh === decks || mesh === parapets;
          mesh.receiveShadow = true;
          terrainRoot.add(mesh);
        }
        // 古橋中央加暖色光，不投影，作為遠處可辨識的少量視覺節點。
        for (let i = 0; i < Math.min(2, bridgeSites.length); i++) {
          const site = bridgeSites[i];
          const glow = new THREE.PointLight("#f0c98e", 0.38, 6.5, 2);
          glow.position.set(site.x, site.deckY + 0.32, site.z);
          glow.castShadow = false;
          terrainRoot.add(glow);
          landmarkLights.push({ light: glow, phase: 20 + i * 2.1, intensity: 0.38 });
        }
      }

      // 裸露邊緣的層理岩壁：高度差越大，側面越深、越厚。
      const cliffDirections = [
        { dc: 0, dr: -1, dx: 0, dz: -0.46, sx: 0.94, sz: 0.08 },
        { dc: 1, dr: 0, dx: 0.46, dz: 0, sx: 0.08, sz: 0.94 },
        { dc: 0, dr: 1, dx: 0, dz: 0.46, sx: 0.94, sz: 0.08 },
        { dc: -1, dr: 0, dx: -0.46, dz: 0, sx: 0.08, sz: 0.94 },
      ];
      const cliffFaces: { x: number; y: number; z: number; sx: number; sy: number; sz: number; bandY: number; upperBandY: number }[] = [];
      const rockCracks: { x: number; y: number; z: number; nx: number; nz: number; height: number; width: number; seed: number }[] = [];
      const caveEntrances: { x: number; y: number; z: number; rot: number; scale: number }[] = [];
      const cliffRibs: { x: number; y: number; z: number; rot: number; height: number; tint: string }[] = [];
      const cliffLedges: { x: number; y: number; z: number; rot: number }[] = [];
      const heightRims: { x: number; y: number; z: number; rot: number; width: number; depth: number; tint: string }[] = [];
      const cliffFragments: {
        x: number; y: number; z: number;
        rx: number; ry: number; rz: number;
        sx: number; sy: number; sz: number;
        tint: string;
      }[] = [];
      const ridgeSupports: { x: number; y: number; z: number; rot: number; height: number; tint: string }[] = [];
      const talusDebris: { x: number; y: number; z: number; scale: number; rot: number; tint: string }[] = [];
      for (const cell of tileCells.values()) {
        if (cell.h <= 0) continue;
        const gx = Math.floor(cell.x), gy = Math.floor(cell.z);
        for (const d of cliffDirections) {
          const neighbor = tileCells.get((gx + d.dc) + "," + (gy + d.dr));
          const neighborH = neighbor?.h ?? 0;
          if (neighborH >= cell.h) continue;
          const high = groundTop(cell.h);
          const low = groundTop(neighborH);
          cliffFaces.push({
            x: cell.x + d.dx,
            y: (high + low) / 2,
            z: cell.z + d.dz,
            sx: d.sx,
            sy: high - low,
            sz: d.sz,
            bandY: low + (high - low) * 0.28,
            upperBandY: low + (high - low) * 0.68,
          });

          // 依高度做出 1／2／3 層不同的岩台外沿：層數就是高度等級，岩沿逐層向外挑出。
          const rimRot = d.dc === 0 ? 0 : Math.PI / 2;
          for (let layer = 0; layer < cell.h; layer++) {
            const levelTint =
              cell.h === 1
                ? "#789477"
                : cell.h === 2
                  ? (layer === 0 ? "#d1bd91" : "#788d79")
                  : (layer === 0 ? "#ead6a9" : layer === 1 ? "#b39f79" : "#627d70");
            const offset = 0.445 + layer * 0.032;
            heightRims.push({
              x: cell.x + Math.sign(d.dx) * offset,
              y: high - 0.028 - layer * 0.115,
              z: cell.z + Math.sign(d.dz) * offset,
              rot: rimRot,
              width: 0.94 - layer * 0.035,
              depth: 0.13 + layer * 0.018,
              tint: levelTint,
            });
          }


          // 二、三級高地的裸露斷面偶爾加上石灰岩支撐脊柱；只貼在側壁，不佔平台可建造面。
          const ridgeVertical = high - low;
          const ridgeSeed = Math.abs(Math.sin(cell.x * 61.7 + cell.z * 37.9 + d.dc * 13.1 + d.dr * 29.3) * 24817.31) % 1;
          const nearRidgeBuilding = protectedBuildings.some((building) =>
            Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 1.05,
          );
          if (
            cell.h >= 2 && ridgeVertical >= 0.78 && ridgeSeed > 0.905 &&
            ridgeSupports.length < 220 && !nearRidgeBuilding
          ) {
            ridgeSupports.push({
              x: cell.x + d.dx * 0.505,
              y: low + ridgeVertical * 0.43,
              z: cell.z + d.dz * 0.505,
              rot: Math.atan2(d.dx, d.dz),
              height: ridgeVertical * 0.78,
              tint: ridgeSeed > 0.965 ? "#b9b29a" : "#78877a",
            });
          }

          // 斷層表面隨機生成薄片狀岩角，角度、厚度和色階有細微變化，避免連續牆面像積木。          // 斷層表面隨機生成薄片狀岩角，角度、厚度和色階有細微變化，避免連續牆面像積木。
          const faceSeed = Math.abs(Math.sin(cell.x * 43.17 + cell.z * 91.73 + d.dc * 17.1 + d.dr * 31.7) * 28543.31) % 1;
          const crackSeed = Math.abs(Math.sin(cell.x * 97.3 + cell.z * 41.9 + d.dc * 23.1 + d.dr * 17.7) * 26173.91) % 1;
          if (cell.h >= 2 && crackSeed > 0.84 && rockCracks.length < 620) {
            const along = (crackSeed - 0.5) * 0.54;
            rockCracks.push({
              x: cell.x + d.dx * 1.015 + (d.dc === 0 ? along : 0),
              y: low + (high - low) * (0.34 + crackSeed * 0.2),
              z: cell.z + d.dz * 1.015 + (d.dr === 0 ? along : 0),
              nx: d.dc,
              nz: d.dr,
              height: 0.16 + crackSeed * 0.18,
              width: 0.018 + crackSeed * 0.012,
              seed: crackSeed,
            });
          }
          if (cell.h >= 1 && faceSeed > 0.42) {
            const vertical = high - low;
            const along = (faceSeed - 0.5) * 0.48;
            const sideDepth = 0.515;
            const acrossX = d.dc === 0 ? along : 0;
            const acrossZ = d.dr === 0 ? along : 0;
            const width = 0.18 + faceSeed * 0.12;
            const height = Math.min(vertical * 0.62, 0.16 + faceSeed * 0.17);
            cliffFragments.push({
              x: cell.x + Math.sign(d.dx) * sideDepth + acrossX,
              y: low + vertical * (0.28 + faceSeed * 0.38),
              z: cell.z + Math.sign(d.dz) * sideDepth + acrossZ,
              rx: (faceSeed - 0.5) * 0.7,
              ry: faceSeed * Math.PI * 2,
              rz: (faceSeed - 0.5) * 0.85,
              sx: d.dc === 0 ? width : 0.11 + faceSeed * 0.06,
              sy: height,
              sz: d.dr === 0 ? width : 0.11 + faceSeed * 0.06,
              tint: faceSeed > 0.76 ? "#a49b7e" : faceSeed > 0.58 ? "#83907a" : "#536a61",
            });
            if (cell.h >= 2 && faceSeed > 0.86) {
              cliffFragments.push({
                x: cell.x + Math.sign(d.dx) * (sideDepth + 0.01) - acrossX * 0.62,
                y: low + vertical * (0.62 + faceSeed * 0.12),
                z: cell.z + Math.sign(d.dz) * (sideDepth + 0.01) - acrossZ * 0.62,
                rx: (faceSeed - 0.5) * 0.95,
                ry: faceSeed * Math.PI * 2 + 0.7,
                rz: (faceSeed - 0.5) * 0.9,
                sx: d.dc === 0 ? width * 0.72 : 0.1,
                sy: height * 0.68,
                sz: d.dr === 0 ? width * 0.72 : 0.1,
                tint: "#b6aa88",
              });
            }
          }

          const verticalFace = high - low;
          const caveSeed = Math.abs(Math.sin(cell.x * 31.7 + cell.z * 73.1 + d.dc * 11.3 + d.dr * 19.7) * 29713.91) % 1;
          if (
            cell.h >= 2 &&
            verticalFace >= 0.82 &&
            caveSeed > 0.945 &&
            caveEntrances.length < 28 &&
            !protectedBuildings.some((building) =>
              Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 1.6,
            )
          ) {
            caveEntrances.push({
              x: cell.x + d.dx * 1.12,
              y: low + verticalFace * 0.48,
              z: cell.z + d.dz * 1.12,
              rot: Math.atan2(d.dx, d.dz),
              scale: Math.min(1, verticalFace / 1.1),
            });
          }
          if (cell.h >= 3 && verticalFace >= 0.82 && faceSeed > 0.93 && cliffRibs.length < 120) {
            cliffRibs.push({
              x: cell.x + d.dx * 1.14,
              y: low + verticalFace * 0.52,
              z: cell.z + d.dz * 1.14,
              rot: Math.atan2(d.dx, d.dz),
              height: verticalFace * (0.72 + faceSeed * 0.16),
              tint: faceSeed > 0.97 ? "#c2b69a" : "#758176",
            });
          }

          if (neighbor && neighbor.h > 0 && cell.h >= neighbor.h + 1) {
            // 低側平台只在非道路格留下少量崩落碎石，並避開塔座和聖地周圍。
            const rubbleSeed = Math.abs(Math.sin(cell.x * 17.9 + cell.z * 61.3 + d.dc * 9.1 + d.dr * 21.7) * 17281.91) % 1;
            if (rubbleSeed > 0.62) {
              const lowerX = cell.x + d.dc * 0.66;
              const lowerZ = cell.z + d.dr * 0.66;
              const nearBuilding = protectedBuildings.some((building) =>
                Math.hypot(lowerX - building.x, lowerZ - building.z) < building.radius + 0.35,
              );
              if (!nearBuilding) {
                talusDebris.push({
                  x: lowerX + (rubbleSeed - 0.5) * 0.18,
                  y: groundTop(neighbor.h) + 0.045,
                  z: lowerZ + (0.5 - rubbleSeed) * 0.18,
                  scale: 0.055 + rubbleSeed * 0.055,
                  rot: rubbleSeed * Math.PI * 2,
                  tint: rubbleSeed > 0.82 ? "#b2a384" : "#778273",
                });
              }
            }
          }

          if (cell.h >= 2 && neighbor) {
            cliffLedges.push({
              x: cell.x + d.dx * 0.84,
              y: high + 0.012,
              z: cell.z + d.dz * 0.84,
              rot: d.dc === 0 ? 0 : Math.PI / 2,
            });
          }
        }
      }
      if (cliffFaces.length) {
        const cliffMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), shared.cliff, cliffFaces.length);
        const bandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), shared.cliffBand, cliffFaces.length);
        const upperBandMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), shared.cliffBandLight, cliffFaces.length);
        const capMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), shared.cliffCap, cliffFaces.length);
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < cliffFaces.length; i++) {
          const face = cliffFaces[i];
          matrix.makeScale(face.sx, face.sy, face.sz);
          matrix.setPosition(face.x, face.y, face.z);
          cliffMesh.setMatrixAt(i, matrix);
          matrix.makeScale(face.sx, 0.035, Math.max(face.sz, 0.11));
          matrix.setPosition(face.x, face.bandY, face.z);
          bandMesh.setMatrixAt(i, matrix);
          matrix.makeScale(face.sx, 0.032, Math.max(face.sz, 0.11));
          matrix.setPosition(face.x, face.upperBandY, face.z);
          upperBandMesh.setMatrixAt(i, matrix);
          matrix.makeScale(face.sx * 1.04, 0.055, Math.max(face.sz * 1.18, 0.12));
          matrix.setPosition(face.x, face.y + face.sy / 2 - 0.015, face.z);
          capMesh.setMatrixAt(i, matrix);
        }
        cliffMesh.instanceMatrix.needsUpdate = true;
        bandMesh.instanceMatrix.needsUpdate = true;
        upperBandMesh.instanceMatrix.needsUpdate = true;
        capMesh.instanceMatrix.needsUpdate = true;
        cliffMesh.castShadow = true;
        cliffMesh.receiveShadow = true;
        bandMesh.receiveShadow = true;
        upperBandMesh.receiveShadow = true;
        capMesh.castShadow = true;
        capMesh.receiveShadow = true;
        terrainRoot.add(cliffMesh, bandMesh, upperBandMesh, capMesh);
      }
      if (rockCracks.length) {
        const crackMesh = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          shared.rockCrack,
          rockCracks.length,
        );
        const crackEdgeMesh = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          shared.rockCrackEdge,
          rockCracks.length,
        );
        const crackDummy = new THREE.Object3D();
        for (let i = 0; i < rockCracks.length; i++) {
          const crack = rockCracks[i];
          const faceX = crack.nx !== 0;
          crackDummy.position.set(
            crack.x + (faceX ? crack.nx * 0.009 : 0),
            crack.y,
            crack.z + (faceX ? 0 : crack.nz * 0.009),
          );
          crackDummy.rotation.set(
            faceX ? (crack.seed - 0.5) * 0.16 : 0,
            0,
            faceX ? 0 : (crack.seed - 0.5) * 0.16,
          );
          crackDummy.scale.set(faceX ? 0.014 : crack.width, crack.height, faceX ? crack.width : 0.014);
          crackDummy.updateMatrix();
          crackMesh.setMatrixAt(i, crackDummy.matrix);

          crackDummy.position.x += faceX ? 0 : crack.width * 0.8;
          crackDummy.position.z += faceX ? -crack.width * 0.8 : 0;
          crackDummy.scale.set(faceX ? 0.01 : crack.width * 0.36, crack.height * 0.62, faceX ? crack.width * 0.36 : 0.01);
          crackDummy.updateMatrix();
          crackEdgeMesh.setMatrixAt(i, crackDummy.matrix);
        }
        crackMesh.instanceMatrix.needsUpdate = true;
        crackEdgeMesh.instanceMatrix.needsUpdate = true;
        crackMesh.castShadow = false;
        crackMesh.receiveShadow = false;
        crackEdgeMesh.castShadow = false;
        crackEdgeMesh.receiveShadow = false;
        terrainRoot.add(crackMesh, crackEdgeMesh);
      }
      if (caveEntrances.length) {
        const caveMouths = new THREE.InstancedMesh(
          new THREE.CircleGeometry(0.255, 24),
          shared.caveShadow,
          caveEntrances.length,
        );
        const caveArches = new THREE.InstancedMesh(
          new THREE.TorusGeometry(0.29, 0.055, 7, 24, Math.PI),
          shared.caveRim,
          caveEntrances.length,
        );
        const dummy = new THREE.Object3D();
        for (let i = 0; i < caveEntrances.length; i++) {
          const cave = caveEntrances[i];
          dummy.position.set(cave.x + Math.sin(cave.rot) * 0.012, cave.y, cave.z + Math.cos(cave.rot) * 0.012);
          dummy.rotation.set(0, cave.rot, 0);
          dummy.scale.setScalar(cave.scale);
          dummy.updateMatrix();
          caveMouths.setMatrixAt(i, dummy.matrix);
          dummy.position.set(cave.x + Math.sin(cave.rot) * 0.024, cave.y, cave.z + Math.cos(cave.rot) * 0.024);
          dummy.rotation.set(0, cave.rot, 0);
          dummy.scale.setScalar(cave.scale);
          dummy.updateMatrix();
          caveArches.setMatrixAt(i, dummy.matrix);
        }
        caveMouths.instanceMatrix.needsUpdate = true;
        caveArches.instanceMatrix.needsUpdate = true;
        caveMouths.castShadow = false;
        caveMouths.receiveShadow = false;
        caveArches.castShadow = true;
        caveArches.receiveShadow = true;
        terrainRoot.add(caveMouths, caveArches);

        // 最多 4 處洞口使用不投影的青綠微光，讓洞穴有深度而不增加陰影成本。
        for (let i = 0; i < Math.min(4, caveEntrances.length); i++) {
          const cave = caveEntrances[i];
          const glow = new THREE.PointLight("#59cdb5", 0.46, 5.8, 2);
          glow.position.set(
            cave.x + Math.sin(cave.rot) * 0.28,
            cave.y + 0.02,
            cave.z + Math.cos(cave.rot) * 0.28,
          );
          glow.castShadow = false;
          terrainRoot.add(glow);
          landmarkLights.push({ light: glow, phase: i * 1.7, intensity: 0.46 });
        }
      }

      if (cliffRibs.length) {
        const ribs = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.17, 1, 0.13),
          shared.cliffFacet,
          cliffRibs.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < cliffRibs.length; i++) {
          const rib = cliffRibs[i];
          dummy.position.set(rib.x, rib.y, rib.z);
          dummy.rotation.set(0, rib.rot, 0);
          dummy.scale.set(1, rib.height, 1);
          dummy.updateMatrix();
          ribs.setMatrixAt(i, dummy.matrix);
          tint.set(rib.tint);
          ribs.setColorAt(i, tint);
        }
        ribs.instanceMatrix.needsUpdate = true;
        if (ribs.instanceColor) ribs.instanceColor.needsUpdate = true;
        ribs.castShadow = true;
        ribs.receiveShadow = true;
        terrainRoot.add(ribs);
      }


      if (ridgeSupports.length) {
        const supports = new THREE.InstancedMesh(
          new THREE.CylinderGeometry(0.12, 0.205, 1, 5),
          shared.cliffFacet,
          ridgeSupports.length,
        );
        const supportCaps = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.27, 0.075, 0.25),
          shared.cliffCap,
          ridgeSupports.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < ridgeSupports.length; i++) {
          const support = ridgeSupports[i];
          dummy.position.set(support.x, support.y, support.z);
          dummy.rotation.set(0, support.rot, 0);
          dummy.scale.set(1, support.height, 1);
          dummy.updateMatrix();
          supports.setMatrixAt(i, dummy.matrix);
          tint.set(support.tint);
          supports.setColorAt(i, tint);

          dummy.position.set(support.x, support.y + support.height * 0.48, support.z);
          dummy.rotation.set(0, support.rot, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          supportCaps.setMatrixAt(i, dummy.matrix);
        }
        supports.instanceMatrix.needsUpdate = true;
        supportCaps.instanceMatrix.needsUpdate = true;
        if (supports.instanceColor) supports.instanceColor.needsUpdate = true;
        supports.castShadow = true;
        supports.receiveShadow = true;
        supportCaps.castShadow = true;
        supportCaps.receiveShadow = true;
        terrainRoot.add(supports, supportCaps);
      }

      if (cliffFragments.length) {
        const fragments = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.22, 0),
          shared.cliffFacet,
          cliffFragments.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < cliffFragments.length; i++) {
          const fragment = cliffFragments[i];
          dummy.position.set(fragment.x, fragment.y, fragment.z);
          dummy.rotation.set(fragment.rx, fragment.ry, fragment.rz);
          dummy.scale.set(fragment.sx / 0.22, fragment.sy / 0.22, fragment.sz / 0.22);
          dummy.updateMatrix();
          fragments.setMatrixAt(i, dummy.matrix);
          tint.set(fragment.tint);
          fragments.setColorAt(i, tint);
        }
        fragments.instanceMatrix.needsUpdate = true;
        if (fragments.instanceColor) fragments.instanceColor.needsUpdate = true;
        fragments.castShadow = true;
        fragments.receiveShadow = true;
        terrainRoot.add(fragments);
      }

      if (talusDebris.length) {
        const rubble = new THREE.InstancedMesh(
          new THREE.DodecahedronGeometry(0.075, 0),
          shared.rockDetail,
          talusDebris.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < talusDebris.length; i++) {
          const stone = talusDebris[i];
          dummy.position.set(stone.x, stone.y, stone.z);
          dummy.rotation.set(stone.rot * 0.22, stone.rot, stone.rot * -0.16);
          dummy.scale.setScalar(stone.scale / 0.075);
          dummy.updateMatrix();
          rubble.setMatrixAt(i, dummy.matrix);
          tint.set(stone.tint);
          rubble.setColorAt(i, tint);
        }
        rubble.instanceMatrix.needsUpdate = true;
        if (rubble.instanceColor) rubble.instanceColor.needsUpdate = true;
        rubble.castShadow = false;
        rubble.receiveShadow = true;
        terrainRoot.add(rubble);
      }

      if (heightRims.length) {
        const rims = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          shared.heightRim,
          heightRims.length,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < heightRims.length; i++) {
          const rim = heightRims[i];
          dummy.position.set(rim.x, rim.y, rim.z);
          dummy.rotation.y = rim.rot;
          dummy.scale.set(rim.width, 0.036, rim.depth);
          dummy.updateMatrix();
          rims.setMatrixAt(i, dummy.matrix);
          tint.set(rim.tint);
          rims.setColorAt(i, tint);
        }
        rims.instanceMatrix.needsUpdate = true;
        if (rims.instanceColor) rims.instanceColor.needsUpdate = true;
        rims.castShadow = true;
        rims.receiveShadow = true;
        terrainRoot.add(rims);
      }

      if (cliffLedges.length) {
        const ledges = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.92, 0.026, 0.13),
          shared.cliffLip,
          cliffLedges.length,
        );
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < cliffLedges.length; i++) {
          const ledge = cliffLedges[i];
          matrix.makeRotationY(ledge.rot);
          matrix.setPosition(ledge.x, ledge.y, ledge.z);
          ledges.setMatrixAt(i, matrix);
        }
        ledges.instanceMatrix.needsUpdate = true;
        ledges.receiveShadow = true;
        terrainRoot.add(ledges);
      }

      // 單級坡面連接相鄰平台；道路高度 0 不鋪坡，避免遮住怪物通道。
      const rampDirections = [
        { dc: 0, dr: -1, rot: 0 },
        { dc: 1, dr: 0, rot: -Math.PI / 2 },
        { dc: 0, dr: 1, rot: Math.PI },
        { dc: -1, dr: 0, rot: Math.PI / 2 },
      ];
      const rampGeometry = new THREE.BufferGeometry();
      rampGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
        -0.46, HEIGHT_STEP, -0.46, 0.46, HEIGHT_STEP, -0.46,
        -0.46, 0, 0.46, 0.46, 0, 0.46,
      ], 3));
      rampGeometry.setIndex([0, 2, 1, 1, 2, 3]);
      rampGeometry.computeVertexNormals();
      const rampCells: { x: number; y: number; z: number; rot: number; level: number }[] = [];
      for (const cell of tileCells.values()) {
        if (cell.h <= 0) continue;
        const gx = Math.floor(cell.x), gy = Math.floor(cell.z);
        const nearBuilding = protectedBuildings.some((building) =>
          Math.hypot(cell.x - building.x, cell.z - building.z) < building.radius + 0.58,
        );
        if (nearBuilding) continue;
        const higher = rampDirections.find((d) => {
          const neighbor = tileCells.get((gx + d.dc) + "," + (gy + d.dr));
          return !!neighbor && neighbor.h === cell.h + 1;
        });
        if (higher) rampCells.push({ x: cell.x, y: groundTop(cell.h) + 0.012, z: cell.z, rot: higher.rot, level: cell.h });
      }
      if (rampCells.length) {
        const ramps = new THREE.InstancedMesh(rampGeometry, shared.ramp, rampCells.length);
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < rampCells.length; i++) {
          const ramp = rampCells[i];
          matrix.makeRotationY(ramp.rot);
          matrix.setPosition(ramp.x, ramp.y, ramp.z);
          ramps.setMatrixAt(i, matrix);
        }
        ramps.instanceMatrix.needsUpdate = true;
        ramps.receiveShadow = true;
        terrainRoot.add(ramps);

        // 少量坡道側邊定位柱強化落差與可走方向；最多 180 段，並且只落在避開建築的坡面。
        const detailedRamps = rampCells.filter((ramp) => {
          const seed = Math.abs(Math.sin(ramp.x * 47.3 + ramp.z * 83.1 + ramp.rot * 13.7) * 21731.9) % 1;
          return seed > 0.58;
        }).slice(0, 180);
        if (detailedRamps.length) {
          const rampPosts = new THREE.InstancedMesh(
            new THREE.BoxGeometry(0.085, 0.15, 0.09),
            shared.cliffLip,
            detailedRamps.length * 4,
          );
          const rampPostCaps = new THREE.InstancedMesh(
            new THREE.OctahedronGeometry(0.055, 0),
            shared.foundationGold,
            detailedRamps.length * 4,
          );
          const postDummy = new THREE.Object3D();
          for (let i = 0; i < detailedRamps.length; i++) {
            const ramp = detailedRamps[i];
            let postIndex = 0;
            for (const side of [-1, 1]) for (const localZ of [-0.25, 0.25]) {
              const heightAlongRamp = HEIGHT_STEP * (0.5 - localZ / 0.92) + 0.025;
              const worldX = ramp.x + Math.sin(ramp.rot) * localZ + Math.cos(ramp.rot) * side * 0.385;
              const worldZ = ramp.z + Math.cos(ramp.rot) * localZ - Math.sin(ramp.rot) * side * 0.385;
              const index = i * 4 + postIndex++;
              postDummy.position.set(worldX, ramp.y + heightAlongRamp + 0.075, worldZ);
              postDummy.rotation.set(0, ramp.rot, 0);
              postDummy.scale.set(1, 1, 1);
              postDummy.updateMatrix();
              rampPosts.setMatrixAt(index, postDummy.matrix);
              postDummy.position.y += 0.105;
              postDummy.scale.set(0.82, 0.82, 0.82);
              postDummy.updateMatrix();
              rampPostCaps.setMatrixAt(index, postDummy.matrix);
            }
          }
          rampPosts.instanceMatrix.needsUpdate = true;
          rampPostCaps.instanceMatrix.needsUpdate = true;
          rampPosts.castShadow = false;
          rampPosts.receiveShadow = true;
          rampPostCaps.castShadow = false;
          rampPostCaps.receiveShadow = false;
          terrainRoot.add(rampPosts, rampPostCaps);
        }

        // 部分坡面疊加三段薄石階，順著原坡度排列；只增加視覺層次，不遮住通道寬度。
        const stairRamps = rampCells.filter((ramp) => {
          const seed = Math.abs(Math.sin(ramp.x * 61.7 + ramp.z * 23.9) * 21731.19) % 1;
          return seed > 0.48 && !protectedBuildings.some((building) =>
            Math.hypot(ramp.x - building.x, ramp.z - building.z) < building.radius + 1.2,
          );
        });
        if (stairRamps.length) {
          const stairSteps = new THREE.InstancedMesh(
            new THREE.BoxGeometry(0.76, 0.045, 0.18),
            shared.rampStep,
            stairRamps.length * 3,
          );
          const stairDummy = new THREE.Object3D();
          for (let i = 0; i < stairRamps.length; i++) {
            const ramp = stairRamps[i];
            for (let step = 0; step < 3; step++) {
              const localZ = (step - 1) * 0.28;
              const heightAlongRamp = HEIGHT_STEP * (0.5 - localZ / 0.92) + 0.025;
              const worldX = ramp.x + Math.sin(ramp.rot) * localZ;
              const worldZ = ramp.z + Math.cos(ramp.rot) * localZ;
              stairDummy.position.set(worldX, ramp.y + heightAlongRamp, worldZ);
              stairDummy.rotation.set(0, ramp.rot, 0);
              stairDummy.scale.set(1, 1, 1);
              stairDummy.updateMatrix();
              stairSteps.setMatrixAt(i * 3 + step, stairDummy.matrix);
            }
          }
          stairSteps.instanceMatrix.needsUpdate = true;
          stairSteps.castShadow = false;
          stairSteps.receiveShadow = true;
          terrainRoot.add(stairSteps);
        }
      }

      // 海面已由上方深海／淺灘雙層承接，移除舊的單色底板以露出水域。
    };

    const updateFireflies = (time: number) => {
      if (!fireflyMesh || !fireflyEntries.length) return;
      let pulse = 0;
      for (let i = 0; i < fireflyEntries.length; i++) {
        const mote = fireflyEntries[i];
        const drift = Math.sin(time * 0.00048 + mote.phase);
        const orbit = time * 0.00016 + mote.phase;
        fireflyDummy.position.set(
          mote.x + Math.cos(orbit) * mote.radius,
          mote.y + drift * 0.11,
          mote.z + Math.sin(orbit) * mote.radius,
        );
        const shimmer = 0.72 + (Math.sin(time * 0.0017 + mote.phase) * 0.5 + 0.5) * 0.48;
        fireflyDummy.scale.setScalar(mote.scale * shimmer);
        fireflyDummy.updateMatrix();
        fireflyMesh.setMatrixAt(i, fireflyDummy.matrix);
        pulse += shimmer;
      }
      fireflyMesh.instanceMatrix.needsUpdate = true;
      shared.firefly.opacity = 0.24 + (pulse / fireflyEntries.length) * 0.25;
    };

    const updateWaterRipples = (time: number) => {
      waterBumpMap.offset.x = (time * 0.000006) % 1;
      waterBumpMap.offset.y = (time * 0.0000035) % 1;
      oceanSurfaceUniforms.time.value = time * 0.001;
      shoreFoamUniforms.time.value = time * 0.001;
      cliffStrataUniforms.time.value = time * 0.001;
      pollenUniforms.time.value = time * 0.001;
      // 海岸泡沫除了整體呼吸，還有依岸線位置錯相的流動脈衝。
      shared.shoreFoam.opacity = 0.62 + Math.sin(time * 0.00072) * 0.055;
      if (!waterRippleMesh || !waterRippleEntries.length) return;
      for (let i = 0; i < waterRippleEntries.length; i++) {
        const ripple = waterRippleEntries[i];
        const phase = (time * 0.00013 * ripple.speed + ripple.phase) % 1;
        const scale = 0.42 + phase * 1.42;
        waterRippleDummy.position.set(ripple.x, -0.259, ripple.z);
        waterRippleDummy.rotation.set(-Math.PI / 2, 0, ripple.phase * Math.PI);
        waterRippleDummy.scale.set(scale, scale, scale);
        waterRippleDummy.updateMatrix();
        waterRippleMesh.setMatrixAt(i, waterRippleDummy.matrix);
      }
      waterRippleMesh.instanceMatrix.needsUpdate = true;
      shared.waterRipple.opacity = 0.11 + (Math.sin(time * 0.0011) * 0.5 + 0.5) * 0.09;
      if (waterGlintMesh && waterGlintEntries.length) {
        for (let i = 0; i < waterGlintEntries.length; i++) {
          const glint = waterGlintEntries[i];
          const drift = Math.sin(time * 0.00042 + glint.phase);
          const pulse = 0.58 + (Math.sin(time * 0.0016 + glint.phase) * 0.5 + 0.5) * 0.62;
          waterGlintDummy.position.set(glint.x + drift * 0.065, -0.246, glint.z - drift * 0.045);
          waterGlintDummy.rotation.set(-Math.PI / 2, glint.rot + drift * 0.035, 0);
          waterGlintDummy.scale.set(glint.scale * pulse, 1, 1);
          waterGlintDummy.updateMatrix();
          waterGlintMesh.setMatrixAt(i, waterGlintDummy.matrix);
        }
        waterGlintMesh.instanceMatrix.needsUpdate = true;
        shared.waterGlint.opacity = 0.1 + (Math.sin(time * 0.0009) * 0.5 + 0.5) * 0.12;
      }
    };

    const rebuildBuildings = (data: Terrain3DSnapshot, animateTurrets: boolean, animateMainUpgrade: boolean) => {
      for (const effect of installationRings) effect.material.dispose();
      for (const effect of buildFlashEffects) effect.material.dispose();
      clearGroup(buildingRoot);
      rings.length = 0;
      gems.length = 0;
      turretGroups.length = 0;
      installationAnimations.length = 0;
      installationRings.length = 0;
      buildFlashEffects.length = 0;
      chargeCores.length = 0;
      for (let i = 0; i < data.towers.length; i++) {
        const tower = data.towers[i];
        const childIndex = buildingRoot.children.length;
        if (tower.sanctuary) createSanctuary(tower, data.heights, animateTurrets, animateMainUpgrade);
        else if (tower.stake) createStake(tower, data.heights);
        else createTowerBase(tower, data.heights);
        // 讓 3D 點擊能直接對應遊戲塔陣列索引，不再只靠地面距離猜測。
        const hitRoot = buildingRoot.children[childIndex];
        if (hitRoot) {
          const isSanctuary = !!tower.sanctuary;
          const hitWidth = isSanctuary ? 6.6 : 2.05;
          const hitHeight = isSanctuary ? 5.8 : 3.8;
          const hitBox = new THREE.Mesh(
            new THREE.BoxGeometry(hitWidth, hitHeight, hitWidth),
            buildingHitMaterial,
          );
          hitBox.position.y = hitHeight * 0.5;
          hitRoot.add(hitBox);
          hitRoot.userData.gameTowerIndex = i;
        }
      }
    };

    const ensureSprite = (list: any[], index: number, parent: any) => {
      if (!list[index]) {
        const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, alphaTest: 0.04 });
        const sprite = new THREE.Sprite(material);
        sprite.center.set(0.5, 0.12);
        parent.add(sprite);
        list[index] = sprite;
      }
      list[index].visible = true;
      return list[index];
    };

    const updateSpriteTexture = (sprite: any, image: HTMLImageElement | null | undefined) => {
      const nextTexture = image && image.complete && image.naturalWidth > 0 ? getTexture(image) : null;
      // 角色通常會連續數百幀使用同一張圖；只有素材真的切換時才觸發材質更新。
      if (sprite.material.map === nextTexture) return;
      sprite.material.map = nextTexture;
      sprite.material.needsUpdate = true;
    };

    const updateActors = (data: Terrain3DSnapshot, time: number) => {
      let spriteIndex = 0;
      for (const tower of data.towers) {
        if (tower.sanctuary || tower.stake) continue;
        const i = spriteIndex++;
        const sprite = ensureSprite(towerSprites, i, actorRoot);
        updateSpriteTexture(sprite, tower.image);
        const h = terrainHeightAt(tower.gx, tower.gy, data.heights);
        sprite.position.set(tower.x / CELL, groundTop(h) + 1.03 + Math.min(0.16, (tower.level - 1) * 0.025), tower.y / CELL);
        sprite.scale.set(1.42, 1.58, 1);
        sprite.renderOrder = 4;
      }
      for (let i = spriteIndex; i < towerSprites.length; i++) towerSprites[i].visible = false;

      for (let i = 0; i < data.enemies.length; i++) {
        const enemy = data.enemies[i];
        const sprite = ensureSprite(enemySprites, i, actorRoot);
        updateSpriteTexture(sprite, enemy.image);
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(enemy.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(enemy.y / CELL)));
        const h = terrainHeightAt(gx, gy, data.heights);
        const size = Math.max(0.72, (enemy.r * 3.3) / CELL);
        const squash = enemy.hurt > 0 ? 0.78 : 1;
        sprite.position.set(enemy.x / CELL, groundTop(h) + size * 0.42, enemy.y / CELL);
        sprite.scale.set(size * (enemy.face < 0 ? -1 : 1) * squash, size / squash, 1);
        sprite.material.opacity = enemy.hurt > 0 ? 0.84 : 1;
        sprite.renderOrder = 5;

        if (!enemyHealthBars[i]) {
          const back = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#091522", transparent: true, opacity: 0.9, depthWrite: false }));
          const fill = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#73d7a1", transparent: true, opacity: 0.95, depthWrite: false }));
          back.center.set(0.5, 0.5);
          fill.center.set(0.5, 0.5);
          actorRoot.add(back, fill);
          enemyHealthBars[i] = { back, fill };
        }
        const bar = enemyHealthBars[i];
        const ratio = Math.max(0, Math.min(1, enemy.hp / Math.max(1, enemy.maxHp)));
        const barWidth = Math.max(0.34, size * 0.76);
        const barY = groundTop(h) + size * 1.18;
        bar.back.position.set(enemy.x / CELL, barY, enemy.y / CELL);
        bar.back.scale.set(barWidth, 0.055, 1);
        bar.back.visible = enemy.hp > 0;
        bar.fill.position.set(enemy.x / CELL - (barWidth * (1 - ratio)) / 2, barY + 0.006, enemy.y / CELL);
        bar.fill.scale.set(Math.max(0.005, barWidth * ratio), 0.035, 1);
        bar.fill.material.color.set(ratio > 0.35 ? "#73d7a1" : "#ff657b");
        bar.fill.visible = enemy.hp > 0;
      }
      for (let i = data.enemies.length; i < enemySprites.length; i++) {
        enemySprites[i].visible = false;
        if (enemyHealthBars[i]) {
          enemyHealthBars[i].back.visible = false;
          enemyHealthBars[i].fill.visible = false;
        }
      }
    };

    const purificationAuraMaterial = new THREE.MeshBasicMaterial({
      color: "#77e8dc",
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const purificationAura = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.035, 8, 112),
      purificationAuraMaterial,
    );
    purificationAura.rotation.x = Math.PI / 2;
    purificationAura.visible = false;
    effectRoot.add(purificationAura);

    const updateBlackMist = (data: Terrain3DSnapshot, time: number) => {
      const power = THREE.MathUtils.clamp(data.sanctuaryPower ?? 0.12, 0, 1);
      const hq = data.towers.find((tower) => tower.sanctuary);
      roadGuideUniforms.origin.value.set(
        hq ? hq.x / CELL : COLS / 2,
        hq ? hq.y / CELL : ROWS / 2,
      );
      roadGuideUniforms.power.value = power;
      if (data.mapMode === "expand") {
        blackMistVeilUniforms.time.value = time * 0.001;
        // 黑霧覆蓋強度固定；真正的退霧只能由已取得地塊遮罩觸發。
        shared.blackMistField.opacity = 0.86;
        blackMistFrontUniforms.time.value = time * 0.001;
        blackMistFrontUniforms.power.value = power;
        blackMistFieldTexture.offset.set((time * 0.000006) % 1, (time * 0.000004) % 1);
      }
      if (blackMistMesh && blackMistEntries.length) {
        // 岸線霧絲維持穩定密度，不隨聖地升級而把未取得區域變淡。
        shared.blackMist.opacity = 0.72;
        for (let i = 0; i < blackMistEntries.length; i++) {
          const entry = blackMistEntries[i];
          const drift = Math.sin(time * 0.00034 + entry.phase);
          const pulse = 1 + Math.sin(time * 0.0011 + entry.phase) * 0.055;
          blackMistDummy.position.set(
            entry.x + entry.driftX * drift * 0.11,
            entry.y + Math.sin(time * 0.00072 + entry.phase) * 0.075,
            entry.z + entry.driftZ * drift * 0.11,
          );
          blackMistDummy.rotation.set(-Math.PI / 2, entry.rot + drift * 0.035, 0);
          blackMistDummy.scale.set(entry.scaleX * pulse, entry.scaleZ * pulse, 1);
          blackMistDummy.updateMatrix();
          blackMistMesh.setMatrixAt(i, blackMistDummy.matrix);
        }
        blackMistMesh.instanceMatrix.needsUpdate = true;
      }

      if (blackMistVeilMesh && blackMistVeilEntries.length) {
        shared.blackMistVeil.opacity = 0.46;
        for (let i = 0; i < blackMistVeilEntries.length; i++) {
          const veil = blackMistVeilEntries[i];
          const drift = Math.sin(time * 0.00023 + veil.phase);
          const pulse = 1 + Math.sin(time * 0.00041 + veil.phase) * 0.045;
          blackMistVeilDummy.position.set(
            veil.x + veil.driftX * drift * 0.16,
            veil.y + Math.sin(time * 0.00031 + veil.phase) * 0.13,
            veil.z + veil.driftZ * drift * 0.16,
          );
          blackMistVeilDummy.rotation.set(0, veil.rot + drift * 0.045, 0);
          blackMistVeilDummy.scale.set(veil.scaleX * pulse, veil.scaleY * pulse, 1);
          blackMistVeilDummy.updateMatrix();
          blackMistVeilMesh.setMatrixAt(i, blackMistVeilDummy.matrix);
        }
        blackMistVeilMesh.instanceMatrix.needsUpdate = true;
      }

      if (blackMistCloudMesh && blackMistCloudEntries.length) {
        shared.blackMistCloud.opacity = 0.25;
        for (let i = 0; i < blackMistCloudEntries.length; i++) {
          const cloud = blackMistCloudEntries[i];
          const drift = Math.sin(time * 0.00012 + cloud.phase);
          blackMistCloudDummy.position.set(
            cloud.x + cloud.driftX * drift * 2.2,
            -0.145 + Math.sin(time * 0.00018 + cloud.phase) * 0.018,
            cloud.z + cloud.driftZ * drift * 2.2,
          );
          const pulse = 1 + Math.sin(time * 0.0003 + cloud.phase) * 0.035;
          blackMistCloudDummy.scale.set(cloud.scaleX * pulse, 0.19, cloud.scaleZ * pulse);
          blackMistCloudDummy.rotation.y = cloud.phase + drift * 0.025;
          blackMistCloudDummy.updateMatrix();
          blackMistCloudMesh.setMatrixAt(i, blackMistCloudDummy.matrix);
        }
        blackMistCloudMesh.instanceMatrix.needsUpdate = true;
      }

      if (!hq || data.mapMode !== "expand") {
        purificationAura.visible = false;
        return;
      }
      const gx = Math.max(0, Math.min(COLS - 1, Math.floor(hq.x / CELL)));
      const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(hq.y / CELL)));
      const height = data.heights[gy * COLS + gx] ?? 0;
      purificationAura.visible = true;
      purificationAura.position.set(hq.x / CELL, groundTop(height) + 0.09, hq.y / CELL);
      // 聖地只保留貼近核心的結界圈；升級不再把視覺安全區無限放大。
      purificationAura.scale.setScalar(5.8);
      purificationAura.rotation.y = Math.sin(time * 0.00022) * 0.045;
      purificationAuraMaterial.opacity = 0.11 + power * 0.13;
    };

    const selectedRangeMaterial = new THREE.MeshBasicMaterial({ color: "#a7e8dc", transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false });
    const selectedRange = new THREE.Mesh(new THREE.TorusGeometry(1, 0.018, 8, 96), selectedRangeMaterial);
    selectedRange.rotation.x = Math.PI / 2;
    selectedRange.visible = false;
    effectRoot.add(selectedRange);

    // 放塔預覽直接貼在 3D 地面；綠色＝平地、金色＝高地、紅色＝不可放置。
    const placementPreview = new THREE.Group();
    const placementFillMaterial = new THREE.MeshBasicMaterial({
      color: "#8ce3ac",
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const placementFill = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), placementFillMaterial);
    placementFill.rotation.x = -Math.PI / 2;
    placementFill.position.y = 0.004;
    const placementOutlineMaterial = new THREE.LineBasicMaterial({
      color: "#c1f4d0",
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    const placementOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.94, 0.045, 0.94)),
      placementOutlineMaterial,
    );
    placementOutline.position.y = 0.026;
    placementPreview.add(placementFill, placementOutline);
    placementPreview.visible = false;
    effectRoot.add(placementPreview);

    const updateEffects = (data: Terrain3DSnapshot) => {
      for (let i = 0; i < data.shots.length; i++) {
        const shot = data.shots[i];
        if (!shotNodes[i]) {
          const group = new THREE.Group();
          const material = new THREE.MeshStandardMaterial({ color: shot.color, emissive: shot.color, emissiveIntensity: 1.1, roughness: 0.28 });
          const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), material);
          core.castShadow = false;
          group.add(core);
          const trail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.48), material);
          trail.position.z = -0.28;
          group.add(trail);
          const wakeMaterial = new THREE.MeshBasicMaterial({
            color: shot.color, vertexColors: true, transparent: true, opacity: 0.24,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            depthWrite: false, toneMapped: false,
          });
          installProjectileWakeFlow(wakeMaterial);
          const wake = new THREE.Mesh(projectileWakeGeometry, wakeMaterial);
          wake.position.y = -0.12;
          wake.renderOrder = 4;
          wake.castShadow = false;
          wake.receiveShadow = false;
          group.add(wake);
          // 低空掠地的第二道氣流貼近地表滑過；速度不足時自動隱藏，不會變成常駐地面光帶。
          const skimMaterial = new THREE.MeshBasicMaterial({
            color: shot.color, vertexColors: true, transparent: true, opacity: 0.16,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            depthWrite: false, toneMapped: false,
          });
          installProjectileWakeFlow(skimMaterial);
          const skimWake = new THREE.Mesh(projectileWakeGeometry, skimMaterial);
          skimWake.position.y = -0.665;
          skimWake.renderOrder = 3;
          skimWake.castShadow = false;
          skimWake.receiveShadow = false;
          group.add(skimWake);
          effectRoot.add(group);
          shotNodes[i] = group;
        }
        const node = shotNodes[i];
        node.visible = true;
        node.children[0].material.color.set(shot.color);
        node.children[0].material.emissive.set(shot.color);
        const speedFactor = THREE.MathUtils.clamp(((shot.speed ?? 220) - 220) / 420, 0, 1);
        const wake = node.children[2];
        wake.material.color.set(shot.color);
        wake.material.opacity = 0.14 + speedFactor * 0.5;
        wake.scale.set(0.82 + speedFactor * 0.44, 1, 0.72 + speedFactor * 1.3);
        const skimWake = node.children[3];
        skimWake.visible = speedFactor > 0.08;
        skimWake.material.color.set(shot.color);
        skimWake.material.opacity = speedFactor > 0.08 ? 0.06 + speedFactor * 0.3 : 0;
        skimWake.scale.set(1.15 + speedFactor * 0.7, 1, 0.9 + speedFactor * 1.6);
        node.children[1].scale.z = 1 + speedFactor * 1.9;
        node.children[1].position.z = -0.28 - speedFactor * 0.16;
        node.children[0].scale.setScalar(1 + speedFactor * 0.13);
        const dx = (shot.tx - shot.x) / CELL;
        const dz = (shot.ty - shot.y) / CELL;
        const length = Math.hypot(dx, dz) || 1;
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(shot.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(shot.y / CELL)));
        const h = data.heights[gy * COLS + gx] ?? 0;
        node.position.set(shot.x / CELL, groundTop(h) + 0.72, shot.y / CELL);
        node.rotation.y = Math.atan2(dx / length, dz / length);
        node.scale.setScalar(shot.sanctuary ? 1.28 : 1);
      }
      for (let i = data.shots.length; i < shotNodes.length; i++) shotNodes[i].visible = false;

      for (let i = 0; i < data.rings.length; i++) {
        const ring = data.rings[i];
        if (!ringNodes[i]) {
          const group = new THREE.Group();
          const material = new THREE.MeshBasicMaterial({
            color: "#ffd27a", transparent: true, opacity: 0.88,
            side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
          });
          const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.055, 8, 72), material);
          mesh.rotation.x = Math.PI / 2;
          group.add(mesh);
          effectRoot.add(group);
          ringNodes[i] = { group, mesh, accentOuter: null, accentInner: null, accentMaterial: null };
        }
        const node = ringNodes[i];
        const isTilePull = ring.color === "#72e8dc" || ring.color === "#f0d79c";
        // 只有升陸牽引波才加上第二層潮汐線；一般戰鬥環維持原本單環，避免額外 draw calls。
        if (isTilePull && !node.accentOuter) {
          node.accentMaterial = new THREE.MeshBasicMaterial({
            color: "#d8fff3", transparent: true, opacity: 0.62,
            side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
          });
          node.accentOuter = new THREE.Mesh(new THREE.TorusGeometry(1, 0.014, 5, 72), node.accentMaterial);
          node.accentInner = new THREE.Mesh(new THREE.TorusGeometry(1, 0.01, 5, 72), node.accentMaterial);
          node.accentOuter.rotation.x = Math.PI / 2;
          node.accentInner.rotation.x = Math.PI / 2;
          node.group.add(node.accentOuter, node.accentInner);
        }
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(ring.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(ring.y / CELL)));
        const h = data.heights[gy * COLS + gx] ?? 0;
        const scale = Math.max(0.08, ring.r / CELL);
        node.group.visible = true;
        node.group.position.set(ring.x / CELL, groundTop(h) + 0.08, ring.y / CELL);
        node.mesh.scale.setScalar(scale);
        node.mesh.material.opacity = Math.max(0, Math.min(0.9, ring.life * 2.5));
        node.mesh.material.color.set(ring.color.startsWith("#") ? ring.color : "#ffd27a");
        if (node.accentOuter && node.accentInner && node.accentMaterial) {
          node.accentOuter.visible = isTilePull;
          node.accentInner.visible = isTilePull;
          node.accentOuter.scale.setScalar(scale * 1.075);
          node.accentInner.scale.setScalar(scale * 0.79);
          node.accentOuter.rotation.z = performance.now() * 0.00016;
          node.accentInner.rotation.z = -performance.now() * 0.00023;
          node.accentMaterial.opacity = Math.max(0, Math.min(0.68, ring.life * 1.9));
          node.accentMaterial.color.set(ring.color === "#f0d79c" ? "#fff0c9" : "#d8fff3");
        }
      }
      for (let i = data.rings.length; i < ringNodes.length; i++) ringNodes[i].group.visible = false;

      const selectedTower = data.towers.find((tower) => tower.selected);
      if (selectedTower && (selectedTower.range ?? 0) > 0) {
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(selectedTower.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(selectedTower.y / CELL)));
        const h = terrainHeightAt(gx, gy, data.heights);
        selectedRange.visible = true;
        selectedRange.position.set(selectedTower.x / CELL, groundTop(h) + 0.045, selectedTower.y / CELL);
        selectedRange.scale.setScalar(selectedTower.range! / CELL);
        selectedRangeMaterial.opacity = 0.24 + Math.sin(performance.now() * 0.003) * 0.05;
      } else {
        selectedRange.visible = false;
      }

      if (data.placement) {
        const { gx, gy, height, valid, snapped } = data.placement;
        placementPreview.visible = true;
        placementPreview.position.set(gx + 0.5, groundTop(height) + 0.045, gy + 0.5);
        placementPreview.scale.setScalar(snapped ? 0.94 : 1);
        const fillColor = !valid ? "#ff7188" : height > 0 ? "#f1c982" : "#8ce3ac";
        const lineColor = !valid ? "#ff9cac" : height > 0 ? "#ffe2a5" : "#c1f4d0";
        placementFillMaterial.color.set(fillColor);
        placementOutlineMaterial.color.set(lineColor);
        placementFillMaterial.opacity = valid
          ? (height > 0 ? 0.23 : 0.18) + Math.sin(performance.now() * 0.004) * 0.025
          : 0.15;
        placementOutlineMaterial.opacity = valid ? 0.96 : 0.88;
      } else {
        placementPreview.visible = false;
      }
    };

    const resize = () => {
      if (!renderer || !host) return;
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const focus = (x: number, y: number) => {
      const snapshot = snapshotRef.current();
      const gx = Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
      const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(y / CELL)));
      controls.target.set(x / CELL, groundTop(terrainHeightAt(gx, gy, snapshot.heights)), y / CELL);
      controls.update();
    };

    const reset = () => {
      const snapshot = snapshotRef.current();
      const hq = snapshot.towers.find((tower) => tower.sanctuary);
      const centerX = hq ? hq.x / CELL : COLS / 2;
      const centerZ = hq ? hq.y / CELL : ROWS / 2;
      const gx = Math.max(0, Math.min(COLS - 1, Math.floor(centerX)));
      const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(centerZ)));
      const terrainHeight = terrainHeightAt(gx, gy, snapshot.heights);
      focus(centerX * CELL, centerZ * CELL);
      camera.position.set(centerX + 5, groundTop(terrainHeight) + 27, centerZ + 5);
      controls.update();
    };

    const setPointerRay = (clientX: number, clientY: number) => {
      if (!renderer) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      // 捕捉事件可能早於下一幀 render；先同步 OrbitControls 剛更新的相機世界矩陣，
      // 避免使用上一幀的 camera.matrixWorld 計算滑鼠射線。
      camera.updateMatrixWorld(true);
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return true;
    };

    const screenToWorld = (clientX: number, clientY: number) => {
      if (!setPointerRay(clientX, clientY)) return null;
      const point = new THREE.Vector3();
      // 由高至低測試四個頂面平面。只有交點所在格子的實際高度吻合才接受，
      // 這樣裝飾物、岩壁側面、海面與基地模型都不會把放置座標拉偏。
      for (let height = 3; height >= 0; height--) {
        const intersection = raycaster.ray.intersectPlane(terrainPickPlanes[height], point);
        if (!intersection) continue;
        const gx = Math.floor(point.x);
        const gy = Math.floor(point.z);
        if (terrainCellHeights.get(gx + "," + gy) !== height) continue;
        return { x: point.x * CELL, y: point.z * CELL };
      }
      // 指向島外或空格時仍回傳平地投影，讓 UI 能顯示不可建提示。
      const fallback = raycaster.ray.intersectPlane(floorPlane, point);
      if (!fallback) return null;
      return { x: point.x * CELL, y: point.z * CELL };
    };

    const screenToCellPrecise = (clientX: number, clientY: number): Terrain3DCellHit | null => {
      if (!setPointerRay(clientX, clientY)) return null;
      // 地表格子由分塊 InstancedMesh 建立；先同步地形世界矩陣，
      // 確保所有放置模式都取得相同的 gx／gy／height，不再從世界座標反算。
      terrainRoot.updateMatrixWorld(true);
      // 只測地表的四組高度 InstancedMesh，不碰水面、岩壁裝飾、塔體或粒子效果。
      const hits = raycaster.intersectObjects(terrainPickMeshes, false);
      for (const hit of hits) {
        const cells = (hit.object as any).userData?.pickCells as Terrain3DCellHit[] | undefined;
        const instanceId = hit.instanceId;
        if (!cells || instanceId == null) continue;
        const cell = cells[instanceId];
        if (!cell) continue;
        return cell;
      }
      return null;
    };

    const screenToWorldPrecise = (clientX: number, clientY: number) => {
      const cell = screenToCellPrecise(clientX, clientY);
      return cell ? { x: (cell.gx + 0.5) * CELL, y: (cell.gy + 0.5) * CELL } : null;
    };

    const pickTower = (clientX: number, clientY: number): number | null => {
      if (!setPointerRay(clientX, clientY)) return null;
      const hits = raycaster.intersectObject(buildingRoot, true);
      for (const hit of hits) {
        let node: any = hit.object;
        while (node && node !== buildingRoot) {
          const index = node.userData?.gameTowerIndex;
          if (Number.isInteger(index)) return index as number;
          node = node.parent;
        }
      }
      return null;
    };

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
      // 避免高 DPI 螢幕把填色像素數放大太多；仍保留清晰度。
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
      renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.domElement.dataset.game3d = "true";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      renderer.domElement.style.touchAction = "none";
      host.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.enablePan = true;
      controls.enableZoom = true;
      controls.enableRotate = true;
      controls.screenSpacePanning = true;
      controls.rotateSpeed = 0.62;
      controls.panSpeed = 0.8;
      controls.minDistance = 6;
      controls.maxDistance = 560;
      controls.minPolarAngle = THREE.MathUtils.degToRad(8);
      controls.maxPolarAngle = THREE.MathUtils.degToRad(76);
      controls.mouseButtons = {
        LEFT: -1,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };

      const snapshot = snapshotRef.current();
      const hq = snapshot.towers.find((tower) => tower.sanctuary);
      const centerX = hq ? hq.x / CELL : COLS / 2;
      const centerZ = hq ? hq.y / CELL : ROWS / 2;
      const h = hq ? snapshot.heights[hq.gy * COLS + hq.gx] ?? 0 : 0;
      controls.target.set(centerX, groundTop(h), centerZ);
      camera.position.set(centerX + 5, groundTop(h) + 27, centerZ + 5);
      controls.update();

      apiRef.current = { screenToWorld, screenToCellPrecise, screenToWorldPrecise, pickTower, focus, reset };
      setError("");
    } catch {
      setError("此瀏覽器無法啟動 WebGL，請更新瀏覽器或啟用硬體加速。");
      return () => {
        renderer?.dispose?.();
        renderer?.domElement?.remove?.();
      };
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || altDown) return;
      altDown = true;
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      altDown = false;
      controls.mouseButtons.LEFT = -1;
    };
    const onBlur = () => {
      altDown = false;
      controls.mouseButtons.LEFT = -1;
    };
    const onContextMenu = (event: Event) => event.preventDefault();
    window.addEventListener("resize", resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    let lastHqFireLevel: number | null = null;
    let lastFrameAt = 0;
    let lastRafAt = 0;
    let renderAccumulator = 0;
    const renderInterval = 1000 / 60;
    let lastSnapshotAt = -Infinity;
    let lastAmbientUpdateAt = -Infinity;
    let cachedSnapshot: Terrain3DSnapshot | null = null;
    const render = (time: number) => {
      if (disposed) return;
      animationFrame = requestAnimationFrame(render);
      // 對齊 60Hz 螢幕更新節奏，避免 40 FPS 與 60Hz 不整除造成不均勻掉幀與閃動。
      const rafDelta = lastRafAt ? Math.min(100, time - lastRafAt) : renderInterval;
      lastRafAt = time;
      renderAccumulator += rafDelta;
      if (renderAccumulator < renderInterval) return;
      renderAccumulator = Math.min(renderAccumulator - renderInterval, renderInterval * 0.75);
      const dt = lastFrameAt ? Math.min(0.05, (time - lastFrameAt) / 1000) : 0;
      lastFrameAt = time;
      if (!cachedSnapshot || time - lastSnapshotAt >= 1000 / 30) {
        cachedSnapshot = snapshotRef.current();
        lastSnapshotAt = time;
      }
      const data = cachedSnapshot;

      if (time - lastBuildAt > 700) {
        lastBuildAt = time;
        // 地形資料以不可變引用更新；未變更時不再每 700ms 重掃 400×400 高度陣列與碰撞集合。
        const terrainInputsChanged =
          data.heights !== lastTerrainHeightsRef ||
          data.blocked !== lastTerrainBlockedRef ||
          data.placed !== lastTerrainPlacedRef ||
          data.mapMode !== lastTerrainMapMode;
        if (terrainInputsChanged) {
          let heightHash = 2166136261;
          for (let i = 0; i < data.heights.length; i++) heightHash = Math.imul(heightHash ^ (data.heights[i] ?? 0), 16777619);
          // 動態路障只改尋路碰撞，不改變道路／地形本身；排除路障格，避免每放一個路障就清空重建整張地圖。
          const stakeKeys = new Set(data.towers.filter((tower) => tower.stake).map((tower) => tower.gx + "," + tower.gy));
          const terrainBlocked = stakeKeys.size
            ? new Set([...data.blocked].filter((key) => !stakeKeys.has(key)))
            : data.blocked;
          let blockedHash = 2166136261;
          // 排序後雜湊，Set 插入順序改變但內容相同時不會誤判為地形變更。
          for (const key of [...terrainBlocked].sort()) {
            for (let i = 0; i < key.length; i++) blockedHash = Math.imul(blockedHash ^ key.charCodeAt(i), 16777619);
          }
          const placedKey = data.placed.map((tile) => [tile.tc, tile.tr, tile.templateId, tile.rot].join(",")).join("|");
          const terrainKey = data.mapMode + "|" + placedKey + "|" + heightHash + "|" + blockedHash;
          if (terrainKey !== lastTerrainKey) {
            rebuildTerrain(terrainBlocked === data.blocked ? data : { ...data, blocked: terrainBlocked });
            lastTerrainKey = terrainKey;
          }
          lastTerrainHeightsRef = data.heights;
          lastTerrainBlockedRef = data.blocked;
          lastTerrainPlacedRef = data.placed;
          lastTerrainMapMode = data.mapMode;
        }
        const buildingKey = data.towers.map((tower) =>
          [tower.sanctuary ? "hq" : tower.stake ? "stake" : "tower", tower.gx, tower.gy, tower.def, tower.level, tower.hqFireLv ?? 0, tower.hqFortifyLv ?? 0].join(","),
        ).join("|");
        if (buildingKey !== lastBuildingKey) {
          const hq = data.towers.find((tower) => tower.sanctuary);
          const fireLevel = hq?.hqFireLv ?? 0;
          const animateTurrets = lastHqFireLevel !== null && lastHqFireLevel < 1 && fireLevel >= 1;
          const animateMainUpgrade = lastHqFireLevel !== null && lastHqFireLevel < 2 && fireLevel >= 2;
          rebuildBuildings(data, animateTurrets, animateMainUpgrade);
          lastHqFireLevel = fireLevel;
          lastBuildingKey = buildingKey;
        }
      }

      updateActors(data, time);
      updateEffects(data);
      // 水面、燈光與黑霧提高至 30 FPS 更新，減少低頻矩陣跳動造成的閃爍感。
      if (time - lastAmbientUpdateAt >= 1000 / 30) {
        lastAmbientUpdateAt = time;
        updateWaterRipples(time);
        updateFireflies(time);
        updateLandmarkLights(time);
        updateBlackMist(data, time);
      }
      // 鏡頭拉遠時霧層更柔和、遠景更自然；拉近時保留地表紋理與建築邊緣。
      const viewDistance = camera.position.distanceTo(controls.target);
      atmosphericFog.near = THREE.MathUtils.clamp(viewDistance * 1.08, 82, 185);
      atmosphericFog.far = THREE.MathUtils.clamp(viewDistance * 3.7, 320, 860);
      for (const ring of rings) ring.rotation.y += dt * 0.42;
      for (let i = installationAnimations.length - 1; i >= 0; i--) {
        const animation = installationAnimations[i];
        animation.age += dt;
        const p = Math.min(1, animation.age / animation.duration);
        const ease = 1 - Math.pow(1 - p, 3);
        animation.group.scale.setScalar(animation.fromScale + (1 - animation.fromScale) * ease);
        animation.group.position.y = animation.targetY + (1 - ease) * 0.92;
        if (p >= 1) installationAnimations.splice(i, 1);
      }
      for (let i = installationRings.length - 1; i >= 0; i--) {
        const effect = installationRings[i];
        effect.age += dt;
        const p = Math.min(1, effect.age / effect.duration);
        effect.mesh.scale.setScalar(0.22 + p * 1.42);
        effect.material.opacity = (1 - p) * 0.92;
        if (p >= 1) {
          effect.mesh.parent?.remove(effect.mesh);
          effect.mesh.geometry?.dispose?.();
          effect.material.dispose();
          installationRings.splice(i, 1);
        }
      }
      for (const effect of buildFlashEffects) {
        const flash = Math.max(0, Math.min(1, effect.tower.hqBuildFlash ?? 0));
        effect.material.opacity = flash * 0.72;
        effect.mesh.scale.setScalar(1 + (1 - flash) * 0.16);
      }
      for (const gem of gems) {
        const pulse = 1 + Math.sin(time * 0.0022) * 0.045;
        gem.scale.setScalar(pulse);
      }
      for (const core of chargeCores) {
        const charge = Math.max(0, Math.min(1, core.tower.hqCharge ?? 0));
        core.material.emissiveIntensity = 0.85 + charge * 2.8;
        core.mesh.scale.setScalar((1 + Math.sin(time * 0.0022) * 0.045) * (1 + charge * 0.22));
      }
      for (const turret of turretGroups) {
        turret.group.rotation.y = Math.atan2(Math.cos(turret.tower.aim), Math.sin(turret.tower.aim));
        const flash = turret.index < 0
          ? turret.tower.hqCannonAtk ?? 0
          : turret.tower.hqTurretAtk?.[turret.index] ?? 0;
        turret.group.position.y = turret.baseY - flash * 0.11;
        turret.group.position.z = turret.baseZ;
        turret.flash.visible = flash > 0.06;
        turret.flash.scale.setScalar(0.72 + flash * 1.8);
        turret.flash.material.opacity = Math.min(1, flash * 1.25);
      }
      sanctuarySigilUniforms.time.value = time * 0.001;
      sanctuarySigilUniforms.power.value = THREE.MathUtils.clamp(data.sanctuaryPower ?? 0.18, 0, 1);
      roadGuideUniforms.time.value = time * 0.001;
      foliageWindUniform.value = time * 0.00048;
      projectileWakeUniforms.time.value = time * 0.001;
      controls.update();
      renderer.render(scene, camera);
    };
    animationFrame = requestAnimationFrame(render);

    const resetButton = host.querySelector<HTMLButtonElement>("[data-reset-3d]");
    resetButton?.addEventListener("click", reset);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resetButton?.removeEventListener("click", reset);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      controls.dispose();
      apiRef.current = null;
      clearGroup(terrainRoot);
      for (const geometry of terrainGeometries) geometry.dispose();
      for (const effect of installationRings) effect.material.dispose();
      for (const effect of buildFlashEffects) effect.material.dispose();
      clearGroup(buildingRoot);
      clearGroup(actorRoot);
      for (const bar of enemyHealthBars) {
        bar.back.material.dispose();
        bar.fill.material.dispose();
      }
      selectedRangeMaterial.dispose();
      purificationAuraMaterial.dispose();
      shared.blackMist.dispose();
      shared.blackMistVeil.dispose();
      shared.blackMistField.dispose();
      shared.blackMistCloud.dispose();
      blackMistTexture.dispose();
      blackMistFieldTexture.dispose();
      blackMistFieldMaskTexture.dispose();
      placementFillMaterial.dispose();
      placementOutlineMaterial.dispose();
      for (const ringNode of ringNodes) {
        ringNode.mesh.material.dispose();
        ringNode.accentMaterial?.dispose();
      }
      for (const shotNode of shotNodes) {
        shotNode.children[0]?.material?.dispose();
        shotNode.children[2]?.material?.dispose();
        shotNode.children[3]?.material?.dispose();
      }
      clearGroup(effectRoot);
      projectileWakeGeometry.dispose();
      scene.remove(skyDome);
      skyGeometry.dispose();
      skyMaterial.dispose();
      shared.waterRipple.dispose();
      shared.waterGlint.dispose();
      shared.firefly.dispose();
      shared.pollen.dispose();
      shared.treeBark.dispose();
      shared.grass.dispose();
      shared.grassBlade.dispose();
      shared.foliageWind.dispose();
      shared.meadowBloom.dispose();
      shared.roadGuide.dispose();
      shared.roadWear.dispose();
      shared.sanctuarySigil.dispose();
      shared.biomeSeam.dispose();
      shared.roadMedallion.dispose();
      shared.tidalSand.dispose();
      shared.beachPebble.dispose();
      shared.contactShadow.dispose();
      surfaceReliefMap.dispose();
      surfaceRoughnessMap.dispose();
      waterBumpMap.dispose();
      environmentTexture.dispose();
      contactShadowTexture.dispose();
      contactShadowGeometry.dispose();
      for (const texture of textureCache.values()) texture.dispose();
      for (const material of towerAccentMaterials.values()) material.dispose();
      buildingHitMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [snapshotRef, apiRef]);

  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden" style={{ background: "#10232c" }}>
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-[#c5dff2]">{error}</div>
      ) : (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-[#8ec8ee55] bg-[#061525cc] px-3 py-2 text-xs text-[#d7ecff] shadow-lg">
            <b className="block text-[#f2d89b]">潮汐遺跡・3D 戰場</b>
            Alt＋左鍵旋轉 · 右鍵平移 · 滾輪縮放
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg border border-[#8ec8ee33] bg-[#061525cc] px-3 py-2 text-[11px] text-[#9ec4de]">
            道路與聖地保留為禁建區 · 高地 Lv.1～3 可放置一般塔
            <span className="block mt-1 text-[#d8c89e]">高地保留高度差與射程優勢；未開拓區域持續受黑霧覆蓋</span>
            <span className="block mt-1 text-[#83d9d5]">深淵霧覆蓋未開拓世界 · 牽引升起的新地塊會驅散黑霧</span>
          </div>
          <button
            type="button"
            data-reset-3d
            className="btn ghost absolute right-3 top-3 z-10"
            style={{ background: "rgba(6,21,37,0.88)" }}
          >
            重設視角
          </button>
        </>
      )}
    </div>
  );
});
