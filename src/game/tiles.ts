/**
 * Modular tile expansion (Tower Dominion-style) for FoxTD.
 * Board: 20x20 slots of 20x20 cells covering 400x400.
 */
import { COLS, ROWS, cellKey, type Cell } from "./grid";

export const TILE = 20;
export const TILE_COLS = Math.floor(COLS / TILE);
export const TILE_ROWS = Math.floor(ROWS / TILE);
export const EXPAND_EVERY = 3;
export const OFFER_COUNT = 3;

export type Edge = "N" | "E" | "S" | "W";
export type Rot = 0 | 1 | 2 | 3;
export type PortKind = "path" | "entrance" | "exit";
export type Port = { edge: Edge; i: number; kind: PortKind };

export type TileTemplate = {
  id: string;
  name: string;
  blocked: boolean[][];
  ports: Port[];
  heights?: { c: number; r: number; h: number }[];
};

export type PlacedTile = { tc: number; tr: number; templateId: string; rot: Rot };
export type TileBoard = { placed: PlacedTile[]; playerBlocked: Set<string> };

function emptyBlocked(fill = false): boolean[][] {
  return Array.from({ length: TILE }, () => Array.from({ length: TILE }, () => fill));
}
function carveH(b: boolean[][], r0: number, r1: number, c0 = 0, c1 = TILE - 1) {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) b[r][c] = false;
}
function carveV(b: boolean[][], c0: number, c1: number, r0 = 0, r1 = TILE - 1) {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) b[r][c] = false;
}
function port(edge: Edge, i: number, kind: PortKind = "path"): Port {
  return { edge, i: Math.max(0, Math.min(TILE - 1, i)), kind };
}

function rotateBlocked(src: boolean[][], rot: Rot): boolean[][] {
  if (rot === 0) return src.map((row) => row.slice());
  const out = emptyBlocked(false);
  for (let r = 0; r < TILE; r++) {
    for (let c = 0; c < TILE; c++) {
      let nr = r, nc = c;
      if (rot === 1) { nr = c; nc = TILE - 1 - r; }
      else if (rot === 2) { nr = TILE - 1 - r; nc = TILE - 1 - c; }
      else { nr = TILE - 1 - c; nc = r; }
      out[nr][nc] = src[r][c];
    }
  }
  return out;
}

/** 順時針 90°×rot；索引與 blocked 旋轉一致 */
function rotatePort(p: Port, rot: Rot): Port {
  if (rot === 0) return { ...p };
  let edge = p.edge;
  let i = p.i;
  for (let k = 0; k < rot; k++) {
    // (c,r) on edge → CW: (TILE-1-r, c)
    if (edge === "N") {
      // (i,0) → (TILE-1, i) = E@i
      edge = "E";
    } else if (edge === "E") {
      // (TILE-1,i) → (TILE-1-i, TILE-1) = S@(TILE-1-i)
      edge = "S";
      i = TILE - 1 - i;
    } else if (edge === "S") {
      // (i,TILE-1) → (0, i) = W@i
      edge = "W";
    } else {
      // (0,i) → (TILE-1-i, 0) = N@(TILE-1-i)
      edge = "N";
      i = TILE - 1 - i;
    }
  }
  return { edge, i, kind: p.kind };
}

export function rotatedTemplate(t: TileTemplate, rot: Rot) {
  const blocked = rotateBlocked(t.blocked, rot);
  const ports = t.ports.map((p) => rotatePort(p, rot));
  const heights: { c: number; r: number; h: number }[] = [];
  for (const h of t.heights ?? []) {
    let c = h.c, r = h.r;
    for (let k = 0; k < rot; k++) {
      const nc = TILE - 1 - r, nr = c;
      c = nc; r = nr;
    }
    heights.push({ c, r, h: h.h });
  }
  return { blocked, ports, heights };
}

