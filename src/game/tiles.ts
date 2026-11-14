/**
 * Modular tile expansion (Tower Dominion-style) for FoxTD.
 * Board: 10x10 slots of 20x20 cells covering 200x200.
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

function rotatePort(p: Port, rot: Rot): Port {
  if (rot === 0) return { ...p };
  let { edge, i } = p;
  for (let k = 0; k < rot; k++) {
    if (edge === "N") edge = "E";
    else if (edge === "E") { edge = "S"; i = TILE - 1 - i; }
    else if (edge === "S") { edge = "W"; i = TILE - 1 - i; }
    else edge = "N";
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
  carveH(blocked, 9, 10);
  return {
    id: "straight", name: "直道", blocked,
    ports: [port("W", 9), port("W", 10), port("E", 9), port("E", 10)],
    heights: [
      { c: 3, r: 6, h: 1 }, { c: 4, r: 6, h: 2 }, { c: 8, r: 6, h: 1 },
      { c: 12, r: 13, h: 1 }, { c: 15, r: 13, h: 2 }, { c: 16, r: 13, h: 1 },
    ],
  };
}
function makeCorner(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 9, 10, 0, 10);
  carveV(blocked, 9, 10, 9, TILE - 1);
  return {
    id: "corner", name: "轉角", blocked,
    ports: [port("W", 9), port("W", 10), port("S", 9), port("S", 10)],
    heights: [
      { c: 3, r: 6, h: 1 }, { c: 4, r: 7, h: 2 },
      { c: 13, r: 13, h: 2 }, { c: 14, r: 14, h: 1 },
    ],
  };
}
function makeTee(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 9, 10);
  carveV(blocked, 9, 10, 0, 10);
  return {
    id: "tee", name: "三叉", blocked,
    ports: [port("W", 9), port("W", 10), port("E", 9), port("E", 10), port("N", 9), port("N", 10)],
    heights: [
      { c: 4, r: 13, h: 2 }, { c: 5, r: 14, h: 1 },
      { c: 14, r: 13, h: 2 }, { c: 15, r: 4, h: 1 },
    ],
  };
}
function makeCross(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 9, 10);
  carveV(blocked, 9, 10);
  return {
    id: "cross", name: "十字", blocked,
    ports: [port("N", 9), port("N", 10), port("E", 9), port("E", 10), port("S", 9), port("S", 10), port("W", 9), port("W", 10)],
    heights: [
      { c: 5, r: 5, h: 2 }, { c: 14, r: 5, h: 2 },
      { c: 5, r: 14, h: 1 }, { c: 14, r: 14, h: 2 },
    ],
  };
}
function makeOpen(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 8, 11);
  carveV(blocked, 8, 11);
  for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) blocked[r][c] = false;
  for (let r = 3; r <= 5; r++) for (let c = 14; c <= 16; c++) blocked[r][c] = false;
  for (let r = 14; r <= 16; r++) for (let c = 3; c <= 5; c++) blocked[r][c] = false;
  for (let r = 14; r <= 16; r++) for (let c = 14; c <= 16; c++) blocked[r][c] = false;
  return {
    id: "open", name: "開闊", blocked,
    ports: [port("N", 9), port("N", 10), port("E", 9), port("E", 10), port("S", 9), port("S", 10), port("W", 9), port("W", 10)],
    heights: [
      { c: 5, r: 5, h: 2 }, { c: 14, r: 5, h: 2 }, { c: 5, r: 14, h: 2 }, { c: 14, r: 14, h: 2 },
      { c: 6, r: 7, h: 1 }, { c: 13, r: 7, h: 1 }, { c: 7, r: 13, h: 1 }, { c: 12, r: 13, h: 1 },
    ],
  };
}
function makeChoke(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 9, 10);
  return {
    id: "choke", name: "瓶頸", blocked,
    ports: [port("W", 9), port("W", 10), port("E", 9), port("E", 10)],
    heights: [
      { c: 4, r: 6, h: 2 }, { c: 5, r: 6, h: 2 }, { c: 4, r: 7, h: 1 },
      { c: 14, r: 12, h: 2 }, { c: 15, r: 12, h: 2 }, { c: 15, r: 13, h: 1 },
      { c: 9, r: 5, h: 1 }, { c: 10, r: 14, h: 1 },
    ],
  };
}
function makeSpawn(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 9, 10);
  carveV(blocked, 9, 10);
  return {
    id: "spawn", name: "裂口", blocked,
    ports: [
      port("W", 9, "entrance"), port("W", 10, "entrance"),
      port("N", 9, "entrance"), port("N", 10, "entrance"),
      port("E", 9), port("E", 10),
      port("S", 9), port("S", 10),
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
  for (let r = 0; r < TILE; r++) for (let c = 9; c <= 10; c++) blocked[r][c] = false;
  for (let c = 0; c < TILE; c++) for (let r = 9; r <= 10; r++) blocked[r][c] = false;
  for (const [c, r] of [[8, 8], [12, 8], [8, 12], [12, 12]] as const) blocked[r][c] = true;
  for (const [c, r] of [[8, 11], [11, 8], [12, 11], [11, 12]] as const) blocked[r][c] = true;
  return {
    id: "hq",
    name: "聖地",
    blocked,
    ports: [
      port("W", 9), port("W", 10),
      port("E", 9), port("E", 10),
      port("N", 9), port("N", 10),
      port("S", 9), port("S", 10),
    ],
    heights: [
      { c: 8, r: 8, h: 3 }, { c: 12, r: 8, h: 3 }, { c: 8, r: 12, h: 3 }, { c: 12, r: 12, h: 3 },
      { c: 8, r: 11, h: 2 }, { c: 11, r: 8, h: 2 }, { c: 12, r: 11, h: 2 }, { c: 11, r: 12, h: 2 },
    ],
  };
}
function makeBridge(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 7, 12);
  return {
    id: "bridge", name: "長橋", blocked,
    ports: [port("W", 8), port("W", 9), port("W", 10), port("W", 11), port("E", 8), port("E", 9), port("E", 10), port("E", 11)],
  };
}

export const TILE_TEMPLATES: TileTemplate[] = [
  makeStraight(), makeCorner(), makeTee(), makeCross(), makeOpen(), makeChoke(), makeSpawn(), makeHq(), makeBridge(),
];
export const TEMPLATE_BY_ID: Record<string, TileTemplate> = Object.fromEntries(TILE_TEMPLATES.map((t) => [t.id, t]));
export const OFFERABLE_IDS = TILE_TEMPLATES.filter((t) => t.id !== "hq").map((t) => t.id);

export type TileOfferBias = {
  seed?: number;
  weights?: Partial<Record<string, number>>;
  chaos?: number;
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  straight: 1.1,
  corner: 1.15,
  tee: 1.0,
  cross: 0.95,
  open: 0.75,
  choke: 1.2,
  spawn: 0.55,
  bridge: 0.9,
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

export function edgesRoadCompatible(myPorts: Port[], myEdge: Edge, theirPorts: Port[], theirEdge: Edge): boolean {
  const mine = new Set(myPorts.filter((p) => p.edge === myEdge).map((p) => p.i));
  const theirs = new Set(theirPorts.filter((p) => p.edge === theirEdge).map((p) => p.i));
  if (mine.size === 0 && theirs.size === 0) return true;
  if (mine.size === 0 || theirs.size === 0) return false;
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

export function buildHeights(board: TileBoard): number[] {
  const heights = Array.from({ length: COLS * ROWS }, () => 0);
  for (const p of board.placed) {
    const tpl = TEMPLATE_BY_ID[p.templateId];
    if (!tpl) continue;
    const { blocked, heights: hs } = rotatedTemplate(tpl, p.rot);
    const origin = worldOrigin(p.tc, p.tr);
    for (const h of hs) {
      const lc = h.c, lr = h.r;
      if (lc < 0 || lr < 0 || lc >= TILE || lr >= TILE) continue;
      if (!blocked[lr][lc]) continue;
      const c = origin.c + lc, r = origin.r + lr;
      if (c >= 0 && r >= 0 && c < COLS && r < ROWS) heights[r * COLS + c] = h.h;
    }
  }
  return heights;
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

export function collectGates(board: TileBoard): { entrances: Cell[]; exits: Cell[] } {
  const entrances: Cell[] = [], exits: Cell[] = [];
  for (const p of board.placed) {
    const tpl = TEMPLATE_BY_ID[p.templateId];
    if (!tpl) continue;
    const { ports } = rotatedTemplate(tpl, p.rot);
    const origin = worldOrigin(p.tc, p.tr);
    for (const port of ports) {
      let c = origin.c, r = origin.r;
      if (port.edge === "N") { c += port.i; r += 0; }
      else if (port.edge === "S") { c += port.i; r += TILE - 1; }
      else if (port.edge === "W") { c += 0; r += port.i; }
      else { c += TILE - 1; r += port.i; }
      if (port.kind === "entrance") entrances.push({ c, r });
      if (port.kind === "exit") exits.push({ c, r });
    }
    if (p.templateId === "hq") {
      for (const dc of [9, 10]) for (const dr of [9, 10]) {
        exits.push({ c: origin.c + dc, r: origin.r + dr });
      }
    }
  }
  if (!exits.length) {
    const hq = board.placed.find((x) => x.templateId === "hq");
    if (hq) {
      const origin = worldOrigin(hq.tc, hq.tr);
      exits.push({ c: origin.c + 9, r: origin.r + 9 }, { c: origin.c + 10, r: origin.r + 10 });
    }
  }
  return { entrances, exits };
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

export function canPlaceTile(board: TileBoard, tc: number, tr: number, templateId: string, rot: Rot): boolean {
  if (tc < 0 || tr < 0 || tc >= TILE_COLS || tr >= TILE_ROWS) return false;
  if (slotOccupied(board, tc, tr)) return false;
  const tpl = TEMPLATE_BY_ID[templateId];
  if (!tpl) return false;
  const { ports } = rotatedTemplate(tpl, rot);
  let adjacent = false;
  let roadLinked = false;
  for (const edge of ["N", "E", "S", "W"] as Edge[]) {
    const nb = neighborSlot(tc, tr, edge);
    if (!nb || !slotOccupied(board, nb.tc, nb.tr)) continue;
    adjacent = true;
    const neighbor = board.placed.find((p) => p.tc === nb.tc && p.tr === nb.tr)!;
    const nTpl = TEMPLATE_BY_ID[neighbor.templateId];
    if (!nTpl) return false;
    const nPorts = rotatedTemplate(nTpl, neighbor.rot).ports;
    const need = opposite(edge);
    if (!edgesRoadCompatible(ports, edge, nPorts, need)) return false;
    if (edgeHasRoad(ports, edge) && edgeHasRoad(nPorts, need)) roadLinked = true;
  }
  return adjacent && roadLinked;
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
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        if (!canPlaceTile(next, slot.tc, slot.tr, "spawn", rot)) continue;
        const placed = placeTile(next, slot.tc, slot.tr, "spawn", rot);
        if (placed) {
          next = placed;
          hasFront = true;
          break;
        }
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
  const placeable = board ? placeableTemplateIds(board) : [...OFFERABLE_IDS];
  const pool = placeable.length ? placeable : [...OFFERABLE_IDS];
  const out: string[] = [];
  if (chaos < 0.99) {
    const ranked = shuffleWith(pool).sort((a, b) => {
      const jitter = (tileRandom() - 0.5) * chaos * 2;
      return weightOf(b, weights) + jitter - weightOf(a, weights);
    });
    for (const id of ranked) {
      if (out.length >= count) break;
      if (!out.includes(id)) out.push(id);
    }
  }
  let guard = 0;
  while (out.length < count && pool.length && guard++ < 32) {
    const id = weightedPick(pool, weights);
    if (id) out.push(id);
    else break;
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
  if (!pool.length) {
    const any = OFFERABLE_IDS.filter((id) => id !== offers[index]);
    if (!any.length) return null;
    return weightedPick(any, weights);
  }
  return weightedPick(pool, weights);
}

export const DEFAULT_TILE_BIAS: TileOfferBias = {
  chaos: 0.35,
  weights: { ...DEFAULT_WEIGHTS },
};

export function shouldOfferTiles(wave: number, board: TileBoard): boolean {
  if (wave <= 0 || wave % EXPAND_EVERY !== 0) return false;
  return frontierSlots(board).length > 0;
}

export function validPlacements(board: TileBoard, templateId: string): { tc: number; tr: number; rot: Rot }[] {
  const slots = frontierSlots(board);
  const out: { tc: number; tr: number; rot: Rot }[] = [];
  for (const s of slots) {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      if (canPlaceTile(board, s.tc, s.tr, templateId, rot)) out.push({ tc: s.tc, tr: s.tr, rot });
    }
  }
  return out;
}

export function isCellOnBoard(board: TileBoard, c: number, r: number): boolean {
  if (!board.placed.length) return true;
  return slotOccupied(board, Math.floor(c / TILE), Math.floor(r / TILE));
}

export function isExpandBoard(board: TileBoard): boolean {
  return board.placed.length > 0;
}
