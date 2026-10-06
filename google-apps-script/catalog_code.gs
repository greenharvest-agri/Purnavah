/**
 * Purnavah — Catalog Admin backend (Google Apps Script)
 * ─────────────────────────────────────────────────────
 * Powers products.html: list / add / update / delete rows in the
 * "Catalog" sheet tab. Auth: any active admin's password from the Admins
 * tab — see resolveAdminByPassword_ below (equal access for every admin,
 * §13 point 3 — this page doesn't scope by role/identity).
 *
 * SETUP
 * 1. Create (or open) the Google Sheet that will hold the catalog.
 * 2. Add a tab named exactly "Catalog". Run setupSheet() once (see
 *    below) from the Apps Script editor to create the header row for
 *    you, or type it in by hand — must match HEADERS exactly:
 *      Product ID | Product Name | Category | Display Name | Unit | Pack Size |
 *      MRP | HSN/SAC | GST% | Stock | Active | WA Key | Notes | Weight (kg) |
 *      Contents | Max Order Qty (kg)
 *    Per-hub stock (see below) additionally needs one "Stock: <Admin ID>"
 *    column per active hub-admin, added manually the same way "Weight (kg)"
 *    was — the plain "Stock" column above is legacy/no longer read once
 *    those exist.
 * 3. Extensions → Apps Script, paste this whole file in as Code.gs.
 * 4. Change INTERNAL_KEY below if you don't want to reuse the Orders script's value.
 * 5. Deploy → New deployment → type "Web app" →
 *      Execute as: Me
 *      Who has access: Anyone
 *    Deploy, authorize, copy the "Web app URL".
 * 6. Paste that URL into products.html's "Apps Script Web App URL" field.
 *
 * Re-deploy (Manage deployments → Edit → new version) every time you
 * change this script — editing the code alone does not update a live
 * deployment's URL behavior. If a "new version" of an existing deployment
 * doesn't seem to take effect, create a brand-new deployment instead — a
 * known Apps Script quirk, not a bug in this file.
 *
 * PUBLIC ENDPOINT
 * ?action=catalog (GET, no key) is used by index.html — the live order
 * form. It returns only Active = Y rows (out-of-stock rows are still
 * included, flagged with inStock:false, so out-of-stock products show
 * disabled instead of disappearing), and only the fields a shopper needs
 * (no exact Stock counts, HSN, or Notes). Deploy this script and paste the
 * Web app URL into index.html's CATALOG_API_URL.
 *
 * PRODUCT ID (added 2026-07-09)
 * Every row has an auto-generated, never-editable "Product ID" (PRD-XXXXXX).
 * Existing sheets need a one-time manual migration: insert a new column A
 * named "Product ID" in the Sheet UI (shifts existing data right to line up
 * with HEADERS), then run backfillProductIds() once from the editor.
 * orders_code.gs calls the new "decrementStock" action (internal-key gated)
 * when an admin confirms an order, matching on Product ID.
 *
 * WEIGHT (kg) (added 2026-07-12, Issue 2)
 * Used by admin.html's confirm modal to show estimated package weight.
 * Existing sheets need a one-time manual migration: add a new column named
 * "Weight (kg)" at the END of the sheet (lowest-risk — no need to shift any
 * existing columns), then run backfillCatalogWeights_() once from the
 * editor to fill it in by parsing each row's Pack Size. Rows missing an
 * explicit Weight (kg) value fall back to the same Pack-Size parse at read
 * time (see parseWeightFromPackSize_), so the backfill is a convenience,
 * not a hard requirement.
 *
 * COUPONS (added 2026-07-17)
 * ?action=coupon&code=XYZ (GET, no key) is used by index.html to let a
 * customer self-apply a discount code. Reads a separate "Coupons" tab in
 * this same spreadsheet — columns: ID | Coupon Code | Value | Active.
 * Deliberately only ever returns the single looked-up code's result (valid
 * + discount value, or invalid), never the full coupon list, so hitting
 * this endpoint can't be used to enumerate all active codes.
 *
 * MAX ORDER QTY (KG) (added 2026-08-11)
 * Per-product cap on how much of one product a customer can add to a
 * single order, expressed in kg (not packet count) so it holds even if a
 * customer mixes pack sizes of the same product (e.g. Jeera Phool capped
 * at 2kg total, whether that's two 1kg packs, four 500g packs, or a mix).
 * Existing sheets need a one-time manual migration: add a new column named
 * "Max Order Qty (kg)" at the END of the sheet (lowest-risk — no need to
 * shift any existing columns). Leave it blank (or 0) on any row that
 * should have no limit — that's the default for every product until an
 * admin sets one, via products.html or directly in the sheet. Enter the
 * same value on every pack-size row of a given product — index.html reads
 * it per-row and takes the max across a product's variants, so a blank row
 * mixed with a filled one still works, but consistent entry is clearer.
 * Enforced client-side only (index.html), using each row's Weight (kg) —
 * a product with no weight set (and an unparseable Pack Size) can't have
 * this cap enforced, since there's nothing to convert packets to kg with.
 *
 * ADMINS — MULTI-ADMIN WORKFLOW (added 2026-09-15, promoted to prod
 * 2026-09-22, §13). Real per-admin passwords replace the old shared
 * ADMIN_KEY for every human-facing action. Reads/writes an "Admins" tab in
 * this same spreadsheet — columns: Admin ID | Name | Role | WhatsApp Number |
 * UPI VPA | Active | Password. Run setupAdminsSheet() once from the Apps
 * Script editor to create the tab, then add one row per admin by hand
 * (Super Admin's password is just another row here too — no separate
 * top-level check). resolveAdminByPassword_() is the single lookup used
 * everywhere: it matches a submitted password against active rows and
 * returns that row's identity, throwing a loud config error if two active
 * rows share a password (an ambiguous-identity bug, not just sloppy setup).
 * ?action=whoAmI (GET, password required) lets any admin page resolve "who
 * just logged in" (their own Name/Role/UPI VPA/WhatsApp) once at connect
 * time. ?action=admins (GET, password required, Super Admin role only)
 * returns the full roster (minus Password) — used by the Super Admin
 * assignment page (orderAssignment.html) to populate its "assign to"/filter
 * controls; no other page needs the full roster since identity now comes
 * from each admin's own password, not a self-picked dropdown.
 *
 * PER-HUB STOCK (added 2026-09-20, promoted to prod 2026-09-22 — see
 * PER_HUB_INVENTORY_PLAN.md). The single "Stock" column is replaced by one
 * "Stock: <Admin ID>" column per active hub-admin (Role=Admin or Super
 * Admin alike — Hub Central is a real hub too). rowToObject/
 * handlePublicCatalog read every hub's column instead of the old flat Stock
 * cell — a blank cell means "not sold at this hub at all," 0 means "sold
 * there, currently out of stock." ?action=hubs (GET, password required, any
 * active admin) returns the roster products.html/orderAssignment.html need
 * to build per-hub stock columns/dropdowns — narrower than ?action=admins
 * (no WhatsApp/UPI exposure). An admin may only edit their own hub's stock
 * via handleAdd/handleUpdate (Super Admin may edit any) — products.html
 * also disables these inputs client-side, but the real guard is here.
 * Per-hub invoice legal identity (added 2026-09-25, promoted to prod
 * same day). "Hub Name"/"Company Name"/"Company Address"/"GSTIN"/
 * "Company Email"/"Company Website"/"Company Phone" columns on the Admins
 * tab hold each hub's own printed invoice identity — resolveAdminByPassword_
 * and handleAdmins now return them (so admin.html/invoices.html/
 * orderAssignment.html's already-built resolveHubInfo()/hub-info UI, which
 * were never dev-gated client-side, actually get real data instead of
 * silently falling back to the hardcoded Greenharvest block). Editable via
 * ?action=updateHubInfo (POST, Super-Admin-only, whitelisted to
 * HUB_INFO_FIELDS — see handleUpdateHubInfo_ below). These columns must
 * exist on THIS spreadsheet's Admins tab (add them by hand, same as any
 * other manual column migration in this file) — a missing column just
 * reads as blank, which still falls back to the hardcoded company block.
 */

