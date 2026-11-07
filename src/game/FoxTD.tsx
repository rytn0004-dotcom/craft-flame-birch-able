import { useEffect, useRef, useState } from "react";
import { CELL, COLS, cellHeight, cellKey, defaultEntrances, defaultExits, emptyHeights, pathsForGates, pointsOf, presetMaps, rangeBonus, ROWS, sameCell, VIEW_H, VIEW_W, WORLD_H, WORLD_W, type Cell, type MapLayout } from "./grid";
import { tickBrain, type Blackboard } from "./ai";
import {
  defaultSkillsFor,
  makeSkillState,
  resolveSkill,
  tickSkillCooldowns,
  triggerCooldown,
  type SkillId,
  type SkillRuntime,
} from "./skills";
import { ENEMY_TYPES, stockBestiary, TOWERS, TRAIT_INFO, type EnemyDef, type Special, type TowerDef, type Trait } from "./types";
import {
  buildBlocked,
  buildHeights,
  collectGates,
  EXPAND_EVERY,
  isCellOnBoard,
  OFFER_COUNT,
  pickOfferTemplates,
  seedBoard,
  shouldOfferTiles,
  frontierSlots,
  type TileBoard,
} from "./tiles";

const VIEWW = VIEW_W;
const VIEWH = VIEW_H;
const GRID = CELL;
const MAX_WAVE = 20;
const STAKE_COST = 35;
const START_GOLD = 200;

/** 升級費用：前期便宜、後期遞增，避免直線爆炸 */
function upgradeCost(kind: "dmg" | "rate", level: number) {
  const base = kind === "dmg" ? 30 : 26;
  // level 1→2 ≈ 30/26, 5→6 ≈ 90/78, 10→11 ≈ 210/180
  return Math.round(base * Math.pow(level, 1.32));
}

function sellRefund(spent: number) {
  return Math.floor(spent * 0.7);
}
const MAP_KEY = "foxtd-maps-v1";
const LAST_KEY = "foxtd-last-layout";

function readSavedMaps(): MapLayout[] {
  try {
    const raw = localStorage.getItem(MAP_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as MapLayout[];
    if (!Array.isArray(data)) return [];
    return data.filter((m) => m && typeof m.name === "string" && Array.isArray(m.heights)).slice(0, 8);
  } catch {
    return [];
  }
}

function writeSavedMaps(maps: MapLayout[]) {
  localStorage.setItem(MAP_KEY, JSON.stringify(maps.slice(0, 8)));
}

function rememberLayout(layout: MapLayout) {
  localStorage.setItem(LAST_KEY, JSON.stringify(layout));
}

type Seg = { ax: number; ay: number; bx: number; by: number; len: number; start: number };
type RouteGeom = { pts: { x: number; y: number }[]; segs: Seg[]; len: number };
const routes: RouteGeom[] = [];

function geomOf(pts: { x: number; y: number }[]): RouteGeom {
  const segs: Seg[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, len, start: total });
    total += len;
  }
  return { pts, segs, len: Math.max(1, total) };
}

function loadRoutes(paths: Cell[][]) {
  routes.length = 0;
  for (const cells of paths) routes.push(geomOf(pointsOf(cells)));
  if (!routes.length) routes.push(geomOf([{ x: CELL / 2, y: CELL / 2 }]));
}

function posAt(dist: number, route = 0) {
  const live = routes[route] ?? routes[0];
  const d = Math.max(0, Math.min(live.len, dist));
  for (const s of live.segs) {
    if (d <= s.start + s.len) {
      const t = s.len === 0 ? 0 : (d - s.start) / s.len;
      return { x: s.ax + (s.bx - s.ax) * t, y: s.ay + (s.by - s.ay) * t };
    }
  }
  const last = live.pts[live.pts.length - 1] ?? { x: 0, y: 0 };
  return { x: last.x, y: last.y };
}

function routeLen(route = 0) {
  return (routes[route] ?? routes[0])?.len ?? 1;
}

function projectDist(x: number, y: number, route = 0) {
  const live = routes[route] ?? routes[0];
  let best = 0;
  let bd = 1e9;
  const step = Math.max(16, Math.floor(live.len / 400));
  for (let d = 0; d <= live.len; d += step) {
    const p = posAt(d, route);
    const dd = Math.hypot(p.x - x, p.y - y);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}


const ZOOM_MIN = 0.1;
const ZOOM_MAX = 3;

function clampCam(cam: { x: number; y: number; zoom: number }) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom || 1));
  cam.zoom = z;
  const vw = VIEWW / z;
  const vh = VIEWH / z;
  const maxX = Math.max(0, WORLD_W - vw);
  const maxY = Math.max(0, WORLD_H - vh);
  cam.x = Math.max(0, Math.min(maxX, cam.x));
  cam.y = Math.max(0, Math.min(maxY, cam.y));
}

loadRoutes(pathsForGates(new Set(), defaultEntrances(), defaultExits()) ?? [[defaultEntrances()[0]]]);

type Enemy = {
  type: number;
  dist: number;
  hp: number;
  maxHp: number;
  speed: number;
  gold: number;
  slow: number;
  slowT: number;
  burn: number;
  burnT: number;
  rootT: number;
  vuln: number;
  vulnT: number;
  r: number;
  color: string;
  phase: number;
  hurt: number;
  face: number;
  melee: boolean;
  atk: number;
  route: number;
  armor: boolean;
  regen: number;
  noslow: boolean;
  shield: number;
  boss: boolean;
  atkCd: number;
  aiSpeed: number;
  rage: boolean;
  aiAction: string;
  skills: SkillRuntime[];
  hasteT: number;
  hasteMul: number;
};

type Tower = {
  def: number;
  x: number;
  y: number;
  damage: number;
  cooldown: number;
  range: number;
  cd: number;
  level: number;
  aim: number;
  recoil: number;
  hp: number;
  maxHp: number;
  shake: number;
  stake: boolean;
  gx: number;
  gy: number;
  rateMul: number;
  terrorT: number;
  /** 累計投入金幣（建塔+升級），用於賣出退款 */
  spent: number;
};

type Shot = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  damage: number;
  special: Special;
  color: string;
  life: number;
  pierced: Set<Enemy>;
  target: Enemy | null;
};

type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number };
type Floater = { x: number; y: number; text: string; color: string; life: number };
type Ring = { x: number; y: number; r: number; max: number; color: string; life: number };
type Pop = { x: number; y: number; age: number; scale: number };

const SPRITE_SETS = {
  imp: [0, 1, 2, 3].map((i) => `/anim/imp/${i}.png?v=4`),
  brute: [0, 1, 2, 3].map((i) => `/anim/brute/${i}.png?v=4`),
  boss: [0, 1, 2, 3].map((i) => `/anim/boss/${i}.png?v=4`),
  king: [0, 1].map((i) => `/anim/king/${i}.png?v=4`),
  bolt: [0, 1, 2, 3].map((i) => `/anim/bolt/${i}.png?v=4`),
  hit: [0, 1, 2, 3].map((i) => `/anim/hit/${i}.png?v=4`),
};

const TOWER_ANIMS: string[][] = TOWERS.map((_, i) =>
  i < 5 ? [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `/anim/towers/t${String(i + 1).padStart(2, "0")}/${n}.jpg`) : [],
);

function pingIndex(count: number, step: number) {
  if (count <= 1) return 0;
  const span = count * 2 - 2;
  const k = ((step % span) + span) % span;
  return k < count ? k : span - k;
}

function AlivePortrait({ frames }: { frames: string[] }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setStep((n) => n + 1), 130);
    return () => window.clearInterval(id);
  }, []);
  return <img src={frames[pingIndex(frames.length, step)] ?? frames[0]} alt="" />;
}

type Phase = "ready" | "play" | "win" | "lose";

function spawnPlan(wave: number) {
  const list: { type: number; at: number; route: number }[] = [];
  const count = 6 + wave * 2;
  const base = Math.min(ENEMY_TYPES.length - 2, Math.floor((wave - 1) / 2));
  let t = 0.4;
  let n = 0;
  const lanes = Math.max(1, routes.length);
  for (let i = 0; i < count; i++) {
    let type = base;
    if (Math.random() < 0.22 && type > 0) type -= 1;
    if (Math.random() < 0.18 + wave * 0.02) type = Math.min(ENEMY_TYPES.length - 2, type + 1);
    list.push({ type, at: t, route: n % lanes });
    n += 1;
    t += Math.max(0.28, 0.72 - wave * 0.03);
  }
  if (wave % 5 === 0) {
    list.push({ type: Math.min(ENEMY_TYPES.length - 1, 6), at: t + 0.4, route: n % lanes });
    n += 1;
    list.push({ type: Math.min(ENEMY_TYPES.length - 1, 8), at: t + 1.0, route: n % lanes });
  }
  if (wave % 4 === 0) {
    list.push({ type: Math.min(5, 2 + Math.floor(wave / 4)), at: t + 0.6, route: n % lanes });
  }
  return list;
}

/** 無盡：有精英／Boss，數量與屬性保守，避免後期打不過 */
function endlessPlan(wave: number) {
  const list: { type: number; at: number; route: number }[] = [];
  const lanes = Math.max(1, routes.length);
  const nTypes = Math.max(1, ENEMY_TYPES.length);
  const fodder = Math.min(18, 7 + Math.floor(wave * 0.35));
  const elites = Math.min(4, Math.floor((wave + 2) / 4));
  const interval = Math.max(0.32, 0.62 - wave * 0.006);
  let t = 0.35;
  let n = 0;
  const clampType = (i: number) => Math.max(0, Math.min(nTypes - 1, i));
  const pickFodder = () => clampType(Math.floor(Math.random() * (Math.min(3, 1 + Math.floor(wave / 6)) + 1)));
  const pickElite = () => {
    const pool = [2, 3, 6, 7, 8].map(clampType);
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const pickBoss = () => {
    if (wave >= 25 && Math.random() < 0.25) return clampType(9);
    if (wave >= 15 && Math.random() < 0.45) return clampType(5);
    return clampType(4);
  };
  for (let i = 0; i < fodder; i++) {
    list.push({ type: pickFodder(), at: t, route: n % lanes });
    n += 1;
    t += interval * (0.85 + Math.random() * 0.4);
  }
  for (let i = 0; i < elites; i++) {
    list.push({ type: pickElite(), at: t, route: Math.floor(Math.random() * lanes) });
    t += interval * 1.35;
  }
  if (wave > 0 && wave % 5 === 0) {
    list.push({ type: pickBoss(), at: t + 0.6, route: Math.floor(Math.random() * lanes) });
    const guards = Math.min(4, 2 + Math.floor(wave / 15));
    for (let g = 0; g < guards; g++) {
      list.push({ type: pickFodder(), at: t + 0.9 + g * 0.35, route: g % lanes });
    }
  } else if (wave > 0 && wave % 3 === 0) {
    list.push({ type: pickElite(), at: t + 0.4, route: n % lanes });
  }
  list.sort((a, b) => a.at - b.at);
  return list;
}

function endlessScale(wave: number) {
  return Math.min(2.4, 1 + Math.log2(1 + Math.max(0, wave - 1)) * 0.28);
}

type WaveGroup = { type: number; count: number };
type WaveDef = { spawns: WaveGroup[]; gates: number[] };
const RUN_KEY = "foxtd-run-v1";

function defaultWaves(): WaveDef[] {
  const n = stockBestiary().length;
  return Array.from({ length: MAX_WAVE }, (_, i) => {
    const wave = i + 1;
    const base = Math.min(n - 1, Math.floor((wave - 1) / 2));
    const spawns: WaveGroup[] = [{ type: Math.min(base, 4), count: 6 + wave }];
    if (wave > 2) spawns.push({ type: Math.max(0, base - 1), count: 3 });
    if (wave % 4 === 0) spawns.push({ type: 6, count: 2 });
    if (wave % 5 === 0) spawns.push({ type: 5, count: 1 });
    if (wave > 8) spawns.push({ type: 7, count: 2 });
    if (wave > 12) spawns.push({ type: 8, count: 3 });
    if (wave >= 18) spawns.push({ type: 9, count: 1 });
    return { spawns, gates: [] };
  });
}

function cloneWaves(src: WaveDef[]): WaveDef[] {
  return src.map((w) => ({
    gates: [...(w.gates ?? [])],
    spawns: (w.spawns ?? []).map((g) => ({ ...g })),
  }));
}

function normalizeWaves(raw: unknown): WaveDef[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((w) => {
    if (Array.isArray(w)) return { spawns: w as WaveGroup[], gates: [] };
    if (w && typeof w === "object" && Array.isArray((w as WaveDef).spawns)) {
      const wave = w as WaveDef;
      return { spawns: wave.spawns, gates: Array.isArray(wave.gates) ? wave.gates : [] };
    }
    return { spawns: [], gates: [] };
  });
}

function queueFromGroups(groups: WaveGroup[], gates: number[], routeCount: number, typeCount: number) {
  const list: { type: number; at: number; route: number }[] = [];
  const usable = (gates.length ? gates : Array.from({ length: Math.max(1, routeCount) }, (_, i) => i)).filter(
    (i) => i >= 0 && i < Math.max(1, routeCount),
  );
  const picks = usable.length ? usable : [0];
  let spawned = 0;
  let t = 0.35;
  for (const g of groups) {
    const n = Math.max(0, Math.min(40, Math.round(g.count)));
    const type = Math.max(0, Math.min(typeCount - 1, g.type));
    for (let i = 0; i < n; i++) {
      list.push({ type, at: t, route: picks[spawned % picks.length] });
      spawned += 1;
      t += 0.38;
    }
  }
  return list;
}

function blit(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) return;
  const m = Math.max(1, Math.floor(Math.min(sw, sh) * 0.03));
  ctx.drawImage(img, m, m, sw - m * 2, sh - m * 2, dx, dy, dw, dh);
}

