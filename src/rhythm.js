// Your rhythm, learned: which hours actually work for you, from what you did rather than what a textbook says.
//
// The planner starts from a fixed alertness curve (src/smart.js: peak after waking, a post-lunch dip, a second
// wind). That is a fair guess for a stranger. This module replaces the guess with evidence, hour by hour:
//   • a work session you marked Done            → that hour worked
//   • a session you marked Missed               → it didn't
//   • a block Donna placed that you dragged   → the old hour didn't work, the new one does
//   • a block Donna placed that you deleted   → weak evidence against that hour
//   • Good / Undo / Bad on something Donna placed on its own
//
// Per kind of effort (focus work, exercise, light work) each hour keeps two numbers: times it worked, times it
// didn't. An hour's score is its success rate, pulled towards your own overall rate while evidence is thin
// (so two bad mornings nudge, twenty decide) and compared with that overall rate (so someone who misses a
// third of everything isn't told every hour is bad). The planner adds the result to its slot score: with no
// evidence nothing changes, and no amount of evidence can place work outside waking hours or over a commitment.
// Old evidence fades: the totals are capped, so the last few months outweigh last year.
import { load, save } from './store.js';
import * as T from './time.js';
import { demandOf } from './smart.js';

export const CLASSES = { deep: 'Focus work', physical: 'Exercise', light: 'Light work' };
/** Hour-units of evidence kept per kind; beyond it everything is scaled down, so recent weeks count most. */
const CAP = 120;
/** Below this much evidence (hour-units) nothing is concluded. */
const MIN_EVIDENCE = 3;
/** Pseudo-observations at your overall rate added to every hour: the shrinkage that keeps thin evidence gentle. */
const PRIOR = 2;
/** Score points per unit of lift (an hour that works 30 points more often than your average → +0.9). */
const GAIN = 3;
/** The most an hour's history may add or take away. The fixed curve spans about 2.5 points for focus work. */
const MAX_BIAS = 1.2;

/** Which learned curve a kind of effort uses, or '' for kinds that aren't auto-placed by energy (meals, meetings). */
export const classOf = demand => demand === 'deep' ? 'deep' : demand === 'physical' ? 'physical' : demand === 'light' || demand === 'neutral' ? 'light' : '';
const zeros = () => Array(24).fill(0);

function bucket(create) {
  const m = load('memory');
  if (!m.rhythm || typeof m.rhythm !== 'object') { if (!create) return null; m.rhythm = { n: 0 }; }
  return m.rhythm;
}

/**
 * Records that [start, end) worked (good = true) or didn't for this kind of effort.
 * Each hour gets credit for the share of it the block covered; weight scales weaker signals.
 */
export function noteRhythm(good, demand, start, end, weight = 1) {
  const cls = classOf(demand);
  if (!cls || !start || !end || !(end > start) || !(weight > 0)) return;
  const r = bucket(true);
  const c = r[cls] || (r[cls] = { good: zeros(), bad: zeros() });
  const side = good ? c.good : c.bad;
  const len = Math.min(T.diffMin(start, end), 8 * 60);
  for (let done = 0, m = T.mins(start); done < len;) {
    const step = Math.min(60 - (m % 60), len - done);
    side[Math.floor(m / 60) % 24] += weight * step / 60;
    done += step; m += step;
  }
  const total = c.good.reduce((a, b) => a + b, 0) + c.bad.reduce((a, b) => a + b, 0);
  if (total > CAP) for (const arr of [c.good, c.bad]) for (let h = 0; h < 24; h++) arr[h] = +(arr[h] * CAP / total).toFixed(3);
  r.n = (r.n || 0) + 1;
  r.updated = T.nowStr();
  save('memory');
}

/** The same, for a calendar block (its title and kind say what kind of effort it was). */
export const noteBlock = (good, ev, weight = 1) => { if (ev && ev.start && !ev.allDay) noteRhythm(good, demandOf(ev.title, ev.kind), ev.start, ev.end, weight); };

function analyse(c) {
  if (!c) return null;
  // An hour borrows half of what its neighbours saw: 09:00 going badly says something about 08:00 and 10:00.
  const sm = arr => arr.map((v, h) => v + 0.5 * (arr[(h + 23) % 24] + arr[(h + 1) % 24]));
  const G = c.good.reduce((a, b) => a + b, 0), B = c.bad.reduce((a, b) => a + b, 0);
  if (G + B < MIN_EVIDENCE) return null;
  const base = (G + 1) / (G + B + 2);
  const g = sm(c.good), b = sm(c.bad);
  const bias = g.map((_, h) => {
    const n = g[h] + b[h];
    if (!n) return 0;
    const rate = (g[h] + base * PRIOR) / (n + PRIOR);
    return +Math.max(-MAX_BIAS, Math.min(MAX_BIAS, GAIN * (rate - base))).toFixed(3);
  });
  return { bias, base, evidence: G + B };
}

/** Score adjustment per hour of the day (24 numbers) for this kind of effort, or null when there is nothing to go on. */
export function rhythmBias(demand) {
  const r = bucket(false), cls = classOf(demand);
  const a = r && cls ? analyse(r[cls]) : null;
  return a && a.bias.some(Boolean) ? a.bias : null;
}

/** For the app (Memory, Today): what has been learned, per kind of effort and hour. */
export function rhythmView() {
  const r = bucket(false);
  const kinds = [];
  for (const [id, label] of Object.entries(CLASSES)) {
    const c = r && r[id];
    if (!c) continue;
    const a = analyse(c);
    const evidence = c.good.reduce((x, y) => x + y, 0) + c.bad.reduce((x, y) => x + y, 0);
    kinds.push({ id, label, evidence: +evidence.toFixed(1), ready: !!a, usual: a ? Math.round(a.base * 100) : null,
      hours: c.good.map((g, h) => ({ h, worked: +g.toFixed(2), didnt: +c.bad[h].toFixed(2), lean: a ? a.bias[h] : 0 })) });
  }
  return { signals: (r && r.n) || 0, updated: (r && r.updated) || null, needed: MIN_EVIDENCE, kinds };
}

/** Forget everything learned (Memory → Start over). */
export function resetRhythm() { const m = load('memory'); delete m.rhythm; save('memory'); }
