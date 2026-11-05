/**
 * Enemy behavior tree for FoxTD.
 */
import { pickSkill, type SkillId, type SkillRuntime } from "./skills";

export type BTStatus = "success" | "failure" | "running";

export type Blackboard = {
  t: number;
  dt: number;
  targetTower: number | null;
  pathLeft: number;
  hpRatio: number;
  shield: number;
  boss: boolean;
  melee: boolean;
  canMove: boolean;
  lastAction: string;
  chosenSkill: SkillId | null;
  skills: SkillRuntime[];
  anyTowerInSkillRange: boolean;
};

export type BTContext = {
  attackTower: (towerIndex: number, damage: number) => boolean;
  setAttackCooldown: (sec: number) => void;
  attackCd: number;
  setSpeedMul: (m: number) => void;
  setRage: (on: boolean) => void;
  shout: (text: string, color?: string) => void;
  castSkill: (id: SkillId) => boolean;
};

export type BTNode = { tick: (bb: Blackboard, ctx: BTContext) => BTStatus };

function seq(children: BTNode[]): BTNode {
  return {
    tick(bb, ctx) {
      for (const c of children) {
        const s = c.tick(bb, ctx);
        if (s !== "success") return s;
      }
      return "success";
    },
  };
}

function sel(children: BTNode[]): BTNode {
  return {
    tick(bb, ctx) {
      for (const c of children) {
        const s = c.tick(bb, ctx);
        if (s !== "failure") return s;
      }
      return "failure";
    },
  };
}

function cond(fn: (bb: Blackboard) => boolean): BTNode {
  return { tick(bb) { return fn(bb) ? "success" : "failure"; } };
}

function act(fn: (bb: Blackboard, ctx: BTContext) => BTStatus): BTNode {
  return { tick: fn };
}

const isMelee = cond((bb) => bb.melee);
const hasTower = cond((bb) => bb.targetTower !== null);
const isLowHp = cond((bb) => bb.hpRatio < 0.35);
const isCritical = cond((bb) => bb.hpRatio < 0.15);
const hasShield = cond((bb) => bb.shield > 0);

const trySkill = act((bb, ctx) => {
  const id = pickSkill(bb.skills, {
    hpRatio: bb.hpRatio,
    hasTower: bb.anyTowerInSkillRange || bb.targetTower !== null,
    boss: bb.boss,
  });
  bb.chosenSkill = id;
  if (!id) return "failure";
  if (!ctx.castSkill(id)) return "failure";
  bb.lastAction = `skill:${id}`;
  ctx.setSpeedMul(0.25);
  return "success";
});

const attackTower = act((bb, ctx) => {
  if (bb.targetTower === null) return "failure";
  if (ctx.attackCd > 0) {
    bb.lastAction = "windup";
    ctx.setSpeedMul(0.12);
    return "running";
  }
  const ok = ctx.attackTower(bb.targetTower, bb.boss ? 28 : 18);
  ctx.setAttackCooldown(bb.boss ? 0.85 : 0.55);
  bb.lastAction = ok ? "smash" : "miss";
  if (ok && bb.boss) ctx.shout("轟！", "#ffd27a");
  ctx.setSpeedMul(0.15);
  return ok ? "success" : "failure";
});

const march = act((bb, ctx) => {
  bb.lastAction = "march";
  ctx.setSpeedMul(1);
  return "success";
});

const rage = act((bb, ctx) => {
  bb.lastAction = "rage";
  ctx.setRage(true);
  ctx.setSpeedMul(1.35);
  if (bb.hpRatio < 0.2) ctx.shout("潮怒", "#ff6fa8");
  return "success";
});

const brace = act((bb, ctx) => {
  bb.lastAction = "brace";
  ctx.setRage(false);
  ctx.setSpeedMul(0.8);
  return "success";
});

const sprint = act((bb, ctx) => {
  bb.lastAction = "sprint";
  ctx.setSpeedMul(1.28);
  return "success";
});

export const meleeTree: BTNode = sel([trySkill, seq([isMelee, hasTower, attackTower]), march]);
export const bossTree: BTNode = sel([
  trySkill,
  seq([isLowHp, rage, sel([seq([hasTower, attackTower]), march])]),
  seq([hasShield, brace, march]),
  seq([isMelee, hasTower, attackTower]),
  march,
]);
export const basicTree: BTNode = sel([trySkill, seq([isCritical, sprint]), march]);

export function treeFor(e: { boss: boolean; melee: boolean }): BTNode {
  if (e.boss) return bossTree;
  if (e.melee) return meleeTree;
  return basicTree;
}

export function tickBrain(
  enemy: { boss: boolean; melee: boolean },
  bb: Blackboard,
  ctx: BTContext,
): BTStatus {
  return treeFor(enemy).tick(bb, ctx);
}
