export const COLS = 400;
export const ROWS = 400;
export const CELL = 32;
export const VIEW_W = 960;
export const VIEW_H = 640;
export const WORLD_W = COLS * CELL;
export const WORLD_H = ROWS * CELL;

export type Cell = { c: number; r: number };

export function cellKey(c: number, r: number) {
  return `${c},${r}`;
}

export function sameCell(a: Cell, b: Cell) {
  return a.c === b.c && a.r === b.r;
}

export function defaultEntrances(): Cell[] {
  return [
    { c: 0, r: 80 },
    { c: 0, r: 200 },
    { c: 0, r: 320 },
  ];
}

export function defaultExits(): Cell[] {
  return [
    { c: COLS - 1, r: 100 },
    { c: COLS - 1, r: 200 },
    { c: COLS - 1, r: 300 },
  ];
}

/** BFS. Uniform cost, so this is the shortest path to the nearest goal. */
export function routeToNearest(blocked: Set<string>, start: Cell, goals: Cell[]): Cell[] | null {
  if (start.c < 0 || start.r < 0 || start.c >= COLS || start.r >= ROWS) return null;
  const goalsOk = goals.filter((g) => g.c >= 0 && g.r >= 0 && g.c < COLS && g.r < ROWS && !blocked.has(cellKey(g.c, g.r)));
  if (!goalsOk.length || blocked.has(cellKey(start.c, start.r))) return null;
  const goalAt = new Uint8Array(COLS * ROWS);
  for (const g of goalsOk) goalAt[g.r * COLS + g.c] = 1;
  const startI = start.r * COLS + start.c;
  if (goalAt[startI]) return [start];
  const prev = new Int32Array(COLS * ROWS);
  prev.fill(-2);
  prev[startI] = -1;
  const q = new Int32Array(COLS * ROWS);
  let head = 0;
  let tail = 0;
  q[tail++] = startI;
  while (head < tail) {
    const cur = q[head++];
    const c = cur % COLS;
    const r = (cur / COLS) | 0;
    const nexts: number[] = [];
    if (c + 1 < COLS) nexts.push(cur + 1);
    if (c > 0) nexts.push(cur - 1);
    if (r + 1 < ROWS) nexts.push(cur + COLS);
    if (r > 0) nexts.push(cur - COLS);
    for (const n of nexts) {
      if (prev[n] !== -2) continue;
      const nc = n % COLS;
      const nr = (n / COLS) | 0;
      if (blocked.has(cellKey(nc, nr))) continue;
      prev[n] = cur;
      if (goalAt[n]) {
        const path: Cell[] = [];
        let k = n;
        while (k !== -1) {
          path.push({ c: k % COLS, r: (k / COLS) | 0 });
          k = prev[k];
        }
        return path.reverse();
      }
      q[tail++] = n;
    }
  }
  return null;
}

export function pathsForGates(blocked: Set<string>, entrances: Cell[], exits: Cell[]): Cell[][] | null {
  if (!entrances.length || !exits.length) return null;
  const paths: Cell[][] = [];
  for (const start of entrances) {
    const path = routeToNearest(blocked, start, exits);
    // 單條入口不通不整盤作廢：保留可通戰線，至少 1 條才算成功
    if (path && path.length) paths.push(path);
  }
  return paths.length ? paths : null;
}

export function pointsOf(cells: Cell[]) {
  return cells.map((c) => ({ x: c.c * CELL + CELL / 2, y: c.r * CELL + CELL / 2 }));
}

export const HEIGHT_MAX = 3;

export function emptyHeights() {
  return Array.from({ length: COLS * ROWS }, () => 0);
}

export function clampHeight(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(HEIGHT_MAX, Math.round(n)));
}

export function rangeBonus(height: number) {
  return clampHeight(height) * 30;
}

export function cellHeight(heights: number[], c: number, r: number) {
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return 0;
  return clampHeight(heights[r * COLS + c] ?? 0);
}

