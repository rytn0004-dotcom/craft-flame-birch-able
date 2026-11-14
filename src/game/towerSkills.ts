/**
 * 深技能池 + 效果標籤（戰鬥依 tags 結算，描述與效果一致）
 * 每 5 級從池中抽 3 個給玩家選 1。
 * 技能分锋锐／潮控／裂域三路徑，一座塔最多修兩條（第三條鎖死）。
 */

export type SkillTier = "low" | "mid" | "high";

/** BTD 式三路徑：一座塔最多修兩條，第三條鎖死 */
export type SkillPath = "edge" | "tide" | "bloom";

export const SKILL_PATH_META: Record<
  SkillPath,
  { name: string; tag: string; color: string }
> = {
  edge: { name: "锋锐", tag: "點殺／暴擊／斬殺", color: "#ffe08a" },
  tide: { name: "潮控", tag: "減速／定身／印記", color: "#7ecbff" },
  bloom: { name: "裂域", tag: "濺射／連鎖／爆發", color: "#ff9ec4" },
};

/** 可疊加的戰鬥效果（實作於 hit / fire / aura） */
export type SkillEffect =
  | { type: "dmgMul"; value: number }
  | { type: "crit"; chance: number; mul: number }
  | { type: "splash"; radius: number; pct: number }
  | { type: "slowOnHit"; factor: number; duration: number }
  | { type: "rootChance"; chance: number; duration: number }
  | { type: "burnBoost"; dps: number; duration: number }
  | { type: "burnSpread"; radius: number }
  | { type: "execLine"; ratio: number }
  | { type: "lowHpDmgMul"; hpRatio: number; mul: number }
  | { type: "shieldDmgMul"; mul: number }
  | { type: "vulnOnHit"; mul: number; duration: number }
  | { type: "chainBonus"; extra: number; range: number; pct: number }
  | { type: "chainReturn"; pct: number }
  | { type: "aoeRadiusMul"; value: number }
  | { type: "aoeCenterMul"; value: number }
  | { type: "killNova"; radius: number; pctOfMaxHp: number }
  | { type: "goldOnKill"; amount: number }
  | { type: "hasteOnKill"; duration: number; rateMul: number }
  | { type: "doubleShot"; chance: number }
  | { type: "periodicNova"; period: number; dmgMul: number; radiusMul: number }
  | { type: "auraSlow"; factor: number }
  | { type: "rangeAdd"; value: number }
  | { type: "cooldownMul"; value: number }
  | { type: "rootExtraDmg"; mul: number }
  | { type: "everyNShotsNova"; n: number; dmgMul: number; radius: number }
  | { type: "distDmgMul"; maxBonus: number }
  | { type: "pierceWiden"; add: number }
  | { type: "pierceNovaAt"; count: number; radius: number; dmgMul: number }
  | { type: "markStack"; max: number; perStack: number }
  | { type: "multihitEcho"; pct: number; radius: number };

export type TowerSkillDef = {
  id: string;
  name: string;
  desc: string;
  color: string;
  tier: SkillTier;
  path: SkillPath;
  effects: SkillEffect[];
};

export const SKILL_EVERY_LEVELS = 5;
export const SKILL_CHOICE_COUNT = 3;

