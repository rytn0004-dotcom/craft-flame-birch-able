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
  collectEffects,
  isSkillLevel,
  rollSkillChoices,
  skillLabelShort,
  SKILL_BY_ID,
  SKILL_CHOICE_COUNT,
  sumDmgMul,
  type SkillEffect,
  type TowerSkillDef,
} from "./towerSkills";
import {
  allDifficulties,
  getDifficulty,
  loadActiveDifficultyId,
  saveActiveDifficultyId,
  upsertCustomDifficulty,
  type DifficultyProfile,
} from "./difficulty";
import {
  buildBlocked,
  buildHeights,
  canPlaceTile,
  collectGates,
  EXPAND_EVERY,
  frontierSlots,
  isCellOnBoard,
  isExpandBoard,
  OFFER_COUNT,
  DEFAULT_TILE_BIAS,
  pickOfferTemplates,
  placeTile,
  rerollOfferSlot,
  rotatedTemplate,
  bootstrapFrontiers,
  seedBoard,
  setTileRngSeed,
  shouldOfferTiles,
  TEMPLATE_BY_ID,
  TILE,
  validPlacements,
  type Rot,
  type TileBoard,
  type TileOfferBias,
} from "./tiles";

/** 本局地塊隨機偏置（可之後接到難度／設定 UI） */
const runTileBias: TileOfferBias = { ...DEFAULT_TILE_BIAS };

/** 明潮砂：改寫疆域的潮息殘砂。基礎產量 0，僅事件獲得，用於單獨重骰地塊選項 */
const MING_SAND_REROLL_COST = 1;

const VIEWW = VIEW_W;
const VIEWH = VIEW_H;
const GRID = CELL;
const MAX_WAVE = 20;
const STAKE_COST = 35;
const START_GOLD = 220; // fallback；實際以難度 startGold 為準

/** 聖地：本陣防禦建築 + 週期護衛 + 一場一條升級路線 */
const HQ_BASE_DMG = 10;
const HQ_BASE_CD = 1.0;
const HQ_BASE_RANGE = 150;
/** 週期投放基礎間隔（秒）；路線會縮短 */
const HQ_ESCORT_BASE_CD = 14;
const HQ_ESCORT_COST = 28;
/** 接觸結算間隔 */
const HQ_CONTACT_TICK = 0.25;
const HQ_ATK_W = 0.12;
const HQ_REFLECT_W = 0.04;

type HqPathId = "blade" | "bow" | "tide";
type EscortKind = "melee" | "ranged" | "healer";

type HqPick = {
  id: string;
  name: string;
  desc: string;
  cost: number;
  /** 套用到 hqProg */
  apply: (p: HqProgress) => void;
};

type HqProgress = {
  path: HqPathId | null;
  /** 已完成階數 0..3 */
  tier: number;
  squad: number;
  deployCd: number;
  atkW: number;
  meleeHp: number;
  ranged: boolean;
  rangedDmg: number;
  healer: boolean;
  healAmt: number;
  mixRanged: number;
  mixHealer: number;
};

type Escort = {
  id: number;
  kind: EscortKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  route: number;
  /** 沿路徑的距離（迎擊：從靠近出口處往入口方向減小 dist） */
  dist: number;
  speed: number;
  contactT: number;
  shootCd: number;
  healCd: number;
};

const HQ_PATH_META: Record<HqPathId, { name: string; tag: string; color: string }> = {
  blade: { name: "刃衛之路", tag: "近戰海 · 換血擋線", color: "#ffb4a8" },
  bow: { name: "羽矢之路", tag: "邊走邊射 · 清雜", color: "#a8e0ff" },
  tide: { name: "潮愈之路", tag: "治療延壽 · 穩線", color: "#b8f0c8" },
};

function defaultHqProgress(): HqProgress {
  return {
    path: null,
    tier: 0,
    squad: 2,
    deployCd: HQ_ESCORT_BASE_CD,
    atkW: HQ_ATK_W,
    meleeHp: 48,
    ranged: false,
    rangedDmg: 7,
    healer: false,
    healAmt: 8,
    mixRanged: 0,
    mixHealer: 0,
  };
}

/** 鎖定路線：三選一 */
const HQ_PATH_LOCK: { path: HqPathId; cost: number; name: string; desc: string }[] = [
  { path: "blade", cost: 45, name: "刃衛之路", desc: "近戰為主，提高編制與換傷，適合硬擋高壓線" },
  { path: "bow", cost: 45, name: "羽矢之路", desc: "解鎖遠程護衛，邊推進邊輸出，適合多雜兵" },
  { path: "tide", cost: 45, name: "潮愈之路", desc: "解鎖回復兵，延長護衛存活，適合長波與 Boss 拖時間" },
];

/** 各路線三階；第 2 階為二選一，其餘單選推進 */
function hqTierChoices(path: HqPathId, tier: number): HqPick[] {
  // tier 為「即將購買的階」1..3
  if (path === "blade") {
    if (tier === 1)
      return [{ id: "b1", name: "編制擴充", desc: "投放 +1，進戰生命 +10", cost: 55, apply: (p) => { p.squad += 1; p.meleeHp += 10; } }];
    if (tier === 2)
      return [
        { id: "b2a", name: "鋒刃加重", desc: "換傷權重 +35%，更會換血", cost: 70, apply: (p) => { p.atkW *= 1.35; } },
        { id: "b2b", name: "動員加速", desc: "週期間隔 −3s，編制再 +1", cost: 70, apply: (p) => { p.deployCd = Math.max(7, p.deployCd - 3); p.squad += 1; } },
      ];
    return [{ id: "b3", name: "最終：鐵壁刃潮", desc: "編制 +2，換傷 +20%，間隔 −2s", cost: 95, apply: (p) => { p.squad += 2; p.atkW *= 1.2; p.deployCd = Math.max(6, p.deployCd - 2); } }];
  }
  if (path === "bow") {
    if (tier === 1)
      return [{ id: "o1", name: "羽矢編入", desc: "解鎖遠程；每次至少 1 名羽矢", cost: 55, apply: (p) => { p.ranged = true; p.mixRanged = Math.max(1, p.mixRanged); } }];
    if (tier === 2)
      return [
        { id: "o2a", name: "貫矢", desc: "遠程傷害 +50%", cost: 70, apply: (p) => { p.rangedDmg *= 1.5; } },
        { id: "o2b", name: "箭雨編制", desc: "遠程名額 +1，總編制 +1", cost: 70, apply: (p) => { p.mixRanged += 1; p.squad += 1; } },
      ];
    return [{ id: "o3", name: "最終：天羽連射", desc: "遠程傷 +40%，間隔 −3s，編制 +1", cost: 95, apply: (p) => { p.rangedDmg *= 1.4; p.deployCd = Math.max(6, p.deployCd - 3); p.squad += 1; } }];
  }
  // tide
  if (tier === 1)
    return [{ id: "t1", name: "潮愈巫", desc: "解鎖回復兵；每次至少 1 名", cost: 55, apply: (p) => { p.healer = true; p.mixHealer = Math.max(1, p.mixHealer); } }];
  if (tier === 2)
    return [
      { id: "t2a", name: "春潮", desc: "治療量 +60%", cost: 70, apply: (p) => { p.healAmt *= 1.6; } },
      { id: "t2b", name: "護衛堅體", desc: "進戰生命 +18，編制 +1", cost: 70, apply: (p) => { p.meleeHp += 18; p.squad += 1; } },
    ];
  return [{ id: "t3", name: "最終：不息潮心", desc: "治療 +40%，間隔 −2s，回復名額 +1", cost: 95, apply: (p) => { p.healAmt *= 1.4; p.deployCd = Math.max(6, p.deployCd - 2); p.mixHealer += 1; } }];
}

/** 升級費用：前期便宜、後期遞增，避免直線爆炸 */
function upgradeCost(kind: "dmg" | "rate", level: number) {
  const base = kind === "dmg" ? 30 : 26;
  // level 1→2 ≈ 30/26, 5→6 ≈ 90/78, 10→11 ≈ 210/180
  return Math.round(base * Math.pow(level, 1.32));
}

type AutoUpgradeMode = "off" | "dmg" | "rate" | "smart";
const AUTO_UPGRADE_MAX_LEVEL = 20;
/** 自動升級至少保留的金幣，避免把建塔錢花光 */
const AUTO_UPGRADE_RESERVE = 45;
const AUTO_UPGRADE_LABEL: Record<AutoUpgradeMode, string> = {
  off: "自動升級：關",
  dmg: "自動：傷害",
  rate: "自動：射速",
  smart: "自動：智能",
};

function applyPassiveSkillEffects(tw: {
  skills?: string[];
  damage: number;
  cooldown: number;
  range: number;
}) {
  const effects = collectEffects(tw.skills);
  for (const e of effects) {
    if (e.type === "dmgMul") tw.damage *= e.value;
    if (e.type === "cooldownMul") tw.cooldown = Math.max(0.12, tw.cooldown * e.value);
    if (e.type === "rangeAdd") tw.range += e.value;
  }
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
  tideMark?: number;
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

export type TargetMode = "auto" | "first" | "last" | "nearest" | "farthest" | "strongest" | "weakest";

const TARGET_MODE_LABEL: Record<TargetMode, string> = {
  auto: "特性預設",
  first: "最前（近出口）",
  last: "最後（剛入場）",
  nearest: "最近",
  farthest: "最遠",
  strongest: "血量最高",
  weakest: "血量最低",
};

/** 依塔特殊效果給預設鎖定策略 */
function defaultTargetMode(special: Special): TargetMode {
  switch (special) {
    case "execute":
      return "weakest";
    case "slow":
    case "root":
      return "nearest";
    case "aoe":
    case "chain":
    case "ultimate":
    case "break":
      return "strongest";
    case "burn":
    case "rapid":
      return "nearest";
    case "pierce":
    case "high":
    case "range":
    default:
      return "first";
  }
}

function resolveTargetMode(mode: TargetMode | undefined, special: Special): TargetMode {
  const m = mode ?? "auto";
  return m === "auto" ? defaultTargetMode(special) : m;
}

function pickTowerTarget(
  tw: { x: number; y: number; range: number; targetMode?: TargetMode; def: number },
  enemies: Enemy[],
  special: Special,
): Enemy | null {
  const mode = resolveTargetMode(tw.targetMode, special);
  let best: Enemy | null = null;
  let score = mode === "weakest" || mode === "last" || mode === "nearest" ? Infinity : -Infinity;
  for (const e of enemies) {
    const p = posAt(e.dist, e.route);
    const d = Math.hypot(p.x - tw.x, p.y - tw.y);
    if (d > tw.range) continue;
    let sc = 0;
    if (mode === "first") sc = e.dist;
    else if (mode === "last") sc = e.dist;
    else if (mode === "nearest") sc = d;
    else if (mode === "farthest") sc = d;
    else if (mode === "strongest") sc = e.hp;
    else if (mode === "weakest") sc = e.hp;
    const better =
      mode === "last" || mode === "nearest" || mode === "weakest" ? sc < score : sc > score;
    if (best === null || better) {
      best = e;
      score = sc;
    }
  }
  return best;
}

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
  /** 攻擊動畫已播放時間 / 總時長（秒）；atkT < atkDur 時顯示攻擊幀 */
  atkT: number;
  atkDur: number;
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
  /** 鎖定優先；auto 則依塔特性 */
  targetMode?: TargetMode;
  /** 本塔專屬覺醒技能 id 列表 */
  skills?: string[];
  skillShots?: number;
  focusId?: number;
  focusStacks?: number;
  moonfallCd?: number;
  pierceHits?: number;
  /** 聖地本體（不可出售、獨特升級路線） */
  sanctuary?: boolean;
  hqCoreLv?: number;
  /** 週期投放計時 */
  escortCd?: number;
};

function sanctuaryStats(tw: { hqCoreLv?: number }) {
  const coreLv = tw.hqCoreLv ?? 1;
  const damage = HQ_BASE_DMG * Math.pow(1.18, coreLv - 1);
  const range = HQ_BASE_RANGE + (coreLv - 1) * 10;
  const cooldown = Math.max(0.4, HQ_BASE_CD * Math.pow(0.94, coreLv - 1));
  return { damage, range, cooldown };
}

function coreUpgradeCost(lv: number) {
  return Math.round(40 * Math.pow(1.4, Math.max(0, lv - 1)));
}

let __escortSeq = 1;



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
  skills?: string[];
  fromTower?: number;
  /** 霞貫穿透計數 */
  pierceCount?: number;
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
  [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `/anim/towers/t${String(i + 1).padStart(2, "0")}/${n}.jpg?v=9`),
);

/** 每塔 4 幀攻擊；最後一幀在時軸上佔較長比例 */
const TOWER_ATK_ANIMS: string[][] = TOWERS.map((_, i) =>
  [0, 1, 2, 3].map((n) => `/anim/towers/t${String(i + 1).padStart(2, "0")}/atk/${n}.jpg?v=3`),
);

/**
 * progress 0..1 → 攻擊幀。
 * 預設權重：蓄力 / 出手 / 命中 / 收勢(較長)。
 * 末幀拉長，對齊「出手後停一下再回待機」。
 */
function attackFrameIndex(progress: number, count: number, weights?: number[]) {
  if (count <= 1) return 0;
  const p = Math.max(0, Math.min(1, progress));
  const w = weights && weights.length === count ? weights : count === 4 ? [0.14, 0.18, 0.26, 0.42] : null;
  if (!w) {
    const hold = 0.42;
    if (p >= 1 - hold) return count - 1;
    return Math.min(count - 2, Math.floor((p / (1 - hold)) * (count - 1)));
  }
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += w[i];
    if (p <= acc || i === count - 1) return i;
  }
  return count - 1;
}