function makeStraight(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  return {
    id: "straight", name: "直道", blocked,
    ports: [port("W", 10), port("E", 10)],
    heights: [
      { c: 3, r: 6, h: 1 }, { c: 4, r: 6, h: 2 }, { c: 8, r: 6, h: 1 },
      { c: 12, r: 13, h: 1 }, { c: 15, r: 13, h: 2 }, { c: 16, r: 13, h: 1 },
    ],
  };
}
function makeCorner(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10, 0, 10);
  carveV(blocked, 10, 10, 10, TILE - 1);
  return {
    id: "corner", name: "轉角", blocked,
    ports: [port("W", 10), port("S", 10)],
    heights: [
      { c: 3, r: 6, h: 1 }, { c: 4, r: 7, h: 2 },
      { c: 13, r: 13, h: 2 }, { c: 14, r: 14, h: 1 },
    ],
  };
}
function makeTee(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  carveV(blocked, 10, 10, 0, 10);
  return {
    id: "tee", name: "三叉", blocked,
    ports: [port("W", 10), port("E", 10), port("N", 10)],
    heights: [
      { c: 4, r: 13, h: 2 }, { c: 5, r: 14, h: 1 },
      { c: 14, r: 13, h: 2 }, { c: 15, r: 4, h: 1 },
    ],
  };
}
function makeCross(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  carveV(blocked, 10, 10);
  return {
    id: "cross", name: "十字", blocked,
    ports: [port("N", 10), port("E", 10), port("S", 10), port("W", 10)],
    heights: [
      { c: 5, r: 5, h: 2 }, { c: 14, r: 5, h: 2 },
      { c: 5, r: 14, h: 1 }, { c: 14, r: 14, h: 2 },
    ],
  };
}
function makeOpen(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  carveV(blocked, 10, 10);
  // 角落空地仍可走一小塊，但不加寬主道
  for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) blocked[r][c] = false;
  for (let r = 3; r <= 5; r++) for (let c = 14; c <= 16; c++) blocked[r][c] = false;
  for (let r = 14; r <= 16; r++) for (let c = 3; c <= 5; c++) blocked[r][c] = false;
  for (let r = 14; r <= 16; r++) for (let c = 14; c <= 16; c++) blocked[r][c] = false;
  return {
    id: "open", name: "開闊", blocked,
    ports: [port("N", 10), port("E", 10), port("S", 10), port("W", 10)],
    heights: [
      { c: 5, r: 5, h: 2 }, { c: 14, r: 5, h: 2 }, { c: 5, r: 14, h: 2 }, { c: 14, r: 14, h: 2 },
      { c: 6, r: 7, h: 1 }, { c: 13, r: 7, h: 1 }, { c: 7, r: 13, h: 1 }, { c: 12, r: 13, h: 1 },
    ],
  };
}
function makeChoke(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  return {
    id: "choke", name: "瓶頸", blocked,
    ports: [port("W", 10), port("E", 10)],
    heights: [
      { c: 4, r: 6, h: 2 }, { c: 5, r: 6, h: 2 }, { c: 4, r: 7, h: 1 },
      { c: 14, r: 12, h: 2 }, { c: 15, r: 12, h: 2 }, { c: 15, r: 13, h: 1 },
      { c: 9, r: 5, h: 1 }, { c: 10, r: 14, h: 1 },
    ],
  };
}
function makeSpawn(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  carveV(blocked, 10, 10);
  return {
    id: "spawn", name: "裂口", blocked,
    ports: [
      port("W", 10, "entrance"),
      port("N", 10, "entrance"),
      port("E", 10),
      port("S", 10),
    ],
    heights: [
      { c: 4, r: 4, h: 2 }, { c: 5, r: 4, h: 1 },
      { c: 14, r: 14, h: 2 }, { c: 15, r: 5, h: 1 },
      { c: 6, r: 14, h: 1 },
    ],
  };
}
function makeHq(): TileTemplate {
  const blocked = emptyBlocked(true);
  // 四向各一條單格道路匯入聖地中心
  for (let r = 0; r < TILE; r++) blocked[r][10] = false;
  for (let c = 0; c < TILE; c++) blocked[10][c] = false;
  // 聖地核心周邊高地（不可走）
  for (const [c, r] of [[8, 8], [12, 8], [8, 12], [12, 12], [9, 9], [11, 9], [9, 11], [11, 11]] as const)
    blocked[r][c] = true;
  return {
    id: "hq",
    name: "聖地",
    blocked,
    ports: [
      port("W", 10),
      port("E", 10),
      port("N", 10),
      port("S", 10),
    ],
    heights: [
      { c: 8, r: 8, h: 3 }, { c: 12, r: 8, h: 3 }, { c: 8, r: 12, h: 3 }, { c: 12, r: 12, h: 3 },
      { c: 8, r: 11, h: 2 }, { c: 11, r: 8, h: 2 }, { c: 12, r: 11, h: 2 }, { c: 11, r: 12, h: 2 },
    ],
  };
}
function makeBridge(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  return {
    id: "bridge", name: "長橋", blocked,
    ports: [port("W", 10), port("E", 10)],
  };
}

/** 中島：中央 1×1 高地，道路上下繞行（東西向） */
function makeIslet(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  // 中心高地堵住直路
  blocked[10][10] = true;
  // 北側繞行
  for (const c of [9, 10, 11]) blocked[9][c] = false;
  blocked[10][9] = false;
  blocked[10][11] = false;
  return {
    id: "islet",
    name: "中島",
    blocked,
    ports: [port("W", 10), port("E", 10)],
    heights: [
      { c: 10, r: 10, h: 3 },
      { c: 8, r: 8, h: 1 }, { c: 12, r: 8, h: 1 },
      { c: 8, r: 12, h: 2 }, { c: 12, r: 12, h: 1 },
    ],
  };
}

/** 台地：中央 2×2 高地，道路繞行兩側 */
function makeMesa(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10);
  // 2×2 高地（堵住中線）
  for (const r of [9, 10]) for (const c of [9, 10]) blocked[r][c] = true;
  // 北側繞行
  for (const c of [8, 9, 10, 11]) blocked[8][c] = false;
  blocked[9][8] = false;
  blocked[9][11] = false;
  // 南側繞行（雙線擇一仍算單道主脈，南側作備援）
  for (const c of [8, 9, 10, 11]) blocked[11][c] = false;
  blocked[10][8] = false;
  blocked[10][11] = false;
  return {
    id: "mesa",
    name: "台地",
    blocked,
    ports: [port("W", 10), port("E", 10)],
    heights: [
      { c: 9, r: 9, h: 3 }, { c: 10, r: 9, h: 3 },
      { c: 9, r: 10, h: 2 }, { c: 10, r: 10, h: 3 },
      { c: 7, r: 7, h: 1 }, { c: 12, r: 7, h: 1 },
      { c: 7, r: 12, h: 1 }, { c: 12, r: 12, h: 2 },
    ],
  };
}

/** 彎島：轉角中間放 1×1 高地，道路外彎 */
function makeCornerIslet(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 10, 10, 0, 10);
  carveV(blocked, 10, 10, 10, TILE - 1);
  blocked[10][10] = true;
  // 外角繞行
  blocked[9][9] = false;
  blocked[9][10] = false;
  blocked[10][9] = false;
  blocked[11][10] = false;
  blocked[11][11] = false;
  blocked[10][11] = false;
  return {
    id: "corner_islet",
    name: "角島",
    blocked,
    ports: [port("W", 10), port("S", 10)],
    heights: [
      { c: 10, r: 10, h: 3 },
      { c: 7, r: 7, h: 1 }, { c: 13, r: 13, h: 2 },
    ],
  };
}

export const TILE_TEMPLATES: TileTemplate[] = [
  makeStraight(), makeCorner(), makeTee(), makeCross(), makeOpen(), makeChoke(), makeSpawn(), makeHq(), makeBridge(),
  makeIslet(), makeMesa(), makeCornerIslet(),
];
export const TEMPLATE_BY_ID: Record<string, TileTemplate> = Object.fromEntries(TILE_TEMPLATES.map((t) => [t.id, t]));
export const OFFERABLE_IDS = TILE_TEMPLATES.filter((t) => t.id !== "hq").map((t) => t.id);

