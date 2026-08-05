# SOP adaptation — decisions, changes, and open notes

Source: Tsang_SOP_multimodal_scpipeline_prep_071526.pdf (A. Ayers, 7/14/26).
Goal: adopt this detailed SOP as the site's protocol, modular by modality, with the
site's existing reagent/material calculations injected, exportable + saved to the
experiment's Drive folder as a Google Doc.

This file records the reconciliation between the SOP and the site's current logic.

## Resolved decisions (from you)

1. **ASAP library count — KEEP 3 separate libraries: ATAC, ADT, HTO.**
   Reason: ASAP HTO uses a *different amplification primer*, so it's its own library
   (not read through the ADT library the way unsort/sort CITE HTOs are).
   → Site logic is already correct (asap = ATAC + ADT + HTO). No change. This differs
     from a literal reading of the SOP (which implies HTO rides on CSP via bridge oligo);
     the site's 3-library treatment is the intended one.
   → CONTRAST with CITE/sort: unsort 5' CITE = GEX + ADT (HTO in ADT lib) + TCR + BCR;
     sort 5' = GEX + ADT (HTO in ADT lib) + TCR (see #6). Only ASAP breaks HTO out.

2. **Buffer / DNase / FACS volumes — KEEP the site's current calculations.**
   The site's calcs account for more (per-pool + per-super-pool structure, overage, unit
   conversions) than the SOP's rounded per-pool figures. So we do NOT switch the workbook
   to the SOP's numbers (e.g. we keep the current DNase and staining-buffer math, including
   the earlier DNase→media-volume fix and RPMI-DNase / RPMI-DNase-low structure).
   → The SOP's differing figures (staining/wash 19→25 mL/pool/modality; FACS 70 mL/pool;
     R10+DNase 10 mL/sample at 100 µL stock/10 mL) are recorded here for reference but are
     NOT applied, per your instruction.

3. **Stim extra buffer — ADD (this is the one gap in the current calcs).**
   Per SOP, when a stim arm is included, the staining/wash buffer (PBS + 2% BSA) needs:
   - **600 µL per stim sample, rounded up to 1 mL/sample**, PLUS
   - **9 mL per stim pool, rounded up to 10 mL/stim pool**.
   These are ADDITIONAL to the normal stain/wash buffer, only when stim is in the plan.

4. **Stim scaling — ADOPT the SOP rule.**
   **# stim pools = # sample pools × # stim conditions** (default 4; "or some reduced
   subset if not stimming all samples"). The site already collects "Stim conditions" and
   "Stim cells/sample/condition" as inputs, so stim pools should be derived as
   (sample pools × stim conditions). Buffer/reagent stim terms scale off this.

5. **Detailed notes — this document** (kept updated as changes land).

6. **V(D)J — opt-in per arm, OFF by default (FINAL).**
   No arm gets TCR or BCR automatically. In the planning stage each arm has a V(D)J
   selection: none (default) / TCR / BCR / both. Selected libraries are added per lane of
   that arm. So: unsort 5' can be set to TCR+BCR; sorted can be set to TCR (per sorted
   population); stim defaults to none but TCR/BCR can be added. Nothing V(D)J unless chosen.

## Final answers (this round)
- V(D)J: opt-in per arm, off by default; user picks TCR / BCR / both. (Replaces the old
  behavior where unsort auto-added both.)
- Stim-pool multiplier: # stim pools = # sample pools x plan "Stim conditions" input.
- Stim lanes: default NO V(D)J; opt-in available.
- Bulk tubes: NO ALLCELLS aliquot (per-sample counts as-is).
- Unsort HTO: 2 uL/pool (confirmed).

## To implement (spec)

- **Library mapping** (timing.js `ARM_LIBRARIES` + app cost/lane logic):
  - unsort 5' CITE: GEX, ADT, TCR, BCR  (HTO in ADT)
  - sort 5': GEX, ADT, **TCR** (per sorted population; no BCR)  (HTO in ADT)
  - ASAP: ATAC, ADT, HTO  (3 libraries — unchanged)
  - bulk: BulkGEX (+ optional BulkVDJ)
  - stim 5': GEX, ADT  (HTO in ADT)
