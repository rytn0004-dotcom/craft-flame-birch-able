import { i as __toESM } from "../_runtime.mjs";
import { K as require_react, b as require_jsx_runtime } from "../_libs/@tanstack/react-router+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-Bsf072fv.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var TOWERS = [
	{
		id: 0,
		name: "銀月狐仙",
		img: "/towers/t01.png",
		cost: 55,
		range: 145,
		damage: 24,
		cooldown: .95,
		special: "high",
		trait: "高傷害",
		color: "#b9dcff"
	},
	{
		id: 1,
		name: "寒霜狐仙",
		img: "/towers/t02.png",
		cost: 70,
		range: 130,
		damage: 10,
		cooldown: .85,
		special: "slow",
		trait: "減速敵人 45%",
		color: "#7ecbff"
	},
	{
		id: 2,
		name: "潮歌狐仙",
		img: "/towers/t03.png",
		cost: 85,
		range: 200,
		damage: 16,
		cooldown: 1.05,
		special: "range",
		trait: "超遠射程",
		color: "#9ad7ff"
	},
	{
		id: 3,
		name: "赤焰狐仙",
		img: "/towers/t04.png",
		cost: 100,
		range: 135,
		damage: 13,
		cooldown: 1,
		special: "burn",
		trait: "燃燒 持續傷害",
		color: "#ff8a55"
	},
	{
		id: 4,
		name: "疾羽狐仙",
		img: "/towers/t05.png",
		cost: 115,
		range: 120,
		damage: 8,
		cooldown: .28,
		special: "rapid",
		trait: "極高射速",
		color: "#d7b6ff"
	},
	{
		id: 5,
		name: "花繚狐仙",
		img: "/towers/t06.png",
		cost: 145,
		range: 150,
		damage: 18,
		cooldown: 1.15,
		special: "aoe",
		trait: "範圍爆炸",
		color: "#ff9ec4"
	},
	{
		id: 6,
		name: "縛影狐仙",
		img: "/towers/t07.png",
		cost: 170,
		range: 125,
		damage: 14,
		cooldown: 1.05,
		special: "root",
		trait: "阻擋：定身 + 強減速",
		color: "#c9a0ff"
	},
	{
		id: 7,
		name: "聖輝狐仙",
		img: "/towers/t08.png",
		cost: 185,
		range: 145,
		damage: 20,
		cooldown: .95,
		special: "break",
		trait: "護盾破擊：易傷 +40%",
		color: "#ffe08a"
	},
	{
		id: 8,
		name: "璃鏈狐仙",
		img: "/towers/t09.png",
		cost: 210,
		range: 140,
		damage: 16,
		cooldown: .9,
		special: "chain",
		trait: "連鎖閃電 3 名",
		color: "#8ef0ff"
	},
	{
		id: 9,
		name: "霞貫狐仙",
		img: "/towers/t10.png",
		cost: 240,
		range: 170,
		damage: 22,
		cooldown: 1.1,
		special: "pierce",
		trait: "穿透直線傷害",
		color: "#ffb0c8"
	},
	{
		id: 10,
		name: "背光狐仙",
		img: "/towers/t11.png",
		cost: 270,
		range: 155,
		damage: 36,
		cooldown: 1.2,
		special: "execute",
		trait: "高傷害，殘血處決",
		color: "#ffd2a8"
	},
	{
		id: 11,
		name: "究極狐仙",
		img: "/towers/t12.png",
		cost: 340,
		range: 175,
		damage: 42,
		cooldown: .85,
		special: "ultimate",
		trait: "高傷 + 燃燒 + 減速 + 範圍",
		color: "#ff6fa8"
	}
];
var ENEMY_TYPES = [
	{
		name: "小妖",
		hp: 42,
		speed: 78,
		gold: 7,
		color: "#6dcaa0",
		r: 11
	},
	{
		name: "狼妖",
		hp: 95,
		speed: 68,
		gold: 16,
		color: "#c48a62",
		r: 13
	},
	{
		name: "石魔",
		hp: 190,
		speed: 50,
		gold: 28,
		color: "#7f93a8",
		r: 16
	},
	{
		name: "炎魔",
		hp: 280,
		speed: 60,
		gold: 42,
		color: "#e07048",
		r: 15
	},
	{
		name: "魔將",
		hp: 460,
		speed: 46,
		gold: 68,
		color: "#b06ad4",
		r: 18
	},
	{
		name: "妖王",
		hp: 820,
		speed: 40,
		gold: 120,
		color: "#ff5f9a",
		r: 21
	}
];
var W = 960;
var H = 600;
var GRID = 40;
var MAX_WAVE = 12;
var PATH = [
	{
		x: -20,
		y: 300
	},
	{
		x: 160,
		y: 300
	},
	{
		x: 160,
		y: 100
	},
	{
		x: 390,
		y: 100
	},
	{
		x: 390,
		y: 470
	},
	{
		x: 610,
		y: 470
	},
	{
		x: 610,
		y: 170
	},
	{
		x: 830,
		y: 170
	},
	{
		x: 830,
		y: 510
	},
	{
		x: 990,
		y: 510
	}
];
var SEGS = [];
var PATH_LEN = 0;
for (let i = 0; i < PATH.length - 1; i++) {
	const a = PATH[i];
	const b = PATH[i + 1];
	const len = Math.hypot(b.x - a.x, b.y - a.y);
	SEGS.push({
		ax: a.x,
		ay: a.y,
		bx: b.x,
		by: b.y,
		len,
		start: PATH_LEN
	});
	PATH_LEN += len;
}
function posAt(dist) {
	const d = Math.max(0, Math.min(PATH_LEN, dist));
	for (const s of SEGS) if (d <= s.start + s.len) {
		const t = s.len === 0 ? 0 : (d - s.start) / s.len;
		return {
			x: s.ax + (s.bx - s.ax) * t,
			y: s.ay + (s.by - s.ay) * t
		};
	}
	const last = PATH[PATH.length - 1];
	return {
		x: last.x,
		y: last.y
	};
}
var BLOCKED = /* @__PURE__ */ new Set();
for (let d = 0; d <= PATH_LEN; d += 8) {
	const p = posAt(d);
	const gx = Math.floor(p.x / GRID);
	const gy = Math.floor(p.y / GRID);
	for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) BLOCKED.add(`${gx + dx},${gy + dy}`);
}
function spawnPlan(wave) {
	const list = [];
	const count = 6 + wave * 2;
	const base = Math.min(ENEMY_TYPES.length - 2, Math.floor((wave - 1) / 2));
	let t = .4;
	for (let i = 0; i < count; i++) {
		let type = base;
		if (Math.random() < .22 && type > 0) type -= 1;
		if (Math.random() < .18 + wave * .02) type = Math.min(ENEMY_TYPES.length - 2, type + 1);
		list.push({
			type,
			at: t
		});
		t += Math.max(.28, .72 - wave * .03);
	}
	if (wave % 4 === 0) list.push({
		type: Math.min(5, 2 + Math.floor(wave / 4)),
		at: t + .6
	});
	return list;
}
function FoxTD() {
	const canvasRef = (0, import_react.useRef)(null);
	const wrapRef = (0, import_react.useRef)(null);
	const [gold, setGold] = (0, import_react.useState)(180);
	const [lives, setLives] = (0, import_react.useState)(20);
	const [wave, setWave] = (0, import_react.useState)(0);
	const [phase, setPhase] = (0, import_react.useState)("ready");
	const [pick, setPick] = (0, import_react.useState)(null);
	const [sel, setSel] = (0, import_react.useState)(null);
	const [hover, setHover] = (0, import_react.useState)("");
	const goldRef = (0, import_react.useRef)(180);
	const livesRef = (0, import_react.useRef)(20);
	const phaseRef = (0, import_react.useRef)("ready");
	const pickRef = (0, import_react.useRef)(null);
	const selRef = (0, import_react.useRef)(null);
	(0, import_react.useEffect)(() => {
		goldRef.current = gold;
	}, [gold]);
	(0, import_react.useEffect)(() => {
		livesRef.current = lives;
	}, [lives]);
	(0, import_react.useEffect)(() => {
		phaseRef.current = phase;
	}, [phase]);
	(0, import_react.useEffect)(() => {
		pickRef.current = pick;
	}, [pick]);
	(0, import_react.useEffect)(() => {
		selRef.current = sel;
	}, [sel]);
	const sim = (0, import_react.useRef)({
		towers: [],
		enemies: [],
		shots: [],
		parts: [],
		floats: [],
		rings: [],
		queue: [],
		clock: 0,
		between: 0,
		wave: 0,
		images: [],
		pointer: {
			x: 0,
			y: 0,
			down: false
		}
	});
	(0, import_react.useEffect)(() => {
		const imgs = TOWERS.map((t) => {
			const img = new Image();
			img.src = t.img;
			return img;
		});
		sim.current.images = imgs;
		const canvas = canvasRef.current;
		const ctx = canvas.getContext("2d");
		let raf = 0;
		let last = performance.now();
		let hudAcc = 0;
		const burst = (x, y, color, n, spd = 2) => {
			for (let i = 0; i < n; i++) sim.current.parts.push({
				x,
				y,
				vx: (Math.random() - .5) * spd * 2,
				vy: (Math.random() - .5) * spd * 2 - .4,
				life: .45 + Math.random() * .35,
				max: .8,
				color,
				size: 2 + Math.random() * 3
			});
		};
		const float = (x, y, text, color) => {
			sim.current.floats.push({
				x,
				y,
				text,
				color,
				life: .8
			});
		};
		const applyStatus = (e, special, dmg) => {
			if (special === "slow" || special === "ultimate" || special === "root") {
				e.slow = special === "root" ? .22 : special === "ultimate" ? .5 : .55;
				e.slowT = special === "root" ? 2.2 : 2.4;
			}
			if (special === "root") e.rootT = Math.max(e.rootT, .55);
			if (special === "burn" || special === "ultimate") {
				e.burn = special === "ultimate" ? 16 : 9;
				e.burnT = 3;
			}
			if (special === "break") {
				e.vuln = 1.4;
				e.vulnT = 3.2;
			}
			if (special === "execute" && e.hp > 0 && e.hp < e.maxHp * .18) e.hp = 0;
		};
		const hitEnemy = (e, dmg, special, color, px, py) => {
			const amount = dmg * (e.vulnT > 0 ? e.vuln : 1);
			e.hp -= amount;
			float(px, py - 16, String(Math.round(amount)), "#fff");
			applyStatus(e, special, dmg);
			burst(px, py, color, 6, 1.6);
			if (special === "aoe" || special === "ultimate") {
				sim.current.rings.push({
					x: px,
					y: py,
					r: 8,
					max: special === "ultimate" ? 96 : 74,
					color,
					life: .28
				});
				for (const o of sim.current.enemies) {
					if (o === e) continue;
					const p = posAt(o.dist);
					if (Math.hypot(p.x - px, p.y - py) < (special === "ultimate" ? 92 : 70)) {
						o.hp -= amount * .65;
						applyStatus(o, special, dmg * .65);
					}
				}
			}
			if (special === "chain") {
				const p0 = posAt(e.dist);
				const near = sim.current.enemies.filter((o) => o !== e).map((o) => ({
					o,
					d: Math.hypot(posAt(o.dist).x - p0.x, posAt(o.dist).y - p0.y)
				})).filter((x) => x.d < 110).sort((a, b) => a.d - b.d).slice(0, 3);
				for (const n of near) {
					n.o.hp -= dmg * .55;
					const np = posAt(n.o.dist);
					burst(np.x, np.y, "#8ef0ff", 4, 1.2);
				}
			}
		};
		const fire = (tw, target) => {
			const def = TOWERS[tw.def];
			const p = posAt(target.dist);
			if (def.special === "pierce") {
				const ang = Math.atan2(p.y - tw.y, p.x - tw.x);
				sim.current.shots.push({
					x: tw.x,
					y: tw.y,
					tx: tw.x + Math.cos(ang) * 900,
					ty: tw.y + Math.sin(ang) * 900,
					speed: 520,
					damage: tw.damage,
					special: def.special,
					color: def.color,
					life: 1.1,
					pierced: /* @__PURE__ */ new Set(),
					target: null
				});
			} else sim.current.shots.push({
				x: tw.x,
				y: tw.y,
				tx: p.x,
				ty: p.y,
				speed: 460,
				damage: tw.damage,
				special: def.special,
				color: def.color,
				life: 1.6,
				pierced: /* @__PURE__ */ new Set(),
				target
			});
			burst(tw.x, tw.y, def.color, 4, 1.4);
		};
		const step = (dt) => {
			const s = sim.current;
			if (phaseRef.current !== "play") return;
			s.clock += dt;
			if (s.queue.length) while (s.queue.length && s.clock >= s.queue[0].at) {
				const job = s.queue.shift();
				const et = ENEMY_TYPES[job.type];
				const scale = 1 + (s.wave - 1) * .16;
				s.enemies.push({
					type: job.type,
					dist: 0,
					hp: et.hp * scale,
					maxHp: et.hp * scale,
					speed: et.speed * (.96 + Math.random() * .08),
					gold: Math.round(et.gold * (1 + s.wave * .14) * (1 + job.type * .12)),
					slow: 1,
					slowT: 0,
					burn: 0,
					burnT: 0,
					rootT: 0,
					vuln: 1,
					vulnT: 0,
					r: et.r,
					color: et.color
				});
			}
			else if (s.enemies.length === 0 && s.wave > 0) {
				s.between += dt;
				if (s.wave >= MAX_WAVE) {
					phaseRef.current = "win";
					setPhase("win");
				} else if (s.between > 7) beginWave();
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
					if (Math.random() < .35) {
						const p = posAt(e.dist);
						burst(p.x, p.y, "#ff6a2a", 1, .8);
					}
				}
				if (e.rootT <= 0) {
					const spd = e.speed * (e.slowT > 0 ? e.slow : 1);
					e.dist += spd * dt;
				}
				if (e.dist >= PATH_LEN) {
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
					const p = posAt(e.dist);
					float(p.x, p.y, `+${e.gold}`, "#ffd27a");
					burst(p.x, p.y, e.color, 12, 2.4);
					s.enemies.splice(i, 1);
				}
			}
			for (const tw of s.towers) {
				tw.cd -= dt;
				let best = null;
				let bestDist = -1;
				for (const e of s.enemies) {
					const p = posAt(e.dist);
					if (Math.hypot(p.x - tw.x, p.y - tw.y) <= tw.range && e.dist > bestDist) {
						bestDist = e.dist;
						best = e;
					}
				}
				if (best && tw.cd <= 0) {
					tw.cd = tw.cooldown;
					fire(tw, best);
				}
			}
			for (let i = s.shots.length - 1; i >= 0; i--) {
				const sh = s.shots[i];
				sh.life -= dt;
				if (sh.special !== "pierce" && sh.target && s.enemies.includes(sh.target)) {
					const p = posAt(sh.target.dist);
					sh.tx = p.x;
					sh.ty = p.y;
				}
				const dx = sh.tx - sh.x;
				const dy = sh.ty - sh.y;
				const dist = Math.hypot(dx, dy) || 1;
				const stepLen = sh.speed * dt;
				sh.x += dx / dist * stepLen;
				sh.y += dy / dist * stepLen;
				if (Math.random() < .7) burst(sh.x, sh.y, sh.color, 1, .4);
				if (sh.special === "pierce") {
					for (const e of s.enemies) {
						if (sh.pierced.has(e)) continue;
						const p = posAt(e.dist);
						if (Math.hypot(p.x - sh.x, p.y - sh.y) < e.r + 10) {
							sh.pierced.add(e);
							hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y);
						}
					}
					if (sh.life <= 0 || dist < stepLen) s.shots.splice(i, 1);
				} else if (dist < 14 || sh.life <= 0) {
					const victims = [];
					if (sh.target && s.enemies.includes(sh.target)) victims.push(sh.target);
					else {
						let near = null;
						let nd = 36;
						for (const e of s.enemies) {
							const p = posAt(e.dist);
							const dd = Math.hypot(p.x - sh.x, p.y - sh.y);
							if (dd < nd) {
								nd = dd;
								near = e;
							}
						}
						if (near) victims.push(near);
					}
					for (const e of victims) {
						const p = posAt(e.dist);
						hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y);
					}
					if (!victims.length && (sh.special === "aoe" || sh.special === "ultimate")) hitEnemyArea(sh);
					s.shots.splice(i, 1);
				}
			}
			function hitEnemyArea(sh) {
				sim.current.rings.push({
					x: sh.x,
					y: sh.y,
					r: 6,
					max: 70,
					color: sh.color,
					life: .25
				});
				for (const e of sim.current.enemies) {
					const p = posAt(e.dist);
					if (Math.hypot(p.x - sh.x, p.y - sh.y) < 70) hitEnemy(e, sh.damage, sh.special, sh.color, p.x, p.y);
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
			hudAcc += dt;
			if (hudAcc > .25) hudAcc = 0;
		};
		const beginWave = () => {
			const s = sim.current;
			if (s.wave >= MAX_WAVE) return;
			if (s.queue.length || s.enemies.length) return;
			s.wave += 1;
			s.clock = 0;
			s.between = 0;
			s.queue = spawnPlan(s.wave);
			setWave(s.wave);
		};
		canvas.__begin = beginWave;
		const draw = () => {
			const s = sim.current;
			ctx.clearRect(0, 0, W, H);
			const g = ctx.createLinearGradient(0, 0, 0, H);
			g.addColorStop(0, "#0c2742");
			g.addColorStop(1, "#061018");
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, W, H);
			ctx.strokeStyle = "rgba(90,150,200,0.12)";
			ctx.lineWidth = 1;
			for (let x = 0; x <= W; x += GRID) {
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, H);
				ctx.stroke();
			}
			for (let y = 0; y <= H; y += GRID) {
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(W, y);
				ctx.stroke();
			}
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.strokeStyle = "rgba(70,140,200,0.35)";
			ctx.lineWidth = 34;
			ctx.beginPath();
			ctx.moveTo(PATH[0].x, PATH[0].y);
			for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i].x, PATH[i].y);
			ctx.stroke();
			ctx.strokeStyle = "rgba(160,220,255,0.18)";
			ctx.lineWidth = 18;
			ctx.stroke();
			const t = performance.now() / 1e3;
			ctx.fillStyle = "rgba(180,230,255,0.08)";
			for (let i = 0; i < 18; i++) {
				const bx = (i * 137 + t * 18) % W;
				const by = (i * 83 + Math.sin(t + i) * 20) % H;
				ctx.beginPath();
				ctx.arc(bx, by, 2 + i % 3, 0, Math.PI * 2);
				ctx.fill();
			}
			if (pickRef.current !== null && phaseRef.current === "play") {
				const def = TOWERS[pickRef.current];
				const gx = Math.floor(s.pointer.x / GRID);
				const gy = Math.floor(s.pointer.y / GRID);
				const px = gx * GRID + GRID / 2;
				const py = gy * GRID + GRID / 2;
				const ok = canPlace(gx, gy);
				ctx.beginPath();
				ctx.arc(px, py, def.range, 0, Math.PI * 2);
				ctx.fillStyle = ok ? "rgba(120,200,255,0.1)" : "rgba(255,80,80,0.12)";
				ctx.fill();
				ctx.strokeStyle = ok ? "rgba(140,210,255,0.55)" : "rgba(255,90,90,0.6)";
				ctx.stroke();
			}
			if (selRef.current !== null && s.towers[selRef.current]) {
				const tw = s.towers[selRef.current];
				ctx.beginPath();
				ctx.arc(tw.x, tw.y, tw.range, 0, Math.PI * 2);
				ctx.fillStyle = "rgba(255,170,210,0.08)";
				ctx.fill();
				ctx.strokeStyle = "rgba(255,170,210,0.45)";
				ctx.stroke();
			}
			for (let i = 0; i < s.towers.length; i++) {
				const tw = s.towers[i];
				const def = TOWERS[tw.def];
				ctx.beginPath();
				ctx.arc(tw.x, tw.y, 24, 0, Math.PI * 2);
				ctx.fillStyle = "rgba(8,20,36,0.9)";
				ctx.fill();
				ctx.strokeStyle = def.color;
				ctx.lineWidth = 2;
				ctx.stroke();
				const img = s.images[tw.def];
				if (img && img.complete && img.naturalWidth) {
					ctx.save();
					ctx.beginPath();
					ctx.arc(tw.x, tw.y, 20, 0, Math.PI * 2);
					ctx.clip();
					ctx.drawImage(img, tw.x - 20, tw.y - 20, 40, 40);
					ctx.restore();
				}
				if (tw.level > 1) {
					ctx.fillStyle = "#ffd27a";
					ctx.font = "bold 11px sans-serif";
					ctx.fillText("L" + tw.level, tw.x - 8, tw.y + 36);
				}
			}
			for (const e of s.enemies) {
				const p = posAt(e.dist);
				ctx.beginPath();
				ctx.arc(p.x, p.y, e.r, 0, Math.PI * 2);
				ctx.fillStyle = e.color;
				ctx.fill();
				ctx.lineWidth = 1.5;
				ctx.strokeStyle = "#fff";
				ctx.stroke();
				if (e.slowT > 0) {
					ctx.beginPath();
					ctx.arc(p.x, p.y, e.r + 4, 0, Math.PI * 2);
					ctx.strokeStyle = "rgba(120,200,255,0.85)";
					ctx.stroke();
				}
				if (e.burnT > 0) {
					ctx.beginPath();
					ctx.arc(p.x, p.y, e.r + 7, 0, Math.PI * 2);
					ctx.strokeStyle = "rgba(255,110,40,0.75)";
					ctx.stroke();
				}
				if (e.vulnT > 0) {
					ctx.beginPath();
					ctx.arc(p.x, p.y, e.r + 10, 0, Math.PI * 2);
					ctx.strokeStyle = "rgba(255,220,120,0.7)";
					ctx.stroke();
				}
				const bw = e.r * 2.2;
				ctx.fillStyle = "#222";
				ctx.fillRect(p.x - bw / 2, p.y - e.r - 10, bw, 4);
				ctx.fillStyle = e.hp / e.maxHp > .35 ? "#5d5" : "#e55";
				ctx.fillRect(p.x - bw / 2, p.y - e.r - 10, bw * Math.max(0, e.hp / e.maxHp), 4);
			}
			for (const sh of s.shots) {
				ctx.shadowColor = sh.color;
				ctx.shadowBlur = 12;
				ctx.beginPath();
				ctx.arc(sh.x, sh.y, sh.special === "pierce" ? 5 : 4, 0, Math.PI * 2);
				ctx.fillStyle = sh.color;
				ctx.fill();
				ctx.shadowBlur = 0;
				ctx.beginPath();
				ctx.arc(sh.x, sh.y, 2, 0, Math.PI * 2);
				ctx.fillStyle = "#fff";
				ctx.fill();
			}
			for (const r of s.rings) {
				ctx.beginPath();
				ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
				ctx.strokeStyle = r.color;
				ctx.globalAlpha = Math.max(0, r.life / .28);
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
				ctx.globalAlpha = Math.max(0, f.life / .8);
				ctx.fillStyle = f.color;
				ctx.fillText(f.text, f.x, f.y);
				ctx.globalAlpha = 1;
			}
			ctx.textAlign = "left";
		};
		const loop = (now) => {
			const dt = Math.min(.05, (now - last) / 1e3);
			last = now;
			step(dt);
			draw();
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		const local = (ev) => {
			const rect = canvas.getBoundingClientRect();
			return {
				x: (ev.clientX - rect.left) / rect.width * W,
				y: (ev.clientY - rect.top) / rect.height * H
			};
		};
		const onMove = (ev) => {
			sim.current.pointer = {
				...local(ev),
				down: true
			};
		};
		const onDown = (ev) => {
			const p = local(ev);
			sim.current.pointer = {
				...p,
				down: true
			};
			if (phaseRef.current !== "play") return;
			const s = sim.current;
			for (let i = 0; i < s.towers.length; i++) {
				const tw = s.towers[i];
				if (Math.hypot(tw.x - p.x, tw.y - p.y) < 26) {
					selRef.current = i;
					setSel(i);
					pickRef.current = null;
					setPick(null);
					return;
				}
			}
			const id = pickRef.current;
			if (id === null) {
				selRef.current = null;
				setSel(null);
				return;
			}
			const gx = Math.floor(p.x / GRID);
			const gy = Math.floor(p.y / GRID);
			const def = TOWERS[id];
			if (!canPlace(gx, gy)) {
				setHover("不能放在路徑或已有塔的格子");
				return;
			}
			if (goldRef.current < def.cost) {
				setHover("金幣不夠");
				return;
			}
			goldRef.current -= def.cost;
			setGold(goldRef.current);
			s.towers.push({
				def: id,
				x: gx * GRID + GRID / 2,
				y: gy * GRID + GRID / 2,
				damage: def.damage,
				cooldown: def.cooldown,
				range: def.range,
				cd: 0,
				level: 1
			});
			setHover(`已放置 ${def.name}`);
		};
		canvas.addEventListener("pointermove", onMove);
		canvas.addEventListener("pointerdown", onDown);
		return () => {
			cancelAnimationFrame(raf);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("pointerdown", onDown);
		};
	}, []);
	function canPlace(gx, gy) {
		if (gx < 0 || gy < 0 || gx >= W / GRID || gy >= H / GRID) return false;
		if (BLOCKED.has(`${gx},${gy}`)) return false;
		for (const t of sim.current.towers) if (Math.floor(t.x / GRID) === gx && Math.floor(t.y / GRID) === gy) return false;
		return true;
	}
	function start() {
		sim.current.towers = [];
		sim.current.enemies = [];
		sim.current.shots = [];
		sim.current.parts = [];
		sim.current.floats = [];
		sim.current.rings = [];
		sim.current.queue = [];
		sim.current.wave = 0;
		sim.current.between = 0;
		goldRef.current = 180;
		livesRef.current = 20;
		setGold(180);
		setLives(20);
		setWave(0);
		setSel(null);
		selRef.current = null;
		phaseRef.current = "play";
		setPhase("play");
		canvasRef.current.__begin?.();
	}
	function callWave() {
		const c = canvasRef.current;
		if (sim.current.enemies.length === 0 && sim.current.queue.length === 0 && sim.current.wave > 0 && sim.current.wave < MAX_WAVE) {
			goldRef.current += 25;
			setGold(goldRef.current);
			setHover("提前出波 +25 金");
		}
		c.__begin?.();
	}
	function upgrade(kind) {
		if (sel === null) return;
		const tw = sim.current.towers[sel];
		if (!tw) return;
		const cost = kind === "dmg" ? 40 * tw.level : 36 * tw.level;
		if (goldRef.current < cost) {
			setHover("金幣不夠升級");
			return;
		}
		goldRef.current -= cost;
		setGold(goldRef.current);
		if (kind === "dmg") tw.damage *= 1.25;
		else tw.cooldown = Math.max(.16, tw.cooldown * .8);
		tw.level += 1;
		setHover(kind === "dmg" ? "傷害提升" : "射速提升");
		setSel(sel);
	}
	function sell() {
		if (sel === null) return;
		const tw = sim.current.towers[sel];
		if (!tw) return;
		const refund = Math.floor(TOWERS[tw.def].cost * .6);
		goldRef.current += refund;
		setGold(goldRef.current);
		sim.current.towers.splice(sel, 1);
		selRef.current = null;
		setSel(null);
		setHover(`賣出 +${refund}`);
	}
	const selected = sel !== null ? sim.current.towers[sel] : null;
	const selectedDef = selected ? TOWERS[selected.def] : null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "td-shell",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
			className: "mx-auto flex max-w-[1320px] items-end justify-between px-4 pt-4",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs tracking-[0.28em] text-[#8ec8ee]",
				children: "UNDERWATER WARD"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "font-['Cormorant_Garamond'] text-4xl leading-none text-[#ffe7f1]",
				children: "狐仙塔防"
			})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "hidden text-sm text-[#9ec4de] sm:block",
				children: "越後面的狐仙越強 · 強敵掉更多金幣"
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "td-layout",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "stage",
				ref: wrapRef,
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("canvas", {
						ref: canvasRef,
						width: W,
						height: H
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "hud-float",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "chip",
								children: ["生命 ", lives]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "chip",
								children: ["金幣 ", gold]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "chip",
								children: [
									"波次 ",
									wave,
									"/",
									MAX_WAVE
								]
							})
						]
					}),
					phase !== "play" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "overlay",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: phase === "win" ? "潮退，聖地仍在" : phase === "lose" ? "結界破碎" : "狐仙結界" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mb-4 max-w-md text-sm text-[#c5dff2]",
								children: phase === "ready" ? "沿水道而來的妖潮會越來越強。放置狐仙，點塔升級傷害或射速。後面的角色帶有減速、燃燒、阻擋與護盾破擊。" : phase === "win" ? "十二波妖潮已被擋下。" : "生命歸零。重新布置結界再試一次。"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								className: "btn",
								onClick: start,
								children: phase === "ready" ? "開始守城" : "重新開始"
							})
						]
					})
				]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
				className: "panel",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "mb-2 flex gap-2",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							className: "btn ghost flex-1",
							onClick: callWave,
							disabled: phase !== "play",
							children: "下一波"
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mb-2 min-h-5 text-xs text-[#ffd7a8]",
						children: hover
					}),
					selected && selectedDef && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mb-3 rounded-xl border border-[#ff9ec455] bg-[#2a1630aa] p-2 text-xs leading-5",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", {
								style: { color: selectedDef.color },
								children: selectedDef.name
							}),
							" Lv.",
							selected.level,
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: ["特性：", selectedDef.trait] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
								"傷害 ",
								Math.round(selected.damage),
								" · 射速 ",
								(1 / selected.cooldown).toFixed(2),
								"/秒 · 射程 ",
								Math.round(selected.range)
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "mt-2 flex gap-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									className: "btn ghost flex-1",
									onClick: () => upgrade("dmg"),
									children: ["傷害 ", 40 * selected.level]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									className: "btn ghost flex-1",
									onClick: () => upgrade("rate"),
									children: ["射速 ", 36 * selected.level]
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								className: "btn ghost mt-2 w-full",
								onClick: sell,
								children: "賣出"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mb-2 text-xs text-[#8eb6d4]",
						children: "守護者（依圖片順序，越後越強）"
					}),
					TOWERS.map((t) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						className: "tower-card" + (pick === t.id ? " on" : ""),
						onClick: () => {
							setPick(t.id);
							pickRef.current = t.id;
							setSel(null);
							selRef.current = null;
							setHover(`${t.name}：${t.trait}`);
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
							src: t.img,
							alt: ""
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", {
								className: "block text-sm",
								style: { color: t.color },
								children: t.name
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "text-[#ffd27a]",
								children: ["💰 ", t.cost]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "mt-0.5 block text-[11px] text-[#b7ddf5]",
								children: t.trait
							})
						] })]
					}, t.id))
				]
			})]
		})]
	});
}
function Home() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FoxTD, {});
}
//#endregion
export { Home as component };