export type TileOfferBias = {
  seed?: number;
  weights?: Partial<Record<string, number>>;
  chaos?: number;
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  straight: 1.0,
  corner: 1.05,
  tee: 1.0,
  cross: 0.9,
  open: 0.7,
  choke: 1.1,
  spawn: 0.55,
  bridge: 0.85,
  islet: 1.25,
  mesa: 1.15,
  corner_islet: 1.1,
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let tileRng: () => number = Math.random;
let tileRngSeed: number | null = null;

export function setTileRngSeed(seed: number | null) {
  if (seed == null || !Number.isFinite(seed)) {
    tileRng = Math.random;
    tileRngSeed = null;
    return;
  }
  tileRngSeed = seed >>> 0;
  tileRng = mulberry32(tileRngSeed);
}

export function getTileRngSeed(): number | null {
  return tileRngSeed;
}

export function tileRandom(): number {
  return tileRng();
}

function shuffleWith<T>(arr: T[], rnd: () => number = tileRandom): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightOf(id: string, weights?: Partial<Record<string, number>>): number {
  const w = weights?.[id] ?? DEFAULT_WEIGHTS[id] ?? 1;
  return Math.max(0, w);
}

function weightedPick(ids: string[], weights?: Partial<Record<string, number>>, rnd: () => number = tileRandom): string | null {
  if (!ids.length) return null;
  let sum = 0;
  const ws = ids.map((id) => {
    const w = weightOf(id, weights);
    sum += w;
    return w;
  });
  if (sum <= 0) return ids[Math.floor(rnd() * ids.length)];
  let r = rnd() * sum;
  for (let i = 0; i < ids.length; i++) {
    r -= ws[i];
    if (r <= 0) return ids[i];
  }
  return ids[ids.length - 1];
}

export function emptyBoard(): TileBoard {
  return { placed: [], playerBlocked: new Set() };
}
export function tileKey(tc: number, tr: number) { return tc + "," + tr; }
export function slotOccupied(board: TileBoard, tc: number, tr: number) {
  return board.placed.some((p) => p.tc === tc && p.tr === tr);
}
export function worldOrigin(tc: number, tr: number): Cell {
  return { c: tc * TILE, r: tr * TILE };
}

export function edgeHasRoad(ports: Port[], edge: Edge): boolean {
  return ports.some((p) => p.edge === edge);
}

/**
 * 單邊銜接規則（硬約束）：
 * - 雙方都無道路（空地／牆）→ 可接
 * - 一方有路、一方空地 → 不可接（空地不能接到道路上）
 * - 雙方都有路 → 必須至少一個端口索引 i 重疊（路心對上路心）
 */
export function edgesRoadCompatible(myPorts: Port[], myEdge: Edge, theirPorts: Port[], theirEdge: Edge): boolean {
  const mine = new Set(myPorts.filter((p) => p.edge === myEdge).map((p) => p.i));
  const theirs = new Set(theirPorts.filter((p) => p.edge === theirEdge).map((p) => p.i));
  const myRoad = mine.size > 0;
  const theirRoad = theirs.size > 0;
  // 空地 ↔ 空地
  if (!myRoad && !theirRoad) return true;
  // 空地 ↔ 道路：禁止
  if (myRoad !== theirRoad) return false;
  // 道路 ↔ 道路：端口必須對齊
  for (const i of mine) if (theirs.has(i)) return true;
  return false;
}

export function seedBoard(): TileBoard {
  const board = emptyBoard();
  const midC = Math.floor(TILE_COLS / 2);
  const midR = Math.floor(TILE_ROWS / 2);
  board.placed.push({ tc: midC, tr: midR, templateId: "hq", rot: 0 });
  return board;
}

export function buildBlocked(board: TileBoard): Set<string> {
  const open = new Set<string>();
  for (const p of board.placed) {
    const tpl = TEMPLATE_BY_ID[p.templateId];
    if (!tpl) continue;
    const { blocked } = rotatedTemplate(tpl, p.rot);
    const origin = worldOrigin(p.tc, p.tr);
    for (let r = 0; r < TILE; r++) for (let c = 0; c < TILE; c++) {
      if (!blocked[r][c]) open.add(cellKey(origin.c + c, origin.r + r));
    }
  }
  const blocked = new Set<string>();
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const k = cellKey(c, r);
    if (!open.has(k)) blocked.add(k);
  }
  for (const k of board.playerBlocked) blocked.add(k);
  return blocked;
}

/**
 * 高地：所有「非道路」格程序化生成高度 0～3（穩定雜湊，同局可重現）
 * 道路與未解鎖格為 0 且不可建塔。
 */
/**
 * 程序化高地（value noise + 道路鄰近衰減 + 模板覆蓋）
 * - 道路永遠高度 0
 * - 近路偏低、遠路可抬高 → 戰術可讀、成片台地
 * - 中島／台地等模板 heights 覆寫
 */
