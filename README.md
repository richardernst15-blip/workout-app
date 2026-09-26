# Workout App

Mobile-first workout tracker for bodyweight / rings training. One Cloudflare Worker serves the
static front end from `public/` and a small JSON API backed by D1. No build step.

## Features
- **Exercises** – name, description, muscle group, notes, instruction video link. Ships with a starter bodyweight/rings set.
- **Workouts** – solo or split (superset/circuit) blocks, reps or timed holds, sets/rounds, optional rest after each exercise, between rounds, and after the block. Optional warm-up and cool-down sections. Muscle-group filter when picking exercises.
- **Planner** – month calendar, time, reminder, weekly repeat (4/8/12 weeks), per-day warm-up/cool-down toggles. Reminders go to your phone calendar via an `.ics` feed.
- **Active workout** – screen stays on (Wake Lock), exercise and rest pills, swipe left = done, swipe right = note, split-round checkboxes, auto-starting rest timer (rested left / remaining right, fills darker as it runs), +15 s, 3-2-1 beeps.
- **Review** – every note per exercise, pre-suggested rep changes from your flags, save for next time or apply to every workout with the same name.

## Deploy (GitHub → Cloudflare)
1. Push this folder to a new GitHub repo.
2. Create the database: `npx wrangler d1 create workout-app`
3. Paste the returned `database_id` into `wrangler.toml` and commit.
4. Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → pick the repo. Deploy command: `npx wrangler deploy`.
5. Every push to `main` redeploys. The `docs` table is created automatically on first request (or run `npm run db:init`).

### Optional access key
`npx wrangler secret put API_TOKEN` — then enter the same key in the app under Settings (sliders icon on Today). The calendar link includes it automatically.

### Local dev
`npm install && npm run dev`

## Phone setup
- **Home screen**: open the site in Safari/Chrome → Share → Add to Home Screen.
- **Reminders**: Settings → *Subscribe on this device* (or copy the link and add it as a subscribed calendar). On iPhone, turn **off** "Remove Alerts" when subscribing or the reminders won't fire. Subscribed calendars refresh on the phone's schedule (often hourly); each planned day also has a one-off "Add to phone calendar" button that is instant.
- **Keep screen on**: needs HTTPS (workers.dev is fine) and iOS 16.4+ / recent Android Chrome.

## Data
Single D1 table `docs(kind, id, data, updated_at)`; kinds are `exercise`, `workout`, `schedule`, `session`. The app caches locally and queues edits offline, syncing when back online. Settings has JSON export/import for backups.
