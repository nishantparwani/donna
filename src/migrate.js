// One-time upgrades of stored data. Each step runs once (state.schema) and only changes values the user
// never customised.
import * as T from './time.js';
import { load, save, DEFAULT_SETTINGS } from './store.js';
import { ruleSimilarity, parseWindows } from './engine.js';

const V1_HIGH = 'board, investor, interview, client, pitch, exec, leadership';
const V1_PROTECTED = 'family, school, pickup, doctor, dentist, gym, kids, personal';
const RETIRED_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3-flash'];
const SCHEMA = 2; // v2 step; v3 has its own below

export function migrate() {
  const st = load('state');
  let changed = false;
  if ((st.schema || 1) < 2) changed = toV2(st);
  if ((st.schema || 1) < 3) changed = toV3(st) || changed;
  if ((st.schema || 1) < 4) changed = toV4(st) || changed;
  if ((st.schema || 1) < 5) changed = toV5(st) || changed;
  return changed;
}

function toV2(st) {
  const s = load('settings');
  if (s.highStakesKeywords === V1_HIGH) s.highStakesKeywords = DEFAULT_SETTINGS.highStakesKeywords;
  if (s.protectedKeywords === V1_PROTECTED) s.protectedKeywords = DEFAULT_SETTINGS.protectedKeywords;
  // The free tier of these models runs out after a handful of calls; Flash-Lite has real headroom.
  if (!s.geminiModel || RETIRED_MODELS.includes(s.geminiModel)) s.geminiModel = DEFAULT_SETTINGS.geminiModel;
  // v1's fixed focus blocks become a flexible habit — but only if the user had autonomy on (they wanted them).
  if (s.autonomous && Number(s.focusBlocksPerDay) > 0 && Number(s.focusMinutes) > 0) {
    const h = load('habits');
    if (!h.items.length) {
      for (let i = 0; i < Number(s.focusBlocksPerDay); i++) {
        h.items.push({ id: 'H' + (++h.seq), title: '🎯 Focus', minutes: Number(s.focusMinutes), days: 'MO,TU,WE,TH,FR',
          windowStart: s.workStart || '09:00', windowEnd: s.workEnd || '18:00', idealTime: '', kind: 'focus', active: true, created: T.nowStr() });
      }
      save('habits');
    }
  }
  delete s.focusBlocksPerDay; delete s.focusMinutes;
  save('settings');
  // v1 model blocks / usage use a different shape.
  delete st.modelBlocked; delete st.llmUsage;
  st.schema = SCHEMA;
  save('state');
  const c = load('chat');
  c.messages.push({ role: 'assistant', time: T.nowStr(), actions: [], text: `🎉 I've been upgraded. New:
- Repeating events ("DSA every weekday 7:30pm till Nov 30"), and deleting or moving a whole series at once
- Tasks with deadlines: tell me "OS assignment due Friday, ~3 hours" and I book study sessions before it's due
- Habits: "gym 1h sometime between 5 and 9pm on weekdays"
- Search months ahead: "when is my next dentist?", "delete all X events"
- A free AI router, so I don't stop when one free quota runs out
- Today view, insights, a booking page, Meet links, briefings, voice input, and an installable phone app${s.autonomous ? '' : '\n\nBackground autonomy is still paused, as you left it. Turn it on in Settings when you want me to keep plans in shape on my own.'}` });
  save('chat');
  return true;
}

/** "6:00", "AM" → minutes of day. */
const toMin = (h, m, ap) => (Number(h) % 12 + (/pm/i.test(ap || '') ? 12 : 0)) * 60 + Number(m || 0);

/**
 * v3: rules that were only text become settings the code enforces (wake-up time, when an activity may
 * happen, night-owl dates), near-duplicate rules merge, and the user hears what is new.
 */
