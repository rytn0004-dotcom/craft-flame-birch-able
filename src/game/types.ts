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
  { id: 0, name: "銀月狐仙", img: "/towers/t01.png", cost: 55, range: 145, damage: 24, cooldown: 0.95, special: "high", trait: "高傷害", color: "#b9dcff" },
  { id: 1, name: "寒霜狐仙", img: "/towers/t02.png", cost: 70, range: 130, damage: 10, cooldown: 0.85, special: "slow", trait: "減速敵人 45%", color: "#7ecbff" },
  { id: 2, name: "潮歌狐仙", img: "/towers/t03.png", cost: 85, range: 200, damage: 16, cooldown: 1.05, special: "range", trait: "超遠射程", color: "#9ad7ff" },
  { id: 3, name: "赤焰狐仙", img: "/towers/t04.png", cost: 100, range: 135, damage: 13, cooldown: 1.0, special: "burn", trait: "燃燒 持續傷害", color: "#ff8a55" },
  { id: 4, name: "疾羽狐仙", img: "/towers/t05.png", cost: 115, range: 120, damage: 8, cooldown: 0.28, special: "rapid", trait: "極高射速", color: "#d7b6ff" },
  { id: 5, name: "花繚狐仙", img: "/towers/t06.png", cost: 145, range: 150, damage: 18, cooldown: 1.15, special: "aoe", trait: "範圍爆炸", color: "#ff9ec4" },
  { id: 6, name: "縛影狐仙", img: "/towers/t07.png", cost: 170, range: 125, damage: 14, cooldown: 1.05, special: "root", trait: "阻擋：定身 + 強減速", color: "#c9a0ff" },
  { id: 7, name: "聖輝狐仙", img: "/towers/t08.png", cost: 185, range: 145, damage: 20, cooldown: 0.95, special: "break", trait: "護盾破擊：易傷 +40%", color: "#ffe08a" },
  { id: 8, name: "璃鏈狐仙", img: "/towers/t09.png", cost: 210, range: 140, damage: 16, cooldown: 0.9, special: "chain", trait: "連鎖閃電 3 名", color: "#8ef0ff" },
  { id: 9, name: "霞貫狐仙", img: "/towers/t10.png", cost: 240, range: 170, damage: 22, cooldown: 1.1, special: "pierce", trait: "穿透直線傷害", color: "#ffb0c8" },
  { id: 10, name: "背光狐仙", img: "/towers/t11.png", cost: 270, range: 155, damage: 36, cooldown: 1.2, special: "execute", trait: "高傷害，殘血處決", color: "#ffd2a8" },
  { id: 11, name: "究極狐仙", img: "/towers/t12.png", cost: 340, range: 175, damage: 42, cooldown: 0.85, special: "ultimate", trait: "高傷 + 燃燒 + 減速 + 範圍", color: "#ff6fa8" },
];

export const ENEMY_TYPES = [
  { name: "小妖", hp: 42, speed: 78, gold: 7, color: "#6dcaa0", r: 11, melee: false },
  { name: "狼妖", hp: 95, speed: 68, gold: 16, color: "#c48a62", r: 13, melee: false },
  { name: "石魔", hp: 190, speed: 50, gold: 28, color: "#7f93a8", r: 16, melee: false },
  { name: "炎魔", hp: 280, speed: 60, gold: 42, color: "#e07048", r: 15, melee: false },
  { name: "魔將", hp: 460, speed: 46, gold: 68, color: "#b06ad4", r: 18, melee: false },
  { name: "妖王", hp: 820, speed: 40, gold: 120, color: "#ff5f9a", r: 21, melee: false },
  { name: "潮刃", hp: 260, speed: 54, gold: 36, color: "#ffd2a8", r: 14, melee: true },
];
