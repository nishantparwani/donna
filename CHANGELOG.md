# Changelog

What changed in each version and why. Newest first. Setup, architecture and how to contribute are in [README.md](README.md).

## v9: learns your hours, WhatsApp removed (Nov 2026)
Tests: `test/v9.js` (13 cases), run by `npm test`.
- **WhatsApp is gone.** The channel (`src/whatsapp.js`, the `/api/whatsapp` webhook, its Settings section, the privacy
  page Meta required and voice-note transcription) is removed. On the first request after the upgrade, migration step 8
  deletes its stored settings and message ids, and its two secrets leave the encrypted vault the next time it is saved.
  If a Meta app was ever connected, delete it at developers.facebook.com: nothing here talks to it any more.
- **The planner learns which hours work for you** (`src/rhythm.js`). Until now the "energy" behind every automatic
  placement was one fixed curve for everybody, and the things Donna recorded about you (check-ins, edits, feedback)
  were shown in Memory but never used. Now each Done / Missed check-in, each block of Donna's that you drag or
  delete, and each Good / Undo / Bad on something it placed counts for or against that hour of the day. The planner
  adds the result to its slot score: with no record nothing changes; a few sessions nudge; a few weeks decide. It can
  never place work while you are asleep or over a commitment. Memory → **Your hours** shows what it has learned, hour
  by hour, with a table view and "start over"; the strip on Today uses it too.
- **People called Kal, Sham, Subah, Raat or Aaj keep their names.** "Lunch with Kal at 1pm" was booked as "Lunch with"
  on the wrong day, because those words were read as Hinglish for tomorrow / evening / morning / night / today. They
  are now only read that way beside a form no English sentence has ("6 baje", "saade 9", "2 ghante").
- **A request is saved in one transaction.** A chat that changed the action log, tasks, chat and state used to write
  four rows one after another; a Worker that died in between left them out of step. They now go to D1 as one batch
  (all or nothing, one round trip), the encrypted keys included.
- **Laptop widths with the chat open:** the top bar's buttons no longer run under the chat panel (labels fold to
  icons by the bar's own width), and the date and live clock on Today no longer overlap. Settings opens with a
  numbered list of its sections.

## v6.1: "Timetable" design
The interface was rebuilt around one idea: a working diary set like a timetable. Warm paper and black ink (or the
reverse at night), hairline rules instead of cards and shadows, one signal colour (vermilion by default; cobalt, forest
or ink-only in Settings → You) that only ever means *now*, *needs you* or *your next action*. One typeface, Times New Roman, everywhere;
size, case and spacing carry the hierarchy. on the date and what is next; the index is numbered like a diary's contents.

## v6: colours as priorities, safe under load (Nov 2026 assessment)
Everything here stays on free tiers. Tests: `test/v6.js` (21 cases), run by `npm test`.
- **Colours = priorities**, the same 11 colours as Google Calendar, ranked red > orange > yellow > green > light green >
  blue > dark blue > purple > lavender > pink > grey (Settings → Colours & priority to reorder). Say "color red",
  "in yellow", "high/low priority", or "make gym red"; colours set in Google count too. Booking or moving a coloured
  event over lower-priority ones cancels them (never events with other guests, which would email them); the same
  colour means simultaneous; uncoloured events have no priority. Needs **bridge v5** to show in Google
  (Settings → Calendar shows the update steps).
- **Nobody is emailed unless you ask.** Invites (and Meet links) only when you say invite/share/notify or type an
  address; dinner with Mom stays on your calendar only, and the reply says how to invite.
- **Dates and times read right without the AI:** "tomorrow morning at 6" (06:00), "dinner at 8" (20:00), ranges
  ("from 12 noon till 3pm", "4-6pm"), "day after tomorrow", 20/11, "in 3 days". Impossible dates ("30 Feb") are refused,
  never rolled into March; "SAT prep" and "lunch in the sun" are not weekends.
- **Private AI (optional, off by default):** Gemini is used as before. Turn this on in Settings → AI if you ever want
  calendar text kept away from free tiers that may train on it (Gemini free tier, OpenRouter free models).
- **Keys and tokens encrypted at rest:** AES-256-GCM in their own D1 row (`vault`), key derived from the
  `SESSION_SECRET` Worker secret; never in the data rows, backups or downloads. The bridge file no longer contains
  the token (the app fills it in when you copy it).
- **One writer at a time** across every Worker instance (a free Durable Object lease, `WriterLock`), so the 15-min
  check, your phone and your laptop can no longer overwrite each other's changes or undo history. Views skip the lock.
- **Backups:** a copy of every data row inside D1 each day, kept 14 days (`bak:YYYY-MM-DD:<row>`), plus
  Settings → Health & backups → *Download a backup*. **Health:** requests answered in code / by AI / failed, reply
  time, and how often you undo Donna's changes.
- **Hardening:** Content-Security-Policy (no inline scripts), passkey sign-in can't be locked out by strangers'
  password attempts, constant-time token check in the bridge, service-worker cache named from the app's content.
