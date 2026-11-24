import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CELL, COLS, ROWS } from "./grid";
import { TILE, type PlacedTile } from "./tiles";

export type Terrain3DTower = {
  x: number; y: number; gx: number; gy: number; def: number; level: number; aim: number;
  stake?: boolean; sanctuary?: boolean; hqFireLv?: number; hqFortifyLv?: number;
  hqTurretAtk?: number[]; hqCannonAtk?: number;
  hp: number; maxHp: number; image?: HTMLImageElement | null;
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

const HEIGHT_STEP = 0.36;
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
    const rings: any[] = [];
    const gems: any[] = [];
    const turretGroups: { group: any; tower: Terrain3DTower; index: number; flash: any }[] = [];
    const towerSprites: any[] = [];
    const enemySprites: any[] = [];
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
      glass: new THREE.MeshStandardMaterial({ color: "#0b3155", roughness: 0.22, emissive: "#0876bd", emissiveIntensity: 0.5 }),
      terrain: [
        new THREE.MeshStandardMaterial({ color: MATERIALS.road, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.low, roughness: 0.92 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.mid, roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ color: MATERIALS.high, roughness: 0.88 }),
      ],
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

    const makeCannon = (parent: any, scale = 1) => {
      const cannon = new THREE.Group();
      parent.add(cannon);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.76 * scale, 0.28 * scale, 0.66 * scale), shared.blue);
      base.position.y = 0.17 * scale;
      base.castShadow = true;
      cannon.add(base);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * scale, 0.23 * scale, 1.08 * scale, 14), shared.gold);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.47 * scale, 0.34 * scale);
      barrel.castShadow = true;
      cannon.add(barrel);
      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.17 * scale, 0.055 * scale, 8, 18), shared.brightGold);
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

    const createSanctuary = (tower: Terrain3DTower, heights: number[]) => {
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
      makeCrystal(root, 0, 4.82, -0.28, 0.53);

      // 主炮始終存在，使用金屬炮身＋藍色晶體砲口
      const mainGunMount = new THREE.Group();
      mainGunMount.position.set(0, 1.55, 0.72);
      mainGunMount.rotation.y = Math.atan2(Math.cos(tower.aim), Math.sin(tower.aim));
      const mainCannon = makeCannon(mainGunMount, (tower.hqFireLv ?? 0) >= 2 ? 1.28 : 1.08);
      mainCannon.position.y = 0.12;
      root.add(mainGunMount);
      turretGroups.push({ group: mainGunMount, tower, index: -1, flash: mainCannon.userData.muzzleFlash });

      const mainRing = new THREE.Group();
      mainRing.position.set(0, 1.79, 0.72);
      const ringMesh = new THREE.Mesh(new THREE.TorusGeometry((tower.hqFireLv ?? 0) >= 2 ? 0.92 : 0.76, 0.065, 10, 44), shared.brightGold);
      ringMesh.rotation.x = Math.PI / 2;
      mainRing.add(ringMesh);
      root.add(mainRing);
      rings.push(mainRing);

      // 四座角樓先有空砲座；購買火力後才安裝砲塔和炮管
      const corners = [[-2.28, -2.28], [2.28, -2.28], [-2.28, 2.28], [2.28, 2.28]];
      for (const [cx, cz] of corners) {
        addCylinder(root, 0.52, 0.67, 0.9, cx, 1.05, cz, shared.stone, 12);
        addCylinder(root, 0.59, 0.59, 0.12, cx, 1.56, cz, shared.gold, 12);
        const spin = new THREE.Group();
        spin.position.set(cx, 1.64, cz);
        const runeRing = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.055, 8, 28), shared.brightGold);
        runeRing.rotation.x = Math.PI / 2;
        spin.add(runeRing);
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), shared.crystal);
        gem.position.y = 0.06;
        spin.add(gem);
        root.add(spin);
        rings.push(spin);
        gems.push(gem);

        if ((tower.hqFireLv ?? 0) >= 1) {
          const mount = new THREE.Group();
          mount.position.set(cx, 1.72, cz);
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
          turretGroups.push({ group: mount, tower, index: corners.findIndex(([x, z]) => x === cx && z === cz), flash: cannon.userData.muzzleFlash });
        }
      }

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
      addCylinder(root, 0.52, 0.63, 0.24, 0, 0.12, 0, shared.blue, 12);
      addCylinder(root, 0.43, 0.43, 0.08, 0, 0.28, 0, shared.gold, 12);
      buildingRoot.add(root);
    };

    const rebuildTerrain = (data: Terrain3DSnapshot) => {
      clearGroup(terrainRoot);
      const byHeight: { x: number; z: number }[][] = [[], [], [], []];
      const cells = new Set<string>();

      const addCell = (gx: number, gy: number) => {
        const key = gx + "," + gy;
        if (cells.has(key)) return;
        cells.add(key);
        const blocked = data.blocked.has(key);
        let h = data.heights[gy * COLS + gx] ?? 0;
        if (!data.placed.length && blocked && h === 0) h = 1;
        if (!blocked) h = 0;
        h = Math.max(0, Math.min(3, h | 0));
        byHeight[h].push({ x: gx + 0.5, z: gy + 0.5 });
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
        for (let i = 0; i < list.length; i++) {
          matrix.makeTranslation(list[i].x, top / 2, list[i].z);
          mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = h > 0;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        terrainRoot.add(mesh);
      }

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(COLS + 8, ROWS + 8),
        new THREE.MeshStandardMaterial({ color: "#10283a", roughness: 0.98 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(COLS / 2, -0.025, ROWS / 2);
      floor.receiveShadow = true;
      terrainRoot.add(floor);
    };

    const rebuildBuildings = (data: Terrain3DSnapshot) => {
      clearGroup(buildingRoot);
      rings.length = 0;
      gems.length = 0;
      turretGroups.length = 0;
      for (const tower of data.towers) {
        if (tower.sanctuary) createSanctuary(tower, data.heights);
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
      sprite.material.map = image && image.complete && image.naturalWidth > 0 ? getTexture(image) : null;
      sprite.material.needsUpdate = true;
    };

    const updateActors = (data: Terrain3DSnapshot, time: number) => {
      const towers = data.towers.filter((tower) => !tower.sanctuary && !tower.stake);
      for (let i = 0; i < towers.length; i++) {
        const tower = towers[i];
        const sprite = ensureSprite(towerSprites, i, actorRoot);
        updateSpriteTexture(sprite, tower.image);
        const h = data.heights[tower.gy * COLS + tower.gx] ?? 0;
        sprite.position.set(tower.x / CELL, groundTop(h) + 0.08, tower.y / CELL);
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
      }
      for (let i = data.enemies.length; i < enemySprites.length; i++) enemySprites[i].visible = false;
    };

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
          rebuildBuildings(data);
          lastBuildingKey = buildingKey;
        }
      }

      updateActors(data, time);
      updateEffects(data);
      const dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 0;
      lastTime = time;
      for (const ring of rings) ring.rotation.y += dt * 0.42;
      for (const gem of gems) {
        const pulse = 1 + Math.sin(time * 0.0022) * 0.045;
        gem.scale.setScalar(pulse);
      }
      for (const turret of turretGroups) {
        turret.group.rotation.y = Math.atan2(Math.cos(turret.tower.aim), Math.sin(turret.tower.aim));
        const flash = turret.index < 0
          ? turret.tower.hqCannonAtk ?? 0
          : turret.tower.hqTurretAtk?.[turret.index] ?? 0;
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
      clearGroup(buildingRoot);
      clearGroup(actorRoot);
      clearGroup(effectRoot);
      for (const texture of textureCache.values()) texture.dispose();
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