export function buildHeights(board: TileBoard): number[] {
  const heights = Array.from({ length: COLS * ROWS }, () => 0);
  const hash01 = (c: number, r: number, salt: number) => {
    let h = (c * 73856093) ^ (r * 19349663) ^ (salt * 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h >>> 0) / 4294967296;
  };
  // 雙線性 value noise（格點隨機 → 平滑插值）
  const fade = (t: number) => t * t * (3 - 2 * t);
  const valueNoise = (x: number, y: number, salt: number, scale: number) => {
    const xs = x / scale;
    const ys = y / scale;
    const x0 = Math.floor(xs);
    const y0 = Math.floor(ys);
    const fx = fade(xs - x0);
    const fy = fade(ys - y0);
    const v00 = hash01(x0, y0, salt);
    const v10 = hash01(x0 + 1, y0, salt);
    const v01 = hash01(x0, y0 + 1, salt);
    const v11 = hash01(x0 + 1, y0 + 1, salt);
    const a = v00 * (1 - fx) + v10 * fx;
    const b = v01 * (1 - fx) + v11 * fx;
    return a * (1 - fy) + b * fy;
  };
  // 沿用每局地塊 RNG 種子，使用世界座標統一採樣，地塊接縫不會突然換一套噪聲。
  // 同一局重建／擴張時既有區域的高地分布保持穩定。
  const worldSalt = tileRngSeed ?? 0x4e554c;
  // 三層八度 + domain warp + ridged noise：先形成山脈大形，再雕出側脊與風蝕細溝。
  const fbm = (c: number, r: number, _salt: number) => {
    const warpX = (valueNoise(c + 17, r - 29, worldSalt ^ 0x68bc21eb, 16.0) - 0.5) * 5.2;
    const warpY = (valueNoise(c - 23, r + 41, worldSalt ^ 0x02e5be93, 16.0) - 0.5) * 5.2;
    const wx = c + warpX;
    const wy = r + warpY;
    const broad = valueNoise(wx, wy, worldSalt ^ 0x9e3779b9, 13.5);
    const middle = valueNoise(wx * 0.98 + 31, wy * 0.98 - 19, worldSalt, 6.2);
    const fine = valueNoise(c + 47, r - 13, worldSalt ^ 0x85ebca6b, 2.9);
    const ridgeSource = valueNoise(wx * 0.82 - 7, wy * 0.82 + 11, worldSalt ^ 0xc2b2ae35, 9.2);
    const ridged = 1.0 - Math.abs(ridgeSource * 2.0 - 1.0);
    return Math.max(0, Math.min(1,
      broad * 0.39 + middle * 0.31 + fine * 0.12 + ridged * 0.18,
    ));
  };

  const roadDist = new Map<string, number>(); // 可建格到最近道路的粗距
  for (const p of board.placed) {
    const tpl = TEMPLATE_BY_ID[p.templateId];
    if (!tpl) continue;
    const { blocked } = rotatedTemplate(tpl, p.rot);
    const origin = worldOrigin(p.tc, p.tr);
    const salt = worldSalt;
    const isHq = p.templateId === "hq";

    // 先標記道路鄰居距離（切比雪夫 0～3）
    for (let lr = 0; lr < TILE; lr++) {
      for (let lc = 0; lc < TILE; lc++) {
        if (blocked[lr][lc]) continue;
        for (let dr = -3; dr <= 3; dr++) {
          for (let dc = -3; dc <= 3; dc++) {
            const nlr = lr + dr, nlc = lc + dc;
            if (nlr < 0 || nlc < 0 || nlr >= TILE || nlc >= TILE) continue;
            if (!blocked[nlr][nlc]) continue;
            const k = cellKey(origin.c + nlc, origin.r + nlr);
            const d = Math.max(Math.abs(dc), Math.abs(dr));
            const prev = roadDist.get(k);
            if (prev === undefined || d < prev) roadDist.set(k, d);
          }
        }
      }
    }

    for (let lr = 0; lr < TILE; lr++) {
      for (let lc = 0; lc < TILE; lc++) {
        if (!blocked[lr][lc]) continue;
        const c = origin.c + lc;
        const r = origin.r + lr;
        if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
        if (isHq && lc >= 8 && lc <= 11 && lr >= 8 && lr <= 11) {
          heights[r * COLS + c] = 0;
          continue;
        }
        let n = fbm(c, r, salt);
        // 靠路：略壓低但仍保可辨高度（避免路邊全是 height0 讓玩家以為不能建）
        const rd = roadDist.get(cellKey(c, r));
        if (rd !== undefined) {
          if (rd <= 1) n = 0.28 + n * 0.42;
          else if (rd === 2) n = 0.22 + n * 0.55;
          else n = 0.12 + n * 0.78;
        }
        // 量化到 1～3（可建高地一律至少 Lv1）
        let h = 1;
        if (n < 0.38) h = 1;
        else if (n < 0.68) h = 2;
        else h = 3;
        heights[r * COLS + c] = h;
      }
    }
    // 模板指定高度覆蓋（中島／台地等），並記錄為鎖定節點，後續平滑不改變設計高度。
    const { heights: fixed } = rotatedTemplate(tpl, p.rot);
    for (const fh of fixed) {
      const c = origin.c + fh.c;
      const r = origin.r + fh.r;
      if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
      if (!blocked[fh.r]?.[fh.c]) continue;
      heights[r * COLS + c] = Math.max(0, Math.min(3, fh.h | 0));
    }
  }

  // 輕量平滑；可建格保底高度 1
  const smoothed = heights.slice();
  for (const p of board.placed) {
    const origin = worldOrigin(p.tc, p.tr);
    const tpl = TEMPLATE_BY_ID[p.templateId];
    const rotBlocked = tpl ? rotatedTemplate(tpl, p.rot).blocked : null;
    for (let lr = 1; lr < TILE - 1; lr++) {
      for (let lc = 1; lc < TILE - 1; lc++) {
        const c = origin.c + lc;
        const r = origin.r + lr;
        if (c < 1 || r < 1 || c >= COLS - 1 || r >= ROWS - 1) continue;
        const i = r * COLS + c;
        if (heights[i] === 0) continue;
        // 八方向坡度濾波：保留山脊核心，讓肩部自然退到 Lv.2／Lv.1，
        // 對角鄰格採較低權重，減少棋盤式十字台階。
        let sum = heights[i] * 2.6;
        let weight = 2.6;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const j = (r + dr) * COLS + (c + dc);
          sum += heights[j];
          weight += 1;
        }
        for (const [dc, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          const j = (r + dr) * COLS + (c + dc);
          sum += heights[j] * 0.48;
          weight += 0.48;
        }
        const neighborhood = sum / weight;
        const ridgePreservation = heights[i] >= 3 ? 0.58 : 0.46;
        smoothed[i] = Math.max(1, Math.min(3,
          Math.round(heights[i] * ridgePreservation + neighborhood * (1 - ridgePreservation)),
        ));
      }
    }
    if (rotBlocked) {
      for (let lr = 0; lr < TILE; lr++) {
        for (let lc = 0; lc < TILE; lc++) {
          if (!rotBlocked[lr][lc]) continue;
          const c = origin.c + lc;
          const r = origin.r + lr;
          if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
          const i = r * COLS + c;
          if (heights[i] > 0 && smoothed[i] < 1) smoothed[i] = Math.max(1, heights[i]);
        }
      }
    }
  }
  return smoothed;
}