// INTERNAL_KEY (renamed from ADMIN_KEY, 2026-09-15) — no longer a human
// credential. Used ONLY for server-to-server calls: orders_code.gs's
// decrementStock/moveStock calls and its resolveAdmin cross-script password
// lookup. Human auth (products.html's add/update/delete, and every action on
// orders_code.gs) now goes through a per-admin Password (Admins tab),
// resolved via resolveAdminByPassword_ below — deliberately NOT the same
// secret as this one, so rotating an admin's password never breaks the
// internal orders<->catalog plumbing, and vice versa. Must match
// orders_code.gs's INTERNAL_KEY exactly. This is a DIFFERENT value from
// catalog_code.dev.gs's DEV secret — a prod-configured client can never
// accidentally authenticate against dev, or vice versa.
const INTERNAL_KEY = 'purnavah-internal-2026';
const SHEET_NAME = 'Catalog';
const COUPONS_SHEET_NAME = 'Coupons';
const ADMINS_SHEET_NAME = 'Admins';

// Product ID is first so it reads naturally as the row's identity column;
// it's auto-generated and never editable from products.html.
const HEADERS = [
  'Product ID', 'Product Name', 'Category', 'Display Name', 'Unit', 'Pack Size',
  'MRP', 'HSN/SAC', 'GST%', 'Stock', 'Active', 'WA Key', 'Notes', 'Weight (kg)',
  'Contents', // free text, e.g. "Turmeric 50g, Red Chilli 50g, Coriander 50g, Garam Masala 50g" — shown to shoppers on index.html for bundle/multi-item products, blank for everything else
  'Max Order Qty (kg)' // blank/0 = no limit; see header comment "MAX ORDER QTY (KG)" above
];

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'list') return handleList(e);
    if (action === 'catalog') return handlePublicCatalog(e);
    if (action === 'coupon') return handleCouponValidate(e);
    if (action === 'whoAmI') return handleWhoAmI(e);
    if (action === 'admins') return handleAdmins(e);
    if (action === 'hubs') return handleHubs(e);
    return jsonOut({ status: 'error', message: 'Unknown action' });
  } catch (err) {
    return jsonOut({ status: 'error', message: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // Server-to-server actions — gated by INTERNAL_KEY, never a human password.
    if (body.action === 'decrementStock') {
      if (body.internalKey !== INTERNAL_KEY) return jsonOut({ status: 'error', message: 'Invalid internal key' });
      return decrementStock_(body);
    }
    if (body.action === 'moveStock') {
      if (body.internalKey !== INTERNAL_KEY) return jsonOut({ status: 'error', message: 'Invalid internal key' });
      return moveStock_(body);
    }
    if (body.action === 'resolveAdmin') {
      if (body.internalKey !== INTERNAL_KEY) return jsonOut({ status: 'error', message: 'Invalid internal key' });
      return handleResolveAdmin_(body);
    }

    // Every other action here is products.html's catalog CRUD — equal access
    // for any active admin regardless of role (§13 point 3), so this only
    // needs to confirm the password belongs to SOME active admin.
    const admin = resolveAdminByPassword_(body.password);
    if (!admin) return jsonOut({ status: 'error', message: 'Invalid password' });

    if (body.action === 'add') return handleAdd(body, admin);
    if (body.action === 'update') return handleUpdate(body, admin);
    if (body.action === 'delete') return handleDelete(body);
    if (body.action === 'updateHubInfo') return handleUpdateHubInfo_(body, admin);
    return jsonOut({ status: 'error', message: 'Unknown action' });
  } catch (err) {
    return jsonOut({ status: 'error', message: err.message });
  }
}

// No I/O/0/1 — avoids characters that look alike when read off a printed
// invoice or typed in by hand.
function generateProductId_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'PRD-';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found — create a tab with that exact name first');
  return sheet;
}

