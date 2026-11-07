/**
 * 每座塔專屬覺醒：Lv5 低階 / Lv8 中階 / Lv10 高階
 * 技能 id = `t{塔id}_{tier}`，效果依塔特性量身，互不重複。
 */
import type { Special } from "./types";

export type SkillTier = "low" | "mid" | "high";

export type TowerSkillId = string;

export type TowerSkillDef = {
  id: TowerSkillId;
  towerId: number;
  tier: SkillTier;
  name: string;
  desc: string;
  color: string;
};

export const SKILL_UNLOCK_LEVEL: Record<SkillTier, number> = {
  low: 5,
  mid: 8,
  high: 10,
};

/** 12 塔 × 3 階 = 專屬技能表 */
export const TOWER_SKILL_TREE: TowerSkillDef[] = [
  // 0 銀月 · 高傷
  { id: "t0_low", towerId: 0, tier: "low", name: "銀輝", desc: "傷害 +18%", color: "#b9dcff" },
  { id: "t0_mid", towerId: 0, tier: "mid", name: "月刃", desc: "暴擊：15% 機率造成 2.2 倍傷害", color: "#e8fbff" },
  { id: "t0_high", towerId: 0, tier: "high", name: "滿月斬", desc: "每 6 發對目標與附近釋放滿月斬（高傷）", color: "#ffe08a" },
  // 1 寒霜 · 減速
  { id: "t1_low", towerId: 1, tier: "low", name: "霜痕", desc: "減速更強（再壓 20% 移速）", color: "#7ecbff" },
  { id: "t1_mid", towerId: 1, tier: "mid", name: "凍結", desc: "命中有 18% 短暫定身", color: "#a8e4ff" },
  { id: "t1_high", towerId: 1, tier: "high", name: "極寒領域", desc: "射程內敵人持續大幅減速", color: "#4db8ff" },
  // 2 潮歌 · 遠程
  { id: "t2_low", towerId: 2, tier: "low", name: "遠韻", desc: "射程 +40", color: "#9ad7ff" },
  { id: "t2_mid", towerId: 2, tier: "mid", name: "潮聲", desc: "距離越遠傷害越高（最高 +45%）", color: "#7ec8c8" },
  { id: "t2_high", towerId: 2, tier: "high", name: "共鸣砲", desc: "每 5 秒對最遠敵人追加一發強擊", color: "#5ec4ff" },
  // 3 赤焰 · 燃燒
  { id: "t3_low", towerId: 3, tier: "low", name: "熾芯", desc: "燃燒傷害 +50%、持續更久", color: "#ff8a55" },
  { id: "t3_mid", towerId: 3, tier: "mid", name: "延燒", desc: "燃燒會傳給附近一個敵人", color: "#ff6a3a" },
  { id: "t3_high", towerId: 3, tier: "high", name: "爆炎", desc: "燃燒結束或擊殺時小爆炸", color: "#ff4500" },
  // 4 疾羽 · 速射
  { id: "t4_low", towerId: 4, tier: "low", name: "羽嵐", desc: "射速再 +20%", color: "#d7b6ff" },
  { id: "t4_mid", towerId: 4, tier: "mid", name: "連珠", desc: "每次射擊 25% 機率連發第二發", color: "#c9a0ff" },
  { id: "t4_high", towerId: 4, tier: "high", name: "羽暴", desc: "連續命中同一目標傷害遞增（最高 +60%）", color: "#b388ff" },
  // 5 花繚 · AOE
  { id: "t5_low", towerId: 5, tier: "low", name: "花瓣", desc: "爆炸範圍 +25%、濺射 +10%", color: "#ff9ec4" },
  { id: "t5_mid", towerId: 5, tier: "mid", name: "繚亂", desc: "爆炸中心額外 35% 傷害", color: "#ff7eb3" },
  { id: "t5_high", towerId: 5, tier: "high", name: "櫻葬", desc: "擊殺時再引爆一次大範圍", color: "#ff5c9a" },
  // 6 縛影 · 定身
  { id: "t6_low", towerId: 6, tier: "low", name: "影絲", desc: "定身時間 +40%", color: "#c9a0ff" },
  { id: "t6_mid", towerId: 6, tier: "mid", name: "枷鎖", desc: "被定身的敵人受到傷害 +25%", color: "#a878ff" },
  { id: "t6_high", towerId: 6, tier: "high", name: "影牢", desc: "定身結束時對目標造成爆發傷害", color: "#8b5cff" },
  // 7 聖輝 · 破盾易傷
  { id: "t7_low", towerId: 7, tier: "low", name: "聖痕", desc: "易傷效果 +15%（總計更高）", color: "#ffe08a" },
  { id: "t7_mid", towerId: 7, tier: "mid", name: "破曉", desc: "對護盾額外 80% 傷害", color: "#ffd27a" },
  { id: "t7_high", towerId: 7, tier: "high", name: "審判", desc: "對已易傷敵人首次命中追加真實傷害", color: "#ffc857" },
  // 8 璃鏈 · 連鎖
  { id: "t8_low", towerId: 8, tier: "low", name: "璃脈", desc: "連鎖目標 +1、跳躍距離更遠", color: "#8ef0ff" },
  { id: "t8_mid", towerId: 8, tier: "mid", name: "共振", desc: "連鎖傷害提升至 75%", color: "#5ee7ff" },
  { id: "t8_high", towerId: 8, tier: "high", name: "天鏈", desc: "連鎖可回彈主目標一次", color: "#2bd3ff" },
  // 9 霞貫 · 穿透
  { id: "t9_low", towerId: 9, tier: "low", name: "貫氣", desc: "穿透路徑傷害不衰減", color: "#ffb0c8" },
  { id: "t9_mid", towerId: 9, tier: "mid", name: "霞線", desc: "穿透寬度擴大，更易掃到多敵", color: "#ff8fb3" },
  { id: "t9_high", towerId: 9, tier: "high", name: "斷潮一閃", desc: "穿透命中 ≥3 名時末端爆炸", color: "#ff6b9d" },
  // 10 背光 · 處決
  { id: "t10_low", towerId: 10, tier: "low", name: "殘光", desc: "處決線提升至 24% 血量", color: "#ffd2a8" },
  { id: "t10_mid", towerId: 10, tier: "mid", name: "追魂", desc: "對低於半血敵人傷害 +40%", color: "#ffb87a" },
  { id: "t10_high", towerId: 10, tier: "high", name: "終焉", desc: "處決成功時回復 25 金並短暫加速射速", color: "#ff9f4a" },
  // 11 究極 · 全能
  { id: "t11_low", towerId: 11, tier: "low", name: "潮核", desc: "傷害、燃燒、減速全面小幅強化", color: "#ff6fa8" },
  { id: "t11_mid", towerId: 11, tier: "mid", name: "三重潮", desc: "命中附加小範圍第二次衝擊", color: "#ff4d94" },
  { id: "t11_high", towerId: 11, tier: "high", name: "狐仙神樂", desc: "每隔數秒釋放全特性大招（傷+燃+緩+爆）", color: "#ff2d7b" },
];