function toV3(st) {
  const s = load('settings');
  const m = load('memory');
  const notes = [];
  for (const r of m.rules.filter(x => x.active)) {
    const t = r.text;
    const wake = /wake[- ]?up time (?:of |is )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t) || /before (?:the user'?s? )?(?:wakes?|waking)[^0-9]{0,20}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t);
    if (wake) {
      const w = toMin(wake[1], wake[2], wake[3] || 'am');
      if (w >= 4 * 60 && w <= 13 * 60 && (!s.dayStart || s.dayStart === DEFAULT_SETTINGS.dayStart || T.hm(s.dayStart) < w)) {
        s.dayStart = T.toHM(w); r.active = false; r.note = 'now the wake-up setting';
        notes.push(`wake-up time ${s.dayStart} is now a setting (nothing gets auto-placed before it)`);
      }
      continue;
    }
    if (/\b12\s*(?:am|a\.m\.)\b.*\b2\s*(?:am|a\.m\.)\b.*tomorrow/i.test(t)) {
      r.active = false; r.note = 'built in (night-owl dates)';
      notes.push('"tomorrow" after midnight = the day you wake up into — built in now, until 4 AM');
      continue;
    }
    const act = /schedule\s+"?([a-z][a-z ]{1,20}?)"?\s+(?:events?\s+|sessions?\s+)?only\s+(?:at|between|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+or\s+after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(t);
    if (act) {
      const ap2 = act[7] || act[4] || 'am';
      const a = toMin(act[2], act[3], act[4] || ap2), b = toMin(act[5], act[6], ap2);
      const wins = [];
      if (b > a) wins.push(`${T.toHM(a)}-${T.toHM(Math.min(1440, b + 60))}`); // "at 6–7 AM" = starting then
      if (act[8]) { const c = toMin(act[8], act[9], act[10] || 'pm'); wins.push(`${T.toHM(c)}-${T.toHM(Math.max(c + 120, Math.min(1440, T.hm(s.dayEnd || '23:00') - 60)))}`); }
      const word = act[1].trim().toLowerCase();
      const match = /^run/.test(word) ? 'run, running, jog, jogging, marathon' : word;
      if (wins.length && parseWindows(wins.join(', ')).length) {
        s.activityWindows = [...(s.activityWindows || []).filter(x => x.match !== match), { match, windows: wins.join(', ') }];
        r.active = false; r.note = 'now an enforced time window';
        notes.push(`${word}: only ${wins.join(' or ')} (enforced in code now)`);
      }
    }
  }
  // Rules that say the same thing three ways become one (the newest wording wins).
  const active = m.rules.filter(x => x.active);
  let merged = 0;
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    if (active[i].active && active[j].active && ruleSimilarity(active[i].text, active[j].text) >= 0.5) { active[i].active = false; active[i].note = 'merged into ' + active[j].id; merged++; }
  }
  if (merged) notes.push(`merged ${merged} duplicate rule${merged === 1 ? '' : 's'}`);
  save('settings'); save('memory');
  st.schema = 3; save('state');
  const c = load('chat');
  if (c.messages.length) {
    c.messages.push({ role: 'assistant', time: T.nowStr(), actions: [], text: `🚀 Upgraded to v3. New:
- **Plan my day**: give me your list ("CFA 2h, project, 5k run, assignments — max productivity") and I build the whole day around your classes in one go: focus-length blocks, breaks, lunch/dinner, gaps filled
- **"I woke up just now"** re-plans the rest of today instantly (no AI needed); "running 30 min late" shifts what's next
- **Nothing gets cancelled unless you say cancel** — I move things instead (enforced in code)
- **Weekly goals**: "10 hours of CFA a week" — your own CFA blocks count, I book only the shortfall
- **Radar**: exams, evaluations, deadlines and trips coming up — including classes that fall while you're travelling
- Bulk rename / pasted lists in one step, no double-booked flights, "every 5 hours" skips your sleep, "undo that" reverts a whole plan
- Briefing comes 45 min before your first commitment on early days${notes.length ? '\n\nFrom your feedback, now built in:\n' + notes.map(n => '- ' + n).join('\n') : ''}` });
    save('chat');
  }
  return true;
}

const OLD_ORDER = 'workers-ai,gemini,groq,cerebras,openrouter,mistral';
/** v4: the faster, better model answers first; old "needs attention" leftovers are dropped (now computed live). */
function toV4(st) {
  const s = load('settings');
  if (!s.aiOrder || s.aiOrder.join(',') === OLD_ORDER) s.aiOrder = DEFAULT_SETTINGS.aiOrder.slice();
  save('settings');
  delete st.lastIssuesList; delete st.lastIssues;
  st.schema = 4; save('state');
  return true;
}

/** v5: the user asked (2026-10-20) for background autonomy on, with evening planning of the next day. */
function toV5(st) {
  load('settings').autonomous = true;
  save('settings');
  st.schema = 5; save('state');
  const c = load('chat');
  c.messages.push({ role: 'assistant', time: T.nowStr(), actions: [], text: '🤖 Autonomy is on. Every 15 minutes I keep task sessions, habits and buffers in place and fix clashes, and when you open the app after 6 pm I get tomorrow ready on my own. Everything I decide shows on the Today screen with an Undo button.' });
  save('chat');
  return true;
}