function opposite(e: Edge): Edge {
  return e === "N" ? "S" : e === "S" ? "N" : e === "E" ? "W" : "E";
}
function neighborSlot(tc: number, tr: number, edge: Edge): { tc: number; tr: number } | null {
  if (edge === "N") return tr > 0 ? { tc, tr: tr - 1 } : null;
  if (edge === "S") return tr < TILE_ROWS - 1 ? { tc, tr: tr + 1 } : null;
  if (edge === "W") return tc > 0 ? { tc: tc - 1, tr } : null;
  return tc < TILE_COLS - 1 ? { tc: tc + 1, tr } : null;
}

/**
 * 入口／出口：
 * - 出口固定聖地中心
 * - 入口 = 所有「能連通聖地」的道路外緣；路線重合時以離大本最遠的路口為準（每條枝葉一個入口）
 */
export function collectGates(board: TileBoard): { entrances: Cell[]; exits: Cell[] } {
  const exits: Cell[] = [];
  const seenX = new Set<string>();
  const pushX = (c: number, r: number) => {
    const k = c + "," + r;
    if (seenX.has(k)) return;
    seenX.add(k);
    exits.push({ c, r });
  };

  const hq = board.placed.find((x) => x.templateId === "hq");
  if (hq) {
    const origin = worldOrigin(hq.tc, hq.tr);
    // 單線十字中心為聖地終點
    pushX(origin.c + 10, origin.r + 10);
  }
  // 模板上標記的 exit 仍收（少用）
  for (const p of board.placed) {
    const tpl = TEMPLATE_BY_ID[p.templateId];
    if (!tpl) continue;
    const { ports } = rotatedTemplate(tpl, p.rot);
    const origin = worldOrigin(p.tc, p.tr);
    for (const port of ports) {
      if (port.kind !== "exit") continue;
      let c = origin.c, r = origin.r;
      if (port.edge === "N") { c += port.i; r += 0; }
      else if (port.edge === "S") { c += port.i; r += TILE - 1; }
      else if (port.edge === "W") { c += 0; r += port.i; }
      else { c += TILE - 1; r += port.i; }
      pushX(c, r);
    }
  }

  const blocked = buildBlocked(board);
  const isOpen = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < COLS && r < ROWS && !blocked.has(c + "," + r);

  // 從聖地 BFS：只走可通道路
  const dist = new Map<string, number>();
  const q: Cell[] = [];
  for (const e of exits) {
    if (!isOpen(e.c, e.r)) continue;
    const k = e.c + "," + e.r;
    if (dist.has(k)) continue;
    dist.set(k, 0);
    q.push(e);
  }
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const d0 = dist.get(cur.c + "," + cur.r)!;
    for (const [dc, dr] of dirs) {
      const nc = cur.c + dc, nr = cur.r + dr;
      if (!isOpen(nc, nr)) continue;
      const nk = nc + "," + nr;
      if (dist.has(nk)) continue;
      dist.set(nk, d0 + 1);
      q.push({ c: nc, r: nr });
    }
  }

  // 外緣候選：可連通聖地、且至少有一側不是「同圖已解鎖道路」
  // （朝向域外／牆／未解鎖槽）
  type Cand = { c: number; r: number; d: number };
  const rim: Cand[] = [];
  for (const [k, d] of dist) {
    if (d <= 2) continue; // 太靠近聖地不當入口
    const [cs, rs] = k.split(",");
    const c = Number(cs), r = Number(rs);
    let openN = 0;
    let outward = false;
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (isOpen(nc, nr) && dist.has(nc + "," + nr)) {
        openN++;
        continue;
      }
      // 外側：未在 path 上
      outward = true;
    }
    // 枝葉或貼外緣：開口少或有朝外
    if (outward && openN <= 3) rim.push({ c, r, d });
  }

  // 路線重合 → 以最遠路口為準：對 rim 做「更遠者抑制較近者」
  // 若 A 能沿道路走到 B 且 dist(B)>dist(A)，則 A 不作為入口（同一條路只留最遠）
  rim.sort((a, b) => b.d - a.d);
  const entrances: Cell[] = [];
  const suppressed = new Set<string>();

  const canReachThroughPath = (from: Cand, to: Cand): boolean => {
    // 限制步數的 BFS，只在 dist 集合內
    const goal = to.c + "," + to.r;
    const start = from.c + "," + from.r;
    if (start === goal) return true;
    const seen = new Set<string>([start]);
    const qq: Cell[] = [{ c: from.c, r: from.r }];
    let steps = 0;
    const limit = Math.abs(to.d - from.d) + 8;
    for (let i = 0; i < qq.length && steps < 4000; i++) {
      const cur = qq[i];
      steps++;
      for (const [dc, dr] of dirs) {
        const nc = cur.c + dc, nr = cur.r + dr;
        const nk = nc + "," + nr;
        if (!dist.has(nk) || seen.has(nk)) continue;
        if (nk === goal) return true;
        // 只往「離 HQ 更遠或持平」走，加速同一枝判斷
        const nd = dist.get(nk)!;
        if (nd < from.d - 2) continue;
        seen.add(nk);
        qq.push({ c: nc, r: nr });
        if (seen.size > limit * 12) break;
      }
    }
    return false;
  };

  for (const cand of rim) {
    const ck = cand.c + "," + cand.r;
    if (suppressed.has(ck)) continue;
    // 若已有更遠入口在同一條可達路上，跳過（rim 已按 d 降序，先放最遠）
    let dominated = false;
    for (const e of entrances) {
      const ed = dist.get(e.c + "," + e.r) ?? 0;
      if (ed < cand.d) continue;
      if (canReachThroughPath(cand, { c: e.c, r: e.r, d: ed })) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;
    entrances.push({ c: cand.c, r: cand.r });
    // 抑制同一枝上更近的 rim
    for (const o of rim) {
      if (o.d >= cand.d) continue;
      if (canReachThroughPath(o, cand)) suppressed.add(o.c + "," + o.r);
    }
  }

  // 保底：若演算法沒找到，退回「朝外的 entrance 端口」
  if (!entrances.length) {
    for (const p of board.placed) {
      const tpl = TEMPLATE_BY_ID[p.templateId];
      if (!tpl) continue;
      const { ports } = rotatedTemplate(tpl, p.rot);
      const origin = worldOrigin(p.tc, p.tr);
      for (const port of ports) {
        if (port.kind !== "entrance") continue;
        const nb = neighborSlot(p.tc, p.tr, port.edge);
        if (nb && slotOccupied(board, nb.tc, nb.tr)) continue;
        let c = origin.c, r = origin.r;
        if (port.edge === "N") { c += port.i; r += 0; }
        else if (port.edge === "S") { c += port.i; r += TILE - 1; }
        else if (port.edge === "W") { c += 0; r += port.i; }
        else { c += TILE - 1; r += port.i; }
        if (dist.has(c + "," + r) || isOpen(c, r)) entrances.push({ c, r });
      }
    }
  }

  // 去重
  const seenE = new Set<string>();
  const uniq: Cell[] = [];
  for (const e of entrances) {
    const k = e.c + "," + e.r;
    if (seenE.has(k)) continue;
    seenE.add(k);
    uniq.push(e);
  }

  return { entrances: uniq, exits };
}

