/** 難度與可自訂倍率；工房可另存命名檔 */

export type DifficultyId = "easy" | "normal" | "hard" | "inferno" | string;

export type DifficultyProfile = {
  id: DifficultyId;
  label: string;
  /** 敵人生命倍率 */
  enemyHpMul: number;
  /** 擊殺金幣倍率 */
  enemyGoldMul: number;
  /** 移速倍率 */
  enemySpeedMul: number;
  /** 塔傷害倍率 */
  towerDmgMul: number;
  /** 塔造價倍率 */
  towerCostMul: number;
  /** 開局金幣 */
  startGold: number;
  /** 關卡每波生命成長（加在 1 上，例如 0.08 → 第 5 波約 1.32 倍） */
  waveHpScale: number;
  builtin?: boolean;
};

export const BUILTIN_DIFFICULTIES: DifficultyProfile[] = [
  {
    id: "easy",
    label: "簡單",
    enemyHpMul: 0.75,
    enemyGoldMul: 1.25,
    enemySpeedMul: 0.92,
    towerDmgMul: 1.15,
    towerCostMul: 0.9,
    startGold: 280,
    waveHpScale: 0.05,
    builtin: true,
  },
  {
    id: "normal",
    label: "普通",
    enemyHpMul: 1,
    enemyGoldMul: 1,
    enemySpeedMul: 1,
    towerDmgMul: 1,
    towerCostMul: 1,
    startGold: 220,
    waveHpScale: 0.08,
    builtin: true,
  },
  {
    id: "hard",
    label: "困難",
    enemyHpMul: 1.35,
    enemyGoldMul: 0.95,
    enemySpeedMul: 1.06,
    towerDmgMul: 0.95,
    towerCostMul: 1.05,
    startGold: 180,
    waveHpScale: 0.11,
    builtin: true,
  },
  {
    id: "inferno",
    label: "煉獄",
    enemyHpMul: 1.8,
    enemyGoldMul: 0.85,
    enemySpeedMul: 1.12,
    towerDmgMul: 0.9,
    towerCostMul: 1.1,
    startGold: 150,
    waveHpScale: 0.14,
    builtin: true,
  },
];

const CUSTOM_KEY = "foxtd-difficulties-v1";
const ACTIVE_KEY = "foxtd-difficulty-active";

export function loadCustomDifficulties(): DifficultyProfile[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as DifficultyProfile[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((d) => d && d.id && d.label);
  } catch {
    return [];
  }
}

export function saveCustomDifficulties(list: DifficultyProfile[]) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.slice(0, 12)));
}

export function allDifficulties(): DifficultyProfile[] {
  const custom = loadCustomDifficulties();
  const ids = new Set(custom.map((c) => c.id));
  return [...BUILTIN_DIFFICULTIES.filter((b) => !ids.has(b.id)), ...custom];
}

export function getDifficulty(id: string): DifficultyProfile {
  return allDifficulties().find((d) => d.id === id) ?? BUILTIN_DIFFICULTIES[1];
}

export function loadActiveDifficultyId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) || "normal";
  } catch {
    return "normal";
  }
}

export function saveActiveDifficultyId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function upsertCustomDifficulty(profile: DifficultyProfile) {
  const list = loadCustomDifficulties().filter((d) => d.id !== profile.id);
  list.unshift({ ...profile, builtin: false });
  saveCustomDifficulties(list);
}
