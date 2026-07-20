# One-click equipment booking — setup (Google + Cloudflare)

The code side is done: `functions/api/book.js` is a Cloudflare Pages Function
that writes an event to the right equipment calendar using a **shared service
account**, and the Scheduling tab now calls it. You need to do the account-level
setup once (these steps involve a secret key — keep it out of the repo).

## 1. Google Cloud — create the service account
1. Go to https://console.cloud.google.com → create a project (any name).
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Give it a name (e.g. `planner-booker`); you don't need to grant it project roles.
4. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads. This is the secret. Do **not** commit it anywhere.
5. Copy the service account's email — it looks like
   `planner-booker@your-project.iam.gserviceaccount.com`.

## 2. Share each equipment calendar with the service account
For **every** one of the 8 equipment calendars, in Google Calendar:
- Calendar **Settings → Share with specific people (or groups) → Add people**.
- Paste the service-account email from step 1.5.
- Permission: **Make changes to events**. Save.

(If nothing is shared, bookings will fail with a "permission" / 403 error.)

## 3. Cloudflare — store the key as a secret
1. Cloudflare dashboard → your Pages project → **Settings → Variables and secrets**.
2. **Add variable**, type **Secret** (encrypted):
   - **Name:** `GOOGLE_SA_KEY`
   - **Value:** paste the **entire contents** of the JSON key file from step 1.4.
3. Save, then **redeploy** the site (or push any commit) so the function picks it up.

## 4. Test
- Visit `https://<your-site>/api/book` in a browser. You should see JSON with
  `"configured": true` and the equipment list. If `configured` is false, the
  secret isn't set on this deployment.
- In the app: Scheduling tab → pick equipment/date/time → **Book selected
  equipment**. You should get "Booked to lab calendars" with a **view** link,
  and the event should appear on that equipment's calendar.

## Notes
- **Time zone** is set to `America/New_York` in `functions/api/book.js`
  (`TIME_ZONE`). Change it there if your calendars use a different zone.
- **Who can book:** any visitor who can load the site can POST to `/api/book`
  (it only writes to the 8 allow-listed calendars, nothing else). If the site
  should be lab-only, put it behind **Cloudflare Access** (free) so only your
  people can reach it.
- The service-account key lives only in the Cloudflare secret at runtime; it is
  never sent to the browser and never stored in the repo.
- If one-click ever fails, the booking panel still shows the old manual
  "add-to-calendar" links and an `.ics` download as a fallback.
