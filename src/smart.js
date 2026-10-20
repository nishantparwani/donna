// Smart placement: where in a day a block fits BEST, not just where it fits first.
// Every candidate start gets a score from:
//   • energy   deep work (study, CFA, DSA, projects) goes to the user's peak hours, light work (review,
//              email, errands) to the dips, workouts to morning / early evening — all anchored on the
//              user's own wake-up and wind-down times, so a 09:30 riser peaks later than a 06:00 one
//   • slivers  a placement that leaves a useless 10–25 min scrap of free time is worse than one that
//              sits snug against a class or leaves a usable gap
//   • rhythm   no two deep blocks glued together, parts of the same item spread out, not stacked
//   • wishes   closeness to a time the user hinted at ("around 7pm"); a mild pull towards earlier
// Pure functions on minutes of the day; callers pass in what is busy.

const DEEP = /\b(study|studies|cfa|frm|dsa|leetcode|code|coding|program\w*|project|assignment|homework|thesis|research|write|writing|essay|report|paper|exams?|prep|preparation|revision|revise|practice|problems?|maths?|physics|chem\w*|deep|focus|build\w*|design|analysis|model\w*|learn\w*|course|ml|ai|case study|mock|portfolio)\b/i;
const LIGHT = /\b(review|read|reading|emails?|inbox|admin|errands?|chores?|laundry|groceries|shopping|calls?|planning|journal\w*|organi[sz]e|clean\w*|reply|messages|notes|flashcards?|anki|podcast|news|tidy)\b/i;
const PHYSICAL = /\b(run|running|jog\w*|walk|gym|workout|exercise|yoga|swim\w*|cycl\w*|sports?|football|cricket|badminton|tennis|marathon|stretch\w*|5k|10k)\b/i;
const MEAL = /\b(lunch|dinner|breakfast|brunch|meal|snack)\b/i;

/** What kind of effort a block takes: deep | light | physical | meal | social | neutral. */
export function demandOf(title, kind) {
  const t = String(title || '');
  if (MEAL.test(t)) return 'meal';
  if (PHYSICAL.test(t)) return 'physical';
  if (kind === 'meeting') return 'social';
  if (LIGHT.test(t) && !/\b(exams?|tests?|mock)\b/i.test(t)) return 'light';
  if (DEEP.test(t) || kind === 'focus' || kind === 'task') return 'deep';
  return 'neutral';
}

/** Alertness (0–1) at minute m of the day for someone who wakes at `wake` and winds down at `sleep`. */
export function energy(m, wake, sleep) {
  if (sleep <= wake) sleep = 1440;
  if (m < wake) return 0.15;
  if (m >= sleep) return 0.15;
  const since = m - wake;
  const dip = Math.max(13 * 60 + 30, wake + 5 * 60); // post-lunch slump
  if (since < 45) return 0.45 + 0.35 * since / 45;  // still waking up
  if (m >= dip && m < dip + 105) return 0.55;
  if (sleep - m <= 60) return 0.35;                 // last hour: wind down
  if (sleep - m <= 150) return 0.62;
  if (since < 4 * 60 + 15) return 1;                // first peak
  return m < dip ? 0.85 : 0.88;                     // late morning / second wind
}

function avgEnergy(t, len, wake, sleep) {
  let n = 0, sum = 0;
  for (let m = t; m < t + len; m += 15) { sum += energy(m, wake, sleep); n++; }
  return n ? sum / n : 0;
}

/**
 * Score of starting a block at minute t (higher is better).
 * @param {object} c
 *   demand, wake, sleep           see demandOf / energy
 *   from                          planning starts here (for the pull towards earlier)
 *   earlyWeight                   points lost per hour after `from` (0.08 today, smaller for later days)
 *   ideal, idealWeight            a time the user hinted at (minutes) or null, and how hard it pulls
 *   free                          [lo, hi] the free stretch this start sits in (breaks already taken off)
 *   neighbors                     [{a, b, demand}] blocks already on the day
 *   same                          [{a, b}] other parts of the same item on this day
 *   brk                           break between blocks
 */
export function scoreSlot(t, len, c) {
  const { demand, wake, sleep } = c;
  const e = avgEnergy(t, len, wake, sleep);
  let s = 0;
  if (demand === 'deep') s += 3 * e;
  else if (demand === 'light') s += 1.2 * (1 - Math.abs(e - 0.6)) - (e > 0.95 ? 0.6 : 0); // leave the peak for deep work
  else if (demand === 'physical') {
    const morning = t >= wake + 20 && t + len <= wake + 180;
    const evening = t >= 17 * 60 && t + len <= 20 * 60 + 30;
    s += morning || evening ? 1.6 : t + len > sleep - 90 ? -1 : 0.4;
  } else if (demand === 'social') s += 1.2 * e;
  else s += e;

  if (c.ideal != null) s -= (c.idealWeight ?? 1.4) * Math.abs(t - c.ideal) / 60;
  if (c.from != null) s -= (c.earlyWeight ?? 0.08) * Math.max(0, t - c.from) / 60;

  if (c.free) {
    const before = t - c.free[0], after = c.free[1] - (t + len);
    for (const left of [before, after]) {
      if (left === 0) s += 0.25;               // snug: no wasted time
      else if (left > 0 && left < 20) s -= 0.1; // just a longer breather
      else if (left >= 20 && left < 30) s -= 0.6; // a scrap too short to use
      else if (left < 0) s -= 0.6;              // no breather before / after
    }
  }
  const brk = c.brk ?? 10;
  for (const n of c.neighbors || []) {
    const touching = (n.b <= t && t - n.b <= brk + 10) || (n.a >= t + len && n.a - (t + len) <= brk + 10);
    if (touching && demand === 'deep' && n.demand === 'deep') s -= 0.5;  // give the brain a real break
    if (touching && demand === 'physical' && n.demand === 'meal') s -= 0.8;
    if (demand === 'deep' && n.b <= t && t - n.b <= 30 && n.b - n.a >= 150) s -= 0.4; // straight out of a long lab or class
  }
  for (const p of c.same || []) {
    const gap = t >= p.b ? t - p.b : p.a - (t + len);
    if (gap < 60) s -= 1.5; else if (gap < 120) s -= 0.4; // spread the parts of one item
  }
  return s;
}

/** The free stretch around [t, t+len) given busy [a, b) ranges and a break, clipped to [lo, hi]. */
export function freeAround(t, len, busy, brk, lo, hi) {
  let a = lo, b = hi;
  for (const [x, y] of busy) {
    if (y <= t) a = Math.max(a, y + brk);
    else if (x >= t + len) b = Math.min(b, x - brk);
  }
  return [a, b];
}

/** Why a slot was chosen, in a few words (shown to the model, which passes it on). */
export function reasonFor(t, len, demand, wake, sleep) {
  const e = avgEnergy(t, len, wake, sleep);
  if (demand === 'deep') return e >= 0.95 ? 'peak focus hours' : e >= 0.8 ? 'good focus time' : 'best time left that day';
  if (demand === 'light') return 'lighter-energy time, keeps your peak free';
  if (demand === 'physical') return 'a good time for exercise';
  return 'fits well';
}
