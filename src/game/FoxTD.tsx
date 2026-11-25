import { useEffect, useRef, useState } from "react";
import { Terrain3DMap, type Terrain3DApi, type Terrain3DSnapshot } from "./Terrain3DMap";
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
  ownedSkillPaths,
  rollSkillChoices,
  skillLabelShort,
  SKILL_BY_ID,
  SKILL_CHOICE_COUNT,
  SKILL_PATH_META,
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
  deleteCustomDifficulty,
  type DifficultyProfile,
} from "./difficulty";
import {
  buildBlocked,
  buildHeights,
  bestRotForSlot,
  canPlaceTile,
  createTidalLiftTemplate,
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
  TILE_COLS,
  TILE_ROWS,
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
const STAKE_COST = 28;
const START_GOLD = 250; // fallback；備戰期可放 銀月+寒霜+餘額

/** 聖地：本陣防禦建築 + 週期護衛 + 一場一條升級路線 */
const HQ_BASE_DMG = 10;
const HQ_BASE_CD = 1.0;
const HQ_BASE_RANGE = 150;
/** 週期投放基礎間隔（秒）；路線會縮短 */
const HQ_ESCORT_BASE_CD = 14;
const HQ_ESCORT_COST = 22;
/**
 * 聖地建築血量（與一般塔／舊「生命條數」分離）
 * 平衡假設：雜兵剩餘 ~30–50，漏一隻約扣 12–15；滿編漏 15 隻約 200 傷。
 * 本體 1200 → 約能扛 5–6 波「全漏」；正常半漏可打到中後期。
 * Boss 有倍率但單次有上限，避免一隻秒殺。
 */
const HQ_BUILDING_HP = 1200;
const HQ_LEAK_HP_MUL = 0.18;
const HQ_LEAK_FLAT = 6;
const HQ_LEAK_HIT_CAP = 100;
const HQ_LEAK_BOSS_MUL = 1.35;
const HQ_HP_PER_CORE_LV = 100; // 主砲升級附帶建築耐久
/** 接觸結算間隔（越短換血越快） */
const HQ_CONTACT_TICK = 0.10;
/** 護衛對怪傷害 ≈ 自身當前生命 × 此權重（每 tick） */
const HQ_ATK_W = 0.30;
/** 怪對護衛反傷權重 */
const HQ_REFLECT_W = 0.08;
/** 沿路徑判定接觸的距離（格距像素感） */
const HQ_CONTACT_PATH = 36;
/** 像素距離備援 */
const HQ_CONTACT_PX = 44;
/** 聖砲／加固各最多 5 次，禁止無限強化 */
const HQ_FIRE_MAX = 5;
const HQ_FORT_MAX = 5;
const SHRINE_PLACE_GOLD = 45;
const ELITE_BP_CHANCE = 0.22;

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
  /** 沿路徑距離：自聖地往入口遞減；可為負表示穿過入口進入迷霧 */
  dist: number;
  speed: number;
  contactT: number;
  shootCd: number;
  healCd: number;
  /** 1=正常，降至 0 後移除（迷霧消散） */
  fade: number;
  ai?: "march" | "intercept" | "hold" | "support";
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
    squad: 3,
    deployCd: HQ_ESCORT_BASE_CD,
    atkW: HQ_ATK_W,
    meleeHp: 62,
    ranged: false,
    rangedDmg: 7,
    healer: false,
    healAmt: 8,
    mixRanged: 0,
    mixHealer: 0,
  };
}

type HqBuffId = "dmg" | "resist" | "escort_cd" | "escort_hp" | "range" | "free_escort";
type HqBuffProgress = {
  tier: number;
  picks: HqBuffId[];
  blueprints: number;
  shrineCount: number;
  freePerWave: number;
};
function defaultHqBuff(): HqBuffProgress {
  return { tier: 0, picks: [], blueprints: 0, shrineCount: 0, freePerWave: 0 };
}
function hqBuffChoices(tier: number): { id: HqBuffId; name: string; desc: string; cost: number }[] {
  // 越後期越強、越貴
  if (tier === 1)
    return [
      { id: "dmg", name: "聖焰加持", desc: "聖地傷害 +15%", cost: 55 },
      { id: "resist", name: "潮盾", desc: "漏怪傷害再 −10%", cost: 55 },
    ];
  if (tier === 2)
    return [
      { id: "escort_cd", name: "急動員", desc: "護衛投放間隔 −3s", cost: 95 },
      { id: "escort_hp", name: "護潮甲", desc: "護衛生命 +32%", cost: 95 },
    ];
  return [
    { id: "range", name: "遠望聖域", desc: "聖地射程 +36", cost: 150 },
    { id: "free_escort", name: "潮汐預備", desc: "+3 免費名額，之後每波 +1", cost: 150 },
  ];
}

/** 鎖定路線：三選一 */
const HQ_PATH_LOCK: { path: HqPathId; cost: number; name: string; desc: string }[] = [
  { path: "blade", cost: 40, name: "刃衛之路", desc: "近戰為主，提高編制與換傷，適合硬擋高壓線" },
  { path: "bow", cost: 40, name: "羽矢之路", desc: "解鎖遠程護衛，邊推進邊輸出，適合多雜兵" },
  { path: "tide", cost: 40, name: "潮愈之路", desc: "解鎖回復兵，延長護衛存活，適合長波與 Boss 拖時間" },
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
  return Math.floor(spent * 0.75);
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
  /** 火力分支：傷／速／射程 */
  hqFireLv?: number;
  /** 加固分支：建築血／漏傷抗性 */
  hqFortifyLv?: number;
  /** 週期投放計時 */
  escortCd?: number;
  /** 四角砲台開火動畫 0..1 */
  hqTurretAtk?: number[];
  /** 屋頂大砲開火動畫 0..1 */
  hqCannonAtk?: number;
  /** 主砲蓄能 0..1 */
  hqCharge?: number;
  /** 升級外觀閃光 */
  hqBuildFlash?: number;
};

function sanctuaryStats(
  tw: { hqCoreLv?: number; hqFireLv?: number; hqFortifyLv?: number },
  buffPicks: HqBuffId[] = [],
) {
  const fire = Math.min(HQ_FIRE_MAX, tw.hqFireLv ?? 0);
  const fort = Math.min(HQ_FORT_MAX, tw.hqFortifyLv ?? 0);
  let damage = HQ_BASE_DMG * Math.pow(1.2, fire) * Math.pow(1.05, fort);
  let range = HQ_BASE_RANGE + fire * 12 + fort * 4;
  const cooldown = Math.max(0.38, HQ_BASE_CD * Math.pow(0.91, fire) * Math.pow(0.98, fort));
  const maxHp = HQ_BUILDING_HP + fort * 150 + fire * 35;
  let leakResist = Math.min(0.45, fort * 0.09);
  for (const id of buffPicks) {
    if (id === "dmg") damage *= 1.15;
    if (id === "resist") leakResist = Math.min(0.55, leakResist + 0.1);
    if (id === "range") range += 36;
  }
  return { damage, range, cooldown, maxHp, leakResist };
}

/** 漏怪傷害：剩餘生命折算 × 加固抗性 */
function sanctuaryLeakDamage(
  e: { hp: number; boss?: boolean; maxHp?: number },
  resist = 0,
) {
  const rem = Math.max(0, e.hp);
  let dmg = rem * HQ_LEAK_HP_MUL + HQ_LEAK_FLAT;
  if (e.boss) dmg *= HQ_LEAK_BOSS_MUL;
  dmg = Math.min(HQ_LEAK_HIT_CAP, Math.max(HQ_LEAK_FLAT, dmg));
  dmg *= Math.max(0.55, 1 - Math.min(0.45, resist));
  return Math.round(dmg);
}

/** 狐緣：鄰格（切比雪夫距離 ≤1）是否有指定 special 的塔 */
function hasNeighborSpecial(
  towers: { gx: number; gy: number; special?: string; def: number; stake?: boolean; sanctuary?: boolean }[],
  tw: { gx: number; gy: number },
  special: string,
  book: { special: string }[],
): boolean {
  for (const o of towers) {
    if (o.stake || o.sanctuary) continue;
    if (o.gx === tw.gx && o.gy === tw.gy) continue;
    if (Math.max(Math.abs(o.gx - tw.gx), Math.abs(o.gy - tw.gy)) > 1) continue;
    const sp = o.special || book[o.def]?.special;
    if (sp === special) return true;
  }
  return false;
}

/** Boss／敵技能顯示名（避免橫幅出現英文 id） */
const BOSS_SKILL_LABEL: Record<string, string> = {
  slam: "震地重擊",
  nova: "潮爆新星",
  terror: "威壓恐襲",
  howl: "潮嚎",
  barrier: "護潮屏障",
  mend: "癒合潮息",
  charge: "衝鋒",
};

/** 狐緣組合說明（固定 3 組） */
const FOX_BONDS: { a: string; b: string; name: string; desc: string }[] = [
  { a: "slow", b: "burn", name: "霜焰", desc: "霜塔鄰火塔：對減速中的敵人融化額外傷" },
  { a: "chain", b: "pierce", name: "璃貫", desc: "鏈塔鄰貫塔：連鎖多跳一程、穿透更易擴散" },
  { a: "root", b: "execute", name: "影裁", desc: "縛塔鄰處決塔：定身／緩速中更易觸發斬殺" },
];

function coreUpgradeCost(lv: number) {

  return Math.round(40 * Math.pow(1.4, Math.max(0, lv - 1)));
}

let __escortSeq = 1;

/** —— 創意玩法：連殺、潮汐事件、奇遇波、背水 —— */
const COMBO_WINDOW = 1.25;
const COMBO_GOLD_PER = 0.06; // 每層連殺額外金幣比例
const LAST_STAND_LIVES = 3;
/** 波間空檔：緊湊但夠讀提示／補一塔（秒） */
const WAVE_GAP_EARLY = 4.4;
const WAVE_GAP_NORMAL = 5.0;
const WAVE_GAP_MILESTONE = 5.8;
const WAVE_GAP_ENDLESS = 3.6;
const WAVE_GAP_ENDLESS_BOSS = 4.8;

type TideEventId =
  | "gold_rain"
  | "blood_tide"
  | "sanctuary_roar"
  | "mist"
  | "still_water"
  | "dual_moon"
  | "cliff_song";
type TideEvent = { id: TideEventId; name: string; desc: string; t: number; dur: number };

const TIDE_TABLE: { id: TideEventId; name: string; desc: string; weight: number; dur: number }[] = [
  { id: "gold_rain", name: "金沙落潮", desc: "本波擊殺金幣 +35%", weight: 1.05, dur: 999 },
  { id: "blood_tide", name: "赤潮催行", desc: "敵人移速 +18%，擊殺連殺窗口更長", weight: 1, dur: 999 },
  { id: "sanctuary_roar", name: "聖地鳴振", desc: "護衛動員免費一次、間隔暫時縮短", weight: 0.9, dur: 20 },
  { id: "mist", name: "海霧", desc: "所有塔射程 -12%，近戰護衛換傷 +25%", weight: 0.85, dur: 999 },
  { id: "still_water", name: "靜水片刻", desc: "敵人 -12% 移速，塔冷卻 -8%", weight: 1, dur: 999 },
  { id: "dual_moon", name: "雙月高台", desc: "高度 ≥2 的塔傷害 +10%，平地幾乎不懲罰", weight: 0.95, dur: 999 },
  { id: "cliff_song", name: "峭壁和鳴", desc: "同高度相鄰略加傷；首殺爆發更溫和", weight: 0.9, dur: 999 },
];

type WaveQuirk = { name: string; tag: string; enemyHp: number; enemySpd: number; gold: number; note: string };

function waveQuirk(wave: number): WaveQuirk | null {
  if (wave <= 0) return null;
  if (wave % 5 === 0) {
    const table: WaveQuirk[] = [
      { name: "潮汐祭", tag: "祭典", enemyHp: 1.15, enemySpd: 1.05, gold: 1.2, note: "強敵厚賞" },
      { name: "裂口狂潮", tag: "裂口", enemyHp: 0.92, enemySpd: 1.14, gold: 1.1, note: "又快又密" },
      { name: "沉船遺寶", tag: "遺寶", enemyHp: 1.05, enemySpd: 0.95, gold: 1.45, note: "偏肥的怪" },
    ];
    return table[(wave / 5 - 1) % table.length];
  }
  if (wave === 7) return { name: "初見巨影", tag: "預兆", enemyHp: 1.25, enemySpd: 0.88, gold: 1.15, note: "偏肉的試煉" };
  if (wave === 13) return { name: "雙月", tag: "雙月", enemyHp: 1.1, enemySpd: 1.1, gold: 1.2, note: "節奏加快" };
  return null;
}

function pickTideEvent(wave: number): TideEvent | null {
  if (wave < 2) return null;
  // 約 40% 機率觸發；奇遇波必觸
  const force = wave % 5 === 0;
  if (!force && Math.random() > 0.42) return null;
  const sum = TIDE_TABLE.reduce((a, x) => a + x.weight, 0);
  let r = Math.random() * sum;
  let row = TIDE_TABLE[0];
  for (const t of TIDE_TABLE) {
    r -= t.weight;
    if (r <= 0) {
      row = t;
      break;
    }
  }
  return { id: row.id, name: row.name, desc: row.desc, t: 0, dur: row.dur };
}




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

type SpawnJob = { type: number; at: number; route: number };

/** 分線負載平衡：優先補最空的路，避免精英全擠同一入口 */
function makeLanePicker(lanes: number) {
  const load = Array.from({ length: Math.max(1, lanes) }, () => 0);
  let rr = 0;
  const n = Math.max(1, lanes);
  return {
    next(weight = 1) {
      let best = 0;
      for (let i = 1; i < n; i++) if (load[i] < load[best]) best = i;
      const floor = load[best];
      const ties: number[] = [];
      for (let i = 0; i < n; i++) if (load[i] === floor) ties.push(i);
      const pick = ties[rr++ % ties.length];
      load[pick] += weight;
      return pick;
    },
  };
}

function clampSpawnType(i: number, hiExclusive?: number) {
  const hi = hiExclusive ?? ENEMY_TYPES.length;
  return Math.max(0, Math.min(Math.max(0, hi - 1), i | 0));
}

/** 一般波基礎間距：有下限，多線略加快但不塌成牆 */
function spawnBaseGap(wave: number, lanes: number) {
  return Math.max(0.3, 0.56 - wave * 0.02 - Math.min(0.08, Math.max(0, lanes - 1) * 0.015));
}

/**
 * 標準出怪：偵查 → 主波（微叢集）→ 壓力尾
 * - 類型曲線穩定，隨機只做小幅抖動
 * - 路線用負載平衡，Boss／拆塔優先走空線
 */
function spawnPlan(wave: number): SpawnJob[] {
  const list: SpawnJob[] = [];
  const lanes = Math.max(1, routes.length);
  const lane = makeLanePicker(lanes);
  const nTypes = Math.max(1, ENEMY_TYPES.length);
  // 主波不直接抽 Boss 槽（索引 4、5、9 等）；壓力段再放
  const fodderHi = Math.min(nTypes, 4);
  const tier = Math.min(fodderHi - 1, Math.max(0, Math.floor((wave - 1) / 2)));
  const gap = spawnBaseGap(wave, lanes);

  const mainCount = 5 + Math.floor(wave * 1.55);
  const lanePad = Math.round(mainCount * 0.16 * Math.max(0, lanes - 1));
  const totalMain = mainCount + lanePad;

  let t = 0.2;

  // 1) 偵查：弱體先探路，讓玩家對準火力
  const scouts = wave <= 2 ? 2 : 3;
  for (let i = 0; i < scouts; i++) {
    list.push({
      type: clampSpawnType(Math.max(0, tier - (i === 0 ? 1 : 0)), fodderHi),
      at: t,
      route: lane.next(1),
    });
    t += gap * 0.8;
  }
  t += gap * 0.35;

  // 2) 主波：每 4 隻一個微叢集（密→略疏），可讀可反應
  for (let i = 0; i < totalMain; i++) {
    let type = tier;
    if (Math.random() < 0.18 && type > 0) type -= 1;
    if (Math.random() < 0.1 + wave * 0.012) type = Math.min(fodderHi - 1, type + 1);
    list.push({ type: clampSpawnType(type, fodderHi), at: t, route: lane.next(1) });
    const mod = i % 4;
    if (mod === 3) t += gap * 0.55;
    else if (mod === 0 && i > 0) t += gap * 1.2;
    else t += gap;
  }

  // 3) 壓力尾：拆塔／疾行等，錯開路線
  if (wave >= 4 && wave % 4 === 0) {
    t += gap * 0.7;
    const melee = clampSpawnType(6);
    list.push({ type: melee, at: t, route: lane.next(2) });
    if (wave >= 8) {
      list.push({ type: melee, at: t + gap * 0.85, route: lane.next(2) });
      t += gap * 0.85;
    }
  }
  if (wave >= 5 && wave % 5 === 0) {
    t += gap * 1.0;
    list.push({ type: clampSpawnType(6), at: t, route: lane.next(2) });
    list.push({ type: clampSpawnType(8), at: t + gap * 0.65, route: lane.next(2) });
  }
  // 中後期偶發疾潮，不與 Boss 波重疊
  if (wave >= 9 && wave % 5 !== 0 && wave % 3 === 0) {
    t += gap * 0.5;
    list.push({ type: clampSpawnType(8), at: t, route: lane.next(1) });
  }

  list.sort((a, b) => a.at - b.at || a.route - b.route);
  return list;
}