- **Stim buffer terms** (consumables sheet, gated to stim arm), scaling:
  - staining/wash buffer += 1 mL × (# stim samples) + 10 mL × (# stim pools)
  - # stim pools = (# sample pools) × (# stim conditions)
  - BSA (2% w/v) and PBS in that buffer scale with the added volume, consistent with the
    existing staining-buffer component rows.
- **Modular protocol** (new): SOP sections become modules tagged by modality/arm; the
  generated protocol includes only sections the experiment uses, preserves the SOP prose,
  and injects computed numbers (buffer volumes, HTO counts, cell targets, pool #s) from
  the plan. Export = user download + Drive Google Doc (Protocol upload path already exists).

## Open / still-unclear items (need confirmation or care)

- **Sorted BCR:** assumed sorted arm gets TCR only (no BCR). Confirm.
- **Stim conditions default:** SOP says ×4 conditions; the site input "Stim conditions"
  defaults to 5. Which is authoritative for the stim-pool multiplier — the plan input, right?
  (Assuming the plan input drives it, not a hardcoded 4.)
- **Stim modality libraries:** stim 5' = GEX + ADT (HTO in ADT). Confirm no VDJ on stim lanes.
- **"ALLCELLS" tubes:** SOP adds an ALLCELLS aliquot (per sample) for bulk/controls. The
  site's per-sample tube counts may or may not include this extra aliquot — check bulk tube
  counts include +1 ALLCELLS set if that's intended.
- **HTO amounts:** SOP unsort = 2 µL TotalSeqC HTO/pool + 10 µL Fc block; sort = 5 µL HTO +
  10 µL Fc block + sort-Ab cocktail (total/# pools). Site currently: sort HTO 5 µL/pool,
  Fc block 10 µL/pool (matches). Unsort HTO 2 µL/pool — confirm the site uses 2 µL (not 5).
- **Sort Ab cocktail:** SOP total ≈ 463.5 µL for up to ~60 samples (9×), split across pools
  (≈ total/# pools). Site currently ≈ 61.5 µL/pool — consistent at ~6-8 pools. Leave as is.
- **DNase/media:** left on the site's current model per decision #2, NOT the SOP's R10-based
  per-sample figure. Flagging that these two models diverge if anyone cross-checks by hand.

## SOP vs current protocol — comparison (071526 detailed SOP)

DONE this round:
- **Staining/wash buffer volume ADAPTED** from 14 -> **19 mL/pool/modality** (unsort III + ASAP IV),
  BSA 0.28 -> 0.38 g/pool, per the SOP's "need 19 mL per sample pool per modality" figure.
  Per-super-pool (9 mL) and the site's per-pool/per-super logic kept. Prep box + workbook both updated.

Differences noted (SOP vs current generated protocol) — for the pending protocol rewrite:
- **Wash step volumes** (unsort): SOP does 2 mL dilute + 2 mL wash + 3x 3 mL post-HTO = ~13 mL/pool at
  pool level; site's 14 mL matched the steps, but SOP's stated *need* is 19 mL/pool (now adopted).
- **Sort FACS washes are larger**: SOP step 7 uses a 15 mL wash (vs small site step volume). Already
  covered by the 70 mL/pool FACS prep + 10% FBS correction done earlier.
- **HTO volumes**: unsort 2 uL/pool + 10 uL Fc block; sort 5 uL HTO + 10 uL Fc block + 200 uL sort-Ab
  cocktail (total/# pools); ASAP 2 uL TotalSeqA/pool. Site matches sort (5 uL) + Fc (10 uL); confirm unsort 2 uL.
- **Lyo panel**: 3 vials each (TotalSeq-C 399905 unsort, TotalSeq-A 399907 ASAP), 1 vial/~500k cells,
  1.5M cells stained in 150 uL. Site models lyo panels per super-pool — consistent.
- **Superpool stain target**: 1.5M cells (unsort + ASAP). ASAP resuspended in exactly 450 uL PBS; unsort
  700-800 uL. Site's stainTarget = 1.5M — consistent.
- **ASAP**: 3 libraries (ATAC + ADT + HTO) — kept. OMNI lysis 100 uL/rxn, wash 1 mL/rxn, bridge oligo BOA.
- **Stim**: #stim pools = #sample pools x 4 conditions; stim wash buffer 1 mL/stim sample + 10 mL/stim pool
  (STILL PENDING to add to the staining-buffer calc). Stim HTO = 1 uL/pool.
- **Sequencing ratio**: 5' cDNA:CSP:TCR:BCR = 65:33:1:1 (SOP). Site read-ratio math is per-library reads/cell.
- **Bulk**: 500k/sample Trizol, 1 tube/sample, no ALLCELLS aliquot — consistent.
- **DNase**: SOP thaw media 10 mL/sample @0.1 mg/mL + incubation 2 mL/sample @50 U/mL. Site keeps its
  media-volume-derived DNase (~1.4 mg/sample) per the "keep site calc" decision.

PENDING (large, staged):
1. Rewrite the generated protocol text to follow the SOP section order + detail (thaw -> pool/split ->
   unsort+ASAP stain -> sort stain -> ASAP -> bulk -> stim -> GEM load), with injected plan numbers,
   keeping the prep-buffer list at the top of the Protocols page.
2. Downloadable **Word (.docx) SOP** with all experiment-adapted numbers filled in (uses the docx skill).
3. Add the pending **stim wash buffer** (1 mL/stim sample + 10 mL/stim pool) to the staining-buffer calc.
