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

// TEMPORARY STUB — full restore in next commit
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
  return board;
}
export function buildBlocked(board: TileBoard): Set<string> {
  return new Set();
}
export function buildHeights(board: TileBoard): number[] {
  return Array.from({ length: COLS * ROWS }, () => 0);
}
export function isCellOnBoard(board: TileBoard, c: number, r: number): boolean {
  if (!board.placed.length) return true;
  return slotOccupied(board, Math.floor(c / TILE), Math.floor(r / TILE));
}
export function isExpandBoard(board: TileBoard): boolean {
  return board.placed.length > 0;
}
export const TEMPLATE_BY_ID: Record<string, TileTemplate> = {};
export const OFFERABLE_IDS: string[] = [];
export function setTileRngSeed(_seed: number | null) {}
export function getTileRngSeed(): number | null { return null; }
export function tileRandom(): number { return Math.random(); }
export function canPlaceTile() { return false; }
export function validPlacements() { return []; }
export function suggestPlacement() { return null; }
export function bestRotForSlot() { return null; }
export function collectGates() { return { entrances: [], exits: [] }; }
export function frontierSlots() { return []; }
export function bootstrapFrontiers(board: TileBoard) { return board; }
export function shouldOfferTiles() { return false; }
export function rotatedTemplate(t: TileTemplate, rot: Rot) {
  return { blocked: t.blocked, ports: t.ports, heights: t.heights ?? [] };
}
