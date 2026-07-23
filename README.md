# Single-Cell Experiment Planner

A static web tool for planning a single-cell batch end-to-end: design populations & modalities, enter
samples, and get a pooling strategy, workflow diagram, personnel timeline, reagent list,
cost estimate, and a printable protocol packet — all driven by your master-schema
spreadsheet.

Everything runs in the browser. There is no server and nothing to install to *use* it.
To *host* it, you put these files in a GitHub repository and turn on GitHub Pages. 

--- 

## What's in this folder

```
index.html                     the page itself
css/style.css                  styling
js/pooling.js                  genetic + HTO pooling engine (tested)
js/parse.js                    reads the spreadsheet
js/cost.js                     lanes, kits, reagents, cost
js/workflow.js                 workflow diagram + personnel timeline
js/handbook.js                 Handbook + Equipment tab text
js/app.js                      ties everything together
data/SingleCell_Pipeline_MasterSchema.xlsx    <-- the spreadsheet the tool reads
README.md                      this file
```

**The spreadsheet in `data/` is the single source of truth.** Update that file (in the
repo) and the tool updates itself — no code changes needed.

---

## Part 1 — Put it on the web with GitHub Pages (first time, ~15 min)

You only do steps 1–5 once. After that, updating is just step 6.

### 1. Make a free GitHub account
Go to <https://github.com> and sign up if you don't have an account.

### 2. Create a new repository
- Click the **+** (top-right) → **New repository**.
- **Repository name:** something like `singlecell-planner`.
- Set it to **Public** (required for free GitHub Pages).
- Do **not** add a README (we already have one).
- Click **Create repository**.

### 3. Upload these files
- On the new repo page, click **uploading an existing file** (in the "quick setup" box).
- Drag in **everything in this folder**, keeping the folder structure:
  `index.html`, the `css/` folder, the `js/` folder, and the `data/` folder.
  - Tip: the easiest way is to drag the whole set of files and folders at once. GitHub
    preserves the `css/`, `js/`, and `data/` subfolders automatically.
- Scroll down and click **Commit changes**.

### 4. Turn on GitHub Pages
- In the repo, go to **Settings** (top menu) → **Pages** (left sidebar).
- Under **Build and deployment → Source**, choose **Deploy from a branch**.
- Under **Branch**, pick **main** and **/ (root)**, then click **Save**.

### 5. Open your site
- Wait ~1 minute, then refresh the Pages settings screen. It will show a URL like:
  `https://YOUR-USERNAME.github.io/singlecell-planner/`
- Open it. You should see the planner with **"… modalities · … kits loaded"** in the
  top-right corner. That means it successfully read the spreadsheet.

### 6. Updating later
Whenever you change the spreadsheet or want to tweak anything:
- Go to the repo → open the `data/` folder → click the spreadsheet →
  the pencil/upload option → **upload a new version** with the *same filename*
  (`SingleCell_Pipeline_MasterSchema.xlsx`) → **Commit changes**.
- The live site refreshes within a minute. (If you don't see the change, do a hard
  refresh: Ctrl/Cmd + Shift + R.)

---

## Part 2 — Using the planner