/** 攻擊動畫進度曲線：前段偏快、收勢偏慢 */
function attackEase(p: number) {
  const t = Math.max(0, Math.min(1, p));
  // smoothstep-ish: 出手加速，尾段變慢利於末幀停留感
  return t * t * (3 - 2 * t);
}

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
  return (
    <img
      className="tower-idle"
      src={frames[pingIndex(frames.length, step)] ?? frames[0]}
      alt=""
      draggable={false}
    />
  );
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

/** 透明精靈直接繪製；不裁切硬邊，避免奇怪邊緣 */
function blit(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) return;
  ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh);
}

/** 塔繪製：輕微橢圓遮罩去掉殘餘方角背景 */
function blitTower(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) return;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(dx + dw / 2, dy + dh * 0.52, dw * 0.48, dh * 0.48, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}

export function FoxTD() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [gold, setGold] = useState(START_GOLD);
  /** 明潮砂：重骰地塊用，基礎產量 0 */
  const [mingSand, setMingSand] = useState(0);
  const mingSandRef = useRef(0);
  const [lives, setLives] = useState(20);
  const [wave, setWave] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [pick, setPick] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState("");
  const [speed, setSpeed] = useState(1);
  const [endless, setEndless] = useState(false);
  const [autoUpgrade, setAutoUpgrade] = useState<AutoUpgradeMode>("off");
  const autoUpgradeRef = useRef<AutoUpgradeMode>("off");
  const [skillOffer, setSkillOffer] = useState<{
    towerIndex: number;
    level: number;
    choices: TowerSkillDef[];
  } | null>(null);
  const skillOfferQueueRef = useRef<{ towerIndex: number; level: number; choices: TowerSkillDef[] }[]>([]);
  const skillOfferRef = useRef<{ towerIndex: number; level: number; choices: TowerSkillDef[] } | null>(null);

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
  /** expand = 地塊拼接開局；layout = 完整預設／自訂地圖 */
  const [mapMode, setMapMode] = useState<"expand" | "layout">("expand");
  const [selectedLevelId, setSelectedLevelId] = useState<string>("mode-expand");
  const [tool, setTool] = useState<"block" | "height" | "entry" | "exit">("block");
  const [brush, setBrush] = useState(1);
  const [bestiary, setBestiary] = useState<EnemyDef[]>(() => stockBestiary());
  const [editMob, setEditMob] = useState(0);
  const [editTower, setEditTower] = useState(0);
  const [difficultyId, setDifficultyId] = useState(() => loadActiveDifficultyId());
  const [diffList, setDiffList] = useState<DifficultyProfile[]>(() => allDifficulties());
  const difficultyRef = useRef<DifficultyProfile>(getDifficulty(loadActiveDifficultyId()));
  const [towerBook, setTowerBook] = useState<TowerDef[]>(() => TOWERS.map((t) => ({ ...t })));
  const towerBookRef = useRef<TowerDef[]>(TOWERS.map((t) => ({ ...t })));
  const [diffName, setDiffName] = useState("自訂難度");
  const boardRef = useRef<TileBoard>(seedBoard());
  const hqProgRef = useRef<HqProgress>(defaultHqProgress());
  const [, setHqProgTick] = useState(0);
  const bumpHqUi = () => setHqProgTick((n) => n + 1);
  const tileOfferRef = useRef<string[] | null>(null);
  const [tileOffer, setTileOffer] = useState<string[] | null>(null);
  const [pickTemplate, setPickTemplate] = useState<string | null>(null);
  const pickTemplateRef = useRef<string | null>(null);
  const [pickRot, setPickRot] = useState<Rot>(0);
  const pickRotRef = useRef<Rot>(0);
  const mapModeRef = useRef<"expand" | "layout">("expand");


  useEffect(() => {
    goldRef.current = gold;
    mingSandRef.current = mingSand;
  }, [gold, mingSand]);
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
    autoUpgradeRef.current = autoUpgrade;
  }, [autoUpgrade]);
  useEffect(() => {
    skillOfferRef.current = skillOffer;
  }, [skillOffer]);
  useEffect(() => {
    pickTemplateRef.current = pickTemplate;
  }, [pickTemplate]);
  useEffect(() => {
    pickRotRef.current = pickRot;
  }, [pickRot]);
  useEffect(() => {
    mapModeRef.current = mapMode;
  }, [mapMode]);
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
    towerBookRef.current = towerBook;
  }, [towerBook]);
  useEffect(() => {
    difficultyRef.current = getDifficulty(difficultyId);
    saveActiveDifficultyId(difficultyId);
  }, [difficultyId]);
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
    escorts: [] as Escort[],
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
    towerAtkFrames: [] as HTMLImageElement[][],
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
    sim.current.towerAtkFrames = TOWER_ATK_ANIMS.map((urls) =>
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
      ground: "/scene/ground.png",
      height1: "/scene/height1.png",
      height2: "/scene/height2.png",
      height3: "/scene/height3.png",
      entrance: "/scene/entrance.png",
      exit: "/scene/exit.png",
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

    const hitEnemy = (
      e: Enemy,
      dmg: number,
      special: Special,
      color: string,
      px: number,
      py: number,
      skills?: string[],
      fromTower?: number,
      extra?: { pierceCount?: number },
    ) => {
      const effects = collectEffects(skills);
      const hasEff = (t: SkillEffect["type"]) => effects.some((x) => x.type === t);
      const get = <T extends SkillEffect["type"]>(t: T) => effects.filter((x) => x.type === t) as Extract<SkillEffect, { type: T }>[];

      let amount = dmg * (e.vulnT > 0 ? e.vuln : 1);
      amount *= sumDmgMul(effects);

      // 暴擊
      for (const c of get("crit")) {
        if (Math.random() < c.chance) {
          amount *= c.mul;
          float(px, py - 30, "暴擊", "#ffe08a");
          break;
        }
      }
      // 距離加傷
      if (fromTower != null) {
        const tw = sim.current.towers[fromTower];
        for (const d of get("distDmgMul")) {
          if (!tw) break;
          const dist = Math.hypot(px - tw.x, py - tw.y);
          amount *= 1 + Math.min(d.maxBonus, (dist / Math.max(60, tw.range)) * d.maxBonus);
        }
      }
      // 印記
      let markBonus = 0;
      for (const m of get("markStack")) {
        markBonus = Math.max(markBonus, Math.min(m.max, e.tideMark || 0) * m.perStack);
      }
      amount *= 1 + markBonus;
      // 半血 / 護盾 / 定身
      for (const l of get("lowHpDmgMul")) {
        if (e.hp / e.maxHp <= l.hpRatio) amount *= l.mul;
      }
      for (const sh of get("shieldDmgMul")) {
        if (e.shield > 0) amount *= sh.mul;
      }
      for (const r of get("rootExtraDmg")) {
        if (e.rootT > 0) amount *= r.mul;
      }

      if (e.armor) amount *= 0.65;
      if (e.shield > 0) {
        const used = Math.min(e.shield, amount);
        e.shield -= used;
        amount -= used;
      }
      e.hp -= amount;
      float(px, py - 16, String(Math.round(amount)), "#fff");
      applyStatus(e, special, dmg);

      // 減速 / 定身 / 燃燒 / 易傷 / 印記
      for (const sl of get("slowOnHit")) {
        if (!e.noslow) {
          e.slow = Math.min(e.slow, sl.factor);
          e.slowT = Math.max(e.slowT, sl.duration);
        }
      }
      for (const rc of get("rootChance")) {
        if (!e.noslow && Math.random() < rc.chance) {
          e.rootT = Math.max(e.rootT, rc.duration);
          float(px, py - 26, "縛", "#a8e4ff");
        }
      }
      for (const b of get("burnBoost")) {
        e.burn = Math.max(e.burn, b.dps);
        e.burnT = Math.max(e.burnT, b.duration);
      }
      for (const bs of get("burnSpread")) {
        if (e.burnT <= 0) continue;
        for (const o of sim.current.enemies) {
          if (o === e) continue;
          const op = posAt(o.dist, o.route);
          if (Math.hypot(op.x - px, op.y - py) < bs.radius) {
            o.burn = Math.max(o.burn, e.burn * 0.75);
            o.burnT = Math.max(o.burnT, 2.2);
          }
        }
      }
      for (const v of get("vulnOnHit")) {
        e.vuln = Math.max(e.vuln, v.mul);
        e.vulnT = Math.max(e.vulnT, v.duration);
      }
      for (const m of get("markStack")) {
        e.tideMark = Math.min(m.max, (e.tideMark || 0) + 1);
      }

      // 處決
      let exec = special === "execute" ? 0.18 : 0;
      for (const ex of get("execLine")) exec = Math.max(exec, ex.ratio);
      if (exec > 0 && e.hp > 0 && e.hp < e.maxHp * exec) {
        e.hp = 0;
        float(px, py - 28, "斬", "#ffd2a8");
      }

      burst(px, py, color, 6, 1.6);
      e.hurt = 0.22;

      let aoeMul = 1;
      for (const a of get("aoeRadiusMul")) aoeMul *= a.value;
      let centerMul = 1;
      for (const a of get("aoeCenterMul")) centerMul *= a.value;

      sim.current.pops.push({
        x: px,
        y: py,
        age: 0,
        scale: special === "aoe" || special === "ultimate" ? 1.35 * aoeMul : 0.85,
      });

      if (special === "aoe" || special === "ultimate") {
        const maxR = (special === "ultimate" ? 96 : 74) * aoeMul;
        sim.current.rings.push({ x: px, y: py, r: 8, max: maxR, color, life: 0.28 });
        for (const o of sim.current.enemies) {
          if (o === e) continue;
          const op = posAt(o.dist, o.route);
          if (Math.hypot(op.x - px, op.y - py) < maxR * 0.95) {
            o.hp -= amount * 0.65;
            applyStatus(o, special, dmg * 0.65);
          }
        }
        if (centerMul > 1) e.hp -= amount * (centerMul - 1) * 0.6;
      }

      // 濺射
      for (const sp of get("splash")) {
        for (const o of sim.current.enemies) {
          if (o === e) continue;
          const op = posAt(o.dist, o.route);
          if (Math.hypot(op.x - px, op.y - py) < sp.radius) o.hp -= amount * sp.pct;
        }
        sim.current.rings.push({ x: px, y: py, r: 4, max: sp.radius, color: "#9ad7ff", life: 0.15 });
      }
      // 回響
      for (const ec of get("multihitEcho")) {
        const near = sim.current.enemies
          .filter((o) => o !== e)
          .map((o) => ({ o, d: Math.hypot(posAt(o.dist, o.route).x - px, posAt(o.dist, o.route).y - py) }))
          .filter((x) => x.d < ec.radius)
          .sort((a, b) => a.d - b.d)[0];
        if (near) {
          near.o.hp -= amount * ec.pct;
          burst(posAt(near.o.dist, near.o.route).x, posAt(near.o.dist, near.o.route).y, "#8ef0ff", 4, 1.2);
        }
      }

      // 連鎖（基礎 + 技能）
      if (special === "chain") {
        let extra = 0, jump = 110, pct = 0.55, ret = 0;
        for (const c of get("chainBonus")) {
          extra += c.extra;
          jump = Math.max(jump, c.range);
          pct = Math.max(pct, c.pct);
        }
        for (const c of get("chainReturn")) ret = Math.max(ret, c.pct);
        const p0 = posAt(e.dist, e.route);
        const near = sim.current.enemies
          .filter((o) => o !== e)
          .map((o) => ({ o, d: Math.hypot(posAt(o.dist, o.route).x - p0.x, posAt(o.dist, o.route).y - p0.y) }))
          .filter((x) => x.d < jump)
          .sort((a, b) => a.d - b.d)
          .slice(0, 3 + extra);
        for (const n of near) {
          n.o.hp -= dmg * pct;
          const np = posAt(n.o.dist, n.o.route);
          burst(np.x, np.y, "#8ef0ff", 4, 1.2);
        }
        if (ret > 0 && near.length) e.hp -= dmg * ret;
      }

      // 擊殺效果
      if (e.hp <= 0) {
        for (const g of get("goldOnKill")) {
          goldRef.current += g.amount;
          setGold(goldRef.current);
        }
        for (const h of get("hasteOnKill")) {
          if (fromTower != null) {
            const tw = sim.current.towers[fromTower];
            if (tw) {
              tw.rateMul = Math.max(tw.rateMul || 1, h.rateMul);
              tw.moonfallCd = -(h.duration);
            }
          }
        }
        for (const k of get("killNova")) {
          sim.current.rings.push({ x: px, y: py, r: 10, max: k.radius, color: "#ff8a55", life: 0.32 });
          for (const o of sim.current.enemies) {
            if (o === e) continue;
            const op = posAt(o.dist, o.route);
            if (Math.hypot(op.x - px, op.y - py) < k.radius) o.hp -= e.maxHp * k.pctOfMaxHp;
          }
        }
      }
    };

    const fire = (tw: Tower, target: Enemy, towerIndex?: number) => {
      const def = towerBookRef.current?.[tw.def] ?? TOWERS[tw.def];
      const p = posAt(target.dist, target.route);
      const skills = tw.skills || [];
      const effects = collectEffects(skills);
      tw.skillShots = (tw.skillShots || 0) + 1;
      const dmg = tw.damage;

      const pushShot = (tx: number, ty: number, tgt: Enemy | null, special: Special, color: string, spd: number, life: number) => {
        sim.current.shots.push({
          x: tw.x,
          y: tw.y,
          tx,
          ty,
          speed: spd,
          damage: dmg,
          special,
          color,
          life,
          pierced: new Set(),
          target: tgt,
          skills,
          fromTower: towerIndex,
          pierceCount: 0,
        });
      };

      // 每 N 發 nova
      for (const n of effects) {
        if (n.type === "everyNShotsNova" && tw.skillShots % n.n === 0) {
          sim.current.rings.push({ x: p.x, y: p.y, r: 8, max: n.radius, color: "#ff9ec4", life: 0.28 });
          for (const o of sim.current.enemies) {
            const op = posAt(o.dist, o.route);
            if (Math.hypot(op.x - p.x, op.y - p.y) < n.radius) o.hp -= dmg * n.dmgMul;
          }
          float(p.x, p.y - 18, "裂潮", "#ff9ec4");
        }
      }

      if (def.special === "pierce") {
        const ang = Math.atan2(p.y - tw.y, p.x - tw.x);
        pushShot(tw.x + Math.cos(ang) * 900, tw.y + Math.sin(ang) * 900, null, def.special, def.color, 520, 1.1);
      } else {
        pushShot(p.x, p.y, target, def.special, def.color, 460, 1.6);
        for (const d of effects) {
          if (d.type === "doubleShot" && Math.random() < d.chance) {
            pushShot(p.x + 6, p.y + 6, target, def.special, def.color, 480, 1.5);
          }
        }
      }
      burst(tw.x, tw.y, def.color, 4, 1.4);
      tw.recoil = 0.28;
      // 攻擊動畫貼射速：佔本輪冷卻大部分，快塔更快播完；末幀仍會被權重拉長
      {
        const period = Math.max(0.12, tw.cooldown / (tw.rateMul > 0 ? tw.rateMul : 1));
        tw.atkDur = Math.min(0.85, Math.max(0.18, period * 0.92));
        tw.atkT = 0;
      }
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
          const diff = difficultyRef.current;
          const scale = endlessRef.current
            ? endlessScale(s.wave)
            : 1 + (s.wave - 1) * (diff.waveHpScale ?? 0.08);
          const speedMul =
            (endlessRef.current ? 1 + Math.min(0.12, (s.wave - 1) * 0.004) : 1) * (diff.enemySpeedMul ?? 1);
          const goldMul =
            (endlessRef.current
              ? 1 + Math.min(0.9, s.wave * 0.035)
              : 1 + Math.min(1.2, (s.wave - 1) * 0.06)) * (diff.enemyGoldMul ?? 1);
          const hpMul = (diff.enemyHpMul ?? 1) * scale;
          s.enemies.push({
            type: job.type,
            dist: 0,
            hp: et.hp * hpMul,
            maxHp: et.hp * hpMul,
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
          } else if (isExpandBoard(boardRef.current) && shouldOfferTiles(s.wave, boardRef.current) && !tileOfferRef.current) {
            const opts = pickOfferTemplates(OFFER_COUNT, boardRef.current, runTileBias);
            if (opts.length && frontierSlots(boardRef.current).length) {
              // 擴張波結算：湧出明潮砂（基礎產量 0，僅此事件）
              mingSandRef.current += 1;
              setMingSand(mingSandRef.current);
              tileOfferRef.current = opts;
              setTileOffer(opts);
              setPickTemplate(null);
              pickTemplateRef.current = null;
              pausedRef.current = true;
              setPaused(true);
              setHover(`第 ${s.wave} 波結束 · 疆域可擴張 · 明潮砂 +1（現有 ${mingSandRef.current}）`);
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
          const d = Math.hypot(tw.x - p.x, tw.y - p.y);
          // 路障可被近戰拆；略優先攻擊路障以便擋路有意義
          const weight = tw.stake ? d * 0.85 : d;
          towersNear.push({ index: ti, dist: d });
          if (weight < bestD) {
            bestD = weight;
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
              if (!tw) continue;
              tw.hp -= h.damage * (e.rage ? 1.3 : 1) * (tw.stake ? 0.75 : 1);
              tw.shake = 0.2;
              burst(tw.x, tw.y, "#ffb4c8", 8, 1.8);
            }
            for (let ti = s.towers.length - 1; ti >= 0; ti--) {
              if (s.towers[ti].hp > 0) continue;
              const dead = s.towers[ti];
              if (dead.stake) {
                const next = new Set(s.blocked);
                next.delete(cellKey(dead.gx, dead.gy));
                const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean })?.__commit;
                commit?.(next);
                float(dead.x, dead.y, "路障摧毀", "#ffd2a8");
              } else {
                float(dead.x, dead.y, "塔被拆毀", "#ff8aa0");
              }
              s.towers.splice(ti, 1);
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
            if (!tw) return false;
            e.face = tw.x >= p.x ? 1 : -1;
            // 路障較耐打一點
            const mul = (e.rage ? 1.4 : 1) * (tw.stake ? 0.75 : 1);
            tw.hp -= damage * mul;
            tw.shake = 0.18;
            burst(tw.x, tw.y, e.rage ? "#ff6fa8" : "#ffb4c8", e.boss ? 10 : 6, 1.8);
            if (tw.hp <= 0) {
              if (tw.stake) {
                const next = new Set(s.blocked);
                next.delete(cellKey(tw.gx, tw.gy));
                const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean })?.__commit;
                commit?.(next);
                float(tw.x, tw.y, "路障摧毀", "#ffd2a8");
              } else {
                float(tw.x, tw.y, "塔被拆毀", "#ff8aa0");
              }
              s.towers.splice(towerIndex, 1);
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


      // 技能光環／週期 Nova
      for (let ti = 0; ti < s.towers.length; ti++) {
        const tw = s.towers[ti];
        if (tw.stake || !tw.skills?.length) continue;
        const effects = collectEffects(tw.skills);
        for (const ef of effects) {
          if (ef.type === "auraSlow") {
            for (const e of s.enemies) {
              const p = posAt(e.dist, e.route);
              if (Math.hypot(p.x - tw.x, p.y - tw.y) <= tw.range && !e.noslow) {
                e.slow = Math.min(e.slow, ef.factor);
                e.slowT = Math.max(e.slowT, 0.3);
              }
            }
          }
          if (ef.type === "periodicNova") {
            // 負 moonfallCd 保留給 haste timer
            if (tw.moonfallCd != null && tw.moonfallCd < 0) continue;
            tw.moonfallCd = (tw.moonfallCd || 0) + dt;
            if ((tw.moonfallCd || 0) >= ef.period) {
              tw.moonfallCd = 0;
              const rad = tw.range * ef.radiusMul;
              sim.current.rings.push({ x: tw.x, y: tw.y, r: 10, max: rad, color: "#ffe08a", life: 0.35 });
              for (const e of s.enemies) {
                const p = posAt(e.dist, e.route);
                if (Math.hypot(p.x - tw.x, p.y - tw.y) <= rad) {
                  e.hp -= tw.damage * ef.dmgMul;
                  e.burn = Math.max(e.burn, 8);
                  e.burnT = Math.max(e.burnT, 2);
                }
              }
              float(tw.x, tw.y - 36, "領域", "#ffe08a");
            }
          }
        }
      }

      // 自動升級：優先低等塔，保留底金
      {
        const mode = autoUpgradeRef.current;
        if (mode !== "off" && phaseRef.current === "play") {
          const list = s.towers
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => !t.stake && t.level < AUTO_UPGRADE_MAX_LEVEL)
            .sort((a, b) => a.t.level - b.t.level || a.i - b.i);
          for (const { t: tw } of list) {
            let kind: "dmg" | "rate" = mode === "rate" ? "rate" : "dmg";
            if (mode === "smart") {
              const cd = upgradeCost("dmg", tw.level);
              const cr = upgradeCost("rate", tw.level);
              kind = cr < cd ? "rate" : "dmg";
            }
            const cost = upgradeCost(kind, tw.level);
            if (goldRef.current - cost < AUTO_UPGRADE_RESERVE) continue;
            if (goldRef.current < cost) continue;
            goldRef.current -= cost;
            tw.spent = (tw.spent || 0) + cost;
            if (kind === "dmg") tw.damage *= 1.22;
            else tw.cooldown = Math.max(0.18, tw.cooldown * 0.82);
            tw.level += 1;
            const before = tw.maxHp;
            tw.maxHp = Math.round(tw.maxHp * 1.18 + 12);
            tw.hp = Math.min(tw.maxHp, tw.hp + (tw.maxHp - before) + 20);
            setGold(goldRef.current);
            if (isSkillLevel(tw.level)) {
              const idx = s.towers.indexOf(tw);
              if (idx >= 0) {
                // 延遲到下一幀用 queue（在 React 外）
                const choices = rollSkillChoices(tw.skills, tw.level, SKILL_CHOICE_COUNT);
                if (choices.length) {
                  const offer = { towerIndex: idx, level: tw.level, choices };
                  // 寫入 queue，step 外由 ref 標記
                  (sim.current as { __skillQ?: typeof offer[] }).__skillQ = (
                    (sim.current as { __skillQ?: typeof offer[] }).__skillQ || []
                  ).concat([offer]);
                }
              }
            }
          }
        }
      }

      {
        const q = (s as { __skillQ?: { towerIndex: number; level: number; choices: TowerSkillDef[] }[] }).__skillQ;
        if (q && q.length) {
          (s as { __skillQ?: unknown }).__skillQ = [];
          for (const offer of q) skillOfferQueueRef.current.push(offer);
          if (!skillOfferRef.current && skillOfferQueueRef.current.length) {
            const first = skillOfferQueueRef.current.shift()!;
            queueMicrotask(() => {
              setSkillOffer(first);
              pausedRef.current = true;
              setPaused(true);
            });
          }
        }
      }

      for (const tw of s.towers) {
        if (tw.terrorT > 0) {
          tw.terrorT -= dt;
          if (tw.terrorT <= 0) tw.rateMul = 1;
        } else if (tw.rateMul === undefined) tw.rateMul = 1;
        tw.cd -= dt;
        const twDef = towerBookRef.current[tw.def] ?? TOWERS[tw.def];
        const best = tw.stake ? null : pickTowerTarget(tw, s.enemies, twDef?.special ?? "high");
        if (best && tw.cd <= 0) {
          let cd = tw.cooldown / (tw.rateMul > 0 ? tw.rateMul : 1);
          // 終焉疾射 / 羽嵐已在 cooldown 寫入
          if (tw.moonfallCd != null && tw.moonfallCd < 0) {
            cd *= 0.7;
            tw.moonfallCd += dt;
            if (tw.moonfallCd >= 0) tw.moonfallCd = 0;
          }
          tw.cd = cd;
          const ti = s.towers.indexOf(tw);
          fire(tw, best, ti >= 0 ? ti : undefined);
        } else if (best) {
          const p = posAt(best.dist, best.route);
          tw.aim = Math.atan2(p.y - tw.y, p.x - tw.x);
        }
        if (tw.recoil > 0) tw.recoil -= dt;
        if (tw.atkDur > 0 && tw.atkT < tw.atkDur) tw.atkT = Math.min(tw.atkDur, tw.atkT + dt);
        if (tw.shake > 0) tw.shake -= dt;
        // 聖地週期護衛
        if (tw.sanctuary) {
          tw.escortCd = (tw.escortCd ?? 0) - dt;
          if (tw.escortCd <= 0 && s.enemies.some((e) => e.hp > 0)) {
            // 自動動員（耗金，金幣不足則延遲重試）
            const p = hqProgRef.current;
            if (goldRef.current >= HQ_ESCORT_COST) {
              // 內聯一次部署避免閉包問題：重用部署邏輯的最小子集
              tw.escortCd = p.deployCd;
              let threat: Enemy | null = null;
              let bestD = 1e15;
              for (const e of s.enemies) {
                if (e.hp <= 0) continue;
                const pos = posAt(e.dist, e.route);
                const d = Math.hypot(pos.x - tw.x, pos.y - tw.y);
                if (d < bestD) {
                  bestD = d;
                  threat = e;
                }
              }
              if (threat) {
                const route = threat.route;
                const live = routes[route] ?? routes[0];
                if (live) {
                  goldRef.current -= HQ_ESCORT_COST;
                  setGold(goldRef.current);
                  const baseDist = Math.min(live.len - 20, Math.max(40, threat.dist + 40));
                  const kinds: EscortKind[] = [];
                  let rangedLeft = p.ranged ? p.mixRanged : 0;
                  let healLeft = p.healer ? p.mixHealer : 0;
                  for (let k = 0; k < p.squad; k++) {
                    if (rangedLeft > 0) {
                      kinds.push("ranged");
                      rangedLeft--;
                    } else if (healLeft > 0) {
                      kinds.push("healer");
                      healLeft--;
                    } else kinds.push("melee");
                  }
                  kinds.forEach((kind, i) => {
                    const dist = Math.min(live.len - 10, baseDist + i * 18);
                    const pos = posAt(dist, route);
                    const maxHp =
                      kind === "melee" ? p.meleeHp : kind === "ranged" ? Math.round(p.meleeHp * 0.55) : Math.round(p.meleeHp * 0.65);
                    s.escorts.push({
                      id: __escortSeq++,
                      kind,
                      x: pos.x,
                      y: pos.y,
                      hp: maxHp,
                      maxHp,
                      route,
                      dist,
                      speed: kind === "melee" ? 42 : kind === "ranged" ? 38 : 36,
                      contactT: 0,
                      shootCd: 0.35 * i,
                      healCd: 1.0,
                    });
                  });
                }
              } else tw.escortCd = 2;
            } else tw.escortCd = 2;
          }
        }
      }

      // 護衛：迎擊推進、接觸換傷、遠程射擊、治療
      {
        const p = hqProgRef.current;
        for (let i = s.escorts.length - 1; i >= 0; i--) {
          const u = s.escorts[i];
          if (u.hp <= 0) {
            s.escorts.splice(i, 1);
            continue;
          }
          // 向入口方向迎擊（dist 減少）
          u.dist = Math.max(8, u.dist - u.speed * dt);
          const pos = posAt(u.dist, u.route);
          u.x = pos.x;
          u.y = pos.y;
          u.contactT -= dt;
          u.shootCd -= dt;
          u.healCd -= dt;

          // 近戰接觸
          if (u.kind === "melee" && u.contactT <= 0) {
            for (const e of s.enemies) {
              if (e.hp <= 0) continue;
              const ep = posAt(e.dist, e.route);
              if (Math.hypot(ep.x - u.x, ep.y - u.y) > 22) continue;
              const dmg = u.hp * p.atkW;
              const reflect = Math.max(0, e.hp) * HQ_REFLECT_W + 3;
              e.hp -= dmg;
              u.hp -= reflect;
              u.contactT = HQ_CONTACT_TICK;
              if (e.hp <= 0) {
                goldRef.current += Math.max(1, Math.round((e.gold || 4) * 0.85));
                setGold(goldRef.current);
              }
              break;
            }
          }
          // 遠程
          if (u.kind === "ranged" && u.shootCd <= 0) {
            let target: Enemy | null = null;
            let td = 1e9;
            for (const e of s.enemies) {
              if (e.hp <= 0) continue;
              const ep = posAt(e.dist, e.route);
              const d = Math.hypot(ep.x - u.x, ep.y - u.y);
              if (d < 110 && d < td) {
                td = d;
                target = e;
              }
            }
            if (target) {
              target.hp -= p.rangedDmg;
              u.shootCd = 0.85;
              if (target.hp <= 0) {
                goldRef.current += Math.max(1, Math.round((target.gold || 4) * 0.85));
                setGold(goldRef.current);
              }
            } else u.shootCd = 0.2;
          }
          // 治療
          if (u.kind === "healer" && u.healCd <= 0) {
            for (const o of s.escorts) {
              if (o.id === u.id || o.hp <= 0) continue;
              if (Math.hypot(o.x - u.x, o.y - u.y) > 70) continue;
              o.hp = Math.min(o.maxHp, o.hp + p.healAmt);
            }
            u.healCd = 2.4;
          }
          if (u.hp <= 0) s.escorts.splice(i, 1);
        }
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
          let wide = 10;
          for (const ef of collectEffects(sh.skills)) {
            if (ef.type === "pierceWiden") wide += ef.add;
          }

          for (const e of s.enemies) {
            if (sh.pierced.has(e)) continue;
            const p = posAt(e.dist, e.route);
            if (Math.hypot(p.x - sh.x, p.y - sh.y) < e.r + wide) {
              sh.pierced.add(e);
              sh.pierceCount = (sh.pierceCount || 0) + 1;
              hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y, sh.skills, sh.fromTower, { pierceCount: sh.pierceCount });
              for (const ef of collectEffects(sh.skills)) {
                if (ef.type === "pierceNovaAt" && (sh.pierceCount || 0) >= ef.count) {
                  sim.current.rings.push({ x: p.x, y: p.y, r: 8, max: ef.radius, color: "#ff6b9d", life: 0.28 });
                  for (const o of s.enemies) {
                    const op = posAt(o.dist, o.route);
                    if (Math.hypot(op.x - p.x, op.y - p.y) < ef.radius) o.hp -= sh.damage * ef.dmgMul;
                  }
                  float(p.x, p.y - 22, "斷潮", "#ff6b9d");
                  sh.pierceCount = 0;
                }
              }
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
            hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y, sh.skills, sh.fromTower, { pierceCount: sh.pierceCount });
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
          if (Math.hypot(p.x - sh.x, p.y - sh.y) < 70) hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y, sh.skills, sh.fromTower, { pierceCount: sh.pierceCount });
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
      ctx.imageSmoothingEnabled = true;
      // @ts-expect-error browser
      ctx.imageSmoothingQuality = "high";
      const t = performance.now() / 1000;
      const bg = s.scene.bg;
      // 畫面底：深海漸層（無網點）
      const g0 = ctx.createLinearGradient(0, 0, 0, VIEWH);
      g0.addColorStop(0, "#0a1c30");
      g0.addColorStop(0.45, "#0c2740");
      g0.addColorStop(1, "#071420");
      ctx.fillStyle = g0;
      ctx.fillRect(0, 0, VIEWW, VIEWH);
      ctx.save();
      const z = s.cam.zoom || 1;
      ctx.scale(z, z);
      ctx.translate(-s.cam.x, -s.cam.y);
      // 世界空間平鋪背景：隨鏡頭移動，柔和覆蓋避免破圖／網點感
      if (bg && bg.complete && bg.naturalWidth) {
        const bw = bg.naturalWidth;
        const bh = bg.naturalHeight;
        const tileW = Math.max(900, bw * 0.85);
        const tileH = Math.max(600, bh * 0.85);
        const xStart = Math.floor(s.cam.x / tileW) * tileW - tileW;
        const yStart = Math.floor(s.cam.y / tileH) * tileH - tileH;
        const xEnd = s.cam.x + VIEWW / z + tileW;
        const yEnd = s.cam.y + VIEWH / z + tileH;
        ctx.globalAlpha = 0.55;
        for (let ty = yStart; ty < yEnd; ty += tileH) {
          for (let tx = xStart; tx < xEnd; tx += tileW) {
            ctx.drawImage(bg, tx, ty, tileW, tileH);
          }
        }
        ctx.globalAlpha = 1;
      }
      // 水色罩：抹平貼圖雜訊
      ctx.fillStyle = "rgba(6, 24, 40, 0.42)";
      ctx.fillRect(s.cam.x - 40, s.cam.y - 40, VIEWW / z + 80, VIEWH / z + 80);
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

      const vz = s.cam.zoom || 1;
      const x0 = Math.max(0, Math.floor(s.cam.x / CELL) - 1);
      const y0 = Math.max(0, Math.floor(s.cam.y / CELL) - 1);
      const x1 = Math.min(COLS - 1, Math.ceil((s.cam.x + VIEWW / vz) / CELL) + 1);
      const y1 = Math.min(ROWS - 1, Math.ceil((s.cam.y + VIEWH / vz) / CELL) + 1);
      // 僅工房顯示格線（戰鬥中不顯示網點）
      if (workshopRef.current) {
        ctx.strokeStyle = "rgba(180,230,255,0.12)";
        ctx.lineWidth = 1;
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

      // 可走潮坪：貼圖平鋪 + 柔和底色
      const groundImg = s.scene.ground;
      const groundReady = !!(groundImg && groundImg.complete && groundImg.naturalWidth);
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          if (!isCellOnBoard(boardRef.current, c, r)) continue;
          const key = cellKey(c, r);
          if (s.blocked.has(key)) continue;
          const x = c * CELL, y = r * CELL;
          if (groundReady) {
            ctx.globalAlpha = 0.78;
            ctx.drawImage(groundImg, (c * 37) % 96, (r * 53) % 96, 32, 32, x, y, CELL + 0.5, CELL + 0.5);
            ctx.globalAlpha = 1;
            ctx.fillStyle = "rgba(20, 55, 70, 0.22)";
            ctx.fillRect(x, y, CELL + 0.5, CELL + 0.5);
          } else {
            const h = ((c * 374761) ^ (r * 668265)) >>> 0;
            const tint = (h % 8) / 8;
            ctx.fillStyle = `rgba(${24 + tint * 14 | 0}, ${58 + tint * 18 | 0}, ${72 + tint * 20 | 0}, 0.55)`;
            ctx.fillRect(x, y, CELL + 0.5, CELL + 0.5);
          }
        }
      }


      if (tileOfferRef.current && pickTemplateRef.current) {
        const tid = pickTemplateRef.current;
        const rot = pickRotRef.current;
        const tpl = TEMPLATE_BY_ID[tid];
        const rt = tpl ? rotatedTemplate(tpl, rot) : null;
        const valid = validPlacements(boardRef.current, tid).filter((s) => s.rot === rot);
        // 可放槽位底色
        for (const slot of valid) {
          const ox = slot.tc * TILE * CELL;
          const oy = slot.tr * TILE * CELL;
          ctx.fillStyle = "rgba(120, 220, 180, 0.22)";
          ctx.fillRect(ox, oy, TILE * CELL, TILE * CELL);
          ctx.strokeStyle = "rgba(160, 255, 210, 0.9)";
          ctx.lineWidth = 2;
          ctx.strokeRect(ox + 2, oy + 2, TILE * CELL - 4, TILE * CELL - 4);
        }
        // 游標所在槽：道路／礁石形狀預覽（確認放置效果）
        if (rt) {
          const gx = Math.floor(s.pointer.x / CELL);
          const gy = Math.floor(s.pointer.y / CELL);
          const hovTc = Math.floor(gx / TILE);
          const hovTr = Math.floor(gy / TILE);
          const canHere = valid.some((v) => v.tc === hovTc && v.tr === hovTr);
          const ox = hovTc * TILE * CELL;
          const oy = hovTr * TILE * CELL;
          // 僅在鄰近 frontier 槽上畫形狀，避免滿圖塗抹
          const near = frontierSlots(boardRef.current).some(
            (f) => f.tc === hovTc && f.tr === hovTr,
          ) || canHere;
          if (near && hovTc >= 0 && hovTr >= 0 && hovTc < 10 && hovTr < 10) {
            for (let r = 0; r < TILE; r++) {
              for (let c = 0; c < TILE; c++) {
                const blocked = rt.blocked[r][c];
                const x = ox + c * CELL;
                const y = oy + r * CELL;
                if (blocked) {
                  ctx.fillStyle = canHere ? "rgba(40, 70, 90, 0.55)" : "rgba(90, 40, 40, 0.45)";
                } else {
                  ctx.fillStyle = canHere ? "rgba(180, 230, 255, 0.35)" : "rgba(255, 120, 100, 0.28)";
                }
                ctx.fillRect(x, y, CELL, CELL);
              }
            }
            ctx.strokeStyle = canHere ? "rgba(200, 255, 230, 0.95)" : "rgba(255, 140, 140, 0.9)";
            ctx.lineWidth = 3;
            ctx.strokeRect(ox + 1, oy + 1, TILE * CELL - 2, TILE * CELL - 2);
            ctx.fillStyle = canHere ? "#c8ffe0" : "#ffb0b0";
            ctx.font = "bold 13px sans-serif";
            ctx.fillText(canHere ? "可放置 · 點一下確認" : "無法銜接", ox + 12, oy + 22);
          }
        }
      }

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // 道路：接近聖地中心時透明度遞減（隱沒，不搶建築畫面）
      const hqTw = s.towers.find((tw) => tw.sanctuary);
      const hqX = hqTw?.x ?? -99999;
      const hqY = hqTw?.y ?? -99999;
      const fadeR = CELL * 5.5;
      routes.forEach((live, idx) => {
        if (!live.pts.length) return;
        for (let i = 1; i < live.pts.length; i++) {
          const a = live.pts[i - 1];
          const b = live.pts[i];
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dist = Math.hypot(mx - hqX, my - hqY);
          const fade = hqTw ? Math.max(0.05, Math.min(1, (dist - CELL * 1.2) / fadeR)) : 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle =
            idx % 2 === 0
              ? `rgba(255,230,180,${0.18 * fade})`
              : `rgba(140,210,255,${0.16 * fade})`;
          ctx.lineWidth = 30;
          ctx.stroke();
          ctx.strokeStyle = `rgba(100,190,230,${0.12 * fade})`;
          ctx.lineWidth = 14;
          ctx.stroke();
        }
      });

      // 少量氣泡（勿過密）
      ctx.fillStyle = "rgba(180,230,255,0.2)";
      for (let i = 0; i < 10; i++) {
        const bx = s.cam.x + ((i * 173 + t * 18) % (VIEWW / z + 80));
        const by = s.cam.y + ((i * 111 + t * 28) % (VIEWH / z + 80));
        ctx.beginPath();
        ctx.arc(bx, by, 1.5 + (i % 3), 0, Math.PI * 2);
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
        // 格線落點
        ctx.fillStyle = ok ? "rgba(120,200,255,0.18)" : "rgba(255,70,70,0.2)";
        ctx.fillRect(gx * GRID + 2, gy * GRID + 2, GRID - 4, GRID - 4);
        ctx.strokeStyle = ok ? "rgba(180,230,255,0.85)" : "rgba(255,100,100,0.9)";
        ctx.lineWidth = 2;
        ctx.strokeRect(gx * GRID + 2, gy * GRID + 2, GRID - 4, GRID - 4);
        ctx.beginPath();
        ctx.arc(px, py, def.range + bonus, 0, Math.PI * 2);
        ctx.fillStyle = ok ? "rgba(120,200,255,0.1)" : "rgba(255,80,80,0.12)";
        ctx.fill();
        ctx.strokeStyle = ok ? "rgba(140,210,255,0.55)" : "rgba(255,90,90,0.6)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const cost = Math.max(1, Math.round(def.cost * (getDifficulty(difficultyId).towerCostMul ?? 1)));
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = ok ? "#dff6ff" : "#ffb0b0";
        ctx.fillText(ok ? `💰${cost}` : "無法放置", px - 18, py + 4);
        if (bonus > 0 && ok) {
          ctx.fillStyle = "#ffe08a";
          ctx.fillText(`高地 +${bonus}`, px - 28, py - 34);
        }
      }

      ctx.textAlign = "center";
      const heightImgs = [null, s.scene.height1, s.scene.height2, s.scene.height3];
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          const h = cellHeight(s.heights, c, r);
          if (h <= 0) continue;
          const x = c * CELL;
          const y = r * CELL;
          const lift = h * 6;
          const himg = heightImgs[Math.min(3, h)];
          if (himg && himg.complete && himg.naturalWidth) {
            ctx.globalAlpha = 0.92;
            ctx.drawImage(himg, x - 4, y - 10 - lift, CELL + 8, CELL + 12);
            ctx.globalAlpha = 1;
          } else {
            // 後備：圓角礁岩台
            const cols = [
              null,
              ["rgba(40,90,105,0.7)", "rgba(100,180,195,0.75)"],
              ["rgba(50,110,125,0.75)", "rgba(130,205,220,0.8)"],
              ["rgba(120,90,40,0.75)", "rgba(255,220,140,0.85)"],
            ] as const;
            const pair = cols[h]!;
            ctx.fillStyle = pair[0];
            ctx.beginPath();
            ctx.ellipse(x + CELL / 2, y + CELL / 2 + 4 - lift * 0.3, CELL * 0.42, CELL * 0.28, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = pair[1];
            ctx.beginPath();
            ctx.ellipse(x + CELL / 2, y + CELL / 2 - 6 - lift * 0.5, CELL * 0.38, CELL * 0.26, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          if (workshopRef.current) {
            ctx.fillStyle = h === 3 ? "#fff4d2" : "#e9fbff";
            ctx.font = "bold 11px sans-serif";
            ctx.fillText(String(h), x + CELL / 2, y + 14 - lift);
          }
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
            // —— 未解鎖疆域：連片深海（高不透明，蓋住任何底圖網點）——
            const depth = 0.82 + rnd * 0.12;
            ctx.fillStyle = `rgba(${6 + rnd * 10 | 0}, ${22 + rnd * 18 | 0}, ${38 + rnd * 20 | 0}, ${depth})`;
            ctx.fillRect(x - 0.25, y - 0.25, CELL + 0.5, CELL + 0.5);

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
              if (coral && coral.complete && coral.naturalWidth > 8 && rnd < 0.55) {
                ctx.globalAlpha = 0.35 + rnd * 0.2;
                const sc = 0.85 + rnd2 * 0.25;
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
      ctx.textAlign = "center";
      ctx.font = "bold 11px sans-serif";
      const pulse = 0.85 + Math.sin(t * 2.2) * 0.1;
      entrancesRef.current.forEach((g, i) => {
        const x = g.c * CELL + CELL / 2;
        const y = g.r * CELL + CELL / 2;
        const ent = s.scene.entrance;
        // 光暈
        const grd = ctx.createRadialGradient(x, y, 4, x, y, CELL * 0.85);
        grd.addColorStop(0, "rgba(120, 220, 255, 0.35)");
        grd.addColorStop(1, "rgba(40, 120, 180, 0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, CELL * 0.9, 0, Math.PI * 2);
        ctx.fill();
        if (ent && ent.complete && ent.naturalWidth) {
          ctx.globalAlpha = pulse;
          ctx.drawImage(ent, x - CELL * 0.7, y - CELL * 0.7, CELL * 1.4, CELL * 1.4);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = "rgba(140, 230, 255, 0.8)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, CELL * 0.38, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#e8fbff";
        ctx.fillText(String(i + 1), x, y + 4);
      });
      exitsRef.current.forEach((g, i) => {
        const x = g.c * CELL + CELL / 2;
        const y = g.r * CELL + CELL / 2;
        const ex = s.scene.exit;
        const grd = ctx.createRadialGradient(x, y, 4, x, y, CELL * 0.85);
        grd.addColorStop(0, "rgba(255, 140, 180, 0.35)");
        grd.addColorStop(1, "rgba(180, 40, 90, 0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, CELL * 0.9, 0, Math.PI * 2);
        ctx.fill();
        if (ex && ex.complete && ex.naturalWidth) {
          ctx.globalAlpha = pulse;
          ctx.drawImage(ex, x - CELL * 0.7, y - CELL * 0.7, CELL * 1.4, CELL * 1.4);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = "rgba(255, 160, 190, 0.85)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, CELL * 0.38, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = "#ffe4ee";
        ctx.fillText(String(i + 1), x, y + 4);
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
        if (tw.sanctuary) {
          const pulse = 0.9 + Math.sin(t * 2) * 0.05;
          const R = CELL * 2.5;
          ctx.save();
          ctx.translate(tw.x, tw.y);
          // 建築基座（約 4 格視覺）
          ctx.fillStyle = "rgba(20, 40, 70, 0.92)";
          ctx.strokeStyle = "rgba(255, 220, 160, 0.75)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.roundRect?.(-R, -R, R * 2, R * 2, 12);
          if (!ctx.roundRect) {
            ctx.rect(-R, -R, R * 2, R * 2);
          }
          ctx.fill();
          ctx.stroke();
          // 內殿
          ctx.fillStyle = `rgba(255, 200, 140, ${0.2 * pulse})`;
          ctx.fillRect(-R * 0.55, -R * 0.55, R * 1.1, R * 1.1);
          ctx.fillStyle = "#ffe7c2";
          ctx.font = "bold 13px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("聖地", 0, -6);
          ctx.font = "10px sans-serif";
          ctx.fillStyle = "#9ad7ff";
          ctx.fillText(`主砲 Lv.${tw.hqCoreLv ?? 1}`, 0, 10);
          const prog = hqProgRef.current;
          ctx.fillText(prog.path ? HQ_PATH_META[prog.path].name : "未選路線", 0, 22);
          // 射程環
          ctx.beginPath();
          ctx.arc(0, 0, tw.range, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255, 210, 150, 0.15)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
          continue;
        }

        // 護衛單位
        for (const u of s.escorts) {
          const col = u.kind === "melee" ? "#ffb4a8" : u.kind === "ranged" ? "#a8e0ff" : "#b8f0c8";
          ctx.beginPath();
          ctx.arc(u.x, u.y, u.kind === "melee" ? 9 : 7, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.9;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.stroke();
          // hp bar
          const ratio = Math.max(0, u.hp / u.maxHp);
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(u.x - 10, u.y - 14, 20, 3);
          ctx.fillStyle = col;
          ctx.fillRect(u.x - 10, u.y - 14, 20 * ratio, 3);
        }

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
        const atkFrames = s.towerAtkFrames[tw.def] || [];
        const inAtk = tw.atkDur > 0 && tw.atkT < tw.atkDur && atkFrames.length > 0;
        const atkP = inAtk ? attackEase(tw.atkT / tw.atkDur) : 0;
        const atkIdx = inAtk ? attackFrameIndex(atkP, atkFrames.length) : 0;
        // 命中幀附近多一點前衝與放大
        const peak = inAtk ? Math.sin(Math.min(1, atkP / 0.58) * Math.PI) : 0;
        const bob = Math.sin(t * (hasAnim ? 2.2 : 2.8) + i) * (hasAnim ? 2.5 : 5) * (inAtk ? 0.35 : 1);
        const kick = tw.recoil > 0 ? tw.recoil / 0.28 : 0;
        const sh = tw.shake > 0 ? (Math.random() - 0.5) * 8 : 0;
        const lean = peak * 14 + kick * 10;
        const ox = Math.cos(tw.aim || 0) * lean + sh;
        const oy = Math.sin(tw.aim || 0) * lean;
        const breathe = hasAnim || inAtk ? 1 : 1 + Math.sin(t * 2.4 + i) * 0.05;
        const punch = 1 + peak * 0.14 + kick * 0.08;
        ctx.save();
        ctx.translate(tw.x + ox, tw.y + bob + oy);
        ctx.rotate(Math.sin(t * 1.5 + i * 0.7) * (hasAnim ? 0.02 : 0.04) + peak * 0.03);
        ctx.scale(punch * breathe, punch * breathe);
        // 腳底淡影（無圓框）
        ctx.beginPath();
        ctx.ellipse(0, 26, 16 + peak * 3, 5, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,0,0,${0.28 + peak * 0.12})`;
        ctx.fill();
        let img = s.images[tw.def];
        if (inAtk) {
          const fr = atkFrames[atkIdx];
          if (fr && fr.complete && fr.naturalWidth) img = fr;
        } else if (hasAnim) {
          const idx = pingIndex(frames.length, Math.floor(t * 6 + i));
          const fr = frames[idx];
          if (fr && fr.complete && fr.naturalWidth) img = fr;
        }
        if (img && img.complete && img.naturalWidth) {
          // 只顯示立繪，輕柔橢圓遮罩去掉殘餘方角
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(0, 2, 28, 30, 0, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, -28, -32, 56, 56);
          // 命中幀柔光一閃，強化出手感（小尺寸下仍可感知）
          if (inAtk && atkIdx === 2) {
            const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
            g.addColorStop(0, "rgba(255, 230, 180, 0.35)");
            g.addColorStop(0.55, "rgba(255, 160, 80, 0.12)");
            g.addColorStop(1, "rgba(255, 120, 40, 0)");
            ctx.fillStyle = g;
            ctx.fillRect(-28, -32, 56, 56);
          }
          ctx.restore();
        } else {
          ctx.fillStyle = def.color;
          ctx.beginPath();
          ctx.arc(0, 0, 14, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        // 瞄準指示改為細短光點，不畫粗槍管框
        ctx.save();
        ctx.translate(tw.x + ox, tw.y + bob + oy);
        ctx.rotate(tw.aim || 0);
        ctx.fillStyle = def.color;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.arc(22 - kick * 10, 0, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
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
      ctx.restore();
      // 螢幕暗角：增加景深、柔化邊緣
      const vig = ctx.createRadialGradient(
        VIEWW * 0.5,
        VIEWH * 0.5,
        Math.min(VIEWW, VIEWH) * 0.35,
        VIEWW * 0.5,
        VIEWH * 0.5,
        Math.max(VIEWW, VIEWH) * 0.72,
      );
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(2, 10, 20, 0.45)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, VIEWW, VIEWH);
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
      if (tileOfferRef.current && tileOfferRef.current.length && pickTemplateRef.current) {
        const gx = Math.floor(p.x / GRID);
        const gy = Math.floor(p.y / GRID);
        confirmPlaceTile(Math.floor(gx / TILE), Math.floor(gy / TILE));
        return;
      }
      const gx0 = Math.floor(p.x / GRID);
      const gy0 = Math.floor(p.y / GRID);
      // 路障模式優先：點地圖即放，不先選中塔
      if (stakeRef.current && phaseRef.current === "play") {
        const gx = gx0;
        const gy = gy0;
        if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return;
        if (!isCellOnBoard(boardRef.current, gx, gy)) {
          setHover("只能放在已解鎖地塊上");
          return;
        }
        if (gateHere(gx, gy)) {
          setHover("不能堵住出入口");
          return;
        }
        if (s.towers.some((t) => t.gx === gx && t.gy === gy)) {
          setHover("這格已有塔或路障");
          return;
        }
        if (s.blocked.has(cellKey(gx, gy))) {
          setHover("這格是地形／障礙，請點可走的路徑格");
          return;
        }
        if (goldRef.current < STAKE_COST) {
          setHover(`金幣不夠（需要 ${STAKE_COST}）`);
          return;
        }
        const next = new Set(s.blocked);
        next.add(cellKey(gx, gy));
        if (!commitBlocks(next)) {
          setHover("不能完全封死最短路，換一格試試");
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
          atkT: 0,
          atkDur: 0,
          hp: 240,
          maxHp: 240,
          shake: 0,
          stake: true,
          gx,
          gy,
          rateMul: 1,
          terrorT: 0,
          spent: STAKE_COST,
        });
        setHover("路障已放（可被近戰拆毀）· 妖潮改道");
        return;
      }
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
      const gx = gx0;
      const gy = gy0;
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
      const base = towerBookRef.current[id] ?? TOWERS[id];
      const diff = difficultyRef.current;
      const cost = Math.max(1, Math.round(base.cost * (diff.towerCostMul ?? 1)));
      const dmg = base.damage * (diff.towerDmgMul ?? 1);
      if (!canPlace(gx, gy)) {
        setHover("這格不能放塔");
        return;
      }
      if (goldRef.current < cost) {
        setHover("金幣不夠");
        return;
      }
      goldRef.current -= cost;
      setGold(goldRef.current);
      const bonus = rangeBonus(cellHeight(s.heights, gx, gy));
      s.towers.push({
        def: id,
        x: gx * GRID + GRID / 2,
        y: gy * GRID + GRID / 2,
        damage: dmg,
        cooldown: base.cooldown,
        range: base.range + bonus,
        cd: 0,
        level: 1,
        aim: 0,
        recoil: 0,
        atkT: 0,
        atkDur: 0,
        hp: 140,
        maxHp: 140,
        shake: 0,
        stake: false,
        gx,
        gy,
        rateMul: 1,
        terrorT: 0,
        spent: cost,
        targetMode: "auto",
        skills: [],
        skillShots: 0,
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


  function applyTileBoard(board: TileBoard) {
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
    const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
    commit?.(new Set(blocked));
  }

  function selectTileTemplate(id: string) {
    setPickTemplate(id);
    pickTemplateRef.current = id;
    setPickRot(0);
    pickRotRef.current = 0;
    const n = validPlacements(boardRef.current, id).length;
    setHover(n ? `已選「${TEMPLATE_BY_ID[id]?.name || id}」· 可放 ${n} 處 · 點地圖高亮格` : "此塊無法銜接，請換一塊或旋轉");
  }

  function rotatePickTile() {
    if (!pickTemplateRef.current) return;
    const next = ((pickRotRef.current + 1) % 4) as Rot;
    pickRotRef.current = next;
    setPickRot(next);
    setHover(`旋轉 ${next * 90}°`);
  }

  function confirmPlaceTile(tc: number, tr: number) {
    const id = pickTemplateRef.current;
    if (!id) {
      setHover("請先點選一塊模板");
      return;
    }
    let rot = pickRotRef.current;
    if (!canPlaceTile(boardRef.current, tc, tr, id, rot)) {
      const hit = validPlacements(boardRef.current, id).find((p) => p.tc === tc && p.tr === tr);
      if (!hit) {
        setHover("此格無法銜接道路");
        return;
      }
      rot = hit.rot;
      pickRotRef.current = rot;
      setPickRot(rot);
    }
    const next = placeTile(boardRef.current, tc, tr, id, rot);
    if (!next) {
      setHover("放置失敗");
      return;
    }
    applyTileBoard(next);
    setTileOffer(null);
    tileOfferRef.current = null;
    setPickTemplate(null);
    pickTemplateRef.current = null;
    pausedRef.current = false;
    setPaused(false);
    // 成功塑界：再凝一撮明潮砂
    mingSandRef.current += 1;
    setMingSand(mingSandRef.current);
    setHover(
      `已拼接「${TEMPLATE_BY_ID[id]?.name || id}」· 入口 ${entrancesRef.current.length} · 明潮砂 +1（${mingSandRef.current}）`,
    );
  }

  /** 單獨重骰某一格地塊選項，消耗明潮砂 */
  function rerollTileSlot(index: number) {
    if (!tileOffer || index < 0 || index >= tileOffer.length) return;
    if (mingSandRef.current < MING_SAND_REROLL_COST) {
      setHover(`明潮砂不足（需要 ${MING_SAND_REROLL_COST}）`);
      return;
    }
    const nextId = rerollOfferSlot(boardRef.current, tileOffer, index, runTileBias);
    if (!nextId) {
      setHover("沒有可替換的地塊");
      return;
    }
    if (nextId === tileOffer[index]) {
      setHover("重骰結果相同，明潮砂未扣除");
      return;
    }
    mingSandRef.current -= MING_SAND_REROLL_COST;
    setMingSand(mingSandRef.current);
    const next = tileOffer.slice();
    next[index] = nextId;
    tileOfferRef.current = next;
    setTileOffer(next);
    if (pickTemplateRef.current === tileOffer[index]) {
      selectTileTemplate(nextId);
    }
    setHover(`第 ${index + 1} 格重骰為「${TEMPLATE_BY_ID[nextId]?.name || nextId}」· 明潮砂 −${MING_SAND_REROLL_COST}`);
  }

  function skipTileOffer() {
    setTileOffer(null);
    tileOfferRef.current = null;
    setPickTemplate(null);
    pickTemplateRef.current = null;
    pausedRef.current = false;
    setPaused(false);
    setHover("已略過拼接，下一波即將開始");
  }

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
    // 每局新種子：可重現可改成固定數字；此處用時間混合難度字串
    {
      const base = Date.now() ^ (difficultyId || "").split("").reduce((a, c) => a + c.charCodeAt(0) * 17, 0);
      setTileRngSeed(base >>> 0);
      runTileBias.seed = undefined; // 已在全域 seed，bias 不再覆寫
    }
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
    const startG = difficultyRef.current.startGold ?? START_GOLD;
    goldRef.current = startG;
    livesRef.current = 20;
    mingSandRef.current = 0;
    setMingSand(0);
    setGold(startG);
    setLives(20);
    setWave(0);
    setSel(null);
    selRef.current = null;
    phaseRef.current = "play";
    setPhase("play");
    setTileOffer(null);
    tileOfferRef.current = null;

    // 依主選單選擇：地塊擴張 或 完整關卡／自訂地圖
    if (mapMode === "expand") {
      // 中央聖地 → 四向自動拼接（至少一條戰線）
      let board = seedBoard();
      board = bootstrapFrontiers(board, runTileBias);
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
      const fronts = paths?.length ?? 0;
      setActiveMap("潮汐擴張");
      setHover(`聖地已展開 · 戰線 ${Math.max(fronts, gates.entrances.length)} 條（至少 1 條）`);
      spawnSanctuaryTower();
    } else {
      // 完整地圖：使用目前 loadLayout 已寫入的 mapRef／入口出口；若尚未載入則找 selectedLevelId
      const all = [...presetMaps(), ...savedMaps];
      const layout = all.find((m) => m.id === selectedLevelId) ?? all[0];
      if (layout) {
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
          // 後備：仍用擴張模式，避免卡死
          setHover("所選地圖路線不通，改以潮汐擴張開局");
          let board = seedBoard();
          board = bootstrapFrontiers(board, runTileBias);
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
        } else {
          setActiveMap(layout.name);
          // 完整關卡不啟用地塊擴張（board 標記為「已滿圖」避免誤觸發）
          boardRef.current = { placed: [], playerBlocked: new Set() };
        }
      }
    }

    setWorkshop(false);
    setPaused(false);
    pausedRef.current = false;
    const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
    commit?.(new Set(mapRef.current));
    const c = canvasRef.current as HTMLCanvasElement & { __begin?: () => void };
    c.__begin?.();
  }

  function selectLevel(id: string, mode: "expand" | "layout") {
    setSelectedLevelId(id);
    setMapMode(mode);
    if (mode === "expand") {
      setActiveMap("潮汐擴張");
      setHover("開局：中央聖地＋裂口，每 3 波可拼接新地塊");
      return;
    }
    const layout = [...presetMaps(), ...savedMaps].find((m) => m.id === id);
    if (!layout) return;
    loadLayout(layout);
    setHover(`已選關卡「${layout.name}」· 按開始守城`);
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
        targetMode: t.targetMode ?? "auto",
        skills: t.skills ?? [],
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
        targetMode?: TargetMode;
        skills?: string[];
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
        atkT: 0,
        atkDur: 0,
        hp: t.hp,
        maxHp: t.maxHp,
        shake: 0,
        stake: !!t.stake,
        gx: t.gx,
        gy: t.gy,
        rateMul: 1,
        terrorT: 0,
        spent: t.stake ? STAKE_COST : (TOWERS[t.def]?.cost ?? 50) * Math.max(1, t.level || 1),
        targetMode: t.targetMode ?? "auto",
        skills: t.skills ?? [],
        skillShots: 0,
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


  function queueSkillOffer(towerIndex: number, level: number) {
    const tw = sim.current.towers[towerIndex];
    if (!tw || tw.stake) return;
    const choices = rollSkillChoices(tw.skills, level, SKILL_CHOICE_COUNT);
    if (!choices.length) {
      setHover("技能池已空，無新技能可選");
      return;
    }
    const offer = { towerIndex, level, choices };
    if (skillOfferRef.current) {
      skillOfferQueueRef.current.push(offer);
    } else {
      setSkillOffer(offer);
      pausedRef.current = true;
      setPaused(true);
    }
  }

  function pickSkillChoice(skillId: string) {
    if (!skillOffer) return;
    const { towerIndex } = skillOffer;
    const tw = sim.current.towers[towerIndex];
    if (!tw) {
      setSkillOffer(null);
      return;
    }
    if (!tw.skills) tw.skills = [];
    if (!tw.skills.includes(skillId)) {
      tw.skills.push(skillId);
      // 被動：只對「新技能」套一次（避免重複乘）
      const def = SKILL_BY_ID[skillId];
      if (def) {
        for (const e of def.effects) {
          if (e.type === "dmgMul") tw.damage *= e.value;
          if (e.type === "cooldownMul") tw.cooldown = Math.max(0.12, tw.cooldown * e.value);
          if (e.type === "rangeAdd") tw.range += e.value;
        }
      }
      setHover(`習得「${skillLabelShort(skillId)}」`);
    }
    const next = skillOfferQueueRef.current.shift() || null;
    setSkillOffer(next);
    if (!next) {
      pausedRef.current = false;
      setPaused(false);
    }
    setSel(towerIndex);
  }

  function upgrade(kind: "dmg" | "rate") {
    const idx = selRef.current ?? sel;
    if (idx === null) return;
    const tw = sim.current.towers[idx];
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
    // 升級強化耐久：最大生命 +18% 並回一部分血
    const before = tw.maxHp;
    tw.maxHp = Math.round(tw.maxHp * 1.18 + 12);
    tw.hp = Math.min(tw.maxHp, tw.hp + (tw.maxHp - before) + 20);
    setHover(
      kind === "dmg"
        ? `傷害提升 · 生命 ${Math.round(tw.hp)}/${tw.maxHp}（−${cost}）`
        : `射速提升 · 生命 ${Math.round(tw.hp)}/${tw.maxHp}（−${cost}）`,
    );
    setSel(idx);
    if (isSkillLevel(tw.level) && idx != null) {
      queueSkillOffer(idx, tw.level);
    }
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

  
  function spawnSanctuaryTower() {
    const board = boardRef.current;
    const hq = board.placed.find((p) => p.templateId === "hq");
    if (!hq) return;
    // 去掉舊聖地
    sim.current.towers = sim.current.towers.filter((t) => !t.sanctuary);
    sim.current.escorts = [];
    const originC = hq.tc * TILE;
    const originR = hq.tr * TILE;
    // 建築中心約在 tile 內 9.5, 9.5 格
    const gx = originC + 9;
    const gy = originR + 9;
    const stats = sanctuaryStats({ hqCoreLv: 1 });
    sim.current.towers.push({
      def: 0,
      x: gx * GRID + GRID / 2,
      y: gy * GRID + GRID / 2,
      damage: stats.damage,
      cooldown: stats.cooldown,
      range: stats.range,
      cd: 0,
      level: 1,
      aim: 0,
      recoil: 0,
      atkT: 0,
      atkDur: 0,
      hp: 800,
      maxHp: 800,
      shake: 0,
      stake: false,
      gx,
      gy,
      rateMul: 1,
      terrorT: 0,
      spent: 0,
      targetMode: "auto",
      skills: [],
      skillShots: 0,
      sanctuary: true,
      hqCoreLv: 1,
      escortCd: 3,
    });
    hqProgRef.current = defaultHqProgress();
    bumpHqUi();
  }

  function sell() {
    const idx = selRef.current ?? sel;
    if (idx === null) return;
    const tw = sim.current.towers[idx];
    if (!tw) return;
    if (tw.sanctuary) {
      setHover("聖地不可出售，請用兵裝介面強化");
      return;
    }
    if (tw.stake) {
      const next = new Set(sim.current.blocked);
      next.delete(cellKey(tw.gx, tw.gy));
      const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
      commit?.(next);
      const refund = sellRefund(tw.spent || STAKE_COST);
      goldRef.current += refund;
      setGold(goldRef.current);
      sim.current.towers.splice(idx, 1);
      selRef.current = null;
      setSel(null);
      setHover(`路障已拆除 +${refund}`);
      return;
    }
    const refund = sellRefund(tw.spent || TOWERS[tw.def].cost);
    goldRef.current += refund;
    setGold(goldRef.current);
    sim.current.towers.splice(idx, 1);
    selRef.current = null;
    setSel(null);
    setHover(`賣出 +${refund}`);
  }


  function upgradeSanctuaryCore() {
    const idx = selRef.current ?? sel;
    if (idx === null) return;
    const tw = sim.current.towers[idx];
    if (!tw?.sanctuary) return;
    const lv = tw.hqCoreLv ?? 1;
    const cost = coreUpgradeCost(lv);
    if (goldRef.current < cost) {
      setHover(`金幣不足（主砲升級需要 ${cost}）`);
      return;
    }
    goldRef.current -= cost;
    setGold(goldRef.current);
    tw.hqCoreLv = lv + 1;
    tw.level = tw.hqCoreLv;
    tw.spent = (tw.spent || 0) + cost;
    const st = sanctuaryStats(tw);
    tw.damage = st.damage;
    tw.range = st.range;
    tw.cooldown = st.cooldown;
    tw.maxHp = Math.round(tw.maxHp * 1.1);
    tw.hp = Math.min(tw.maxHp, tw.hp + 30);
    setHover(`聖地主砲 → Lv.${tw.hqCoreLv}（−${cost}）· 主線仍以護衛路線為核心`);
    setSel(idx);
  }




  function compositionForSquad(p: HqProgress): EscortKind[] {
    const kinds: EscortKind[] = [];
    let rangedLeft = p.ranged ? p.mixRanged : 0;
    let healLeft = p.healer ? p.mixHealer : 0;
    for (let i = 0; i < p.squad; i++) {
      if (rangedLeft > 0) {
        kinds.push("ranged");
        rangedLeft--;
      } else if (healLeft > 0) {
        kinds.push("healer");
        healLeft--;
      } else kinds.push("melee");
    }
    return kinds;
  }

  function deployEscortSquad(force = false) {
    if (phaseRef.current !== "play") return;
    const s = sim.current;
    const hq = s.towers.find((t) => t.sanctuary);
    if (!hq) return;
    const p = hqProgRef.current;
    if (!force) {
      if ((hq.escortCd ?? 0) > 0) return;
    }
    if (goldRef.current < HQ_ESCORT_COST) {
      if (force) setHover(`護衛動員需要 ${HQ_ESCORT_COST} 金`);
      return;
    }
    // 威脅：離聖地最近的怪
    let threat: Enemy | null = null;
    let bestD = 1e15;
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      const pos = posAt(e.dist, e.route);
      const d = Math.hypot(pos.x - hq.x, pos.y - hq.y);
      if (d < bestD) {
        bestD = d;
        threat = e;
      }
    }
    if (!threat) {
      if (force) setHover("戰場無威脅，暫不派出護衛");
      return;
    }
    const route = threat.route;
    const live = routes[route] ?? routes[0];
    if (!live) return;
    // 在威脅與出口之間偏本陣：取 threat.dist 再往出口方向一點
    const baseDist = Math.min(live.len - 20, Math.max(40, threat.dist + 40));
    goldRef.current -= HQ_ESCORT_COST;
    setGold(goldRef.current);
    hq.escortCd = p.deployCd;
    const kinds = compositionForSquad(p);
    kinds.forEach((kind, i) => {
      const dist = Math.min(live.len - 10, baseDist + i * 18);
      const pos = posAt(dist, route);
      const maxHp = kind === "melee" ? p.meleeHp : kind === "ranged" ? Math.round(p.meleeHp * 0.55) : Math.round(p.meleeHp * 0.65);
      s.escorts.push({
        id: __escortSeq++,
        kind,
        x: pos.x,
        y: pos.y,
        hp: maxHp,
        maxHp,
        route,
        dist,
        speed: kind === "melee" ? 42 : kind === "ranged" ? 38 : 36,
        contactT: 0,
        shootCd: 0.4 * i,
        healCd: 1.2,
      });
    });
    setHover(`護衛出動 ×${kinds.length}（${HQ_PATH_META[p.path || "blade"]?.name || "未選路線"}）· −${HQ_ESCORT_COST} 金`);
  }

  function lockHqPath(path: HqPathId) {
    const entry = HQ_PATH_LOCK.find((x) => x.path === path);
    if (!entry) return;
    const p = hqProgRef.current;
    if (p.path) {
      setHover("本場已選定聖地路線，無法更改");
      return;
    }
    if (goldRef.current < entry.cost) {
      setHover(`需要 ${entry.cost} 金鎖定路線`);
      return;
    }
    goldRef.current -= entry.cost;
    setGold(goldRef.current);
    p.path = path;
    if (path === "bow") {
      p.ranged = true;
      p.mixRanged = 1;
    }
    if (path === "tide") {
      p.healer = true;
      p.mixHealer = 1;
    }
    bumpHqUi();
    setHover(`聖地路線鎖定：${entry.name} · 一場僅此一路`);
  }

  function pickHqTier(pick: HqPick) {
    const p = hqProgRef.current;
    if (!p.path) {
      setHover("請先鎖定一條聖地路線");
      return;
    }
    if (p.tier >= 3) {
      setHover("聖地路線已達最終型");
      return;
    }
    const needTier = p.tier + 1;
    const opts = hqTierChoices(p.path, needTier);
    if (!opts.some((o) => o.id === pick.id)) {
      setHover("選項與當前階不符");
      return;
    }
    if (goldRef.current < pick.cost) {
      setHover(`需要 ${pick.cost} 金`);
      return;
    }
    goldRef.current -= pick.cost;
    setGold(goldRef.current);
    pick.apply(p);
    p.tier = needTier;
    bumpHqUi();
    setHover(`聖地「${pick.name}」完成（${p.tier}/3）`);
  }

  // 快捷鍵：選塔 / 升級 / 賣出 / 取消 / 暫停
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = ev.key;
      if (key === "Escape") {
        setPick(null);
        pickRef.current = null;
        setSel(null);
        selRef.current = null;
        stakeRef.current = false;
        setHover("已取消選取");
        return;
      }
      if (key === "p" || key === "P") {
        if (phaseRef.current !== "play") return;
        const next = !pausedRef.current;
        pausedRef.current = next;
        setPaused(next);
        setHover(next ? "已暫停 [P]" : "繼續 [P]");
        return;
      }
      if (key === "s" || key === "S") {
        if (selRef.current !== null) sell();
        return;
      }
      if (key === "d" || key === "D") {
        if (selRef.current !== null) upgrade("dmg");
        return;
      }
      if (key === "f" || key === "F") {
        if (selRef.current !== null) upgrade("rate");
        return;
      }
      // 1-9,0,-,= → 塔 0..11
      const map: Record<string, number> = {
        "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6, "8": 7, "9": 8, "0": 9, "-": 10, "=": 11,
      };
      if (key in map) {
        const id = map[key];
        if (id >= TOWERS.length) return;
        const cost = Math.max(1, Math.round(TOWERS[id].cost * (getDifficulty(difficultyId).towerCostMul ?? 1)));
        if (phaseRef.current === "play" && goldRef.current < cost) {
          setHover(`金幣不足：${TOWERS[id].name} 需要 ${cost}`);
          return;
        }
        setPick(id);
        pickRef.current = id;
        setSel(null);
        selRef.current = null;
        setHover(`已選 ${TOWERS[id].name} [${key}] · 點地圖放置`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // sell/upgrade close over latest sel via refs + state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [difficultyId]);

  const selected = sel !== null ? sim.current.towers[sel] : null;
  const selectedDef: TowerDef | null = selected ? TOWERS[selected.def] : null;

  return (
    <div className="td-shell">
      <header className="mx-auto flex max-w-[1320px] items-end justify-between px-4 pt-4">
        <div>
          <p className="text-xs tracking-[0.28em] text-[#8ec8ee]">UNDERWATER WARD</p>
          <h1 className="font-['Cormorant_Garamond'] text-4xl leading-none text-[#ffe7f1]">狐仙塔防</h1>
        </div>
        <p className="hidden text-sm text-[#9ec4de] sm:block">滾輪縮放 · 拖曳平移 · [1-0-=]選塔 · [D/F]升級 · [S]賣出 · [Esc]取消 · [P]暫停</p>
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
          {phase === "play" && skillOffer && (
            <div className="overlay" style={{ maxHeight: "90vh", overflowY: "auto" }}>
              <h2>塔覺醒 · 三選一</h2>
              <p className="mb-2 max-w-md text-sm text-[#c5dff2]">
                {sim.current.towers[skillOffer.towerIndex]
                  ? (towerBook[sim.current.towers[skillOffer.towerIndex].def]?.name || "塔")
                  : "塔"}{" "}
                升至 Lv.{skillOffer.level} — 選擇一項技能（效果立即生效）
              </p>
              <div className="flex max-w-lg flex-col gap-2">
                {skillOffer.choices.map((c) => (
                  <button
                    key={c.id}
                    className="btn"
                    style={{ borderColor: c.color, textAlign: "left" }}
                    onClick={() => pickSkillChoice(c.id)}
                  >
                    <b style={{ color: c.color }}>{c.name}</b>
                    <span className="mt-0.5 block text-xs font-normal text-[#c5dff2]">{c.desc}</span>
                    <span className="text-[10px] text-[#8eb6d4]">
                      {c.tier === "high" ? "高階" : c.tier === "mid" ? "中階" : "低階"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {phase === "play" && tileOffer && tileOffer.length > 0 && (
            <div
              className="overlay"
              style={{
                pointerEvents: "none",
                background: "transparent",
                justifyContent: "flex-start",
                paddingTop: 12,
              }}
            >
              <div
                style={{
                  pointerEvents: "auto",
                  background: "rgba(8,20,36,0.92)",
                  borderRadius: 12,
                  padding: 16,
                  maxWidth: 420,
                }}
              >
              <h2>疆域擴張 · 地塊拼接</h2>
              <p className="mb-2 max-w-md text-sm text-[#c5dff2]">
                第 {wave} 波結束。選模板 → 旋轉 → 地圖上移入高亮格可預覽道路，再點放。三格可分開重骰。
              </p>
              <p className="mb-2 text-xs text-[#9ad7ff]">
                明潮砂 <b className="text-[#ffe08a]">{mingSand}</b>
                <span className="text-[#8eb6d4]">（塑界潮息凝成的細砂；重骰一格消耗 {MING_SAND_REROLL_COST}）</span>
              </p>
              <div className="mb-2 flex flex-wrap justify-center gap-3">
                {tileOffer.map((id, index) => {
                  const nPlace = validPlacements(boardRef.current, id).length;
                  const rotShow = pickTemplate === id ? pickRot : (0 as Rot);
                  const tpl = TEMPLATE_BY_ID[id];
                  const rt = tpl ? rotatedTemplate(tpl, rotShow) : null;
                  return (
                    <div key={`${id}-${index}`} className="flex flex-col items-center gap-1">
                      <button
                        type="button"
                        className={"btn" + (pickTemplate === id ? "" : " ghost")}
                        style={{ minWidth: 108, padding: "8px 10px" }}
                        onClick={() => selectTileTemplate(id)}
                      >
                        <b className="block text-sm">{tpl?.name ?? id}</b>
                        <span className="block text-[10px] text-[#9ec4de]">
                          {nPlace ? `可銜接 ${nPlace} 處` : "目前無法銜接"}
                        </span>
                        {rt && (
                          <span
                            className="mt-1 inline-grid gap-px rounded border border-[#3a6080] bg-[#061018] p-0.5"
                            style={{ gridTemplateColumns: "repeat(8, 5px)" }}
                            aria-hidden
                          >
                            {Array.from({ length: 64 }, (_, i) => {
                              const r = Math.floor(i / 8);
                              const c = i % 8;
                              const br = Math.min(TILE - 1, Math.floor((r / 8) * TILE));
                              const bc = Math.min(TILE - 1, Math.floor((c / 8) * TILE));
                              const blocked = rt.blocked[br][bc];
                              return (
                                <span
                                  key={i}
                                  style={{
                                    width: 5,
                                    height: 5,
                                    background: blocked ? "#2a4058" : "#7ec8e8",
                                  }}
                                />
                              );
                            })}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 11, padding: "4px 8px" }}
                        disabled={mingSand < MING_SAND_REROLL_COST}
                        onClick={() => rerollTileSlot(index)}
                        title={`消耗 ${MING_SAND_REROLL_COST} 明潮砂，只重骰這一格`}
                      >
                        重骰此格
                      </button>
                    </div>
                  );
                })}
              </div>
              {pickTemplate && (
                <div className="mb-2 flex flex-wrap justify-center gap-2">
                  <button className="btn ghost" onClick={rotatePickTile}>
                    旋轉 {pickRot * 90}°
                  </button>
                  <span className="self-center text-xs text-[#9ad7ff]">
                    可放 {validPlacements(boardRef.current, pickTemplate).filter((x) => x.rot === pickRot).length} 格 · 移入地圖預覽道路後點放
                  </span>
                </div>
              )}
              <button className="btn ghost" onClick={skipTileOffer}>
                略過，繼續戰鬥
              </button>
              </div>
            </div>
          )}
          {phase === "play" && paused && !(tileOffer && tileOffer.length) && !skillOffer && (
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
            <div className="overlay" style={{ maxHeight: "90vh", overflowY: "auto" }}>
              <h2>{phase === "win" ? "潮退，聖地仍在" : phase === "lose" ? "結界破碎" : "狐仙結界"}</h2>
              <p className="mb-3 max-w-lg text-sm text-[#c5dff2]">
                {phase === "ready"
                  ? "先選關卡或自訂地圖，再開始守城。也可進工房編輯後保存，出現在下方清單。"
                  : phase === "win"
                    ? "十二波妖潮已被擋下。"
                    : "生命歸零。重新布置結界再試一次。"}
              </p>
              {phase === "ready" && (
                <div className="mb-4 w-full max-w-lg text-left">
                  <p className="mb-1 text-xs tracking-wide text-[#8ec8ee]">選擇開局</p>
                  <div className="mb-2 flex flex-wrap gap-2">
                    <button
                      className={"btn" + (selectedLevelId === "mode-expand" ? "" : " ghost")}
                      onClick={() => selectLevel("mode-expand", "expand")}
                      title="從小地圖開始，每 3 波拼接新地塊"
                    >
                      潮汐擴張（推薦）
                    </button>
                  </div>
                  <p className="mb-1 mt-2 text-xs tracking-wide text-[#8ec8ee]">預設關卡</p>
                  <div className="mb-2 flex flex-wrap gap-2">
                    {presetMaps().map((m) => (
                      <button
                        key={m.id}
                        className={"btn" + (selectedLevelId === m.id ? "" : " ghost")}
                        onClick={() => selectLevel(m.id, "layout")}
                      >
                        {m.name.replace(/^關卡[·・]?/, "")}
                      </button>
                    ))}
                  </div>
                  {savedMaps.length > 0 && (
                    <>
                      <p className="mb-1 mt-2 text-xs tracking-wide text-[#8ec8ee]">自訂地圖</p>
                      <div className="mb-2 flex flex-wrap gap-2">
                        {savedMaps.map((m) => (
                          <button
                            key={m.id}
                            className={"btn" + (selectedLevelId === m.id ? "" : " ghost")}
                            onClick={() => selectLevel(m.id, "layout")}
                          >
                            {m.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <p className="mt-1 text-xs text-[#9ec4de]">
                    目前：<span className="text-[#ffe7f1]">{activeMap}</span>
                    {mapMode === "expand" ? " · 地塊拼接模式" : " · 完整地圖"}
                  </p>
                  <p className="mb-1 mt-3 text-xs tracking-wide text-[#8ec8ee]">難度</p>
                  <div className="mb-1 flex flex-wrap gap-2">
                    {diffList.map((d) => (
                      <button
                        key={d.id}
                        className={"btn" + (difficultyId === d.id ? "" : " ghost")}
                        onClick={() => {
                          setDifficultyId(d.id);
                          difficultyRef.current = d;
                          setHover(
                            `${d.label} · 怪血×${d.enemyHpMul} · 塔傷×${d.towerDmgMul} · 金幣${d.startGold}`,
                          );
                        }}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-[#9ec4de]">
                    怪血 ×{getDifficulty(difficultyId).enemyHpMul} · 塔傷 ×{getDifficulty(difficultyId).towerDmgMul} · 開局 {getDifficulty(difficultyId).startGold} 金
                  </p>
                </div>
              )}
              <button className="btn" onClick={start}>
                {phase === "ready" ? (endless ? "開始無盡" : "開始守城") : "重新開始"}
              </button>
              {phase === "ready" && (
                <div className="mt-3 flex flex-wrap justify-center gap-2">
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
                setStaking((v) => {
                  const next = !v;
                  stakeRef.current = next;
                  setHover(
                    next
                      ? `路障模式：點可走路徑放置（${STAKE_COST} 金，可被近戰拆毀）`
                      : "已關閉路障模式",
                  );
                  return next;
                });
                setPick(null);
                pickRef.current = null;
              }}
              disabled={phase !== "play"}
            >
              {staking ? "路障中…" : `路障 ${STAKE_COST}`}
            </button>
          </div>
          <div className="mb-2 flex gap-2">
            <button
              className={"btn ghost flex-1" + (autoUpgrade !== "off" ? " on" : "")}
              onClick={() => {
                const order: AutoUpgradeMode[] = ["off", "smart", "dmg", "rate"];
                const next = order[(order.indexOf(autoUpgrade) + 1) % order.length];
                setAutoUpgrade(next);
                autoUpgradeRef.current = next;
                setHover(
                  next === "off"
                    ? "已關閉自動升級"
                    : `${AUTO_UPGRADE_LABEL[next]}（保留 ${AUTO_UPGRADE_RESERVE} 金，最高 Lv.${AUTO_UPGRADE_MAX_LEVEL}）`,
                );
              }}
              disabled={phase !== "play"}
              title="循環：關 → 智能 → 傷害 → 射速"
            >
              {AUTO_UPGRADE_LABEL[autoUpgrade]}
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
          <p className="mb-2 min-h-5 text-xs text-[#ffd7a8]">{hover || "提示：數字選塔，點地圖放置；點塔可升級/賣出"}</p>
          <p className="mb-2 text-[10px] leading-4 text-[#6a8eaa]">[1-9,0,-,=] 選塔 · [D]/[F] 升級 · [S] 賣出 · [Esc] 取消 · [P] 暫停</p>
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
          {workshop && (
            <div className="mb-3 max-h-80 overflow-auto rounded-xl border border-[#ffd2a855] bg-[#1a1428cc] p-2 text-xs leading-6">
              <b className="text-[#ffd2a8]">數值工房 · 怪物</b>
              <div className="my-1 flex flex-wrap gap-1">
                {bestiary.map((m, i) => (
                  <button
                    key={m.name + i}
                    className={"btn ghost" + (editMob === i ? " on" : "")}
                    style={{ color: m.color }}
                    onClick={() => setEditMob(i)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
              {bestiary[editMob] && (
                <div className="grid grid-cols-2 gap-1">
                  {(
                    [
                      ["hp", "生命"],
                      ["speed", "移速"],
                      ["gold", "金幣"],
                      ["r", "半徑"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between gap-1">
                      <span>{label}</span>
                      <input
                        className="w-16 rounded bg-[#08131f] px-1 text-right text-[#e7f6ff]"
                        type="number"
                        value={bestiary[editMob][key] as number}
                        onChange={(ev) => {
                          const v = Number(ev.target.value);
                          setBestiary((prev) => {
                            const next = prev.map((m, i) => (i === editMob ? { ...m, [key]: v } : m));
                            bestiaryRef.current = next;
                            return next;
                          });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              <b className="mt-2 block text-[#9ad7ff]">數值工房 · 塔</b>
              <div className="my-1 flex flex-wrap gap-1">
                {towerBook.map((t, i) => (
                  <button
                    key={t.id}
                    className={"btn ghost" + (editTower === i ? " on" : "")}
                    style={{ color: t.color }}
                    onClick={() => setEditTower(i)}
                  >
                    {t.name.replace("狐仙", "")}
                  </button>
                ))}
              </div>
              {towerBook[editTower] && (
                <div className="grid grid-cols-2 gap-1">
                  {(
                    [
                      ["cost", "造價"],
                      ["damage", "傷害"],
                      ["cooldown", "冷卻"],
                      ["range", "射程"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between gap-1">
                      <span>{label}</span>
                      <input
                        className="w-16 rounded bg-[#08131f] px-1 text-right text-[#e7f6ff]"
                        type="number"
                        step={key === "cooldown" ? 0.05 : 1}
                        value={towerBook[editTower][key] as number}
                        onChange={(ev) => {
                          const v = Number(ev.target.value);
                          setTowerBook((prev) => {
                            const next = prev.map((t, i) => (i === editTower ? { ...t, [key]: v } : t));
                            towerBookRef.current = next;
                            return next;
                          });
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              <b className="mt-2 block text-[#c9a0ff]">存成難度檔</b>
              <div className="mt-1 flex flex-wrap gap-1">
                <input
                  className="w-24 rounded bg-[#08131f] px-1 text-[#e7f6ff]"
                  value={diffName}
                  maxLength={12}
                  onChange={(e) => setDiffName(e.target.value)}
                  aria-label="難度名稱"
                />
                <button
                  className="btn ghost"
                  onClick={() => {
                    const base = getDifficulty(difficultyId);
                    const id = `custom-${Date.now()}`;
                    const profile: DifficultyProfile = {
                      ...base,
                      id,
                      label: diffName.trim() || "自訂",
                      builtin: false,
                    };
                    upsertCustomDifficulty(profile);
                    setDiffList(allDifficulties());
                    setDifficultyId(id);
                    difficultyRef.current = profile;
                    setHover(`已保存難度「${profile.label}」`);
                  }}
                >
                  保存倍率
                </button>
                <button
                  className="btn ghost"
                  onClick={() => {
                    setBestiary(stockBestiary());
                    bestiaryRef.current = stockBestiary();
                    const tb = TOWERS.map((t) => ({ ...t }));
                    setTowerBook(tb);
                    towerBookRef.current = tb;
                    setHover("已還原怪物／塔基準數值");
                  }}
                >
                  還原數值
                </button>
              </div>
              <p className="mt-1 text-[10px] text-[#8eb6d4]">
                怪物／塔數值立即生效；「保存倍率」把目前難度倍率存成可選檔。建議先用「普通」試平衡。
              </p>
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
          {selected && selected.sanctuary && (
            <div className="mb-3 rounded-xl border border-[#ffe08a66] bg-[#1a1420cc] p-2 text-xs text-[#e7f6ff]">
              <b className="text-[#ffe08a]">聖地 · 本陣與護衛</b>
              <div className="mt-1 text-[#c5dff2]">
                主砲 Lv.{selected.hqCoreLv ?? 1} · 傷 {selected.damage.toFixed(0)} · 護衛CD{" "}
                {Math.max(0, selected.escortCd ?? 0).toFixed(1)}s · 場上 {sim.current.escorts.length}
              </div>
              <div className="mt-1 text-[#9ec4de]">
                編制 {hqProgRef.current.squad} · 間隔 {hqProgRef.current.deployCd.toFixed(0)}s · 動員 {HQ_ESCORT_COST} 金／次（自動週期）
              </div>
              <div className="mt-2 flex gap-1">
                <button className="btn ghost" style={{ flex: 1, fontSize: 11 }} onClick={() => deployEscortSquad(true)}>
                  立即動員
                </button>
                <button
                  className="btn"
                  style={{ flex: 1, fontSize: 11 }}
                  disabled={gold < coreUpgradeCost(selected.hqCoreLv ?? 1)}
                  onClick={upgradeSanctuaryCore}
                >
                  主砲 {coreUpgradeCost(selected.hqCoreLv ?? 1)}
                </button>
              </div>
              {!hqProgRef.current.path ? (
                <div className="mt-2">
                  <p className="text-[10px] text-[#ffd27a]">鎖定本場唯一路線（三選一，不可更改）</p>
                  {HQ_PATH_LOCK.map((x) => (
                    <button
                      key={x.path}
                      className="btn ghost mt-1 w-full text-left"
                      style={{ fontSize: 11, borderColor: HQ_PATH_META[x.path].color }}
                      disabled={gold < x.cost}
                      onClick={() => lockHqPath(x.path)}
                    >
                      <b style={{ color: HQ_PATH_META[x.path].color }}>{x.name}</b>
                      <span className="block text-[10px] text-[#9ec4de]">{x.desc}</span>
                      <span className="text-[10px] text-[#ffd27a]">{x.cost} 金</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-2">
                  <p className="text-[10px]" style={{ color: HQ_PATH_META[hqProgRef.current.path].color }}>
                    {HQ_PATH_META[hqProgRef.current.path].name} · {HQ_PATH_META[hqProgRef.current.path].tag} · 進度{" "}
                    {hqProgRef.current.tier}/3
                  </p>
                  {hqProgRef.current.tier < 3 ? (
                    hqTierChoices(hqProgRef.current.path, hqProgRef.current.tier + 1).map((opt) => (
                      <button
                        key={opt.id}
                        className="btn ghost mt-1 w-full text-left"
                        style={{ fontSize: 11 }}
                        disabled={gold < opt.cost}
                        onClick={() => pickHqTier(opt)}
                      >
                        <b>{opt.name}</b>
                        <span className="block text-[10px] text-[#9ec4de]">{opt.desc}</span>
                        <span className="text-[10px] text-[#ffd27a]">{opt.cost} 金</span>
                      </button>
                    ))
                  ) : (
                    <p className="mt-1 text-[10px] text-[#b8f0c8]">最終型已成 · 依靠週期護衛與主砲守線</p>
                  )}
                </div>
              )}
            </div>
          )}
          {selected && selectedDef && !selected.stake && !selected.sanctuary && (
            <div className="mb-3 rounded-xl border border-[#ff9ec455] bg-[#2a1630aa] p-2 text-xs leading-5">
              <b style={{ color: selectedDef.color }}>{selectedDef.name}</b> Lv.{selected.level}
              <div>特性：{selectedDef.trait}</div>
              <div>
                傷害 {Math.round(selected.damage)} · 射速 {(1 / selected.cooldown).toFixed(2)}/秒 · 射程 {Math.round(selected.range)}
                {cellHeight(sim.current.heights, selected.gx, selected.gy) > 0
                  ? `（高地 +${cellHeight(sim.current.heights, selected.gx, selected.gy) * 30}）`
                  : ""}
              </div>
              <div className="mt-1 text-[11px] leading-5 text-[#ffd2a8]">
                <b>覺醒</b>
                {selected.skills && selected.skills.length > 0 ? (
                  <ul className="mt-0.5 list-none pl-0">
                    {selected.skills.map((id) => {
                      const sk = SKILL_BY_ID[id];
                      return (
                        <li key={id} style={{ color: sk?.color || "#ffd2a8" }}>
                          {sk ? `${sk.name}：${sk.desc}` : id}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <span className="text-[#8eb6d4]"> — 每 5 級三選一（從技能池抽取）</span>
                )}
              </div>
              <div className="mt-2 text-[11px] text-[#b7ddf5]">鎖定優先</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(["auto", "first", "last", "nearest", "farthest", "strongest", "weakest"] as TargetMode[]).map((m) => {
                  const cur = selected.targetMode ?? "auto";
                  const effective =
                    m === "auto"
                      ? TARGET_MODE_LABEL[defaultTargetMode(selectedDef.special)]
                      : TARGET_MODE_LABEL[m];
                  return (
                    <button
                      key={m}
                      className={"btn ghost" + (cur === m ? " on" : "")}
                      title={m === "auto" ? `實際：${TARGET_MODE_LABEL[defaultTargetMode(selectedDef.special)]}` : TARGET_MODE_LABEL[m]}
                      onClick={() => {
                        const tw = sim.current.towers[sel!];
                        if (!tw || tw.stake) return;
                        tw.targetMode = m;
                        setSel(sel);
                        setHover(
                          `${selectedDef.name} 鎖定：${TARGET_MODE_LABEL[m]}${
                            m === "auto" ? `（${TARGET_MODE_LABEL[defaultTargetMode(selectedDef.special)]}）` : ""
                          }`,
                        );
                      }}
                    >
                      {m === "auto" ? "預設" : TARGET_MODE_LABEL[m].slice(0, 4)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-[#8eb6d4]">
                目前有效：
                {TARGET_MODE_LABEL[
                  resolveTargetMode(selected.targetMode, selectedDef.special)
                ]}
              </p>
              <p className="mt-1 text-[11px] text-[#b7ddf5]">
                約 {(selected.damage / Math.max(0.12, selected.cooldown / (selected.rateMul || 1))).toFixed(1)} 傷/秒
                · 退款 {sellRefund(selected.spent || selectedDef.cost)}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  className="btn ghost flex-1"
                  disabled={gold < upgradeCost("dmg", selected.level)}
                  onClick={() => upgrade("dmg")}
                  title="快捷鍵 D"
                >
                  傷害 {upgradeCost("dmg", selected.level)} [D]
                </button>
                <button
                  className="btn ghost flex-1"
                  disabled={gold < upgradeCost("rate", selected.level)}
                  onClick={() => upgrade("rate")}
                  title="快捷鍵 F"
                >
                  射速 {upgradeCost("rate", selected.level)} [F]
                </button>
              </div>
              <button className="btn ghost mt-2 w-full" onClick={sell}>
                賣出 +{sellRefund(selected.spent || selectedDef.cost)}
              </button>
            </div>
          )}
          <p className="mb-2 text-xs text-[#8eb6d4]">守護者（依圖片順序，越後越強）</p>
          {towerBook.map((t) => {
            const showCost = Math.max(1, Math.round(t.cost * (getDifficulty(difficultyId).towerCostMul ?? 1)));
            const canAfford = phase !== "play" || gold >= showCost;
            const hotkey = t.id < 9 ? String(t.id + 1) : t.id === 9 ? "0" : t.id === 10 ? "-" : "=";
            return (
              <button
                key={t.id}
                className={"tower-card" + (pick === t.id ? " on" : "") + (!canAfford ? " dim" : "")}
                disabled={phase === "play" && !canAfford && pick !== t.id}
                title={`快捷鍵 ${hotkey}`}
                onClick={() => {
                  if (phase === "play" && !canAfford) {
                    setHover(`金幣不足：需要 ${showCost}`);
                    return;
                  }
                  setPick(t.id);
                  pickRef.current = t.id;
                  setSel(null);
                  selRef.current = null;
                  setHover(
                    `${t.name}：${t.trait} · 傷 ${Math.round(t.damage * (getDifficulty(difficultyId).towerDmgMul ?? 1))} · [${hotkey}]`,
                  );
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
                    <span className="ml-1 text-[10px] font-normal text-[#7aa0bc]">[{hotkey}]</span>
                  </b>
                  <span className={canAfford ? "text-[#ffd27a]" : "text-[#ff8a8a]"}>💰 {showCost}{!canAfford && phase === "play" ? " · 不足" : ""}</span>
                  <span className="mt-0.5 block text-[11px] text-[#b7ddf5]">{t.trait}</span>
                </span>
              </button>
            );
          })}
        </aside>
      </div>
    </div>
  );
}
