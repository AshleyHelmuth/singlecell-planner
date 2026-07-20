/* ============================================================================
   parse.js  —  Reads the SingleCell master-schema .xlsx into plain JS objects.
   Depends on SheetJS (XLSX global). Every extractor is defensive: missing
   sheets/columns yield empty structures rather than throwing, so the site still
   runs while the spreadsheet is a work in progress.
   ============================================================================ */

(function (root) {
  'use strict';

  const norm = (v) => (v == null ? '' : String(v).trim());
  const numish = (v) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  };

  // Return sheet as array-of-arrays (1 row = 1 array), preserving blanks.
  function grid(wb, name) {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
  }

  // Find the header row (contains a cell exactly === needle) in a grid.
  function findHeaderRow(g, needle) {
    for (let i = 0; i < g.length; i++) {
      if (g[i] && g[i].some((c) => norm(c).toLowerCase() === needle.toLowerCase())) return i;
    }
    return -1;
  }

  // ---- Standard "labelled columns" sheet (title row 1, subtitle row 2, header
  //      row containing a known key, data rows after) --------------------------
  function labelledSheet(wb, name, keyColumn) {
    const g = grid(wb, name);
    const hdr = findHeaderRow(g, keyColumn);
    if (hdr === -1) return { rows: [], headers: [] };
    const headers = g[hdr].map(norm);
    const rows = [];
    for (let i = hdr + 1; i < g.length; i++) {
      const r = g[i];
      if (!r || r.every((c) => c == null || c === '')) continue;
      const obj = {};
      headers.forEach((h, j) => { if (h) obj[h] = r[j]; });
      // skip pure note/spacer rows that have no key value
      if (norm(obj[headers[0]]) === '') continue;
      rows.push(obj);
    }
    return { rows, headers };
  }

  // ---- Consumables sheet parser (Pre_ / Post_GEM) ----------------------------
  //   Flat per-item layout (header on row 1):
  //   Section | Type | Item / supply | Item ID | Scaling basis | Amount per unit |
  //   Unit | Overage | Count | Total needed | Order | Unit price ($) |
  //   Cost per basis-unit | Total cost | Notes | _price | _stock | _stockUnit
  //   One row = one item. Each item carries a single scaling basis (per sample /
  //   per genetic pool / per super-pool / per <library> / per Flex sample, ...)
  //   which the cost engine multiplies by the current plan.
  function consumablesSheet(wb, name) {
    const g = grid(wb, name);
    if (!g.length) return { stages: [], items: [] };
    const hdr = (g[0] || []).map((x) => norm(x).toLowerCase());
    const col = (names) => {
      for (let c = 0; c < hdr.length; c++) if (names.some((nm) => hdr[c] === nm)) return c;
      return -1;
    };
    const cSection = col(['section']);
    const cType = col(['type']);
    const cItem = col(['item / supply', 'item / supply ', 'item/supply', 'item']);
    const cId = col(['item id', 'item_id']);
    const cBasis = col(['scaling basis']);
    const cAmt = col(['amount per unit', 'amount/unit', 'amount']);
    const cUnit = col(['unit']);
    const cOver = col(['overage']);
    const cTotal = col(['total needed']);
    const cPrice = col(['unit price ($)', 'unit price', 'unit_price ($)']);
    const cNotes = col(['notes']);
    const cStockU = col(['_stockunit']);
    // Not the flat format (e.g. an old matrix sheet) -> nothing to read.
    if (cItem < 0 || cBasis < 0) return { stages: [], items: [] };

    const items = [];
    let section = '';
    for (let i = 1; i < g.length; i++) {
      const r = g[i];
      if (!r) continue;
      if (cSection >= 0 && norm(r[cSection])) section = norm(r[cSection]);
      const item = norm(r[cItem]);
      if (!item) continue;
      const itemId = cId >= 0 ? norm(r[cId]) : '';
      items.push({
        section,
        type: cType >= 0 ? norm(r[cType]) : '',
        item, itemId,
        scalingBasis: cBasis >= 0 ? norm(r[cBasis]) : '',
        amountPerUnit: cAmt >= 0 ? numish(r[cAmt]) : null,
        units: cUnit >= 0 ? norm(r[cUnit]) : '',
        overage: cOver >= 0 ? numish(r[cOver]) : null,
        totalNeeded: cTotal >= 0 ? numish(r[cTotal]) : null,
        unitPrice: cPrice >= 0 ? numish(r[cPrice]) : null,
        note: cNotes >= 0 ? norm(r[cNotes]) : '',
        stockUnit: cStockU >= 0 ? norm(r[cStockU]) : '',
        catalogKey: itemId,
        perStage: {} // legacy shape; unused by the flat cost path
      });
    }
    return { stages: [], items };
  }

  // ---- Public extractors -----------------------------------------------------

  function modalities(wb) {
    const { rows } = labelledSheet(wb, 'Modality_Definitions', 'modality_id');
    return rows.map((r) => ({
      id: norm(r.modality_id),
      name: norm(r.modality),
      chemistry: norm(r.chemistry),
      requiredStages: norm(r.required_stage_ids).split(',').map((s) => s.trim()).filter(Boolean),
      targetCells: norm(r.default_target_recovered_cells),
      doublet: norm(r.typical_doublet_rate),
      notes: norm(r.notes)
    }));
  }

  function kits(wb) {
    const { rows } = labelledSheet(wb, 'Kit_Catalog', 'kit_id');
    return rows.map((r) => ({
      id: norm(r.kit_id),
      name: norm(r.kit_name),
      part: norm(r.part_number),
      category: norm(r.category),
      chemistry: norm(r.chemistry),
      reactions: numish(r.reactions_per_kit),
      price: numish(r.price_usd)
    })).filter((k) => k.id);
  }

  function supplies(wb) {
    const { rows } = labelledSheet(wb, 'Additional_Supply_Catalog', 'item_id');
    return rows.map((r) => {
      const price = numish(r.Price);
      const stockSize = numish(r['Stock Size (Units)']);
      const stockUnits = norm(r['Stock Units']) || norm(r.Units);
      const usageStock = numish(r['Adjusted Stock Size (Usage Units)']);
      const usageUnits = norm(r['Usage Units']) || stockUnits;
      // Price/Unit and Adjusted-Stock columns are spreadsheet formulas that lose
      // their cached values on re-save, so derive price-per-unit from the literal
      // Price + Stock Size and remember which unit that price is expressed in.
      let pricePerUnit = null, priceUnit = '';
      const explicit = numish(r['Price/ Unit ']) ?? numish(r['Price/ Unit']);
      if (explicit != null) { pricePerUnit = explicit; priceUnit = usageUnits; }
      else if (price != null && stockSize) { pricePerUnit = price / stockSize; priceUnit = stockUnits; }
      else if (price != null && usageStock) { pricePerUnit = price / usageStock; priceUnit = usageUnits; }
      return {
        id: norm(r.item_id),
        reagent: norm(r.reagent),
        appliesTo: norm(r.applies_to_protocol),
        vendor: norm(r.vendor),
        catalog: norm(r.catalog_number),
        price: price,
        stockSize: stockSize,
        stockUnits: stockUnits,
        usageStock: usageStock,
        usageUnits: usageUnits,
        units: usageUnits || stockUnits,
        pricePerUnit: pricePerUnit,
        priceUnit: priceUnit
      };
    }).filter((s) => s.id);
  }

  function antibodies(wb) {
    const { rows } = labelledSheet(wb, 'Antibody_HTO_Catalog', 'item_id');
    return rows.map((r) => ({
      id: norm(r.item_id),
      vendor: norm(r.vendor),
      name: norm(r.item_name),
      catalog: norm(r.catalog_number),
      type: norm(r.totalseq_type)
    })).filter((a) => a.id);
  }

  function sequencing(wb) {
    const { rows } = labelledSheet(wb, 'Sequencing_Pricing', 'platform_id');
    return rows.map((r) => ({
      id: norm(r.platform_id),
      platform: norm(r.platform),
      config: norm(r.configuration),
      price: numish(r.price_usd),
      pricePerM: numish(r.price_per_M_reads),
      notes: norm(r.notes)
    })).filter((s) => s.id);
  }

  function stages(wb) {
    const { rows } = labelledSheet(wb, 'Protocol_Stages', 'stage_id');
    return rows.map((r) => ({
      id: norm(r.stage_id),
      name: norm(r.stage_name),
      description: norm(r.stage_description),
      timeWindow: norm(r.typical_time_window),
      personnelRule: norm(r.personnel_rule),
      sourceDoc: norm(r.source_protocol_doc),
      notes: norm(r.notes)
    })).filter((s) => s.id);
  }

  function personnel(wb) {
    const { rows } = labelledSheet(wb, 'Personnel_Roster', 'person_id');
    return rows.map((r) => ({
      id: norm(r.person_id),
      name: norm(r.name),
      role: norm(r.role),
      trainedStages: norm(r.trained_stage_ids).split(',').map((s) => s.trim()).filter(Boolean),
      availability: norm(r.weekly_availability),
      active: norm(r.active).toLowerCase() !== 'no'
    })).filter((p) => p.id);
  }

  function cellFlowAssumptions(wb) {
    const { rows } = labelledSheet(wb, 'Cell_Flow_Assumptions', 'assumption_id');
    const byId = {};
    rows.forEach((r) => {
      const id = norm(r.assumption_id);
      if (!id) return;
      byId[id] = { label: norm(r.label), value: numish(r.default_value), units: norm(r.units), notes: norm(r.notes) };
    });
    return byId;
  }

  function parseWorkbook(wb) {
    return {
      modalities: modalities(wb),
      kits: kits(wb),
      supplies: supplies(wb),
      antibodies: antibodies(wb),
      sequencing: sequencing(wb),
      stages: stages(wb),
      personnel: personnel(wb),
      preGem: consumablesSheet(wb, 'Pre_GEM_Consumables'),
      postGem: consumablesSheet(wb, 'Post_GEM_Consumables'),
      cellFlowAssumptions: cellFlowAssumptions(wb),
      liveInventory: liveInventory(wb),
      sheetNames: wb.SheetNames.slice()
    };
  }

  function liveInventory(wb) {
    const { rows } = labelledSheet(wb, 'Live_Inventory', 'item_id');
    return rows.map((r) => {
      const packSize = numish(r.pack_size);
      const container = norm(r.container);
      let usageUnit = norm(r.usage_unit);
      let currentContainers = numish(r.current_containers);
      let currentUnits = numish(r.current_units);
      // If no distinct pack size, the container IS the usage unit (1:1).
      const pack = (packSize && packSize > 0) ? packSize : 1;
      if (!usageUnit) usageUnit = (packSize && packSize > 0) ? '' : container;
      if (currentUnits == null && currentContainers != null) currentUnits = currentContainers * pack;
      if (currentContainers == null && currentUnits != null && pack) currentContainers = currentUnits / pack;
      return {
        id: norm(r.item_id),
        name: norm(r.item_name),
        catalogTab: norm(r.source_catalog_tab),
        container: container,
        packSize: pack,
        usageUnit: usageUnit,
        unit: usageUnit,               // back-compat alias
        currentContainers: currentContainers,
        currentUnits: currentUnits,
        currentStock: currentUnits,    // back-compat alias
        minStock: numish(r.min_stock_threshold),
        orderStatus: norm(r.order_status),
        location: norm(r.location),
        lastRestock: norm(r.last_restock_date),
        notes: norm(r.notes)
      };
    }).filter((x) => x.id && x.id !== 'item_id');
  }

  const api = { parseWorkbook, _internal: { grid, labelledSheet, consumablesSheet } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SchemaParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