export const SKILL_BY_ID: Record<string, TowerSkillDef> = Object.fromEntries(
  TOWER_SKILL_TREE.map((s) => [s.id, s]),
);

export function skillForTowerTier(towerId: number, tier: SkillTier): TowerSkillDef | undefined {
  return TOWER_SKILL_TREE.find((s) => s.towerId === towerId && s.tier === tier);
}

export function unlockedTierAtLevel(level: number): SkillTier | null {
  if (level === SKILL_UNLOCK_LEVEL.high) return "high";
  if (level === SKILL_UNLOCK_LEVEL.mid) return "mid";
  if (level === SKILL_UNLOCK_LEVEL.low) return "low";
  return null;
}

export function hasSkill(skills: string[] | undefined, id: string) {
  return !!skills?.includes(id);
}

export function hasTowerTier(skills: string[] | undefined, towerId: number, tier: SkillTier) {
  const sk = skillForTowerTier(towerId, tier);
  return sk ? hasSkill(skills, sk.id) : false;
}

/** 升級後應學會的技能（該階尚未擁有時） */
export function skillUnlockedByLevel(towerId: number, level: number): TowerSkillDef | null {
  const tier = unlockedTierAtLevel(level);
  if (!tier) return null;
  return skillForTowerTier(towerId, tier) ?? null;
}

export function skillLabelShort(id: string) {
  return SKILL_BY_ID[id]?.name ?? id;
}