/** 無盡：分段編隊 + 分線平衡，Boss 前留呼吸 */
function endlessPlan(wave: number): SpawnJob[] {
  const list: SpawnJob[] = [];
  const lanes = Math.max(1, routes.length);
  const lane = makeLanePicker(lanes);
  const nTypes = Math.max(1, ENEMY_TYPES.length);
  const clampType = (i: number) => clampSpawnType(i, nTypes);
  const fodder = Math.min(15, 6 + Math.floor(wave * 0.3));
  const elites = Math.min(3, Math.floor((wave + 1) / 5));
  const interval = Math.max(0.34, 0.55 - wave * 0.0045);

  const pickFodder = () => {
    const span = Math.min(3, 1 + Math.floor(wave / 7));
    return clampType(Math.floor(Math.random() * (span + 1)));
  };
  const pickElite = () => {
    const pool = [2, 3, 6, 7, 8].map(clampType);
    return pool[Math.floor(Math.random() * pool.length)];
  };
  const pickBoss = () => {
    if (wave >= 25 && Math.random() < 0.22) return clampType(9);
    if (wave >= 15 && Math.random() < 0.4) return clampType(5);
    return clampType(4);
  };

  let t = 0.22;
  // 偵查
  for (let i = 0; i < 2; i++) {
    list.push({ type: pickFodder(), at: t, route: lane.next(1) });
    t += interval * 0.75;
  }
  t += interval * 0.3;
  // 主雜兵（微叢集）
  for (let i = 0; i < fodder; i++) {
    list.push({ type: pickFodder(), at: t, route: lane.next(1) });
    t += interval * (i % 4 === 3 ? 0.6 : i % 4 === 0 && i > 0 ? 1.15 : 0.9 + Math.random() * 0.25);
  }
  // 精英錯線
  for (let i = 0; i < elites; i++) {
    t += interval * 0.5;
    list.push({ type: pickElite(), at: t, route: lane.next(2) });
    t += interval * 1.25;
  }
  if (wave > 0 && wave % 5 === 0) {
    t += interval * 1.4; // Boss 前清空視野
    list.push({ type: pickBoss(), at: t, route: lane.next(3) });
    const guards = Math.min(3, 1 + Math.floor(wave / 18));
    for (let g = 0; g < guards; g++) {
      list.push({ type: pickFodder(), at: t + 0.7 + g * 0.32, route: lane.next(1) });
    }
  } else if (wave > 0 && wave % 3 === 0) {
    t += interval * 0.45;
    list.push({ type: pickElite(), at: t, route: lane.next(2) });
  }
  list.sort((a, b) => a.at - b.at || a.route - b.route);
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
    const base = Math.min(3, Math.floor((wave - 1) / 2));
    // 主波略瘦 + 偵查型前置，時間軸由 queueFromGroups 展開
    const spawns: WaveGroup[] = [
      { type: Math.max(0, base - 1), count: wave <= 2 ? 2 : 3 },
      { type: Math.min(base, 3), count: 5 + Math.floor(wave * 0.9) },
    ];
    if (wave > 3) spawns.push({ type: Math.max(0, base - 1), count: 2 });
    if (wave % 4 === 0) spawns.push({ type: Math.min(6, n - 1), count: wave >= 8 ? 2 : 1 });
    if (wave % 5 === 0) spawns.push({ type: Math.min(5, n - 1), count: 1 });
    if (wave > 8) spawns.push({ type: Math.min(7, n - 1), count: 1 });
    if (wave > 12) spawns.push({ type: Math.min(8, n - 1), count: 2 });
    if (wave >= 18) spawns.push({ type: Math.min(9, n - 1), count: 1 });
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
  const list: SpawnJob[] = [];
  const usable = (gates.length ? gates : Array.from({ length: Math.max(1, routeCount) }, (_, i) => i)).filter(
    (i) => i >= 0 && i < Math.max(1, routeCount),
  );
  const picks = usable.length ? usable : [0];
  const lane = makeLanePicker(picks.length);
  let t = 0.2;
  for (const g of groups) {
    const n = Math.max(0, Math.min(40, Math.round(g.count)));
    const type = Math.max(0, Math.min(typeCount - 1, g.type));
    // 高階／Boss 型在時間軸上留白，雜兵可略密
    const threat = type / Math.max(1, typeCount - 1);
    const step = 0.28 + threat * 0.22;
    t += threat > 0.55 ? 0.35 : 0.08;
    for (let i = 0; i < n; i++) {
      const li = lane.next(1 + (threat > 0.55 ? 1 : 0));
      list.push({ type, at: t, route: picks[li] ?? picks[0] });
      t += step * (i % 4 === 3 ? 0.7 : 1);
    }
  }
  list.sort((a, b) => a.at - b.at);
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


/** 聖地中世紀聖城外觀 + 角樓／屋頂砲（依火力等級顯形） */
function drawSanctuaryCastle(
  ctx: CanvasRenderingContext2D,
  tw: {
    x: number;
    y: number;
    range: number;
    aim?: number;
    hp: number;
    maxHp: number;
    hqFireLv?: number;
    hqFortifyLv?: number;
    hqTurretAtk?: number[];
    hqCannonAtk?: number;
    hqBuildFlash?: number;
    shake?: number;
  },
  t: number,
  pathName: string,
  scene?: Record<string, HTMLImageElement | undefined> | null,
) {
  const fire = tw.hqFireLv ?? 0;
  const fort = tw.hqFortifyLv ?? 0;
  const pulse = 0.94 + Math.sin(t * 1.5) * 0.03;
  const bob = Math.sin(t * 1.2) * 0.6;
  // 聖地占位約 6×6 格（HQ 中央 7..12），貼圖對齊該佔地
  const footprint = CELL * 6;
  const sh = (tw.shake ?? 0) > 0 ? (Math.random() - 0.5) * 2 : 0;
  const flash = Math.max(0, tw.hqBuildFlash ?? 0);
  const aim = tw.aim ?? -Math.PI / 2;

  const art =
    fire >= 2
      ? scene?.sanctuary_armed
      : fire >= 1
        ? scene?.sanctuary_gold || scene?.sanctuary_armed
        : scene?.sanctuary_base || scene?.sanctuary_gold;

  ctx.save();
  ctx.translate(tw.x + sh, tw.y + sh + bob);

  // 接觸地面的橢圓影（對齊佔地寬）
  ctx.beginPath();
  ctx.ellipse(0, footprint * 0.28, footprint * 0.42, footprint * 0.14, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 10, 24, 0.45)";
  ctx.fill();

  // 淡體積光
  const halo = ctx.createRadialGradient(0, -footprint * 0.05, 8, 0, 0, footprint * 0.55);
  halo.addColorStop(0, `rgba(130, 190, 255, ${0.1 * pulse})`);
  halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, footprint * 0.55, 0, Math.PI * 2);
  ctx.fill();

  if (art && art.complete && art.naturalWidth > 8) {
    // 等角貼圖：寬=6格，高略加一點表現立面（約 5.2 格）
    const iw = footprint;
    const ih = footprint * 0.88;
    // 底部對齊腳底陰影中心略上方
    ctx.drawImage(art, -iw / 2, -ih * 0.72, iw, ih);
    if (flash > 0) {
      ctx.globalAlpha = flash * 0.35;
      ctx.fillStyle = "#c8e8ff";
      ctx.beginPath();
      ctx.ellipse(0, -ih * 0.15, iw * 0.35, ih * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else {
    ctx.fillStyle = "#3a7a9e";
    ctx.fillRect(-footprint * 0.35, -footprint * 0.25, footprint * 0.7, footprint * 0.45);
  }

  // 開火閃光（相對佔地比例）
  if (fire >= 1 && tw.hqTurretAtk) {
    const corners = [
      { x: -footprint * 0.32, y: -footprint * 0.18 },
      { x: footprint * 0.32, y: -footprint * 0.18 },
      { x: -footprint * 0.32, y: footprint * 0.08 },
      { x: footprint * 0.32, y: footprint * 0.08 },
    ];
    corners.forEach((c, i) => {
      const atk = tw.hqTurretAtk![i] ?? 0;
      if (atk <= 0.08) return;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(aim);
      const g = ctx.createRadialGradient(8, 0, 1, 8, 0, 14);
      g.addColorStop(0, `rgba(255,240,180,${0.85 * atk})`);
      g.addColorStop(1, "rgba(255,80,20,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(10, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }
  if (fire >= 2 && (tw.hqCannonAtk ?? 0) > 0.1) {
    const catk = tw.hqCannonAtk ?? 0;
    ctx.save();
    ctx.translate(0, -footprint * 0.35);
    ctx.rotate(aim);
    const g = ctx.createRadialGradient(14, 0, 1, 14, 0, 18);
    g.addColorStop(0, `rgba(255,250,200,${0.9 * catk})`);
    g.addColorStop(1, "rgba(255,100,40,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(14, 0, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // HP 條貼在建築下方邊緣（不超出佔地太多）
  const ratio = Math.max(0, tw.hp / Math.max(1, tw.maxHp));
  const barY = footprint * 0.32;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(-footprint * 0.28, barY, footprint * 0.56, 5);
  ctx.fillStyle = ratio > 0.35 ? "#7ec8ff" : "#ff8aa0";
  ctx.fillRect(-footprint * 0.28, barY, footprint * 0.56 * ratio, 5);
  ctx.textAlign = "center";
  ctx.font = "bold 10px sans-serif";
  ctx.fillStyle = "rgba(230,245,255,0.95)";
  ctx.fillText("聖地", 0, barY - 6);
  ctx.font = "8px sans-serif";
  ctx.fillStyle = "rgba(160,210,240,0.85)";
  ctx.fillText(`${pathName} · 火${fire}/固${fort}`, 0, barY + 16);

  ctx.beginPath();
  ctx.arc(0, 0, tw.range, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(120,190,255,0.08)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}


function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}


export function FoxTD() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const terrain3DApiRef = useRef<Terrain3DApi | null>(null);
  const terrain3DSnapshotRef = useRef<() => Terrain3DSnapshot>(() => ({
    placed: [],
    heights: emptyHeights(),
    blocked: new Set<string>(),
    towers: [],
    enemies: [],
    shots: [],
    rings: [],
    mapMode: "expand",
  }));
  const [gold, setGold] = useState(START_GOLD);
  /** 明潮砂：重骰地塊用，基礎產量 0 */
  const [mingSand, setMingSand] = useState(0);
  const mingSandRef = useRef(0);
  const comboRef = useRef({ n: 0, t: 0, best: 0 });
  /** 每波首殺：觸發「首殺潮」短爆發 */
  const waveFirstKillRef = useRef(true);
  /** 本波風格：漏敵、高地擊殺、路障相關 */
  const waveStyleRef = useRef({ leaked: false, highlandKills: 0, stakeAssists: 0 });
  const tideRef = useRef<TideEvent | null>(null);
  const freeEscortRef = useRef(0);
  const lastStandRef = useRef(false);
  const tacticalRef = useRef({
    inspireCd: 0,
    barrierCd: 0,
    rallyCd: 0,
    inspireT: 0,
    barrierAbsorb: 0,
  });
  const [, setFlavorTick] = useState(0);
  const bumpFlavor = () => setFlavorTick((x) => x + 1);
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
  const [bossBannerUi, setBossBannerUi] = useState<null | { name: string; skills: string[] }>(null);
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
  const hqBuffRef = useRef<HqBuffProgress>(defaultHqBuff());
  const [, bumpHqBuffUi] = useState(0);
  const bumpHqBuff = () => bumpHqBuffUi((n) => n + 1);
  const [, setHqProgTick] = useState(0);
  const bumpHqUi = () => setHqProgTick((n) => n + 1);
  const tileOfferRef = useRef<string[] | null>(null);
  const [tileOffer, setTileOffer] = useState<string[] | null>(null);
  const lastExpandWaveRef = useRef(0);
  const [pickTemplate, setPickTemplate] = useState<string | null>(null);
  const pickTemplateRef = useRef<string | null>(null);
  const [pickRot, setPickRot] = useState<Rot>(0);
  const pickRotRef = useRef<Rot>(0);
  const mapModeRef = useRef<"expand" | "layout">("expand");
  // 地塊預覽只在地圖或模板變更時重算，避免繪圖循環與滑鼠移動反覆掃描全部接口。
  const tilePlacementPreviewRef = useRef<{
    board: TileBoard;
    templateId: string;
    valid: ReturnType<typeof validPlacements>;
    bySlot: Map<string, Rot[]>;
    slotKeys: Set<string>;
    frontierKeys: Set<string>;
  } | null>(null);
  const getTilePlacementPreview = (board: TileBoard, templateId: string) => {
    const cached = tilePlacementPreviewRef.current;
    if (cached && cached.board === board && cached.templateId === templateId) return cached;
    const valid = validPlacements(board, templateId);
    const bySlot = new Map<string, Rot[]>();
    const slotKeys = new Set<string>();
    for (const placement of valid) {
      const key = placement.tc + "," + placement.tr;
      const rotations = bySlot.get(key) ?? [];
      rotations.push(placement.rot);
      bySlot.set(key, rotations);
      slotKeys.add(key);
    }
    const frontierKeys = new Set(frontierSlots(board).map((slot) => slot.tc + "," + slot.tr));
    const next = { board, templateId, valid, bySlot, slotKeys, frontierKeys };
    tilePlacementPreviewRef.current = next;
    return next;
  };


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
    /** Boss 進場橫幅 */
    bossBanner: null as null | { name: string; skills: string[]; life: number },
    bossFreezeT: 0,
    bossMark: null as null | { x: number; y: number; life: number; name: string },
    /** 壓力最高的戰線 */
    hotRoute: 0,
    clock: 0,
    between: 0,
    wave: 0,
    images: [] as HTMLImageElement[],
    towerFrames: [] as HTMLImageElement[][],
    towerAtkFrames: [] as HTMLImageElement[][],
    sheets: {} as Record<string, HTMLImageElement[]>,
    scene: {} as Record<string, HTMLImageElement>,
    pointer: { x: 0, y: 0, down: false, inside: false },
    blocked: new Set<string>(),
    heights: heightsRef.current,
    cam: {
      x: 0,
      y: Math.max(0, defaultEntrances()[1].r * CELL - VIEWH / 2),
      zoom: 1,
    },
    drag: { on: false, sx: 0, sy: 0, cx: 0, cy: 0, moved: false },
  });

  // 3D renderer reads the same live simulation data; tower/enemy sprite frames are unchanged.
  terrain3DSnapshotRef.current = () => {
    const current = sim.current;
    const now = performance.now() / 1000;
    const sanctuary = current.towers.find((tower) => tower.sanctuary);
    const coreProgress = Math.max(0, Math.min(1, ((sanctuary?.hqCoreLv ?? 1) - 1) / 10));
    const buffProgress = Math.max(0, Math.min(1, hqBuffRef.current.tier / 3));
    const shrineProgress = Math.max(0, Math.min(1, hqBuffRef.current.shrineCount / 4));
    const activeCharge = Math.max(0, Math.min(1, sanctuary?.hqCharge ?? 0));
    // 永久升級／祭壇加持形成淨界根基，聖地蓄能時再短暫推高驅霧強度；不修改戰鬥數值。
    const sanctuaryPower = Math.max(0.12, Math.min(1, 0.12 + coreProgress * 0.58 + buffProgress * 0.22 + shrineProgress * 0.08 + activeCharge * 0.08));
    const placementActive =
      current.pointer.inside &&
      phaseRef.current === "play" &&
      pickRef.current !== null &&
      !stakeRef.current &&
      !shrinePlaceRef.current &&
      !tileOfferRef.current;
    let placement: Terrain3DSnapshot["placement"] = null;
    if (placementActive) {
      const rawGx = Math.floor(current.pointer.x / CELL);
      const rawGy = Math.floor(current.pointer.y / CELL);
      const snapped = snapPlaceCell(rawGx, rawGy);
      const target = snapped ?? { gx: rawGx, gy: rawGy };
      placement = {
        gx: target.gx,
        gy: target.gy,
        height: cellHeight(current.heights, target.gx, target.gy),
        valid: !!snapped,
        snapped: !!snapped && (snapped.gx !== rawGx || snapped.gy !== rawGy),
      };
    }
    return {
      placed: boardRef.current.placed,
      heights: current.heights,
      blocked: current.blocked,
      placement,
      sanctuaryPower,
      mapMode: mapModeRef.current,
      towers: current.towers.map((tower, index) => {
        const idle = current.towerFrames[tower.def] || [];
        const attack = current.towerAtkFrames[tower.def] || [];
        const attacking = tower.atkDur > 0 && tower.atkT < tower.atkDur && attack.length > 0;
        const image = attacking
          ? attack[attackFrameIndex(attackEase(tower.atkT / tower.atkDur), attack.length)]
          : idle.length > 1
            ? idle[pingIndex(idle.length, Math.floor(now * 6 + index))]
            : current.images[tower.def];
        return {
          x: tower.x, y: tower.y, gx: tower.gx, gy: tower.gy,
          def: tower.def, level: tower.level, aim: tower.aim,
          range: tower.range, selected: index === selRef.current,
          stake: tower.stake, sanctuary: tower.sanctuary,
          hqFireLv: tower.hqFireLv, hqFortifyLv: tower.hqFortifyLv,
          hqTurretAtk: tower.hqTurretAtk?.slice(), hqCannonAtk: tower.hqCannonAtk,
          hqCharge: tower.hqCharge, hqBuildFlash: tower.hqBuildFlash,
          hp: tower.hp, maxHp: tower.maxHp, image,
        };
      }),
      shots: current.shots.map((shot) => ({
        x: shot.x, y: shot.y, tx: shot.tx, ty: shot.ty, color: shot.color,
        sanctuary: shot.fromTower != null && !!current.towers[shot.fromTower]?.sanctuary,
      })),
      rings: current.rings.map((ring) => ({
        x: ring.x, y: ring.y, r: ring.r, max: ring.max, color: ring.color, life: ring.life,
      })),
      enemies: current.enemies.map((enemy) => {
        const book = bestiaryRef.current[enemy.type] ?? bestiaryRef.current[0];
        const setName = (book?.sprite as string) || (enemy.boss ? "boss" : enemy.type <= 1 ? "imp" : enemy.type <= 3 ? "brute" : "boss");
        const frames = current.sheets[setName] || [];
        const frame = frames.length
          ? frames[Math.floor(now * 7 + enemy.dist / 20 + enemy.phase) % frames.length]
          : undefined;
        const p = posAt(enemy.dist, enemy.route);
        return {
          x: p.x, y: p.y, r: enemy.r, hp: enemy.hp, maxHp: enemy.maxHp,
          hurt: enemy.hurt, face: enemy.face, image: frame, color: enemy.color, boss: enemy.boss,
        };
      }),
    };
  };

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
      height0: "/scene/height0.png?v=6",
      height1: "/scene/height1.png?v=6",
      height2: "/scene/height2.png?v=6",
      height3: "/scene/height3.png?v=6",
      entrance: "/scene/entrance.png",
      exit: "/scene/exit.png",
      sanctuary_base: "/scene/sanctuary_base.png?v=3",
      sanctuary_gold: "/scene/sanctuary_gold.png?v=3",
      sanctuary_armed: "/scene/sanctuary_armed.png?v=3",
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

      // 狐緣連攜（鄰格固定 3 組）
      let bondTag: string | null = null;
      if (fromTower != null) {
        const tw = sim.current.towers[fromTower];
        const book = towerBookRef.current;
        if (tw && !tw.stake && !tw.sanctuary) {
          const sp = (tw as { special?: string }).special || book[tw.def]?.special;
          // 霜焰：slow 鄰 burn（或反向）— 目標處於減速時融化
          if (
            (sp === "burn" || sp === "ultimate") &&
            hasNeighborSpecial(sim.current.towers, tw, "slow", book) &&
            e.slowT > 0 &&
            e.slow < 0.95
          ) {
            amount *= 1.32;
            bondTag = "霜焰";
          } else if (
            sp === "slow" &&
            hasNeighborSpecial(sim.current.towers, tw, "burn", book) &&
            e.burnT > 0
          ) {
            amount *= 1.2;
            bondTag = "霜焰";
          }
          // 璃貫：chain 鄰 pierce
          if (sp === "chain" && hasNeighborSpecial(sim.current.towers, tw, "pierce", book)) {
            amount *= 1.12;
            bondTag = bondTag || "璃貫";
          }
          if (sp === "pierce" && hasNeighborSpecial(sim.current.towers, tw, "chain", book)) {
            amount *= 1.12;
            bondTag = bondTag || "璃貫";
          }
          // 影裁：root 鄰 execute — 定身或深緩中提高斬線
          if (
            (sp === "execute" || sp === "root") &&
            (hasNeighborSpecial(sim.current.towers, tw, sp === "execute" ? "root" : "execute", book))
          ) {
            if (e.rootT > 0 || (e.slowT > 0 && e.slow <= 0.4)) {
              amount *= 1.18;
              bondTag = bondTag || "影裁";
            }
          }
        }
      }
      if (bondTag) float(px, py - 42, bondTag, "#ffb4e0");

      // 高地戰術：高度不進碰撞，只改這一發的手感
      if (fromTower != null) {
        const tw = sim.current.towers[fromTower];
        if (tw && !tw.stake && !tw.sanctuary) {
          const hh = cellHeight(sim.current.heights, tw.gx, tw.gy);
          const nearRoad = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dc, dr]) => {
            const nc = tw.gx + dc;
            const nr = tw.gy + dr;
            if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) return false;
            if (!isCellOnBoard(boardRef.current, nc, nr)) return false;
            return !sim.current.blocked.has(cellKey(nc, nr));
          });
          if (hh >= 3 && Math.random() < 0.14) {
            amount *= 1.48;
            float(px, py - 34, "峭擊", "#ffe08a");
            // 峭擊回響：鄰近同高或更矮的塔短暫加速
            for (const o of sim.current.towers) {
              if (o === tw || o.stake || o.sanctuary) continue;
              if (Math.max(Math.abs(o.gx - tw.gx), Math.abs(o.gy - tw.gy)) > 2) continue;
              o.rateMul = Math.max(o.rateMul || 1, 1.1);
              o.terrorT = Math.max(o.terrorT || 0, 0.4);
            }
          } else if (hh === 2 && Math.random() < 0.09) {
            amount *= 1.28;
            float(px, py - 34, "高擊", "#d7f0ff");
          } else if (hh <= 1 && nearRoad) {
            amount *= 1.08;
          }
          if (hh >= 3 && !e.noslow && Math.random() < 0.22) {
            e.slow = Math.min(e.slow, 0.72);
            e.slowT = Math.max(e.slowT, 0.45);
          }
          // 潮汐：雙月高台
          if (tideRef.current?.id === "dual_moon") {
            // 輕幅：高台略強、平地幾乎不懲罰，避免疊乘爆炸
            if (hh >= 2) amount *= 1.1;
            else amount *= 0.97;
          }
          // 同高共鳴：周圍 2 格內同高度 ≥2 座 → 額外傷害
          {
            let mates = 0;
            for (const o of sim.current.towers) {
              if (o === tw || o.stake || o.sanctuary) continue;
              if (Math.max(Math.abs(o.gx - tw.gx), Math.abs(o.gy - tw.gy)) > 2) continue;
              if (cellHeight(sim.current.heights, o.gx, o.gy) === hh) mates += 1;
            }
            if (mates >= 2) {
              amount *= 1.06;
              if (Math.random() < 0.06) float(px, py - 50, "共鳴", "#b8f0ff");
            } else if (mates >= 1 && tideRef.current?.id === "cliff_song") {
              amount *= 1.04;
            }
          }
          // 隘口伏擊：塔旁 2 格內有路障 → 小幅加傷，偶爾短定身（控場向，不堆爆發）
          {
            let stakesNear = 0;
            for (const o of sim.current.towers) {
              if (!o.stake) continue;
              if (Math.max(Math.abs(o.gx - tw.gx), Math.abs(o.gy - tw.gy)) <= 2) stakesNear += 1;
            }
            if (stakesNear > 0) {
              amount *= 1.05 + Math.min(0.04, stakesNear * 0.02);
              waveStyleRef.current.stakeAssists += 1;
              if (!e.noslow && Math.random() < 0.1 + stakesNear * 0.02) {
                e.rootT = Math.max(e.rootT, 0.28);
                if (Math.random() < 0.3) float(px, py - 38, "隘口", "#d2c4a8");
              }
            }
          }
          // 護衛同陣：附近有護衛 → 極輕加傷
          {
            let guards = 0;
            for (const u of sim.current.escorts) {
              if (u.hp <= 0) continue;
              if (Math.hypot(u.x - tw.x, u.y - tw.y) < 80) guards += 1;
            }
            if (guards > 0) amount *= 1.03;
          }
        }
      }

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

      // 護甲：一般攻擊 0.72；燃燒／破甲塔更有效
      if (e.armor) {
        if (special === "burn" || special === "ultimate") amount *= 0.88;
        else if (special === "break") amount *= 0.95;
        else amount *= 0.72;
      }
      if (e.shield > 0) {
        const used = Math.min(e.shield, amount);
        e.shield -= used;
        amount -= used;
      }
      e.hp -= amount;
      float(px, py - 16, String(Math.round(amount)), special === "break" && e.armor ? "#ffe08a" : "#fff");
      if (special === "break" && e.armor && Math.random() < 0.35) float(px, py - 28, "破甲", "#ffe08a");
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

      // 處決（影裁：定身／深緩中斬線提高）
      let exec = special === "execute" ? 0.18 : 0;
      for (const ex of get("execLine")) exec = Math.max(exec, ex.ratio);
      if (fromTower != null) {
        const tw = sim.current.towers[fromTower];
        const book = towerBookRef.current;
        if (
          tw &&
          special === "execute" &&
          hasNeighborSpecial(sim.current.towers, tw, "root", book) &&
          (e.rootT > 0 || (e.slowT > 0 && e.slow <= 0.4))
        ) {
          exec = Math.max(exec, 0.28);
        }
      }
      if (exec > 0 && e.hp > 0 && e.hp < e.maxHp * exec) {
        e.hp = 0;
        float(px, py - 28, exec >= 0.25 ? "影斬" : "斬", "#ffd2a8");
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
      // 聖地命中專屬金色震波；只增加視覺回饋，不影響傷害判定。
      if (fromTower != null && sim.current.towers[fromTower]?.sanctuary) {
        sim.current.rings.push({
          x: px,
          y: py,
          r: 7,
          max: e.boss ? 72 : 52,
          color: "#ffd27a",
          life: e.boss ? 0.46 : 0.36,
        });
      }

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
        // 璃貫：鄰有穿透塔 → 多跳 1 程、距離略增
        if (fromTower != null) {
          const tw = sim.current.towers[fromTower];
          if (tw && hasNeighborSpecial(sim.current.towers, tw, "pierce", towerBookRef.current)) {
            extra += 1;
            jump += 28;
            pct = Math.max(pct, 0.62);
          }
        }
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
      tw.aim = Math.atan2(p.y - tw.y, p.x - tw.x);

      // —— 聖地：角樓砲台／屋頂聖砲獨立彈道與動畫 ——
      if (tw.sanctuary) {
        const fireLv = tw.hqFireLv ?? 0;
        const R = CELL * 2.55;
        const corners = [
          { x: tw.x - R * 0.95 + 8, y: tw.y - R * 0.92 + 8 },
          { x: tw.x + R * 0.95 - 8, y: tw.y - R * 0.92 + 8 },
          { x: tw.x - R * 0.95 + 8, y: tw.y + R * 0.95 - 8 },
          { x: tw.x + R * 0.95 - 8, y: tw.y + R * 0.95 - 8 },
        ];
        if (!tw.hqTurretAtk) tw.hqTurretAtk = [0, 0, 0, 0];

        const useCannon = fireLv >= 2 && (tw.skillShots % 3 === 0 || fireLv >= 3);
        if (useCannon) {
          const ox = tw.x + Math.cos(tw.aim) * 12;
          const oy = tw.y - R * 0.72 + Math.sin(tw.aim) * 8;
          tw.hqCannonAtk = 1;
          tw.hqCharge = 0;
          sim.current.shots.push({
            x: ox,
            y: oy,
            tx: p.x,
            ty: p.y,
            speed: 320,
            damage: dmg * 1.55,
            special: "high",
            color: "#ffe08a",
            life: 2.2,
            pierced: new Set(),
            target,
            skills: [],
            fromTower: towerIndex,
            pierceCount: 0,
          });
          burst(ox, oy, "#ffe08a", 8, 2.2);
          sim.current.rings.push({ x: ox, y: oy, r: 6, max: 28, color: "rgba(255,220,140,0.5)", life: 0.25 });
          float(ox, oy - 22, "聖砲", "#ffe08a");
        } else if (fireLv >= 1) {
          tw.hqCannonAtk = 0;
          tw.hqCharge = 0;
          // 選最靠近目標的角樓開火
          let bestI = 0;
          let bestD = 1e9;
          for (let i = 0; i < 4; i++) {
            const d = Math.hypot(corners[i].x - p.x, corners[i].y - p.y);
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          }
          tw.hqTurretAtk[bestI] = 1;
          const c = corners[bestI];
          sim.current.shots.push({
            x: c.x,
            y: c.y,
            tx: p.x,
            ty: p.y,
            speed: 500,
            damage: dmg * 1.05,
            special: "high",
            color: "#ffd2a8",
            life: 1.4,
            pierced: new Set(),
            target,
            skills: [],
            fromTower: towerIndex,
            pierceCount: 0,
          });
          burst(c.x, c.y, "#ffd2a8", 5, 1.5);
          float(c.x, c.y - 16, "角樓", "#ffd2a8");
        } else {
          // 初始中央主炮：保留較小威力，但 3D 模型會有明確炮口閃光
          tw.hqCannonAtk = 0.62;
          tw.hqCharge = 0;
          // 初始小兵器：主殿微光彈
          sim.current.shots.push({
            x: tw.x,
            y: tw.y,
            tx: p.x,
            ty: p.y,
            speed: 420,
            damage: dmg,
            special: "high",
            color: "#c9e8ff",
            life: 1.5,
            pierced: new Set(),
            target,
            skills: [],
            fromTower: towerIndex,
            pierceCount: 0,
          });
          burst(tw.x, tw.y, "#c9e8ff", 4, 1.2);
        }
        tw.recoil = 0.22;
        const period = Math.max(0.12, tw.cooldown / (tw.rateMul > 0 ? tw.rateMul : 1));
        tw.atkDur = Math.min(0.85, Math.max(0.18, period * 0.9));
        tw.atkT = 0;
        return;
      }

      const pushShot = (sx: number, sy: number, tx: number, ty: number, tgt: Enemy | null, special: Special, color: string, spd: number, life: number) => {
        sim.current.shots.push({
          x: sx,
          y: sy,
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
        pushShot(tw.x, tw.y, tw.x + Math.cos(ang) * 900, tw.y + Math.sin(ang) * 900, null, def.special, def.color, 520, 1.1);
      } else {
        pushShot(tw.x, tw.y, p.x, p.y, target, def.special, def.color, 460, 1.6);
        for (const d of effects) {
          if (d.type === "doubleShot" && Math.random() < d.chance) {
            pushShot(tw.x, tw.y, p.x + 6, p.y + 6, target, def.special, def.color, 480, 1.5);
          }
        }
      }
      burst(tw.x, tw.y, def.color, 4, 1.4);
      tw.recoil = 0.28;
      {
        const period = Math.max(0.12, tw.cooldown / (tw.rateMul > 0 ? tw.rateMul : 1));
        tw.atkDur = Math.min(0.85, Math.max(0.18, period * 0.92));
        tw.atkT = 0;
      }
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

      if (s.wave === 0) {
        // 備戰潮息：最多 3 次（+12），避免掛機刷金
        const given = (s as { prepGoldGiven?: number }).prepGoldGiven ?? 0;
        if (given < 3) {
          const mark = (s as { prepGoldAcc?: number }).prepGoldAcc ?? 0;
          const next = mark + dt;
          if (next >= 12) {
            (s as { prepGoldAcc?: number }).prepGoldAcc = next - 12;
            (s as { prepGoldGiven?: number }).prepGoldGiven = given + 1;
            goldRef.current += 4;
            setGold(goldRef.current);
            s.floats.push({
              x: VIEWW * 0.5,
              y: 48,
              text: given + 1 >= 3 ? "+4 潮息（備戰補給結束）" : "+4 潮息",
              life: 1.1,
              color: "#ffe08a",
            });
          } else (s as { prepGoldAcc?: number }).prepGoldAcc = next;
        }
      }

      // Boss 橫幅倒數
      if (s.bossBanner) {
        s.bossBanner.life -= dt;
        if (s.bossBanner.life <= 0) {
          s.bossBanner = null;
          setBossBannerUi(null);
        }
      }
      if (s.bossFreezeT > 0) s.bossFreezeT -= dt;

      // 戰線壓力：Σ (路徑剩餘比例 × 血量權重)，最高者標紅
      {
        const pressure = routes.map(() => 0);
        for (const e of s.enemies) {
          if (e.hp <= 0) continue;
          const len = routeLen(e.route) || 1;
          const left = Math.max(0, len - e.dist);
          const w = (0.35 + 0.65 * (left / len)) * (e.boss ? 3.5 : 1) * (0.5 + 0.5 * (e.hp / Math.max(1, e.maxHp)));
          if (e.route >= 0 && e.route < pressure.length) pressure[e.route] += w;
        }
        let hot = 0;
        let best = -1;
        for (let i = 0; i < pressure.length; i++) {
          if (pressure[i] > best) {
            best = pressure[i];
            hot = i;
          }
        }
        s.hotRoute = hot;
        (s as { routePressure?: number[] }).routePressure = pressure;
      }

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
            hp: et.hp * hpMul * 0.92 * (waveQuirk(s.wave)?.enemyHp ?? 1),
            maxHp: et.hp * hpMul * 0.92 * (waveQuirk(s.wave)?.enemyHp ?? 1),
            speed: et.speed * (0.96 + Math.random() * 0.08) * speedMul
              * (waveQuirk(s.wave)?.enemySpd ?? 1)
              * (tideRef.current?.id === "blood_tide" ? 1.18 : tideRef.current?.id === "still_water" ? 0.88 : 1),
            gold: Math.max(1, Math.round(et.gold * goldMul * (1 + job.type * 0.08) * (waveQuirk(s.wave)?.gold ?? 1) * (s.wave <= 3 ? 1.2 : s.wave <= 6 ? 1.08 : 1))),
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
            regen: et.traits.includes("regen") ? et.hp * 0.025 : 0,
            noslow: et.traits.includes("noslow"),
            shield: et.traits.includes("shield") ? et.hp * scale * 0.22 : 0,
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
          // Boss 儀式：橫幅 + 全場短暫停 + 鏡頭對準 + 位置標示
          if (et.boss) {
            const sk = (et.skills as string[] | undefined) || [];
            const labeled = sk.length
              ? sk.slice(0, 4).map((id) => BOSS_SKILL_LABEL[id] || String(id))
              : ["強襲"];
            const skillHint = labeled.join(" · ");
            s.bossBanner = {
              name: et.name || "潮潮巨敵",
              skills: labeled,
              life: 2.6,
            };
            s.bossFreezeT = Math.max(s.bossFreezeT, 1.25);
            const bp = posAt(0, job.route ?? 0);
            s.bossMark = { x: bp.x, y: bp.y, life: 3.2, name: et.name || "Boss" };
            {
              const z = s.cam.zoom || 1;
              s.cam.x = bp.x - VIEWW / (2 * z);
              s.cam.y = bp.y - VIEWH / (2 * z);
              clampCam(s.cam);
            }
            const hq = s.towers.find((t) => t.sanctuary);
            if (hq) hq.shake = Math.max(hq.shake, 0.7);
            float(bp.x, bp.y - 48, `⚠ Boss · ${et.name}`, "#ffd27a");
            setHover(`Boss 來襲：${et.name}（${skillHint}）· 戰況暫停`);
            setBossBannerUi({ name: s.bossBanner.name, skills: s.bossBanner.skills });
          }
        }
      } else if (s.enemies.length === 0 && s.wave > 0) {
        if (tileOfferRef.current && tileOfferRef.current.length) {
          s.between = 0;
        } else {
          // 清波獎勵（僅在剛清空的第一幀發，用 between==0 判斷）
          if (s.between === 0 && s.queue.length === 0) {
            let clearBonus = 10 + s.wave * 3;
            const style = waveStyleRef.current;
            const tags: string[] = [];
            // 完璧：本波零漏傷
            if (!style.leaked) {
              const perfect = 4 + Math.min(10, s.wave);
              clearBonus += perfect;
              tags.push(`完璧 +${perfect}`);
              for (const tw of s.towers) {
                if (tw.stake || tw.sanctuary) continue;
                tw.rateMul = Math.max(tw.rateMul || 1, 1.08);
                tw.terrorT = Math.max(tw.terrorT || 0, 1.6);
              }
            }
            // 連殺殘潮（門檻略高、獎勵收斂）
            if (comboRef.current.best >= 10) {
              const streak = 3 + Math.min(6, Math.floor(comboRef.current.best / 3));
              clearBonus += streak;
              tags.push(`連殺殘潮 +${streak}`);
            }
            // 高台狩獵
            if (style.highlandKills >= 6) {
              const hunt = 3 + Math.min(6, Math.floor(style.highlandKills / 4));
              clearBonus += hunt;
              tags.push(`高台狩獵 +${hunt}`);
              if (style.highlandKills >= 15) {
                hqBuffRef.current.blueprints += 1;
                tags.push("潮紋圖紙");
              }
            }
            // 隘口佈局
            if (style.stakeAssists >= 10) {
              clearBonus += 3;
              tags.push("隘口有功 +3");
            }
            goldRef.current += clearBonus;
            setGold(goldRef.current);
            // 每波微量明潮砂
            if (s.wave % 2 === 0) {
              mingSandRef.current += 1;
              setMingSand(mingSandRef.current);
            }
            const tagStr = tags.length ? " · " + tags.join(" · ") : "";
            setHover(`波次清除 · +${clearBonus} 金` + tagStr + (s.wave % 2 === 0 ? " · 明潮砂 +1" : ""));
            // 重置風格計數
            waveStyleRef.current = { leaked: false, highlandKills: 0, stakeAssists: 0 };
          }
          s.between += dt;
          const cap = wavesRef.current?.length || MAX_WAVE;
          if (s.wave >= cap && !endlessRef.current) {
            phaseRef.current = "win";
            setPhase("win");
          } else if (
            isExpandBoard(boardRef.current) &&
            shouldOfferTiles(s.wave, boardRef.current) &&
            !tileOfferRef.current &&
            lastExpandWaveRef.current !== s.wave
          ) {
            let opts = pickOfferTemplates(OFFER_COUNT, boardRef.current, runTileBias);
            // 常規模板全部無法銜接時，生成一塊依現有端口雕出的淨界浮島，仍必須完成放置。
            if (!opts.length && frontierSlots(boardRef.current).length) {
              const fallback = createTidalLiftTemplate(boardRef.current);
              if (fallback) opts = [fallback.id];
            }
            if (opts.length && frontierSlots(boardRef.current).length) {
              lastExpandWaveRef.current = s.wave;
              mingSandRef.current += 1;
              setMingSand(mingSandRef.current);
              tileOfferRef.current = opts;
              setTileOffer(opts);
              setPickTemplate(null);
              pickTemplateRef.current = null;
              pickRotRef.current = 0;
              setPickRot(0);
              pausedRef.current = true;
              setPaused(true);
              {
                const fronts = frontierSlots(boardRef.current);
                if (fronts.length) {
                  let sx = 0, sy = 0;
                  for (const fr of fronts) {
                    sx += (fr.tc + 0.5) * TILE * CELL;
                    sy += (fr.tr + 0.5) * TILE * CELL;
                  }
                  const z = s.cam.zoom || 1;
                  s.cam.x = sx / fronts.length - VIEWW / (2 * z);
                  s.cam.y = sy / fronts.length - VIEWH / (2 * z);
                  clampCam(s.cam);
                }
              }
              setHover(`第 ${s.wave} 波結束 · 疆域擴張 · 請選模板後再放到地圖綠格`);
              s.between = 0;
            } else {
              const gap = endlessRef.current
                ? s.wave % 5 === 0
                  ? WAVE_GAP_ENDLESS_BOSS
                  : WAVE_GAP_ENDLESS
                : s.wave % 5 === 0
                  ? WAVE_GAP_MILESTONE
                  : s.wave <= 3
                    ? WAVE_GAP_EARLY
                    : WAVE_GAP_NORMAL;
              if (s.between > gap) beginWave();
            }
          } else {
            const gap = endlessRef.current
              ? s.wave % 5 === 0
                ? WAVE_GAP_ENDLESS_BOSS
                : WAVE_GAP_ENDLESS
              : s.wave % 5 === 0
                ? WAVE_GAP_MILESTONE
                : s.wave <= 3
                  ? WAVE_GAP_EARLY
                  : WAVE_GAP_NORMAL;
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
          // 燃燒 DoT 略無視護甲（厚甲仍痛）
          const burnMul = e.armor ? 0.9 : 1;
          e.hp -= e.burn * dt * burnMul;
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
            // 路障較耐打；聖地建築另有減傷（近戰拆建築不該秒掉）
            let mul = (e.rage ? 1.4 : 1) * (tw.stake ? 0.75 : 1);
            if (tw.sanctuary) mul *= 0.42;
            tw.hp -= damage * mul;
            tw.shake = 0.18;
            burst(tw.x, tw.y, e.rage ? "#ff6fa8" : "#ffb4c8", e.boss ? 10 : 6, 1.8);
            if (tw.hp <= 0) {
              if (tw.sanctuary) {
                tw.hp = 0;
                phaseRef.current = "lose";
                setPhase("lose");
                float(tw.x, tw.y, "聖地崩毀", "#ff6a80");
                return true;
              }
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
        if (s.bossFreezeT <= 0 && e.rootT <= 0 && e.aiSpeed > 0.05) {
          const slow = e.noslow ? 1 : e.slowT > 0 ? e.slow : 1;
          {
          const laneSoft = 1 - Math.min(0.18, Math.max(0, routes.length - 1) * 0.045);
          {
            const mp = (s as { moonPhase?: number }).moonPhase ?? 2;
            const moonSpd = mp === 0 ? 1.05 : mp === 3 ? 0.97 : 1; // 退潮快走、望月略慢
            e.dist += e.speed * 0.88 * laneSoft * slow * e.aiSpeed * e.hasteMul * (e.rage ? 1.12 : 1) * moonSpd * dt;
          }
        }
        }
        if (e.dist >= routeLen(e.route)) {
          const hq = s.towers.find((t) => t.sanctuary);
          const resist = hq ? sanctuaryStats(hq, hqBuffRef.current.picks).leakResist : 0;
          let leakDmg = sanctuaryLeakDamage(e, resist);
          const pLeak = posAt(e.dist, e.route);
          if (hq) {
            const tac = tacticalRef.current;
            if (tac.barrierAbsorb > 0 && leakDmg > 0) {
              const ab = Math.min(tac.barrierAbsorb, leakDmg);
              tac.barrierAbsorb -= ab;
              leakDmg -= ab;
              if (ab > 0) float(pLeak.x, pLeak.y - 22, `潮障擋 −${Math.round(ab)}`, "#9ad7ff");
            }
            if (leakDmg > 0) {
              hq.hp = Math.max(0, hq.hp - leakDmg);
              hq.shake = Math.max(hq.shake, 0.25);
              waveStyleRef.current.leaked = true;
              float(pLeak.x, pLeak.y - 10, e.boss ? `Boss 破陣 −${Math.round(leakDmg)}` : `聖地 −${Math.round(leakDmg)}`, e.boss ? "#ff6a80" : "#ff8aa0");
            }
            if (e.boss) {
              const hq2 = s.towers.find((t) => t.sanctuary);
              if (hq2) hq2.shake = Math.max(hq2.shake, 0.4);
              setHover("Boss 已殺入聖地中心！");
            }
            // 用 lives 顯示「完整度百分比」方便舊 UI；真正勝負看 hq.hp
            const pct = hq.maxHp > 0 ? hq.hp / hq.maxHp : 0;
            livesRef.current = Math.max(0, Math.ceil(pct * 20));
            setLives(livesRef.current);
            if (hq.hp <= 0) {
              phaseRef.current = "lose";
              setPhase("lose");
              setHover("聖地建築崩毀");
            } else if (pct <= 0.25) {
              setHover(`聖地告急 ${Math.round(hq.hp)}/${hq.maxHp}（本隻漏傷 ${leakDmg}）`);
            }
          } else {
            waveStyleRef.current.leaked = true;
            livesRef.current -= 1;
            setLives(livesRef.current);
            if (livesRef.current <= 0) {
              phaseRef.current = "lose";
              setPhase("lose");
            }
          }
          s.enemies.splice(i, 1);
          continue;
        }
        if (e.hp <= 0) {
          {
            const p = posAt(e.dist, e.route);
            const tide = tideRef.current;
            let g = e.gold;
            if (tide?.id === "gold_rain") g = Math.round(g * 1.35);
            {
              const mp = (s as { moonPhase?: number }).moonPhase ?? 2;
              if (mp === 1) g = Math.round(g * 1.06); // 潮漲
              else if (mp === 0) g = Math.round(g * 1.08); // 退潮：快走多金
            }
            const combo = comboRef.current;
            combo.t = COMBO_WINDOW + (tide?.id === "blood_tide" ? 0.3 : 0);
            combo.n += 1;
            if (combo.n > combo.best) combo.best = combo.n;
            if (combo.n >= 3) g += Math.max(1, Math.round(e.gold * COMBO_GOLD_PER * Math.min(combo.n, 20)));
            // 高地擊殺統計（死在高台塔射程內）
            {
              for (const tw of s.towers) {
                if (tw.stake || tw.sanctuary) continue;
                const hh = cellHeight(s.heights, tw.gx, tw.gy);
                if (hh < 2) continue;
                if (Math.hypot(p.x - tw.x, p.y - tw.y) <= tw.range + 20) {
                  waveStyleRef.current.highlandKills += 1;
                  break;
                }
              }
            }
            // 首殺潮：本波第一隻擊殺 → 短爆發 + 小額獎金
            if (waveFirstKillRef.current) {
              waveFirstKillRef.current = false;
              const bonus = 3 + Math.min(8, Math.floor(s.wave / 3));
              g += bonus;
              float(p.x, p.y - 44, "首殺潮", "#ffe8a0");
              for (const tw of s.towers) {
                if (tw.stake || tw.sanctuary) continue;
                tw.rateMul = Math.max(tw.rateMul || 1, tideRef.current?.id === "cliff_song" ? 1.18 : 1.1);
                tw.terrorT = Math.max(tw.terrorT || 0, tideRef.current?.id === "cliff_song" ? 1.6 : 1.1);
              }
              s.rings.push({ x: p.x, y: p.y, r: 14, max: 120, life: 0.4, color: "#ffe8a0" });
            }
            goldRef.current += g;
            setGold(goldRef.current);
            if (e.boss) {
              float(p.x, p.y - 36, "Boss 討伐", "#ffd27a");
              hqBuffRef.current.blueprints += 1;
              bumpHqBuff();
              float(p.x, p.y - 52, "潮紋圖紙 +1", "#9ad7ff");
            } else if (e.type >= 2 && Math.random() < ELITE_BP_CHANCE) {
              hqBuffRef.current.blueprints += 1;
              bumpHqBuff();
              float(p.x, p.y - 36, "潮紋圖紙 +1", "#9ad7ff");
            }
            if (combo.n >= 5 && combo.n % 5 === 0) float(p.x, p.y - 14, `連殺 ×${combo.n}`, "#ff9ecd");
            // 過殺餘波：超量擊殺在路徑上留一層薄霧減速（控場、不直接加傷）
            {
              const over = Math.max(0, -e.hp);
              if (over > e.maxHp * 0.2) {
                for (const o of s.enemies) {
                  if (o === e || o.hp <= 0) continue;
                  const op = posAt(o.dist, o.route);
                  if (Math.hypot(op.x - p.x, op.y - p.y) > 70) continue;
                  if (!o.noslow) {
                    o.slow = Math.min(o.slow, 0.78);
                    o.slowT = Math.max(o.slowT, 0.45);
                  }
                }
                if (Math.random() < 0.25) float(p.x, p.y - 22, "餘波", "#c8e8ff");
              }
            }
            // 連殺潮鳴：附近敵人短暫停頓，鼓勵把火力集中在一條線
            if (combo.n === 10 || combo.n === 20) {
              for (const o of s.enemies) {
                const op = posAt(o.dist, o.route);
                if (Math.hypot(op.x - p.x, op.y - p.y) > 120) continue;
                if (!o.noslow) {
                  o.slow = Math.min(o.slow, 0.55);
                  o.slowT = Math.max(o.slowT, 0.75);
                }
              }
              float(p.x, p.y - 48, "潮鳴", "#9ad7ff");
              s.rings.push({ x: p.x, y: p.y, r: 12, max: 120, life: 0.35, color: "#9ad7ff" });
            }
            float(p.x, p.y, `+${g}`, combo.n >= 3 ? "#ffe08a" : "#ffd27a");
            if (combo.n >= 3) bumpFlavor();
            else bumpFlavor();
          }
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
            if (tw.level === 5 || tw.level === 10 || tw.level === 15) {
              if (kind === "dmg") {
                tw.damage *= 1.1;
                tw.range += 8;
              } else {
                tw.cooldown = Math.max(0.16, tw.cooldown * 0.9);
                tw.range += 4;
              }
            }
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

      // 連殺計時衰減
      if (comboRef.current.t > 0) {
        comboRef.current.t -= dt;
        if (comboRef.current.t <= 0) {
          if (comboRef.current.n >= 8) setHover(`連殺中斷 · 本波最高 ×${comboRef.current.best}`);
          comboRef.current.n = 0;
        }
      }
      // 背水一戰
      {
        const hq = s.towers.find((t) => t.sanctuary);
        const hqPct = hq && hq.maxHp > 0 ? hq.hp / hq.maxHp : 1;
        if (!lastStandRef.current && hq && hqPct > 0 && hqPct <= 0.28 && phaseRef.current === "play") {
          lastStandRef.current = true;
          freeEscortRef.current += 1;
          for (const tw of s.towers) {
            if (tw.stake || tw.sanctuary) continue;
            tw.rateMul = Math.max(tw.rateMul || 1, 1.25);
            tw.terrorT = Math.max(tw.terrorT || 0, 12);
          }
          setHover(`背水一戰！聖地耐久 ${(hqPct * 100).toFixed(0)}% · 全塔射速提升，護衛免費名額 +1`);
          bumpFlavor();
        }
      }
      // 潮汐：靜水加速冷卻感（以 rateMul 近似）
      if (tideRef.current?.id === "still_water") {
        for (const tw of s.towers) {
          if (!tw.stake && (tw.rateMul || 1) < 1.08) tw.rateMul = 1.08;
        }
      }

      for (const tw of s.towers) {
        if (tw.terrorT > 0) {
          tw.terrorT -= dt;
          if (tw.terrorT <= 0) tw.rateMul = 1;
        } else if (tw.rateMul === undefined) tw.rateMul = 1;
        // Boss 進場儀式：短暫停射
        if (s.bossFreezeT > 0) {
          continue;
        }
        tw.cd -= dt;
        const twDef = towerBookRef.current[tw.def] ?? TOWERS[tw.def];
        const best = tw.stake
          ? null
          : pickTowerTarget(
              {
                ...tw,
                range: tw.range * (tideRef.current?.id === "mist" ? 0.88 : 1) * (1 + Math.min(0.12, (comboRef.current.n || 0) * 0.008)),
              },
              s.enemies,
              twDef?.special ?? "high",
            );
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
        if (tw.sanctuary) {
          const fireLevel = tw.hqFireLv ?? 0;
          const mainCanCharge = fireLevel === 0 || fireLevel >= 2;
          if (best && mainCanCharge) {
            const period = Math.max(0.12, tw.cooldown / Math.max(0.1, tw.rateMul || 1));
            tw.hqCharge = Math.max(0, Math.min(1, 1 - Math.max(0, tw.cd) / period));
          } else {
            tw.hqCharge = Math.max(0, (tw.hqCharge ?? 0) - dt * 2.1);
          }
        }
        if (tw.recoil > 0) tw.recoil -= dt;
        if (tw.atkDur > 0 && tw.atkT < tw.atkDur) tw.atkT = Math.min(tw.atkDur, tw.atkT + dt);
        if (tw.shake > 0) tw.shake -= dt;
        // 聖地週期護衛 + 外觀動畫衰減
        if (tw.sanctuary) {
          if (tw.hqTurretAtk) {
            for (let ti = 0; ti < tw.hqTurretAtk.length; ti++) {
              if (tw.hqTurretAtk[ti] > 0) tw.hqTurretAtk[ti] = Math.max(0, tw.hqTurretAtk[ti] - dt * 2.4);
            }
          }
          if ((tw.hqCannonAtk ?? 0) > 0) tw.hqCannonAtk = Math.max(0, (tw.hqCannonAtk ?? 0) - dt * 1.7);
          if ((tw.hqBuildFlash ?? 0) > 0) tw.hqBuildFlash = Math.max(0, (tw.hqBuildFlash ?? 0) - dt * 1.3);
          tw.escortCd = (tw.escortCd ?? 0) - dt;
          if (tw.escortCd <= 0 && s.enemies.some((e) => e.hp > 0)) {
            // 自動動員（耗金，金幣不足則延遲重試）
            const p = hqProgRef.current;
            if (goldRef.current >= HQ_ESCORT_COST || freeEscortRef.current > 0) {
              // 內聯一次部署避免閉包問題：重用部署邏輯的最小子集
              tw.escortCd = Math.max(5, p.deployCd - Math.floor(Math.max(0, s.wave) / 5)) * (tideRef.current?.id === "sanctuary_roar" ? 0.7 : 1);
              // 優先高壓戰線（與壓力標紅同一語意），同線再取最接近終點
              let threat: Enemy | null = null;
              let bestScore = -1e15;
              const hot = s.hotRoute ?? 0;
              for (const e of s.enemies) {
                if (e.hp <= 0) continue;
                const pos = posAt(e.dist, e.route);
                const distHq = Math.hypot(pos.x - tw.x, pos.y - tw.y);
                const onHot = e.route === hot ? 80 : 0;
                const score = onHot + e.dist * 2 - distHq * 0.15;
                if (score > bestScore) {
                  bestScore = score;
                  threat = e;
                }
              }
              if (threat) {
                const route = threat.route;
                const live = routes[route] ?? routes[0];
                if (live) {
                  if (freeEscortRef.current > 0) {
                    freeEscortRef.current -= 1;
                  } else {
                    goldRef.current -= HQ_ESCORT_COST;
                    setGold(goldRef.current);
                  }
                  // 自聖地端派出（高 dist），不閃現到怪臉上
                  const hqAnchor = projectDist(tw.x, tw.y, route);
                  const baseDist = Math.min(live.len - 12, Math.max(live.len * 0.7, hqAnchor + 8));
                  const wave = Math.max(0, s.wave);
                  const squadN = Math.min(18, p.squad + Math.floor(wave / 4));
                  const hpMul = 1 + Math.min(1.25, wave * 0.045);
                  const kinds: EscortKind[] = [];
                  let rangedLeft = p.ranged ? p.mixRanged + Math.floor(wave / 8) : 0;
                  let healLeft = p.healer ? p.mixHealer + Math.floor(wave / 10) : 0;
                  for (let k = 0; k < squadN; k++) {
                    if (rangedLeft > 0) {
                      kinds.push("ranged");
                      rangedLeft--;
                    } else if (healLeft > 0) {
                      kinds.push("healer");
                      healLeft--;
                    } else kinds.push("melee");
                  }
                  // 場上護衛上限，避免後期卡頓
                  const room = Math.max(0, 28 - s.escorts.length);
                  kinds.slice(0, room).forEach((kind, i) => {
                    const dist = Math.max(20, baseDist - i * 12);
                    const pos = posAt(dist, route);
                    const maxHp = Math.round(
                      (kind === "melee" ? p.meleeHp : kind === "ranged" ? p.meleeHp * 0.55 : p.meleeHp * 0.65) * hpMul,
                    );
                    s.escorts.push({
                      id: __escortSeq++,
                      kind,
                      x: pos.x,
                      y: pos.y,
                      hp: maxHp,
                      maxHp,
                      route,
                      dist,
                      speed: 100,
                      contactT: 0,
                      shootCd: 0.25 * i,
                      healCd: 1.0,
                      fade: 1,
                      ai: "march" as const,
                    });
                  });
                }
              } else tw.escortCd = 2;
            } else tw.escortCd = 2;
          }
        }
      }

      // 護衛：自聖地沿路前進；接觸則全兵種互耗血；不因到頭消失
      {
        const p = hqProgRef.current;
        const mistMul = tideRef.current?.id === "mist" ? 1.25 : 1;
        for (let i = s.escorts.length - 1; i >= 0; i--) {
          const u = s.escorts[i];
          if (u.hp <= 0 || (u.fade ?? 1) <= 0) {
            s.escorts.splice(i, 1);
            continue;
          }
          if (s.bossFreezeT > 0) continue; // 進場儀式護衛也停
          u.contactT -= dt;
          u.shootCd -= dt;
          u.healCd -= dt;
          // 已進入入口外迷霧：不再攔截，避免堵口
          if ((u.dist ?? 0) < 0) {
            u.dist = u.dist - u.speed * dt;
            const mistPast = CELL * 3;
            if (u.dist < -mistPast) {
              u.fade = Math.max(0, (u.fade ?? 1) - dt / 1.4);
              u.dist = -mistPast;
            }
            const live = routes[u.route];
            if (live && live.pts.length >= 2) {
              const a = live.pts[0];
              const b = live.pts[Math.min(1, live.pts.length - 1)];
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              const len = Math.hypot(dx, dy) || 1;
              const beyond = -u.dist;
              u.x = a.x + (dx / len) * beyond;
              u.y = a.y + (dy / len) * beyond;
            }
            if ((u.fade ?? 1) <= 0) {
              s.escorts.splice(i, 1);
            }
            continue;
          }

          // 行為樹目標選擇：同線 > 殘血 > Boss；近戰殘血傾向 hold
          const hpRatio = u.hp / Math.max(1, u.maxHp);
          let engage: Enemy | null = null;
          let engageGap = 1e9;
          for (const e of s.enemies) {
            if (e.hp <= 0) continue;
            const ep = posAt(e.dist, e.route);
            const same = e.route === u.route;
            const pathGap = same ? Math.abs(e.dist - u.dist) : 1e9;
            const pxGap = Math.hypot(ep.x - u.x, ep.y - u.y);
            const reach = u.kind === "ranged" ? HQ_CONTACT_PX * 1.15 : HQ_CONTACT_PX;
            const hit = (same && pathGap <= HQ_CONTACT_PATH) || pxGap <= reach;
            if (!hit) continue;
            let score = same ? pathGap : pxGap + 80;
            if (e.boss) score -= 12;
            if (e.hp / Math.max(1, e.maxHp) < 0.35) score -= 8;
            if (score < engageGap) {
              engageGap = score;
              engage = e;
            }
          }
          if (u.kind === "melee" && hpRatio < 0.28 && engage && !engage.boss) {
            // 非 Boss 交戰中過殘 → 後撤一點再打
            u.ai = "hold";
          } else if (engage) {
            u.ai = "intercept";
          } else if (u.kind === "healer") {
            u.ai = "support";
          } else {
            u.ai = "march";
          }

          if (engage && u.ai !== "hold") {
            // 全兵種接觸交戰：停在怪前方，互耗血（不瞬移到怪身上）
            if (engage.route === u.route) {
              const side = engage.dist + (u.kind === "melee" ? 14 : 22);
              u.dist = Math.max(8, Math.min(routeLen(u.route) - 4, side));
            }
            const pos = posAt(u.dist, u.route);
            u.x = pos.x;
            u.y = pos.y;
            engage.slow = Math.min(engage.slow, u.kind === "melee" ? 0.18 : 0.45);
            engage.slowT = Math.max(engage.slowT, u.kind === "melee" ? 0.35 : 0.2);
            if (u.contactT <= 0) {
              // 治療兵少換血；輸出用「最大血+當前血」混合，殘血仍有貢獻
              const kindMul = u.kind === "melee" ? 1 : u.kind === "ranged" ? 0.72 : 0.28;
              const power = u.maxHp * 0.55 + u.hp * 0.45;
              let dmg = Math.max(5, power * p.atkW * mistMul * kindMul);
              if (engage.armor) dmg *= 0.9; // 護衛略吃甲，留給聖輝破甲定位
              const isBoss = !!engage.boss;
              const reflectCap = isBoss ? 10 : 14;
              const reflect = Math.max(
                2,
                Math.min(reflectCap, u.maxHp * 0.14, Math.max(0, engage.hp) * HQ_REFLECT_W + dmg * 0.18),
              );
              // 治療兵接觸：主要減速，反傷減半
              const refl = u.kind === "healer" ? reflect * 0.4 : reflect;
              engage.hp -= dmg;
              if (u.kind !== "healer" || Math.random() < 0.5) u.hp -= refl;
              u.contactT = isBoss ? HQ_CONTACT_TICK * 1.25 : HQ_CONTACT_TICK;
              const ep = posAt(engage.dist, engage.route);
              if (Math.random() < 0.4) {
                float(ep.x, ep.y - 16, `−${Math.round(dmg)}`, u.kind === "melee" ? "#ffb4a8" : u.kind === "ranged" ? "#a8e0ff" : "#b8f0c8");
              }
              if (engage.hp <= 0) {
                goldRef.current += Math.max(1, Math.round((engage.gold || 4) * 0.9));
                setGold(goldRef.current);
                float(ep.x, ep.y - 28, "護衛擊破", "#ffe08a");
              }
            }
          } else {
            // 向入口推進；穿過入口再往外約 3 格後迷霧消散（不堵怪口）
            const mistPast = CELL * 3;
            u.dist = u.dist - u.speed * dt;
            if (u.dist < -mistPast) {
              u.fade = Math.max(0, (u.fade ?? 1) - dt / 1.4);
              u.dist = -mistPast;
            }
            // 入口附近仍用路徑點；超出入口用入口方向外推
            if (u.dist >= 0) {
              const pos = posAt(u.dist, u.route);
              u.x = pos.x;
              u.y = pos.y;
            } else {
              const live = routes[u.route];
              if (live && live.pts.length >= 2) {
                const a = live.pts[0];
                const b = live.pts[Math.min(1, live.pts.length - 1)];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const len = Math.hypot(dx, dy) || 1;
                const beyond = -u.dist;
                u.x = a.x + (dx / len) * beyond;
                u.y = a.y + (dy / len) * beyond;
              }
            }
          }
          if ((u.fade ?? 1) <= 0) {
            s.escorts.splice(i, 1);
            continue;
          }

          // 遠程額外遠射（接觸外也能輸出）
          if (u.kind === "ranged" && u.shootCd <= 0 && !engage) {
            let target: Enemy | null = null;
            let td = 1e9;
            for (const e of s.enemies) {
              if (e.hp <= 0) continue;
              const ep = posAt(e.dist, e.route);
              const d = Math.hypot(ep.x - u.x, ep.y - u.y);
              const bias = e.route === u.route ? 0 : 40;
              if (d + bias < 150 && d + bias < td) {
                td = d + bias;
                target = e;
              }
            }
            if (target) {
              const rd = p.rangedDmg * (1.25 + Math.min(0.5, s.wave * 0.02));
              target.hp -= rd;
              u.shootCd = 0.55;
              if (Math.random() < 0.35) {
                const tp = posAt(target.dist, target.route);
                float(tp.x, tp.y - 16, `−${Math.round(rd)}`, "#a8e0ff");
              }
            } else u.shootCd = 0.12;
          }

          if (u.kind === "healer" && u.healCd <= 0) {
            for (const o of s.escorts) {
              if (o.id === u.id || o.hp <= 0) continue;
              if (Math.hypot(o.x - u.x, o.y - u.y) > 90) continue;
              o.hp = Math.min(o.maxHp, o.hp + p.healAmt * (1 + Math.min(0.4, s.wave * 0.015)));
            }
            u.healCd = 1.8;
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
      // 備戰結束進第 1 波：依佈署給一點週轉金
      if (s.wave === 0) {
        const n = s.towers.filter((t) => !t.stake && !t.sanctuary).length;
        if (n >= 2) {
          const interest = 12 + Math.min(24, n * 4);
          goldRef.current += interest;
          setGold(goldRef.current);
          setHover(`佈署完備 · 週轉 +${interest} 金 · 第 1 波來襲`);
        }
      }
      s.wave += 1;
      if (hqBuffRef.current.freePerWave > 0) {
        freeEscortRef.current += hqBuffRef.current.freePerWave;
      }
      // 清除已消散／無血護衛，避免持續占資源
      sim.current.escorts = sim.current.escorts.filter((u) => (u.fade ?? 1) > 0.05 && u.hp > 0);
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
      // 奇遇波 + 潮汐事件
      const quirk = waveQuirk(s.wave);
      const tide = pickTideEvent(s.wave);
      tideRef.current = tide;
      freeEscortRef.current = tide?.id === "sanctuary_roar" ? 1 : 0;
      if (tide?.id === "sanctuary_roar") {
        const hq = s.towers.find((t) => t.sanctuary);
        if (hq) hq.escortCd = Math.min(hq.escortCd ?? 0, 2);
      }
      comboRef.current.n = 0;
      comboRef.current.t = 0;
      waveFirstKillRef.current = true;
      waveStyleRef.current = { leaked: false, highlandKills: 0, stakeAssists: 0 };
      // 月相：每 4 波一輪，只動金幣／移速幾個百分點，不當主力數值
      const moonPhase = s.wave % 4;
      const moonName = moonPhase === 1 ? "潮漲" : moonPhase === 2 ? "平潮" : moonPhase === 3 ? "望月" : "退潮";
      (s as { moonPhase?: number }).moonPhase = moonPhase;
      let msg = `第 ${s.wave} 波 · ${moonName}`;
      if (quirk) msg += ` · ${quirk.name}（${quirk.note}）`;
      if (tide) msg += ` · 潮汐「${tide.name}」：${tide.desc}`;
      setHover(msg);
      bumpFlavor();
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
        ctx.strokeStyle = "rgba(180,230,255,0.04)";
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


      // 高壓戰線路徑淡紅描邊
      {
        const hr = s.hotRoute;
        const pts = routes[hr]?.pts;
        if (pts && pts.length > 1 && ((s as { routePressure?: number[] }).routePressure?.[hr] ?? 0) > 0.2) {
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255, 100, 90, 0.38)";
          ctx.lineWidth = 7;
          ctx.lineJoin = "round";
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        }
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
            ctx.drawImage(groundImg, (c * 37) % 96, (r * 53) % 96, 32, 32, x, y, CELL, CELL);
            ctx.globalAlpha = 1;
            ctx.fillStyle = "rgba(20, 55, 70, 0.18)";
            ctx.fillRect(x, y, CELL, CELL);
          } else {
            const h = ((c * 374761) ^ (r * 668265)) >>> 0;
            const tint = (h % 8) / 8;
            ctx.fillStyle = `rgba(${24 + tint * 14 | 0}, ${58 + tint * 18 | 0}, ${72 + tint * 20 | 0}, 0.55)`;
            ctx.fillRect(x, y, CELL, CELL);
          }
        }
      }


      // 選塔放置時：鄰格狐緣預覽（可組成霜焰／璃貫／影裁）
      if (pickRef.current != null && phaseRef.current === "play") {
        const def = towerBookRef.current[pickRef.current] ?? TOWERS[pickRef.current];
        const sp = def?.special;
        const gx = Math.floor(s.pointer.x / CELL);
        const gy = Math.floor(s.pointer.y / CELL);
        if (sp && gx >= 0 && gy >= 0 && gx < COLS && gy < ROWS) {
          const partners: Record<string, string> = {
            slow: "burn", burn: "slow", chain: "pierce", pierce: "chain", root: "execute", execute: "root",
          };
          const need = partners[sp];
          const bondName = FOX_BONDS.find((b) => (b.a === sp && b.b === need) || (b.b === sp && b.a === need))?.name;
          if (need) {
            for (const tw of s.towers) {
              if (tw.stake || tw.sanctuary) continue;
              const osp = tw.special || towerBookRef.current[tw.def]?.special;
              if (osp !== need) continue;
              if (Math.max(Math.abs(tw.gx - gx), Math.abs(tw.gy - gy)) > 1) continue;
              // 高亮夥伴塔與預放格
              ctx.strokeStyle = "rgba(255, 200, 120, 0.95)";
              ctx.lineWidth = 2.5;
              ctx.strokeRect(tw.gx * CELL + 2, tw.gy * CELL + 2, CELL - 4, CELL - 4);
              ctx.strokeRect(gx * CELL + 2, gy * CELL + 2, CELL - 4, CELL - 4);
              ctx.fillStyle = "rgba(255, 210, 140, 0.2)";
              ctx.fillRect(gx * CELL, gy * CELL, CELL, CELL);
              if (bondName) {
                ctx.fillStyle = "#ffe08a";
                ctx.font = "bold 11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(`狐緣·${bondName}`, gx * CELL + CELL / 2, gy * CELL - 6);
                ctx.textAlign = "left";
              }
            }
          }
        }
      }

      if (tileOfferRef.current && pickTemplateRef.current) {
        const tid = pickTemplateRef.current;
        let rot = pickRotRef.current;
        const tpl = TEMPLATE_BY_ID[tid];
        // 任一旋轉可放的槽（綠底）；避免只顯示當前旋轉導致「接口看起來不能放」
        const preview = getTilePlacementPreview(boardRef.current, tid);
        const slotKeys = preview.slotKeys;
        for (const key of slotKeys) {
          const [tc, tr] = key.split(",").map(Number);
          const ox = tc * TILE * CELL;
          const oy = tr * TILE * CELL;
          const matchCur = preview.bySlot.get(key)?.includes(rot) ?? false;
          ctx.fillStyle = matchCur ? "rgba(120, 220, 180, 0.28)" : "rgba(120, 200, 255, 0.16)";
          ctx.fillRect(ox, oy, TILE * CELL, TILE * CELL);
          ctx.strokeStyle = matchCur ? "rgba(160, 255, 210, 0.95)" : "rgba(140, 210, 255, 0.75)";
          ctx.lineWidth = matchCur ? 2.5 : 1.5;
          ctx.strokeRect(ox + 2, oy + 2, TILE * CELL - 4, TILE * CELL - 4);
        }
        // 游標所在 frontier：自動選可用旋轉並畫道路形狀
        const gx = Math.floor(s.pointer.x / CELL);
        const gy = Math.floor(s.pointer.y / CELL);
        const hovTc = Math.floor(gx / TILE);
        const hovTr = Math.floor(gy / TILE);
        const hovKey = hovTc + "," + hovTr;
        const near = preview.frontierKeys.has(hovKey) || slotKeys.has(hovKey);
        if (tpl && near && hovTc >= 0 && hovTr >= 0 && hovTc < TILE_COLS && hovTr < TILE_ROWS) {
          // 優先當前旋轉，否則該槽任一可放旋轉
          const slotChoices = preview.bySlot.get(hovKey) ?? [];
          let useRot: Rot = rot;
          let canHere = slotChoices.includes(rot);
          if (!canHere && slotChoices.length) {
            useRot = slotChoices[0];
            canHere = true;
          }
          const rt = rotatedTemplate(tpl, useRot);
          const ox = hovTc * TILE * CELL;
          const oy = hovTr * TILE * CELL;
          for (let r = 0; r < TILE; r++) {
            for (let c = 0; c < TILE; c++) {
              const blocked = rt.blocked[r][c];
              const x = ox + c * CELL;
              const y = oy + r * CELL;
              if (blocked) {
                ctx.fillStyle = canHere ? "rgba(40, 70, 90, 0.55)" : "rgba(90, 40, 40, 0.45)";
              } else {
                ctx.fillStyle = canHere ? "rgba(180, 230, 255, 0.4)" : "rgba(255, 120, 100, 0.28)";
              }
              ctx.fillRect(x, y, CELL, CELL);
            }
          }
          ctx.strokeStyle = canHere ? "rgba(200, 255, 230, 0.98)" : "rgba(255, 140, 140, 0.9)";
          ctx.lineWidth = 3;
          ctx.strokeRect(ox + 1, oy + 1, TILE * CELL - 2, TILE * CELL - 2);
          // 預覽道路骨架 + 外緣路口（新怪物路線可讀性）
          {
            ctx.save();
            ctx.lineCap = "round";
            ctx.strokeStyle = canHere ? "rgba(120, 220, 255, 0.95)" : "rgba(255, 120, 120, 0.55)";
            ctx.lineWidth = 10;
            for (let r = 0; r < TILE; r++) {
              for (let c = 0; c < TILE; c++) {
                if (rt.blocked[r][c]) continue;
                const cx = ox + c * CELL + CELL / 2;
                const cy = oy + r * CELL + CELL / 2;
                if (c + 1 < TILE && !rt.blocked[r][c + 1]) {
                  ctx.beginPath();
                  ctx.moveTo(cx, cy);
                  ctx.lineTo(cx + CELL, cy);
                  ctx.stroke();
                }
                if (r + 1 < TILE && !rt.blocked[r + 1][c]) {
                  ctx.beginPath();
                  ctx.moveTo(cx, cy);
                  ctx.lineTo(cx, cy + CELL);
                  ctx.stroke();
                }
              }
            }
            for (let r = 0; r < TILE; r++) {
              for (let c = 0; c < TILE; c++) {
                if (rt.blocked[r][c]) continue;
                if (!(r === 0 || c === 0 || r === TILE - 1 || c === TILE - 1)) continue;
                const cx = ox + c * CELL + CELL / 2;
                const cy = oy + r * CELL + CELL / 2;
                ctx.fillStyle = canHere ? "rgba(255, 210, 120, 0.95)" : "rgba(255, 100, 100, 0.7)";
                ctx.beginPath();
                ctx.arc(cx, cy, 5, 0, Math.PI * 2);
                ctx.fill();
              }
            }
            ctx.restore();
          }
          ctx.fillStyle = canHere ? "#c8ffe0" : "#ffb0b0";
          ctx.font = "bold 13px sans-serif";
          const tip = !canHere
            ? "無法銜接 · 按 R 旋轉或換邊"
            : useRot !== rot
              ? `可放置 · 自動 ${useRot * 90}° · [R]旋轉`
              : `可放置 · 點確認 · [R]旋轉 ${useRot * 90}°`;
          ctx.fillText(tip, ox + 12, oy + 22);
          ctx.font = "11px sans-serif";
          ctx.fillStyle = "rgba(200, 230, 255, 0.9)";
          ctx.fillText("亮線=新道路 · 黃點=外緣路口（可能進怪）", ox + 12, oy + 40);
          if (canHere && useRot !== rot) {
            pickRotRef.current = useRot;
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
          const isHot = idx === s.hotRoute && (s.enemies?.length ?? 0) > 0;
          ctx.strokeStyle = isHot
            ? `rgba(255,90,110,${0.42 * fade})`
            : idx % 2 === 0
              ? `rgba(255,230,180,${0.18 * fade})`
              : `rgba(140,210,255,${0.16 * fade})`;
          ctx.lineWidth = isHot ? 36 : 30;
          ctx.stroke();
          ctx.strokeStyle = isHot
            ? `rgba(255,160,80,${0.28 * fade})`
            : `rgba(100,190,230,${0.12 * fade})`;
          ctx.lineWidth = isHot ? 18 : 14;
          ctx.stroke();
        }
      });

      // 狐緣：鄰格有連攜的塔之間畫淡粉連線
      {
        const book = towerBookRef.current;
        const list = s.towers.filter((tw) => !tw.stake && !tw.sanctuary);
        ctx.save();
        ctx.lineWidth = 2;
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy)) > 1) continue;
            const sa = (a as { special?: string }).special || book[a.def]?.special;
            const sb = (b as { special?: string }).special || book[b.def]?.special;
            const pair = [sa, sb].sort().join("+");
            let col: string | null = null;
            if ((sa === "slow" && sb === "burn") || (sa === "burn" && sb === "slow") ||
                (sa === "slow" && sb === "ultimate") || (sa === "ultimate" && sb === "slow"))
              col = "rgba(120,200,255,0.45)";
            else if ((sa === "chain" && sb === "pierce") || (sa === "pierce" && sb === "chain"))
              col = "rgba(140,240,255,0.5)";
            else if ((sa === "root" && sb === "execute") || (sa === "execute" && sb === "root"))
              col = "rgba(255,180,220,0.5)";
            if (!col) continue;
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // 戰線壓力條（中段）
      {
        const pressure = (s as { routePressure?: number[] }).routePressure || [];
        const maxP = Math.max(1, ...pressure, 1);
        ctx.save();
        ctx.font = "600 11px system-ui,sans-serif";
        ctx.textAlign = "center";
        routes.forEach((live, idx) => {
          if (!live.pts.length) return;
          const val = pressure[idx] || 0;
          if (val <= 0) return;
          const mid = live.pts[Math.floor(live.pts.length * 0.55)] || live.pts[0];
          const isHot = idx === s.hotRoute;
          const bw = 52;
          const ratio = Math.min(1, val / maxP);
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(mid.x - bw / 2, mid.y - 22, bw, 7);
          ctx.fillStyle = isHot ? "rgba(255,90,100,0.95)" : "rgba(120,190,255,0.85)";
          ctx.fillRect(mid.x - bw / 2, mid.y - 22, bw * ratio, 7);
          ctx.strokeStyle = isHot ? "rgba(255,200,180,0.9)" : "rgba(180,220,255,0.5)";
          ctx.strokeRect(mid.x - bw / 2, mid.y - 22, bw, 7);
          ctx.fillStyle = isHot ? "rgba(255,200,180,0.98)" : "rgba(200,230,255,0.85)";
          ctx.fillText(isHot ? `⚠ 壓力 ${val.toFixed(0)}` : `壓力 ${val.toFixed(0)}`, mid.x, mid.y - 26);
        });
        ctx.restore();
      }

      // Boss 進場位置標示
      if (s.bossMark && s.bossMark.life > 0) {
        const m = s.bossMark;
        const pulse = 0.6 + 0.4 * Math.sin(t * 6);
        ctx.save();
        ctx.strokeStyle = `rgba(255, 180, 80, ${0.5 + 0.5 * pulse})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(m.x, m.y, 28 + pulse * 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(m.x, m.y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 100, 100, ${0.7 * pulse})`;
        ctx.stroke();
        // 箭頭指向
        ctx.fillStyle = "rgba(255, 210, 120, 0.95)";
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - 48);
        ctx.lineTo(m.x - 10, m.y - 32);
        ctx.lineTo(m.x + 10, m.y - 32);
        ctx.closePath();
        ctx.fill();
        ctx.font = "bold 13px system-ui,sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffe08a";
        ctx.fillText(m.name, m.x, m.y - 54);
        ctx.font = "10px system-ui,sans-serif";
        ctx.fillStyle = "rgba(255,200,180,0.9)";
        ctx.fillText("BOSS", m.x, m.y + 44);
        ctx.restore();
      }

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
        // 視野內可建格淡綠框，避免只靠游標猜高地
        const pad = 2;
        const c0 = Math.max(0, x0 - pad);
        const c1 = Math.min(COLS - 1, x1 + pad);
        const r0 = Math.max(0, y0 - pad);
        const r1 = Math.min(ROWS - 1, y1 + pad);
        ctx.save();
        for (let rr = r0; rr <= r1; rr++) {
          for (let cc = c0; cc <= c1; cc++) {
            if (cc === gx && rr === gy) continue;
            if (!canPlace(cc, rr)) continue;
            const hx = cc * CELL;
            const hy = rr * CELL;
            ctx.strokeStyle = "rgba(140, 230, 170, 0.55)";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(hx + 3, hy + 3, CELL - 6, CELL - 6);
          }
        }
        ctx.restore();
        if (bonus > 0 && ok) {
          ctx.fillStyle = "#ffe08a";
          ctx.fillText(`高地 +${bonus}`, px - 28, py - 34);
        }
      }

      // 高地模塊已在 blocked 層繪製（height0～3）
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
            // —— 未解鎖：虛空迷霧（不畫礁石障礙）+ 緩動雲絮 ——
            const pulse = 0.5 + 0.5 * Math.sin(t * 0.7 + c * 0.15 + r * 0.11);
            const depth = 0.88 + rnd * 0.08;
            // 統一深色，避免每格不同色造成網格牆
            ctx.fillStyle = "rgba(6, 12, 22, 0.92)";
            ctx.fillRect(x, y, CELL, CELL);
            if (rnd > 0.85) {
              ctx.fillStyle = `rgba(30, 50, 80, ${0.08 + pulse * 0.05})`;
              ctx.beginPath();
              ctx.arc(x + CELL * rnd, y + CELL * rnd2, CELL * (0.2 + rnd * 0.15), 0, Math.PI * 2);
              ctx.fill();
            }
            // 漂浮雲／霧團（稀疏）
            if (rnd < 0.14) {
              const cx = x + CELL * (0.2 + rnd * 0.6) + Math.sin(t * 0.35 + r) * 3;
              const cy = y + CELL * (0.3 + rnd2 * 0.4) + Math.cos(t * 0.28 + c) * 2;
              const gr = ctx.createRadialGradient(cx, cy, 2, cx, cy, CELL * 0.7);
              gr.addColorStop(0, `rgba(160, 190, 220, ${0.1 + pulse * 0.08})`);
              gr.addColorStop(1, "rgba(160, 190, 220, 0)");
              ctx.fillStyle = gr;
              ctx.beginPath();
              ctx.ellipse(cx, cy, CELL * (0.45 + rnd * 0.25), CELL * (0.22 + rnd2 * 0.12), rnd * 0.8, 0, Math.PI * 2);
              ctx.fill();
            }
            // 鄰近已解鎖：柔邊霧
            let nearBoard = false;
            for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]] as const) {
              if (isCellOnBoard(boardRef.current, c + dc, r + dr)) {
                nearBoard = true;
                break;
              }
            }
            if (nearBoard) {
              ctx.fillStyle = `rgba(30, 70, 100, ${0.22 + pulse * 0.06})`;
              ctx.fillRect(x, y, CELL, CELL);
            }
          
          } else {
            // —— 高地：貼齊格子繪製（避免抬高造成點擊錯位）；層級靠貼圖／色階辨識 ——
            {
              const hh = cellHeight(s.heights, c, r);
              const keys = ["height0", "height1", "height2", "height3"] as const;
              const himg = s.scene[keys[Math.max(0, Math.min(3, hh))]];
              // 輕微底部陰影暗示高度，不偏移點擊區域
              if (hh > 0) {
                ctx.fillStyle = `rgba(0, 0, 0, ${0.12 + hh * 0.06})`;
                ctx.fillRect(x + 2, y + CELL - 3, CELL - 4, 3);
              }
              if (himg && himg.complete && himg.naturalWidth) {
                ctx.drawImage(himg, x, y, CELL, CELL);
              } else {
                const cols = ["#4a5a6a", "#5a7a8e", "#6a96a8", "#8ac4b8"];
                ctx.fillStyle = cols[hh] || cols[0];
                ctx.fillRect(x, y, CELL, CELL);
              }
              // 高層略亮一點，方便純視覺分辨
              if (hh >= 2) {
                ctx.fillStyle = "rgba(200, 230, 255, 0.06)";
                ctx.fillRect(x, y, CELL, CELL);
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
        if ((tw as Tower & { tideShrine?: boolean }).tideShrine) {
          // 潮紋祭壇：小型石台 + 符文光
          const py = tw.y - cellHeight(s.heights, tw.gx, tw.gy) * 5;
          ctx.save();
          ctx.translate(tw.x, py);
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.beginPath();
          ctx.ellipse(0, 10, 16, 7, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#3d5a78";
          ctx.fillRect(-14, -8, 28, 18);
          ctx.fillStyle = "#6ec8ff";
          ctx.globalAlpha = 0.55 + Math.sin(t * 2) * 0.15;
          ctx.beginPath();
          ctx.arc(0, -4, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#c8ecff";
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("祭壇", 0, 22);
          ctx.restore();
          continue;
        }
        if (tw.sanctuary) {
          const prog = hqProgRef.current;
          const pathName = prog.path ? HQ_PATH_META[prog.path].name : "未選路線";
          drawSanctuaryCastle(ctx, tw, t, pathName, s.scene);
          continue;
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
      // 護衛（獨立繪製，不依賴場上普通塔數量）
      for (const u of s.escorts) {
        if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) continue;
        const col = u.kind === "melee" ? "#ffb4a8" : u.kind === "ranged" ? "#a8e0ff" : "#b8f0c8";
        const fa = Math.max(0.25, Math.min(1, u.fade ?? 1));
        const rad = u.kind === "melee" ? 11 : 9;
        ctx.save();
        ctx.globalAlpha = 0.95 * fa;
        ctx.beginPath();
        ctx.ellipse(u.x, u.y + rad * 0.7, rad * 0.85, rad * 0.35, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(u.x, u.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(0,20,40,0.9)";
        ctx.fillText(u.kind === "melee" ? "刃" : u.kind === "ranged" ? "羽" : "癒", u.x, u.y + 3);
        const ratio = Math.max(0, u.hp / Math.max(1, u.maxHp));
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(u.x - 12, u.y - rad - 8, 24, 4);
        ctx.fillStyle = col;
        ctx.fillRect(u.x - 12, u.y - rad - 8, 24 * ratio, 4);
        ctx.restore();
      }

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
      // 3D 是主畫面；WebGL 啟動後不再讓隱藏的 2D 畫布每幀完整重繪。
      if (!terrain3DApiRef.current) draw();
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
      const rect = wrapRef.current?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
      return {
        x: ((ev.clientX - rect.left) / Math.max(1, rect.width)) * VIEWW,
        y: ((ev.clientY - rect.top) / Math.max(1, rect.height)) * VIEWH,
      };
    };
    const local = (ev: PointerEvent) => {
      const world = terrain3DApiRef.current?.screenToWorld(ev.clientX, ev.clientY);
      if (world) return world;
      const screen = screenOf(ev);
      const cam = sim.current.cam;
      const zoom = cam.zoom || 1;
      return { x: cam.x + screen.x / zoom, y: cam.y + screen.y / zoom };
    };
    const isGameSurface = (ev: PointerEvent) =>
      (ev.target as HTMLElement | null)?.closest?.("canvas[data-game3d='true']") != null;

    const onMove = (ev: PointerEvent) => {
      if (!isGameSurface(ev)) {
        sim.current.pointer.inside = false;
        return;
      }
      const world = local(ev);
      sim.current.pointer = { ...world, down: sim.current.pointer.down, inside: true };
      // 擴張預覽：游標移到最新接口時提示可否放置
      if (tileOfferRef.current && pickTemplateRef.current && phaseRef.current === "play") {
        const tid = pickTemplateRef.current;
        const gx = Math.floor(world.x / CELL);
        const gy = Math.floor(world.y / CELL);
        const tc = Math.floor(gx / TILE);
        const tr = Math.floor(gy / TILE);
        const preview = getTilePlacementPreview(boardRef.current, tid);
        const slotChoices = preview.bySlot.get(tc + "," + tr) ?? [];
        const hitRot = slotChoices.includes(pickRotRef.current) ? pickRotRef.current : slotChoices[0];
        if (hitRot !== undefined) {
          if (hitRot !== pickRotRef.current) {
            pickRotRef.current = hitRot;
            setPickRot(hitRot);
          }
          setHover("接口 (" + tc + "," + tr + ") 可接「" + (TEMPLATE_BY_ID[tid]?.name || tid) + "」· 點擊放置");
        } else if (preview.frontierKeys.has(tc + "," + tr)) {
          setHover(`接口 (${tc},${tr}) 與目前圖塊／旋轉無法銜接 · 按旋轉或換一塊`);
        }
      }

      // 選塔放置：游標下格即時提示可否建造
      if (pickRef.current !== null && phaseRef.current === "play" && !tileOfferRef.current) {
        const gx = Math.floor(world.x / CELL);
        const gy = Math.floor(world.y / CELL);
        const why = canPlaceReason(gx, gy);
        const hh = cellHeight(sim.current.heights, gx, gy);
        if (!why) setHover(`可放置 · 地勢 Lv${hh} · 射程 +${hh * 30}`);
        else setHover(`不可放：${why}`);
      }
    };
    const onUp = () => {
      sim.current.pointer.down = false;
    };
    const onLeave = () => {
      sim.current.pointer.down = false;
      sim.current.pointer.inside = false;
    };
    const onDown = (ev: PointerEvent) => {
      if (!isGameSurface(ev) || ev.button !== 0 || ev.altKey) return;
      const p = local(ev);
      sim.current.pointer = { ...p, down: true, inside: true };
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
        {
          const nearTower = s.towers.some(
            (t) => !t.stake && !t.sanctuary && Math.max(Math.abs(t.gx - gx), Math.abs(t.gy - gy)) <= 2,
          );
          setHover(
            nearTower
              ? "路障已放 · 鄰塔啟動「隘口伏擊」（加傷／短定身）"
              : "路障已放（可被近戰拆毀）· 妖潮改道 · 靠塔放置可觸發隘口伏擊",
          );
        }
        return;
      }
      // 沒有放置工具時，先以 3D 建築實際網格命中選取，再用地面距離作備援。
      // 這可避免點聖地屋頂／城牆時，因高度投影誤差而選不到本陣。
      if (pickRef.current === null && !stakeRef.current && !shrinePlaceRef.current) {
        const pickedTower = terrain3DApiRef.current?.pickTower(ev.clientX, ev.clientY);
        if (pickedTower != null && s.towers[pickedTower]) {
          selRef.current = pickedTower;
          setSel(pickedTower);
          pickRef.current = null;
          setPick(null);
          return;
        }
        for (let i = 0; i < s.towers.length; i++) {
          const tw = s.towers[i];
          const hitR = tw.sanctuary ? 112 : 42;
          if (Math.hypot(tw.x - p.x, tw.y - p.y) < hitR) {
            selRef.current = i;
            setSel(i);
            pickRef.current = null;
            setPick(null);
            return;
          }
        }
      }
      // 潮紋祭壇放置模式：任意高地
      if (shrinePlaceRef.current && phaseRef.current === "play") {
        if (tryPlaceShrineAt(gx0, gy0)) return;
      }
      const id = pickRef.current;
      const gx = gx0;
      const gy = gy0;
      if (id === null) return;
      const base = towerBookRef.current[id] ?? TOWERS[id];
      const diff = difficultyRef.current;
      const cost = Math.max(1, Math.round(base.cost * (diff.towerCostMul ?? 1)));
      const dmg = base.damage * (diff.towerDmgMul ?? 1);
      const snapped = snapPlaceCell(gx, gy);
      if (!snapped) {
        setHover(canPlaceReason(gx, gy) || (isExpandBoard(boardRef.current) ? "請點高地建塔" : "此格不可建塔"));
        return;
      }
      const pgx = snapped.gx;
      const pgy = snapped.gy;
      const snappedAway = pgx !== gx || pgy !== gy;
      if (goldRef.current < cost) {
        setHover("金幣不夠");
        return;
      }
      goldRef.current -= cost;
      setGold(goldRef.current);
      const bonus = rangeBonus(cellHeight(s.heights, pgx, pgy));
      s.towers.push({
        def: id,
        x: pgx * GRID + GRID / 2,
        y: pgy * GRID + GRID / 2,
        damage: dmg,
        cooldown: base.cooldown,
        range: base.range + bonus,
        cd: 0,
        level: 1,
        aim: 0,
        recoil: 0,
        atkT: 0,
        atkDur: 0,
        hp: 175,
        maxHp: 175,
        shake: 0,
        stake: false,
        gx: pgx,
        gy: pgy,
        rateMul: 1,
        terrorT: 0,
        spent: cost,
        targetMode: "auto",
        skills: [],
        skillShots: 0,
        special: base.special,
      });
      const hh = cellHeight(s.heights, pgx, pgy);
      const niche = hh >= 3 ? " · 峭擊" : hh === 2 ? " · 高擊" : " · 路邊伏擊";
      // 放置當下若鄰格組成狐緣，立刻提示（不必等開火）
      let bondHint = "";
      {
        const sp = base.special;
        const book = towerBookRef.current;
        for (const bond of FOX_BONDS) {
          const need = sp === bond.a ? bond.b : sp === bond.b ? bond.a : null;
          if (!need) continue;
          const hit = s.towers.some((t) => {
            if (t.stake || t.sanctuary) return false;
            if (Math.max(Math.abs(t.gx - pgx), Math.abs(t.gy - pgy)) > 1) return false;
            const tsp = (t as { special?: string }).special || book[t.def]?.special;
            return tsp === need;
          });
          if (hit) {
            bondHint = ` · 狐緣「${bond.name}」啟動`;
            float(pgx * GRID + GRID / 2, pgy * GRID + GRID / 2 - 20, bond.name, "#ffb4e0");
            break;
          }
        }
        // 同高共鳴提示
        const mates = s.towers.filter((t) => {
          if (t.stake || t.sanctuary) return false;
          if (t.gx === pgx && t.gy === pgy) return false;
          if (Math.max(Math.abs(t.gx - pgx), Math.abs(t.gy - pgy)) > 2) return false;
          return cellHeight(s.heights, t.gx, t.gy) === hh;
        }).length;
        if (mates >= 2) bondHint += " · 同高共鳴";
        else if (mates >= 1) bondHint += " · 同高相鄰";
      }
      setHover(
        (snappedAway ? "已改放到鄰近高地 · " : "") +
          (bonus > 0 ? `已放置 ${base.name} · 高地射程 +${bonus}${niche}${bondHint}` : `已放置 ${base.name}${niche}${bondHint}`),
      );
    };

    const onContext = (ev: Event) => ev.preventDefault();

    const inputSurface = wrapRef.current ?? canvas;
    inputSurface.addEventListener("pointermove", onMove);
    inputSurface.addEventListener("pointerdown", onDown);
    inputSurface.addEventListener("pointerup", onUp);
    inputSurface.addEventListener("pointercancel", onUp);
    inputSurface.addEventListener("pointerleave", onLeave);
    inputSurface.addEventListener("contextmenu", onContext);
    return () => {
      cancelAnimationFrame(raf);
      inputSurface.removeEventListener("pointermove", onMove);
      inputSurface.removeEventListener("pointerdown", onDown);
      inputSurface.removeEventListener("pointerup", onUp);
      inputSurface.removeEventListener("pointercancel", onUp);
      inputSurface.removeEventListener("pointerleave", onLeave);
      inputSurface.removeEventListener("contextmenu", onContext);
    };
  }, []);


  function applyTileBoard(board: TileBoard): boolean {
    const blocked = buildBlocked(board);
    const heights = buildHeights(board);
    const gates = collectGates(board);
    const paths = pathsForGates(blocked, gates.entrances, gates.exits);
    if (!paths || !paths.length) {
      setHover("此拼接會切斷所有通往聖地的路，請換位置或圖塊");
      return false;
    }
    boardRef.current = board;
    heightsRef.current = heights;
    entrancesRef.current = gates.entrances;
    exitsRef.current = gates.exits;
    mapRef.current = blocked;
    loadRoutes(paths);
    sim.current.blocked = blocked;
    sim.current.heights = heights;
    // 重投影場上單位到新路徑
    for (const e of sim.current.enemies) {
      const p = posAt(e.dist, e.route);
      e.route = Math.min(e.route, Math.max(0, paths.length - 1));
      e.dist = Math.min(routeLen(e.route) - 0.01, Math.max(0.01, projectDist(p.x, p.y, e.route)));
    }
    const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
    commit?.(new Set(blocked));
    return true;
  }

  function selectTileTemplate(id: string) {
    setPickTemplate(id);
    pickTemplateRef.current = id;
    const preview = getTilePlacementPreview(boardRef.current, id);
    const sug = preview.valid[0] ?? null;
    const rot = (sug?.rot ?? 0) as Rot;
    setPickRot(rot);
    pickRotRef.current = rot;
    const n = preview.valid.length;
    setHover(
      n
        ? `已選「${TEMPLATE_BY_ID[id]?.name || id}」· 可放 ${n} 處` +
          (sug ? ` · 建議接口 (${sug.tc},${sug.tr}) 轉 ${rot * 90}°` : "")
        : "此塊無法銜接，請換一塊或旋轉",
    );
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
      const best = bestRotForSlot(boardRef.current, tc, tr, id);
      if (best == null) {
        setHover("此格無法銜接道路");
        return;
      }
      rot = best;
      pickRotRef.current = rot;
      setPickRot(rot);
    }
    const next = placeTile(boardRef.current, tc, tr, id, rot);
    if (!next) {
      setHover("放置失敗");
      return;
    }
    if (!applyTileBoard(next)) {
      return;
    }
    mingSandRef.current += 1;
    setMingSand(mingSandRef.current);
    // 海底升陸與淨化波：兩道潮汐光環由新地塊中心向外擴散。
    const tileCenterX = (tc * TILE + TILE / 2) * CELL;
    const tileCenterY = (tr * TILE + TILE / 2) * CELL;
    sim.current.rings.push(
      { x: tileCenterX, y: tileCenterY, r: 12, max: TILE * CELL * 0.78, color: "#72e8dc", life: 1.35 },
      { x: tileCenterX, y: tileCenterY, r: 8, max: TILE * CELL * 0.48, color: "#f0d79c", life: 1.05 },
    );
    endTileExpand(
      `仙力牽引「${TEMPLATE_BY_ID[id]?.name || id}」自海底升起 · 道路已接通 · 黑霧退至外海 · 明潮砂 +1（${mingSandRef.current}）`,
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

  /** 只有成功放置地塊才能結束本輪淨界；每三波的選地塊流程不可略過。 */
  function endTileExpand(msg?: string) {
    lastExpandWaveRef.current = Math.max(lastExpandWaveRef.current, sim.current.wave);
    tileOfferRef.current = null;
    setTileOffer(null);
    pickTemplateRef.current = null;
    setPickTemplate(null);
    pausedRef.current = false;
    setPaused(false);
    // 立刻進入波間倒數，不會再 shouldOffer
    if (sim.current.between <= 0) sim.current.between = 0.05;
    if (msg) setHover(msg);
  }

  function clearTilePick() {
    setPickTemplate(null);
    pickTemplateRef.current = null;
    setHover("返回選塊 · 請再選模板");
  }

  function isSanctuaryFootprint(gx: number, gy: number) {
    const hq = sim.current.towers.find((t) => t.sanctuary);
    // 僅本體周圍 1 格（切比雪夫），避免大半張 HQ 地塊不能放塔
    if (hq && Math.max(Math.abs(hq.gx - gx), Math.abs(hq.gy - gy)) <= 1) return true;
    for (const p of boardRef.current.placed) {
      if (p.templateId !== "hq") continue;
      const lc = gx - p.tc * TILE;
      const lr = gy - p.tr * TILE;
      // 核心約 4×4
      if (lc >= 8 && lc <= 11 && lr >= 8 && lr <= 11) return true;
    }
    return false;
  }

  /**
   * 地表可建性：高度 0、1、2、3 都能放塔，高度只提供射程加成。
   * 擴張模式的 blocked=true 代表非道路高地；完整地圖的 blocked=true 代表障礙。
   */
  function isBuildableSurface(gx: number, gy: number) {
    const blocked = sim.current.blocked.has(cellKey(gx, gy));
    return isExpandBoard(boardRef.current) ? blocked : !blocked;
  }

  function canPlace(gx: number, gy: number) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
    if (!isCellOnBoard(boardRef.current, gx, gy)) return false;
    if (gateHere(gx, gy)) return false;
    if (isSanctuaryFootprint(gx, gy)) return false;
    // 不用高度值當作禁建條件：1～3 級高地同樣可建，並保留高地射程優勢。
    if (!isBuildableSurface(gx, gy)) return false;
    if (sim.current.towers.some((t) => t.gx === gx && t.gy === gy)) return false;
    return true;
  }

  /** 點到路／邊緣時，改放到游標最近的鄰格高地（切比雪夫 1） */
  function snapPlaceCell(gx: number, gy: number): { gx: number; gy: number } | null {
    if (canPlace(gx, gy)) return { gx, gy };
    const px = sim.current.pointer.x;
    const py = sim.current.pointer.y;
    let best: { gx: number; gy: number } | null = null;
    let bestD = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;
        const x = gx + dc;
        const y = gy + dr;
        if (!canPlace(x, y)) continue;
        const d = Math.hypot(x * CELL + CELL / 2 - px, y * CELL + CELL / 2 - py);
        if (d < bestD) {
          bestD = d;
          best = { gx: x, gy: y };
        }
      }
    }
    // 只在游標其實更靠近那一格中心時吸附，避免隔一條路亂跳
    if (!best) return null;
    const here = Math.hypot(gx * CELL + CELL / 2 - px, gy * CELL + CELL / 2 - py);
    if (bestD + 6 < here) return best;
    return null;
  }

  function canPlaceReason(gx: number, gy: number): string | null {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return "超出地圖";
    if (!isCellOnBoard(boardRef.current, gx, gy)) return "未解鎖地塊";
    if (gateHere(gx, gy)) return "出入口不可建";
    if (isSanctuaryFootprint(gx, gy)) return "聖地範圍不可建";
    if (!isBuildableSurface(gx, gy)) {
      return isExpandBoard(boardRef.current) ? "道路不可建，請點高地" : "障礙／路障不可建";
    }
    if (sim.current.towers.some((t) => t.gx === gx && t.gy === gy)) return "此格已有建築";
    return null;
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
    lastStandRef.current = false;
    comboRef.current = { n: 0, t: 0, best: 0 };
    waveFirstKillRef.current = true;
    waveStyleRef.current = { leaked: false, highlandKills: 0, stakeAssists: 0 };
    tideRef.current = null;
    freeEscortRef.current = 0;
    setPhase("play");
    setTileOffer(null);
    tileOfferRef.current = null;

    // 依主選單選擇：地塊擴張 或 完整關卡／自訂地圖
    if (mapMode === "expand") {
      // 中央聖地 → 四向自動拼接（至少一條戰線）
      let board = seedBoard();
      board = bootstrapFrontiers(board, runTileBias);
      boardRef.current = board;
      if (!applyTileBoard(board)) {
        // 極端：再強塞一裂口
        board = bootstrapFrontiers(seedBoard(), { ...runTileBias, chaos: 0 });
        applyTileBoard(board);
      }
      const fronts = entrancesRef.current.length;
      setActiveMap("潮汐擴張");
      setHover(`聖地已展開 · 戰線 ${Math.max(fronts, 1)} 條 · 先佈署再按「開始第 1 波」`);
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
          applyTileBoard(board);
          spawnSanctuaryTower();
        } else {
          setActiveMap(layout.name);
          // 完整關卡不啟用地塊擴張（board 標記為「已滿圖」避免誤觸發）
          boardRef.current = { placed: [], playerBlocked: new Set() };
          // 完整關卡也必須建立可選取、可升級的遊戲聖地實體。
          spawnSanctuaryTower();
        }
      }
    }

    setWorkshop(false);
    setPaused(false);
    pausedRef.current = false;
    const commit = (canvasRef.current as HTMLCanvasElement & { __commit?: (n: Set<string>) => boolean }).__commit;
    commit?.(new Set(mapRef.current));
    // 開局備戰：先放塔，不自動出怪；按「開始第 1 波」才开战
    sim.current.wave = 0;
    sim.current.queue = [];
    sim.current.enemies = [];
    sim.current.between = 0;
    (sim.current as { prepGoldGiven?: number }).prepGoldGiven = 0;
    (sim.current as { prepGoldAcc?: number }).prepGoldAcc = 0;
    setWave(0);
    // 預設適中縮放並對準大本，避免玩家找不到聖地
    sim.current.cam.zoom = Math.max(sim.current.cam.zoom || 1, 0.85);
    focusCameraOnSanctuary();
    setHover("備戰中 · 視角已對準聖地 · 先放置狐仙／路障，再按「開始第 1 波」");
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


  function deleteSavedMap(id: string) {
    const next = savedMaps.filter((m) => m.id !== id);
    setSavedMaps(next);
    writeSavedMaps(next);
    if (selectedLevelId === id) {
      setSelectedLevelId("mode-expand");
      setMapMode("expand");
      setActiveMap("潮汐擴張");
    }
    setHover("已刪除自訂地圖");
  }

  /** 修改難度欄位：自訂檔自動寫入 localStorage；內建則另存為自訂並切換過去 */
  function patchDifficulty(partial: Partial<DifficultyProfile>) {
    const cur = getDifficulty(difficultyId);
    let next: DifficultyProfile;
    if (cur.builtin) {
      next = {
        ...cur,
        ...partial,
        id: `custom-${Date.now()}`,
        label: (diffName.trim() || cur.label + "·改").slice(0, 12),
        builtin: false,
      };
    } else {
      next = { ...cur, ...partial, builtin: false };
      if (partial.label) next.label = String(partial.label).slice(0, 12);
    }
    upsertCustomDifficulty(next);
    setDiffList(allDifficulties());
    setDifficultyId(next.id);
    difficultyRef.current = next;
    setDiffName(next.label);
    setHover(`難度「${next.label}」已自動儲存`);
  }

  function removeCustomDifficulty(id: string) {
    const cur = getDifficulty(id);
    if (cur.builtin) {
      setHover("內建難度無法刪除");
      return;
    }
    deleteCustomDifficulty(id);
    setDiffList(allDifficulties());
    if (difficultyId === id) {
      setDifficultyId("normal");
      difficultyRef.current = getDifficulty("normal");
    }
    setHover("已刪除自訂難度");
  }

    function callWave() {
    const c = canvasRef.current as HTMLCanvasElement & { __begin?: () => void };
    const s = sim.current;
    // 備戰（wave=0）：直接開第 1 波，無提前金
    if (s.wave === 0 && s.enemies.length === 0 && s.queue.length === 0) {
      c.__begin?.();
      setHover("第 1 波開始");
      return;
    }
    if (s.enemies.length === 0 && s.queue.length === 0 && s.wave > 0 && (endless || s.wave < (waves?.length || MAX_WAVE))) {
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
      {
        const def = SKILL_BY_ID[skillId];
        const pn = def ? SKILL_PATH_META[def.path].name : "";
        const paths = [...ownedSkillPaths(tw.skills)];
        const lock =
          paths.length >= 2
            ? ` · 雙修 ${paths.map((p) => SKILL_PATH_META[p].name).join("、")}（第三鎖死）`
            : paths.length === 1
              ? ` · 已開「${SKILL_PATH_META[paths[0]].name}」`
              : "";
        setHover(`習得「${skillLabelShort(skillId)}」[${pn}]${lock}`);
      }
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
    // 關鍵等級小偏科（參考 KR 中段直線強化）：延續玩家選的傷／速方向
    if (tw.level === 5 || tw.level === 10 || tw.level === 15) {
      if (kind === "dmg") {
        tw.damage *= 1.1;
        tw.range += 8;
      } else {
        tw.cooldown = Math.max(0.16, tw.cooldown * 0.9);
        tw.range += 4;
      }
    }
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

  

  /** 鏡頭對準聖地（大本）中心，開局／換圖後呼叫 */
  function focusCameraOnSanctuary() {
    const s = sim.current;
    const z = s.cam.zoom || 1;
    // 優先已生成的聖地塔
    const hqTw = s.towers.find((t) => t.sanctuary);
    if (hqTw) {
      s.cam.x = hqTw.x - VIEWW / (2 * z);
      s.cam.y = hqTw.y - VIEWH / (2 * z);
      clampCam(s.cam);
      terrain3DApiRef.current?.focus(hqTw.x, hqTw.y);
      return;
    }
    // 擴張模式：HQ 地塊中心
    const hq = boardRef.current.placed.find((p) => p.templateId === "hq");
    if (hq) {
      const cx = (hq.tc * TILE + TILE / 2) * CELL;
      const cy = (hq.tr * TILE + TILE / 2) * CELL;
      s.cam.x = cx - VIEWW / (2 * z);
      s.cam.y = cy - VIEWH / (2 * z);
      clampCam(s.cam);
      terrain3DApiRef.current?.focus(cx, cy);
      return;
    }
    // 完整地圖：出口／入口中心
    const exits = exitsRef.current;
    if (exits.length) {
      let sx = 0, sy = 0;
      for (const g of exits) {
        sx += (g.c + 0.5) * CELL;
        sy += (g.r + 0.5) * CELL;
      }
      s.cam.x = sx / exits.length - VIEWW / (2 * z);
      s.cam.y = sy / exits.length - VIEWH / (2 * z);
      clampCam(s.cam);
    }
  }

  function spawnSanctuaryTower() {
    const board = boardRef.current;
    const hq = board.placed.find((p) => p.templateId === "hq");
    // 去掉舊聖地
    sim.current.towers = sim.current.towers.filter((t) => !t.sanctuary);
    sim.current.escorts = [];

    let gx: number;
    let gy: number;
    if (hq) {
      const originC = hq.tc * TILE;
      const originR = hq.tr * TILE;
      // 擴張模式：建築中心約在 HQ 地塊內 9.5, 9.5 格
      gx = originC + 9;
      gy = originR + 9;
    } else {
      // 完整／自訂地圖沒有 HQ 地塊：將聖地放在出口群朝地圖內側約 3 格處。
      // 位置搜尋避開障礙格與出入口，並確保 6×6 外觀留在地圖內。
      const exits = exitsRef.current.length ? exitsRef.current : defaultExits();
      const exitX = exits.reduce((sum, gate) => sum + gate.c + 0.5, 0) / exits.length;
      const exitY = exits.reduce((sum, gate) => sum + gate.r + 0.5, 0) / exits.length;
      let inwardX = COLS / 2 - exitX;
      let inwardY = ROWS / 2 - exitY;
      const inwardLength = Math.hypot(inwardX, inwardY) || 1;
      inwardX /= inwardLength;
      inwardY /= inwardLength;
      const targetX = exitX + inwardX * 3.2;
      const targetY = exitY + inwardY * 3.2;
      const baseGx = Math.max(3, Math.min(COLS - 4, Math.round(targetX - 0.5)));
      const baseGy = Math.max(3, Math.min(ROWS - 4, Math.round(targetY - 0.5)));
      let best: { gx: number; gy: number; score: number } | null = null;
      for (let dr = -6; dr <= 6; dr++) {
        for (let dc = -6; dc <= 6; dc++) {
          const c = baseGx + dc;
          const r = baseGy + dr;
          if (c < 3 || r < 3 || c >= COLS - 3 || r >= ROWS - 3) continue;
          if (sim.current.blocked.has(cellKey(c, r)) || gateHere(c, r)) continue;
          const height = cellHeight(sim.current.heights, c, r);
          const score = Math.hypot(c + 0.5 - targetX, r + 0.5 - targetY) + height * 0.035;
          if (!best || score < best.score) best = { gx: c, gy: r, score };
        }
      }
      gx = best?.gx ?? baseGx;
      gy = best?.gy ?? baseGy;
    }
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
      hp: stats.maxHp,
      maxHp: stats.maxHp,
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
      hqFireLv: 0,
      hqFortifyLv: 0,
      escortCd: 3,
      hqTurretAtk: [0, 0, 0, 0],
      hqCannonAtk: 0,
      hqBuildFlash: 0.6,
    });
    hqProgRef.current = defaultHqProgress();
    hqBuffRef.current = defaultHqBuff();
    sim.current.escorts = [];
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
    // 潮息換位：拆塔留下短時薄霧，方便重佈時擋一下線
    {
      const sx = tw.x;
      const sy = tw.y;
      for (const e of sim.current.enemies) {
        if (e.hp <= 0 || e.noslow) continue;
        const ep = posAt(e.dist, e.route);
        if (Math.hypot(ep.x - sx, ep.y - sy) > 85) continue;
        e.slow = Math.min(e.slow, 0.7);
        e.slowT = Math.max(e.slowT, 0.9);
      }
      sim.current.rings.push({ x: sx, y: sy, r: 10, max: 85, life: 0.4, color: "#a8d4ff" });
    }
    sim.current.towers.splice(idx, 1);
    selRef.current = null;
    setSel(null);
    setHover(`賣出 +${refund} · 潮息薄霧`);
  }


  function upgradeSanctuaryCore(branch: "fire" | "fortify") {
    const idx = selRef.current ?? sel;
    if (idx === null) return;
    const tw = sim.current.towers[idx];
    if (!tw?.sanctuary) return;
    if (branch === "fire" && (tw.hqFireLv ?? 0) >= HQ_FIRE_MAX) {
      setHover(`聖砲已達上限（最多 ${HQ_FIRE_MAX} 次）`);
      return;
    }
    if (branch === "fortify" && (tw.hqFortifyLv ?? 0) >= HQ_FORT_MAX) {
      setHover(`加固已達上限（最多 ${HQ_FORT_MAX} 次）`);
      return;
    }
    const lv = tw.hqCoreLv ?? 1;
    const cost = coreUpgradeCost(lv);
    if (goldRef.current < cost) {
      setHover(`金幣不足（需要 ${cost}）`);
      return;
    }
    goldRef.current -= cost;
    setGold(goldRef.current);
    tw.hqCoreLv = lv + 1;
    tw.level = tw.hqCoreLv;
    tw.spent = (tw.spent || 0) + cost;
    if (branch === "fire") tw.hqFireLv = (tw.hqFireLv ?? 0) + 1;
    else tw.hqFortifyLv = (tw.hqFortifyLv ?? 0) + 1;
    const st = sanctuaryStats(tw);
    tw.damage = st.damage;
    tw.range = st.range;
    tw.cooldown = st.cooldown;
    const prevMax = tw.maxHp;
    tw.maxHp = st.maxHp;
    if (branch === "fortify") {
      tw.hp = Math.min(tw.maxHp, tw.hp + Math.max(50, tw.maxHp - prevMax));
    } else {
      tw.hp = Math.min(tw.maxHp, tw.hp + Math.max(20, Math.floor((tw.maxHp - prevMax) * 0.5)));
    }
    const tag = branch === "fire" ? "火力" : "加固";
    tw.hqBuildFlash = 1;
    if (branch === "fire") {
      const fl = tw.hqFireLv ?? 0;
      if (fl === 1) {
        float(tw.x, tw.y - 40, "四角砲台就位", "#ffd2a8");
        setHover(`聖地火力 · 四角砲台展開！Lv.${tw.hqCoreLv}（−${cost}）`);
      } else if (fl === 2) {
        float(tw.x, tw.y - 48, "屋頂聖砲就位", "#ffe08a");
        setHover(`聖地火力 · 屋頂聖砲部署！Lv.${tw.hqCoreLv}（−${cost}）`);
      } else {
        float(tw.x, tw.y - 40, "聖砲強化", "#ffe08a");
        setHover(`聖地${tag} → 總Lv.${tw.hqCoreLv}（火${fl}/固${tw.hqFortifyLv ?? 0}）（−${cost}）`);
      }
    } else {
      float(tw.x, tw.y - 40, "城牆加固", "#9ad7ff");
      setHover(
        `聖地加固 → 總Lv.${tw.hqCoreLv}（火${tw.hqFireLv ?? 0}/固${tw.hqFortifyLv ?? 0}）· ${Math.round(tw.hp)}/${tw.maxHp} · 漏抗 ${Math.round(st.leakResist * 100)}%（−${cost}）`,
      );
    }
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
    if (goldRef.current < HQ_ESCORT_COST && freeEscortRef.current <= 0) {
      if (force) setHover(`護衛動員需要 ${HQ_ESCORT_COST} 金`);
      return;
    }
    // 威脅：離聖地最近的怪
    // 只打「最靠近聖地」那一條線的怪
    let threat: Enemy | null = null;
    let bestScore = -1e15;
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      const pos = posAt(e.dist, e.route);
      const distHq = Math.hypot(pos.x - hq.x, pos.y - hq.y);
      const score = e.dist * 2 - distHq * 0.15;
      if (score > bestScore) {
        bestScore = score;
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
    // 從聖地錨點派出，沿路迎敵（不刷在怪臉上）
    const hqAnchor = projectDist(hq.x, hq.y, route);
    const baseDist = Math.min(live.len - 12, Math.max(live.len * 0.7, hqAnchor + 8));
    if (freeEscortRef.current > 0) {
      freeEscortRef.current -= 1;
      setHover("動用免費護衛名額");
    } else {
      goldRef.current -= HQ_ESCORT_COST;
      setGold(goldRef.current);
    }
    const wave = Math.max(0, s.wave);
    hq.escortCd = Math.max(5, p.deployCd - Math.floor(wave / 5)) * (tideRef.current?.id === "sanctuary_roar" ? 0.7 : 1);
    const squadN = Math.min(18, p.squad + Math.floor(wave / 4));
    const hpMul = 1 + Math.min(1.25, wave * 0.045);
    // 擴充 composition：波次補遠程／治療名額
    const kinds: EscortKind[] = [];
    let rangedLeft = (p.ranged ? p.mixRanged : 0) + Math.floor(wave / 8);
    let healLeft = (p.healer ? p.mixHealer : 0) + Math.floor(wave / 10);
    if (!p.ranged) rangedLeft = 0;
    if (!p.healer) healLeft = 0;
    for (let i = 0; i < squadN; i++) {
      if (rangedLeft > 0) {
        kinds.push("ranged");
        rangedLeft--;
      } else if (healLeft > 0) {
        kinds.push("healer");
        healLeft--;
      } else kinds.push("melee");
    }
    const room = Math.max(0, 28 - s.escorts.length);
    kinds.slice(0, room).forEach((kind, i) => {
      const dist = Math.max(20, baseDist - i * 12);
      const pos = posAt(dist, route);
      const maxHp = Math.round(
        (kind === "melee" ? p.meleeHp : kind === "ranged" ? p.meleeHp * 0.55 : p.meleeHp * 0.65) * hpMul,
      );
      s.escorts.push({
        id: __escortSeq++,
        kind,
        x: pos.x,
        y: pos.y,
        hp: maxHp,
        maxHp,
        route,
        dist,
        speed: 100,
        contactT: 0,
        shootCd: 0.25 * i,
        healCd: 1.0,
        fade: 1,
      });
    });
    setHover(
      `護衛出動 ×${Math.min(kinds.length, room)}（波${wave} 編制加成 +${Math.floor(wave / 4)}）· 移速100 · −${HQ_ESCORT_COST} 金`,
    );
  }


  function placeTideShrine() {
    const b = hqBuffRef.current;
    if (b.blueprints < 1) {
      setHover("需要潮紋圖紙（Boss 必掉／精英約 22%）");
      return;
    }
    if (goldRef.current < SHRINE_PLACE_GOLD) {
      setHover(`需要 ${SHRINE_PLACE_GOLD} 金`);
      return;
    }
    shrinePlaceRef.current = true;
    pickRef.current = null;
    setPick(null);
    stakeRef.current = false;
    setHover(`潮紋祭壇：點任意高地放置（圖紙×1 + ${SHRINE_PLACE_GOLD}金）· 可建多座 · Esc 取消`);
  }

  function tryPlaceShrineAt(gx: number, gy: number): boolean {
    if (!shrinePlaceRef.current) return false;
    const b = hqBuffRef.current;
    if (b.blueprints < 1) {
      setHover("圖紙不足");
      shrinePlaceRef.current = false;
      return true;
    }
    if (goldRef.current < SHRINE_PLACE_GOLD) {
      setHover(`需要 ${SHRINE_PLACE_GOLD} 金`);
      return true;
    }
    if (!canPlace(gx, gy)) {
      setHover("只能放在空高地（非道路／聖地）");
      return true;
    }
    goldRef.current -= SHRINE_PLACE_GOLD;
    setGold(goldRef.current);
    b.blueprints -= 1;
    b.shrineCount += 1;
    bumpHqBuff();
    sim.current.towers.push({
      def: 0,
      x: gx * GRID + GRID / 2,
      y: gy * GRID + GRID / 2,
      damage: 0,
      cooldown: 99,
      range: 40,
      cd: 0,
      level: 1,
      aim: 0,
      recoil: 0,
      atkT: 0,
      atkDur: 0,
      hp: 200,
      maxHp: 200,
      shake: 0,
      stake: false,
      gx,
      gy,
      rateMul: 1,
      terrorT: 0,
      spent: SHRINE_PLACE_GOLD,
      sanctuary: false,
      tideShrine: true,
    } as Tower & { tideShrine?: boolean });
    shrinePlaceRef.current = false;
    setHover(`潮紋祭壇 #${b.shrineCount} 已建 · 加持階越後越貴越強`);
    return true;
  }

  function pickHqBuff(id: HqBuffId) {
    const b = hqBuffRef.current;
    if (b.shrineCount < 1) {
      setHover("請先至少建造一座潮紋祭壇");
      return;
    }
    if (b.tier >= 3) {
      setHover("加持已滿（3/3）");
      return;
    }
    const need = b.tier + 1;
    const opts = hqBuffChoices(need);
    const opt = opts.find((o) => o.id === id);
    if (!opt) return;
    if (goldRef.current < opt.cost) {
      setHover(`第 ${need} 階加持需要 ${opt.cost} 金`);
      return;
    }
    goldRef.current -= opt.cost;
    setGold(goldRef.current);
    b.picks.push(id);
    b.tier = need;
    const p = hqProgRef.current;
    if (id === "escort_cd") p.deployCd = Math.max(5, p.deployCd - 3);
    if (id === "escort_hp") p.meleeHp = Math.round(p.meleeHp * 1.32);
    if (id === "free_escort") {
      freeEscortRef.current += 3;
      b.freePerWave += 1;
    }
    const hq = sim.current.towers.find((t) => t.sanctuary);
    if (hq) {
      const st = sanctuaryStats(hq, b.picks);
      const ratio = hq.hp / Math.max(1, hq.maxHp);
      hq.damage = st.damage;
      hq.range = st.range;
      hq.cooldown = st.cooldown;
      hq.maxHp = st.maxHp;
      hq.hp = Math.min(st.maxHp, Math.max(1, Math.round(st.maxHp * ratio)));
    }
    bumpHqBuff();
    setHover(`加持「${opt.name}」· ${b.tier}/3 · −${opt.cost} 金`);
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
        shrinePlaceRef.current = false;
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
      if (key === "h" || key === "H") {
        if (phaseRef.current === "play") {
          focusCameraOnSanctuary();
          setHover("視角已對準聖地 [H]");
        }
        return;
      }
      if (key === " " || key === "Enter") {
        if (phaseRef.current === "play" && !pausedRef.current) {
          ev.preventDefault();
          callWave();
        }
        return;
      }
      if (key === "g" || key === "G") {
        // 手動動員護衛
        if (phaseRef.current === "play") deployEscortSquad(true);
        return;
      }
      if (key === "r" || key === "R") {
        if (tileOfferRef.current && pickTemplateRef.current) {
          rotatePickTile();
          ev.preventDefault();
        }
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
  const sanctuaryForHud = sim.current.towers.find((tower) => tower.sanctuary);
  const sanctuaryCoreProgress = Math.max(0, Math.min(1, ((sanctuaryForHud?.hqCoreLv ?? 1) - 1) / 10));
  const sanctuaryBuffProgress = Math.max(0, Math.min(1, hqBuffRef.current.tier / 3));
  const sanctuaryShrineProgress = Math.max(0, Math.min(1, hqBuffRef.current.shrineCount / 4));
  const sanctuaryChargeProgress = Math.max(0, Math.min(1, sanctuaryForHud?.hqCharge ?? 0));
  const sanctuaryPowerForHud = Math.max(
    0.12,
    Math.min(1, 0.12 + sanctuaryCoreProgress * 0.58 + sanctuaryBuffProgress * 0.22 + sanctuaryShrineProgress * 0.08 + sanctuaryChargeProgress * 0.08),
  );

  return (
    <div className="td-shell">
      <header className="mx-auto flex max-w-[1320px] items-end justify-between px-4 pt-4">
        <div>
          <p className="text-xs tracking-[0.28em] text-[#8ec8ee]">UNDERWATER WARD</p>
          <h1 className="font-['Cormorant_Garamond'] text-4xl leading-none text-[#ffe7f1]">狐仙塔防</h1>
        </div>
        <p className="hidden text-sm text-[#9ec4de] sm:block">
Alt＋左鍵環視 · 右鍵平移 · 滾輪縮放 · [H]對準聖地 · [空格]下一波 · [G]護衛 · [D/F]升級
        </p>
      </header>
      <div className="td-layout">
        <div className="stage" ref={wrapRef}>
          <Terrain3DMap snapshotRef={terrain3DSnapshotRef} apiRef={terrain3DApiRef} />
          <canvas ref={canvasRef} width={VIEWW} height={VIEWH} style={{ display: "none" }} />
          <div className="hud-float">
            <div className="chip" title="聖地建築耐久（漏怪依怪物剩餘生命扣血）">
              {(() => {
                const hq = sim.current.towers.find((t) => t.sanctuary);
                if (!hq) return `結界 ${lives}`;
                const pct = hq.maxHp > 0 ? hq.hp / hq.maxHp : 0;
                const tag = pct <= 0.28 && pct > 0 ? " · 背水" : "";
                return `聖地 ${Math.round(hq.hp)}/${hq.maxHp}${tag}`;
              })()}
            </div>
            <div className="chip">金幣 {gold}</div>
            {phase === "play" && isExpandBoard(boardRef.current) && (
              <div className="chip" title="聖地升級與潮紋祭壇加持會增強淨界，削弱外緣黑霧">
                聖地淨界 {Math.round(sanctuaryPowerForHud * 100)}%
              </div>
            )}
            {phase === "play" && (
              <div className="chip" title="可連通聖地的進怪入口">
                戰線 {Math.max(1, entrancesRef.current.length || 1)}
              </div>
            )}
            {phase === "play" && isExpandBoard(boardRef.current) && (
              <div className="chip" title="重骰地塊用">明潮砂 {mingSand}</div>
            )}
            <div className="chip">
              {wave === 0 && phase === "play"
                ? "備戰中 · 放塔後開戰"
                : `波次 ${wave}${endless ? " · 無盡" : `/${waves?.length || MAX_WAVE}`}`}
              {wave > 0 && speed === 10 ? " · 10倍" : ""}
              {wave > 0 && waveQuirk(wave) ? ` · ${waveQuirk(wave)!.name}` : ""}
            </div>
            {comboRef.current.n >= 3 && phase === "play" && (
              <div className="chip" style={{ borderColor: "#ff9ecd", color: "#ffd0ea" }}>
                連殺 ×{comboRef.current.n}
              </div>
            )}
            {tideRef.current && phase === "play" && (
              <div className="chip" style={{ borderColor: "#7ec8ff", color: "#c5e8ff" }} title={tideRef.current.desc}>
                潮汐 · {tideRef.current.name}
              </div>
            )}
            {freeEscortRef.current > 0 && (
              <div className="chip" style={{ borderColor: "#ffe08a", color: "#ffe08a" }}>
                免費護衛 ×{freeEscortRef.current}
              </div>
            )}
          </div>
          {phase === "play" && bossBannerUi && (
            <div
              className="overlay"
              style={{
                background: "rgba(8,4,16,0.55)",
                pointerEvents: "none",
                justifyContent: "flex-start",
                paddingTop: "18%",
              }}
            >
              <h2 style={{ color: "#ffd27a", textShadow: "0 0 24px #ff6a80" }}>
                {bossBannerUi.name}
              </h2>
              <p className="text-sm text-[#ffc8d8]">Boss 來襲 · 戰線壓力將集中</p>
              <p className="mt-1 text-xs text-[#c5dff2]">
                招式：{bossBannerUi.skills.join(" · ")}
              </p>
            </div>
          )}
          {phase === "play" && skillOffer && (
            <div className="overlay" style={{ maxHeight: "90vh", overflowY: "auto" }}>
              <h2>塔覺醒 · 路徑三選一</h2>
              <p className="mb-1 max-w-md text-sm text-[#c5dff2]">
                {sim.current.towers[skillOffer.towerIndex]
                  ? (towerBook[sim.current.towers[skillOffer.towerIndex].def]?.name || "塔")
                  : "塔"}{" "}
                升至 Lv.{skillOffer.level} — 選一項（立即生效）
              </p>
              <p className="mb-2 max-w-md text-[11px] text-[#9ec4de]">
                {(() => {
                  const tw = sim.current.towers[skillOffer.towerIndex];
                  const paths = [...ownedSkillPaths(tw?.skills)];
                  if (!paths.length) return "路徑：锋锐／潮控／裂域 — 最多修兩條，第三條永久鎖死";
                  if (paths.length === 1) {
                    const m = SKILL_PATH_META[paths[0]];
                    return `已開「${m.name}」· 再開一條後，其餘路徑鎖死`;
                  }
                  const names = paths.map((p) => SKILL_PATH_META[p].name).join("、");
                  return `雙修「${names}」· 第三路徑已鎖死（本塔）`;
                })()}
              </p>
              <div className="flex max-w-lg flex-col gap-2">
                {skillOffer.choices.map((c) => (
                  <button
                    key={c.id}
                    className="btn"
                    style={{ borderColor: c.color, textAlign: "left" }}
                    onClick={() => pickSkillChoice(c.id)}
                  >
                    <b style={{ color: c.color }}>
                      {c.name}
                      <span className="ml-2 text-[10px] font-normal" style={{ color: SKILL_PATH_META[c.path].color }}>
                        [{SKILL_PATH_META[c.path].name}]
                      </span>
                    </b>
                    <span className="mt-0.5 block text-[10px] font-normal text-[#8eb6d0]">{SKILL_PATH_META[c.path].tag}</span>
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
            <>
              {/* 未選模板：半透明遮罩 + 中央選塊 */}
              {!pickTemplate && (
                <div
                  className="overlay"
                  style={{
                    background: "rgba(6,14,24,0.78)",
                    justifyContent: "center",
                    paddingTop: 24,
                  }}
                >
                  <div
                    style={{
                      background: "rgba(8,18,32,0.94)",
                      borderRadius: 14,
                      padding: 18,
                      maxWidth: 460,
                      width: "92%",
                      border: "1px solid rgba(120,180,255,0.25)",
                      boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
                    }}
                  >
                    <h2 style={{ marginTop: 0 }}>聖地淨界 · 選擇升起的地塊</h2>
                    <p className="mb-2 text-sm text-[#c5dff2]">
                      第 {wave} 波結束。每三波必須選擇並放置一塊新地，戰線才會延伸；完成前戰鬥保持暫停。
                    </p>
                    <p className="mb-2 text-xs leading-5 text-[#9ad7ff]">
                      聖地以仙力牽引海底地脈，使新地塊升出海面；外緣黑霧持續侵蝕未淨化之地，升級聖地與建造潮紋祭壇可增強淨界。
                    </p>
                    <p className="mb-2 text-xs text-[#9ad7ff]">
                      明潮砂 <b className="text-[#ffe08a]">{mingSand}</b>
                      （重骰一格消耗 {MING_SAND_REROLL_COST}）
                    </p>
                    <div className="mb-3 flex flex-wrap justify-center gap-3">
                      {tileOffer.map((id, index) => {
                        const nPlace = getTilePlacementPreview(boardRef.current, id).valid.length;
                        const tpl = TEMPLATE_BY_ID[id];
                        const rt = tpl ? rotatedTemplate(tpl, 0) : null;
                        return (
                          <div key={`${id}-${index}`} className="flex flex-col items-center gap-1">
                            <button
                              type="button"
                              className="btn"
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
                            >
                              重骰此格
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              {/* 已選模板：無全屏遮罩，僅頂部工具條，地圖可點 */}
              {pickTemplate && (
                <div
                  style={{
                    position: "absolute",
                    top: 10,
                    left: "50%",
                    transform: "translateX(-50%)",
                    zIndex: 25,
                    pointerEvents: "auto",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: "8px 12px",
                    maxWidth: "min(560px, 94%)",
                    background: "rgba(8,20,36,0.94)",
                    borderRadius: 12,
                    border: "1px solid rgba(120,180,255,0.3)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                  }}
                >
                  <span className="text-sm text-[#e7f6ff]">
                    放置：<b className="text-[#ffe7f1]">{TEMPLATE_BY_ID[pickTemplate]?.name || pickTemplate}</b>
                  </span>
                  <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={rotatePickTile} title="快捷鍵 R">
                    旋轉 {pickRot * 90}°
                  </button>
                  <button className="btn ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={clearTilePick}>
                    返回選塊
                  </button>
                  <span className="text-[11px] text-[#9ad7ff]">
                    綠格可放 · 點地圖升起新地 · 放置前無法繼續波次
                  </span>
                </div>
              )}
            </>
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
            <div className="overlay menu-overlay">
              <div className="menu-shell">
              <div className="menu-hero">
                <p className="menu-kicker">UNDERWATER WARD</p>
                <h2 className="menu-title">{phase === "win" ? "潮退，聖地仍在" : phase === "lose" ? "結界破碎" : "狐仙結界"}</h2>
                <p className="menu-lead">
                  {phase === "ready"
                    ? "深淵黑霧吞噬海上的殘土。聖地以仙力淨化海域、牽引海底地脈升起新土；唯有持續充能，才能為狐仙重建安居之所。"
                    : phase === "win"
                      ? "十二波妖潮已被擋下，結界依然完整。"
                      : "生命歸零。重整佈署，再試一次。"}
                </p>
              </div>
              {phase === "ready" && (
                <div className="menu-grid">
                <section className="menu-card">
                  <h3 className="menu-card-title">選擇開局</h3>
                  <p className="menu-card-hint">擴張模式每三波必須升起一塊新地，讓戰線延伸並把黑霧推回深海</p>
                  <div className="menu-btn-row">
                    <button
                      className={"btn menu-pill" + (selectedLevelId === "mode-expand" ? " on" : " ghost")}
                      onClick={() => selectLevel("mode-expand", "expand")}
                      title="從小地圖開始；每 3 波必須選擇並放置新地塊，不可略過"
                    >
                      潮汐擴張 <span className="menu-pill-tag">推薦</span>
                    </button>
                  </div>
                  <h4 className="menu-sub">預設關卡</h4>
                  <div className="menu-btn-row">
                    {presetMaps().map((m) => (
                      <button
                        key={m.id}
                        className={"btn menu-pill" + (selectedLevelId === m.id ? " on" : " ghost")}
                        onClick={() => selectLevel(m.id, "layout")}
                      >
                        {m.name.replace(/^關卡[·・]?/, "")}
                      </button>
                    ))}
                  </div>
                  {savedMaps.length > 0 && (
                    <>
                      <h4 className="menu-sub">自訂地圖</h4>
                      <div className="menu-stack">
                        {savedMaps.map((m) => (
                          <div key={m.id} className="flex items-center gap-1">
                            <button
                              className={"btn flex-1" + (selectedLevelId === m.id ? "" : " ghost")}
                              onClick={() => selectLevel(m.id, "layout")}
                            >
                              {m.name}
                            </button>
                            <button
                              className="btn ghost"
                              style={{ padding: "7px 10px", color: "#ffb0b0" }}
                              title="刪除此地圖"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSavedMap(m.id);
                              }}
                            >
                              刪
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <p className="mt-1 text-xs text-[#9ec4de]">
                    目前：<span className="text-[#ffe7f1]">{activeMap}</span>
                    {mapMode === "expand" ? " · 地塊拼接模式" : " · 完整地圖"}
                  </p>
                  </section>
                  <section className="menu-card">
                  <h3 className="menu-card-title">難度</h3>
                  <p className="menu-card-hint">調整數值會自動存成自訂難度</p>
                  <div className="mb-2 flex flex-col gap-1.5">
                    {diffList.map((d) => (
                      <div key={d.id} className="flex items-center gap-1">
                        <button
                          className={"btn menu-pill flex-1" + (difficultyId === d.id ? " on" : " ghost")}
                          onClick={() => {
                            setDifficultyId(d.id);
                            difficultyRef.current = d;
                            setDiffName(d.label);
                            setHover(
                              `${d.label} · 怪血×${d.enemyHpMul} · 塔傷×${d.towerDmgMul} · 金幣${d.startGold}`,
                            );
                          }}
                        >
                          {d.label}
                          {!d.builtin ? " ·自訂" : ""}
                        </button>
                        {!d.builtin && (
                          <button
                            className="btn ghost"
                            style={{ padding: "7px 10px", color: "#ffb0b0" }}
                            title="刪除此難度"
                            onClick={() => removeCustomDifficulty(d.id)}
                          >
                            刪
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* 倍率即時改、自訂自動存 */}
                  <div className="menu-diff-grid">
                    {(
                      [
                        ["enemyHpMul", "怪血", 0.4, 3, 0.05],
                        ["towerDmgMul", "塔傷", 0.5, 2, 0.05],
                        ["enemyGoldMul", "掉金", 0.5, 2, 0.05],
                        ["enemySpeedMul", "怪速", 0.7, 1.5, 0.02],
                        ["towerCostMul", "造價", 0.7, 1.5, 0.05],
                        ["startGold", "開局金", 80, 500, 10],
                        ["waveHpScale", "波次成長", 0.02, 0.25, 0.01],
                      ] as const
                    ).map(([key, label, min, max, step]) => (
                      <label key={key} className="menu-diff-field">
                        <span>{label}</span>
                        <input
                          type="number"
                          min={min}
                          max={max}
                          step={step}
                          value={Number(getDifficulty(difficultyId)[key] ?? 1)}
                          onChange={(ev) => {
                            const v = Number(ev.target.value);
                            if (!Number.isFinite(v)) return;
                            patchDifficulty({ [key]: v } as Partial<DifficultyProfile>);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <p className="menu-status">
                    怪血 ×{getDifficulty(difficultyId).enemyHpMul} · 開局金 {getDifficulty(difficultyId).startGold}
                  </p>
                  </section>
                </div>
              )}
              <div className="menu-actions">
              <button className="btn menu-start" onClick={start}>
                {phase === "ready" ? (endless ? "開始無盡" : "開始守城") : "重新開始"}
              </button>
              {phase === "ready" && (
                <div className="menu-actions-sub">
                  <button className={"btn ghost menu-pill" + (endless ? " on" : "")} onClick={() => setEndless((v) => !v)}>
                    {endless ? "無盡：開" : "無盡：關"}
                  </button>
                  <button className="btn ghost menu-pill" onClick={openWorkshop}>
                    地圖工房
                  </button>
                </div>
              )}
              </div>
              </div>
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
            <button
              className="btn flex-1"
              onClick={callWave}
              disabled={phase !== "play" || paused || (wave > 0 && (sim.current.enemies.length > 0 || sim.current.queue.length > 0))}
              title={wave === 0 ? "佈署完成後開始第 1 波" : "清空戰場後可提前召下一波（+25金）"}
            >
              {wave === 0 ? "開始第 1 波" : "下一波"}
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
          {phase === "play" && (
            <div className="mb-2 flex gap-2">
              <button
                className="btn ghost flex-1"
                style={{ fontSize: 12 }}
                onClick={() => {
                  focusCameraOnSanctuary();
                  setHover("視角已對準聖地");
                }}
              >
                對準聖地
              </button>
              <div className="flex flex-1 items-center justify-center rounded-lg border border-[#9ad7ff33] bg-[#0a1828] px-2 text-[11px] text-[#9ad7ff]">
                戰線 {Math.max(1, entrancesRef.current.length || 1)}
                {isExpandBoard(boardRef.current) ? ` · 砂 ${mingSand}` : ""}
              </div>
            </div>
          )}
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
                怪物／塔基準數值即時生效。主畫面難度倍率改動會自動存檔；此處可另存命名副本。
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
                總Lv.{selected.hqCoreLv ?? 1} · 火{selected.hqFireLv ?? 0}/固{selected.hqFortifyLv ?? 0} · 傷{" "}
                {selected.damage.toFixed(0)} · 血 {Math.round(selected.hp)}/{selected.maxHp}
              </div>
              <div className="mt-1 text-[#9ec4de]">
                漏抗 {Math.round(sanctuaryStats(selected).leakResist * 100)}% · 護衛CD{" "}
                {Math.max(0, selected.escortCd ?? 0).toFixed(1)}s · 場上 {sim.current.escorts.length} · 編制{" "}
                {hqProgRef.current.squad}
              </div>
              <div className="mt-1 flex gap-1">
                <button
                  className="btn"
                  style={{ flex: 1, fontSize: 11 }}
                  disabled={
                    gold < coreUpgradeCost(selected.hqCoreLv ?? 1) ||
                    (selected.hqFireLv ?? 0) >= HQ_FIRE_MAX
                  }
                  onClick={() => upgradeSanctuaryCore("fire")}
                  title="Lv1 四角砲台 · Lv2 屋頂聖砲 · 傷害／射程提升"
                >
                  {(selected.hqFireLv ?? 0) >= HQ_FIRE_MAX
                    ? `聖砲已滿 ${HQ_FIRE_MAX}/${HQ_FIRE_MAX}`
                    : (selected.hqFireLv ?? 0) < 1
                      ? `裝角樓 ${coreUpgradeCost(selected.hqCoreLv ?? 1)}`
                      : (selected.hqFireLv ?? 0) < 2
                        ? `裝聖砲 ${coreUpgradeCost(selected.hqCoreLv ?? 1)}`
                        : `強聖砲 ${(selected.hqFireLv ?? 0) + 1}/${HQ_FIRE_MAX} · ${coreUpgradeCost(selected.hqCoreLv ?? 1)}`}
                </button>
                <button
                  className="btn ghost"
                  style={{ flex: 1, fontSize: 11, borderColor: "#9dffc0" }}
                  disabled={
                    gold < coreUpgradeCost(selected.hqCoreLv ?? 1) ||
                    (selected.hqFortifyLv ?? 0) >= HQ_FORT_MAX
                  }
                  onClick={() => upgradeSanctuaryCore("fortify")}
                  title="加厚城牆、提升建築血與漏抗"
                >
                  加固城牆 {coreUpgradeCost(selected.hqCoreLv ?? 1)}
                </button>
              </div>
              <p className="mt-1 text-[10px] text-[#9ec4de]">
                聖砲最多 {HQ_FIRE_MAX} 次 · 加固最多 {HQ_FORT_MAX} 次 · 火力：角樓→聖砲 · 加固：城垛血量
              </p>
              <div className="mt-2 rounded border border-[#3a6080] bg-[#0a1828cc] p-2 text-[11px]">
                <div className="mb-1 flex items-center justify-between text-[#9ad7ff]">
                  <span>祭壇 {hqBuffRef.current.shrineCount} · 圖紙 {hqBuffRef.current.blueprints}</span>
                  <span>加持 {hqBuffRef.current.tier}/3</span>
                </div>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ width: "100%", fontSize: 11, marginBottom: 6 }}
                  disabled={hqBuffRef.current.blueprints < 1 || gold < SHRINE_PLACE_GOLD}
                  onClick={() => placeTideShrine()}
                >
                  建祭壇（圖紙×1 + {SHRINE_PLACE_GOLD}金 · 點地圖高地 · 可多座）
                </button>
                {hqBuffRef.current.shrineCount < 1 && (
                  <p className="text-[10px] text-[#9ec4de]">至少一座祭壇後可選加持路線</p>
                )}
                {hqBuffRef.current.shrineCount >= 1 && hqBuffRef.current.tier < 3 && (
                  <div className="flex flex-col gap-1">
                    <p className="text-[10px] text-[#9ec4de]">第 {hqBuffRef.current.tier + 1} 階更強也更貴 · 二選一</p>
                    {hqBuffChoices(hqBuffRef.current.tier + 1).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 11, textAlign: "left" }}
                        disabled={gold < opt.cost}
                        onClick={() => pickHqBuff(opt.id)}
                      >
                        <strong>{opt.name}</strong> · {opt.cost}金
                        <span className="block text-[10px] text-[#9ec4de]">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
                {hqBuffRef.current.tier >= 3 && (
                  <p className="text-[10px] text-[#b8f0c8]">加持路線完成（3/3）</p>
                )}
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
