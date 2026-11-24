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
const MATERIALS = {
  road: "#344b5d",
  low: "#687c86",
  mid: "#87979a",
  high: "#a9b4b0",
  stone: "#d0d8db",
  ivory: "#e8e9df",
  blue: "#163e70",
  roof: "#2360a0",
  gold: "#c9953f",
  brightGold: "#ffe0a0",
  crystal: "#42caff",
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
    scene.background = new THREE.Color("#0a1d30");
    scene.fog = new THREE.Fog("#0a1d30", 70, 245);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    const terrainRoot = new THREE.Group();
    const buildingRoot = new THREE.Group();
    const actorRoot = new THREE.Group();
    const effectRoot = new THREE.Group();
    scene.add(terrainRoot, buildingRoot, actorRoot, effectRoot);

    scene.add(new THREE.HemisphereLight("#dff2ff", "#24394a", 1.8));
    scene.add(new THREE.AmbientLight("#91b7d5", 0.42));
    const sun = new THREE.DirectionalLight("#fff1d4", 2.65);
    sun.position.set(-32, 48, 28);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -115;
    sun.shadow.camera.right = 115;
    sun.shadow.camera.top = 115;
    sun.shadow.camera.bottom = -115;
    sun.shadow.bias = -0.0003;
    scene.add(sun);

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
      chargeCrystal: new THREE.MeshStandardMaterial({ color: "#78e6ff", metalness: 0.24, roughness: 0.16, emissive: "#00aaff", emissiveIntensity: 0.85 }),
      glass: new THREE.MeshStandardMaterial({ color: "#0b3155", roughness: 0.22, emissive: "#0876bd", emissiveIntensity: 0.5 }),
      terrain: [
        new THREE.MeshStandardMaterial({ color: MATERIALS.road, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.low, roughness: 0.92 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.mid, roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.high, roughness: 0.88 }),
      ],
      cliff: new THREE.MeshStandardMaterial({ color: "#354b59", roughness: 0.97 }),
      cliffBand: new THREE.MeshStandardMaterial({ color: "#71858a", roughness: 0.88 }),
      cliffBandLight: new THREE.MeshStandardMaterial({ color: "#aab9b5", roughness: 0.82 }),
      cliffCap: new THREE.MeshStandardMaterial({ color: "#c2cbc3", roughness: 0.76 }),
      rockDetail: new THREE.MeshStandardMaterial({ color: "#89999a", roughness: 0.96 }),
      terrainCrystal: new THREE.MeshStandardMaterial({
        color: "#4d8589",
        metalness: 0.22,
        roughness: 0.34,
        emissive: "#174d52",
        emissiveIntensity: 0.18,
      }),
      floor: new THREE.MeshStandardMaterial({ color: "#10283a", roughness: 0.98 }),
      ramp: new THREE.MeshStandardMaterial({ color: "#9aabb0", roughness: 0.9 }),
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
      const byHeight: { x: number; z: number; h: number }[][] = [[], [], [], []];
      const tileCells = new Map<string, { x: number; z: number; h: number }>();

      const addCell = (gx: number, gy: number) => {
        const key = gx + "," + gy;
        if (tileCells.has(key)) return;
        const blocked = data.blocked.has(key);
        let h = data.heights[gy * COLS + gx] ?? 0;
        if (data.mapMode === "expand" && !data.placed.length && blocked && h === 0) h = 1;
        if (!blocked) h = 0;
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

      // 裸露邊緣的層理岩壁：高度差越大，側面越深、越厚。
      const cliffDirections = [
        { dc: 0, dr: -1, dx: 0, dz: -0.46, sx: 0.94, sz: 0.08 },
        { dc: 1, dr: 0, dx: 0.46, dz: 0, sx: 0.08, sz: 0.94 },
        { dc: 0, dr: 1, dx: 0, dz: 0.46, sx: 0.94, sz: 0.08 },
        { dc: -1, dr: 0, dx: -0.46, dz: 0, sx: 0.08, sz: 0.94 },
      ];
      const cliffFaces: { x: number; y: number; z: number; sx: number; sy: number; sz: number; bandY: number; upperBandY: number }[] = [];
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

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(COLS + 8, ROWS + 8),
        shared.floor,
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(COLS / 2, -0.025, ROWS / 2);
      floor.receiveShadow = true;
      terrainRoot.add(floor);
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

    const selectedRangeMaterial = new THREE.MeshBasicMaterial({ color: "#9ad7ff", transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false });
    const selectedRange = new THREE.Mesh(new THREE.TorusGeometry(1, 0.018, 8, 96), selectedRangeMaterial);
    selectedRange.rotation.x = Math.PI / 2;
    selectedRange.visible = false;
    effectRoot.add(selectedRange);

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
      clearGroup(effectRoot);
      for (const texture of textureCache.values()) texture.dispose();
      for (const material of towerAccentMaterials.values()) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [snapshotRef, apiRef]);

  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden" style={{ background: "#0a1d30" }}>
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-[#c5dff2]">{error}</div>
      ) : (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-[#8ec8ee55] bg-[#061525cc] px-3 py-2 text-xs text-[#d7ecff] shadow-lg">
            <b className="block text-[#ffe0a0]">3D 戰場</b>
            Alt＋左鍵旋轉 · 右鍵平移 · 滾輪縮放
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg border border-[#8ec8ee33] bg-[#061525cc] px-3 py-2 text-[11px] text-[#9ec4de]">
            角色動畫沿用現有素材 · 高地具實際高度
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