function getColumnIndex(header) {
  const colIdx = {};
  header.forEach((h, i) => colIdx[h.toString().trim()] = i);
  return colIdx;
}

// Per-hub stock — the Catalog sheet's column name for a given hub-admin's
// stock, and the roster of who has one.
function stockColKey_(adminId) { return 'Stock: ' + adminId; }

// Hub Name is a display label from a later, separate feature (per-hub
// invoice identity) not part of this promotion — falls back to the admin's
// personal Name, which is always present.
function hubDisplayName_(h) { return h.hubName || h.name; }

// Reads the Admins tab once and returns every active hub-admin row — Role
// "Admin" and "Super Admin" alike (Hub Central is a real hub too). Shared by
// rowToObject/handlePublicCatalog/handleHubs — the "who has a
// Stock: <id> column" roster.
function getActiveHubAdmins_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADMINS_SHEET_NAME);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const colIdx = getColumnIndex(values[0]);
  const result = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '' || c === null)) continue;
    const active = (row[colIdx['Active']] || 'N').toString().trim().toUpperCase() === 'Y';
    if (!active) continue;
    const role = (row[colIdx['Role']] || '').toString().trim();
    if (role !== 'Admin' && role !== 'Super Admin') continue;
    const adminId = (row[colIdx['Admin ID']] || '').toString().trim();
    if (!adminId) continue;
    result.push({
      adminId: adminId,
      name: (row[colIdx['Name']] || '').toString().trim(),
      hubName: colIdx['Hub Name'] !== undefined ? (row[colIdx['Hub Name']] || '').toString().trim() : ''
    });
  }
  return result;
}

function handleList(e) {
  if (!resolveAdminByPassword_(e.parameter.password)) return jsonOut({ status: 'error', message: 'Invalid password' });
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return jsonOut({ status: 'ok', data: [] });

  const colIdx = getColumnIndex(values[0]);
  const hubAdmins = getActiveHubAdmins_();
  const data = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '' || c === null)) continue; // skip blank rows
    data.push(rowToObject(row, colIdx, r + 1, hubAdmins));
  }
  return jsonOut({ status: 'ok', data });
}

/**
 * ?action=hubs (GET, password required, any active admin — not
 * Super-Admin-only, unlike ?action=admins) — the roster products.html needs
 * to build its per-hub stock columns/dropdown and orderAssignment.html needs
 * for its filter/assign controls. Deliberately narrower than handleAdmins —
 * no WhatsApp/UPI exposure, since every admin (not just Super Admin) can
 * call this.
 */
function handleHubs(e) {
  const admin = resolveAdminByPassword_(e.parameter.password);
  if (!admin) return jsonOut({ status: 'error', message: 'Invalid password' });
  const data = getActiveHubAdmins_().map(h => ({ adminId: h.adminId, name: hubDisplayName_(h) }));
  return jsonOut({ status: 'ok', data });
}

/**
 * Public, unauthenticated endpoint for the customer-facing order form
 * (index.html). No admin key required — deliberately returns only the
 * fields a shopper needs (never the exact Stock count, HSN, or Notes), and
 * only rows that are Active = Y (Active = N means discontinued/hidden
 * entirely — those are still excluded). Out-of-stock rows are included too,
 * with `inStock: false`, so index.html can show them disabled with an "Out
 * of stock" label instead of just disappearing. GST% is included (needed
 * for index.html's sectioned order summary) — unlike the other withheld
 * fields it's just a public tax rate, not sensitive. weightKg and
 * maxOrderKg are also included — neither is sensitive, and index.html needs
 * both client-side to enforce the per-product order cap (see "MAX ORDER QTY
 * (KG)" in the header comment above). inStock is now the SUM across every
 * active hub's "Stock: <id>" column, not one flat cell.
 */
function handlePublicCatalog(e) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return jsonOut({ status: 'ok', data: [] });

  const colIdx = getColumnIndex(values[0]);
  // Sum only ACTIVE hub-admins' Stock: <id> columns — a deactivated/removed
  // admin's leftover column must not keep counting toward "in stock" here.
  const hubAdmins = getActiveHubAdmins_();
  const data = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '' || c === null)) continue; // skip blank rows

    const active = (row[colIdx['Active']] || 'N').toString().trim().toUpperCase();
    if (active !== 'Y') continue;
    const totalStock = hubAdmins.reduce((sum, h) => {
      const col = colIdx[stockColKey_(h.adminId)];
      const cell = col === undefined ? '' : row[col];
      return sum + ((cell === '' || cell === null) ? 0 : (Number(cell) || 0));
    }, 0);

    const displayName = row[colIdx['Display Name']] || row[colIdx['Product Name']] || '';
    const packSize = row[colIdx['Pack Size']] || '';
    data.push({
      productId: row[colIdx['Product ID']] || '',
      productName: row[colIdx['Product Name']] || '',
      category: row[colIdx['Category']] || '',
      displayName: displayName,
      unit: row[colIdx['Unit']] || '',
      packSize: packSize,
      mrp: Number(row[colIdx['MRP']]) || 0,
      gstPct: Number(row[colIdx['GST%']]) || 0, // needed by index.html's sectioned order summary (Items -> GST -> Grand Total) — a tax rate isn't sensitive, safe to expose publicly unlike HSN/stock/cost fields
      waKey: row[colIdx['WA Key']] || computeWaKey(displayName, packSize),
      inStock: totalStock > 0, // boolean only, summed across every active hub — the exact per-hub counts stay admin-only
      contents: row[colIdx['Contents']] || '', // e.g. what's inside a spice-sachet bundle — blank for most products
      weightKg: Number(row[colIdx['Weight (kg)']]) || parseWeightFromPackSize_(packSize), // same fallback as rowToObject — lets index.html convert the kg-based order cap into a packet count
      maxOrderKg: Number(row[colIdx['Max Order Qty (kg)']]) || 0 // 0 = no limit
    });
  }
  return jsonOut({ status: 'ok', data });
}

