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

/** 基準數值（普通難度）；實際遊戲會再乘難度倍率 */
export const TOWERS: TowerDef[] = [
  { id: 0, name: "銀月狐仙", img: "/towers/t01.jpg?v=8", cost: 45, range: 150, damage: 32, cooldown: 0.85, special: "high", trait: "高傷害", color: "#b9dcff" },
  { id: 1, name: "寒霜狐仙", img: "/towers/t02.jpg?v=8", cost: 55, range: 135, damage: 14, cooldown: 0.8, special: "slow", trait: "減速敵人 45%", color: "#7ecbff" },
  { id: 2, name: "潮歌狐仙", img: "/towers/t03.jpg?v=8", cost: 70, range: 210, damage: 20, cooldown: 1.0, special: "range", trait: "超遠射程", color: "#9ad7ff" },
  { id: 3, name: "赤焰狐仙", img: "/towers/t04.jpg?v=8", cost: 80, range: 140, damage: 16, cooldown: 0.95, special: "burn", trait: "燃燒 持續傷害", color: "#ff8a55" },
  { id: 4, name: "疾羽狐仙", img: "/towers/t05.jpg?v=8", cost: 95, range: 125, damage: 11, cooldown: 0.26, special: "rapid", trait: "極高射速", color: "#d7b6ff" },
  { id: 5, name: "花繚狐仙", img: "/towers/t06.jpg?v=8", cost: 120, range: 155, damage: 22, cooldown: 1.1, special: "aoe", trait: "範圍爆炸", color: "#ff9ec4" },
  { id: 6, name: "縛影狐仙", img: "/towers/t07.jpg?v=8", cost: 140, range: 130, damage: 18, cooldown: 1.0, special: "root", trait: "阻擋：定身 + 強減速", color: "#c9a0ff" },
  { id: 7, name: "聖輝狐仙", img: "/towers/t08.jpg?v=8", cost: 160, range: 150, damage: 24, cooldown: 0.9, special: "break", trait: "護盾破擊：易傷 +40%", color: "#ffe08a" },
  { id: 8, name: "璃鏈狐仙", img: "/towers/t09.jpg?v=8", cost: 180, range: 145, damage: 20, cooldown: 0.85, special: "chain", trait: "連鎖閃電 3 名", color: "#8ef0ff" },
  { id: 9, name: "霞貫狐仙", img: "/towers/t10.jpg?v=8", cost: 210, range: 175, damage: 28, cooldown: 1.05, special: "pierce", trait: "穿透直線傷害", color: "#ffb0c8" },
  { id: 10, name: "背光狐仙", img: "/towers/t11.jpg?v=8", cost: 240, range: 160, damage: 42, cooldown: 1.15, special: "execute", trait: "高傷害，殘血處決", color: "#ffd2a8" },
  { id: 11, name: "究極狐仙", img: "/towers/t12.jpg?v=8", cost: 300, range: 180, damage: 48, cooldown: 0.8, special: "ultimate", trait: "高傷 + 燃燒 + 減速 + 範圍", color: "#ff6fa8" },
];

export type Trait = "melee" | "armor" | "regen" | "noslow" | "shield";

export type EnemySprite = "imp" | "brute" | "boss" | "king";

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
  sprite?: EnemySprite;
  lore?: string;
};

export const TRAIT_INFO: { id: Trait; label: string }[] = [
  { id: "melee", label: "近戰拆塔" },
  { id: "armor", label: "厚甲" },
  { id: "regen", label: "回血" },
  { id: "noslow", label: "免疫減速" },
  { id: "shield", label: "護盾" },
];

/** 潮汐結界：配色對齊狐仙銀白／潮紅／海青／月光金 */
export function stockBestiary(): EnemyDef[] {
  return [
    { name: "潮芽", hp: 48, speed: 150, gold: 14, color: "#7ec8c8", r: 11, traits: [], skills: ["howl"], sprite: "imp", lore: "珊瑚間冒出的幼靈。" },
    { name: "浪崽", hp: 95, speed: 140, gold: 22, color: "#9ad7ff", r: 13, traits: [], skills: ["charge", "howl"], sprite: "imp", lore: "乘浪疾行的海獸幼體。" },
    { name: "礁岩衛", hp: 220, speed: 105, gold: 36, color: "#8aa4b8", r: 16, traits: ["armor"], skills: ["slam", "howl"], sprite: "brute", lore: "沉沒神殿石像被潮聲喚醒。" },
    { name: "炎潮", hp: 280, speed: 125, gold: 42, color: "#ff8a6a", r: 15, traits: ["regen"], skills: ["mend", "howl"], sprite: "brute", lore: "地熱與潮水交織的灼熱靈。" },
    { name: "潮將軍", hp: 900, speed: 100, gold: 95, color: "#c9a0ff", r: 18, traits: ["armor", "noslow"], boss: true, skills: ["slam", "terror", "howl", "barrier"], sprite: "boss", lore: "率領潮陣的魔將，銀髮紅披。" },
    { name: "深海王", hp: 1400, speed: 90, gold: 155, color: "#ff6fa8", r: 21, traits: ["shield"], boss: true, skills: ["nova", "barrier", "mend", "terror"], sprite: "king", lore: "舊日海域的君主。" },
    { name: "潮刃", hp: 380, speed: 125, gold: 40, color: "#ffd2a8", r: 14, traits: ["melee"], skills: ["slam", "charge"], sprite: "brute", lore: "專拆塔的刃潮侍衛。" },
    { name: "月影衛", hp: 520, speed: 105, gold: 52, color: "#b9dcff", r: 15, traits: ["armor", "shield"], skills: ["barrier", "slam"], sprite: "boss", lore: "月光甲衛，護盾如潮膜。" },
    { name: "疾潮狐", hp: 110, speed: 210, gold: 28, color: "#d7b6ff", r: 12, traits: ["noslow"], skills: ["charge"], sprite: "imp", lore: "被污濁侵蝕的野狐靈。" },
    { name: "潮后", hp: 2200, speed: 80, gold: 240, color: "#ffe08a", r: 22, traits: ["regen", "shield", "armor"], boss: true, skills: ["nova", "mend", "barrier", "howl", "terror"], sprite: "king", lore: "與狐仙同源而沉淪的潮后。" },
  ];
}

export const ENEMY_TYPES = stockBestiary().map((e) => ({ ...e, melee: e.traits.includes("melee" as Trait) }));
