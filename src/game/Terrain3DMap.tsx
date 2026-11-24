import { useEffect, useRef, useState } from "react";
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
  x: number; y: number; tx: number; ty: number; color: string; sanctuary?: boolean;
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
  mapMode: "expand" | "layout";
};

export type Terrain3DApi = {
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number } | null;
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
    if (node.geometry) node.geometry.dispose();
  });
  group.clear();
}

function groundTop(height: number) {
  return 0.14 + Math.max(0, Math.min(3, height)) * HEIGHT_STEP;
}

export function Terrain3DMap({ snapshotRef, apiRef }: Props) {
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
    let lastBuildingKey = "";
    let lastTime = 0;

    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.Fog("#718f86", 82, 270);

    // 柔和的海天漸層穹頂：由深海青過渡到暖霧色，再到高空藍綠。
    const skyGeometry = new THREE.SphereGeometry(360, 40, 24);
    const skyPositions = skyGeometry.getAttribute("position");
    const skyColors = new Float32Array(skyPositions.count * 3);
    const skyBottom = new THREE.Color("#173e4b");
    const skyHorizon = new THREE.Color("#9ab7a4");
    const skyZenith = new THREE.Color("#365c72");
    const skyColor = new THREE.Color();
    for (let i = 0; i < skyPositions.count; i++) {
      const height = THREE.MathUtils.clamp((skyPositions.getY(i) / 360 + 1) * 0.5, 0, 1);
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

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    const terrainRoot = new THREE.Group();
    const buildingRoot = new THREE.Group();
    const actorRoot = new THREE.Group();
    const effectRoot = new THREE.Group();
    scene.add(terrainRoot, buildingRoot, actorRoot, effectRoot);

    scene.add(new THREE.HemisphereLight("#e6f4ed", "#31433b", 1.52));
    scene.add(new THREE.AmbientLight("#9dbbb6", 0.38));
    const sun = new THREE.DirectionalLight("#ffe2b8", 2.25);
    sun.position.set(-32, 48, 28);
    sun.castShadow = true;
    sun.shadow.radius = 4;
    sun.shadow.normalBias = 0.022;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 190;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -115;
    sun.shadow.camera.right = 115;
    sun.shadow.camera.top = 115;
    sun.shadow.camera.bottom = -115;
    sun.shadow.bias = -0.0003;
    scene.add(sun);
    const seaFill = new THREE.DirectionalLight("#79cbd0", 0.46);
    seaFill.position.set(42, 22, -36);
    seaFill.castShadow = false;
    scene.add(seaFill);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const textureCache = new Map<HTMLImageElement, any>();
    const towerAccentMaterials = new Map<string, any>();
    const getTowerAccentMaterial = (color: string) => {
      const key = /^#[0-9a-f]{6}$/i.test(color) ? color : "#78cfe8";
      let material = towerAccentMaterials.get(key);
      if (!material) {
        material = new THREE.MeshStandardMaterial({
          color: key,
          metalness: 0.5,
          roughness: 0.26,
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
    const waterRippleDummy = new THREE.Object3D();
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
    const shared = {
      stone: new THREE.MeshStandardMaterial({ color: MATERIALS.stone, roughness: 0.76 }),
      ivory: new THREE.MeshStandardMaterial({ color: MATERIALS.ivory, roughness: 0.63 }),
      blue: new THREE.MeshStandardMaterial({ color: MATERIALS.blue, metalness: 0.25, roughness: 0.43 }),
      roof: new THREE.MeshStandardMaterial({ color: MATERIALS.roof, metalness: 0.25, roughness: 0.38 }),
      gold: new THREE.MeshStandardMaterial({ color: MATERIALS.gold, metalness: 0.78, roughness: 0.28 }),
      brightGold: new THREE.MeshStandardMaterial({ color: MATERIALS.brightGold, metalness: 0.7, roughness: 0.22, emissive: "#754c16", emissiveIntensity: 0.18 }),
      crystal: new THREE.MeshStandardMaterial({ color: MATERIALS.crystal, metalness: 0.25, roughness: 0.18, emissive: "#008fe8", emissiveIntensity: 1.0 }),
      chargeCrystal: new THREE.MeshStandardMaterial({ color: "#8af4e8", metalness: 0.24, roughness: 0.16, emissive: "#00a89c", emissiveIntensity: 0.8 }),
      glass: new THREE.MeshStandardMaterial({ color: "#0e3945", roughness: 0.22, emissive: "#0a6070", emissiveIntensity: 0.42 }),
      terrain: [
        new THREE.MeshStandardMaterial({ color: MATERIALS.road, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.low, roughness: 0.92 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.mid, roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.high, roughness: 0.88 }),
      ],
      cliff: new THREE.MeshStandardMaterial({ color: "#344c4c", roughness: 0.97 }),
      cliffBand: new THREE.MeshStandardMaterial({ color: "#637c6b", roughness: 0.88 }),
      cliffBandLight: new THREE.MeshStandardMaterial({ color: "#9a9f7d", roughness: 0.82 }),
      cliffCap: new THREE.MeshStandardMaterial({ color: "#d0c49b", roughness: 0.76 }),
      rockDetail: new THREE.MeshStandardMaterial({ color: "#8b927d", roughness: 0.96 }),
      terrainMoss: new THREE.MeshStandardMaterial({ color: "#66856a", roughness: 0.98 }),
      terrainStrata: new THREE.MeshStandardMaterial({ color: "#c0b99d", roughness: 0.92 }),
      terrainInlay: new THREE.MeshStandardMaterial({ color: "#e1d0a6", roughness: 0.82, metalness: 0.08 }),
      roadPaver: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.94 }),
      roadEdge: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9 }),
      grass: new THREE.MeshStandardMaterial({ color: "#83a878", roughness: 0.96 }),
      terrainCrystal: new THREE.MeshStandardMaterial({
        color: "#55a6a2",
        metalness: 0.22,
        roughness: 0.34,
        emissive: "#1d6865",
        emissiveIntensity: 0.18,
      }),
      floor: new THREE.MeshStandardMaterial({ color: "#123b49", metalness: 0.24, roughness: 0.34 }),
      seaShelf: new THREE.MeshStandardMaterial({ color: "#28636a", metalness: 0.16, roughness: 0.42 }),
      shoreSand: new THREE.MeshStandardMaterial({ color: "#d9c49a", roughness: 0.94 }),
      shoreFoam: new THREE.MeshBasicMaterial({ color: "#b9e6d8", transparent: true, opacity: 0.76, depthWrite: false }),
      waterRipple: new THREE.MeshBasicMaterial({ color: "#c7eee0", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
      cliffLip: new THREE.MeshStandardMaterial({ color: "#c9b58b", roughness: 0.86 }),
      cliffFacet: new THREE.MeshStandardMaterial({ color: "#718071", roughness: 0.96 }),
      reefRock: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.94 }),
      reefCoral: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.78 }),
      heightRim: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.84 }),
      ramp: new THREE.MeshStandardMaterial({ color: "#aeb49c", roughness: 0.9 }),
    };

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
      root.position.set(tower.x / CELL, groundTop(heights[tower.gy * COLS + tower.gx] ?? 0), tower.y / CELL);
      addBox(root, 0.78, 0.16, 0.78, 0, 0.08, 0, shared.gold);
      addCylinder(root, 0.22, 0.34, 0.72, 0, 0.48, 0, shared.stone, 8);
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.25, 0), shared.crystal);
      crystal.position.y = 0.95;
      root.add(crystal);
      buildingRoot.add(root);
    };

    const createTowerBase = (tower: Terrain3DTower, heights: number[]) => {
      const root = new THREE.Group();
      root.position.set(tower.x / CELL, groundTop(heights[tower.gy * COLS + tower.gx] ?? 0), tower.y / CELL);
      const level = Math.max(1, Math.min(8, tower.level || 1));
      const definition = TOWERS[tower.def];
      const accent = getTowerAccentMaterial(definition?.color ?? "#78cfe8");
      const special = definition?.special ?? "high";
      const levelLift = Math.min(0.18, (level - 1) * 0.026);
      const radius = 0.66 + Math.min(0.08, (level - 1) * 0.012);

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
      clearGroup(terrainRoot);
      waterRippleMesh = null;
      waterRippleEntries.length = 0;
      const byHeight: { x: number; z: number; h: number }[][] = [[], [], [], []];
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
        byHeight[h].push(cell);
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

      // 每格岩面保留些微色差，讓平台表面不再像單色網格。
      for (let h = 0; h <= 3; h++) {
        const list = byHeight[h];
        if (!list.length) continue;
        const top = groundTop(h);
        const mesh = new THREE.InstancedMesh(
          new THREE.BoxGeometry(0.98, top, 0.98),
          shared.terrain[h],
          list.length,
        );
        const matrix = new THREE.Matrix4();
        const tint = new THREE.Color();
        for (let i = 0; i < list.length; i++) {
          const cell = list[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          const shade = 0.92 + seed * 0.1;
          matrix.makeTranslation(cell.x, top / 2, cell.z);
          mesh.setMatrixAt(i, matrix);
          tint.setRGB(shade, shade, shade);
          mesh.setColorAt(i, tint);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = h > 0;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        terrainRoot.add(mesh);
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
      const deepWater = new THREE.Mesh(
        new THREE.PlaneGeometry(mapWidth + 36, mapDepth + 36),
        shared.floor,
      );
      deepWater.rotation.x = -Math.PI / 2;
      deepWater.position.set(mapCenterX, -0.34, mapCenterZ);
      deepWater.receiveShadow = false;
      const shelfWater = new THREE.Mesh(
        new THREE.PlaneGeometry(mapWidth + 12, mapDepth + 12),
        shared.seaShelf,
      );
      shelfWater.rotation.x = -Math.PI / 2;
      shelfWater.position.set(mapCenterX, -0.285, mapCenterZ);
      shelfWater.receiveShadow = false;
      terrainRoot.add(deepWater, shelfWater);

      // 外露地塊的岸線：沙色石沿收邊，海面再以稀疏泡沫切出水陸交界。
      // 僅處理已放置地塊的非道路格，並避開現有建築 footprint。
      const coastDirections = [
        { dc: 0, dr: -1, dx: 0, dz: -1, rot: 0 },
        { dc: 1, dr: 0, dx: 1, dz: 0, rot: Math.PI / 2 },
        { dc: 0, dr: 1, dx: 0, dz: 1, rot: 0 },
        { dc: -1, dr: 0, dx: -1, dz: 0, rot: Math.PI / 2 },
      ];
      const protectedBuildings = data.towers.map((tower) => ({
        x: tower.x / CELL,
        z: tower.y / CELL,
        radius: tower.sanctuary ? 4.4 : 1.18,
      }));
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

        // 少量潮汐微光環沿岸緩慢擴散；集中在單一 InstancedMesh，不逐個建立動畫物件。
        const rippleCandidates = coastEdges.filter((edge) => edge.seed > 0.72);
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
      }

      // 高地表面散布少量低矮岩屑，破除棋盤格般的單調感，不遮擋道路或建築。
      const rockCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const seed = Math.abs(Math.sin(cell.x * 91.7 + cell.z * 43.3) * 24634.6345) % 1;
        return seed > 0.86;
      });
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

      // 高地縫隙長出零星短草，採固定種子分布並避開塔座／聖地，讓地貌有生命感但不干擾戰鬥辨識。
      const grassCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h <= 0) return false;
        const seed = Math.abs(Math.sin(cell.x * 63.7 + cell.z * 29.3) * 18341.73) % 1;
        if (seed < 0.965) return false;
        return !data.towers.some((tower) => {
          const tx = tower.x / CELL;
          const tz = tower.y / CELL;
          const clearance = tower.sanctuary ? 4.1 : 1.05;
          return Math.hypot(cell.x - tx, cell.z - tz) < clearance;
        });
      });
      if (grassCells.length) {
        const bladeCount = grassCells.length * 3;
        const grass = new THREE.InstancedMesh(
          new THREE.ConeGeometry(0.052, 0.22, 5),
          shared.grass,
          bladeCount,
        );
        const dummy = new THREE.Object3D();
        const tint = new THREE.Color();
        for (let i = 0; i < grassCells.length; i++) {
          const cell = grassCells[i];
          const seed = Math.abs(Math.sin(cell.x * 127.1 + cell.z * 311.7) * 43758.5453) % 1;
          for (let blade = 0; blade < 3; blade++) {
            const index = i * 3 + blade;
            const angle = seed * Math.PI * 2 + blade * (Math.PI * 2 / 3);
            const radius = 0.08 + seed * 0.08;
            dummy.position.set(
              cell.x + Math.cos(angle) * radius,
              groundTop(cell.h) + 0.12,
              cell.z + Math.sin(angle) * radius,
            );
            dummy.rotation.set(
              Math.cos(angle) * 0.16,
              angle,
              Math.sin(angle) * -0.16,
            );
            dummy.scale.set(0.82 + seed * 0.3, 0.72 + blade * 0.12, 0.82 + seed * 0.3);
            dummy.updateMatrix();
            grass.setMatrixAt(index, dummy.matrix);
            tint.set(blade === 1 ? "#a0b879" : seed > 0.5 ? "#78966b" : "#648c70");
            grass.setColorAt(index, tint);
          }
        }
        grass.instanceMatrix.needsUpdate = true;
        if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
        grass.castShadow = false;
        grass.receiveShadow = true;
        terrainRoot.add(grass);
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
        if (cell.h !== 1 || !detailIsClear(cell)) return false;
        const seed = Math.abs(Math.sin(cell.x * 29.7 + cell.z * 81.3) * 18431.7) % 1;
        return seed > 0.79;
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

      const strataCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 2 || !detailIsClear(cell)) return false;
        const seed = Math.abs(Math.sin(cell.x * 47.1 + cell.z * 19.7) * 29341.3) % 1;
        return seed > 0.77;
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

      const engravedCells = Array.from(tileCells.values()).filter((cell) => {
        if (cell.h !== 3 || !detailIsClear(cell, 1.45)) return false;
        const seed = Math.abs(Math.sin(cell.x * 73.9 + cell.z * 37.1) * 31781.9) % 1;
        return seed > 0.75;
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

      // 裸露邊緣的層理岩壁：高度差越大，側面越深、越厚。
      const cliffDirections = [
        { dc: 0, dr: -1, dx: 0, dz: -0.46, sx: 0.94, sz: 0.08 },
        { dc: 1, dr: 0, dx: 0.46, dz: 0, sx: 0.08, sz: 0.94 },
        { dc: 0, dr: 1, dx: 0, dz: 0.46, sx: 0.94, sz: 0.08 },
        { dc: -1, dr: 0, dx: -0.46, dz: 0, sx: 0.08, sz: 0.94 },
      ];
      const cliffFaces: { x: number; y: number; z: number; sx: number; sy: number; sz: number; bandY: number; upperBandY: number }[] = [];
      const cliffLedges: { x: number; y: number; z: number; rot: number }[] = [];
      const heightRims: { x: number; y: number; z: number; rot: number; width: number; depth: number; tint: string }[] = [];
      const cliffFragments: {
        x: number; y: number; z: number;
        rx: number; ry: number; rz: number;
        sx: number; sy: number; sz: number;
        tint: string;
      }[] = [];
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

          // 斷層表面隨機生成薄片狀岩角，角度、厚度和色階有細微變化，避免連續牆面像積木。
          const faceSeed = Math.abs(Math.sin(cell.x * 43.17 + cell.z * 91.73 + d.dc * 17.1 + d.dr * 31.7) * 28543.31) % 1;
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
      const rampCells: { x: number; y: number; z: number; rot: number }[] = [];
      for (const cell of tileCells.values()) {
        if (cell.h <= 0) continue;
        const gx = Math.floor(cell.x), gy = Math.floor(cell.z);
        const higher = rampDirections.find((d) => {
          const neighbor = tileCells.get((gx + d.dc) + "," + (gy + d.dr));
          return !!neighbor && neighbor.h === cell.h + 1;
        });
        if (higher) rampCells.push({ x: cell.x, y: groundTop(cell.h) + 0.012, z: cell.z, rot: higher.rot });
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
      }

      // 海面已由上方深海／淺灘雙層承接，移除舊的單色底板以露出水域。
    };

    const updateWaterRipples = (time: number) => {
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
      for (const tower of data.towers) {
        if (tower.sanctuary) createSanctuary(tower, data.heights, animateTurrets, animateMainUpgrade);
        else if (tower.stake) createStake(tower, data.heights);
        else createTowerBase(tower, data.heights);
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
      const towers = data.towers.filter((tower) => !tower.sanctuary && !tower.stake);
      for (let i = 0; i < towers.length; i++) {
        const tower = towers[i];
        const sprite = ensureSprite(towerSprites, i, actorRoot);
        updateSpriteTexture(sprite, tower.image);
        const h = data.heights[tower.gy * COLS + tower.gx] ?? 0;
        sprite.position.set(tower.x / CELL, groundTop(h) + 1.03 + Math.min(0.16, (tower.level - 1) * 0.025), tower.y / CELL);
        sprite.scale.set(1.42, 1.58, 1);
        sprite.renderOrder = 4;
      }
      for (let i = towers.length; i < towerSprites.length; i++) towerSprites[i].visible = false;

      for (let i = 0; i < data.enemies.length; i++) {
        const enemy = data.enemies[i];
        const sprite = ensureSprite(enemySprites, i, actorRoot);
        updateSpriteTexture(sprite, enemy.image);
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(enemy.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(enemy.y / CELL)));
        const h = data.heights[gy * COLS + gx] ?? 0;
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
          effectRoot.add(group);
          shotNodes[i] = group;
        }
        const node = shotNodes[i];
        node.visible = true;
        node.children[0].material.color.set(shot.color);
        node.children[0].material.emissive.set(shot.color);
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
          const material = new THREE.MeshBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 0.88, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.055, 8, 36), material);
          mesh.rotation.x = Math.PI / 2;
          effectRoot.add(mesh);
          ringNodes[i] = mesh;
        }
        const mesh = ringNodes[i];
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(ring.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(ring.y / CELL)));
        const h = data.heights[gy * COLS + gx] ?? 0;
        mesh.visible = true;
        mesh.position.set(ring.x / CELL, groundTop(h) + 0.08, ring.y / CELL);
        mesh.scale.setScalar(Math.max(0.08, ring.r / CELL));
        mesh.material.opacity = Math.max(0, Math.min(0.9, ring.life * 2.5));
        mesh.material.color.set(ring.color.startsWith("#") ? ring.color : "#ffd27a");
      }
      for (let i = data.rings.length; i < ringNodes.length; i++) ringNodes[i].visible = false;

      const selectedTower = data.towers.find((tower) => tower.selected);
      if (selectedTower && (selectedTower.range ?? 0) > 0) {
        const gx = Math.max(0, Math.min(COLS - 1, Math.floor(selectedTower.x / CELL)));
        const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(selectedTower.y / CELL)));
        const h = data.heights[gy * COLS + gx] ?? 0;
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
      controls.target.set(x / CELL, groundTop(snapshot.heights[gy * COLS + gx] ?? 0), y / CELL);
      controls.update();
    };

    const reset = () => {
      const snapshot = snapshotRef.current();
      const hq = snapshot.towers.find((tower) => tower.sanctuary);
      const centerX = hq ? hq.x / CELL : 10;
      const centerZ = hq ? hq.y / CELL : 10;
      const gx = Math.max(0, Math.min(COLS - 1, Math.floor(centerX)));
      const gy = Math.max(0, Math.min(ROWS - 1, Math.floor(centerZ)));
      const terrainHeight = snapshot.heights[gy * COLS + gx] ?? 0;
      focus(centerX * CELL, centerZ * CELL);
      camera.position.set(centerX + 5, groundTop(terrainHeight) + 27, centerZ + 5);
      controls.update();
    };

    const screenToWorld = (clientX: number, clientY: number) => {
      if (!renderer) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(terrainRoot, true)[0];
      if (hit) return { x: hit.point.x * CELL, y: hit.point.z * CELL };
      const point = new THREE.Vector3();
      const intersection = raycaster.ray.intersectPlane(floorPlane, point);
      if (!intersection) return null;
      return { x: intersection.x * CELL, y: intersection.z * CELL };
    };

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.16;
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
      controls.maxDistance = 260;
      controls.minPolarAngle = THREE.MathUtils.degToRad(8);
      controls.maxPolarAngle = THREE.MathUtils.degToRad(76);
      controls.mouseButtons = {
        LEFT: -1,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };

      const snapshot = snapshotRef.current();
      const hq = snapshot.towers.find((tower) => tower.sanctuary);
      const centerX = hq ? hq.x / CELL : 10;
      const centerZ = hq ? hq.y / CELL : 10;
      const h = hq ? snapshot.heights[hq.gy * COLS + hq.gx] ?? 0 : 0;
      controls.target.set(centerX, groundTop(h), centerZ);
      camera.position.set(centerX + 5, groundTop(h) + 27, centerZ + 5);
      controls.update();

      apiRef.current = { screenToWorld, focus, reset };
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
    const render = (time: number) => {
      if (disposed) return;
      animationFrame = requestAnimationFrame(render);
      const data = snapshotRef.current();

      if (time - lastBuildAt > 700) {
        lastBuildAt = time;
        let heightHash = 2166136261;
        for (let i = 0; i < data.heights.length; i++) heightHash = Math.imul(heightHash ^ (data.heights[i] ?? 0), 16777619);
        let blockedHash = 2166136261;
        for (const key of data.blocked) {
          for (let i = 0; i < key.length; i++) blockedHash = Math.imul(blockedHash ^ key.charCodeAt(i), 16777619);
        }
        const placedKey = data.placed.map((tile) => [tile.tc, tile.tr, tile.templateId, tile.rot].join(",")).join("|");
        const terrainKey = data.mapMode + "|" + placedKey + "|" + heightHash + "|" + blockedHash;
        if (terrainKey !== lastTerrainKey) {
          rebuildTerrain(data);
          lastTerrainKey = terrainKey;
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
      updateWaterRipples(time);
      const dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 0;
      lastTime = time;
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
      for (const effect of installationRings) effect.material.dispose();
      for (const effect of buildFlashEffects) effect.material.dispose();
      clearGroup(buildingRoot);
      clearGroup(actorRoot);
      for (const bar of enemyHealthBars) {
        bar.back.material.dispose();
        bar.fill.material.dispose();
      }
      selectedRangeMaterial.dispose();
      placementFillMaterial.dispose();
      placementOutlineMaterial.dispose();
      clearGroup(effectRoot);
      scene.remove(skyDome);
      skyGeometry.dispose();
      skyMaterial.dispose();
      shared.waterRipple.dispose();
      for (const texture of textureCache.values()) texture.dispose();
      for (const material of towerAccentMaterials.values()) material.dispose();
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
            建塔預覽：綠＝平地可建 · 金＝高地可建 · 紅＝不可建
            <span className="block mt-1 text-[#d8c89e]">0～3 級皆可建塔｜1／2／3 級分別有單／雙／三層岩沿</span>
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
}