export function frontierSlots(board: TileBoard): { tc: number; tr: number }[] {
  const occ = new Set(board.placed.map((p) => tileKey(p.tc, p.tr)));
  const found = new Set<string>();
  const out: { tc: number; tr: number }[] = [];
  for (const p of board.placed) {
    for (const edge of ["N", "E", "S", "W"] as Edge[]) {
      const nb = neighborSlot(p.tc, p.tr, edge);
      if (!nb) continue;
      const k = tileKey(nb.tc, nb.tr);
      if (occ.has(k) || found.has(k)) continue;
      found.add(k);
      out.push(nb);
    }
  }
  return out;
}

export type PlacementScore = {
  ok: boolean;
  /** 總分，越高越好 */
  score: number;
  roadLinks: number;
  /** 對齊的道路格子數（端口 i 重疊） */
  portOverlap: number;
  openRoadEdges: number;
  buriedEntrance: boolean;
};

/**
 * 評分放置：道路銜接、端口對齊、可繼續擴張、入口不要埋進已佔槽。
 * ok=false 時不可放。
 */
export function scorePlacement(
  board: TileBoard,
  tc: number,
  tr: number,
  templateId: string,
  rot: Rot,
): PlacementScore {
  const bad: PlacementScore = { ok: false, score: -1e9, roadLinks: 0, portOverlap: 0, openRoadEdges: 0, buriedEntrance: false };
  if (tc < 0 || tr < 0 || tc >= TILE_COLS || tr >= TILE_ROWS) return bad;
  if (slotOccupied(board, tc, tr)) return bad;
  const tpl = TEMPLATE_BY_ID[templateId];
  if (!tpl) return bad;
  const { ports } = rotatedTemplate(tpl, rot);

  let adjacent = false;
  let roadLinked = false;
  let neighborOffersRoad = false;
  let roadLinks = 0;
  let portOverlap = 0;
  let openRoadEdges = 0;
  let buriedEntrance = false;

  for (const edge of ["N", "E", "S", "W"] as Edge[]) {
    const nb = neighborSlot(tc, tr, edge);
    const myRoad = edgeHasRoad(ports, edge);
    const myIsEntrance = ports.some((p) => p.edge === edge && p.kind === "entrance");

    if (!nb || !slotOccupied(board, nb.tc, nb.tr)) {
      // 朝外空邊：保留道路接口有利後續擴張
      if (myRoad) openRoadEdges += 1;
      continue;
    }
    adjacent = true;
    const neighbor = board.placed.find((p) => p.tc === nb.tc && p.tr === nb.tr)!;
    const nTpl = TEMPLATE_BY_ID[neighbor.templateId];
    if (!nTpl) return bad;
    const nPorts = rotatedTemplate(nTpl, neighbor.rot).ports;
    const need = opposite(edge);
    if (!edgesRoadCompatible(ports, edge, nPorts, need)) return bad;

    const theirRoad = edgeHasRoad(nPorts, need);
    if (theirRoad) neighborOffersRoad = true;
    if (myRoad && theirRoad) {
      roadLinked = true;
      roadLinks += 1;
      // 端口索引重疊數
      const mine = new Set(ports.filter((p) => p.edge === edge).map((p) => p.i));
      const theirs = new Set(nPorts.filter((p) => p.edge === need).map((p) => p.i));
      for (const i of mine) if (theirs.has(i)) portOverlap += 1;
    }
    // 入口貼著已佔用槽 = 假入口，重罰
    if (myIsEntrance) buriedEntrance = true;
  }

  if (!adjacent) return bad;

  const selfHasRoad = (["N", "E", "S", "W"] as Edge[]).some((e) => edgeHasRoad(ports, e));

  // 硬規則：
  // 1) 鄰居邊上有道路 → 本側必須已形成至少一條道路對接（不能用空地硬貼上路）
  if (neighborOffersRoad && !roadLinked) return bad;
  // 2) 本圖有道路 → 必須至少接到鄰居的一條路（道路必須連到道路，不能只靠空地邊掛上）
  if (selfHasRoad && !roadLinked) return bad;
  // 3) 本圖完全無道路（純空地／牆）→ 只能貼在「鄰居該側也無道路」的邊上
  //    （已由每邊 edgesRoadCompatible 保證；此處若誤觸有路鄰居會在 1 擋下）
  if (!selfHasRoad && neighborOffersRoad) return bad;

  // 分數：優先多路銜接與端口對齊，其次外向接口，懲罰埋入口
  let score =
    roadLinks * 40 +
    portOverlap * 12 +
    openRoadEdges * 8 +
    (templateId === "spawn" ? (buriedEntrance ? -80 : 25) : 0) +
    (templateId === "cross" || templateId === "tee" ? 6 : 0) +
    (templateId === "open" ? 3 : 0);
  if (buriedEntrance) score -= 50;
  const hq = board.placed.find((p) => p.templateId === "hq");
  if (hq) {
    const dist = Math.abs(tc - hq.tc) + Math.abs(tr - hq.tr);
    score += Math.min(12, dist * 2);
  }

  return { ok: true, score, roadLinks, portOverlap, openRoadEdges, buriedEntrance };
}