export const TOWER_SKILL_POOL: TowerSkillDef[] = [
  { id: "keen_edge", name: "鋭刃", desc: "傷害 +12%", color: "#ffe08a", tier: "low", path: "edge", effects: [{ type: "dmgMul", value: 1.12 }] },
  { id: "brisk_wind", name: "疾風", desc: "射速 +12%（冷卻縮短）", color: "#d7b6ff", tier: "low", path: "tide", effects: [{ type: "cooldownMul", value: 0.88 }] },
  { id: "long_reach", name: "延展", desc: "射程 +28", color: "#9ad7ff", tier: "low", path: "tide", effects: [{ type: "rangeAdd", value: 28 }] },
  { id: "mist_spray", name: "潮霧", desc: "命中濺射 20% 傷害", color: "#7ec8c8", tier: "low", path: "bloom", effects: [{ type: "splash", radius: 52, pct: 0.2 }] },
  { id: "frost_touch", name: "霜觸", desc: "命中減速更強", color: "#7ecbff", tier: "low", path: "tide", effects: [{ type: "slowOnHit", factor: 0.55, duration: 2.2 }] },
  { id: "ember", name: "餘燼", desc: "附加燃燒", color: "#ff8a55", tier: "low", path: "tide", effects: [{ type: "burnBoost", dps: 8, duration: 2.8 }] },
  { id: "tide_mark", name: "潮印", desc: "疊印記，每層受擊 +5%（最高 5）", color: "#8ec8ee", tier: "low", path: "tide", effects: [{ type: "markStack", max: 5, perStack: 0.05 }] },
  { id: "pinpoint", name: "點破", desc: "8% 暴擊造成 2 倍傷", color: "#ffd27a", tier: "low", path: "edge", effects: [{ type: "crit", chance: 0.08, mul: 2 }] },
  { id: "siphon", name: "汲金", desc: "擊殺 +8 金", color: "#ffd27a", tier: "low", path: "bloom", effects: [{ type: "goldOnKill", amount: 8 }] },
  { id: "wide_burst", name: "散華", desc: "範圍攻擊半徑 +15%", color: "#ff9ec4", tier: "low", path: "bloom", effects: [{ type: "aoeRadiusMul", value: 1.15 }] },
  { id: "shield_crack", name: "裂盾", desc: "對護盾 +40% 傷害", color: "#ffe08a", tier: "low", path: "edge", effects: [{ type: "shieldDmgMul", mul: 1.4 }] },
  { id: "hunter", name: "追傷", desc: "對 50% 血以下 +20% 傷害", color: "#ffb87a", tier: "low", path: "edge", effects: [{ type: "lowHpDmgMul", hpRatio: 0.5, mul: 1.2 }] },
  { id: "echo_soft", name: "輕回響", desc: "命中後對附近再彈 25%", color: "#8ef0ff", tier: "low", path: "bloom", effects: [{ type: "multihitEcho", pct: 0.25, radius: 70 }] },
  { id: "root_sting", name: "刺縛", desc: "定身中的敵人 +15% 傷害", color: "#c9a0ff", tier: "low", path: "tide", effects: [{ type: "rootExtraDmg", mul: 1.15 }] },
  { id: "moon_crit", name: "月刃", desc: "14% 暴擊 2.3 倍", color: "#e8fbff", tier: "mid", path: "edge", effects: [{ type: "crit", chance: 0.14, mul: 2.3 }] },
  { id: "riptide", name: "裂潮", desc: "每 4 發範圍裂潮", color: "#ff9ec4", tier: "mid", path: "bloom", effects: [{ type: "everyNShotsNova", n: 4, dmgMul: 0.7, radius: 72 }] },
  { id: "deep_freeze", name: "深凍", desc: "18% 短暫定身", color: "#a8e4ff", tier: "mid", path: "tide", effects: [{ type: "rootChance", chance: 0.18, duration: 0.5 }] },
  { id: "wildfire", name: "野火", desc: "燃燒更強並擴散", color: "#ff7a45", tier: "mid", path: "tide", effects: [{ type: "burnBoost", dps: 14, duration: 3.2 }, { type: "burnSpread", radius: 48 }] },
  { id: "blood_scent", name: "血嗅", desc: "低血量目標額外傷害", color: "#ff6b8a", tier: "mid", path: "edge", effects: [{ type: "lowHpDmgMul", hpRatio: 0.4, mul: 1.35 }] },
  { id: "exec_edge", name: "斷首", desc: "低血斬殺線", color: "#ff9f4a", tier: "mid", path: "edge", effects: [{ type: "execLine", ratio: 0.12 }] },
  { id: "chain_surge", name: "鏈涌", desc: "連鎖強化", color: "#2bd3ff", tier: "mid", path: "bloom", effects: [{ type: "chainBonus", extra: 1, range: 120, pct: 0.55 }] },
  { id: "vuln_brand", name: "易傷烙", desc: "命中上易傷", color: "#ffc857", tier: "mid", path: "tide", effects: [{ type: "vulnOnHit", mul: 1.25, duration: 2.8 }] },
  { id: "double_volley", name: "雙連", desc: "25% 連珠", color: "#b388ff", tier: "mid", path: "bloom", effects: [{ type: "doubleShot", chance: 0.25 }] },
  { id: "kill_bloom", name: "葬華", desc: "擊殺小爆", color: "#ff5c9a", tier: "mid", path: "bloom", effects: [{ type: "killNova", radius: 64, pctOfMaxHp: 0.08 }] },
  { id: "far_power", name: "遠勢", desc: "距離越遠傷害越高", color: "#9ad7ff", tier: "mid", path: "edge", effects: [{ type: "distDmgMul", maxBonus: 0.35 }] },
  { id: "center_crush", name: "中核", desc: "範圍中心加傷", color: "#ff8ec8", tier: "mid", path: "bloom", effects: [{ type: "aoeCenterMul", value: 1.35 }] },
  { id: "pierce_fan", name: "貫扇", desc: "穿透加寬", color: "#ffe08a", tier: "mid", path: "edge", effects: [{ type: "pierceWiden", add: 1 }] },
  { id: "mark_brand", name: "深潮印", desc: "印記更高", color: "#7ec8c8", tier: "mid", path: "tide", effects: [{ type: "markStack", max: 6, perStack: 0.07 }] },
  { id: "haste_kill", name: "凱旋", desc: "擊殺加速", color: "#d7b6ff", tier: "mid", path: "tide", effects: [{ type: "hasteOnKill", duration: 1.2, rateMul: 1.35 }] },
  { id: "echo_hard", name: "重回響", desc: "附近再彈 40%", color: "#8ef0ff", tier: "mid", path: "bloom", effects: [{ type: "multihitEcho", pct: 0.4, radius: 85 }] },
  { id: "moonfall", name: "月落", desc: "高暴擊", color: "#e8fbff", tier: "high", path: "edge", effects: [{ type: "crit", chance: 0.22, mul: 2.6 }] },
  { id: "blizzard", name: "暴雪", desc: "強減速+定身", color: "#a8e4ff", tier: "high", path: "tide", effects: [{ type: "slowOnHit", factor: 0.4, duration: 2.8 }, { type: "rootChance", chance: 0.22, duration: 0.65 }] },
  { id: "catastrophe", name: "災域", desc: "週期大範圍", color: "#ff6b9d", tier: "high", path: "bloom", effects: [{ type: "periodicNova", period: 5, dmgMul: 1.1, radiusMul: 1.4 }] },
  { id: "god_music", name: "神樂", desc: "遠距與護盾剋制", color: "#ffd27a", tier: "high", path: "edge", effects: [{ type: "distDmgMul", maxBonus: 0.5 }, { type: "shieldDmgMul", mul: 1.8 }] },
  { id: "final_cut", name: "終焉", desc: "斬殺+金幣+加速", color: "#ff9f4a", tier: "high", path: "edge", effects: [{ type: "execLine", ratio: 0.28 }, { type: "goldOnKill", amount: 30 }, { type: "hasteOnKill", duration: 1.6, rateMul: 1.55 }] },
  { id: "sky_chain", name: "天鏈", desc: "連鎖大強化並回彈", color: "#2bd3ff", tier: "high", path: "bloom", effects: [{ type: "chainBonus", extra: 2, range: 150, pct: 0.8 }, { type: "chainReturn", pct: 0.45 }] },
  { id: "rift_flash", name: "斷潮閃", desc: "穿透命中 3 人末端爆", color: "#ff6b9d", tier: "high", path: "edge", effects: [{ type: "pierceNovaAt", count: 3, radius: 88, dmgMul: 0.85 }] },
  { id: "overpower", name: "破軍", desc: "傷害 +28%", color: "#ff6fa8", tier: "high", path: "edge", effects: [{ type: "dmgMul", value: 1.28 }] },
  { id: "storm_volley", name: "嵐射", desc: "射速 +22% 且 35% 連珠", color: "#b388ff", tier: "high", path: "bloom", effects: [{ type: "cooldownMul", value: 0.78 }, { type: "doubleShot", chance: 0.35 }] },
  { id: "judgment", name: "審判域", desc: "易傷更強；對護盾巨傷", color: "#ffc857", tier: "high", path: "tide", effects: [{ type: "vulnOnHit", mul: 1.45, duration: 3.5 }, { type: "shieldDmgMul", mul: 2 }] },
  { id: "sakura_end", name: "櫻葬", desc: "擊殺雙重爆炸", color: "#ff5c9a", tier: "high", path: "bloom", effects: [{ type: "killNova", radius: 100, pctOfMaxHp: 0.16 }] },
  { id: "abyss_mark", name: "深印", desc: "潮印上限 8 層、每層 10%", color: "#7ec8c8", tier: "high", path: "tide", effects: [{ type: "markStack", max: 8, perStack: 0.1 }] },
];

