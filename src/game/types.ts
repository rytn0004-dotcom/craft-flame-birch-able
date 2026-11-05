export type Special =
  | "high"
  | "slow"
  | "range"
  | "burn"
  | "rapid"
  | "aoe"
  | "root"
  | "break"
  | "chain"
  | "pierce"
  | "execute"
  | "ultimate";

export type TowerDef = {
  id: number;
  name: string;
  img: string;
  cost: number;
  range: number;
  damage: number;
  cooldown: number;
  special: Special;
  trait: string;
  color: string;
};

export const TOWERS: TowerDef[] = [
  { id: 0, name: "銀月狐仙", img: "/towers/t01.png", cost: 50, range: 145, damage: 24, cooldown: 0.95, special: "high", trait: "高傷害", color: "#b9dcff" },
  { id: 1, name: "寒霜狐仙", img: "/towers/t02.png", cost: 65, range: 130, damage: 10, cooldown: 0.85, special: "slow", trait: "減速敵人 45%", color: "#7ecbff" },
  { id: 2, name: "潮歌狐仙", img: "/towers/t03.png", cost: 80, range: 200, damage: 16, cooldown: 1.05, special: "range", trait: "超遠射程", color: "#9ad7ff" },
  { id: 3, name: "赤焰狐仙", img: "/towers/t04.png", cost: 95, range: 135, damage: 13, cooldown: 1.0, special: "burn", trait: "燃燒 持續傷害", color: "#ff8a55" },
  { id: 4, name: "疾羽狐仙", img: "/towers/t05.png", cost: 110, range: 120, damage: 8, cooldown: 0.28, special: "rapid", trait: "極高射速", color: "#d7b6ff" },
  { id: 5, name: "花繚狐仙", img: "/towers/t06.png", cost: 135, range: 150, damage: 18, cooldown: 1.15, special: "aoe", trait: "範圍爆炸", color: "#ff9ec4" },
  { id: 6, name: "縛影狐仙", img: "/towers/t07.png", cost: 155, range: 125, damage: 14, cooldown: 1.05, special: "root", trait: "阻擋：定身 + 強減速", color: "#c9a0ff" },
  { id: 7, name: "聖輝狐仙", img: "/towers/t08.png", cost: 175, range: 145, damage: 20, cooldown: 0.95, special: "break", trait: "護盾破擊：易傷 +40%", color: "#ffe08a" },
  { id: 8, name: "璃鏈狐仙", img: "/towers/t09.png", cost: 200, range: 140, damage: 16, cooldown: 0.9, special: "chain", trait: "連鎖閃電 3 名", color: "#8ef0ff" },
  { id: 9, name: "霞貫狐仙", img: "/towers/t10.png", cost: 230, range: 170, damage: 22, cooldown: 1.1, special: "pierce", trait: "穿透直線傷害", color: "#ffb0c8" },
  { id: 10, name: "背光狐仙", img: "/towers/t11.png", cost: 255, range: 155, damage: 36, cooldown: 1.2, special: "execute", trait: "高傷害，殘血處決", color: "#ffd2a8" },
  { id: 11, name: "究極狐仙", img: "/towers/t12.png", cost: 320, range: 175, damage: 42, cooldown: 0.85, special: "ultimate", trait: "高傷 + 燃燒 + 減速 + 範圍", color: "#ff6fa8" },
];

export type Trait = "melee" | "armor" | "regen" | "noslow" | "shield";

export type EnemyDef = {
  name: string;
  hp: number;
  speed: number;
  gold: number;
  color: string;
  r: number;
  traits: Trait[];
  boss?: boolean;
  skills?: string[];
};

export const TRAIT_INFO: { id: Trait; label: string }[] = [
  { id: "melee", label: "近戰拆塔" },
  { id: "armor", label: "厚甲" },
  { id: "regen", label: "回血" },
  { id: "noslow", label: "免疫減速" },
  { id: "shield", label: "護盾" },
];

export function stockBestiary(): EnemyDef[] {
  return [
    { name: "小妖", hp: 70, speed: 160, gold: 9, color: "#6dcaa0", r: 11, traits: [], skills: ["howl"] },
    { name: "狼妖", hp: 150, speed: 145, gold: 18, color: "#c48a62", r: 13, traits: [], skills: ["charge", "howl"] },
    { name: "石魔", hp: 320, speed: 110, gold: 32, color: "#7f93a8", r: 16, traits: ["armor"], skills: ["slam", "howl"] },
    { name: "炎魔", hp: 420, speed: 130, gold: 45, color: "#e07048", r: 15, traits: ["regen"], skills: ["mend", "howl"] },
    { name: "魔將", hp: 900, speed: 100, gold: 95, color: "#b06ad4", r: 18, traits: ["armor", "noslow"], boss: true, skills: ["slam", "terror", "howl", "barrier"] },
    { name: "妖王", hp: 1400, speed: 90, gold: 155, color: "#ff5f9a", r: 21, traits: ["shield"], boss: true, skills: ["nova", "barrier", "mend", "terror"] },
    { name: "潮刃", hp: 380, speed: 125, gold: 40, color: "#ffd2a8", r: 14, traits: ["melee"], skills: ["slam", "charge"] },
    { name: "影衛", hp: 520, speed: 105, gold: 52, color: "#9bb0c9", r: 15, traits: ["armor", "shield"], skills: ["barrier", "slam"] },
    { name: "疾狐", hp: 180, speed: 230, gold: 26, color: "#d7b6ff", r: 12, traits: ["noslow"], skills: ["charge"] },
    { name: "妖后", hp: 2200, speed: 80, gold: 240, color: "#ffd27a", r: 22, traits: ["regen", "shield", "armor"], boss: true, skills: ["nova", "mend", "barrier", "howl", "terror"] },
  ];
}

export const ENEMY_TYPES = stockBestiary().map((e) => ({ ...e, melee: e.traits.includes("melee" as Trait) }));