export function canPlaceTile(board: TileBoard, tc: number, tr: number, templateId: string, rot: Rot): boolean {
  return scorePlacement(board, tc, tr, templateId, rot).ok;
}

/** 該槽最佳旋轉（同分取較小 rot） */
export function bestRotForSlot(board: TileBoard, tc: number, tr: number, templateId: string): Rot | null {
  let best: Rot | null = null;
  let bestScore = -1e9;
  for (const rot of [0, 1, 2, 3] as Rot[]) {
    const s = scorePlacement(board, tc, tr, templateId, rot);
    if (!s.ok) continue;
    if (s.score > bestScore) {
      bestScore = s.score;
      best = rot;
    }
  }
  return best;
}

/** 整板最佳放置點（模板） */
export function suggestPlacement(
  board: TileBoard,
  templateId: string,
): { tc: number; tr: number; rot: Rot; score: number } | null {
  let best: { tc: number; tr: number; rot: Rot; score: number } | null = null;
  for (const slot of frontierSlots(board)) {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const s = scorePlacement(board, slot.tc, slot.tr, templateId, rot);
      if (!s.ok) continue;
      if (!best || s.score > best.score) best = { tc: slot.tc, tr: slot.tr, rot, score: s.score };
    }
  }
  return best;
}

export function placeTile(board: TileBoard, tc: number, tr: number, templateId: string, rot: Rot): TileBoard | null {
  if (!canPlaceTile(board, tc, tr, templateId, rot)) return null;
  return { placed: [...board.placed, { tc, tr, templateId, rot }], playerBlocked: new Set(board.playerBlocked) };
}

const CARDINAL: Edge[] = ["N", "E", "S", "W"];

export function bootstrapFrontiers(board: TileBoard, bias?: TileOfferBias): TileBoard {
  const hq = board.placed.find((p) => p.templateId === "hq");
  if (!hq) return board;
  let next: TileBoard = { placed: [...board.placed], playerBlocked: new Set(board.playerBlocked) };
  const tryPlace = (tc: number, tr: number, preferSpawn: boolean): boolean => {
    const pool = placeableTemplateIds(next);
    if (!pool.length) return false;
    const ordered = preferSpawn
      ? [...pool.filter((id) => id === "spawn"), ...pool.filter((id) => id !== "spawn")]
      : shuffleWith(pool);
    for (const id of ordered) {
      for (const rot of shuffleWith([0, 1, 2, 3] as Rot[])) {
        if (!canPlaceTile(next, tc, tr, id, rot)) continue;
        const placed = placeTile(next, tc, tr, id, rot);
        if (!placed) continue;
        next = placed;
        return true;
      }
    }
    return false;
  };
  const sides = shuffleWith([...CARDINAL]);
  let hasFront = false;
  for (const edge of sides) {
    const slot = neighborSlot(hq.tc, hq.tr, edge);
    if (!slot || slotOccupied(next, slot.tc, slot.tr)) continue;
    if (tryPlace(slot.tc, slot.tr, true)) {
      hasFront = collectGates(next).entrances.length > 0;
      if (hasFront) break;
    }
  }
  for (const edge of sides) {
    const slot = neighborSlot(hq.tc, hq.tr, edge);
    if (!slot || slotOccupied(next, slot.tc, slot.tr)) continue;
    tryPlace(slot.tc, slot.tr, !hasFront);
    hasFront = collectGates(next).entrances.length > 0;
  }
  if (!hasFront) {
    for (const edge of CARDINAL) {
      const slot = neighborSlot(hq.tc, hq.tr, edge);
      if (!slot || slotOccupied(next, slot.tc, slot.tr)) continue;
      const rot = bestRotForSlot(next, slot.tc, slot.tr, "spawn");
      if (rot == null) continue;
      const placed = placeTile(next, slot.tc, slot.tr, "spawn", rot);
      if (placed) {
        next = placed;
        hasFront = true;
      }
      if (hasFront) break;
    }
  }
  return next;
}

export function isTemplatePlaceable(board: TileBoard, templateId: string): boolean {
  return validPlacements(board, templateId).length > 0;
}

export function placeableTemplateIds(board: TileBoard, exclude: string[] = []): string[] {
  const ban = new Set(exclude);
  return OFFERABLE_IDS.filter((id) => !ban.has(id) && isTemplatePlaceable(board, id));
}

export function pickOfferTemplates(
  count = OFFER_COUNT,
  board?: TileBoard,
  bias?: TileOfferBias,
): string[] {
  if (bias?.seed != null) setTileRngSeed(bias.seed);
  const chaos = Math.max(0, Math.min(1, bias?.chaos ?? 0.35));
  const weights = bias?.weights;
  const pool = board ? placeableTemplateIds(board) : [...OFFERABLE_IDS];
  if (!pool.length) return [];

  const ranked = pool
    .map((id) => {
      const sug = board ? suggestPlacement(board, id) : null;
      const fit = sug?.score ?? 0;
      const w = weightOf(id, weights);
      const jitter = (tileRandom() - 0.5) * chaos * 30;
      return { id, rank: fit * 0.5 + w * 20 + jitter };
    })
    .sort((a, b) => b.rank - a.rank);

  const family = (id: string) => {
    if (id === "spawn") return "spawn";
    if (id === "cross" || id === "tee" || id === "open") return "hub";
    if (id === "corner" || id === "straight" || id === "bridge" || id === "choke") return "path";
    return id;
  };
  const out: string[] = [];
  const usedFam = new Set<string>();
  for (const row of ranked) {
    if (out.length >= count) break;
    const fam = family(row.id);
    if (usedFam.has(fam) && out.length < count - 1) continue;
    out.push(row.id);
    usedFam.add(fam);
  }
  for (const row of ranked) {
    if (out.length >= count) break;
    if (!out.includes(row.id)) out.push(row.id);
  }
  return out.slice(0, count);
}