export const SKILL_BY_ID: Record<string, TowerSkillDef> = Object.fromEntries(
  TOWER_SKILL_POOL.map((s) => [s.id, s]),
);

export function skillLabelShort(id: string) {
  return SKILL_BY_ID[id]?.name ?? id;
}

export function hasSkill(skills: string[] | undefined, id: string) {
  return !!skills?.includes(id);
}

export function isSkillLevel(level: number) {
  return level > 0 && level % SKILL_EVERY_LEVELS === 0;
}

function tierWeight(skillTier: SkillTier, towerLevel: number): number {
  if (towerLevel >= 15) {
    if (skillTier === "high") return 3.2;
    if (skillTier === "mid") return 1.6;
    return 0.7;
  }
  if (towerLevel >= 10) {
    if (skillTier === "high") return 1.2;
    if (skillTier === "mid") return 2.4;
    return 1;
  }
  if (skillTier === "high") return 0.15;
  if (skillTier === "mid") return 0.9;
  return 2.5;
}

export function ownedSkillPaths(owned: string[] | undefined): Set<SkillPath> {
  const paths = new Set<SkillPath>();
  for (const id of owned || []) {
    const def = SKILL_BY_ID[id];
    if (def?.path) paths.add(def.path);
  }
  return paths;
}

export function allowedSkillPaths(owned: string[] | undefined): Set<SkillPath> | null {
  const have = ownedSkillPaths(owned);
  if (have.size < 2) return null;
  return have;
}