export type MapLayout = {
  id: string;
  name: string;
  blocked: string[];
  heights: number[];
  entrances?: Cell[];
  exits?: Cell[];
};

function stampHill(heights: number[], cx: number, cy: number, peak: number, rad = 2) {
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist > rad + 1) continue;
      const h = Math.max(1, peak - Math.max(0, dist - 1));
      const i = y * COLS + x;
      heights[i] = Math.max(heights[i], h);
    }
  }
}

function columnWall(c: number, gaps: number[]) {
  const open = new Set(gaps);
  const cells: string[] = [];
  for (let r = 0; r < ROWS; r++) if (!open.has(r)) cells.push(cellKey(c, r));
  return cells;
}

export function presetMaps(): MapLayout[] {
  const ridge = emptyHeights();
  for (let c = 16; c < COLS - 16; c += 4) {
    ridge[96 * COLS + c] = c % 40 === 0 ? 3 : 2;
    ridge[98 * COLS + c] = 1;
    ridge[300 * COLS + c] = c % 32 === 0 ? 3 : 2;
    ridge[302 * COLS + c] = 1;
  }
  const hills = emptyHeights();
  stampHill(hills, 80, 100, 3, 4);
  stampHill(hills, 180, 60, 3, 6);
  stampHill(hills, 300, 160, 2, 4);
  stampHill(hills, 140, 280, 3, 6);
  stampHill(hills, 320, 300, 3, 4);
  const corridor = [
    ...columnWall(100, [80, 82, 200, 202, 320, 322]),
    ...columnWall(220, [60, 62, 180, 182, 280, 282]),
    ...columnWall(320, [110, 112, 220, 222, 330, 332]),
  ];
  const ring: string[] = [];
  for (let c = 80; c <= 320; c++) {
    ring.push(cellKey(c, 80), cellKey(c, 320));
  }
  for (let r = 80; r <= 320; r++) {
    ring.push(cellKey(80, r), cellKey(320, r));
  }
  const ringOpen = new Set([cellKey(80, 200), cellKey(80, 201), cellKey(320, 200), cellKey(320, 201), cellKey(200, 80), cellKey(200, 320)]);
  return [
    {
      id: "preset-flat",
      name: "關卡·潮坪",
      blocked: [],
      heights: emptyHeights(),
      entrances: defaultEntrances(),
      exits: defaultExits(),
    },
    {
      id: "preset-ridge",
      name: "關卡·月脊",
      blocked: [],
      heights: ridge,
      entrances: defaultEntrances(),
      exits: defaultExits(),
    },
    {
      id: "preset-hills",
      name: "關卡·雙丘",
      blocked: [],
      heights: hills,
      entrances: [
        { c: 0, r: 60 },
        { c: 0, r: 200 },
        { c: 0, r: 340 },
      ],
      exits: [
        { c: COLS - 1, r: 100 },
        { c: COLS - 1, r: 300 },
      ],
    },
    {
      id: "preset-gates",
      name: "關卡·三門",
      blocked: [],
      heights: emptyHeights(),
      entrances: [
        { c: 0, r: 40 },
        { c: 0, r: 200 },
        { c: 0, r: 360 },
      ],
      exits: [
        { c: COLS - 1, r: 120 },
        { c: COLS - 1, r: 280 },
      ],
    },
    {
      id: "preset-hall",
      name: "關卡·長廊",
      blocked: corridor,
      heights: emptyHeights(),
      entrances: defaultEntrances(),
      exits: defaultExits(),
    },
    {
      id: "preset-ring",
      name: "關卡·環潮",
      blocked: ring.filter((k) => !ringOpen.has(k)),
      heights: emptyHeights(),
      entrances: [
        { c: 0, r: 200 },
        { c: 200, r: 0 },
      ],
      exits: [
        { c: COLS - 1, r: 200 },
        { c: 200, r: ROWS - 1 },
      ],
    },
  ];
}