/**
 * Public, unauthenticated coupon lookup for index.html's "Apply coupon"
 * box. Looks up a single code (case-insensitive) in the "Coupons" tab and
 * returns only whether it's valid and its discount value — never the full
 * coupon list, so this endpoint can't be scraped to enumerate all codes.
 */
function handleCouponValidate(e) {
  const code = (e.parameter.code || '').toString().trim().toUpperCase();
  if (!code) return jsonOut({ status: 'ok', valid: false, message: 'Enter a coupon code' });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COUPONS_SHEET_NAME);
  if (!sheet) return jsonOut({ status: 'ok', valid: false, message: 'Invalid coupon code' });

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonOut({ status: 'ok', valid: false, message: 'Invalid coupon code' });
  const colIdx = getColumnIndex(values[0]);

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const rowCode = (row[colIdx['Coupon Code']] || '').toString().trim().toUpperCase();
    if (rowCode !== code) continue;
    const active = (row[colIdx['Active']] || 'N').toString().trim().toUpperCase();
    if (active !== 'Y') return jsonOut({ status: 'ok', valid: false, message: 'This coupon is no longer active' });
    const value = Number(row[colIdx['Value']]) || 0;
    return jsonOut({ status: 'ok', valid: true, code: rowCode, value: value });
  }
  return jsonOut({ status: 'ok', valid: false, message: 'Invalid coupon code' });
}

/**
 * Password-gated AND Super-Admin-role-gated — returns every row in the
 * "Admins" tab (including inactive ones, so a client can still show a
 * deactivated admin's name against historical "Assigned To" data instead of
 * just an unresolved id), MINUS the Password column — this is the one
 * endpoint that returns other admins' info, so it must never leak their
 * passwords. Used only by the Super Admin assignment page (roster for its
 * "assign to"/filter controls); no other page needs the full roster since
 * identity comes from each admin's own password (see handleWhoAmI), not a
 * self-picked dropdown. Returns an empty list (not an error) if the tab
 * doesn't exist yet, so this endpoint can be built/tested against before
 * the tab is manually created.
 */
function handleAdmins(e) {
  const admin = resolveAdminByPassword_(e.parameter.password);
  if (!admin) return jsonOut({ status: 'error', message: 'Invalid password' });
  if (admin.role !== 'Super Admin') return jsonOut({ status: 'error', message: 'Super Admin only' });

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADMINS_SHEET_NAME);
  if (!sheet) return jsonOut({ status: 'ok', data: [] });

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonOut({ status: 'ok', data: [] });
  const colIdx = getColumnIndex(values[0]);

  const data = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '' || c === null)) continue;
    data.push({
      adminId: (row[colIdx['Admin ID']] || '').toString().trim(),
      name: (row[colIdx['Name']] || '').toString().trim(),
      role: (row[colIdx['Role']] || '').toString().trim(),
      whatsapp: (row[colIdx['WhatsApp Number']] || '').toString().trim(),
      upiVpa: (row[colIdx['UPI VPA']] || '').toString().trim(),
      active: (row[colIdx['Active']] || 'N').toString().trim().toUpperCase() === 'Y',
      hubName: (row[colIdx['Hub Name']] || '').toString().trim(),
      companyName: (row[colIdx['Company Name']] || '').toString().trim(),
      companyAddress: (row[colIdx['Company Address']] || '').toString().trim(),
      gstin: (row[colIdx['GSTIN']] || '').toString().trim(),
      companyEmail: (row[colIdx['Company Email']] || '').toString().trim(),
      companyWebsite: (row[colIdx['Company Website']] || '').toString().trim(),
      companyPhone: (row[colIdx['Company Phone']] || '').toString().trim()
      // Password deliberately omitted — see function comment above.
    });
  }
  return jsonOut({ status: 'ok', data });
}

// Columns ?action=updateHubInfo is allowed to touch — never Password/Role/
// Active/Admin ID/Name/WhatsApp Number/UPI VPA, which have their own,
// separate management path. See handleUpdateHubInfo_ below.
const HUB_INFO_FIELDS = ['Hub Name', 'Company Name', 'Company Address', 'GSTIN', 'Company Email', 'Company Website', 'Company Phone'];

/**
 * updateHubInfo action (POST, password required, Super-Admin-only) — lets
 * orderAssignment.html's "Manage Hub Info" section edit a hub's display
 * name and printed invoice identity. Whitelisted to HUB_INFO_FIELDS only.
 * See PER_HUB_INVENTORY_PLAN.md.
 */
