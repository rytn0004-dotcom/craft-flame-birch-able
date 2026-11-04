export const COLS = 200;
export const ROWS = 200;
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
    { c: 0, r: 40 },
    { c: 0, r: 100 },
    { c: 0, r: 160 },
  ];
}

export function defaultExits(): Cell[] {
  return [
    { c: COLS - 1, r: 70 },
    { c: COLS - 1, r: 130 },
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
    if (!path) return null;
    paths.push(path);
  }
  return paths;
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
  for (let c = 8; c < COLS - 8; c += 2) {
    ridge[48 * COLS + c] = c % 20 === 0 ? 3 : 2;
    ridge[49 * COLS + c] = 1;
    ridge[150 * COLS + c] = c % 16 === 0 ? 3 : 2;
    ridge[151 * COLS + c] = 1;
  }
  const hills = emptyHeights();
  stampHill(hills, 40, 50, 3);
  stampHill(hills, 90, 30, 3, 3);
  stampHill(hills, 150, 80, 2);
  stampHill(hills, 70, 140, 3, 3);
  stampHill(hills, 160, 150, 3);
  const corridor = [
    ...columnWall(50, [40, 41, 100, 101, 160, 161]),
    ...columnWall(110, [30, 31, 90, 91, 140, 141]),
    ...columnWall(160, [55, 56, 110, 111, 165, 166]),
  ];
  const ring: string[] = [];
  for (let c = 40; c <= 160; c++) {
    ring.push(cellKey(c, 40), cellKey(c, 160));
  }
  for (let r = 40; r <= 160; r++) {
    ring.push(cellKey(40, r), cellKey(160, r));
  }
  const ringOpen = new Set([cellKey(40, 100), cellKey(40, 101), cellKey(160, 100), cellKey(160, 101), cellKey(100, 40), cellKey(100, 160)]);
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
        { c: 0, r: 30 },
        { c: 0, r: 100 },
        { c: 0, r: 170 },
      ],
      exits: [
        { c: COLS - 1, r: 50 },
        { c: COLS - 1, r: 150 },
      ],
    },
    {
      id: "preset-gates",
      name: "關卡·三門",
      blocked: [],
      heights: emptyHeights(),
      entrances: [
        { c: 0, r: 20 },
        { c: 0, r: 100 },
        { c: 0, r: 180 },
      ],
      exits: [
        { c: COLS - 1, r: 60 },
        { c: COLS - 1, r: 140 },
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
        { c: 0, r: 100 },
        { c: 100, r: 0 },
      ],
      exits: [
        { c: COLS - 1, r: 100 },
        { c: 100, r: ROWS - 1 },
      ],
    },
  ];
}