export function FoxTD() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [gold, setGold] = useState(START_GOLD);
  const [lives, setLives] = useState(20);
  const [wave, setWave] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [pick, setPick] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState("");
  const [speed, setSpeed] = useState(1);
  const [endless, setEndless] = useState(false);
  const [staking, setStaking] = useState(false);
  const [workshop, setWorkshop] = useState(false);
  const [paused, setPaused] = useState(false);
  const [waves, setWaves] = useState<WaveDef[] | null>(null);
  const [editWave, setEditWave] = useState(0);
  const goldRef = useRef(START_GOLD);
  const livesRef = useRef(20);
  const phaseRef = useRef<Phase>("ready");
  const pickRef = useRef<number | null>(null);
  const selRef = useRef<number | null>(null);
  const speedRef = useRef(1);
  const endlessRef = useRef(false);
  const stakeRef = useRef(false);
  const workshopRef = useRef(false);
  const pausedRef = useRef(false);
  const wavesRef = useRef<WaveDef[] | null>(null);
  const mapRef = useRef(new Set<string>());
  const heightsRef = useRef<number[]>(emptyHeights());
  const entrancesRef = useRef<Cell[]>(defaultEntrances());
  const exitsRef = useRef<Cell[]>(defaultExits());
  const bestiaryRef = useRef<EnemyDef[]>(stockBestiary());
  const toolRef = useRef<"block" | "height" | "entry" | "exit">("block");
  const brushRef = useRef(1);
  const [savedMaps, setSavedMaps] = useState<MapLayout[]>(() => readSavedMaps());
  const [mapName, setMapName] = useState("我的地圖");
  const [activeMap, setActiveMap] = useState("潮坪");
  const [tool, setTool] = useState<"block" | "height" | "entry" | "exit">("block");
  const [brush, setBrush] = useState(1);
  const [bestiary, setBestiary] = useState<EnemyDef[]>(() => stockBestiary());
  const [editMob, setEditMob] = useState(0);
  const boardRef = useRef<TileBoard>(seedBoard());
  const tileOfferRef = useRef<string[] | null>(null);
  const [tileOffer, setTileOffer] = useState<string[] | null>(null);


  useEffect(() => {
    goldRef.current = gold;
  }, [gold]);
  useEffect(() => {
    livesRef.current = lives;
  }, [lives]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    pickRef.current = pick;
  }, [pick]);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    endlessRef.current = endless;
  }, [endless]);
  useEffect(() => {
    stakeRef.current = staking;
  }, [staking]);
  useEffect(() => {
    workshopRef.current = workshop;
  }, [workshop]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    wavesRef.current = waves;
  }, [waves]);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    bestiaryRef.current = bestiary;
  }, [bestiary]);
  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);

  function gateHere(c: number, r: number) {
    return (
      entrancesRef.current.some((g) => g.c === c && g.r === r) || exitsRef.current.some((g) => g.c === c && g.r === r)
    );
  }

  const sim = useRef({
    towers: [] as Tower[],
    enemies: [] as Enemy[],
    shots: [] as Shot[],
    parts: [] as Particle[],
    floats: [] as Floater[],
    rings: [] as Ring[],
    pops: [] as Pop[],
    queue: [] as { type: number; at: number; route: number }[],
    clock: 0,
    between: 0,
    wave: 0,
    images: [] as HTMLImageElement[],
    towerFrames: [] as HTMLImageElement[][],
    sheets: {} as Record<string, HTMLImageElement[]>,
    scene: {} as Record<string, HTMLImageElement>,
    pointer: { x: 0, y: 0, down: false },
    blocked: new Set<string>(),
    heights: heightsRef.current,
    cam: {
      x: 0,
      y: Math.max(0, defaultEntrances()[1].r * CELL - VIEWH / 2),
      zoom: 1,
    },
    drag: { on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: false },
  });

  useEffect(() => {
    const imgs = TOWERS.map((t) => {
      const img = new Image();
      img.src = t.img;
      return img;
    });
    sim.current.images = imgs;
    sim.current.towerFrames = TOWER_ANIMS.map((urls) =>
      urls.map((src) => {
        const img = new Image();
        img.src = src;
        return img;
      }),
    );
    const sheets: Record<string, HTMLImageElement[]> = {};
    for (const [key, urls] of Object.entries(SPRITE_SETS)) {
      sheets[key] = urls.map((src) => {
        const img = new Image();
        img.src = src;
        return img;
      });
    }
    sim.current.sheets = sheets;
    const scene: Record<string, HTMLImageElement> = {};
    for (const [key, src] of Object.entries({
      bg: "/scene/bg.jpg",
      coral: "/scene/coral.png?v=4",
      pillar: "/scene/pillar.png?v=4",
    })) {
      const img = new Image();
      img.src = src;
      scene[key] = img;
    }
    sim.current.scene = scene;

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    let hudAcc = 0;

    const burst = (x: number, y: number, color: string, n: number, spd = 2) => {
      for (let i = 0; i < n; i++) {
        sim.current.parts.push({
          x,
          y,
          vx: (Math.random() - 0.5) * spd * 2,
          vy: (Math.random() - 0.5) * spd * 2 - 0.4,
          life: 0.45 + Math.random() * 0.35,
          max: 0.8,
          color,
          size: 2 + Math.random() * 3,
        });
      }
    };
    const float = (x: number, y: number, text: string, color: string) => {
      sim.current.floats.push({ x, y, text, color, life: 0.8 });
    };

    const applyStatus = (e: Enemy, special: Special, dmg: number) => {
      if (!e.noslow && (special === "slow" || special === "ultimate" || special === "root")) {
        e.slow = special === "root" ? 0.22 : special === "ultimate" ? 0.5 : 0.55;
        e.slowT = special === "root" ? 2.2 : 2.4;
      }
      if (special === "root" && !e.noslow) e.rootT = Math.max(e.rootT, 0.55);
      if (special === "burn" || special === "ultimate") {
        e.burn = special === "ultimate" ? 16 : 9;
        e.burnT = 3;
      }
      if (special === "break") {
        e.vuln = 1.4;
        e.vulnT = 3.2;
      }
      if (special === "execute" && e.hp > 0 && e.hp < e.maxHp * 0.18) {
        e.hp = 0;
      }
    };

    const hitEnemy = (e: Enemy, dmg: number, special: Special, color: string, px: number, py: number) => {
      let amount = dmg * (e.vulnT > 0 ? e.vuln : 1);
      if (e.armor) amount *= 0.65;
      if (e.shield > 0) {
        const used = Math.min(e.shield, amount);
        e.shield -= used;
        amount -= used;
      }
      e.hp -= amount;
      float(px, py - 16, String(Math.round(amount)), "#fff");
      applyStatus(e, special, dmg);
      burst(px, py, color, 6, 1.6);
      e.hurt = 0.22;
      sim.current.pops.push({ x: px, y: py, age: 0, scale: special === "aoe" || special === "ultimate" ? 1.35 : 0.85 });
      if (special === "aoe" || special === "ultimate") {
        sim.current.rings.push({ x: px, y: py, r: 8, max: special === "ultimate" ? 96 : 74, color, life: 0.28 });
        for (const o of sim.current.enemies) {
          if (o === e) continue;
          const p = posAt(o.dist, o.route);
          if (Math.hypot(p.x - px, p.y - py) < (special === "ultimate" ? 92 : 70)) {
            o.hp -= amount * 0.65;
            applyStatus(o, special, dmg * 0.65);
          }
        }
      }
      if (special === "chain") {
        const p0 = posAt(e.dist, e.route);
        const near = sim.current.enemies
          .filter((o) => o !== e)
          .map((o) => ({ o, d: Math.hypot(posAt(o.dist, o.route).x - p0.x, posAt(o.dist, o.route).y - p0.y) }))
          .filter((x) => x.d < 110)
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        for (const n of near) {
          n.o.hp -= dmg * 0.55;
          const np = posAt(n.o.dist, n.o.route);
          burst(np.x, np.y, "#8ef0ff", 4, 1.2);
        }
      }
    };

    const fire = (tw: Tower, target: Enemy) => {
      const def = TOWERS[tw.def];
      const p = posAt(target.dist, target.route);
      if (def.special === "pierce") {
        const ang = Math.atan2(p.y - tw.y, p.x - tw.x);
        sim.current.shots.push({
          x: tw.x,
          y: tw.y,
          tx: tw.x + Math.cos(ang) * 900,
          ty: tw.y + Math.sin(ang) * 900,
          speed: 520,
          damage: tw.damage,
          special: def.special,
          color: def.color,
          life: 1.1,
          pierced: new Set(),
          target: null,
        });
      } else {
        sim.current.shots.push({
          x: tw.x,
          y: tw.y,
          tx: p.x,
          ty: p.y,
          speed: 460,
          damage: tw.damage,
          special: def.special,
          color: def.color,
          life: 1.6,
          pierced: new Set(),
          target,
        });
      }
      burst(tw.x, tw.y, def.color, 4, 1.4);
      tw.recoil = 0.22;
      tw.aim = Math.atan2(p.y - tw.y, p.x - tw.x);
      sim.current.pops.push({
        x: tw.x + Math.cos(tw.aim) * 28,
        y: tw.y + Math.sin(tw.aim) * 28,
        age: 0,
        scale: 0.45,
      });
    };

    const step = (dt: number) => {
      const s = sim.current;
      if (phaseRef.current !== "play" || pausedRef.current) return;
      s.clock += dt;

      if (s.queue.length) {
        while (s.queue.length && s.clock >= s.queue[0].at) {
          const job = s.queue.shift()!;
          const book = bestiaryRef.current;
          const et = book[job.type] ?? book[0];
          const scale = endlessRef.current ? endlessScale(s.wave) : 1 + (s.wave - 1) * 0.16;
          const speedMul = endlessRef.current ? 1 + Math.min(0.12, (s.wave - 1) * 0.004) : 1;
          // 關卡：緩增；無盡：更慢，避免金幣雪球壓過難度
          const goldMul = endlessRef.current
            ? 1 + Math.min(0.9, s.wave * 0.035)
            : 1 + Math.min(1.6, (s.wave - 1) * 0.07);
          s.enemies.push({
            type: job.type,
            dist: 0,
            hp: et.hp * scale,
            maxHp: et.hp * scale,
            speed: et.speed * (0.96 + Math.random() * 0.08) * speedMul,
            gold: Math.max(1, Math.round(et.gold * goldMul * (1 + job.type * 0.08))),
            slow: 1,
            slowT: 0,
            burn: 0,
            burnT: 0,
            rootT: 0,
            vuln: 1,
            vulnT: 0,
            r: et.r,
            color: et.color,
            phase: Math.random() * 4,
            hurt: 0,
            face: 1,
            melee: et.traits.includes("melee"),
            atk: 0.4,
            route: job.route ?? 0,
            armor: et.traits.includes("armor"),
            regen: et.traits.includes("regen") ? et.hp * 0.04 : 0,
            noslow: et.traits.includes("noslow"),
            shield: et.traits.includes("shield") ? et.hp * scale * 0.28 : 0,
            boss: !!et.boss,
            atkCd: 0,
            aiSpeed: 1,
            rage: false,
            aiAction: "march",
            skills: makeSkillState(
              (et.skills as SkillId[] | undefined)?.length
                ? (et.skills as SkillId[])
                : defaultSkillsFor({ melee: et.traits.includes("melee"), boss: !!et.boss, traits: et.traits }),
            ),
            hasteT: 0,
            hasteMul: 1,
          });
        }
      } else if (s.enemies.length === 0 && s.wave > 0) {
        if (tileOfferRef.current && tileOfferRef.current.length) {
          s.between = 0;
        } else {
          s.between += dt;
          const cap = wavesRef.current?.length || MAX_WAVE;
          if (s.wave >= cap && !endlessRef.current) {
            phaseRef.current = "win";
            setPhase("win");
          } else if (shouldOfferTiles(s.wave, boardRef.current) && !tileOfferRef.current) {
            const opts = pickOfferTemplates(OFFER_COUNT);
            if (opts.length && frontierSlots(boardRef.current).length) {
              tileOfferRef.current = opts;
              setTileOffer(opts);
              setHover(`第 ${s.wave} 波結束 · 選擇地塊拼接（每 ${EXPAND_EVERY} 波）`);
              s.between = 0;
            } else {
              const gap = endlessRef.current ? (s.wave % 5 === 0 ? 5.5 : 4.2) : 7;
              if (s.between > gap) beginWave();
            }
          } else {
            const gap = endlessRef.current ? (s.wave % 5 === 0 ? 5.5 : 4.2) : 7;
            if (s.between > gap) beginWave();
          }
        }
      }

      for (let i = s.enemies.length - 1; i >= 0; i--) {
        const e = s.enemies[i];
        if (e.rootT > 0) e.rootT -= dt;
        if (e.slowT > 0) e.slowT -= dt;
        else e.slow = 1;
        if (e.vulnT > 0) e.vulnT -= dt;
        if (e.burnT > 0) {
          e.burnT -= dt;
          e.hp -= e.burn * dt;
          if (Math.random() < 0.35) {
            const p = posAt(e.dist, e.route);
            burst(p.x, p.y, "#ff6a2a", 1, 0.8);
          }
        }
        if (e.hurt > 0) e.hurt -= dt;
        if (e.regen > 0 && e.hp > 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + e.regen * dt);
        tickSkillCooldowns(e.skills, dt);
        if (e.atkCd > 0) e.atkCd -= dt;
        if (e.hasteT > 0) e.hasteT -= dt;
        else e.hasteMul = 1;
        const p = posAt(e.dist, e.route);
        let targetTower: number | null = null;
        let bestD = e.boss ? 56 : 48;
        const towersNear: { index: number; dist: number }[] = [];
        for (let ti = 0; ti < s.towers.length; ti++) {
          const tw = s.towers[ti];
          if (tw.stake) continue;
          const d = Math.hypot(tw.x - p.x, tw.y - p.y);
          towersNear.push({ index: ti, dist: d });
          if (d < bestD) {
            bestD = d;
            targetTower = ti;
          }
        }
        const castSkill = (id: SkillId) => {
          const fx = resolveSkill(id, { boss: e.boss, maxHp: e.maxHp, towersInRange: towersNear });
          triggerCooldown(e.skills, id);
          for (const sh of fx.shouts) float(p.x, p.y - 20, sh.text, sh.color);
          if (fx.heal) e.hp = Math.min(e.maxHp, e.hp + fx.heal);
          if (fx.shield) e.shield += fx.shield;
          if (fx.hasteT && fx.hasteMul) {
            e.hasteT = Math.max(e.hasteT, fx.hasteT);
            e.hasteMul = Math.max(e.hasteMul, fx.hasteMul);
          }
          if (fx.dash) e.dist += fx.dash;
          if (fx.towerHits) {
            for (const h of fx.towerHits) {
              const tw = s.towers[h.index];
              if (!tw || tw.stake) continue;
              tw.hp -= h.damage * (e.rage ? 1.3 : 1);
              tw.shake = 0.2;
              burst(tw.x, tw.y, "#ffb4c8", 8, 1.8);
            }
            for (let ti = s.towers.length - 1; ti >= 0; ti--) {
              if (!s.towers[ti].stake && s.towers[ti].hp <= 0) {
                float(s.towers[ti].x, s.towers[ti].y, "塔被拆毀", "#ff8aa0");
                s.towers.splice(ti, 1);
              }
            }
          }
          if (fx.terror) {
            for (const idx of fx.terror.indices) {
              const tw = s.towers[idx];
              if (!tw || tw.stake) continue;
              tw.terrorT = Math.max(tw.terrorT || 0, fx.terror.duration);
              tw.rateMul = fx.terror.rateMul;
            }
          }
          if (fx.rings) {
            for (const r of fx.rings) s.rings.push({ x: p.x, y: p.y, r: 8, max: r.r, life: 0.35, color: r.color });
          }
          burst(p.x, p.y, e.color, 6, 1.4);
          return true;
        };
        e.aiSpeed = 1;
        const bb: Blackboard = {
          t: s.clock,
          dt,
          targetTower,
          pathLeft: Math.max(0, routeLen(e.route) - e.dist),
          hpRatio: e.maxHp > 0 ? e.hp / e.maxHp : 1,
          shield: e.shield,
          boss: e.boss,
          melee: e.melee,
          canMove: e.rootT <= 0,
          lastAction: e.aiAction,
          chosenSkill: null,
          skills: e.skills,
          anyTowerInSkillRange: towersNear.some((t) => t.dist < 120),
        };
        tickBrain(e, bb, {
          attackCd: e.atkCd,
          setAttackCooldown: (sec) => { e.atkCd = sec; },
          setSpeedMul: (m) => { e.aiSpeed = m; },
          setRage: (on) => { e.rage = on; },
          shout: (text, color) => { float(p.x, p.y - 18, text, color || "#ffd27a"); },
          castSkill,
          attackTower: (towerIndex, damage) => {
            const tw = s.towers[towerIndex];
            if (!tw || tw.stake) return false;
            e.face = tw.x >= p.x ? 1 : -1;
            tw.hp -= damage * (e.rage ? 1.4 : 1);
            tw.shake = 0.18;
            burst(tw.x, tw.y, e.rage ? "#ff6fa8" : "#ffb4c8", e.boss ? 10 : 6, 1.8);
            if (tw.hp <= 0) {
              s.towers.splice(towerIndex, 1);
              float(tw.x, tw.y, "塔被拆毀", "#ff8aa0");
            }
            return true;
          },
        });
        e.aiAction = bb.lastAction;
        if (e.rootT <= 0 && e.aiSpeed > 0.05) {
          const slow = e.noslow ? 1 : e.slowT > 0 ? e.slow : 1;
          e.dist += e.speed * slow * e.aiSpeed * e.hasteMul * (e.rage ? 1.12 : 1) * dt;
        }
        if (e.dist >= routeLen(e.route)) {
          livesRef.current -= 1;
          setLives(livesRef.current);
          s.enemies.splice(i, 1);
          if (livesRef.current <= 0) {
            phaseRef.current = "lose";
            setPhase("lose");
          }
          continue;
        }
        if (e.hp <= 0) {
          goldRef.current += e.gold;
          setGold(goldRef.current);
          const p = posAt(e.dist, e.route);
          float(p.x, p.y, `+${e.gold}`, "#ffd27a");
          burst(p.x, p.y, e.color, 12, 2.4);
          s.enemies.splice(i, 1);
        }
      }

      for (const tw of s.towers) {
        if (tw.terrorT > 0) {
          tw.terrorT -= dt;
          if (tw.terrorT <= 0) tw.rateMul = 1;
        } else if (tw.rateMul === undefined) tw.rateMul = 1;
        tw.cd -= dt;
        let best: Enemy | null = null;
        let bestDist = -1;
        for (const e of s.enemies) {
          const p = posAt(e.dist, e.route);
          const d = Math.hypot(p.x - tw.x, p.y - tw.y);
          if (d <= tw.range && e.dist > bestDist) {
            bestDist = e.dist;
            best = e;
          }
        }
        if (best && tw.cd <= 0) {
          tw.cd = tw.cooldown / (tw.rateMul > 0 ? tw.rateMul : 1);
          fire(tw, best);
        } else if (best) {
          const p = posAt(best.dist, best.route);
          tw.aim = Math.atan2(p.y - tw.y, p.x - tw.x);
        }
        if (tw.recoil > 0) tw.recoil -= dt;
        if (tw.shake > 0) tw.shake -= dt;
      }

      for (let i = s.shots.length - 1; i >= 0; i--) {
        const sh = s.shots[i];
        sh.life -= dt;
        if (sh.special !== "pierce" && sh.target && s.enemies.includes(sh.target)) {
          const p = posAt(sh.target.dist, sh.target.route);
          sh.tx = p.x;
          sh.ty = p.y;
        }
        const dx = sh.tx - sh.x;
        const dy = sh.ty - sh.y;
        const dist = Math.hypot(dx, dy) || 1;
        const stepLen = sh.speed * dt;
        sh.x += (dx / dist) * stepLen;
        sh.y += (dy / dist) * stepLen;
        if (Math.random() < 0.7) burst(sh.x, sh.y, sh.color, 1, 0.4);

        if (sh.special === "pierce") {
          for (const e of s.enemies) {
            if (sh.pierced.has(e)) continue;
            const p = posAt(e.dist, e.route);
            if (Math.hypot(p.x - sh.x, p.y - sh.y) < e.r + 10) {
              sh.pierced.add(e);
              hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y);
            }
          }
          if (sh.life <= 0 || dist < stepLen) s.shots.splice(i, 1);
        } else if (dist < 14 || sh.life <= 0) {
          const victims: Enemy[] = [];
          if (sh.target && s.enemies.includes(sh.target)) victims.push(sh.target);
          else {
            let near: Enemy | null = null;
            let nd = 36;
            for (const e of s.enemies) {
              const p = posAt(e.dist, e.route);
              const dd = Math.hypot(p.x - sh.x, p.y - sh.y);
              if (dd < nd) {
                nd = dd;
                near = e;
              }
            }
            if (near) victims.push(near);
          }
          for (const e of victims) {
            const p = posAt(e.dist, e.route);
            hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y);
          }
          if (!victims.length && (sh.special === "aoe" || sh.special === "ultimate")) {
            hitEnemyArea(sh);
          }
          s.shots.splice(i, 1);
        }
      }

      function hitEnemyArea(sh: Shot) {
        sim.current.rings.push({ x: sh.x, y: sh.y, r: 6, max: 70, color: sh.color, life: 0.25 });
        for (const e of sim.current.enemies) {
          const p = posAt(e.dist, e.route);
          if (Math.hypot(p.x - sh.x, p.y - sh.y) < 70) hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y);
        }
      }

      for (let i = s.parts.length - 1; i >= 0; i--) {
        const p = s.parts[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= dt;
        if (p.life <= 0) s.parts.splice(i, 1);
      }
      for (let i = s.floats.length - 1; i >= 0; i--) {
        const f = s.floats[i];
        f.y -= 28 * dt;
        f.life -= dt;
        if (f.life <= 0) s.floats.splice(i, 1);
      }
      for (let i = s.rings.length - 1; i >= 0; i--) {
        const r = s.rings[i];
        r.life -= dt;
        r.r += (r.max - r.r) * Math.min(1, dt * 8);
        if (r.life <= 0) s.rings.splice(i, 1);
      }
      for (let i = s.pops.length - 1; i >= 0; i--) {
        s.pops[i].age += dt;
        if (s.pops[i].age > 0.28) s.pops.splice(i, 1);
      }

      hudAcc += dt;
      if (hudAcc > 0.25) hudAcc = 0;
    };

    const beginWave = () => {
      const s = sim.current;
      const cap = wavesRef.current?.length || MAX_WAVE;
      if (!endlessRef.current && s.wave >= cap) return;
      if (s.queue.length || s.enemies.length) return;
      s.wave += 1;
      s.clock = 0;
      s.between = 0;
      const custom = wavesRef.current;
      const book = bestiaryRef.current;
      if (endlessRef.current) {
        s.queue = endlessPlan(s.wave);
      } else if (custom && custom.length) {
        const wave = custom[Math.min(custom.length - 1, s.wave - 1)];
        s.queue = queueFromGroups(wave?.spawns ?? [], wave?.gates ?? [], routes.length, book.length);
      } else {
        s.queue = spawnPlan(s.wave);
      }
      setWave(s.wave);
    };
    (canvas as HTMLCanvasElement & { __begin?: () => void }).__begin = beginWave;

    const draw = () => {
      const s = sim.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, VIEWW, VIEWH);
      const bg = s.scene.bg;
      if (bg && bg.complete && bg.naturalWidth) {
        ctx.drawImage(bg, 0, 0, VIEWW, VIEWH);
      } else {
        ctx.fillStyle = "#0c2742";
        ctx.fillRect(0, 0, VIEWW, VIEWH);
      }
      ctx.fillStyle = "rgba(4, 14, 28, 0.28)";
      ctx.fillRect(0, 0, VIEWW, VIEWH);
      const t = performance.now() / 1000;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 18;
      for (let i = 0; i < 4; i++) {
        const x = 80 + i * 230 + Math.sin(t * 0.4 + i) * 12;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 30, VIEWH);
        ctx.stroke();
      }
      ctx.save();
      const z = s.cam.zoom || 1;
      ctx.scale(z, z);
      ctx.translate(-s.cam.x, -s.cam.y);
      const decor: { key: string; x: number; y: number; w: number; h: number }[] = [
        { key: "coral", x: 40, y: 430, w: 120, h: 120 },
        { key: "pillar", x: 250, y: 40, w: 90, h: 150 },
        { key: "coral", x: 700, y: 40, w: 130, h: 110 },
        { key: "pillar", x: 470, y: 250, w: 78, h: 140 },
        { key: "coral", x: 860, y: 300, w: 110, h: 120 },
      ];
      for (const d of decor) {
        const img = s.scene[d.key];
        if (!img || !img.complete || !img.naturalWidth) continue;
        const bob = Math.sin(t * 1.3 + d.x) * 3;
        ctx.globalAlpha = 0.9;
        blit(ctx, img, d.x, d.y + bob, d.w, d.h);
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = "rgba(180,230,255,0.08)";
      ctx.lineWidth = 1;
      const vz = s.cam.zoom || 1;
      const x0 = Math.max(0, Math.floor(s.cam.x / CELL) - 1);
      const y0 = Math.max(0, Math.floor(s.cam.y / CELL) - 1);
      const x1 = Math.min(COLS - 1, Math.ceil((s.cam.x + VIEWW / vz) / CELL) + 1);
      const y1 = Math.min(ROWS - 1, Math.ceil((s.cam.y + VIEWH / vz) / CELL) + 1);
      if (pickRef.current !== null || workshopRef.current) {
        ctx.beginPath();
        for (let x = x0; x <= x1; x++) {
          ctx.moveTo(x * CELL, y0 * CELL);
          ctx.lineTo(x * CELL, (y1 + 1) * CELL);
        }
        for (let y = y0; y <= y1; y++) {
          ctx.moveTo(x0 * CELL, y * CELL);
          ctx.lineTo((x1 + 1) * CELL, y * CELL);
        }
        ctx.stroke();
      }

      // 可走地板：淺砂／潮坪，和域外深海對比
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          if (!isCellOnBoard(boardRef.current, c, r)) continue;
          const key = cellKey(c, r);
          if (s.blocked.has(key)) continue;
          const x = c * CELL, y = r * CELL;
          const h = ((c * 374761) ^ (r * 668265)) >>> 0;
          const tint = (h % 12) / 12;
          ctx.fillStyle = `rgba(${30 + tint * 20 | 0}, ${70 + tint * 25 | 0}, ${90 + tint * 30 | 0}, 0.42)`;
          ctx.fillRect(x, y, CELL, CELL);
          // 偶發淺色砂粒，不要整格線
          if ((h % 7) === 0) {
            ctx.fillStyle = "rgba(180, 220, 230, 0.12)";
            ctx.fillRect(x + 6, y + 10, 4, 3);
          }
        }
      }

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      routes.forEach((live, idx) => {
        ctx.beginPath();
        if (!live.pts.length) return;
        ctx.moveTo(live.pts[0].x, live.pts[0].y);
        for (let i = 1; i < live.pts.length; i++) ctx.lineTo(live.pts[i].x, live.pts[i].y);
        ctx.strokeStyle = idx % 2 === 0 ? "rgba(255,236,190,0.28)" : "rgba(180,220,255,0.28)";
        ctx.lineWidth = 28;
        ctx.stroke();
        ctx.strokeStyle = "rgba(120,210,255,0.22)";
        ctx.lineWidth = 12;
        ctx.stroke();
      });

      ctx.fillStyle = "rgba(210,245,255,0.35)";
      for (let i = 0; i < 18; i++) {
        const bx = s.cam.x + ((i * 137 + t * 22) % VIEWW);
        const by = s.cam.y + ((i * 90 + t * 36) % VIEWH);
        ctx.beginPath();
        ctx.arc(bx, by, 2 + (i % 4), 0, Math.PI * 2);
        ctx.fill();
      }

      if (pickRef.current !== null && !stakeRef.current && phaseRef.current === "play") {
        const def = TOWERS[pickRef.current];
        const gx = Math.floor(s.pointer.x / GRID);
        const gy = Math.floor(s.pointer.y / GRID);
        const px = gx * GRID + GRID / 2;
        const py = gy * GRID + GRID / 2;
        const bonus = rangeBonus(cellHeight(s.heights, gx, gy));
        const ok = canPlace(gx, gy);
        ctx.beginPath();
        ctx.arc(px, py, def.range + bonus, 0, Math.PI * 2);
        ctx.fillStyle = ok ? "rgba(120,200,255,0.1)" : "rgba(255,80,80,0.12)";
        ctx.fill();
        ctx.strokeStyle = ok ? "rgba(140,210,255,0.55)" : "rgba(255,90,90,0.6)";
        ctx.stroke();
        if (bonus > 0 && ok) {
          ctx.fillStyle = "#ffe08a";
          ctx.font = "bold 12px sans-serif";
          ctx.fillText(`高地 +${bonus}`, px - 28, py - 34);
        }
      }

      const pads = ["", "rgba(86, 176, 196, 0.38)", "rgba(120, 214, 230, 0.5)", "rgba(255, 214, 140, 0.55)"];
      const lips = ["", "rgba(40, 90, 110, 0.55)", "rgba(50, 120, 140, 0.6)", "rgba(150, 100, 40, 0.55)"];
      ctx.textAlign = "center";
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          const h = cellHeight(s.heights, c, r);
          if (h <= 0) continue;
          const x = c * CELL;
          const y = r * CELL;
          const lift = h * 5;
          if (h > 0) {
            ctx.fillStyle = lips[h];
            ctx.fillRect(x + 4, y + 10 - lift, CELL - 8, CELL - 12);
            ctx.fillStyle = pads[h];
            ctx.fillRect(x + 4, y + 4 - lift, CELL - 8, CELL - 16);
            ctx.strokeStyle = h === 3 ? "rgba(255,230,170,0.8)" : "rgba(190,240,255,0.45)";
            ctx.strokeRect(x + 4, y + 4 - lift, CELL - 8, CELL - 16);
          }
          ctx.fillStyle = h === 3 ? "#fff4d2" : "#e9fbff";
          ctx.font = "bold 11px sans-serif";
          ctx.fillText(String(h), x + CELL / 2, y + 16 - lift);
        }
      }
      ctx.textAlign = "left";

      // 自然地形遮擋：域外 = 深海／礁岩／斷崖／藻林；域內路障 = 廢墟牆／珊瑚障
      // 用 cell hash 決定樣式，避免整片點陣方塊出戲
      const terrainHash = (c: number, r: number) => {
        let h = (c * 73856093) ^ (r * 19349663);
        h = (h ^ (h >>> 13)) * 1274126177;
        return (h >>> 0) / 4294967296;
      };
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          const key = cellKey(c, r);
          if (!s.blocked.has(key)) continue;
          const x = c * CELL;
          const y = r * CELL;
          const onBoard = isCellOnBoard(boardRef.current, c, r);
          const rnd = terrainHash(c, r);
          const rnd2 = terrainHash(c + 17, r + 31);

          if (!onBoard) {
            // —— 未解鎖疆域：連片自然景觀 ——
            // 底：深海漸層（略帶藍綠，蓋住背景點陣）
            const depth = 0.55 + rnd * 0.25;
            ctx.fillStyle = `rgba(${8 + rnd * 12 | 0}, ${28 + rnd * 30 | 0}, ${48 + rnd * 28 | 0}, ${depth})`;
            ctx.fillRect(x, y, CELL, CELL);

            // 鄰近已解鎖區的「岸邊」用較淺水色，做出邊界過渡
            let nearOpen = false;
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              if (isCellOnBoard(boardRef.current, c + dc, r + dr) && !s.blocked.has(cellKey(c + dc, r + dr))) {
                nearOpen = true;
                break;
              }
            }
            if (nearOpen) {
              ctx.fillStyle = "rgba(40, 90, 110, 0.35)";
              ctx.fillRect(x, y, CELL, CELL);
            }

            // 依 hash 疊加一種地貌（礁岩 / 斷崖 / 珊瑚 / 藻林 / 廢柱）
            const kind = Math.floor(rnd * 5);
            if (kind === 0) {
              // 礁岩堆
              ctx.fillStyle = `rgba(${50 + rnd2 * 40 | 0}, ${70 + rnd2 * 30 | 0}, ${80 + rnd2 * 40 | 0}, 0.85)`;
              ctx.beginPath();
              ctx.ellipse(x + CELL * (0.3 + rnd * 0.4), y + CELL * (0.45 + rnd2 * 0.3), CELL * 0.28, CELL * 0.2, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.beginPath();
              ctx.ellipse(x + CELL * 0.65, y + CELL * 0.55, CELL * 0.2, CELL * 0.15, 0, 0, Math.PI * 2);
              ctx.fill();
            } else if (kind === 1) {
              // 斷崖／石壁
              ctx.fillStyle = "rgba(35, 48, 62, 0.9)";
              ctx.fillRect(x + 2, y + 4, CELL - 4, CELL - 6);
              ctx.strokeStyle = "rgba(90, 120, 140, 0.45)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(x + 6, y + 10);
              ctx.lineTo(x + CELL - 6, y + 14);
              ctx.moveTo(x + 8, y + 20);
              ctx.lineTo(x + CELL - 8, y + 22);
              ctx.stroke();
              // 崖頂高光
              ctx.fillStyle = "rgba(120, 160, 180, 0.25)";
              ctx.fillRect(x + 2, y + 4, CELL - 4, 5);
            } else if (kind === 2) {
              // 珊瑚叢（可貼圖）
              const coral = s.scene.coral;
              if (coral && coral.complete && coral.naturalWidth) {
                ctx.globalAlpha = 0.55 + rnd * 0.3;
                const sc = 0.7 + rnd2 * 0.5;
                blit(ctx, coral, x + 2, y + 2, CELL * sc, CELL * sc);
                ctx.globalAlpha = 1;
              } else {
                ctx.fillStyle = `rgba(${180 + rnd * 40 | 0}, ${80 + rnd2 * 40 | 0}, ${110 + rnd * 30 | 0}, 0.55)`;
                for (let k = 0; k < 3; k++) {
                  const cx = x + 8 + k * 8 + rnd * 4;
                  const cy = y + CELL - 6;
                  ctx.beginPath();
                  ctx.moveTo(cx, cy);
                  ctx.quadraticCurveTo(cx + 4, cy - 16 - rnd2 * 10, cx + 2, cy - 22 - k * 3);
                  ctx.strokeStyle = ctx.fillStyle;
                  ctx.lineWidth = 3;
                  ctx.stroke();
                }
              }
            } else if (kind === 3) {
              // 海藻／樹林感（向上飄的絲帶）
              ctx.strokeStyle = `rgba(${40 + rnd * 30 | 0}, ${140 + rnd2 * 50 | 0}, ${100 + rnd * 40 | 0}, 0.7)`;
              ctx.lineWidth = 2;
              for (let k = 0; k < 3; k++) {
                const bx = x + 8 + k * 9;
                ctx.beginPath();
                ctx.moveTo(bx, y + CELL - 2);
                ctx.bezierCurveTo(bx + Math.sin(t + k) * 4, y + 18, bx - 3, y + 10, bx + Math.cos(t * 0.7 + k) * 3, y + 4);
                ctx.stroke();
              }
            } else {
              // 沉沒石柱殘段
              const pillar = s.scene.pillar;
              if (pillar && pillar.complete && pillar.naturalWidth && rnd > 0.4) {
                ctx.globalAlpha = 0.45 + rnd2 * 0.25;
                blit(ctx, pillar, x + 4, y - 4, CELL - 8, CELL + 4);
                ctx.globalAlpha = 1;
              } else {
                ctx.fillStyle = "rgba(70, 85, 100, 0.75)";
                ctx.fillRect(x + CELL * 0.35, y + 4, CELL * 0.3, CELL - 6);
                ctx.fillStyle = "rgba(140, 160, 175, 0.35)";
                ctx.fillRect(x + CELL * 0.32, y + 2, CELL * 0.36, 6);
              }
            }

            // 輕微噪點，打破方格感（不要整排一樣）
            if (rnd2 > 0.7) {
              ctx.fillStyle = "rgba(160, 210, 230, 0.08)";
              ctx.beginPath();
              ctx.arc(x + rnd * CELL, y + rnd2 * CELL, 2, 0, Math.PI * 2);
              ctx.fill();
            }
          } else {
            // —— 域內可走區上的路障：可拆除的廢墟／珊瑚障 ——
            ctx.fillStyle = "rgba(22, 28, 40, 0.55)";
            ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6);

            if (rnd < 0.45) {
              // 崩塌石牆
              ctx.fillStyle = "rgba(55, 62, 78, 0.92)";
              ctx.fillRect(x + 5, y + 6, CELL - 10, CELL - 10);
              ctx.strokeStyle = "rgba(160, 190, 210, 0.35)";
              ctx.strokeRect(x + 5, y + 6, CELL - 10, CELL - 10);
              ctx.fillStyle = "rgba(255, 200, 160, 0.15)";
              ctx.fillRect(x + 5, y + 6, CELL - 10, 4);
            } else if (rnd < 0.75) {
              // 活珊瑚障
              const coral = s.scene.coral;
              if (coral && coral.complete && coral.naturalWidth) {
                ctx.globalAlpha = 0.85;
                blit(ctx, coral, x + 2, y + 2, CELL - 4, CELL - 4);
                ctx.globalAlpha = 1;
              } else {
                ctx.fillStyle = "rgba(200, 90, 120, 0.7)";
                ctx.beginPath();
                ctx.arc(x + CELL / 2, y + CELL / 2, CELL * 0.32, 0, Math.PI * 2);
                ctx.fill();
              }
            } else {
              // 短石柱
              const pillar = s.scene.pillar;
              if (pillar && pillar.complete && pillar.naturalWidth) {
                ctx.globalAlpha = 0.9;
                blit(ctx, pillar, x + 6, y + 2, CELL - 12, CELL - 4);
                ctx.globalAlpha = 1;
              } else {
                ctx.fillStyle = "rgba(90, 100, 120, 0.9)";
                ctx.fillRect(x + CELL * 0.3, y + 4, CELL * 0.4, CELL - 8);
              }
            }
          }
        }
      }
      ctx.font = "bold 12px sans-serif";
      entrancesRef.current.forEach((g, i) => {
        ctx.fillStyle = "rgba(80, 180, 220, 0.85)";
        ctx.fillRect(g.c * CELL + 2, g.r * CELL + 2, CELL - 4, CELL - 4);
        ctx.fillStyle = "#e8fbff";
        ctx.fillText(String(i + 1), g.c * CELL + CELL / 2, g.r * CELL + 20);
      });
      exitsRef.current.forEach((g, i) => {
        ctx.fillStyle = "rgba(220, 90, 130, 0.85)";
        ctx.fillRect(g.c * CELL + 2, g.r * CELL + 2, CELL - 4, CELL - 4);
        ctx.fillStyle = "#ffe4ee";
        ctx.fillText(String(i + 1), g.c * CELL + CELL / 2, g.r * CELL + 20);
      });
      ctx.textAlign = "left";

      if (selRef.current !== null && s.towers[selRef.current]) {
        const tw = s.towers[selRef.current];
        const py = tw.y - cellHeight(s.heights, tw.gx, tw.gy) * 5;
        ctx.beginPath();
        ctx.arc(tw.x, py, tw.range, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,170,210,0.08)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,170,210,0.45)";
        ctx.stroke();
      }

      for (let i = 0; i < s.towers.length; i++) {
        const src = s.towers[i];
        const tw = { ...src, y: src.y - cellHeight(s.heights, src.gx, src.gy) * 5 };
        if (tw.stake) {
          const img = s.scene.pillar;
          const bob = Math.sin(t * 2 + i) * 2;
          if (img && img.complete && img.naturalWidth) blit(ctx, img, tw.x - 16, tw.y - 28 + bob, 32, 48);
          else {
            ctx.fillStyle = "#d7c4a8";
            ctx.fillRect(tw.x - 8, tw.y - 16, 16, 32);
          }
          continue;
        }
        const def = TOWERS[tw.def];
        const frames = s.towerFrames[tw.def] || [];
        const hasAnim = frames.length > 1;
        const bob = Math.sin(t * (hasAnim ? 2.2 : 2.8) + i) * (hasAnim ? 2.5 : 5);
        const kick = tw.recoil > 0 ? tw.recoil / 0.22 : 0;
        const sh = tw.shake > 0 ? (Math.random() - 0.5) * 8 : 0;
        const ox = Math.cos(tw.aim || 0) * kick * 10 + sh;
        const oy = Math.sin(tw.aim || 0) * kick * 10;
        const breathe = hasAnim ? 1 : 1 + Math.sin(t * 2.4 + i) * 0.05;
        ctx.save();
        ctx.translate(tw.x + ox, tw.y + bob + oy);
        ctx.rotate(Math.sin(t * 1.5 + i * 0.7) * (hasAnim ? 0.03 : 0.07));
        ctx.scale((1 + kick * 0.12) * breathe, (1 - kick * 0.08) * (2 - breathe));
        ctx.beginPath();
        ctx.ellipse(0, 22, 18, 6, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, 26, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(8,20,36,0.88)";
        ctx.fill();
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        let img = s.images[tw.def];
        if (hasAnim) {
          const idx = pingIndex(frames.length, Math.floor(t * (tw.recoil > 0 ? 14 : 6) + i));
          const fr = frames[idx];
          if (fr && fr.complete && fr.naturalWidth) img = fr;
        }
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(0, 0, 22, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, -22, -22, 44, 44);
          ctx.restore();
        }
        ctx.restore();
        ctx.save();
        ctx.translate(tw.x + ox, tw.y + bob + oy);
        ctx.rotate(tw.aim || 0);
        ctx.translate(-kick * 14, 0);
        ctx.fillStyle = def.color;
        ctx.fillRect(12, -3, 18, 6);
        ctx.beginPath();
        ctx.arc(30, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (!hasAnim) {
          const motes = def.special === "ultimate" ? 6 : 4;
          for (let k = 0; k < motes; k++) {
            let sx: number;
            let sy: number;
            if (def.special === "burn" || def.special === "ultimate" || def.special === "aoe") {
              const life = (t * 0.55 + k / motes) % 1;
              sx = Math.sin(k * 2.2 + t * 1.4) * 16;
              sy = 18 - life * 48;
            } else {
              const a = t * (def.special === "rapid" ? 2.4 : 1.3) + (k * Math.PI * 2) / motes;
              sx = Math.cos(a) * 30;
              sy = Math.sin(a) * 14;
            }
            ctx.globalAlpha = 0.35 + 0.45 * Math.abs(Math.sin(t * 3 + k));
            ctx.fillStyle = def.color;
            ctx.beginPath();
            ctx.arc(tw.x + sx, tw.y + bob + sy, 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        if (tw.level > 1) {
          ctx.fillStyle = "#ffd27a";
          ctx.font = "bold 11px sans-serif";
          ctx.fillText("L" + tw.level, tw.x - 8, tw.y + 40);
        }
        if (tw.hp < tw.maxHp) {
          ctx.fillStyle = "#401820";
          ctx.fillRect(tw.x - 16, tw.y + 28, 32, 4);
          ctx.fillStyle = "#ff8aa8";
          ctx.fillRect(tw.x - 16, tw.y + 28, 32 * Math.max(0, tw.hp / tw.maxHp), 4);
        }
      }

      const ready = (img?: HTMLImageElement) => !!img && img.complete && img.naturalWidth > 0;
      for (const e of s.enemies) {
        const p = posAt(e.dist, e.route);
        const ahead = posAt(Math.min(routeLen(e.route), e.dist + 12), e.route);
        e.face = ahead.x >= p.x ? 1 : -1;
        const book = bestiaryRef.current[e.type] ?? bestiaryRef.current[0];
        const setName = (book?.sprite as string) || (e.boss ? "boss" : e.type <= 1 ? "imp" : e.type <= 3 ? "brute" : "boss");
        const frames = s.sheets[setName] || [];
        const n = Math.max(1, frames.length);
        const frame =
          e.type === 5
            ? frames[Math.floor(e.dist / 18) % n]
            : frames[Math.floor(t * 7 + e.dist / 20 + e.phase) % n];
        const size = e.type === 5 ? e.r * 5.1 : e.r * 3.3;
        const stepBob = e.type === 5 ? Math.sin((e.dist / 18) * Math.PI) * 3 : 0;
        const squash = e.hurt > 0 ? 0.68 : 1;
        const knock = e.hurt > 0 ? -e.face * 14 * (e.hurt / 0.22) : 0;
        ctx.save();
        ctx.translate(p.x + knock, p.y + (e.hurt > 0 ? 6 : 0) + stepBob);
        ctx.scale(e.face * (e.melee && e.atk < 0.2 ? 1.12 : 1) * squash, e.rootT > 0 ? 0.9 : 1 / squash);
        const drawY = e.type === 5 ? -size + 8 : -size * 0.72;
        if (ready(frame)) blit(ctx, frame, -size / 2, drawY, size, size);
        else {
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(0, 0, e.r, 0, Math.PI * 2);
          ctx.fill();
        }
        if (e.hurt > 0 && ready(frame)) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = Math.min(0.9, e.hurt * 4);
          blit(ctx, frame, -size / 2, drawY, size, size);
        }
        ctx.restore();
        if (e.slowT > 0) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, e.r + 6, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(120,200,255,0.85)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (e.burnT > 0) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, e.r + 9, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,110,40,0.75)";
          ctx.stroke();
        }
        if (e.vulnT > 0) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, e.r + 12, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,220,120,0.7)";
          ctx.stroke();
        }
        if (e.boss) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, e.r + 16, 0, Math.PI * 2);
          ctx.strokeStyle = e.rage ? "rgba(255,80,120,0.95)" : "rgba(255,210,120,0.9)";
          ctx.lineWidth = e.rage ? 4 : 3;
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.fillStyle = e.rage ? "#ff6fa8" : "#ffd27a";
          ctx.font = "bold 11px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(e.rage ? "RAGE" : "BOSS", p.x, p.y - e.r - 22);
          ctx.textAlign = "left";
        }
        if (e.aiAction && e.aiAction.startsWith("skill:")) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, e.r + 14, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(180,220,255,0.85)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        const bw = e.r * 2.4;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(p.x - bw / 2, p.y - e.r - 16, bw, 4);
        ctx.fillStyle = e.hp / e.maxHp > 0.35 ? "#7d7" : "#e66";
        ctx.fillRect(p.x - bw / 2, p.y - e.r - 16, bw * Math.max(0, e.hp / e.maxHp), 4);
      }

      const bolt = s.sheets.bolt || [];
      const bframe = bolt[Math.floor(t * 12) % 4];
      for (const sh of s.shots) {
        const ang = Math.atan2(sh.ty - sh.y, sh.tx - sh.x);
        ctx.save();
        ctx.translate(sh.x, sh.y);
        ctx.rotate(ang);
        if (ready(bframe)) blit(ctx, bframe, -16, -16, 32, 32);
        else {
          ctx.fillStyle = sh.color;
          ctx.beginPath();
          ctx.arc(0, 0, 5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      const hits = s.sheets.hit || [];
      for (const pop of s.pops) {
        const idx = Math.min(3, Math.floor((pop.age / 0.28) * 4));
        const fr = hits[idx];
        if (!ready(fr)) continue;
        const sz = 64 * pop.scale;
        blit(ctx, fr, pop.x - sz / 2, pop.y - sz / 2, sz, sz);
      }

      for (const r of s.rings) {
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.strokeStyle = r.color;
        ctx.globalAlpha = Math.max(0, r.life / 0.28);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (const p of s.parts) {
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = "center";
      ctx.font = "bold 13px sans-serif";
      for (const f of s.floats) {
        ctx.globalAlpha = Math.max(0, f.life / 0.8);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = "left";
    };

    const loop = (now: number) => {
      const raw = Math.min(0.05, (now - last) / 1000);
      last = now;
      let left = raw * speedRef.current;
      while (left > 0.0001) {
        const h = Math.min(0.033, left);
        step(h);
        left -= h;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const commitBlocks = (next: Set<string>) => {
      // 出入口不可成為碰撞格，避免路徑被關死
      for (const g of entrancesRef.current) next.delete(cellKey(g.c, g.r));
      for (const g of exitsRef.current) next.delete(cellKey(g.c, g.r));
      // 清掉非法座標的碰撞 key
      for (const key of [...next]) {
        const [c, r] = key.split(",").map(Number);
        if (!Number.isFinite(c) || !Number.isFinite(r) || c < 0 || r < 0 || c >= COLS || r >= ROWS) next.delete(key);
      }
      const paths = pathsForGates(next, entrancesRef.current, exitsRef.current);
      if (!paths) return false;
      const marks = sim.current.enemies.map((e) => ({
        x: posAt(e.dist, e.route).x,
        y: posAt(e.dist, e.route).y,
        route: e.route,
      }));
      loadRoutes(paths);
      sim.current.enemies.forEach((e, i) => {
        const route = Math.min(marks[i].route, Math.max(0, routes.length - 1));
        e.route = route;
        e.dist = Math.min(Math.max(0.01, routeLen(route) - 0.01), projectDist(marks[i].x, marks[i].y, route));
      });
      sim.current.blocked = next;
      return true;
    };
    (canvas as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit = commitBlocks;
    (canvas as HTMLCanvasElement & {
      __applyMap?: (b: string[], h: number[], entrances?: Cell[], exits?: Cell[]) => boolean;
    }).__applyMap = (blocked, heights, entrances, exits) => {
      if (entrances && entrances.length) entrancesRef.current = entrances.map((g) => ({ ...g }));
      if (exits && exits.length) exitsRef.current = exits.map((g) => ({ ...g }));
      const next = new Set(blocked);
      if (!commitBlocks(next)) return false;
      const h = heightsRef.current;
      for (let i = 0; i < COLS * ROWS; i++) h[i] = Math.max(0, Math.min(3, Math.round(heights[i] ?? 0)));
      sim.current.heights = h;
      mapRef.current = next;
      // 鏡頭移到第一個入口附近
      const gate = entrancesRef.current[0];
      if (gate) {
        const z = sim.current.cam.zoom || 1;
        sim.current.cam.x = gate.c * CELL - VIEWW / (2 * z);
        sim.current.cam.y = gate.r * CELL - VIEWH / (2 * z);
        clampCam(sim.current.cam);
      }
      return true;
    };
    try {
      const raw = localStorage.getItem(LAST_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as MapLayout;
        if (saved && Array.isArray(saved.heights)) {
          (canvas as HTMLCanvasElement & { __applyMap?: (b: string[], h: number[]) => boolean }).__applyMap?.(
            saved.blocked ?? [],
            saved.heights,
          );
          setActiveMap(saved.name || "已保存地圖");
        }
      }
    } catch {
      /* ignore broken save */
    }

    const screenOf = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((ev.clientX - rect.left) / rect.width) * VIEWW,
        y: ((ev.clientY - rect.top) / rect.height) * VIEWH,
      };
    };
    const local = (ev: PointerEvent) => {
      const s = screenOf(ev);
      const cam = sim.current.cam;
      const z = cam.zoom || 1;
      return { x: cam.x + s.x / z, y: cam.y + s.y / z };
    };

    const onMove = (ev: PointerEvent) => {
      const drag = sim.current.drag;
      if (drag.on) {
        const sc = screenOf(ev);
        const z = sim.current.cam.zoom || 1;
        sim.current.cam.x = drag.cx - (sc.x - drag.sx) / z;
        sim.current.cam.y = drag.cy - (sc.y - drag.sy) / z;
        clampCam(sim.current.cam);
        drag.moved = Math.hypot(sc.x - drag.sx, sc.y - drag.sy) > 4;
        return;
      }
      sim.current.pointer = { ...local(ev), down: sim.current.pointer.down };
    };
    const onUp = () => {
      sim.current.drag.on = false;
      sim.current.pointer.down = false;
    };
    const onDown = (ev: PointerEvent) => {
      const sc = screenOf(ev);
      const p = local(ev);
      sim.current.pointer = { ...p, down: true };
      // 中鍵／右鍵／Alt+左鍵：拖曳鏡頭
      const pan = ev.button === 1 || ev.button === 2 || ev.altKey;
      if (pan) {
        ev.preventDefault();
        sim.current.drag = {
          on: true,
          sx: sc.x,
          sy: sc.y,
          cx: sim.current.cam.x,
          cy: sim.current.cam.y,
          moved: false,
        };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      if (phaseRef.current !== "play") {
        if (!workshopRef.current) return;
        // 工房工具：入口／出口
        if (toolRef.current === "entry" || toolRef.current === "exit") {
          const gx = Math.floor(p.x / GRID);
          const gy = Math.floor(p.y / GRID);
          if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return;
          const list = toolRef.current === "entry" ? entrancesRef.current : exitsRef.current;
          const idx = list.findIndex((g) => g.c === gx && g.r === gy);
          if (idx >= 0) list.splice(idx, 1);
          else list.push({ c: gx, r: gy });
          if (!entrancesRef.current.length) entrancesRef.current = defaultEntrances();
          if (!exitsRef.current.length) exitsRef.current = defaultExits();
          if (!commitBlocks(new Set(mapRef.current))) {
            setHover("出入口配置會封死路線");
            return;
          }
          setHover(toolRef.current === "entry" ? `入口 ${entrancesRef.current.length} 個` : `出口 ${exitsRef.current.length} 個`);
          return;
        }
        const gx = Math.floor(p.x / GRID);
        const gy = Math.floor(p.y / GRID);
        if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return;
        if (toolRef.current === "height") {
          const i = gy * COLS + gx;
          const h = brushRef.current;
          heightsRef.current[i] = h;
          sim.current.heights[i] = h;
          setHover(h === 0 ? "平地，射程不加" : `高度 ${h} · 放塔射程 +${h * 30}`);
          return;
        }
        if (gateHere(gx, gy)) {
          setHover("出入口不能封");
          return;
        }
        const next = new Set(mapRef.current);
        const k = cellKey(gx, gy);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        if (!commitBlocks(next)) {
          setHover("這會封死路線");
          return;
        }
        mapRef.current = next;
        setHover("工房：再點一下可拆除路障");
        return;
      }
      const s = sim.current;
      for (let i = 0; i < s.towers.length; i++) {
        const tw = s.towers[i];
        const py = tw.y - cellHeight(s.heights, tw.gx, tw.gy) * 5;
        if (Math.hypot(tw.x - p.x, py - p.y) < 28 / (s.cam.zoom || 1)) {
          selRef.current = i;
          setSel(i);
          pickRef.current = null;
          setPick(null);
          return;
        }
      }
      const id = pickRef.current;
      const gx = Math.floor(p.x / GRID);
      const gy = Math.floor(p.y / GRID);
      if (stakeRef.current) {
        if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return;
        if (gateHere(gx, gy)) {
          setHover("不能堵住出入口");
          return;
        }
        if (s.towers.some((t) => t.gx === gx && t.gy === gy) || s.blocked.has(cellKey(gx, gy))) {
          setHover("這格已經有東西");
          return;
        }
        if (goldRef.current < STAKE_COST) {
          setHover("金幣不夠");
          return;
        }
        const next = new Set(s.blocked);
        next.add(cellKey(gx, gy));
        if (!commitBlocks(next)) {
          setHover("不能完全封死最短路");
          return;
        }
        goldRef.current -= STAKE_COST;
        setGold(goldRef.current);
        s.towers.push({
          def: 0,
          x: gx * GRID + GRID / 2,
          y: gy * GRID + GRID / 2,
          damage: 0,
          cooldown: 1,
          range: 0,
          cd: 0,
          level: 1,
          aim: 0,
          recoil: 0,
          hp: 160,
          maxHp: 160,
          shake: 0,
          stake: true,
          gx,
          gy,
          rateMul: 1,
          terrorT: 0,
          spent: STAKE_COST,
        });
        setHover("路障已放，妖潮改走最短路");
        return;
      }
      if (id === null) {
        // 左鍵空白處也可拖鏡頭
        sim.current.drag = {
          on: true,
          sx: sc.x,
          sy: sc.y,
          cx: sim.current.cam.x,
          cy: sim.current.cam.y,
          moved: false,
        };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      const def = TOWERS[id];
      if (!canPlace(gx, gy)) {
        setHover("這格不能放塔");
        return;
      }
      if (goldRef.current < def.cost) {
        setHover("金幣不夠");
        return;
      }
      goldRef.current -= def.cost;
      setGold(goldRef.current);
      const bonus = rangeBonus(cellHeight(s.heights, gx, gy));
      s.towers.push({
        def: id,
        x: gx * GRID + GRID / 2,
        y: gy * GRID + GRID / 2,
        damage: def.damage,
        cooldown: def.cooldown,
        range: def.range + bonus,
        cd: 0,
        level: 1,
        aim: 0,
        recoil: 0,
        hp: 90,
        maxHp: 90,
        shake: 0,
        stake: false,
        gx,
        gy,
        rateMul: 1,
        terrorT: 0,
        spent: def.cost,
      });
      setHover(bonus > 0 ? `已放置 ${def.name} · 高地射程 +${bonus}` : `已放置 ${def.name}`);
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = ((ev.clientX - rect.left) / rect.width) * VIEWW;
      const sy = ((ev.clientY - rect.top) / rect.height) * VIEWH;
      const cam = sim.current.cam;
      const oldZ = cam.zoom || 1;
      const factor = ev.deltaY > 0 ? 0.9 : 1.1;
      const nextZ = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZ * factor));
      // 以游標為錨點縮放
      const worldX = cam.x + sx / oldZ;
      const worldY = cam.y + sy / oldZ;
      cam.zoom = nextZ;
      cam.x = worldX - sx / nextZ;
      cam.y = worldY - sy / nextZ;
      clampCam(cam);
      setHover(`縮放 ${Math.round(nextZ * 100)}% · 滾輪縮放 · 拖曳平移`);
    };
    const onContext = (ev: Event) => ev.preventDefault();

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
    };
  }, []);

  function canPlace(gx: number, gy: number) {
    if (!Number.isInteger(gx) || !Number.isInteger(gy)) return false;
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
    if (!isCellOnBoard(boardRef.current, gx, gy)) return false;
    if (gateHere(gx, gy)) return false;
    const key = cellKey(gx, gy);
    if (sim.current.blocked.has(key)) return false;
    if (sim.current.towers.some((t) => t.gx === gx && t.gy === gy)) return false;
    return true;
  }

  function start() {
    sim.current.towers = [];
    sim.current.enemies = [];
    sim.current.shots = [];
    sim.current.parts = [];
    sim.current.floats = [];
    sim.current.rings = [];
    sim.current.pops = [];
    sim.current.queue = [];
    sim.current.wave = 0;
    sim.current.between = 0;
    goldRef.current = START_GOLD;
    livesRef.current = 20;
    setGold(START_GOLD);
    setLives(20);
    setWave(0);
    setSel(null);
    selRef.current = null;
    phaseRef.current = "play";
    setPhase("play");
    // apply seed board (HQ + path + spawn)
    {
      const board = seedBoard();
      boardRef.current = board;
      const blocked = buildBlocked(board);
      const heights = buildHeights(board);
      heightsRef.current = heights;
      const gates = collectGates(board);
      entrancesRef.current = gates.entrances;
      exitsRef.current = gates.exits;
      mapRef.current = blocked;
      const paths = pathsForGates(blocked, gates.entrances, gates.exits);
      if (paths) loadRoutes(paths);
      sim.current.blocked = blocked;
      sim.current.heights = heights;
      setTileOffer(null);
      tileOfferRef.current = null;
    }
    setWorkshop(false);
    setPaused(false);
    pausedRef.current = false;
    const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
    commit?.(new Set(mapRef.current));
    const c = canvasRef.current as HTMLCanvasElement & { __begin?: () => void };
    c.__begin?.();
  }

  function openWorkshop() {
    setWaves((w) => w ?? defaultWaves());
    setEditWave(0);
    setWorkshop(true);
  }

  function setWaveCount(type: number, count: number) {
    setWaves((prev) => {
      const base = cloneWaves(prev ?? defaultWaves());
      while (base.length <= editWave) base.push({ spawns: [], gates: [] });
      const wave = base[editWave];
      const i = wave.spawns.findIndex((g) => g.type === type);
      const n = Math.max(0, Math.min(40, Math.round(count) || 0));
      if (n === 0) {
        if (i >= 0) wave.spawns.splice(i, 1);
      } else if (i >= 0) wave.spawns[i].count = n;
      else wave.spawns.push({ type, count: n });
      return base;
    });
  }

  function addWave() {
    setWaves((prev) => {
      const base = cloneWaves(prev ?? defaultWaves());
      base.push({ spawns: [{ type: 0, count: 6 }], gates: [] });
      return base;
    });
    setEditWave((waves ?? defaultWaves()).length);
  }

  function saveGame() {
    const data = {
      gold: goldRef.current,
      lives: livesRef.current,
      wave: sim.current.wave,
      endless,
      phase: phaseRef.current === "play" ? "play" : "ready",
      map: [...mapRef.current],
      heights: heightsRef.current.slice(),
      towers: sim.current.towers.map((t) => ({
        def: t.def,
        gx: t.gx,
        gy: t.gy,
        damage: t.damage,
        cooldown: t.cooldown,
        range: t.range,
        level: t.level,
        hp: t.hp,
        maxHp: t.maxHp,
        stake: t.stake,
      })),
      waves,
    };
    localStorage.setItem(RUN_KEY, JSON.stringify(data));
    setHover("進度已存檔");
  }

  function loadGame() {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) {
      setHover("沒有進度存檔");
      return;
    }
    let data: {
      gold?: number;
      lives?: number;
      wave?: number;
      endless?: boolean;
      phase?: Phase;
      map?: string[];
      heights?: number[];
      towers?: {
        def: number;
        gx: number;
        gy: number;
        damage: number;
        cooldown: number;
        range: number;
        level: number;
        hp: number;
        maxHp: number;
        stake: boolean;
      }[];
      waves?: WaveGroup[][] | null;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      setHover("存檔讀不出來");
      return;
    }
    const canvas = canvasRef.current as HTMLCanvasElement & {
      __applyMap?: (b: string[], h: number[]) => boolean;
      __commit?: (n: Set<string>) => boolean;
      __begin?: () => void;
    };
    const heights = data.heights?.length ? data.heights : emptyHeights();
    if (!canvas?.__applyMap?.(data.map ?? [], heights)) {
      setHover("存檔裡的路封死了，沒有讀取");
      return;
    }
    const s = sim.current;
    s.towers = [];
    s.enemies = [];
    s.shots = [];
    s.queue = [];
    s.parts = [];
    s.floats = [];
    s.rings = [];
    s.pops = [];
    for (const t of data.towers ?? []) {
      if (t.stake) {
        const next = new Set(s.blocked);
        next.add(cellKey(t.gx, t.gy));
        if (!canvas.__commit?.(next)) continue;
      }
      s.towers.push({
        def: t.def,
        x: t.gx * CELL + CELL / 2,
        y: t.gy * CELL + CELL / 2,
        damage: t.damage,
        cooldown: t.cooldown,
        range: t.range,
        cd: 0,
        level: t.level || 1,
        aim: 0,
        recoil: 0,
        hp: t.hp,
        maxHp: t.maxHp,
        shake: 0,
        stake: !!t.stake,
        gx: t.gx,
        gy: t.gy,
        rateMul: 1,
        terrorT: 0,
        spent: t.stake ? STAKE_COST : (TOWERS[t.def]?.cost ?? 50) * Math.max(1, t.level || 1),
      });
    }
    const nextWaves = normalizeWaves(data.waves);
    wavesRef.current = nextWaves;
    setWaves(nextWaves);
    const nextPhase: Phase = data.phase === "play" ? "play" : "ready";
    const savedWave = data.wave || 0;
    s.wave = nextPhase === "play" && savedWave > 0 ? savedWave - 1 : savedWave;
    s.between = 0;
    goldRef.current = data.gold ?? START_GOLD;
    livesRef.current = data.lives ?? 20;
    setGold(goldRef.current);
    setLives(livesRef.current);
    setEndless(!!data.endless);
    endlessRef.current = !!data.endless;
    pausedRef.current = false;
    setPaused(false);
    setWorkshop(false);
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
    setWave(s.wave);
    if (nextPhase === "play" && savedWave > 0) {
      canvas.__begin?.();
      setHover("已讀檔，這一波重新開始");
    } else {
      setHover("已讀取地圖、出怪與進度");
    }
  }

  function backToMenu() {
    pausedRef.current = false;
    setPaused(false);
    phaseRef.current = "ready";
    setPhase("ready");
    setWorkshop(false);
    setStaking(false);
    setHover("");
  }

  function callWave() {
    const c = canvasRef.current as HTMLCanvasElement & { __begin?: () => void };
    if (sim.current.enemies.length === 0 && sim.current.queue.length === 0 && sim.current.wave > 0 && (endless || sim.current.wave < (waves?.length || MAX_WAVE))) {
      goldRef.current += 25;
      setGold(goldRef.current);
      setHover("提前出波 +25 金");
    }
    c.__begin?.();
  }

  function upgrade(kind: "dmg" | "rate") {
    if (sel === null) return;
    const tw = sim.current.towers[sel];
    if (!tw || tw.stake) return;
    const cost = upgradeCost(kind, tw.level);
    if (goldRef.current < cost) {
      setHover(`金幣不夠（需要 ${cost}）`);
      return;
    }
    goldRef.current -= cost;
    setGold(goldRef.current);
    tw.spent = (tw.spent || 0) + cost;
    if (kind === "dmg") tw.damage *= 1.22;
    else tw.cooldown = Math.max(0.18, tw.cooldown * 0.82);
    tw.level += 1;
    setHover(kind === "dmg" ? `傷害提升（−${cost}）` : `射速提升（−${cost}）`);
    setSel(sel);
  }

  function loadLayout(layout: MapLayout) {
    const canvas = canvasRef.current as HTMLCanvasElement & {
      __applyMap?: (b: string[], h: number[], entrances?: Cell[], exits?: Cell[]) => boolean;
    };
    const ok = canvas?.__applyMap?.(
      layout.blocked ?? [],
      layout.heights ?? emptyHeights(),
      layout.entrances,
      layout.exits,
    );
    if (!ok) {
      setHover("這張地圖會封死路線");
      return;
    }
    setActiveMap(layout.name);
    if (!layout.id.startsWith("preset-")) setMapName(layout.name);
    rememberLayout({
      ...layout,
      heights: heightsRef.current.slice(),
      blocked: [...mapRef.current],
      entrances: entrancesRef.current.map((g) => ({ ...g })),
      exits: exitsRef.current.map((g) => ({ ...g })),
    });
    setHover(`已載入 ${layout.name} · 入口 ${entrancesRef.current.length} · 出口 ${exitsRef.current.length}`);
  }

  function saveMap() {
    const name = mapName.trim().slice(0, 16) || "未命名地圖";
    const entry: MapLayout = {
      id: `user-${Date.now()}`,
      name,
      blocked: [...mapRef.current],
      heights: heightsRef.current.map((n) => Math.max(0, Math.min(3, Math.round(n)))),
      entrances: entrancesRef.current.map((g) => ({ ...g })),
      exits: exitsRef.current.map((g) => ({ ...g })),
    };
    const next = [entry, ...savedMaps.filter((m) => m.name !== name)].slice(0, 8);
    writeSavedMaps(next);
    setSavedMaps(next);
    setActiveMap(name);
    rememberLayout(entry);
    setHover(`已保存「${name}」，下次打開還在`);
  }

  function sell() {
    if (sel === null) return;
    const tw = sim.current.towers[sel];
    if (!tw) return;
    if (tw.stake) {
      const next = new Set(sim.current.blocked);
      next.delete(cellKey(tw.gx, tw.gy));
      const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
      commit?.(next);
      const refund = sellRefund(tw.spent || STAKE_COST);
      goldRef.current += refund;
      setGold(goldRef.current);
      sim.current.towers.splice(sel, 1);
      selRef.current = null;
      setSel(null);
      setHover(`路障已拆除 +${refund}`);
      return;
    }
    const refund = sellRefund(tw.spent || TOWERS[tw.def].cost);
    goldRef.current += refund;
    setGold(goldRef.current);
    sim.current.towers.splice(sel, 1);
    selRef.current = null;
    setSel(null);
    setHover(`賣出 +${refund}`);
  }

  const selected = sel !== null ? sim.current.towers[sel] : null;
  const selectedDef: TowerDef | null = selected ? TOWERS[selected.def] : null;

  return (
    <div className="td-shell">
      <header className="mx-auto flex max-w-[1320px] items-end justify-between px-4 pt-4">
        <div>
          <p className="text-xs tracking-[0.28em] text-[#8ec8ee]">UNDERWATER WARD</p>
          <h1 className="font-['Cormorant_Garamond'] text-4xl leading-none text-[#ffe7f1]">狐仙塔防</h1>
        </div>
        <p className="hidden text-sm text-[#9ec4de] sm:block">滾輪縮放 · 拖曳／右鍵平移 · 200×200 大地圖</p>
      </header>
      <div className="td-layout">
        <div className="stage" ref={wrapRef}>
          <canvas ref={canvasRef} width={VIEWW} height={VIEWH} />
          <div className="hud-float">
            <div className="chip">生命 {lives}</div>
            <div className="chip">金幣 {gold}</div>
            <div className="chip">
              波次 {wave}
              {endless ? " · 無盡" : `/${waves?.length || MAX_WAVE}`}
              {speed === 10 ? " · 10倍" : ""}
            </div>
          </div>
          {phase === "play" && tileOffer && tileOffer.length > 0 && (
            <div className="overlay">
              <h2>疆域擴張 · 地塊</h2>
              <p className="mb-2 max-w-md text-sm text-[#c5dff2]">
                第 {wave} 波結束。可選模板稍後完整放置；目前可略過以繼續下一波。
              </p>
              <div className="mb-2 flex flex-wrap justify-center gap-2">
                {tileOffer.map((id) => (
                  <span key={id} className="btn ghost">
                    {id}
                  </span>
                ))}
              </div>
              <button
                className="btn"
                onClick={() => {
                  setTileOffer(null);
                  tileOfferRef.current = null;
                  setHover("已略過拼接，下一波即將開始");
                }}
              >
                略過，繼續戰鬥
              </button>
            </div>
          )}
          {phase === "play" && paused && !(tileOffer && tileOffer.length) && (
            <div className="overlay">
              <h2>已暫停</h2>
              <p className="mb-4 text-sm text-[#c5dff2]">時間停住了。可以繼續守城，或回到主畫面。</p>
              <button
                className="btn"
                onClick={() => {
                  pausedRef.current = false;
                  setPaused(false);
                }}
              >
                繼續
              </button>
              <button className="btn ghost mt-3" onClick={saveGame}>
                存檔
              </button>
              <button className="btn ghost mt-3" onClick={backToMenu}>
                返回主畫面
              </button>
            </div>
          )}
          {phase !== "play" && !workshop && (
            <div className="overlay">
              <h2>{phase === "win" ? "潮退，聖地仍在" : phase === "lose" ? "結界破碎" : "狐仙結界"}</h2>
              <p className="mb-4 max-w-md text-sm text-[#c5dff2]">
                {phase === "ready"
                  ? "點地圖工房可先封路，或把地形抬到 1–3。除了平地，每高一階，塔的射程 +30，做好的地圖可以保存。戰鬥中放路障會依最短路改道。每 5 波出現會拆塔的潮刃。"
                  : phase === "win"
                    ? "十二波妖潮已被擋下。"
                    : "生命歸零。重新布置結界再試一次。"}
              </p>
              <button className="btn" onClick={start}>
                {phase === "ready" ? (endless ? "開始無盡" : "開始守城") : "重新開始"}
              </button>
              {phase === "ready" && (
                <div className="mt-3 flex gap-2">
                  <button className="btn ghost" onClick={() => setEndless((v) => !v)}>
                    {endless ? "無盡：開" : "無盡：關"}
                  </button>
                  <button className="btn ghost" onClick={openWorkshop}>
                    地圖工房
                  </button>
                </div>
              )}
            </div>
          )}
          {workshop && phase !== "play" && (
            <div className="map-editor">
              <p className="w-full text-xs leading-5 text-[#d5eeff]">
                地圖「{activeMap}」。封路不能封死。地形 0 是平地；1、2、3 每高一階，放上去的塔射程 +30。
              </p>
              <button className={"btn ghost" + (tool === "block" ? " on" : "")} onClick={() => setTool("block")}>
                封路
              </button>
              <button className={"btn ghost" + (tool === "entry" ? " on" : "")} onClick={() => setTool("entry")}>
                入口
              </button>
              <button className={"btn ghost" + (tool === "exit" ? " on" : "")} onClick={() => setTool("exit")}>
                出口
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  const cam = sim.current.cam;
                  cam.zoom = 1;
                  const g = entrancesRef.current[0];
                  if (g) {
                    cam.x = g.c * CELL - VIEWW / 2;
                    cam.y = g.r * CELL - VIEWH / 2;
                  } else {
                    cam.x = 0;
                    cam.y = 0;
                  }
                  clampCam(cam);
                  setHover("已重設視角 100%");
                }}
              >
                重設視角
              </button>
              {[0, 1, 2, 3].map((h) => (
                <button
                  key={h}
                  className={"btn ghost" + (tool === "height" && brush === h ? " on" : "")}
                  onClick={() => {
                    setTool("height");
                    setBrush(h);
                  }}
                >
                  {h === 0 ? "平地 0" : `高 ${h} +${h * 30}`}
                </button>
              ))}
              {presetMaps().map((m) => (
                <button key={m.id} className="btn ghost" onClick={() => loadLayout(m)}>
                  {m.name}
                </button>
              ))}
              {savedMaps.map((m) => (
                <button key={m.id} className="btn ghost" onClick={() => loadLayout(m)}>
                  {m.name}
                </button>
              ))}
              <input
                value={mapName}
                maxLength={16}
                aria-label="地圖名稱"
                onChange={(e) => setMapName(e.target.value)}
              />
              <button className="btn" onClick={saveMap}>
                保存地圖
              </button>
              <button className="btn" onClick={() => setWorkshop(false)}>
                完成工房
              </button>
            </div>
          )}
        </div>
        <aside className="panel">
          <div className="mb-2 flex gap-2">
            <button
              className="btn ghost flex-1"
              onClick={() => {
                pausedRef.current = true;
                setPaused(true);
              }}
              disabled={phase !== "play" || paused}
            >
              暫停
            </button>
            <button className="btn ghost flex-1" onClick={callWave} disabled={phase !== "play" || paused}>
              下一波
            </button>
            <button
              className="btn ghost flex-1"
              onClick={() => setSpeed((v) => (v === 10 ? 1 : 10))}
              disabled={phase !== "play"}
            >
              {speed === 10 ? "速度 10x" : "速度 1x"}
            </button>
            <button
              className={"btn ghost flex-1" + (staking ? " on" : "")}
              onClick={() => {
                setStaking((v) => !v);
                setPick(null);
                pickRef.current = null;
              }}
              disabled={phase !== "play"}
            >
              路障 {STAKE_COST}
            </button>
          </div>
          <div className="mb-2 flex gap-2">
            <button className="btn ghost flex-1" onClick={saveGame}>
              存檔
            </button>
            <button className="btn ghost flex-1" onClick={loadGame}>
              讀檔
            </button>
          </div>
          <p className="mb-2 min-h-5 text-xs text-[#ffd7a8]">{hover}</p>
          {workshop && waves && (
            <div className="mb-3 max-h-64 overflow-auto rounded-xl border border-[#9ad7ff55] bg-[#102033cc] p-2 text-xs leading-6">
              <div className="mb-1 flex items-center justify-between gap-1">
                <button className="btn ghost" onClick={() => setEditWave((n) => Math.max(0, n - 1))}>
                  上一波
                </button>
                <b>
                  第 {Math.min(editWave, waves.length - 1) + 1} / {waves.length} 波
                </b>
                <button className="btn ghost" onClick={() => setEditWave((n) => Math.min(waves.length - 1, n + 1))}>
                  下一波
                </button>
              </div>
              {ENEMY_TYPES.map((enemy, type) => (
                <label key={enemy.name} className="flex items-center justify-between gap-2">
                  <span style={{ color: enemy.color }}>{enemy.name}</span>
                  <input
                    className="w-16 rounded bg-[#08131f] px-1 text-right text-[#e7f6ff]"
                    type="number"
                    min={0}
                    max={40}
                    value={waves[Math.min(editWave, waves.length - 1)]?.spawns?.find((g) => g.type === type)?.count ?? 0}
                    onChange={(ev) => setWaveCount(type, Number(ev.target.value))}
                  />
                </label>
              ))}
              <div className="mt-2 flex gap-2">
                <button className="btn ghost flex-1" onClick={addWave}>
                  加一波
                </button>
                <button
                  className="btn ghost flex-1"
                  onClick={() => {
                    setWaves(null);
                    wavesRef.current = null;
                    setHover("已改回自動出怪");
                  }}
                >
                  自動出怪
                </button>
              </div>
            </div>
          )}
          {selected && selected.stake && (
            <div className="mb-3 rounded-xl border border-[#ffd2a855] bg-[#2a2016aa] p-2 text-xs leading-5">
              <b className="text-[#ffd2a8]">改道路障</b>
              <div>擋住一格。妖潮會重算邊界內的最短路，不能封死。</div>
              <button className="btn ghost mt-2 w-full" onClick={sell}>
                拆除
              </button>
            </div>
          )}
          {selected && selectedDef && !selected.stake && (
            <div className="mb-3 rounded-xl border border-[#ff9ec455] bg-[#2a1630aa] p-2 text-xs leading-5">
              <b style={{ color: selectedDef.color }}>{selectedDef.name}</b> Lv.{selected.level}
              <div>特性：{selectedDef.trait}</div>
              <div>
                傷害 {Math.round(selected.damage)} · 射速 {(1 / selected.cooldown).toFixed(2)}/秒 · 射程 {Math.round(selected.range)}
                {cellHeight(sim.current.heights, selected.gx, selected.gy) > 0
                  ? `（高地 +${cellHeight(sim.current.heights, selected.gx, selected.gy) * 30}）`
                  : ""}
              </div>
              <div className="mt-2 flex gap-2">
                <button className="btn ghost flex-1" onClick={() => upgrade("dmg")}>
                  傷害 {upgradeCost("dmg", selected.level)}
                </button>
                <button className="btn ghost flex-1" onClick={() => upgrade("rate")}>
                  射速 {upgradeCost("rate", selected.level)}
                </button>
              </div>
              <button className="btn ghost mt-2 w-full" onClick={sell}>
                賣出
              </button>
            </div>
          )}
          <p className="mb-2 text-xs text-[#8eb6d4]">守護者（依圖片順序，越後越強）</p>
          {TOWERS.map((t) => (
            <button
              key={t.id}
              className={"tower-card" + (pick === t.id ? " on" : "")}
              onClick={() => {
                setPick(t.id);
                pickRef.current = t.id;
                setSel(null);
                selRef.current = null;
                setHover(`${t.name}：${t.trait}`);
              }}
            >
              {TOWER_ANIMS[t.id]?.length ? (
                <AlivePortrait frames={TOWER_ANIMS[t.id]} />
              ) : (
                <img className="tower-idle" src={t.img} alt="" />
              )}
              <span>
                <b className="block text-sm" style={{ color: t.color }}>
                  {t.name}
                </b>
                <span className="text-[#ffd27a]">💰 {t.cost}</span>
                <span className="mt-0.5 block text-[11px] text-[#b7ddf5]">{t.trait}</span>
              </span>
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