1. **Plan tab**
   - **01 Design the experiment** — choose which cell **populations** this batch looks at
     (unsorted / sorted / stimulated single-cell, or bulk), then the **downstream modality**
     for each. Cells flow from a population into its modality:
     - **Unsorted** → 5′ CITE-seq, 5′ scRNA-seq (hashed), or Flex; optionally add **ASAP-seq**
       (a separate 3′/ATAC load off the same population).
     - **Sorted** → 5′ scRNA-seq (hashed) or Flex.
     - **Stimulated** → 5′ CITE-seq, 5′ scRNA-seq (hashed), or Flex.
     - **Bulk** → bulk RNA-seq or bulk TCR/BCR.
     - Any 5′ modality (CITE-seq or scRNA-seq) can add **V(D)J (TCR/BCR)** — it rides on the
       5′ cDNA and never gets its own lane.
     - Tick **Use the default MADI workflow** at the top to load the standard config in one
       click (unsorted → 5′ CITE-seq + ASAP · sorted → 5′ scRNA-seq · stim → 5′ CITE-seq ·
       bulk → bulk RNA-seq); any manual edit unticks it. Later steps appear once at least one
       population + modality is configured.
   - **02 Enter samples** — an Excel-like grid: click a cell and paste directly from a
     spreadsheet. It now has a **fixed height with a scrollbar** (the header stays pinned),
     so a 54-sample batch no longer stretches the page. Core columns are **Sample ID**,
     **Patient ID**, **Lineage**, and **Cells available**; add your own columns for anything
     else that could confound your batches (timepoint, condition, sex, site...).
     - Repeat the **Patient ID** for a donor's multiple timepoints.
     - Give related people the **same Lineage** label (e.g. a mother and infant) so they
       are never placed in the same genetic pool.
     - Fill in **Cells available** for any sample with a known lower cell count (e.g. an
       infant draw) — the tool contributes only what's actually available toward each
       load's cell target, and flags samples that fall short instead of overestimating.
     - Check any custom column under **Confounding variables** to have its values spread
       across pools rather than clustered in one (e.g. don't let a pool be all-one-timepoint).
     - The **Load MADI example** button fills in a realistic 54-sample batch (with a
       Timepoint column already checked as a confounder) to try it.
   - **03 Review pooling strategy** — computes genetic pools + HTO/loading assignments.
     **Download strategy (.xlsx)** to review or hand off; if you edit pool assignments in
     Excel and **Upload adjusted strategy**, the rest of the plan uses your version instead
     of recomputing (the sample IDs must match Step 02 exactly).
   - **04 Tune assumptions** — defaults come from the lab's BCP-IDVax ordering calculations,
     split out **per loading chemistry** (5′ CITE-seq, 5′ scRNA-seq, Flex, ASAP-seq, V(D)J,
     bulk). Cells/GEM only appears for things actually loaded onto GEMs — **V(D)J and bulk
     have no cells/GEM and no lanes of their own** (V(D)J uses per-lane T/B-cell counts for
     read depth; bulk uses reads/sample). Only the cards for the chemistries you chose are shown.
   - Click **Build the plan**.

2. **Workflow tab** — a **cell-flow & pooling diagram** that traces cells from samples →
   fixed per-sample takes (genetic pooling / stim / bulk) → genetic pools → per-modality
   cells → loading channels → libraries, with a ✓/⚠ check at each stage. Following the MADI
   protocol:
   - Each sample contributes a **fixed 1.5M cells to pooling** (used going into CITE-seq
     staining regardless of how many the sample had), a **500K bulk reserve** (100K floor for
     low-count samples, kept in Trizol), and a **stim reserve**; leftover cells are banked.
   - Each genetic pool is split by taking a **fixed 1.2M/pool** for each unsort/ASAP-style
     load; the **sorted load takes the remainder** of the pool.
   - For unsort CITE-seq and ASAP, the per-pool tubes are **HTO-stained** (TotalSeq-C for
     CITE-seq, TotalSeq-A for ASAP), washed, and **combined**; then **~1.5M cells are
     subsampled for the surface-panel (lyo) staining** and super-loaded at a **~1.1–1.2M
     target**. Those two numbers (`cells_for_panel_stain`, `cells_at_load`) are editable too.
   - It then shows channels per modality and the final library counts (e.g. 14 channels of
     CITE-seq → 14 GEX + 14 ADT + 14 HTO, plus V(D)J TCR/BCR if added; bulk = 1 library/sample).
   - Below it is a personnel timeline. **Print / save PDF** button included.
   - **All the cell-count numbers are editable** in the **Cell_Flow_Assumptions** sheet
     (cells/sample for pooling, bulk reserve + low floor, stim reserve, cells taken per pool,
     ALLCELLS %). Edit the `default_value` column and reload — keep `assumption_id` and the
     column headers unchanged.
   - Two cell "currencies" appear on purpose: the **upstream takes are raw thaw-cell counts**
     (millions), while **channel counts come from the recovered-cell lane math** (thousands of
     recovered cells/sample, set in Step 04). They're different stages, not a contradiction.
   - If samples are pooled (multiple donors per pool) but **no bulk RNA-seq** is selected, the
     tab warns you — bulk RNA-seq is required to SNP-demultiplex pooled donors later.

3. **Reagents & cost tab** — lanes per load (population · modality), then the **full reagent
   list**: not just 10x kits and antibodies but every buffer, plasticware item, staining
   reagent and QC consumable from the Pre-GEM and Post-GEM lists, scaled by how many samples,
   genetic pools, staining super-pools and channels your plan has. Each reagent shows the
   **total amount needed**, an **order quantity**, its scope and an estimated cost.
   - **HTO hashtags** are counted the way you actually use them: **2 µL of a distinct hashtag
     per genetic pool** — TotalSeq-A for ASAP-seq and TotalSeq-C for CITE-seq, listed
     separately (if you run both, you get one of each per pool). A hashtag vial lasts many
     batches, so the order line reads "N unique hashtags", not one vial per pool.
   - **Universal cocktails** are 3 vials per staining batch; the kit comes with 5, so one kit
     covers a batch.
   - **Export reagent list (Excel)** downloads `reagent_list.xlsx` — one row per reagent with
     item ID, total amount, order quantity, scope, cost and notes.
   Rows tagged **no price / needs data** are waiting on a price in the catalog.

4. **Protocols tab** — a printable packet: workflow overview first, then one page per
   module — **pre-experiment prep (media + buffer recipes), thaw & count, pool & split,
   CITE-seq (unsort 5′) staining, ASAP-seq, sort staining, bulk/TriZol, stim, and 10x GEM
   loading**. Each protocol opens with a **reagent header** listing every reagent/supply for
   that step in *per-sample / per-genetic-pool / per-HTO-staining-batch* form (pulled live
   from the Pre-GEM sheet and scaled to your plan), followed by detailed step-by-step
   instructions. Only the protocols relevant to your selected modalities appear. Use
   **Print packet → Save as PDF**.

5. **Projects tab** — save, group and roll up experiments across a whole project.
   - On the **Plan tab**, once you've built a plan, use **05 Save & track this experiment**:
     give it a **name**, optionally a **project** (type a new one or pick an existing one),
     a **date** (planned for / done), and a **status** (planned / completed). **Save
     experiment** stores it; **New / clear** starts a blank one. Saving after building the
     plan also stores a snapshot of that experiment's reagents, pricing, pooling and batches
     so the project rollups don't have to recompute.
   - In the **Projects tab**, pick a project from the dropdown (or *All experiments*) to see
     every experiment in it with its **date, status, sample/pool counts and estimated cost**,
     plus a **project total**. Per experiment you can:
     - **Open** — load it back into the Plan tab to view or edit (then Save to update it).
     - **Export workbook** — one `.xlsx` with four sheets: **Summary, Pooling, Reagents,
       Pricing** for that experiment.
     - **Protocols** — load it and jump to the Protocols tab to print/save its packet.
     - **Record inventory** — see below.
     - **Delete**.
   - **Project-level exports:**
     - **Export project reagents + cost** — a workbook with a **Cost summary** (each
       experiment's total plus a **PROJECT TOTAL**) and **Reagent totals** (every reagent
       summed across all experiments in the project, with amounts and cost).
     - **Export batches + samples** — one row per sample across the whole project showing
       which **experiment, date, genetic pool (batch), HTO and super-pool** it belonged to.
   - **Inventory (Live_Inventory tab of the spreadsheet).** When an experiment is completed,
     **Record inventory** matches its reagents/kits to rows in the **Live_Inventory** tab by
     `item_id`, records the usage as **negative transactions**, marks the experiment completed,
     and downloads an `inventory_usage_*.xlsx` whose rows you **append to your
     Inventory_Transactions tab** (current_stock there is an auto-computed SUMIFS of those
     transactions). Only items whose `item_id` exists in Live_Inventory are deducted — add
     `item_id`s there to start tracking more of them.
   - **Where this is stored / moving it around.** Saved experiments live in **this browser's
     localStorage** (per browser, per machine — they are *not* synced across devices and are
     separate from the spreadsheet). Use **Backup (JSON)** to download everything and
     **Restore** to load it on another machine or share it with the lab. If you change the
     master spreadsheet, an experiment's saved numbers don't update until you **Open and
     re-Save** it.

6. **Handbook tab** — condensed reference from the lab handbook.

7. **Equipment tab** — equipment needs tailored to your modalities, plus a spot to embed
   your booking calendar (see below).

---

## Part 3 — Filling the placeholders later

The tool is built to show honest gaps rather than guess. Here's how to close them:

- **Reagent quantities / costs** — the per-stage amounts in the **Pre_GEM_Consumables** and
  **Post_GEM_Consumables** tabs now drive the whole reagent list. Costs come from each item's
  **Price** and **Stock Size** in **Additional_Supply_Catalog** (Post-GEM rows link to the
  catalog via their `catalog_key`). If a reagent shows **no price**, add its Price/Stock Size
  to the catalog. A few source rows have unit mismatches (e.g. DNase entered in `mg` though
  the note says µL of stock) — fix the unit or value in that cell for an exact cost.
- **Real personnel names** — replace the example rows in the **Personnel_Roster** tab. The
  workflow timeline will use real names instead of "Person 1/2/3".
- **Booking calendar** — open the **Equipment tab**; it has the exact Google Calendar embed
  snippet to paste in. Get your embed code from Google Calendar → *Settings → Settings for
  my calendars → [your calendar] → Integrate calendar → Embed code*.
- **Module protocols** — Thaw and Pool have full step-by-step text (from the handbook +
  MADI protocol). Other modules show a placeholder; add their steps in `js/app.js`
  (`placeholderProtocol` / add an entry to the `expanded` map) when ready.

---

## Troubleshooting

- **Top-right says "Could not load spreadsheet."**
  - If you opened `index.html` by double-clicking it (address bar starts with `file://`),
    browsers block reading local files for security. Use the GitHub Pages URL instead, or
    run a tiny local server: in this folder run `python3 -m http.server` and open
    <http://localhost:8000>.
  - Online, this usually means the spreadsheet filename in `data/` doesn't match
    `SingleCell_Pipeline_MasterSchema.xlsx`. Rename it to match.
- **The whole table area shows an error about the library.**
  The tool loads the spreadsheet-reading library (SheetJS) from a CDN
  (`cdn.sheetjs.com`). If your network blocks it: download `xlsx.full.min.js` from
  <https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js>, put it in the `js/`
  folder, and change the line in `index.html` that loads it from the CDN URL to
  `<script src="js/xlsx.full.min.js"></script>`.
- **A number looks wrong.** Every cost line shows its **Source** column (which spreadsheet
  cell/kit it came from) so you can trace and correct it at the source.

---

## What's been tested vs. what to check in your browser

- **Tested:** the pooling engine (confounder-balancing placement + the original 18
  automated tests, reproducing the MADI flowchart: 54 samples → 3 sets of 18 → 6 lanes;
  respects no-same-patient and no-related rules; HTO reuse across super-pools) and the
  cost engine (per-load lane math, per-chemistry read depths including ASAP-seq's added
  HTO library and the VDJ add-on, correct per-lane kit costs from real prices).
- **Please eyeball in the browser** the first time: the sample-grid paste behavior with
  a real Excel selection, the pooling-strategy download/re-upload round trip, the workflow
  diagram layout with your real sample set, printing/PDF output, and that your
  spreadsheet's tab/column names match what the parser expects (they did at build time).

---

## A couple of decisions worth confirming

- **Pooling model.** The tool uses the two-level model you described: genetic pools of up
  to 20 (no same-patient, no related — SNP-demuxable), then one HTO per pool, then pools
  combined into loading super-pools. The MADI flowcharts used 9/pool; the cap is adjustable
  in **04 Tune assumptions → General** if you want to match a specific batch.
- **Modality → assay-arm mapping** is currently built into `js/cost.js` (because the
  `required_stage_ids` column in Modality_Definitions is blank). Fill that column later and
  the mapping can be driven entirely from the spreadsheet.
- **Confounder balancing** is a soft optimization, not a hard rule: pool/HTO placement first
  respects the hard same-patient/lineage constraint, then — among the pools that don't
  violate it — prefers whichever pool has seen the *fewest* samples with this sample's value
  on each checked confounder column. With a handful of confounder columns and typical batch
  sizes this reliably produces an even spread (tested: perfect 3/3/3 timepoint splits across
  6 pools), but it isn't a formal balanced-design solver — for unusual sample compositions
  (e.g. very few samples of one condition), double-check the "Confounder spread" table in
  Step 03.
- **Cell-budget handling** is intentionally simple: if you fill in **Cells available** for a
  sample, the tool contributes `min(cells available, target)` toward that load's total-cell
  math and flags the sample as a shortfall — it does **not** model split-across-loads mass
  balance (e.g. how many cells a thawed sample has left for ASAP-seq after CITE-seq and
  sorting each take their share). For batches with several low-input samples split across
  many loads, sanity-check the actual cell budget by hand.
- **Per-chemistry assumption defaults** (cells/GEM, reads/cell) come from the BCP-IDVax
  calculations you shared, and are keyed by **loading chemistry** rather than by arm — so
  V(D)J and bulk correctly have no cells/GEM (V(D)J rides on the 5′ load; bulk is per-sample).
  A few defaults are estimates worth confirming: the **sorted** load reuses its chemistry's
  blended cells/GEM (real batches vary by sorted population, cDC/Trm ~40k vs HSPC/pDC ~10k),
  and **bulk reads/sample** (30M RNA, 5M TCR/BCR) are placeholders. All are editable in
  **04 Tune assumptions**.
- **The cell-flow diagram uses fixed per-pool takes.** Unsort and ASAP each take a fixed
  amount from every genetic pool (default 1.2M/pool), and the sorted load takes whatever
  remains — so the sorted super-pool is large by design (it feeds FACS enrichment). All of
  these numbers, plus the per-sample pooling/bulk/stim takes and the ALLCELLS %, are editable
  in **Cell_Flow_Assumptions**. Pool totals are computed as (samples in pool × pooling take ×
  (1 + ALLCELLS %)); real counted pool totals vary batch to batch.
- **The day-by-day personnel grid** (below the cell-flow diagram) still runs through a
  compatibility layer that maps the population→modality selection back onto the original arm
  tracks (unsorted-5′, ASAP, sorted, Flex, stim), so e.g. a stimulated 5′ load's staffing is
  folded into the unsorted-5′ track. The **cell-flow diagram** and the **Reagents & cost**
  numbers use the full new model and are authoritative; the personnel grid may want a
  dedicated follow-up pass.
- **Pooling strategy re-upload** requires the re-uploaded file's Sample ID column to match
  Step 02's sample set exactly (same IDs, nothing added/removed) — it will tell you exactly
  which IDs don't match rather than guessing. If your file also has HTO and Loading
  Super-Pool columns filled in for every row, those are used as-is; otherwise HTOs are
  reassigned automatically from your edited pool groupings.

## One unified planning workflow

The Plan tab is a single workflow with a **left-side navigator** that lights up each
step as it's completed (Modalities → Samples → Pooling → Assumptions → Build → Save).

**Samples — two input paths, one pipeline.** In Step 02 choose:
- **I have my samples** — the editable grid (paste from Excel; Sample/Patient/Lineage
  + confounder columns).
- **Planning / conceptual** — no sample sheet yet: enter counts (# samples, # patients,
  # related lineage groups, # timepoints/patient, # conditions). `Pooling.synthSamples`
  builds a representative sample set that flows through the **exact same** biological
  pooling + cost + workflow pipeline — same-patient timepoints land in different pools,
  related lineages stay apart, and Timepoint/Condition are spread across pools.

Either way, Step 03 computes genetic pools with the hard biological rule intact and shows
**alternative pooling options** (feasible max-samples-per-pool → pool count + confounder
spread, default = fewest pools with best spread).

**The colleague's numbers, integrated.** After **Build the plan**, the Workflow tab shows
a **Batch scenario & numbers** section computed from the actual plan: per-sample cell
allocation, pool-size comparison, per-arm lane/chip/library counts with shortfall flags,
sort per-population fill (dynamic lane assignment), and the library-by-type pooling table
(one pooled submission per type — replaces the old "pooling %"). All the underlying
assumptions live in the **Batch scenario assumptions** card in Step 04.

**Sort populations.** A shared toggle row (HSC, pDC, cDC, Treg on by default; Trm, All T,
All B available — extend via `Pooling.SORT_MODEL`) drives the sorted arm. Presort +
empirical frequencies, lineage → V(D)J mapping, and dynamic lane assignment (big
populations get a dedicated capped lane; small ones bin-pack into shared lanes; a lane's
libraries = GEX +VDJ-TCR/+VDJ-BCR by lineage).

**Explanations on click.** The little **ⓘ** buttons next to assumptions and headers open a
right-side drawer explaining where a number comes from (e.g. "cells loaded per lane" is a
lab-validated super-load, not a 10x spec). Content lives in the `EXPLAIN` map in `app.js`.

### Engine (pure, node-tested) — `js/pooling.js`
`synthSamples`, `evenSplitPools`, `SORT_MODEL`, `dynamicSortLanes`, `exploreScenario`,
`libraryPoolingFromScenario`, `poolingOptions`, `spreadQuality` — all pure and covered by
the logic tests; the biological `buildGeneticPools` is unchanged.

## Plan tab: collapsible 7-section workflow

The Plan tab is now a single-open **accordion** — each section shows a completion
tick and, when collapsed, a one-line summary of what you chose. The side navigator
mirrors the sections and opens them on click.

1. **Design the experiment** — populations → modalities (MADI default toggle). The
   sort-population toggles live here, shown when a sorted arm is in the design.
2. **Samples** — *cells/sample at thaw* and *people available to thaw* (1 person =
   19 samples). A red FLAG / green OK message reports thaw capacity for both the
   real-sample table and the planning-counts path.
3. **Per-sample cell allocation** — feasibility gate: each unsort modality is its
   own pool needing a per-sample amount (default 1.0M), bulk gets its reserve
   (0.5M), stim its aliquot, sort the remainder. A deficit is flagged before you go
   further. Ends with the **Compute pooling strategy** button.
4. **Review pooling strategy** — one combined table (pool · HTO · super-pool ·
   samples · confounder spread per column), a **pool-composition** table (pooled
   cells + ALLCELLS share), alternative pool-count options, and clickable
   explanations for confounder-spread and ALLCELLS.
5. **Lyo panel staining** — cells-to-stain per modality → panels & vials (2.0M per
   3-vial panel), with a cocktail picker constrained to TotalSeq-C (CITE) / -A (ASAP).
6. **Modality arms & assumptions** — per-modality reagent/lane assumptions.
7. **Sequencing** — reads/cell per library type with defaults.

Then **Build the plan** → Workflow / Reagents / Protocols, and **Save**.

### New engine (pure, node-tested) — `js/pooling.js`
`thawCapacity`, `perSampleAllocation`, `lyoStaining` (+ `COCKTAILS`) join the earlier
`synthSamples`, `exploreScenario`, `dynamicSortLanes`, `poolingOptions`, etc.