function handleUpdateHubInfo_(body, admin) {
  if (admin.role !== 'Super Admin') return jsonOut({ status: 'error', message: 'Super Admin only' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADMINS_SHEET_NAME);
    if (!sheet) return jsonOut({ status: 'error', message: 'Admins tab not found' });
    const values = sheet.getDataRange().getValues();
    const colIdx = getColumnIndex(values[0]);
    const adminIdColIdx = colIdx['Admin ID'];
    const targetId = (body.adminId || '').toString().trim();
    if (!targetId) return jsonOut({ status: 'error', message: 'adminId is required' });

    let rowIndex = -1;
    for (let r = 1; r < values.length; r++) {
      if ((values[r][adminIdColIdx] || '').toString().trim() === targetId) { rowIndex = r + 1; break; }
    }
    if (rowIndex === -1) return jsonOut({ status: 'error', message: 'No admin row found for id ' + targetId });

    const fields = body.fields || {};
    Object.keys(fields).forEach(key => {
      if (HUB_INFO_FIELDS.indexOf(key) === -1) return; // ignore anything outside the whitelist
      if (colIdx[key] === undefined) return; // column not added to the sheet yet
      sheet.getRange(rowIndex, colIdx[key] + 1).setValue(fields[key]);
    });
    return jsonOut({ status: 'ok' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * ?action=whoAmI (GET, password required, any active admin) — lets a page
 * resolve "who just logged in" once at connect time: their own Name/Role/
 * WhatsApp Number/UPI VPA. This is the one admin-facing endpoint that
 * doesn't require Super Admin, since it only ever returns the CALLER's own
 * row (matched by the password they submitted), never anyone else's.
 */
function handleWhoAmI(e) {
  const admin = resolveAdminByPassword_(e.parameter.password);
  if (!admin) return jsonOut({ status: 'error', message: 'Invalid password' });
  return jsonOut({ status: 'ok', admin: admin });
}

/**
 * Internal (INTERNAL_KEY-gated) counterpart to handleWhoAmI — same
 * underlying lookup, called by orders_code.gs's resolveAdmin_ so that
 * script can authenticate/scope its own requests without duplicating the
 * Admins-tab lookup logic in a second spreadsheet's script.
 */
function handleResolveAdmin_(body) {
  const admin = resolveAdminByPassword_(body.password);
  if (!admin) return jsonOut({ status: 'error', message: 'Invalid password' });
  return jsonOut({ status: 'ok', admin: admin });
}

/**
 * Single source of truth for turning a submitted password into an admin's
 * identity. Matches against ACTIVE rows only (a deactivated admin's old
 * password stops working immediately). Throws (not returns null) if two
 * active rows share a password — resolving to "whichever matched first"
 * would silently let one admin's password work as another's, a real
 * identity-collision bug, not just a sloppy setup mistake (confirmed
 * 2026-09-15, see MULTI_ADMIN_WORKFLOW_PLAN.md §13 point 9). Returns null
 * (not an error) for "no match" — an empty/wrong password is the expected,
 * non-exceptional case; a duplicate-password config error is not.
 */
function resolveAdminByPassword_(password) {
  password = (password || '').toString();
  if (!password) return null;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADMINS_SHEET_NAME);
  if (!sheet) return null;

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const colIdx = getColumnIndex(values[0]);
  if (colIdx['Password'] === undefined) return null;

  let match = null;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '' || c === null)) continue;
    const active = (row[colIdx['Active']] || 'N').toString().trim().toUpperCase() === 'Y';
    if (!active) continue;
    const rowPassword = (row[colIdx['Password']] || '').toString();
    if (!rowPassword || rowPassword !== password) continue;

    if (match) {
      throw new Error('Configuration error: more than one active admin shares this password — ask Super Admin to fix the Admins tab.');
    }
    match = {
      adminId: (row[colIdx['Admin ID']] || '').toString().trim(),
      name: (row[colIdx['Name']] || '').toString().trim(),
      role: (row[colIdx['Role']] || '').toString().trim(),
      whatsapp: (row[colIdx['WhatsApp Number']] || '').toString().trim(),
      upiVpa: (row[colIdx['UPI VPA']] || '').toString().trim(),
      hubName: (row[colIdx['Hub Name']] || '').toString().trim(),
      companyName: (row[colIdx['Company Name']] || '').toString().trim(),
      companyAddress: (row[colIdx['Company Address']] || '').toString().trim(),
      gstin: (row[colIdx['GSTIN']] || '').toString().trim(),
      companyEmail: (row[colIdx['Company Email']] || '').toString().trim(),
      companyWebsite: (row[colIdx['Company Website']] || '').toString().trim(),
      companyPhone: (row[colIdx['Company Phone']] || '').toString().trim()
    };
  }
  return match;
}

function rowToObject(row, colIdx, rowIndex, hubAdmins) {
  const displayName = row[colIdx['Display Name']] || row[colIdx['Product Name']] || '';
  const packSize = row[colIdx['Pack Size']] || '';
  // Per-hub stock — one entry per active hub-admin. Blank cell -> stock:
  // null ("not sold at this hub at all"), distinct from 0 ("sold there,
  // currently out of stock").
  const stockByHub = (hubAdmins || []).map(h => {
    const col = colIdx[stockColKey_(h.adminId)];
    const cell = col === undefined ? '' : row[col];
    const stock = (cell === '' || cell === null) ? null : (Number(cell) || 0);
    return { adminId: h.adminId, name: hubDisplayName_(h), stock: stock };
  });
  const totalStock = stockByHub.reduce((sum, h) => sum + (h.stock || 0), 0);
  return {
    rowIndex: rowIndex,
    productId: (row[colIdx['Product ID']] || '').toString().trim(),
    productName: row[colIdx['Product Name']] || '',
    category: row[colIdx['Category']] || '',
    displayName: displayName,
    unit: row[colIdx['Unit']] || '',
    packSize: packSize,
    mrp: Number(row[colIdx['MRP']]) || 0,
    hsn: (row[colIdx['HSN/SAC']] || '').toString(),
    gstPct: Number(row[colIdx['GST%']]) || 0,
    stockByHub: stockByHub,
    totalStock: totalStock,
    active: (row[colIdx['Active']] || 'N').toString().trim().toUpperCase(),
    // Same fallback as handlePublicCatalog() — a blank "WA Key" cell must
    // resolve to the same key the customer order form computed and used as
    // the item's column name in the Orders sheet, or admin.html's price
    // lookup (which matches on this exact string) silently fails.
    waKey: row[colIdx['WA Key']] || computeWaKey(displayName, packSize),
    notes: row[colIdx['Notes']] || '',
    weightKg: Number(row[colIdx['Weight (kg)']]) || parseWeightFromPackSize_(packSize),
    contents: row[colIdx['Contents']] || '',
    maxOrderKg: Number(row[colIdx['Max Order Qty (kg)']]) || 0
  };
}