- **Delivery:** `npm run deploy` builds, refuses uncommitted changes, runs every test, then deploys tagged with the
  commit (`/api/version`). `.github/workflows/test.yml` runs the tests on every push.

## v5.1: the scheduler itself, measured
`eval/plan-bench.js` (runs in `npm test`, ~1 s, no AI) sets up realistic student weeks and checks every placement:
no overlaps, nothing while asleep / in the past / after a deadline, work booked vs. work that could fit, deep work in
peak hours, scraps, cramming on the deadline day, heaviest day, and churn when the autopilot re-plans every 15 min.
What it found, now fixed:
- **Crunches were flagged "at risk" while time was free** (20 h of exam prep in 5 days → only 16 h booked): fixed caps
  of 2 sessions a day / 90 min apart. Now the rules relax in steps only when needed (3 a day, then up to 10 h of
  focus a day), and such tasks show **Tight** instead of failing. A normal week still gets the comfortable rules.
- **Night owls got nothing scheduled** (a 02:00 bedtime made the waking window empty). Waking hours may now cross
  midnight everywhere (planner, chat bookings, deadlines, Today strip, "I sleep at 2").
- **A skipped study session counted as done.** Today now asks **Did you do these? Done / Missed**; missed time is
  booked again before the deadline. Saying "I skipped my OS session" in chat does the same, instantly, without AI.
- **"5k run around 7pm" landed at 09:40** when deep work also wanted the evening: time hints are now placed first.
- **A weekly goal set on a Sunday was "at risk"** (6 h demanded in one day). The first week asks only its remaining
  share; from Friday, next week's share is booked into next week.
- **Plan my day no longer needs the AI**: the dialog's lines ("CFA 2h", "run around 7pm", "review in the evening")
  are read in code and planned in about a second, with Undo — it works even when every AI quota is used up.
- New **Plan my week** (deadlines · weekly goals · habits in one form) and a **Your week** chart on Today: commitments,
  focus Donna booked, habits, free time and deadlines per day, with overloaded days flagged.

## v5: tested against real requests, then fixed
A 95-scenario eval (`eval/crud.js`: create, read, update, delete, follow-ups, dates, Hinglish, edge cases) was
run against a real model; every failure it found is now fixed in code and has an offline test (`test/v5.js`).
- **Stronger model first:** `@cf/openai/gpt-oss-120b` on Cloudflare (no key, ~2–3 s a reply), Gemini as fallback.
  89/95 on the first full run; the misses (below) were fixed and re-checked.
- **No more refusals over clashes.** A time you name is booked; the reply says what it overlaps ("Heads-up: this
  overlaps CFA class 17:00–21:00"). Times Donna picks itself still avoid clashes.
- **Hinglish times** ("kal shaam 6 baje gym", "parso subah saade 9") are read in code, so they're instant and exact.
- "Push everything after 6pm by 30 min", "clear my evening tomorrow", "swap X and Y", "every weekday" repeats,
  "cancel the first one" (after a list), "yesterday", and a bare "cancel it" (asks which) all work now.
- The model's hidden reasoning can no longer leak into a reply; a delete can't target an event you never named.
- **UI:** replies show each change as a card (added / moved / cancelled) with one **Undo** for the whole reply;
  overlap warnings are callouts; agendas render as a time table; **Ctrl+K** (or `/`) opens a command bar on any
  screen; new design tokens; old upgrade announcements are gone from the chat.

## v4: fast, smarter placement, passkeys
- **Opens instantly.** The next ~6 weeks of Google Calendar are saved in D1 (`src/sync.js`, row `gcache`). Views read
  that copy (no Apps Script call), the app then calls `/api/sync` in the background and redraws only if Google changed.
  The 15-min cron keeps it fresh; chat/edits re-read Google only if the copy is older than 5 min. The app shell is
  served cache-first by the service worker, and the last-seen Today/Calendar/chat paint from localStorage on open.
- **Never hangs.** A chat reply has a 40 s budget (25 s per model call); if time runs out it reports what was done.
  Gemini answers first, Workers AI is the fallback. Every browser request has a timeout with a plain message.
- **Places things where they fit best, not first** (`src/smart.js`): an energy curve anchored on your wake-up /
  wind-down (deep work in peak hours, light work in the post-lunch dip, workouts morning/early evening), no useless
  10–25 min scraps, no glued-together deep blocks, parts of one item spread out. `plan_day` tries several arrangements
  and keeps the best day; task sessions are spread over days with a day of slack before the deadline; "CFA 2h
  tomorrow" with no time picks the best slot in one step.
- **"Needs attention" is live** (computed from the calendar on every load, never a leftover).
- **Passkeys**: Settings → Security → *Add this device* (Windows Hello / Touch ID / Face ID); "Sign out all other
  devices" invalidates every other cookie. Password sign-in still works as a fallback.