export function isPathLocked(owned: string[] | undefined, path: SkillPath): boolean {
  const allow = allowedSkillPaths(owned);
  if (!allow) return false;
  return !allow.has(path);
}

export function rollSkillChoices(
  owned: string[] | undefined,
  towerLevel: number,
  count = SKILL_CHOICE_COUNT,
): TowerSkillDef[] {
  const have = new Set(owned || []);
  const allow = allowedSkillPaths(owned);
  const pool = TOWER_SKILL_POOL.filter((s) => {
    if (have.has(s.id)) return false;
    if (allow && !allow.has(s.path)) return false;
    return true;
  });
  if (!pool.length) return [];
  const bag: TowerSkillDef[] = [];
  for (const s of pool) {
    const w = Math.max(1, Math.round(tierWeight(s.tier, towerLevel) * 10));
    for (let i = 0; i < w; i++) bag.push(s);
  }
  const out: TowerSkillDef[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (out.length < count && out.length < pool.length && guard++ < 200) {
    const pick = bag[Math.floor(Math.random() * bag.length)];
    if (used.has(pick.id)) continue;
    used.add(pick.id);
    out.push(pick);
  }
  return out;
}

export function collectEffects(skills: string[] | undefined): SkillEffect[] {
  const out: SkillEffect[] = [];
  for (const id of skills || []) {
    const def = SKILL_BY_ID[id];
    if (def) out.push(...def.effects);
  }
  return out;
}

export function sumDmgMul(effects: SkillEffect[]): number {
  let m = 1;
  for (const e of effects) if (e.type === "dmgMul") m *= e.value;
  return m;
}