function computeWaKey(displayName, packSize) {
  displayName = (displayName || '').toString().trim();
  packSize = (packSize || '').toString().trim();
  return packSize ? (displayName + ' (' + packSize + ')') : displayName;
}

// Fallback for rows with no explicit "Weight (kg)" value — parses common
// Pack Size formats ("500 g", "1 L", "2 kg", "250 ml"). Liquids (L/ml) are
// treated as ~1:1 with kg, a reasonable approximation for oils/ghee.
function parseWeightFromPackSize_(packSize) {
  const s = (packSize || '').toString().trim().toLowerCase();
  const m = s.match(/([\d.]+)\s*(kg|g|l|ml)\b/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (isNaN(num)) return 0;
  switch (m[2]) {
    case 'kg': return num;
    case 'g':  return num / 1000;
    case 'l':  return num;
    case 'ml': return num / 1000;
    default:   return 0;
  }
}

function handleAdd(body, admin) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const fields = body.fields || {};

    // Per-hub stock authorization — an admin may only set their own hub's
    // "Stock: <id>" column on a new product; Super Admin may set any.
    Object.keys(fields).forEach(key => {
      if (key.indexOf('Stock: ') !== 0) return;
      const hubId = key.slice('Stock: '.length);
      if (admin.role !== 'Super Admin' && hubId !== admin.adminId) {
        throw new Error("You can only edit your own hub's stock.");
      }
    });

    const productName = (fields['Product Name'] || '').toString().trim();
    const displayName = (fields['Display Name'] || '').toString().trim();
    if (!productName) throw new Error('Product Name is required');
    if (!displayName) throw new Error('Display Name is required');

    const values = sheet.getDataRange().getValues();
    const colIdx = getColumnIndex(values[0]);

    const dupe = values.slice(1).some(row =>
      (row[colIdx['Product Name']] || '').toString().trim().toLowerCase() === productName.toLowerCase());
    if (dupe) throw new Error('A product named "' + productName + '" already exists');

    const waKey = computeWaKey(displayName, fields['Pack Size']);
    const active = fields['Active'] !== undefined && fields['Active'] !== ''
      ? fields['Active']
      : (Number(fields['Stock']) > 0 ? 'Y' : 'N');

    // Generate a unique Product ID — retry on collision (astronomically unlikely
    // with 32^6 combinations, but cheap to guard against).
    const existingIds = values.slice(1).map(row => (row[colIdx['Product ID']] || '').toString()).filter(Boolean);
    let productId;
    do { productId = generateProductId_(); } while (existingIds.includes(productId));

    // Built from the sheet's actual header row (colIdx), not the fixed
    // HEADERS constant — HEADERS is just the template setupSheet() writes to
    // a brand-new sheet; a live sheet can have columns added later (e.g.
    // "Contents", or a "Stock: <id>" column) in whatever position they were
    // inserted, and this must still land each field in the right column
    // regardless of that order.
    const newRow = new Array(values[0].length).fill('');
    Object.keys(colIdx).forEach(h => {
      if (h === 'Product ID') newRow[colIdx[h]] = productId;
      else if (h === 'WA Key') newRow[colIdx[h]] = waKey;
      else if (h === 'Active') newRow[colIdx[h]] = active;
      else if (fields[h] !== undefined) newRow[colIdx[h]] = fields[h];
    });

    sheet.appendRow(newRow);
    const rowIndex = sheet.getLastRow();
    return jsonOut({ status: 'ok', rowIndex: rowIndex, waKey: waKey, productId: productId });
  } finally {
    lock.releaseLock();
  }
}

// Resolves a Product ID to its current sheet row number — the canonical
// lookup for every catalog CRUD op that targets an existing row (update,
// delete, decrementStock_), so a row shifting position (another admin's
// add/delete since the client last loaded) never causes the wrong row to
// be touched. Returns -1 if not found.
function findRowByProductId_(values, colIdx, productId) {
  const pidColIdx = colIdx['Product ID'];
  if (pidColIdx === undefined || !productId) return -1;
  for (let r = 1; r < values.length; r++) {
    if ((values[r][pidColIdx] || '').toString().trim() === productId) return r + 1;
  }
  return -1;
}

