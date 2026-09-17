# Annex Hub

A lightweight lab-organization site for the Yale Biohub Annex: **inventory**, and later scheduling, Annex usage, and guidelines. It reads and writes the **same** `Live_Inventory` Google Sheet the singlecell-planner uses, via the same service account — so both tools stay in sync automatically.

This first version implements the **Inventory** tab in full. The other three tabs are placeholders for now.

## What the Inventory tab does

- **Left sub-menu:** `＋ Update inventory` at the top, then one page per supply category (10X reagents · Reagents & supplies · Oligos · TotalSeq + HTOs · Antibodies), then `Edit reservations` at the bottom. On a phone the sub-menu becomes a scrolling chip row and every control is thumb-sized.
- **Update inventory:** type a **catalog # / item ID** (or search by name). If it exists, you can *add a container/box* or *take out units*. If it doesn't, you add it as a new item and it's auto-assigned an ID.
- **Category pages:** collapsible sub-categories, a search box up top, and inline `− / ＋ / Take out / Add` controls on every line.
- **10X reagents:** grouped into sub-sections by **assay** (driven by the `Experiment` column in the sheet — edit that column to re-file a kit). Each kit is one line; **expand it to see every lot** and use/reserve a specific lot.
- **Reservations:** the **Available** number already excludes reserved stock. The **reserved** figure on each line is clickable to see what it's reserved for, and the `Edit reservations` page lets you add or release reservations. Reservations live in the `Reservations` sheet, so the planner can create them too.

Every stock change is appended to a `Movements` audit tab, and 10X usage is also logged to `Lots Used`.

## One-time setup (≈5 min, mirrors the planner)

1. **Replace the live sheet.** Upload the new `Live_Inventory.xlsx` (delivered alongside this app) to Google Drive, replacing the current one — it adds the `Experiment` column and the `Reservations` + `Movements` tabs and keeps every existing header, so the planner keeps working. Keep the same Sheet ID, or note the new one.
2. **Push this folder to a new GitHub repo** (e.g. `annex-hub`), with `index.html`, `worker.js`, and `wrangler.toml` at the repo root.
3. **Create the Worker from Git.** Cloudflare → Workers & Pages → **Create → Import a repository** → pick the repo. Leave the build command empty; Cloudflare reads `wrangler.toml`.
4. **Add the two variables** (Settings → Variables and Secrets) — the *same* values as the planner:
   - `GOOGLE_SA_KEY` — **Secret** — the full service-account JSON.
   - `INVENTORY_SHEET_ID` — **Plaintext** — the sheet's ID.
5. **Share the sheet** with the service account's `client_email` as **Editor** (already done if it's the same sheet/account as the planner).
6. Redeploy and open the site.

## Verifying it works

Open the site and check the pill in the top-right reads **Live**. If it says *Not connected*, the two variables aren't set yet. To test the API directly, open DevTools → Console on the live site and run:

```js
fetch('/api/inventory').then(r=>r.json()).then(d=>console.log(d.configured, d.tenX?.length, d.reagents?.length))
```

You should see `true`, the kit count, and the reagent count.

## Notes / current limits

- **10X on-hand is read from `10X Kits_All`** (per-box), which is the live source of truth. The old `10X Kits_Condensed` tab is left untouched but is now just a legacy snapshot — if your planner reads *that* tab for kit counts, point it at `10X Kits_All` later so the two never drift.
- **Adding new TotalSeq tubes** from the UI isn't wired yet — add tube rows directly in the sheet for now; editing existing tubes' remaining volume works.
- **10X "use"** draws rxns down from the boxes with the most remaining first; adding a box/lot appends a new Kit ID (`{catalog}-NNN`). Boxes aren't hard-deleted (they go to 0 rxns) so row identity stays stable.
- Writes go straight to the sheet and the page reloads from it, so two people editing at once always see the latest saved state (last write wins per cell).
