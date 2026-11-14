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
  carveH(blocked, 8, 11);
  return { id: "straight", name: "直道", blocked, ports: [port("W", 9), port("W", 10), port("E", 9), port("E", 10)] };
}
function makeCorner(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 8, 11, 0, 11);
  carveV(blocked, 8, 11, 8, TILE - 1);
  return { id: "corner", name: "轉角", blocked, ports: [port("W", 9), port("W", 10), port("S", 9), port("S", 10)] };
}
function makeTee(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 8, 11);
  carveV(blocked, 8, 11, 0, 11);
  return { id: "tee", name: "三叉", blocked, ports: [port("W", 9), port("W", 10), port("E", 9), port("E", 10), port("N", 9), port("N", 10)] };
}
function makeCross(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 8, 11);
  carveV(blocked, 8, 11);
  return { id: "cross", name: "十字", blocked, ports: [port("N", 9), port("N", 10), port("E", 9), port("E", 10), port("S", 9), port("S", 10), port("W", 9), port("W", 10)] };
}
function makeOpen(): TileTemplate {
  const blocked = emptyBlocked(false);
  for (const [c, r] of [[4, 4], [15, 4], [4, 15], [15, 15], [9, 9], [10, 10]] as const) blocked[r][c] = true;
  return {
    id: "open", name: "開闊", blocked,
    ports: [port("N", 5), port("N", 14), port("E", 5), port("E", 14), port("S", 5), port("S", 14), port("W", 5), port("W", 14)],
    heights: [{ c: 6, r: 6, h: 1 }, { c: 13, r: 6, h: 1 }, { c: 6, r: 13, h: 2 }, { c: 13, r: 13, h: 2 }],
  };
}
function makeChoke(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 9, 10);
  carveV(blocked, 3, 5, 3, 7);
  carveV(blocked, 14, 16, 12, 16);
  return {
    id: "choke", name: "瓶頸", blocked,
    ports: [port("W", 9), port("W", 10), port("E", 9), port("E", 10)],
    heights: [{ c: 9, r: 7, h: 2 }, { c: 10, r: 7, h: 2 }, { c: 9, r: 12, h: 2 }, { c: 10, r: 12, h: 2 }],
  };
}
function makeSpawn(): TileTemplate {
  const blocked = emptyBlocked(true);
  carveH(blocked, 8, 11);
  carveV(blocked, 8, 11, 0, 11);
  return {
    id: "spawn", name: "裂口", blocked,
    ports: [port("W", 9, "entrance"), port("W", 10, "entrance"), port("E", 9), port("E", 10), port("N", 9, "entrance"), port("N", 10, "entrance")],
  };
}
function makeHq(): TileTemplate {
  const blocked = emptyBlocked(false);
  for (let i = 5; i <= 14; i++) {
    blocked[5][i] = true; blocked[14][i] = true; blocked[i][5] = true; blocked[i][14] = true;
  }
  carveH(blocked, 9, 10, 5, 14);
  carveV(blocked, 9, 10, 5, 14);
  return {
    id: "hq", name: "聖地", blocked,
    ports: [port("W", 9, "exit"), port("W", 10, "exit"), port("E", 9, "exit"), port("E", 10, "exit"), port("N", 9, "exit"), port("N", 10, "exit"), port("S", 9, "exit"), port("S", 10, "exit")],
    heights: [{ c: 9, r: 9, h: 3 }, { c: 10, r: 9, h: 3 }, { c: 9, r: 10, h: 3 }, { c: 10, r: 10, h: 3 }],
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

export function seedBoard(): TileBoard {
  const board = emptyBoard();
  const midC = Math.floor(TILE_COLS / 2);
  const midR = Math.floor(TILE_ROWS / 2);
  board.placed.push({ tc: midC, tr: midR, templateId: "hq", rot: 0 });
  board.placed.push({ tc: midC - 1, tr: midR, templateId: "straight", rot: 0 });
  board.placed.push({ tc: midC - 2, tr: midR, templateId: "spawn", rot: 0 });
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
    const { heights: hs } = rotatedTemplate(tpl, p.rot);
    const origin = worldOrigin(p.tc, p.tr);
    for (const h of hs) {
      const c = origin.c + h.c, r = origin.r + h.r;
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
  let adjacent = false, connected = false;
  for (const edge of ["N", "E", "S", "W"] as Edge[]) {
    const nb = neighborSlot(tc, tr, edge);
    if (!nb || !slotOccupied(board, nb.tc, nb.tr)) continue;
    adjacent = true;
    const neighbor = board.placed.find((p) => p.tc === nb.tc && p.tr === nb.tr)!;
    const nTpl = TEMPLATE_BY_ID[neighbor.templateId];
    if (!nTpl) continue;
    const nPorts = rotatedTemplate(nTpl, neighbor.rot).ports;
    const need = opposite(edge);
    const myIdx = new Set(ports.filter((p) => p.edge === edge).map((p) => p.i));
    const theirIdx = new Set(nPorts.filter((p) => p.edge === need).map((p) => p.i));
    for (const i of myIdx) if (theirIdx.has(i)) { connected = true; break; }
  }
  return adjacent && connected;
}

export function placeTile(board: TileBoard, tc: number, tr: number, templateId: string, rot: Rot): TileBoard | null {
  if (!canPlaceTile(board, tc, tr, templateId, rot)) return null;
  return { placed: [...board.placed, { tc, tr, templateId, rot }], playerBlocked: new Set(board.playerBlocked) };
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