function handleUpdate(body, admin) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const values = sheet.getDataRange().getValues();
    const colIdx = getColumnIndex(values[0]);

    const productId = (body.productId || '').toString().trim();
    if (!productId) throw new Error('productId is required');
    const rowIndex = findRowByProductId_(values, colIdx, productId);
    if (rowIndex === -1) throw new Error('Product not found for id ' + productId + ' — it may have been deleted, or the catalog changed since you loaded this page. Refresh and try again.');

    const currentRow = values[rowIndex - 1];
    const fields = Object.assign({}, body.fields || {});

    // Per-hub stock authorization: an admin may only edit their own hub's
    // "Stock: <id>" column; Super Admin may edit any. products.html also
    // disables these inputs client-side, but this is the real guard.
    Object.keys(fields).forEach(key => {
      if (key.indexOf('Stock: ') !== 0) return;
      const hubId = key.slice('Stock: '.length);
      if (admin.role !== 'Super Admin' && hubId !== admin.adminId) {
        throw new Error("You can only edit your own hub's stock.");
      }
    });

    // Keep WA Key in sync whenever Display Name or Pack Size changes
    if (fields['Display Name'] !== undefined || fields['Pack Size'] !== undefined) {
      const displayName = fields['Display Name'] !== undefined ? fields['Display Name'] : currentRow[colIdx['Display Name']];
      const packSize = fields['Pack Size'] !== undefined ? fields['Pack Size'] : currentRow[colIdx['Pack Size']];
      fields['WA Key'] = computeWaKey(displayName, packSize);
    }

    Object.keys(fields).forEach(key => {
      if (colIdx[key] === undefined) return; // ignore unknown columns
      sheet.getRange(rowIndex, colIdx[key] + 1).setValue(fields[key]);
    });

    return jsonOut({ status: 'ok', waKey: fields['WA Key'] !== undefined ? fields['WA Key'] : undefined });
  } finally {
    lock.releaseLock();
  }
}

function handleDelete(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const values = sheet.getDataRange().getValues();
    const colIdx = getColumnIndex(values[0]);

    const productId = (body.productId || '').toString().trim();
    if (!productId) throw new Error('productId is required');
    const rowIndex = findRowByProductId_(values, colIdx, productId);
    if (rowIndex === -1) throw new Error('Product not found for id ' + productId + ' — it may already be deleted. Refresh and try again.');

    sheet.deleteRow(rowIndex);
    return jsonOut({ status: 'ok' });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once from the Apps Script editor (select it in the function
 * dropdown, click ▶ Run) to create the "Catalog" tab with the correct
 * header row and a Y/N dropdown on the Active column. Safe to re-run —
 * it won't touch an existing "Catalog" tab.
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEET_NAME)) return; // already set up

  const sheet = ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const activeCol = HEADERS.indexOf('Active') + 1;
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Y', 'N'], true).build();
  sheet.getRange(2, activeCol, 998, 1).setDataValidation(rule);
}

/**
 * Run once from the Apps Script editor (▶ Run → setupAdminsSheet) to create
 * the "Admins" tab with the correct header row, a Role dropdown (Super
 * Admin/Admin), and a Y/N dropdown on Active. Safe to re-run — won't touch
 * an existing "Admins" tab. After running, add one row per admin by hand:
 * Admin ID (a stable short key like "superadmin"/"admin-b"/"admin-c" — MUST
 * exactly match the "Stock: <id>" suffix you've already added to the
 * Catalog sheet for that admin's hub) | Name | Role | WhatsApp Number
 * (e.g. 91XXXXXXXXXX) | UPI VPA | Active | Password (a real distinct
 * credential for that admin — Super Admin's password is just another row
 * here too, same column, no separate mechanism). Passwords must be unique
 * across active rows — resolveAdminByPassword_ throws a config error if two
 * active rows collide.
 *
 * IMPORTANT — this is the PROD Admins tab. Use real, distinct passwords for
 * each admin here (do NOT reuse the test passwords from the DEV sheet).
 */
function setupAdminsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(ADMINS_SHEET_NAME)) return; // already set up

  const headers = ['Admin ID', 'Name', 'Role', 'WhatsApp Number', 'UPI VPA', 'Active', 'Password'];
  const sheet = ss.insertSheet(ADMINS_SHEET_NAME);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const roleRule = SpreadsheetApp.newDataValidation().requireValueInList(['Super Admin', 'Admin'], true).build();
  sheet.getRange(2, headers.indexOf('Role') + 1, 998, 1).setDataValidation(roleRule);
  const activeRule = SpreadsheetApp.newDataValidation().requireValueInList(['Y', 'N'], true).build();
  sheet.getRange(2, headers.indexOf('Active') + 1, 998, 1).setDataValidation(activeRule);
}

/**
 * ONE-TIME MIGRATION for a Catalog sheet that predates the Product ID column.
 * Before running this: in the Sheet UI, right-click column A's header →
 * "Insert 1 column left" → type "Product ID" in the new A1. That shifts all
 * existing data right by one column so it lines up with the new HEADERS
 * order — this function does NOT insert the column itself, only fills in
 * blank IDs for rows that already have one missing.
 * Run once from the Apps Script editor (▶ Run → backfillProductIds). Safe
 * to re-run — skips rows that already have an ID.
 */
function backfillProductIds() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const colIdx = getColumnIndex(values[0]);
  const pidColIdx = colIdx['Product ID'];
  if (pidColIdx === undefined) {
    Logger.log('ERROR: "Product ID" column not found in the header row. Add it as column A first, then re-run.');
    return;
  }
  const existing = values.slice(1).map(r => (r[pidColIdx] || '').toString()).filter(Boolean);
  let count = 0;
  for (let r = 1; r < values.length; r++) {
    if (values[r].every(c => c === '' || c === null)) continue; // skip blank rows
    if (values[r][pidColIdx]) continue; // already has an ID
    let newId;
    do { newId = generateProductId_(); } while (existing.includes(newId));
    existing.push(newId);
    sheet.getRange(r + 1, pidColIdx + 1).setValue(newId);
    count++;
  }
  Logger.log('Backfilled ' + count + ' Product IDs.');
}

/**
 * ONE-TIME MIGRATION for a Catalog sheet that predates the Weight (kg)
 * column. Before running this: in the Sheet UI, add a new column named
 * "Weight (kg)" at the END of the sheet (lowest-risk — doesn't shift any
 * existing data). This function does NOT insert the column itself, only
 * fills in blank weights by parsing each row's Pack Size (e.g. "500 g" ->
 * 0.5, "1 L" -> 1). Run once from the Apps Script editor. Safe to re-run —
 * skips rows that already have a non-zero weight.
 */
