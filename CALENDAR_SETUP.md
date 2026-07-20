# Deploy + one-click booking (Cloudflare Workers)

This site now deploys as a **Cloudflare Worker with static assets**:
`worker.js` serves the site AND handles one-click equipment booking to Google
Calendar via a **shared service account**. `wrangler.toml` tells Cloudflare how
to build it. Do the setup below once.

## A. Deploy the Worker from GitHub
1. Repo must have this structure at its ROOT: `index.html`, `css/`, `js/`,
   `data/`, `assets/`, `worker.js`, `wrangler.toml`.
2. Cloudflare -> **Workers & Pages -> Create -> Import a repository**
   ("Deploy from Git"). Select `AshleyHelmuth/singlecell-planner`.
3. Leave the build command EMPTY. Cloudflare reads `wrangler.toml` and deploys.
   You get a `*.workers.dev` URL.
4. Visit `https://<your-worker>.workers.dev/` -> the planner app should load.
5. Visit `https://<your-worker>.workers.dev/api/book` -> JSON with
   `"configured": false` (expected until step C).

## B. Google Cloud - service account
1. console.cloud.google.com -> create a project.
2. APIs & Services -> Library -> Google Calendar API -> Enable.
3. APIs & Services -> Credentials -> Create credentials -> Service account
   (name it; skip the optional role/user steps).
4. Open it -> Keys -> Add key -> Create new key -> JSON -> download.
   This file is the secret - do NOT commit it.
5. Copy the service account email (...@...iam.gserviceaccount.com).

## C. Share calendars + store the key
1. In Google Calendar, for EACH of the 8 equipment calendars: Settings ->
   Share with specific people -> add the service-account email -> permission
   "Make changes to events".
2. Cloudflare: your Worker -> Settings -> Variables and Secrets -> Add.
   - Type: Secret (encrypted)
   - Name: GOOGLE_SA_KEY
   - Value: paste the ENTIRE contents of the JSON key file.
   (This box works now because it's a real Worker, not assets-only.)
3. Re-deploy the Worker (Deployments -> redeploy latest, or push a commit).

## D. Test
- `https://<your-worker>.workers.dev/api/book` should show `"configured": true`.
- App: Scheduling tab -> pick equipment/date/time -> Book selected equipment ->
  "Booked to lab calendars" with a view link; event appears on the calendar.

## Notes
- Time zone is America/New_York in worker.js (TIME_ZONE). Change if needed.
- Anyone who can load the site can POST to /api/book (only writes to the 8
  allow-listed calendars). To make it lab-only, put the Worker behind
  Cloudflare Access (free) with Google/email login.
- The service-account key lives only in the Cloudflare secret at runtime - never
  in the repo, never sent to the browser.
- If one-click fails, the booking panel still shows manual add-to-calendar
  links + an .ics download as fallback.
- Update the site later = commit to GitHub; Cloudflare redeploys automatically.
