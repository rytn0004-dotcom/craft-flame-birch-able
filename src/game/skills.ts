/**
 * Enemy skill system for FoxTD.
 */
export type SkillId =
  | "slam"
  | "howl"
  | "mend"
  | "barrier"
  | "charge"
  | "terror"
  | "nova";

export type SkillDef = {
  id: SkillId;
  name: string;
  cd: number;
  range: number;
  hpBelow?: number;
  hpAbove?: number;
  needTower?: boolean;
  boss?: boolean;
};

export const SKILLS: Record<SkillId, SkillDef> = {
  slam: { id: "slam", name: "震地", cd: 4.5, range: 70, needTower: true },
  howl: { id: "howl", name: "戰嚎", cd: 7, range: 0, hpAbove: 0.2 },
  mend: { id: "mend", name: "癒合", cd: 8, range: 0, hpBelow: 0.55 },
  barrier: { id: "barrier", name: "護障", cd: 10, range: 0, hpBelow: 0.7 },
  charge: { id: "charge", name: "突進", cd: 6, range: 0, hpAbove: 0.25 },
  terror: { id: "terror", name: "威壓", cd: 9, range: 120, needTower: true },
  nova: { id: "nova", name: "潮爆", cd: 12, range: 100, needTower: true, boss: true },
};

export type SkillRuntime = { id: SkillId; cdLeft: number };

export function defaultSkillsFor(opts: {
  melee?: boolean;
  boss?: boolean;
  traits?: string[];
}): SkillId[] {
  if (opts.boss) return ["nova", "barrier", "howl", "mend"];
  if (opts.melee) return ["slam", "charge"];
  const t = new Set(opts.traits || []);
  const list: SkillId[] = [];
  if (t.has("regen")) list.push("mend");
  if (t.has("shield")) list.push("barrier");
  if (t.has("noslow")) list.push("charge");
  if (t.has("armor")) list.push("howl");
  if (!list.length) list.push("howl");
  return list;
}

export function makeSkillState(ids: SkillId[]): SkillRuntime[] {
  return ids.map((id) => ({ id, cdLeft: 0.5 + Math.random() * 1.5 }));
}

export type SkillEffectResult = {
  shouts: { text: string; color: string }[];
  hasteT?: number;
  hasteMul?: number;
  heal?: number;
  shield?: number;
  dash?: number;
  towerHits?: { index: number; damage: number }[];
  terror?: { indices: number[]; duration: number; rateMul: number };
  rings?: { r: number; color: string }[];
};

export function resolveSkill(
  id: SkillId,
  opts: { boss: boolean; maxHp: number; towersInRange: { index: number; dist: number }[] },
): SkillEffectResult {
  const shouts: SkillEffectResult["shouts"] = [];
  const def = SKILLS[id];
  shouts.push({ text: def.name, color: opts.boss ? "#ffd27a" : "#c5e8ff" });
  switch (id) {
    case "slam":
      return {
        shouts,
        towerHits: opts.towersInRange.filter((t) => t.dist <= 70).map((t) => ({
          index: t.index,
          damage: opts.boss ? 36 : 22,
        })),
        rings: [{ r: 70, color: "rgba(255,180,120,0.7)" }],
      };
    case "howl":
      return { shouts, hasteT: 3.2, hasteMul: opts.boss ? 1.45 : 1.3, rings: [{ r: 40, color: "rgba(200,160,255,0.6)" }] };
    case "mend":
      return { shouts, heal: opts.maxHp * (opts.boss ? 0.18 : 0.14), rings: [{ r: 36, color: "rgba(120,255,180,0.65)" }] };
    case "barrier":
      return { shouts, shield: opts.maxHp * (opts.boss ? 0.22 : 0.16), rings: [{ r: 42, color: "rgba(150,200,255,0.7)" }] };
    case "charge":
      return { shouts, dash: opts.boss ? 90 : 70, hasteT: 0.8, hasteMul: 1.6, rings: [{ r: 28, color: "rgba(255,220,140,0.55)" }] };
    case "terror":
      return {
        shouts,
        terror: {
          indices: opts.towersInRange.filter((t) => t.dist <= 120).map((t) => t.index),
          duration: 3.5,
          rateMul: 0.55,
        },
        rings: [{ r: 120, color: "rgba(180,100,255,0.5)" }],
      };
    case "nova":
      return {
        shouts,
        towerHits: opts.towersInRange.filter((t) => t.dist <= 100).map((t) => ({ index: t.index, damage: 48 })),
        hasteT: 2.5,
        hasteMul: 1.35,
        heal: opts.maxHp * 0.08,
        rings: [
          { r: 60, color: "rgba(255,120,160,0.7)" },
          { r: 100, color: "rgba(255,200,120,0.45)" },
        ],
      };
    default:
      return { shouts };
  }
}

export function pickSkill(
  skills: SkillRuntime[],
  bb: { hpRatio: number; hasTower: boolean; boss: boolean },
): SkillId | null {
  for (const s of skills) {
    if (s.cdLeft > 0) continue;
    const def = SKILLS[s.id];
    if (def.hpBelow !== undefined && bb.hpRatio > def.hpBelow) continue;
    if (def.hpAbove !== undefined && bb.hpRatio < def.hpAbove) continue;
    if (def.needTower && !bb.hasTower) continue;
    if (def.hpBelow !== undefined) return s.id;
    if (def.needTower) return s.id;
    return s.id;
  }
  for (const s of skills) {
    if (s.cdLeft > 0) continue;
    const def = SKILLS[s.id];
    if (def.needTower && !bb.hasTower) continue;
    if (def.hpBelow !== undefined && bb.hpRatio > def.hpBelow) continue;
    return s.id;
  }
  return null;
}

export function triggerCooldown(skills: SkillRuntime[], id: SkillId) {
  const def = SKILLS[id];
  const row = skills.find((s) => s.id === id);
  if (row) row.cdLeft = def.cd;
}

export function tickSkillCooldowns(skills: SkillRuntime[], dt: number) {
  for (const s of skills) if (s.cdLeft > 0) s.cdLeft -= dt;
}