function backfillCatalogWeights_() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const colIdx = getColumnIndex(values[0]);
  const weightColIdx = colIdx['Weight (kg)'];
  if (weightColIdx === undefined) {
    Logger.log('ERROR: "Weight (kg)" column not found in the header row. Add it first, then re-run.');
    return;
  }
  let count = 0;
  for (let r = 1; r < values.length; r++) {
    if (values[r].every(c => c === '' || c === null)) continue;
    if (Number(values[r][weightColIdx]) > 0) continue; // already has a weight
    const weight = parseWeightFromPackSize_(values[r][colIdx['Pack Size']]);
    if (weight > 0) {
      sheet.getRange(r + 1, weightColIdx + 1).setValue(weight);
      count++;
    }
  }
  Logger.log('Backfilled ' + count + ' catalog weights from Pack Size.');
}

/**
 * Select THIS from the Apps Script editor's "Select function to run"
 * dropdown to run backfillCatalogWeights_() — the editor hides any function
 * whose name ends in "_" from that dropdown, so the real function isn't
 * directly selectable there.
 */
function runBackfillCatalogWeights() { backfillCatalogWeights_(); }

/**
 * decrementStock action — called by orders_code.gs's confirmOrder_ when an
 * admin confirms an order, so the assigned hub's stock reflects what's
 * actually been committed. Server-to-server call, gated by INTERNAL_KEY
 * (checked by doPost's router before this is called) rather than
 * re-checking here.
 */
function decrementStock_(body) {
  // body.items = [ { productId: 'PRD-A3X9K2', qty: 2 }, ... ]
  // body.hubId = the Admin ID whose Stock: <hubId> column this order draws down.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const values = sheet.getDataRange().getValues();
    const colIdx = getColumnIndex(values[0]);
    const hubId = (body.hubId || '').toString().trim();
    if (!hubId) return jsonOut({ status: 'error', message: 'hubId is required' });
    const stockCol = colIdx[stockColKey_(hubId)];
    const results = [];

    (body.items || []).forEach(({ productId, qty }) => {
      const rowIndex = findRowByProductId_(values, colIdx, productId);
      if (rowIndex === -1) {
        // Almost always a stale client-side catalog cache — the admin page
        // built this productId from a catalog snapshot loaded earlier in
        // the session, and the live sheet's row for it has since been
        // deleted, or the id itself changed (e.g. row deleted and
        // re-added). Reconnect/refresh the catalog and retry.
        results.push({ productId, error: 'Product not found — catalog may have changed since this page loaded; refresh and retry' });
        return;
      }
      const cell = stockCol === undefined ? '' : values[rowIndex - 1][stockCol];
      if (stockCol === undefined || cell === '' || cell === null) {
        // Column missing, or this product's cell in it is blank — either
        // way this product isn't provisioned at this hub. Non-fatal, same
        // as a not-found product above.
        results.push({ productId, error: 'Not stocked at hub "' + hubId + '" — no stock to decrement' });
        return;
      }
      const currentStock = Number(cell) || 0;
      const newStock = currentStock - qty;
      sheet.getRange(rowIndex, stockCol + 1).setValue(newStock);
      results.push({ productId, oldStock: currentStock, newStock, warning: newStock < 0 ? 'Stock went negative' : null });
    });
    return jsonOut({ status: 'ok', results });
  } finally {
    lock.releaseLock();
  }
}

/**
 * moveStock action — called by orders_code.gs when a confirmed order is
 * reassigned to a different hub: rolls back the old hub's stock, deducts the
 * new hub's. Server-to-server call, gated by INTERNAL_KEY (checked by
 * doPost's router before this is called).
 */
function moveStock_(body) {
  // body.items = [ { productId, qty }, ... ], body.fromHubId, body.toHubId
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet();
    const values = sheet.getDataRange().getValues();
    const colIdx = getColumnIndex(values[0]);
    const fromHubId = (body.fromHubId || '').toString().trim();
    const toHubId = (body.toHubId || '').toString().trim();
    if (!toHubId) return jsonOut({ status: 'error', message: 'toHubId is required' });
    // A blank/missing fromHubId (e.g. reassigning a legacy blank-assigned
    // order) just means "nothing to roll back" — not an error.
    const fromCol = fromHubId ? colIdx[stockColKey_(fromHubId)] : undefined;
    const toCol = colIdx[stockColKey_(toHubId)];
    const results = [];

    (body.items || []).forEach(({ productId, qty }) => {
      const rowIndex = findRowByProductId_(values, colIdx, productId);
      if (rowIndex === -1) {
        results.push({ productId, error: 'Product not found — catalog may have changed since this order was confirmed' });
        return;
      }
      const row = values[rowIndex - 1];

      if (fromCol !== undefined) {
        const fromCell = row[fromCol];
        if (fromCell !== '' && fromCell !== null) {
          sheet.getRange(rowIndex, fromCol + 1).setValue((Number(fromCell) || 0) + qty);
        }
      }

      const toCell = toCol === undefined ? '' : row[toCol];
      if (toCol === undefined || toCell === '' || toCell === null) {
        // Same non-fatal philosophy as decrementStock_ — this product isn't
        // provisioned at the new hub.
        results.push({ productId, error: 'Not stocked at hub "' + toHubId + '" — no stock to decrement' });
        return;
      }
      const currentStock = Number(toCell) || 0;
      const newStock = currentStock - qty;
      sheet.getRange(rowIndex, toCol + 1).setValue(newStock);
      results.push({ productId, oldStock: currentStock, newStock, warning: newStock < 0 ? 'Stock went negative' : null });
    });
    return jsonOut({ status: 'ok', results });
  } finally {
    lock.releaseLock();
  }
}
