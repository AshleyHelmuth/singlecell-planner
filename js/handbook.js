/* ============================================================================
   handbook.js  —  Reference content for the Handbook & Equipment tabs.
   Adapted in full from "Setting up a Single Cell Experiment"
   (Benmelech & Ayers, Tsang Lab; created Mar 2025, updated Jun 2026).
   Kept as editable HTML so the lab can extend it.
   ============================================================================ */

(function (root) {
  'use strict';

  const handbookHTML = `
    <div class="hb">
      <div class="hb-intro">
        <h2>Setting up a single-cell experiment</h2>
        <p class="muted">Adapted from the Tsang Lab handbook (Benmelech &amp; Ayers, updated June 2026). This guide reviews the general process for setting up a single-cell experiment: choosing modalities, kits and reagents, batching, and practical bench steps. Kit naming reflects the lab&rsquo;s move to GEM-X 5&prime; v3 (the handbook&rsquo;s original lists Next GEM 5&prime; HT v2).</p>
      </div>

      <details open><summary>Introduction &amp; general workflow</summary>
        <p>Single-cell experiments require a great deal of planning and preparation, especially for large-scale experiments with 50+ samples. Prepare well in advance to ensure you have the correct 10x kits, access to the Yale Flow Cytometry Facility sorter (if enriching rare populations), and enough personnel.</p>
        <p><strong>General steps:</strong> sample collection &rarr; cell isolation &rarr; cell pooling, counting, purifying (dead-cell removal) &rarr; barcoding and staining (+ fixation, depending on modality) &rarr; GEM generation (droplets isolating single cells) &rarr; cDNA amplification &rarr; library construction.</p>
        <p class="hb-src">Adapted from Hu et al., <em>Front. Cell Dev. Biol.</em> 2018.</p>
      </details>

      <details open><summary>Planning checklist</summary>
        <ul>
          <li>Acquire correct kits &amp; reagents (check volumes and expiration, especially GEM-X kits).</li>
          <li>Determine cells/sample, number of batches, and which grant pays for sequencing.</li>
          <li>Book hoods and the sorter; confirm all workers are available.</li>
          <li>Make reagents/buffers; label boxes and tubes.</li>
          <li>Review the protocol before the day.</li>
        </ul>
      </details>

      <details><summary>Setup: modality, chemistry &amp; batching</summary>
        <ol>
          <li><strong>Choose a modality</strong> (scRNAseq, CITEseq, scATACseq/ASAPseq).</li>
          <li><strong>Choose a sequencing chemistry / prep platform</strong> (10x: 5&prime;, 3&prime;, Flex). Consider downstream platform choice here too, to ensure compatibility.</li>
          <li><strong>Plan experiment batching</strong> (depends on number of subjects, samples per subject, etc. &mdash; the goal is to maximize kit usage):
            <ul>
              <li>Include biological replicates and controls; if multiple batches, controls must match across batches.</li>
              <li>Define priority: depth per cell (better gene detection) vs. number of cells (better rare-population detection).</li>
              <li>Define target cell number &mdash; too few misses biology, too many causes shallow sequencing/noise. Standard: 3k&ndash;10k cells/sample; rare populations: 50k+ cells/sample.</li>
              <li>Never confound biology with batch &mdash; mix conditions (disease/subject/controls) within each run and across loading lanes.</li>
              <li>Plan how many pools &rarr; HTOs you will need: cannot mix samples that are too similar (same subject/different timepoint, or genetically related subjects).</li>
              <li>Verify statistical power of batching; plan timing and personnel (what must be done immediately on thaw vs. can be delayed by fixing cells).</li>
            </ul>
          </li>
        </ol>
        <p class="hb-note">Example: 162 samples &rarr; 3 batches of 54 &rarr; 3 people thaw 18 each in parallel &rarr; each person makes 2 pools of 9 (6 pools, 6 HTO sets) &rarr; one person runs ASAP staining/fixation/GEM, one runs CITE staining/GEM, one handles sorting + sorted CITE, in-vitro stim, or bulk RNA-seq.</p>
        <h4>Key decisions to fill when planning</h4>
        <ul>
          <li>Modality + chemistry/platform?</li>
          <li>How many biological replicates?</li>
          <li>How many controls (and what are they)?</li>
          <li>Depth of reads per cell needed?</li>
          <li>Sequencing: library split?</li>
          <li>Target cell number per sample?</li>
          <li>How many batches? How many pools per batch?</li>
        </ul>
      </details>

      <details><summary>Modalities in depth</summary>
        <table class="hb-table">
          <thead><tr><th>Modality</th><th>Primary question</th><th>Output</th><th>Analysis</th><th>Limitations</th></tr></thead>
          <tbody>
            <tr><td>scRNA-seq</td><td>What cell types/states are present; what genes are expressed?</td><td>Gene &times; cell matrix (UMI counts)</td><td>Clustering into cell types/states; differential expression; gene-program discovery</td><td>No regulatory or spatial information</td></tr>
            <tr><td>CITE-seq</td><td>What surface proteins define identity, beyond RNA?</td><td>RNA counts + antibody-derived tag (ADT) counts per cell</td><td>RNA&ndash;protein clustering; improved cell-type annotation (esp. immune)</td><td>Builds on scRNA-seq; limited to chosen antibody panel; can slightly reduce RNA quality</td></tr>
            <tr><td>TCR/BCR (VDJ)</td><td>Clonal lineage &amp; diversity of immune cells?</td><td>Receptor sequences (TCR &alpha;/&beta; or BCR chains) linked to cells</td><td>Clonotype ID, clonal-expansion &amp; lineage tracking, diversity metrics</td><td>Add-on to 5&prime; cDNA / CITE-seq; can be sparse; no functional state without RNA</td></tr>
            <tr><td>scATAC-seq</td><td>What regulates expression (which regions are open)?</td><td>Peak &times; cell matrix (accessible chromatin)</td><td>Peak calling, motif/TF enrichment, regulatory-network inference, weak clustering</td><td>Often paired computationally with scRNA-seq; high sparsity</td></tr>
            <tr><td>ASAP-seq</td><td>How do accessibility &amp; surface protein relate?</td><td>scATAC output + ADTs</td><td>Joint chromatin&ndash;protein clustering; links surface phenotype to regulatory state; TF-motif analysis anchored to protein-defined populations</td><td>No RNA; high sparsity; antibody limitations; harder interpretation</td></tr>
            <tr><td>Flex</td><td>Fixed / banked RNA profiling</td><td>Probe-based gene counts</td><td>Cell-type &amp; state on fixed samples</td><td>Probe-based; different sample-prep track</td></tr>
          </tbody>
        </table>
      </details>

      <details><summary>Terms &amp; glossary</summary>
        <dl>
          <dt>scRNA-seq</dt><dd>Captures and sequences the mRNA transcriptome of individual cells rather than a bulk average, enabling cell-type identification and state analysis.</dd>
          <dt>CITE-seq</dt><dd>Cellular Indexing of Transcriptomes and Epitopes by sequencing &mdash; simultaneously measures gene expression and surface-protein abundance from the same cell using antibodies conjugated to DNA barcodes (ADTs). Produces two libraries (GEX + protein), analogous to combining scRNA-seq and flow cytometry on the same cells.</dd>
          <dt>ASAP-seq</dt><dd>ATAC with Select Antigen Profiling &mdash; combines single-cell ATAC (chromatin accessibility) with surface-protein measurement via antibody-derived tags. Measures which DNA regions are open, plus surface proteins.</dd>
          <dt>ATAC-seq</dt><dd>Assay for Transposase-Accessible Chromatin &mdash; a Tn5 transposase cuts and tags open chromatin; the tagged fragments are sequenced to map accessibility genome-wide.</dd>
          <dt>5&prime; vs 3&prime; chemistry</dt><dd>10x offers two library chemistries. 5&prime; sequences from the transcript start; 3&prime; reads from the poly-A side. 5&prime; is required to capture TCR/BCR variable regions, so choose 5&prime; if immune-repertoire profiling matters.</dd>
          <dt>GEM (Gel Bead-in-Emulsion)</dt><dd>The fundamental unit of the 10x Chromium system: an oil droplet containing one barcoded gel bead, lysis reagents, and ideally one cell. All transcripts from one cell get the same 10x cell barcode.</dd>
          <dt>Barcoding</dt><dd>Tagging molecules of interest (surface proteins, sample hashtags) with short DNA barcodes read alongside the transcriptome. Genetic (SNP) differences distinguish donors, but same-donor timepoints are distinguished with HTOs (hashtag oligos); ADTs can also be used but are read with a 3&prime; kit.</dd>
          <dt>ADT (Antibody-Derived Tag)</dt><dd>Antibodies conjugated to DNA barcodes that bind surface proteins; the tags are amplified alongside the transcriptome for simultaneous protein + RNA readout (CITE-seq).</dd>
          <dt>Hashtag / HTO</dt><dd>Antibodies conjugated to sample-specific barcodes to label which sample a cell belongs to, enabling multiplexing (pooling multiple samples in one channel, then computationally demultiplexing).</dd>
          <dt>UMI (Unique Molecular Identifier)</dt><dd>A short (~12 bp) random sequence added to each captured mRNA during reverse transcription; lets you collapse PCR duplicates (same barcode + same UMI = one original molecule).</dd>
          <dt>Multiplet / doublet</dt><dd>Two or more cells captured in one GEM, sharing a barcode and looking like one mixed cell. Doublet rate scales with cells loaded &mdash; a key constraint.</dd>
          <dt>Sequencing saturation</dt><dd>How thoroughly a library is sequenced. At 0% every read is a new UMI; at 100% every read is a duplicate. Typical GEX targets are 60&ndash;80%; beyond ~80% yields diminishing returns.</dd>
          <dt>Reads per cell</dt><dd>Raw reads allocated per cell barcode &mdash; the primary lever for sequencing depth. Different library types need very different depths.</dd>
          <dt>Mean reads/cell vs. median genes/cell</dt><dd>Reads/cell is your input (sequencing purchased); median genes/cell is an output. The relationship is logarithmic &mdash; doubling reads does not double genes detected.</dd>
          <dt>Flow cytometry / FACS</dt><dd>Cells pass single-file through a laser; fluorescent antibodies emit light captured by detectors for per-cell protein measurement. When cells are sorted by profile it&rsquo;s FACS.</dd>
          <dt>Viability</dt><dd>Percentage of live cells. Dead cells release ambient RNA that raises background. 10x recommends &gt;90%; &gt;85% is workable with more ambient contamination expected below that.</dd>
          <dt>Unsort / sort</dt><dd>Sorted cells are FACS-enriched for rare populations; the unsorted fraction is not enriched.</dd>
          <dt>Superload</dt><dd>Rather than adding the protocol&rsquo;s nuclease-free water to the cell suspension, maximize the suspension (little/no water) to load more cells &mdash; successful sequencing at lower cost, with resulting doublets demultiplexed later.</dd>
          <dt>Lanes / wells</dt><dd>The Chromium chip has row 1 (gel beads) and rows 2A/2B (samples). One gel-bead vial serves 2 cell samples. One <em>well</em> = one gel-bead vial; one <em>lane</em> = the two wells of cell suspension above/below the beads.</dd>
        </dl>
      </details>

      <details><summary>Fundamental design considerations</summary>
        <p>The value of scRNA-seq data relies on experimental design. Critical planning considerations: scientific-question specificity (drives sample types, isolation protocols, analysis), statistical-power requirements (inform cell-count targets and depth), and technical-variability mitigation (deliberate batch design and controls).</p>
        <h4>Defining clear research objectives</h4>
        <p>Hypothesis-driven approaches yield more interpretable results than exploratory ones. Consider whether questions require comprehensive cell-type ID, detection of rare populations, trajectory/differentiation analysis (fewer cells, greater depth), response to perturbations, or disease-associated alterations.</p>
        <h4>Key questions to consider</h4>
        <ul>
          <li><strong>How rare is the rarest population you care about?</strong> To detect a 1% population you need enough total cells that 1% still gives ~30&ndash;50 cells/sample (ideally 100+). Detecting a 1% population at n=100 means loading ~10,000 cells total.</li>
          <li><strong>Do you need protein alongside RNA?</strong> If yes, CITE-seq (protein + transcriptome) or ASAP-seq (protein + accessibility) &mdash; both need antibody panels and extra library prep.</li>
          <li><strong>Do you need TCR/BCR?</strong> This mandates the 5&prime; kit and the V(D)J enrichment library.</li>
          <li><strong>How many samples/conditions?</strong> Determines whether hashtag multiplexing makes sense (saves reagent cost and reduces cross-channel batch effects).</li>
        </ul>
        <h4>Biological controls &amp; replicates</h4>
        <p>Include biological controls to separate biology from technical artifacts. Most robust studies include at least three true biological replicates per condition. For DGE between conditions, treat each <em>sample</em> (not each cell) as the experimental unit &mdash; cells from one sample are correlated, so treating cells as independent causes pseudoreplication and false discoveries (Squair et al. 2021). Use mixed-effects models or pseudobulk (summing counts across cells within a sample).</p>
        <h4>Batch effects, viability &amp; cell size</h4>
        <ul>
          <li><strong>Batch effects:</strong> use a balanced design &mdash; process replicates from different conditions in parallel, not sequentially.</li>
          <li><strong>Viability:</strong> dead cells release ambient mRNA and clump into doublets. Minimize thaw-to-load time; keep cells on ice except during required room-temp steps; use a dead-cell removal kit (e.g. Miltenyi) below ~85%; filter through a 40 µm strainer before loading; count with a viability dye and get accurate counts (loading math depends on it).</li>
          <li><strong>Cell size:</strong> the chip suits ~5&ndash;30 µm cells. Very large cells (some macrophages, cardiomyocytes) may clog/lyse; very small cells may not be captured. Outside this range, consult 10x or use nuclei isolation.</li>
        </ul>
        <p class="hb-src">Adapted from nygen.io scRNA-seq design guide and 10x Genomics DGE analysis guide.</p>
      </details>

      <details><summary>Batch organization</summary>
        <ul>
          <li>Decide the number of cells to run; determine samples/batch, then cells/sample.</li>
          <li>Split samples into batches to avoid confounding covariates (sex, age, collection/vaccination time) by distributing them equally across batches. Use software (e.g. the Omixer R package, or the Protocol Builder code).</li>
          <li>Each experiment needs its own batch logic &mdash; e.g. keep all samples from one individual in the same batch while balancing male/female across batches. Samples/batch depends on lanes; the lab typically runs ~50 samples/batch.</li>
          <li>Organize each batch into boxes in the LN tank before the day &mdash; ideally one box per worker thawing.</li>
          <li>Create labeled tubes for each experiment component (cell thawing, TriZol). Use the cell-count spreadsheet to calculate the volume needed of each sample at every stage.</li>
        </ul>
      </details>

      <details><summary>Hashtag multiplexing</summary>
        <p>Label each sample with a unique hashtag antibody (HTO) before pooling and loading onto a single 10x channel, then computationally assign each cell to its sample of origin after sequencing.</p>
        <h4>Why multiplex?</h4>
        <ul>
          <li><strong>Cost savings:</strong> running 4 samples on 1 channel costs roughly 1/4 the reagent cost of 4 separate channels.</li>
          <li><strong>Reduced batch effects:</strong> multiplexed samples are processed identically (same GEM gen, PCR, library prep).</li>
          <li><strong>Doublet detection:</strong> cross-sample doublets carry two hashtags and can be removed confidently.</li>
        </ul>
        <h4>Key decisions</h4>
        <ul>
          <li><strong>Samples per channel?</strong> Commonly 2&ndash;8; more samples means fewer cells each and higher raw doublet rate. 4/channel is a common sweet spot.</li>
          <li><strong>Hashtag choice:</strong> for immune cells, antibodies to ubiquitous markers (e.g. CD298/&beta;2-microglobulin) work well; keep them compatible with your CITE panel (same TotalSeq-C series for 5&prime;).</li>
          <li><strong>Unequal mixing:</strong> if cell counts differ a lot, mix at unequal ratios (e.g. 1:3) so the scarce sample isn&rsquo;t underrepresented.</li>
        </ul>
        <p class="hb-note"><strong>Key constraint:</strong> SNP demux cannot separate samples that are too similar (same subject/different timepoint, or genetically related subjects) &mdash; those must be separated by HTO, i.e. placed in different genetic pools carrying different hashtags. This is exactly what the Plan tab enforces.</p>
      </details>

      <details><summary>Deciding on cell numbers</summary>
        <p>After thawing and counting, work backwards to cells/sample from the number of samples and the lanes/sequencing you can afford. The Chromium recovers ~60% of cells loaded (varies by cell type/viability) &mdash; for 10,000 cells in data, load ~16,500.</p>
        <h4>Recovery vs. doublet rate</h4>
        <table class="hb-table">
          <thead><tr><th>Target recovery</th><th>Approx. doublet rate</th></tr></thead>
          <tbody>
            <tr><td>~500 cells</td><td>~0.4%</td></tr>
            <tr><td>~3,000</td><td>~2.3%</td></tr>
            <tr><td>~5,000</td><td>~3.9%</td></tr>
            <tr><td>~10,000</td><td>~7.6%</td></tr>
            <tr><td>~20,000</td><td>~15.2% (usually too high)</td></tr>
          </tbody>
        </table>
        <h4>How to decide</h4>
        <ul>
          <li>Discovery / full landscape, 1 sample/channel: 8,000&ndash;10,000 recovered (sees ~1% populations at reasonable power).</li>
          <li>Multiplexed 4 hashtagged samples/channel: ~20,000 total (~5,000 each) &mdash; apparent doublet rate is high but hashtag demux removes most.</li>
          <li>FACS-enriched rare population: 3,000&ndash;5,000 recovered (already enriched).</li>
        </ul>
        <h4>Superloading (lab practice)</h4>
        <p>The lab superloads to ~85,000 cells/lane. It is more efficient with sufficient sample numbers (good for big experiments); for small experiments it is riskier (higher chance of same-donor doublets that are hard to demultiplex). Work backwards to cells/sample to reach that concentration.</p>
        <ul>
          <li><strong>Sorted populations:</strong> ~100,000 cells/lane for scRNA-seq. Volume sent to the sorter depends on population frequency &mdash; e.g. pDCs are ~0.5% of PBMCs, so to get ~1 million from the sorter, send ~50 million cells (~1 million/sample across 50 samples). More is better.</li>
          <li><strong>Unsorted populations:</strong> ~1.2 million cells to run CITE-seq on the unsorted fraction for 1 lane.</li>
        </ul>
      </details>

      <details><summary>Kits &amp; reagents</summary>
        <ul>
          <li>Confirm existence and volumes of kits (especially GEM-X kits) and expiration dates.</li>
          <li>Confirm stim reagents if needed.</li>
          <li>Make thawing/washing buffers before the experiment.</li>
        </ul>
        <h4>Rough per-modality list</h4>
        <ul>
          <li><strong>scRNA-seq / CITE-seq:</strong> Chromium GEM-X Single Cell 5&prime; Kit v3; TotalSeq-C HTO antibody; TotalSeq-C Universal Cocktail.</li>
          <li><strong>ASAP-seq:</strong> ATAC/3&prime; kit; TotalSeq-A HTO antibody; TotalSeq-A Universal Cocktail.</li>
        </ul>
        <p class="hb-note">The handbook&rsquo;s original list cites Next GEM Single Cell 5&prime; HT Reagent Kits v2 (48 rxn); the lab is transitioning to GEM-X 5&prime; v3.</p>
        <h4>Kit explanations</h4>
        <ul>
          <li>10x offers 3&prime; and 5&prime; kits; the lab uses 5&prime; for scRNA-seq and CITE-seq and 3&prime;/ATAC for ASAP-seq. Full per-kit details are in the lab binder and on the 10x website.</li>
          <li><strong>TotalSeq HTO:</strong> antibodies with traceable oligo barcodes that label each pool so pools can be separated later. TotalSeq-A is used for ASAP-seq, TotalSeq-C for CITE-seq.</li>
          <li><strong>Universal cocktails (lyophilized Ab panel):</strong> applied after HTO, once all samples for a modality are pooled, before washing/loading. ~137 markers to characterize immune populations downstream.</li>
        </ul>
        <h4>Reagent explanations</h4>
        <ul>
          <li><strong>RPMI / high DNase:</strong> warmed thaw media with higher DNase to degrade DNA contaminants and DNA/RNA from dying cells; contains FBS (blocks nonspecific binding), HEPES (stable pH), pen/strep (anti-bacterial).</li>
          <li><strong>RPMI / low DNase:</strong> once thawed, switch to lower DNase (less floating DNA remains).</li>
          <li><strong>Staining/wash &amp; FACS buffer:</strong> a neutral buffer with protein to block nonspecific binding &mdash; BSA for wash buffer, FBS for FACS if sorting.</li>
        </ul>
      </details>

      <details><summary>Protocol workflow overviews &amp; key decisions</summary>
        <h4>1. Standard scRNA-seq (5&prime; gene expression)</h4>
        <ol>
          <li><strong>Cell prep:</strong> single-cell suspension; count and assess viability; adjust concentration per the 10x user guide (~700&ndash;1,200 cells/µL for standard loading).</li>
          <li><strong>GEM generation &amp; barcoding:</strong> load suspension, gel beads, and oil; cells lyse in GEMs, mRNA binds barcoded poly-dT primers, RT produces barcoded full-length cDNA.</li>
          <li><strong>Post-GEM RT cleanup:</strong> break the emulsion; clean barcoded cDNA with silane/SPRIselect beads.</li>
          <li><strong>cDNA amplification:</strong> PCR (typically 11&ndash;14 cycles; lower input needs more cycles).</li>
          <li><strong>cDNA QC:</strong> Bioanalyzer/TapeStation &mdash; broad smear ~1,000&ndash;2,000 bp; check ng yield.</li>
          <li><strong>Library construction:</strong> fragment, end-repair, A-tail, ligate adapters with a sample index.</li>
          <li><strong>Library QC:</strong> distribution ~400&ndash;600 bp; quantify by Qubit and/or qPCR.</li>
          <li><strong>Sequencing:</strong> Illumina (NovaSeq/NextSeq) with the appropriate read config (usually a core).</li>
        </ol>
        <h4>2. CITE-seq (5&prime; GEX + surface protein)</h4>
        <p>ADT antibodies bind surface proteins before the Chromium; ADT barcodes are captured with mRNA, giving two libraries (GEX + ADT).</p>
        <ul>
          <li><strong>Panel design:</strong> TotalSeq-C (BioLegend) for the 5&prime; workflow; check availability, isotype controls, and cost.</li>
          <li><strong>Staining (before loading):</strong> wash, <em>block Fc receptors</em> (critical &mdash; prevents false-positive protein signal), incubate with cocktail, wash thoroughly (unbound antibody = background).</li>
          <li><strong>Rest follows the 5&prime; workflow;</strong> at cDNA amp, size-select (SPRIselect ratios) to split small ADT fragments (~180 bp) from large GEX cDNA.</li>
          <li><strong>Two libraries built independently</strong> (GEX + ADT), each sample-indexed.</li>
          <li><strong>Key decisions:</strong> panel size (start focused, 30&ndash;100 markers &mdash; cleaner than 200+); titrate antibodies like flow (over-stain = background, under-stain = weak signal).</li>
        </ul>
        <h4>3. ASAP-seq (ATAC + surface protein)</h4>
        <p>Measures chromatin accessibility + surface protein. Instead of mRNA, Tn5 inserts adapters into open chromatin; tagged fragments are barcoded in GEMs.</p>
        <ul>
          <li><strong>Nuclei prep &amp; transposition:</strong> stain cells with TotalSeq antibodies, gently lyse to expose nuclei (keep envelope intact), add Tn5 to tagment. Time-sensitive &mdash; over-transposition shreds chromatin, under gives low complexity.</li>
          <li><strong>GEM generation:</strong> tagmented nuclei (antibodies still attached) loaded; tagmented DNA + ADT barcodes captured.</li>
          <li><strong>Libraries:</strong> ATAC + ADT (optionally a mitochondrial library).</li>
          <li><strong>Key decisions:</strong> Tn5 amount/time (most critical optimization); nuclei quality (gentle lysis preserving nuclear integrity; may vary by cell type).</li>
        </ul>
        <h4>4. V(D)J immune repertoire (TCR/BCR)</h4>
        <p>From the same 5&prime; cDNA pool that makes the GEX library, enrich TCR and/or BCR by two rounds of nested PCR against the constant regions, then build a separate V(D)J library.</p>
        <ul>
          <li><strong>TCR, BCR, or both?</strong> Each needs its own enrichment; both T and B repertoire = two extra libraries (GEX, ADT if applicable, TCR, BCR).</li>
          <li><strong>Cell input:</strong> meaningful only with enough T/B cells for clonal expansion &mdash; e.g. 5% T cells of 5,000 loaded is only ~250 T cells, likely too few.</li>
        </ul>
      </details>

      <details><summary>Hoods, sorter &amp; sequencing (personnel)</summary>
        <ul>
          <li>Ensure adequate personnel for each step. For ~50 samples: 3 workers thawing; 2 pooling; 2 for TriZol; 1 CITE-seq; 1 ASAP-seq; 1 for stim/sorted fraction. After the experiment day, libraries from GEMs can be built by 1&ndash;2 workers over ~1 week.</li>
          <li>Book BSL hoods and the sorter (if needed) in advance.</li>
          <li>Determine sequencing needed.</li>
        </ul>
      </details>

      <details><summary>Expanded protocol &mdash; cell thawing / PBMC prep (7&ndash;10am)</summary>
        <h4>Materials</h4>
        <ul><li>15 mL prelabeled conicals (&times; samples); Thawsome adaptors (&times; samples); counting plate; FACS tubes (&times; pools).</li></ul>
        <h4>Reagents</h4>
        <ul><li>Complete RPMI (10 mL &times; samples); DNase; AOPI cell dye.</li></ul>
        <h4>Machinery</h4>
        <ul><li>Centrifuge (room temp); incubator; cell counter.</li></ul>
        <h4>Thaw &amp; count</h4>
        <ol>
          <li>Warm complete RPMI in a 37&deg;C bath; set centrifuge to room temp; thaw DNase.</li>
          <li>Prepare RPMI + DNase at 0.1 mg/mL for thawing (1 tube/sample; e.g. 54 tubes &times; 10 mL = 540 mL total). To make extra: add 5.7 mL DNase (10 mg/mL stock) to 565 mL RPMI &rarr; final 0.1 mg/mL.</li>
          <li>Aliquot 10 mL RPMI-DNase into each pre-labeled 15 mL tube. Allow ~20 min to warm before removing cells from the LN tank.</li>
          <li>Centrifuge-thaw: invert cryovial into a Thawsome adapter on top of the 15 mL conical with media. Open frozen samples away from your face (built-up pressure). Spin <strong>10 min @ 350g, 25&deg;C, accel/brake 9</strong>.</li>
          <li>While spinning, make 3 &times; 50 mL "RPMI-DNase-low": add 125 µL stock DNase to each (final 0.025 mg/mL). Prepare 3 counting plates with 20 µL AOPI per mixing well.</li>
          <li>After the spin, pour off supernatant, tap to loosen pellet, add 2 mL RPMI-DNase-low with a p1000 and pipette gently to dissolve.</li>
          <li>Transfer 20 µL into a dye well, mix 10&times;, and count. Then incubate tubes at 37&deg;C (CO&#8322;, lids loose) 10 min, then move all to ice &mdash; keep on fresh ice for the rest of the experiment.</li>
          <li>Export counts and use the cell-count spreadsheet to compute µL from each tube for even pooling, reserving 100&ndash;500k cells for TriZol (bulk RNA) and leftovers for stimulation. Print the per-sample pooling volumes.</li>
        </ol>
        <p class="hb-note">Example split across 3 workers: samples 1&ndash;18, 19&ndash;36, 37&ndash;54, each with a 50 mL tube of RPMI-DNase-low.</p>
      </details>

      <details><summary>Expanded protocol &mdash; pool &amp; split</summary>
        <ul>
          <li>On ice, combine samples into pools using the spreadsheet volumes. Ensure no pool has more than one sample from the same donor (e.g. 54 samples from 19 individuals across several timepoints &rarr; 5&ndash;6 pools, 1 sample/donor each).</li>
          <li>Add the leukopak control to each pool (~8&ndash;9 IDVax samples + 1 leukopak per pool).</li>
          <li>Agitate/mix each sample before pooling, then transfer from each 15 mL sample tube to the corresponding pool tube:
            <ul>
              <li><strong>5&prime; sort pool:</strong> transfer ~1 million cells/sample to the 50 mL tube ("pool volume &ndash; sort").</li>
              <li><strong>Unsort pool:</strong> transfer ~100,000 cells/sample to the FACS tube ("pool volume &ndash; unsort").</li>
              <li><strong>ASAP:</strong> transfer ~200,000 cells/sample to the FACS tube ("pool volume &ndash; ASAP").</li>
            </ul>
          </li>
          <li>Route tubes: unsort tubes &rarr; "Unsort 5&prime; panel staining and ASAP"; sort tubes &rarr; "Staining for sorting specific cell fractions". Leave leftover cells on ice for TriZol and PBMC stimulation.</li>
        </ul>
      </details>
    </div>`;

  function equipmentHTML(plan) {
    // Equipment needs adapt to selected modalities when a plan exists.
    let needs = [
      ['Centrifuge (room temp) + incubator', 'Thaw / PBMC prep', true],
      ['Cell counter (Nexcelom Cellaca)', 'Counting', true],
      ['BSL-2 hood(s)', 'All wet-lab staining', true],
      ['10x Chromium X/iX', 'GEM generation', true],
      ['Thermal cycler', 'cDNA amp / library construction', true],
      ['Bioanalyzer / TapeStation', 'QC', true]
    ];
    if (plan) {
      if (plan.arms.includes('sort5')) needs.push(['Yale Flow Cytometry Facility sorter', 'FACS enrichment — book in advance', true]);
      if (plan.arms.includes('asap3')) needs.push(['Tn5 / tagmentation setup', 'ASAP-seq nuclei prep — time-sensitive', true]);
      if (plan.modalities.includes('Flex (fixed RNA profiling)')) needs.push(['Fixation/hybridization station', 'Flex sample prep', true]);
    }
    let rows = needs.map((n) => '<tr><td>' + n[0] + '</td><td>' + n[1] + '</td></tr>').join('');

    return `
    <div class="equip">
      <h2>Equipment &amp; booking</h2>
      <p class="muted">${plan ? 'Tailored to your selected modalities.' : 'Build a plan to tailor this list to your modalities.'}</p>
      <table class="hb-table"><thead><tr><th>Equipment</th><th>Used for</th></tr></thead><tbody>${rows}</tbody></table>

      <div class="cal-embed">
        <h3>Booking calendar</h3>
        <div class="placeholder-card">
          <p><strong>Placeholder — add your Google Calendar.</strong> Paste your lab's shared calendar embed here. In Google Calendar: <em>Settings → Settings for my calendars → [calendar] → Integrate calendar → Embed code</em>, then replace the <code>src</code> in <code>index.html</code> / this block.</p>
          <pre><code>&lt;iframe src="https://calendar.google.com/calendar/embed?src=YOUR_CALENDAR_ID"
        style="border:0" width="100%" height="600" frameborder="0"&gt;&lt;/iframe&gt;</code></pre>
          <p class="muted">Suggested resources to book: BSL-2 hoods, 10x Chromium, Yale Flow Core sorter, sequencing drop-off (YCGA iLAB).</p>
        </div>
      </div>
    </div>`;
  }

  const api = { handbookHTML, equipmentHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HandbookContent = api;
})(typeof window !== 'undefined' ? window : globalThis);