export function rerollOfferSlot(
  board: TileBoard,
  offers: string[],
  index: number,
  bias?: TileOfferBias,
): string | null {
  if (index < 0 || index >= offers.length) return null;
  if (bias?.seed != null) setTileRngSeed(bias.seed);
  const weights = bias?.weights;
  const others = offers.filter((_, i) => i !== index);
  let pool = placeableTemplateIds(board, [offers[index], ...others]);
  if (!pool.length) pool = placeableTemplateIds(board, [offers[index]]);
  if (!pool.length) pool = placeableTemplateIds(board);
  // 不以不可放置的地塊充數；必選擴張時，保留可行的淨界浮島保底。
  if (!pool.length) return null;
  return weightedPick(pool, weights);
}

export const DEFAULT_TILE_BIAS: TileOfferBias = {
  chaos: 0.35,
  weights: { ...DEFAULT_WEIGHTS },
};

/** 放置後是否仍至少有一條入口→聖地可通 */
export function boardHasPath(board: TileBoard): boolean {
  const blocked = buildBlocked(board);
  const { entrances, exits } = collectGates(board);
  if (!entrances.length || !exits.length) return false;
  // 輕量：只測第一個入口（完整檢查在 paths 側）
  for (const e of entrances) {
    // 延遲 import 迴圈：用 blocked 開通性粗判——格子本身可走
    if (!blocked.has(e.c + "," + e.r)) return true;
  }
  return entrances.some((e) => !blocked.has(`${e.c},${e.r}`));
}

export function shouldOfferTiles(wave: number, board: TileBoard): boolean {
  if (wave <= 0 || wave % EXPAND_EVERY !== 0) return false;
  return frontierSlots(board).length > 0;
}

export function validPlacements(board: TileBoard, templateId: string): { tc: number; tr: number; rot: Rot; score?: number }[] {
  const slots = frontierSlots(board);
  const out: { tc: number; tr: number; rot: Rot; score: number }[] = [];
  for (const s of slots) {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const sc = scorePlacement(board, s.tc, s.tr, templateId, rot);
      if (sc.ok) out.push({ tc: s.tc, tr: s.tr, rot, score: sc.score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 極端接口排列的保底地塊：依鄰格道路端口動態雕出「淨界浮島」。
 * 每個已佔用鄰邊都精確匹配道路／非道路狀態與端口索引，避免選地塊流程無牌可選。
 */
export function createTidalLiftTemplate(board: TileBoard): TileTemplate | null {
  const center = Math.floor(TILE / 2);
  const slots = frontierSlots(board);
  for (const slot of slots) {
    // 唯一 ID 保留每塊浮島自己的道路雕刻，後續擴張不會改寫已放置浮島的模板。
    const id = `tide_lift_${board.placed.length}_${slot.tc}_${slot.tr}`;
    const blocked = emptyBlocked(true);
    const ports: Port[] = [];
    let adjacent = false;
    const portSeen = new Set<string>();

    for (const edge of CARDINAL) {
      const nb = neighborSlot(slot.tc, slot.tr, edge);
      if (!nb || !slotOccupied(board, nb.tc, nb.tr)) continue;
      adjacent = true;
      const neighbor = board.placed.find((placed) => placed.tc === nb.tc && placed.tr === nb.tr);
      if (!neighbor) continue;
      const neighborTemplate = TEMPLATE_BY_ID[neighbor.templateId];
      if (!neighborTemplate) continue;
      const neighborPorts = rotatedTemplate(neighborTemplate, neighbor.rot).ports;
      const touching = opposite(edge);
      const indexes = [...new Set(neighborPorts.filter((p) => p.edge === touching).map((p) => p.i))];

      for (const index of indexes) {
        const portKey = edge + ":" + index;
        if (portSeen.has(portKey)) continue;
        portSeen.add(portKey);
        ports.push(port(edge, index));

        let c = edge === "W" ? 0 : edge === "E" ? TILE - 1 : index;
        let r = edge === "N" ? 0 : edge === "S" ? TILE - 1 : index;
        blocked[r][c] = false;
        while (c !== center) {
          c += c < center ? 1 : -1;
          blocked[r][c] = false;
        }
        while (r !== center) {
          r += r < center ? 1 : -1;
          blocked[r][c] = false;
        }
      }
    }

    if (!adjacent) continue;
    const template: TileTemplate = {
      id,
      name: "淨界浮島",
      blocked,
      ports,
      heights: [
        { c: 6, r: 6, h: 2 },
        { c: 13, r: 6, h: 1 },
        { c: 6, r: 13, h: 1 },
        { c: 13, r: 13, h: 2 },
      ],
    };
    const previous = TEMPLATE_BY_ID[id];
    TEMPLATE_BY_ID[id] = template;
    if (validPlacements(board, id).length) return template;
    if (previous) TEMPLATE_BY_ID[id] = previous;
    else delete TEMPLATE_BY_ID[id];
  }
  return null;
}

export function isCellOnBoard(board: TileBoard, c: number, r: number): boolean {
  if (!board.placed.length) return true;
  return slotOccupied(board, Math.floor(c / TILE), Math.floor(r / TILE));
}

export function isExpandBoard(board: TileBoard): boolean {
  return board.placed.length > 0;
}
