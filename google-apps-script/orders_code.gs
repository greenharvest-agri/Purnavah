/**
 * PURNAVAH — Google Sheets Order Webhook + Admin API
 * =====================================================
 * SINGLE FILE — paste this as your ONLY .gs file.
 *
 * WHAT THIS DOES:
 *  - doPost_logOrder() → your original webhook logic, now renamed.
 *    Receives new orders from index.html and appends rows to the sheet.
 *  - doPost() → smart router. If the POST looks like a new order
 *    (has "items" field, no "action" field) it calls doPost_logOrder.
 *    If it has an "action" field, it handles admin requests.
 *  - doGet() → admin reads: list all orders with status/discount/invoice fields.
 *  - updateOrder() / bulkUpdate → admin writes: update status, discount,
 *    invoice number, item quantities on any row.
 *
 * MULTI-ADMIN WORKFLOW (promoted to prod 2026-09-22, §13). Real per-admin
 * passwords replace the old shared ADMIN_KEY for every human-facing action.
 * Every admin action now resolves the submitted password to an identity via
 * resolveAdmin_() — a cross-script call to catalog_code.gs's Admins tab
 * (this script has no direct access to that spreadsheet). "list" is
 * self-scoped to the caller's own assigned orders (Super Admin included —
 * they use admin.html for their own bucket same as anyone else); "listAll"
 * (Super-Admin-only) returns everything, used by orderAssignment.html.
 * assertOrderAccess_() blocks every write (update/confirm/payment/add item/
 * credit note) unless the order is assigned to the caller (Super Admin
 * unrestricted). Reassignment itself (writing "Assigned To") is additionally
 * Super-Admin-only. ADMIN_COLS gained "Assigned To"/"Confirming Admin UPI" —
 * auto-migrated onto the sheet by ensureAdminColumns_ like any other column,
 * no manual sheet edit needed for these two.
 *
 * PER-HUB STOCK (promoted to prod 2026-09-22 — see PER_HUB_INVENTORY_PLAN.md).
 * confirmOrder_ now requires the order to already be assigned to a hub (blank
 * "Assigned To" blocks confirm outright — there's no hub to decrement stock
 * from) and passes that hub's Admin ID as decrementStock's hubId. Reassigning
 * an already-confirmed order (updateOrder, "Assigned To" change) moves stock
 * from the old hub's column to the new one via the Catalog script's
 * moveStock action, and re-snapshots Confirming Admin UPI so the invoice's
 * live-resolved identity and its frozen UPI payment target never diverge.
 *
 * V2 ADDITIONS (order/invoice lifecycle upgrade):
 *  - ADMIN_COLS extended with shipping, payment and invoice-lifecycle columns.
 *    Existing sheets are migrated automatically — ensureAdminColumns_() appends
 *    any missing column the next time getAllOrders/updateOrder/etc. run.
 *  - getNextInvoiceNo_() — sequential invoice numbers from a "Settings" sheet
 *    tab (auto-created), so admin.html no longer hardcodes a JS counter.
 *  - recordPayment_() — records a payment against an order and derives
 *    Balance Due / Invoice Status / Status from it.
 *  - addItemToOrder_() — adds a line item to an existing order row, creating
 *    a new product column (inserted just before the admin columns) if the
 *    item has never been ordered before.
 *  - "Update order" (admin.html's updateOrderVersion()) — edits an order's
 *    row in place via the generic "update" action (see updateOrder()) below.
 *    Previously appended a full copy as a new version row and marked the
 *    old one "Revised"; removed 2026-07-12 per user request — the sheet now
 *    only ever holds one row per order. deleteRevisedOrderRows_() is a
 *    one-time cleanup for any row already marked Revised from before this
 *    change. GAPL Order ID is unaffected either way (assigned once, on
 *    confirm, never touched by an order edit).
 *  - confirmOrder_() — the "Confirm order" action. Sets Status to
 *    "Confirmed", assigns a business-facing GAPL Order ID (idempotent —
 *    skipped if already set), stores Total Qty/Est. Weight, stores a
 *    WA-Key→Product-ID map in "Product IDs JSON", and calls the Catalog
 *    script's decrementStock action so the assigned hub's Stock reflects
 *    what's actually been committed. Stock decrement only runs once per
 *    order — guarded by the "Stock Decremented" flag rather than Status, so
 *    a prior failed attempt can still be retried by confirming again.
 *    recordPayment_ no longer writes order Status — under this model,
 *    payment is a sub-state under "Invoiced" tracked in admin.html, not a
 *    fulfillment stage.
 *  - createCreditNote_() — the Credit Note feature (invoices.html, 2026-07-09).
 *    Appends a row to an auto-created "Credit Notes" sheet tab and reduces
 *    the source order's Final Total/Balance Due. GST math is computed
 *    client-side (invoices.html already has Catalog data loaded); this
 *    script just persists it. getAllCreditNotes_()/listCreditNotes is the
 *    read side.
 *  - NOTE: this script intentionally does NOT expose a "catalog" action.
 *    The product catalog lives in a separate Google Sheet + Apps Script
 *    deployment (see google-apps-script/catalog_code.gs, used by
 *    products.html and index.html). admin.html's "Add item" panel reads
 *    from that same deployment's public ?action=catalog endpoint instead
 *    of duplicating catalog data into this sheet.
 *  - INVOICES SHEET (2026-07-12): invoice/payment data (Invoice No/Date/
 *    Status/Sent Date, Amount Paid, Balance Due, Payment Mode/Ref/Date) was
 *    split out of this sheet's ADMIN_COLS into a separate auto-created
 *    "Invoices" sheet, joined back by Order Ref (see INVOICE_HEADERS /
 *    upsertInvoiceRow_ / getInvoiceDataByOrderRef_). getAllOrders() still
 *    merges everything into the same order object shape, so admin.html/
 *    invoices.html needed no client-side changes. Order Status changes
 *    (updateOrder/confirmOrder_) live-sync onto the matching Invoices row.
 *    See ORDER_INVOICE_LIFECYCLE.md's "v5"/"v6" sections for the full
 *    write-up and the one-time migration steps for an existing sheet.
 *  - BUGFIX (2026-07-14): product/item columns could display "12/30/1899" /
 *    "31 Dec 1899" for items not part of that order, instead of blank/0.
 *    Root cause: clearContent() (migrateSheetColumns_) and
 *    insertColumnBefore() (addItemToOrder_) both leave a cell's number
 *    FORMAT untouched even when its header/value changes — so a product
 *    column could land on a physical column index that used to be a real
 *    Date-typed column (e.g. the old "Invoice Date"/"Payment Date" columns
 *    dropped to the Invoices sheet above) and inherit its Date format,
 *    rendering plain 0/1 quantities as that date. Values were never
 *    actually corrupted, only the display format was wrong. Both functions
 *    now force plain-integer format on product columns going forward; run
 *    fixProductColumnNumberFormat_() once (via
 *    runFixProductColumnNumberFormat()) to clean up columns already
 *    affected on a live sheet.
 *
 * HOW TO DEPLOY:
 *  1. Open your Google Sheet → Extensions → Apps Script
 *  2. Delete ALL existing code in every .gs file
 *  3. Paste this entire file
 *  4. Save (Ctrl+S)
 *  5. Deploy → Manage Deployments → create a NEW version
 *     (do not edit the existing deployment — create a new one; if a "new
 *     version" of an existing deployment doesn't seem to take effect,
 *     create a brand-new deployment instead — a known Apps Script quirk)
 *  6. Copy the new Web App URL
 *  7. Update SHEETS_WEBHOOK_URL in index.html with the new URL
 *  8. Run testNewOrder() / testAdminList() manually first to confirm it works
 *     (fill in TEST_ADMIN_PASSWORD below with a real Admins-tab password first)
 */

// ─────────────────────────────────────────────
//  CONFIG — edit these to match your setup
// ─────────────────────────────────────────────

const SHEET_NAME = "Orders";   // Must match the tab name at the bottom of your Sheet exactly

// Internal server-to-server secret (renamed from ADMIN_KEY, 2026-09-15) —
// no longer a human credential. Used ONLY for this script's cross-script
// calls to catalog_code.gs (decrementStock, moveStock, resolveAdmin below).
// Every human-facing action on THIS script is now gated by a per-admin
// password, resolved via resolveAdmin_() against the Admins tab (lives in
// the Catalog spreadsheet — this script has no direct access to it, hence
// the cross-script "resolveAdmin" call using this same internal secret).
// Must match catalog_code.gs's INTERNAL_KEY exactly. This is a DIFFERENT
// value from orders_code.dev.gs's DEV secret — a prod-configured client can
// never accidentally authenticate against dev, or vice versa.
const INTERNAL_KEY = "purnavah-internal-2026";

// Columns that come before product columns (order matters). Status is
// first so it's always visible without scrolling past product columns.
// Order Ref (internal UUID, assigned at creation) is the stable join key
// used by the Invoices sheet (see upsertInvoiceRow_); GAPL Order ID is the
// business-facing id assigned on confirm (see getNextGaplOrderId_).
// Version is vestigial — orders no longer version (each edit updates the
// same row in place), left in place only so existing sheets/rows aren't
// disturbed.
const FIXED_COLS = [
  "Status", "Timestamp", "Order Ref", "GAPL Order ID", "Version",
  "Customer Name", "Phone", "Email", "Pincode", "State", "Address", "Notes",
  "Order Total"
];

// Admin/status columns auto-created at the end of the sheet if missing.
// Product columns always sit between FIXED_COLS and ADMIN_COLS — new items
// (from a fresh order, or from the "Add item" admin panel) are inserted
// immediately before the first of these columns, never after.
const ADMIN_COLS = [
  "Discount %", "Discount Amount", "Final Total",
  "Coupon Code",         // self-applied by the customer on index.html, validated against the Catalog spreadsheet's "Coupons" tab at submit time — set once at order creation, not admin-edited
  "Coupon Discount %",   // the coupon's Value at the time it was applied — admin.html seeds the "Discount %" field with this by default (still overridable) so applying it doesn't require a separate discount pipeline
  "Delivery Charge",     // ₹199 flat fee index.html adds when the item subtotal is below ₹2,890 (free above that) — set once at order creation from index.html's own calculation; NOT folded into GST/Final Total math in admin.html, just logged so the amount actually owed is visible
  "Same Day Delivery Charge", // ₹199 flat fee, set once at order creation when the customer checks index.html's same-day-delivery box (currently hidden behind a client-side flag, not yet launched). 0 means not selected. Same "logged, not folded into GST math" treatment as Delivery Charge — admin.html adds it into the customer-facing Total Payable it shows/quotes, same as the shipping charge, without touching the invoiced Final Total.
  "Free Shipping Override", // "Y"/"N"/blank — admin.html's per-order Yes/No shipping toggle. Blank means "no override, compute live from the current subtotal vs. the ₹2,890 threshold"; Y/N is an explicit admin decision that sticks regardless of subtotal until changed again.
  "Courier", "AWB No", "Shipped Date", "Expected Delivery",
  "Delivered Date", "Admin Notes",
  "Total Qty", "Est. Weight (kg)",
  "Stock Decremented",  // "Y" once confirmOrder_ has successfully decremented catalog stock — lets a failed attempt be retried without double-decrementing a succeeded one
  "Product IDs JSON",   // { "WA Key": "PRD-XXXXXX", ... } — set by confirmOrder_, used for stock decrement
  "Item Discounts JSON", // { "WA Key": discountPct, ... } — the real per-item discount admin.html applies, persisted so invoices.html/credit notes don't have to fall back to proportionally allocating the order-level aggregate (Issue 1/Phase 1)
  "Item Price Overrides JSON", // { "WA Key": price, ... } — per-order price override (e.g. giving one item free) set by admin.html, keyed the same way as Item Discounts JSON; a missing key means "use the catalog MRP"
  "Client Order ID",    // index.html's per-submission id — used by findRecentDuplicateOrder_ to collapse a double-click/double-fetch (Issue 5/Phase 2)
  "Last Updated",       // stamped by touchLastUpdated_() on every admin write (update/confirm/payment/credit note/add item) — admin.html sorts its order list by this, falling back to Timestamp for never-touched rows
  // MULTI-ADMIN WORKFLOW (§13, promoted to prod 2026-09-22). Both written via
  // the existing generic "update"/"confirmOrder" actions, no new action needed.
  "Assigned To",         // an Admin ID from the Catalog spreadsheet's "Admins" tab; blank = unassigned (blocks confirm — see confirmOrder_). Set by orderAssignment.html's "Assign to…" control (Super-Admin-only).
  "Confirming Admin UPI" // snapshotted once at confirmOrder_ time (see confirmOrder_ below) from the then-assigned admin's UPI VPA — not re-looked-up live, so editing an admin's UPI later doesn't retroactively change past invoices/confirmations. Re-snapshotted on a confirmed order's reassignment (see moveConfirmedOrderStock_).
];

// These used to be ADMIN_COLS on the Orders sheet — now they live on the
// separate "Invoices" sheet (see INVOICE_HEADERS/upsertInvoiceRow_ below),
// joined back to an order by Order Ref. Kept here only so
// migrateSheetColumns_() can recognize and drop them from a legacy Orders
// sheet, and so migrateOrdersInvoiceDataToInvoicesSheet_() can find them to
// copy over first.
const LEGACY_INVOICE_COLS = [
  "Invoice No", "Invoice Date", "Invoice Status", "Invoice Sent Date",
  "Amount Paid", "Balance Due", "Payment Mode", "Payment Ref", "Payment Date"
];

// URL of the Catalog Apps Script deployment — needed for stock decrement on
// confirm and for the resolveAdmin cross-script identity lookup. Update this
// if you redeploy the catalog script to a new URL.
const CATALOG_API_URL = "https://script.google.com/macros/s/AKfycbwSLba0EjXjj3WgoXzHoCpt5l0Y9D9aab181YNuEopbDyFtfREFzDWX6WHtEEfDPDHNrQ/exec";

// ─────────────────────────────────────────────
//  Invoices sheet — invoice + payment data, kept separate from the Orders
//  sheet (per-order fulfillment/items/shipping data) and joined back to it
//  by "Order ID" (= the Orders sheet's Order Ref, a stable UUID that
//  doesn't change across "Update order" version rows — so one Invoices row
//  covers every version of an order automatically, no copying needed).
//  "Order Status" here is a live-synced mirror of the Orders sheet's
//  Status column (see upsertInvoiceRow_ callers) — kept only for
//  convenience when browsing/reporting off this sheet alone; the Orders
//  sheet's own Status column is still the source of truth.
// ─────────────────────────────────────────────

const INVOICE_HEADERS = [
  "Order ID", "GAPL Order ID", "Customer Name", "Order Status",
  "Invoice No", "Invoice Date", "Invoice Status", "Invoice Sent Date",
  "Amount Paid", "Balance Due", "Payment Mode", "Payment Ref", "Payment Date"
];

function getOrCreateInvoicesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Invoices");
  if (!sheet) {
    sheet = ss.insertSheet("Invoices");
    sheet.getRange(1, 1, 1, INVOICE_HEADERS.length).setValues([INVOICE_HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findInvoiceRowByOrderId_(sheet, orderId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !orderId) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || ""));
  const idx = ids.indexOf(orderId);
  return idx === -1 ? -1 : idx + 2; // 1-based sheet row number
}

// Creates (if this is the first invoice-related write for this order) or
// updates the Invoices-sheet row for the given Order Ref. A new row is only
// ever auto-created when "Invoice No" is present in `fields` — a pure
// Status-sync call for an order that's never been invoiced is correctly a
// no-op, not a blank orphan row.
function upsertInvoiceRow_(orderRef, fields) {
  if (!orderRef || !fields || Object.keys(fields).length === 0) return;
  const sheet = getOrCreateInvoicesSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  let rowIdx = findInvoiceRowByOrderId_(sheet, orderRef);

  if (rowIdx === -1) {
    if (!fields["Invoice No"]) return;
    const newRowIdx = sheet.getLastRow() + 1;
    sheet.getRange(newRowIdx, 1, 1, headers.length).setValues([new Array(headers.length).fill("")]);
    rowIdx = newRowIdx;
    sheet.getRange(rowIdx, headers.indexOf("Order ID") + 1).setValue(orderRef);

    // One-time convenience lookup, not kept live-synced afterward — these
    // don't change once an order has been invoiced.
    const info = findOrderByRef_(orderRef);
    if (info) {
      if (headers.indexOf("Customer Name") > -1) sheet.getRange(rowIdx, headers.indexOf("Customer Name") + 1).setValue(info.customerName);
      if (headers.indexOf("GAPL Order ID") > -1) sheet.getRange(rowIdx, headers.indexOf("GAPL Order ID") + 1).setValue(info.gaplOrderId);
    }
  }

  Object.keys(fields).forEach(key => {
    const colIdx = headers.indexOf(key);
    if (colIdx > -1) sheet.getRange(rowIdx, colIdx + 1).setValue(fields[key]);
  });
}

// Whether this order has ever been invoiced — replaces the old "check the
// Orders sheet's own Invoice No column" logic now that it lives on Invoices.
function hasInvoice_(orderRef) {
  if (!orderRef) return false;
  const sheet = getOrCreateInvoicesSheet_();
  const rowIdx = findInvoiceRowByOrderId_(sheet, orderRef);
  if (rowIdx === -1) return false;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const invoiceNoIdx = headers.indexOf("Invoice No");
  return invoiceNoIdx > -1 && String(sheet.getRange(rowIdx, invoiceNoIdx + 1).getValue() || "").trim() !== "";
}

// One Invoices row per Order Ref → map, read once per getAllOrders() call
// so every order's invoice/payment fields can be merged in without a
// per-row sheet read.
function getInvoiceDataByOrderRef_() {
  const sheet = getOrCreateInvoicesSheet_();
  const map = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  values.forEach(row => {
    const orderRef = String(row[idx["Order ID"]] || "");
    if (!orderRef) return;
    map[orderRef] = {
      invoiceNo:       String(row[idx["Invoice No"]] || ""),
      invoiceDate:     formatDateField_(row[idx["Invoice Date"]]),
      invoiceStatus:   String(row[idx["Invoice Status"]] || ""),
      invoiceSentDate: formatDateField_(row[idx["Invoice Sent Date"]]),
      amountPaid:      Number(row[idx["Amount Paid"]]) || 0,
      balanceDue:      Number(row[idx["Balance Due"]]) || 0,
      paymentMode:     String(row[idx["Payment Mode"]] || ""),
      paymentRef:      String(row[idx["Payment Ref"]] || ""),
      paymentDate:     formatDateField_(row[idx["Payment Date"]])
    };
  });
  return map;
}

// Small helper for upsertInvoiceRow_'s one-time Customer Name/GAPL Order ID
// lookup. Not used on any hot path — only runs once, when a new Invoices
// row is first created for an order.
function findOrderByRef_(orderRef) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const refIdx = idx["Order Ref"];
  if (refIdx === undefined) return null;
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (let r = 0; r < values.length; r++) {
    if (String(values[r][refIdx] || "") === orderRef) {
      return {
        customerName: idx["Customer Name"] !== undefined ? values[r][idx["Customer Name"]] : "",
        gaplOrderId:  idx["GAPL Order ID"] !== undefined ? values[r][idx["GAPL Order ID"]] : ""
      };
    }
  }
  return null;
}


// ─────────────────────────────────────────────
//  ROUTER — single entry point for all POSTs
// ─────────────────────────────────────────────

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // ── New order from index.html (has "items", no "action") ──
    // The order form sends: { name, phone, pincode, address, notes, total, items:{...} }
    if (!body.action && body.items) {
      return doPost_logOrder(e, body);
    }

    // ── Admin action (has "action" + "password") ──
    const auth = resolveAdmin_(body.password);
    if (!auth.ok) {
      return jsonOut({ status: "error", message: auth.message });
    }
    const admin = auth.admin;

    if (body.action === "update") {
      return jsonOut(updateOrder(body, admin));
    }
    if (body.action === "bulkUpdate") {
      const results = (body.updates || []).map(u => updateOrder(u, admin));
      return jsonOut({ status: "ok", results });
    }
    if (body.action === "getNextInvoiceNo") {
      return jsonOut({ status: "ok", invoiceNo: getNextInvoiceNo_() });
    }
    if (body.action === "recordPayment") {
      return jsonOut(recordPayment_(body, admin));
    }
    if (body.action === "addItemToOrder") {
      return jsonOut(addItemToOrder_(body, admin));
    }
    if (body.action === "confirmOrder") {
      return jsonOut(confirmOrder_(body, admin));
    }
    if (body.action === "createCreditNote") {
      return jsonOut(createCreditNote_(body, admin));
    }

    return jsonOut({ status: "error", message: "Unknown action: " + body.action });

  } catch (err) {
    return jsonOut({ status: "error", message: err.message });
  }
}


// ─────────────────────────────────────────────
//  doGet — admin reads (list all orders)
// ─────────────────────────────────────────────

function doGet(e) {
  try {
    const auth = resolveAdmin_(e.parameter.password);
    if (!auth.ok) {
      return jsonOut({ status: "error", message: auth.message });
    }
    const admin = auth.admin;
    const action = e.parameter.action || "list";

    // "my own orders" — every identity, including Super Admin, gets scoped
    // to their own bucket here (§13 point 2: Super Admin uses admin.html
    // for their own assigned orders same as anyone else; the FULL
    // cross-admin picture lives only behind "listAll", Super-Admin-only,
    // used by orderAssignment.html).
    if (action === "list") {
      const all = getAllOrders();
      const scoped = admin.role === "Super Admin"
        ? all.filter(o => !o.assignedTo || o.assignedTo === admin.adminId)
        : all.filter(o => o.assignedTo === admin.adminId);
      return jsonOut({ status: "ok", data: scoped });
    }
    if (action === "listAll") {
      if (admin.role !== "Super Admin") {
        return jsonOut({ status: "error", message: "Super Admin only" });
      }
      return jsonOut({ status: "ok", data: getAllOrders() });
    }
    if (action === "listCreditNotes") {
      const notes = getAllCreditNotes_();
      if (admin.role === "Super Admin") {
        return jsonOut({ status: "ok", data: notes });
      }
      // Scope to credit notes whose source order is assigned to this admin —
      // cross-referenced via Order ID against the Orders sheet's Assigned To,
      // same "hard per-admin-scoped" rule as everything else (§13).
      const assignedByOrderId = {};
      getAllOrders().forEach(o => { assignedByOrderId[o.orderRef] = o.assignedTo; });
      const scoped = notes.filter(n => assignedByOrderId[n.orderId] === admin.adminId);
      return jsonOut({ status: "ok", data: scoped });
    }
    return jsonOut({ status: "error", message: "Unknown action: " + action });
  } catch (err) {
    return jsonOut({ status: "error", message: err.message });
  }
}

// ─────────────────────────────────────────────
//  resolveAdmin_ — resolves a submitted password into an admin's identity by
//  cross-script call to catalog_code.gs (the Admins tab lives in the
//  Catalog spreadsheet, a separate script this one has no direct sheet
//  access to — same reason decrementStock is a cross-script call). Gated by
//  INTERNAL_KEY on the wire (proves the caller is this legitimate backend),
//  not by the human password itself — the password IS the human's proof of
//  identity, checked against the Admins tab on the other end.
// ─────────────────────────────────────────────

function resolveAdmin_(password) {
  password = (password || "").toString();
  if (!password) return { ok: false, message: "Password is required" };
  try {
    const resp = UrlFetchApp.fetch(CATALOG_API_URL, {
      method: "post",
      contentType: "text/plain;charset=utf-8",
      payload: JSON.stringify({ action: "resolveAdmin", internalKey: INTERNAL_KEY, password: password }),
      muteHttpExceptions: true
    });
    const result = JSON.parse(resp.getContentText());
    if (result.status === "ok" && result.admin) return { ok: true, admin: result.admin };
    return { ok: false, message: result.message || "Invalid password" };
  } catch (err) {
    return { ok: false, message: "Could not verify password: " + err.message };
  }
}

// ─────────────────────────────────────────────
//  assertOrderAccess_ — throws unless `admin` is allowed to write to this
//  row. Super Admin is unrestricted (needed for the assignment page's
//  "assign to" control, which by definition targets orders not yet assigned
//  to them). Every other admin may only touch a row currently assigned to
//  themselves (§13 point 1) — reassignment itself is additionally
//  Super-Admin-only, enforced separately in updateOrder.
// ─────────────────────────────────────────────

function assertOrderAccess_(sheet, headers, rowIndex, admin) {
  if (admin.role === "Super Admin") return;
  const assignedIdx = headers.indexOf("Assigned To");
  const assignedTo = assignedIdx > -1 ? String(sheet.getRange(rowIndex, assignedIdx + 1).getValue() || "").trim() : "";
  if (assignedTo !== admin.adminId) {
    throw new Error("This order is not assigned to you.");
  }
}


// ─────────────────────────────────────────────
//  doPost_logOrder — original webhook logic
//  (renamed from doPost so the router can call it)
// ─────────────────────────────────────────────

function doPost_logOrder(e, parsedBody) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let   ws = ss.getSheetByName(SHEET_NAME);

    // Create the Orders sheet if it doesn't exist yet
    if (!ws) {
      ws = ss.insertSheet(SHEET_NAME);
    }

    // Use the already-parsed body if passed in, otherwise parse again
    const data = parsedBody || JSON.parse(e.postData.contents);

    // ── Build / sync header row ──────────────────────────────
    // Read existing headers so we never wipe existing product columns
    let headers = [];
    if (ws.getLastRow() > 0) {
      headers = ws.getRange(1, 1, 1, ws.getLastColumn())
                  .getValues()[0]
                  .map(h => String(h).trim())
                  .filter(h => h !== "");
    }

    // Ensure all fixed meta columns exist (in order)
    FIXED_COLS.forEach(col => {
      if (!headers.includes(col)) headers.push(col);
    });

    // Add any new product columns from this specific order
    Object.keys(data.items || {}).forEach(prod => {
      if (!headers.includes(prod)) headers.push(prod);
    });

    // Ensure admin/status columns exist at the end
    ADMIN_COLS.forEach(col => {
      if (!headers.includes(col)) headers.push(col);
    });

    // Write headers back if they changed
    const currentHeaders = ws.getLastColumn() > 0
      ? ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0]
      : [];
    const headersChanged =
      headers.length !== currentHeaders.length ||
      headers.some((h, i) => h !== currentHeaders[i]);

    if (headersChanged) {
      ws.getRange(1, 1, 1, headers.length).setValues([headers]);
      // Style header row
      const hRange = ws.getRange(1, 1, 1, headers.length);
      hRange.setBackground("#3A5428");
      hRange.setFontColor("#FFFFFF");
      hRange.setFontWeight("bold");
      // Style admin columns differently so they're visually distinct
      ADMIN_COLS.forEach(col => {
        const idx = headers.indexOf(col);
        if (idx > -1) {
          ws.getRange(1, idx + 1).setBackground("#7a6e58").setFontColor("#f0ede0");
        }
      });
      // A newly-added product column can inherit a stray Date number format
      // left over from whatever column used to occupy that physical
      // position — Sheets then renders a plain 0/1 quantity as "12/30/1899"
      // / "31 Dec 1899" (its date epoch). Force plain-integer format on
      // every product column whenever the header row changes, not just the
      // brand-new one, since a legacy sheet can carry the same stale
      // formatting on columns that already existed. See
      // fixProductColumnNumberFormat_ for the one-time cleanup of a sheet
      // already showing this bug.
      const knownColsForFormat = new Set(FIXED_COLS.concat(ADMIN_COLS));
      const maxDataRows = Math.max(ws.getMaxRows() - 1, 1);
      headers.forEach((col, idx) => {
        if (!knownColsForFormat.has(col)) {
          ws.getRange(2, idx + 1, maxDataRows, 1).setNumberFormat("0");
        }
      });
    }

    // ── Dedup guard (Issue 5) ─────────────────────────────────
    // Collapses an exact repeat of this same submission: either the
    // identical clientOrderId (double-click/double-fetch from index.html)
    // within 10 minutes, or — for older cached clients that don't send one —
    // the same phone + total + item set within 2 minutes. Returns the
    // existing row rather than appending a new one; reported as "ok" (not an
    // error) since from the client's perspective this is a successful,
    // idempotent log, not a failure.
    const dup = findRecentDuplicateOrder_(ws, headers, data);
    if (dup) {
      return jsonOut({ status: "ok", row: dup, deduped: true });
    }

    // ── Build the new data row ───────────────────────────────
    const now = new Date();
    const timestamp = Utilities.formatDate(
      now, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss"
    );

    const row = new Array(headers.length).fill("");
    headers.forEach((col, idx) => {
      switch (col) {
        case "Timestamp":     row[idx] = timestamp;            break;
        case "Order Ref":     row[idx] = Utilities.getUuid();  break;
        case "GAPL Order ID": row[idx] = "";                   break; // assigned by confirmOrder_ on confirm
        case "Version":       row[idx] = 1;                    break;
        case "Customer Name": row[idx] = data.name    || "";   break;
        case "Phone":         row[idx] = data.phone   || "";   break;
        case "Email":         row[idx] = data.email   || "";   break;
        case "Pincode":       row[idx] = data.pincode || "";   break;
        case "State":         row[idx] = data.state   || "";   break;
        case "Address":       row[idx] = data.address || "";   break;
        case "Notes":         row[idx] = data.notes   || "";   break;
        case "Order Total":   row[idx] = data.total   || 0;    break;
        case "Status":        row[idx] = "New";                break; // default status
        case "Product IDs JSON":         row[idx] = "{}";       break; // filled in by confirmOrder_
        case "Item Discounts JSON":      row[idx] = "{}";       break;
        case "Item Price Overrides JSON": row[idx] = "{}";      break;
        case "Stock Decremented": row[idx] = "N";               break;
        case "Client Order ID":   row[idx] = data.clientOrderId || ""; break;
        case "Coupon Code":       row[idx] = data.couponCode  || ""; break;
        case "Coupon Discount %": row[idx] = Number(data.couponValue) || 0; break;
        case "Delivery Charge":   row[idx] = Number(data.deliveryCharge) || 0; break;
        case "Same Day Delivery Charge": row[idx] = Number(data.sameDayDeliveryCharge) || 0; break;
        // Left genuinely blank ("") on entry, not defaulted to 0 — these
        // used to silently fall into the "product column" default below,
        // which wrote a literal 0 instead of blank (harmless for most
        // fields since they're always read back with `|| 0`/`|| ""`, but it
        // broke "Discount %" specifically: a blank cell means "never set",
        // distinct from an admin explicitly setting 0%, and getAllOrders()
        // now relies on that distinction — see Issue 9).
        case "Discount %":
        case "Discount Amount":
        case "Final Total":
        case "Courier":
        case "AWB No":
        case "Shipped Date":
        case "Expected Delivery":
        case "Delivered Date":
        case "Admin Notes":
        case "Free Shipping Override":
          row[idx] = "";
          break;
        default:
          // Product column — look up qty from items{}
          row[idx] = (data.items && data.items[col]) ? Number(data.items[col]) : 0;
      }
    });

    // Append to sheet
    ws.appendRow(row);
    ws.autoResizeColumns(1, headers.length);

    return jsonOut({ status: "ok", row: ws.getLastRow() });

  } catch (err) {
    return jsonOut({ status: "error", message: err.message });
  }
}


// ─────────────────────────────────────────────
//  getAllOrders — returns all rows as JSON
// ─────────────────────────────────────────────

function getAllOrders() {
  const sheet = getSheet_();
  ensureAdminColumns_(sheet);
  ensureIdentityColumns_(sheet);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];

  // Index maps for fast lookup
  const fixedIdx = {};
  FIXED_COLS.forEach(c => { fixedIdx[c] = headers.indexOf(c); });
  const adminIdx = {};
  ADMIN_COLS.forEach(c => { adminIdx[c] = headers.indexOf(c); });
  // Invoice/payment data lives on the separate Invoices sheet now, joined
  // by Order Ref — read once and merge per row below.
  const invoiceByOrderRef = getInvoiceDataByOrderRef_();
  const blankInvoiceData = {
    invoiceNo: "", invoiceDate: "", invoiceStatus: "", invoiceSentDate: "",
    amountPaid: 0, balanceDue: 0, paymentMode: "", paymentRef: "", paymentDate: ""
  };

  // Product columns = any column not in FIXED_COLS or ADMIN_COLS
  const productCols = headers
    .map((h, i) => ({ name: h, index: i }))
    .filter(p => p.name && !FIXED_COLS.includes(p.name) && !ADMIN_COLS.includes(p.name));

  const orders = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    // Skip blank rows
    const custName = row[fixedIdx["Customer Name"]];
    const ts       = row[fixedIdx["Timestamp"]];
    if (!custName && !ts) continue;

    // Build items object — only include products with qty > 0
    const items = {};
    productCols.forEach(p => {
      const qty = Number(row[p.index]) || 0;
      if (qty > 0) items[p.name] = qty;
    });

    const orderRefForRow = String(row[fixedIdx["Order Ref"]] || "");
    const inv = invoiceByOrderRef[orderRefForRow] || blankInvoiceData;

    orders.push({
      rowIndex:       r + 1,   // 1-based row number in the sheet — used for updates
      timestamp:      formatTimestamp_(ts),
      orderRef:       String(row[fixedIdx["Order Ref"]] || ""),
      gaplOrderId:    String(row[fixedIdx["GAPL Order ID"]] || ""),
      version:        Number(row[fixedIdx["Version"]]) || 1,
      customerName:   String(custName || ""),
      phone:          String(row[fixedIdx["Phone"]]    || ""),
      email:          String(row[fixedIdx["Email"]]    || ""),
      pincode:        String(row[fixedIdx["Pincode"]]  || ""),
      state:          String(row[fixedIdx["State"]]    || ""),
      address:        String(row[fixedIdx["Address"]]  || ""),
      notes:          String(row[fixedIdx["Notes"]]    || ""),
      orderTotal:     Number(row[fixedIdx["Order Total"]]) || 0,
      items,
      // Order + pricing
      status:         String(row[fixedIdx["Status"]]           || "New"),
      // null (never explicitly saved) is kept distinct from 0 (admin
      // explicitly set/overrode the discount to zero) — admin.html's
      // coupon-default fallback must not treat an explicit 0 the same as
      // "nothing saved yet" (that reinstates a coupon the admin deliberately
      // removed the moment the page is reloaded).
      discountPct:    row[adminIdx["Discount %"]] === "" ? null : (Number(row[adminIdx["Discount %"]]) || 0),
      discountAmount: Number(row[adminIdx["Discount Amount"]])  || 0,
      finalTotal:     Number(row[adminIdx["Final Total"]])
                      || Number(row[fixedIdx["Order Total"]])   || 0,
      couponCode:        String(row[adminIdx["Coupon Code"]] || ""),
      couponDiscountPct: Number(row[adminIdx["Coupon Discount %"]]) || 0,
      deliveryCharge:    Number(row[adminIdx["Delivery Charge"]]) || 0,
      sameDayDeliveryCharge: Number(row[adminIdx["Same Day Delivery Charge"]]) || 0,
      freeShippingOverride: String(row[adminIdx["Free Shipping Override"]] || "").trim().toUpperCase(),
      // Invoice lifecycle (from the separate Invoices sheet, joined by Order Ref)
      invoiceNo:        inv.invoiceNo,
      invoiceDate:      inv.invoiceDate,
      invoiceStatus:    inv.invoiceStatus,
      invoiceSentDate:  inv.invoiceSentDate,
      // Payment (from the separate Invoices sheet, joined by Order Ref)
      amountPaid:     inv.amountPaid,
      balanceDue:     inv.balanceDue,
      paymentMode:    inv.paymentMode,
      paymentRef:     inv.paymentRef,
      paymentDate:    inv.paymentDate,
      // Shipping
      courier:          String(row[adminIdx["Courier"]]           || ""),
      awbNo:            String(row[adminIdx["AWB No"]]            || ""),
      shippedDate:      formatDateField_(row[adminIdx["Shipped Date"]]),
      expectedDelivery: formatDateField_(row[adminIdx["Expected Delivery"]]),
      deliveredDate:    formatDateField_(row[adminIdx["Delivered Date"]]),
      adminNotes:       String(row[adminIdx["Admin Notes"]]       || ""),
      // Confirm-time snapshot (Issue 2 / Phase 4)
      totalQty:         Number(row[adminIdx["Total Qty"]]) || 0,
      estWeight:        Number(row[adminIdx["Est. Weight (kg)"]]) || 0,
      stockDecremented: String(row[adminIdx["Stock Decremented"]] || "N").trim().toUpperCase() === "Y",
      itemDiscounts:    parseJsonSafe_(row[adminIdx["Item Discounts JSON"]]),
      itemPriceOverrides: parseJsonSafe_(row[adminIdx["Item Price Overrides JSON"]]),
      productIdMap:     parseJsonSafe_(row[adminIdx["Product IDs JSON"]]),
      lastUpdated:      formatTimestamp_(row[adminIdx["Last Updated"]]),
      // Multi-admin workflow
      assignedTo:          String(row[adminIdx["Assigned To"]] || "").trim(),
      confirmingAdminUpi:  String(row[adminIdx["Confirming Admin UPI"]] || "").trim()
    });
  }
  return orders;
}


// ─────────────────────────────────────────────
//  updateOrder — write admin fields back to a row
// ─────────────────────────────────────────────

// Shared by confirmOrder_ (initial decrement) and moveConfirmedOrderStock_
// (reassignment) — the product-column quantities on this row matched
// against an already-known WA-Key -> Product-ID map, ready for either
// Catalog stock action.
function collectRowStockItems_(sheet, headers, rowIndex, productIdMap) {
  const fixedSet = new Set(FIXED_COLS);
  const adminSet = new Set(ADMIN_COLS);
  const rowValues = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  const items = [];
  headers.forEach((col, i) => {
    if (!col || fixedSet.has(col) || adminSet.has(col)) return;
    const qty = Number(rowValues[i]) || 0;
    if (qty <= 0) return;
    const productId = productIdMap[col];
    if (productId) items.push({ productId, qty });
  });
  return items;
}

// Reassigning an already-confirmed order: rolls the old hub's stock back and
// deducts the new hub's via the Catalog script's moveStock action, then
// re-snapshots Confirming Admin UPI — the one deliberate exception to
// "idempotent, never re-written" (see confirmOrder_'s own snapshot below),
// otherwise the invoice's live-resolved company identity and its frozen UPI
// payment target would point at two different hubs after a reassignment.
// Non-blocking: a moveStock failure is logged, not thrown — the
// reassignment field write has already completed by the time this runs,
// matching confirmOrder_'s "retryable, don't half-break the primary action"
// pattern for decrementStock.
function moveConfirmedOrderStock_(sheet, headers, rowIndex, fromHubId, toHubId, newAdminUpi) {
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  let productIdMap = {};
  if (idx["Product IDs JSON"] !== undefined) {
    const raw = String(sheet.getRange(rowIndex, idx["Product IDs JSON"] + 1).getValue() || "");
    try { productIdMap = raw ? JSON.parse(raw) : {}; } catch (err) { productIdMap = {}; }
  }
  const items = collectRowStockItems_(sheet, headers, rowIndex, productIdMap);

  let results = [];
  if (items.length > 0) {
    try {
      const resp = UrlFetchApp.fetch(CATALOG_API_URL, {
        method: "post",
        contentType: "text/plain;charset=utf-8",
        payload: JSON.stringify({ internalKey: INTERNAL_KEY, action: "moveStock", fromHubId: fromHubId, toHubId: toHubId, items: items }),
        muteHttpExceptions: true
      });
      const result = JSON.parse(resp.getContentText());
      results = result.results || [];
    } catch (err) {
      Logger.log("moveStock failed: " + err.message);
      results = [{ error: "moveStock call failed: " + err.message }];
    }
  }

  if (idx["Confirming Admin UPI"] !== undefined && newAdminUpi) {
    sheet.getRange(rowIndex, idx["Confirming Admin UPI"] + 1).setValue(newAdminUpi);
  }
  return results;
}

function updateOrder(body, admin) {
  // Expected body shape:
  // {
  //   rowIndex: 3,                    ← sheet row number (from getAllOrders)
  //   password: "...",                ← only checked by doPost, not here
  //   action: "update",
  //   fields: {                       ← any admin column name → new value
  //     "Status": "Packed",
  //     "Discount %": 10,
  //     "Final Total": 3800,
  //     "Courier": "Delhivery",
  //     "AWB No": "AWB123456"
  //   },
  //   items: {                        ← optional: correct a product qty
  //     "Mustard Oil — Organic (1 L)": 3
  //   },
  //   newAssignedAdminUpi: "..."      ← optional; only meaningful alongside
  //                                     an "Assigned To" reassignment of an
  //                                     already-confirmed order (see below)
  // }

  const sheet = getSheet_();
  ensureAdminColumns_(sheet);
  ensureIdentityColumns_(sheet);

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const rowIndex = Number(body.rowIndex);

  if (!rowIndex || rowIndex < 2) {
    return { status: "error", message: "Invalid rowIndex: " + rowIndex };
  }

  assertOrderAccess_(sheet, headers, rowIndex, admin);

  // Reassignment is Super-Admin-only — Admin A/B can never reassign an
  // order to each other, to themselves, or claim an unassigned one, even
  // one already assigned to them (no separate "claim" action either).
  if (body.fields && Object.prototype.hasOwnProperty.call(body.fields, "Assigned To") && admin.role !== "Super Admin") {
    return { status: "error", message: "Only Super Admin can reassign orders." };
  }

  const orderRefColIdx = headers.indexOf("Order Ref");
  const orderRef = orderRefColIdx > -1 ? String(sheet.getRange(rowIndex, orderRefColIdx + 1).getValue() || "") : "";

  // Reassigning an already-CONFIRMED order (Stock Decremented = Y) must move
  // its stock impact from the old hub to the new one, and keep the
  // invoice's UPI payment target in step with its now-live-resolved company
  // identity. Capture the pre-write state before any field below overwrites it.
  const assignedToColIdx = headers.indexOf("Assigned To");
  const stockDecrementedColIdx = headers.indexOf("Stock Decremented");
  const isReassignment = !!(body.fields && Object.prototype.hasOwnProperty.call(body.fields, "Assigned To"));
  const wasStockDecremented = stockDecrementedColIdx > -1 &&
    String(sheet.getRange(rowIndex, stockDecrementedColIdx + 1).getValue() || "").trim().toUpperCase() === "Y";
  const oldAssignedTo = assignedToColIdx > -1 ? String(sheet.getRange(rowIndex, assignedToColIdx + 1).getValue() || "").trim() : "";
  const newAssignedTo = isReassignment ? String(body.fields["Assigned To"] || "").trim() : oldAssignedTo;

  if (isReassignment && wasStockDecremented && !newAssignedTo) {
    return { status: "error", message: "Can't unassign a confirmed order — reassign to a specific hub instead." };
  }

  // Write admin field updates. Once an order has been invoiced, block a
  // generic field update from touching "Final Total" (Issue B/10) unless the
  // caller explicitly opts in via allowFinalTotalUpdate — set by
  // generateInvoice() in admin.html, the one flow allowed to (re)compute it
  // even on a reprint. Anything else (status/shipping edits, etc.) must
  // never regress an invoiced order's post-GST total.
  if (body.fields) {
    const blockFinalTotal = hasInvoice_(orderRef) && !body.allowFinalTotalUpdate;
    // Invoice/payment fields no longer live on this sheet (see Invoices
    // sheet above) — collected here and routed to upsertInvoiceRow_ in one
    // call instead of being written column-by-column on the Orders sheet.
    const invoiceFields = {};

    Object.keys(body.fields).forEach(fieldName => {
      if (fieldName === "Final Total" && blockFinalTotal) return;
      if (LEGACY_INVOICE_COLS.indexOf(fieldName) > -1) {
        invoiceFields[fieldName] = body.fields[fieldName];
        return;
      }
      const colIdx = headers.indexOf(fieldName);
      if (colIdx > -1) {
        sheet.getRange(rowIndex, colIdx + 1).setValue(body.fields[fieldName]);
      } else {
        Logger.log("Warning: column not found — " + fieldName);
      }
    });

    // Live-sync: any Status change on this order also mirrors onto its
    // Invoices row's "Order Status" column, if one already exists (a status
    // change on a never-invoiced order is correctly a no-op there).
    if (Object.prototype.hasOwnProperty.call(body.fields, "Status")) {
      invoiceFields["Order Status"] = body.fields["Status"];
    }
    if (Object.keys(invoiceFields).length > 0) {
      upsertInvoiceRow_(orderRef, invoiceFields);
    }
  }

  // Write updated item quantities
  if (body.items) {
    Object.keys(body.items).forEach(itemName => {
      const colIdx = headers.indexOf(itemName);
      if (colIdx > -1) {
        sheet.getRange(rowIndex, colIdx + 1).setValue(Number(body.items[itemName]) || 0);
      }
    });
  }

  // Move stock + re-snapshot Confirming Admin UPI for a confirmed order's
  // reassignment, now that the field write above has gone through.
  let moveStockResults = null;
  if (isReassignment && wasStockDecremented && newAssignedTo !== oldAssignedTo) {
    moveStockResults = moveConfirmedOrderStock_(sheet, headers, rowIndex, oldAssignedTo, newAssignedTo, body.newAssignedAdminUpi);
  }

  touchLastUpdated_(sheet, rowIndex);
  return { status: "ok", rowIndex, moveStockResults: moveStockResults };
}


// ─────────────────────────────────────────────
//  getNextInvoiceNo_ — sequential invoice numbers,
//  tracked in a "Settings" sheet tab (auto-created)
// ─────────────────────────────────────────────

function getNextInvoiceNo_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let settings = ss.getSheetByName("Settings");
  if (!settings) {
    settings = ss.insertSheet("Settings");
    settings.getRange("A1").setValue("LastInvoiceNo");
    settings.getRange("B1").setValue(0);
  }
  const lastNo = Number(settings.getRange("B1").getValue()) || 0;
  const next = lastNo + 1;
  settings.getRange("B1").setValue(next);
  return "INV-" + String(next).padStart(6, "0");
}

function getNextCreditNoteNo_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let settings = ss.getSheetByName("Settings");
  if (!settings) {
    settings = ss.insertSheet("Settings");
    settings.getRange("A1").setValue("LastInvoiceNo");
    settings.getRange("B1").setValue(0);
  }
  // Tracked in row 2 of the same Settings tab — created lazily if missing.
  if (!settings.getRange("A2").getValue()) {
    settings.getRange("A2").setValue("LastCreditNoteNo");
    settings.getRange("B2").setValue(0);
  }
  const lastNo = Number(settings.getRange("B2").getValue()) || 0;
  const next = lastNo + 1;
  settings.getRange("B2").setValue(next);
  return "CN-" + String(next).padStart(6, "0");
}

// ─────────────────────────────────────────────
//  getNextGaplOrderId_ — business-facing GAPL Order ID,
//  format "GAPL - MM/YY - 00001". Counter resets to 1 each
//  calendar month (locked decision, Issue 8) — tracked in
//  columns C/D of the same "Settings" tab, one row per month,
//  alongside the invoice/credit-note counters in columns A/B.
// ─────────────────────────────────────────────

function getNextGaplOrderId_() {
  // Read-increment-write on a shared counter — must be atomic across
  // concurrent confirmOrder_ calls, or two confirms in quick succession can
  // both read the same counter value before either writes it back.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // throws LockTimeoutError after 10s — caller (confirmOrder_) must catch this and abort cleanly, not partially confirm the order
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let settings = ss.getSheetByName("Settings");
    if (!settings) {
      settings = ss.insertSheet("Settings");
      settings.getRange("A1").setValue("LastInvoiceNo");
      settings.getRange("B1").setValue(0);
    }
    const monthKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MM/yy");
    const lastRow = Math.max(settings.getLastRow(), 1);

    // Column C must stay plain text. Sheets' Automatic cell format silently
    // coerces a "MM/yy"-shaped string like "07/26" into a real Date the
    // moment it's written — after that, comparing it against the literal
    // string monthKey below never matches, so every single confirm falls
    // into the "new month" branch and resets the counter to 1. This was the
    // actual cause of every order in a month getting GAPL ID "00001"
    // regardless of day. Force text format on the whole column before ever
    // reading/writing it.
    settings.getRange(1, 3, lastRow, 1).setNumberFormat("@");

    const monthCol = settings.getRange(1, 3, lastRow, 1).getValues().map(r => {
      const v = r[0];
      // Rows already corrupted into a Date object by the bug above (before
      // this fix shipped) would otherwise never match monthKey again —
      // normalize back to "MM/yy" instead of leaving them permanently stuck.
      if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "MM/yy");
      return String(v || "");
    });
    const rowIdx = monthCol.indexOf(monthKey); // 0-based within the read range

    let counter;
    if (rowIdx === -1) {
      const newRow = lastRow + 1;
      settings.getRange(newRow, 3).setNumberFormat("@").setValue(monthKey);
      counter = 1;
      settings.getRange(newRow, 4).setValue(counter);
    } else {
      const sheetRow = rowIdx + 1;
      counter = (Number(settings.getRange(sheetRow, 4).getValue()) || 0) + 1;
      settings.getRange(sheetRow, 4).setValue(counter);
    }
    return "GAPL - " + monthKey + " - " + String(counter).padStart(5, "0");
  } finally {
    lock.releaseLock();
  }
}


// ─────────────────────────────────────────────
//  recordPayment_ — records a payment against an
//  order row and derives Balance Due / Invoice Status
// ─────────────────────────────────────────────

function recordPayment_(body, admin) {
  // body: { rowIndex, password, action, amountPaid, paymentMode, paymentRef, paymentDate }
  // amountPaid is THIS payment's amount, not a running total (Issue F/Phase 8)
  // — accumulated onto whatever "Amount Paid" already holds, so two partial
  // payments add up instead of the second silently overwriting the first.
  // Amount Paid/Balance Due/etc. live on the separate Invoices sheet now —
  // Final Total is the one payment-adjacent figure still on this sheet.
  const sheet = getSheet_();
  ensureAdminColumns_(sheet);
  ensureIdentityColumns_(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { status: "error", message: "Invalid rowIndex" };
  assertOrderAccess_(sheet, headers, row, admin);

  const orderRefColIdx = headers.indexOf("Order Ref");
  const orderRef = orderRefColIdx > -1 ? String(sheet.getRange(row, orderRefColIdx + 1).getValue() || "") : "";

  const invSheet = getOrCreateInvoicesSheet_();
  const invRowIdx = findInvoiceRowByOrderId_(invSheet, orderRef);
  if (invRowIdx === -1) {
    return { status: "error", message: "No invoice found for this order — generate an invoice before recording payment" };
  }
  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn()).getValues()[0];

  const finalTotalCol = headers.indexOf("Final Total") + 1;
  const finalTotal = Number(sheet.getRange(row, finalTotalCol).getValue()) || 0;
  const existingPaid = Number(invSheet.getRange(invRowIdx, invHeaders.indexOf("Amount Paid") + 1).getValue()) || 0;
  const thisPayment = Number(body.amountPaid) || 0;
  const amountPaid = Math.round((existingPaid + thisPayment) * 100) / 100;
  const balanceDue = Math.max(0, Math.round((finalTotal - amountPaid) * 100) / 100);

  // NOTE: does not touch order "Status" — under the 5-status fulfillment
  // model (New/Confirmed/Invoiced/Packed & Shipped/Delivered/Cancelled),
  // payment is a sub-state layered on top of "Invoiced" in admin.html
  // (PAYMENT_STATES), independent of fulfillment progress. "Paid" is not a
  // valid order Status value here — writing it would break getStatusCfg's
  // ORDER_STATUSES lookup.
  upsertInvoiceRow_(orderRef, {
    "Amount Paid":    amountPaid,
    "Balance Due":    balanceDue,
    "Payment Mode":   body.paymentMode || "",
    "Payment Ref":    body.paymentRef  || "",
    "Payment Date":   body.paymentDate || "",
    "Invoice Status": balanceDue <= 0 ? "Paid" : "Partially Paid"
  });
  touchLastUpdated_(sheet, row);
  return { status: "ok", rowIndex: row, balanceDue, amountPaid };
}


// ─────────────────────────────────────────────
//  addItemToOrder_ — adds/updates a line item on
//  an existing order row, creating a new product
//  column (before the admin columns) if needed
// ─────────────────────────────────────────────

function addItemToOrder_(body, admin) {
  // body: { rowIndex, password, itemName, qty }
  const sheet = getSheet_();
  ensureAdminColumns_(sheet);
  ensureIdentityColumns_(sheet);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { status: "error", message: "Invalid rowIndex" };
  assertOrderAccess_(sheet, headers, row, admin);
  if (!body.itemName) return { status: "error", message: "itemName is required" };

  let colIdx = headers.indexOf(body.itemName);
  if (colIdx === -1) {
    // New product column — insert immediately before the first ADMIN_COLS column
    const firstAdminIdx = ADMIN_COLS
      .map(c => headers.indexOf(c))
      .filter(i => i > -1)
      .reduce((a, b) => Math.min(a, b), headers.length);
    sheet.insertColumnBefore(firstAdminIdx + 1);
    sheet.getRange(1, firstAdminIdx + 1).setValue(body.itemName);
    // insertColumnBefore() can carry over a stray Date format from whichever
    // column used to sit at this position — force plain-integer format so
    // this column's quantities never render as a bogus date (see
    // fixProductColumnNumberFormat_ for cleaning up columns already affected).
    sheet.getRange(2, firstAdminIdx + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat("0");
    colIdx = firstAdminIdx;
  }
  sheet.getRange(row, colIdx + 1).setValue(Number(body.qty) || 0);
  touchLastUpdated_(sheet, row);
  return { status: "ok", rowIndex: row, column: body.itemName };
}


// ─────────────────────────────────────────────
//  deleteRevisedOrderRows_ — ONE-TIME CLEANUP: deletes every row currently
//  marked Status="Revised" on the Orders sheet. These are leftover from the
//  earlier "Update order" behavior (append a new version row, mark the old
//  one Revised) — removed per user request; "Update order" now edits the
//  existing row in place, so no new Revised rows are created going
//  forward. Irreversible — back up the sheet first if you want to keep a
//  copy of the superseded data before deleting it. Run once from the Apps
//  Script editor via the runDeleteRevisedOrderRows() wrapper below.
// ─────────────────────────────────────────────

function deleteRevisedOrderRows_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("No order rows."); return; }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusIdx = headers.indexOf("Status");
  if (statusIdx === -1) { Logger.log('No "Status" column found.'); return; }

  const statuses = sheet.getRange(2, statusIdx + 1, lastRow - 1, 1).getValues();
  // Delete bottom-up so row numbers of not-yet-processed rows don't shift
  // out from under this loop.
  let count = 0;
  for (let r = statuses.length - 1; r >= 0; r--) {
    if (String(statuses[r][0] || "").trim() === "Revised") {
      sheet.deleteRow(r + 2); // +2: values array is 0-based and starts at sheet row 2
      count++;
    }
  }
  Logger.log("Deleted " + count + " Revised row(s).");
}


// ─────────────────────────────────────────────
//  confirmOrder_ — the "Confirm order" action.
//  Sets Status to "Confirmed", stores the WA-Key → Product-ID map for this
//  order's items, and decrements Stock on the Catalog sheet for each item
//  via that sheet's decrementStock action.
// ─────────────────────────────────────────────

function confirmOrder_(body, admin) {
  // body: { rowIndex, password, productIdMap: { "WA Key": "PRD-XXXXXX", ... },
  //          totalQty, estWeight, confirmingAdminUpi }
  // productIdMap/totalQty/estWeight come from admin.html, which already has
  // the catalog loaded client-side — this script has no other way to resolve
  // WA Key → Product ID/weight without duplicating catalog data here
  // (deliberately avoided, see header note).
  const sheet = getSheet_();
  ensureAdminColumns_(sheet);
  ensureIdentityColumns_(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { status: "error", message: "Invalid rowIndex" };
  assertOrderAccess_(sheet, headers, row, admin);

  // Per-hub stock: can't decrement any hub's stock without knowing which hub
  // to decrement — block confirm outright until the order has been assigned
  // to one (Hub Central included; blank no longer implicitly means Super
  // Admin for this purpose).
  const assignedTo = idx["Assigned To"] !== undefined
    ? String(sheet.getRange(row, idx["Assigned To"] + 1).getValue() || "").trim()
    : "";
  if (!assignedTo) {
    return { status: "error", message: "Assign this order to a hub before confirming." };
  }

  // Assign the business-facing GAPL Order ID once, idempotently — a
  // re-confirm (e.g. retrying a failed stock decrement) must not mint a
  // second ID for the same order. Done FIRST, before any other mutation
  // (including Status), and wrapped so a lock timeout inside
  // getNextGaplOrderId_ aborts cleanly with nothing written yet, instead of
  // leaving the order flipped to "Confirmed" with no ID and stock not
  // decremented (a worse half-confirmed state than not confirming at all).
  let gaplOrderId = "";
  if (idx["GAPL Order ID"] !== undefined) {
    const existing = String(sheet.getRange(row, idx["GAPL Order ID"] + 1).getValue() || "").trim();
    if (existing) {
      gaplOrderId = existing;
    } else {
      try {
        gaplOrderId = getNextGaplOrderId_();
      } catch (err) {
        return { status: "error", message: "Could not assign GAPL Order ID (try again): " + err.message };
      }
      sheet.getRange(row, idx["GAPL Order ID"] + 1).setValue(gaplOrderId);
    }
  }

  // Multi-admin workflow — snapshot the confirming admin's UPI VPA once,
  // idempotently (same pattern as GAPL Order ID above): a re-confirm (retry)
  // must not overwrite it, and an admin's UPI changing later must not
  // retroactively change what an already-confirmed order shows. admin.html
  // resolves body.confirmingAdminUpi client-side from the order's current
  // "Assigned To" against the Admins list before calling this action.
  if (idx["Confirming Admin UPI"] !== undefined && body.confirmingAdminUpi) {
    const existingUpi = String(sheet.getRange(row, idx["Confirming Admin UPI"] + 1).getValue() || "").trim();
    if (!existingUpi) sheet.getRange(row, idx["Confirming Admin UPI"] + 1).setValue(body.confirmingAdminUpi);
  }

  if (idx["Status"] !== undefined) sheet.getRange(row, idx["Status"] + 1).setValue("Confirmed");

  // Live-sync (Issue: separate Invoices sheet) — a no-op if this order has
  // no invoice yet (the normal case at confirm time), but keeps the mirror
  // correct for a re-confirm/retry after an invoice already exists.
  const orderRefIdx = idx["Order Ref"];
  if (orderRefIdx !== undefined) {
    const orderRef = String(sheet.getRange(row, orderRefIdx + 1).getValue() || "");
    upsertInvoiceRow_(orderRef, { "Order Status": "Confirmed" });
  }

  if (idx["Total Qty"] !== undefined) sheet.getRange(row, idx["Total Qty"] + 1).setValue(Number(body.totalQty) || 0);
  if (idx["Est. Weight (kg)"] !== undefined) sheet.getRange(row, idx["Est. Weight (kg)"] + 1).setValue(Number(body.estWeight) || 0);

  const productIdMap = body.productIdMap || {};
  if (idx["Product IDs JSON"] !== undefined) sheet.getRange(row, idx["Product IDs JSON"] + 1).setValue(JSON.stringify(productIdMap));

  // Stock decrement — guarded by "Stock Decremented" rather than Status, so
  // re-confirming an already-decremented order is a safe no-op (Issue A),
  // but an order whose *previous* confirm attempt failed to decrement (e.g.
  // the Catalog script was unreachable) can still be retried to completion
  // instead of getting permanently stuck.
  const alreadyDecremented = idx["Stock Decremented"] !== undefined &&
    String(sheet.getRange(row, idx["Stock Decremented"] + 1).getValue() || "").trim().toUpperCase() === "Y";

  let stockResults = [];
  if (!alreadyDecremented) {
    // Product columns = anything not in FIXED_COLS/ADMIN_COLS
    const stockDecrements = collectRowStockItems_(sheet, headers, row, productIdMap);

    if (stockDecrements.length > 0) {
      try {
        const resp = UrlFetchApp.fetch(CATALOG_API_URL, {
          method: "post",
          contentType: "text/plain;charset=utf-8",
          payload: JSON.stringify({ internalKey: INTERNAL_KEY, action: "decrementStock", hubId: assignedTo, items: stockDecrements }),
          muteHttpExceptions: true
        });
        const result = JSON.parse(resp.getContentText());
        stockResults = result.results || [];
        const hadError = stockResults.some(r => r.error);
        if (!hadError && idx["Stock Decremented"] !== undefined) {
          sheet.getRange(row, idx["Stock Decremented"] + 1).setValue("Y");
        }
      } catch (err) {
        Logger.log("Stock decrement failed: " + err.message);
        stockResults = [{ error: "Stock decrement call failed: " + err.message }];
      }
    } else if (idx["Stock Decremented"] !== undefined) {
      // Nothing needed decrementing (e.g. no items matched a Product ID) —
      // mark done so this order doesn't stay "retryable" forever.
      sheet.getRange(row, idx["Stock Decremented"] + 1).setValue("Y");
    }
  }

  touchLastUpdated_(sheet, row);
  return { status: "ok", rowIndex: row, gaplOrderId: gaplOrderId, stockResults: stockResults, alreadyDecremented: alreadyDecremented };
}

// Fill in with a real active row's Password from the Admins tab (Catalog
// spreadsheet) before running any test*() function below — resolveAdmin_
// needs a real password, not a shared key, to authenticate.
const TEST_ADMIN_PASSWORD = "PASTE_A_REAL_ADMIN_PASSWORD_HERE";

function testConfirmOrder() {
  // Run testAdminList() first to get a real rowIndex from your sheet.
  const mock = {
    postData: { contents: JSON.stringify({
      password: TEST_ADMIN_PASSWORD,
      action: "confirmOrder",
      rowIndex: 2,
      productIdMap: {
        "Mustard Oil — Organic (1 L)": "PRD-A3X9K2",
        "A2 Bilona Cow Ghee (1 L)": "PRD-B7K3M9"
      },
      totalQty: 3,
      estWeight: 2.5
    })}
  };
  Logger.log(doPost(mock).getContent());
}


// ─────────────────────────────────────────────
//  Credit Notes — a separate "Credit Notes" sheet tab (auto-created),
//  one row per credit note. GST math is computed client-side in
//  invoices.html (which already has Catalog data loaded for exact
//  per-item GST%/HSN, same as the Excel export) — this script just
//  persists what it's given and applies the balance reduction, matching
//  the pattern used elsewhere (addItemToOrder_/confirmOrder_ also take
//  precomputed data from the frontend rather than re-deriving it here).
// ─────────────────────────────────────────────

const CREDIT_NOTE_HEADERS = [
  "Credit Note No", "Credit Note Date", "Order Row Index", "Order ID", "Invoice No",
  "Customer Name", "Items JSON", "Taxable Value", "CGST", "SGST", "IGST", "Total GST",
  "Total Amount", "Reason"
];

function getOrCreateCreditNotesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Credit Notes");
  if (!sheet) {
    sheet = ss.insertSheet("Credit Notes");
    sheet.getRange(1, 1, 1, CREDIT_NOTE_HEADERS.length).setValues([CREDIT_NOTE_HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getAllCreditNotes_() {
  const sheet = getOrCreateCreditNotesSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(1, 1, lastRow, CREDIT_NOTE_HEADERS.length).getValues();
  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);

  const notes = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row[idx["Credit Note No"]]) continue; // skip blank rows
    let items = [];
    try { items = JSON.parse(row[idx["Items JSON"]] || "[]"); } catch (e) { items = []; }
    notes.push({
      creditNoteNo:   String(row[idx["Credit Note No"]] || ""),
      creditNoteDate: formatDateField_(row[idx["Credit Note Date"]]),
      rowIndex:       Number(row[idx["Order Row Index"]]) || 0,
      orderId:        String(row[idx["Order ID"]] || ""),
      invoiceNo:      String(row[idx["Invoice No"]] || ""),
      customerName:   String(row[idx["Customer Name"]] || ""),
      items:          items,
      taxableValue:   Number(row[idx["Taxable Value"]]) || 0,
      cgst:           Number(row[idx["CGST"]]) || 0,
      sgst:           Number(row[idx["SGST"]]) || 0,
      igst:           Number(row[idx["IGST"]]) || 0,
      totalGst:       Number(row[idx["Total GST"]]) || 0,
      totalAmount:    Number(row[idx["Total Amount"]]) || 0,
      reason:         String(row[idx["Reason"]] || "")
    });
  }
  return notes;
}

function createCreditNote_(body, admin) {
  // body: { rowIndex, password, invoiceNo, items: [{waKey,qty,taxable,cgst,sgst,igst,gstAmt}, ...],
  //          taxableValue, cgst, sgst, igst, totalGst, totalAmount, reason }
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { status: "error", message: "Invalid rowIndex" };
  if (!body.items || !body.items.length) return { status: "error", message: "No items to credit" };

  const sheet = getSheet_();
  ensureAdminColumns_(sheet);
  ensureIdentityColumns_(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  assertOrderAccess_(sheet, headers, row, admin);
  const rowValues = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];

  const orderIdColIdx = headers.indexOf("Order Ref");
  const custNameColIdx = headers.indexOf("Customer Name");
  const orderId = orderIdColIdx > -1 ? String(rowValues[orderIdColIdx] || "") : "";
  const customerName = custNameColIdx > -1 ? String(rowValues[custNameColIdx] || "") : "";

  const cnSheet = getOrCreateCreditNotesSheet_();
  const creditNoteNo = getNextCreditNoteNo_();
  const creditNoteDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy");
  const totalAmount = Number(body.totalAmount) || 0;

  cnSheet.appendRow([
    creditNoteNo, creditNoteDate, row, orderId, body.invoiceNo || "", customerName,
    JSON.stringify(body.items), Number(body.taxableValue) || 0, Number(body.cgst) || 0,
    Number(body.sgst) || 0, Number(body.igst) || 0, Number(body.totalGst) || 0,
    totalAmount, body.reason || ""
  ]);

  // Reduce what's owed on the source order. Deliberately does NOT touch
  // "Invoice Status" — a credit note lowering the balance to zero isn't the
  // same thing as the customer having paid, and computePaymentState() in
  // admin.html/invoices.html derives payment status from that column, not
  // from balance math. Final Total stays on this (Orders) sheet; Amount
  // Paid/Balance Due now live on the separate Invoices sheet, joined by
  // Order Ref.
  const finalTotalCol = headers.indexOf("Final Total") + 1;
  const currentFinalTotal = finalTotalCol > 0 ? Number(sheet.getRange(row, finalTotalCol).getValue()) || 0 : 0;
  const newFinalTotal = Math.max(0, Math.round((currentFinalTotal - totalAmount) * 100) / 100);
  if (finalTotalCol > 0) sheet.getRange(row, finalTotalCol).setValue(newFinalTotal);

  const invSheet = getOrCreateInvoicesSheet_();
  const invRowIdx = findInvoiceRowByOrderId_(invSheet, orderId);
  const invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn()).getValues()[0];
  const currentAmountPaid = invRowIdx > -1 ? Number(invSheet.getRange(invRowIdx, invHeaders.indexOf("Amount Paid") + 1).getValue()) || 0 : 0;
  const newBalanceDue = Math.max(0, Math.round((newFinalTotal - currentAmountPaid) * 100) / 100);
  upsertInvoiceRow_(orderId, { "Balance Due": newBalanceDue });

  touchLastUpdated_(sheet, row);
  return { status: "ok", creditNoteNo, creditNoteDate, newFinalTotal, newBalanceDue };
}


// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

// Scans only the most recent rows (cheap, and dedup only ever needs to look
// back a couple of minutes/10 minutes) for a submission that's an exact
// repeat of this one. Returns the matching row number, or null.
function findRecentDuplicateOrder_(ws, headers, data) {
  const lastRow = ws.getLastRow();
  if (lastRow < 2) return null;

  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const tsColIdx = idx["Timestamp"];
  if (tsColIdx === undefined) return null;

  const scanRows = Math.min(50, lastRow - 1);
  const startRow = lastRow - scanRows + 1;
  const values = ws.getRange(startRow, 1, scanRows, headers.length).getValues();
  const now = Date.now();

  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    const rowTs = parseSheetTimestamp_(row[tsColIdx]);
    if (!rowTs) continue;
    const ageMs = now - rowTs.getTime();

    if (idx["Client Order ID"] !== undefined && data.clientOrderId) {
      const rowClientId = String(row[idx["Client Order ID"]] || "");
      if (rowClientId && rowClientId === data.clientOrderId && ageMs <= 10 * 60 * 1000) {
        return startRow + i;
      }
    }

    if (idx["Phone"] !== undefined && idx["Order Total"] !== undefined && ageMs <= 2 * 60 * 1000) {
      const rowPhone = String(row[idx["Phone"]] || "");
      const rowTotal = Number(row[idx["Order Total"]]) || 0;
      if (rowPhone && rowPhone === String(data.phone || "") &&
          Math.abs(rowTotal - (Number(data.total) || 0)) < 0.01 &&
          sameItemSet_(row, headers, data.items || {})) {
        return startRow + i;
      }
    }
  }
  return null;
}

// Exact same product+qty set (order-independent) — used by the phone+total
// fallback dedup check so two different orders placed back-to-back by the
// same customer for the same total (coincidentally) aren't collapsed unless
// the items also match exactly.
function sameItemSet_(row, headers, items) {
  const fixedSet = new Set(FIXED_COLS);
  const adminSet = new Set(ADMIN_COLS);
  const rowItems = {};
  headers.forEach((col, i) => {
    if (!col || fixedSet.has(col) || adminSet.has(col)) return;
    const q = Number(row[i]) || 0;
    if (q > 0) rowItems[col] = q;
  });
  const incomingKeys = Object.keys(items).filter(k => Number(items[k]) > 0);
  const rowKeys = Object.keys(rowItems);
  if (incomingKeys.length !== rowKeys.length) return false;
  return incomingKeys.every(k => Number(items[k]) === rowItems[k]);
}

// Same idea as formatTimestamp_/formatDateField_ but returns an actual Date
// (not a display string) so callers can do time-window math — the
// Timestamp column may come back as a real Date object (Sheets
// auto-converts recognized date-like strings) or as the "dd/MM/yyyy
// HH:mm:ss" string doPost_logOrder wrote, depending on Sheets' whim.
function parseSheetTimestamp_(val) {
  if (!val) return null;
  if (Object.prototype.toString.call(val) === "[object Date]") return val;
  const m = String(val).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

function ensureIdentityColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  let headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());

  // Insert any missing identity column right after Timestamp (or at the very
  // start if Timestamp itself is missing) — never at the sheet end (Issue D),
  // so a legacy/partially-migrated sheet still gets these next to Status
  // instead of drifting past every product column. Brand-new sheets never
  // hit this path for these three columns since FIXED_COLS already puts them
  // here via doPost_logOrder's header-sync — this is a safety net only.
  let insertAt = headers.indexOf("Timestamp");
  insertAt = insertAt > -1 ? insertAt + 1 : 0; // 0-based position to insert before

  ["Order Ref", "GAPL Order ID", "Version"].forEach(col => {
    if (headers.includes(col)) { insertAt = Math.max(insertAt, headers.indexOf(col) + 1); return; }
    sheet.insertColumnBefore(insertAt + 1);
    const cell = sheet.getRange(1, insertAt + 1);
    cell.setValue(col);
    cell.setBackground("#3A5428");
    cell.setFontColor("#FFFFFF");
    cell.setFontWeight("bold");
    headers.splice(insertAt, 0, col);
    insertAt += 1;
  });
}

// ─────────────────────────────────────────────
//  migrateOrdersInvoiceDataToInvoicesSheet_ — ONE-TIME MIGRATION: copies
//  existing Invoice No/Date/Status/Sent Date/Amount Paid/Balance Due/
//  Payment Mode/Ref/Date data off the Orders sheet (LEGACY_INVOICE_COLS)
//  into the new separate Invoices sheet, keyed by Order Ref. Only touches
//  rows that have a non-blank Invoice No — never-invoiced orders have
//  nothing to migrate. Does NOT modify the Orders sheet itself; run
//  migrateSheetColumns_() afterward to actually drop the old columns from
//  Orders once this has copied their data over. Safe to re-run.
// ─────────────────────────────────────────────

function migrateOrdersInvoiceDataToInvoicesSheet_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("No order rows to migrate."); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });

  const orderRefIdx = idx["Order Ref"] !== undefined ? idx["Order Ref"] : idx["Order ID"];
  const invoiceNoIdx = idx["Invoice No"];
  if (orderRefIdx === undefined || invoiceNoIdx === undefined) {
    Logger.log("Nothing to migrate — no Order Ref/Order ID or Invoice No column found on the Orders sheet.");
    return;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  let count = 0;
  values.forEach(row => {
    const invoiceNo = String(row[invoiceNoIdx] || "").trim();
    if (!invoiceNo) return; // never invoiced — nothing to migrate

    const orderRef = String(row[orderRefIdx] || "").trim();
    if (!orderRef) return;

    const fields = { "Invoice No": invoiceNo };
    LEGACY_INVOICE_COLS.forEach(col => {
      if (col === "Invoice No") return;
      if (idx[col] !== undefined) fields[col] = row[idx[col]];
    });
    if (idx["Status"] !== undefined) fields["Order Status"] = row[idx["Status"]];

    upsertInvoiceRow_(orderRef, fields);
    count++;
  });
  Logger.log("Migrated invoice/payment data for " + count + " order(s) into the Invoices sheet.");
}

// ─────────────────────────────────────────────
//  migrateSheetColumns_ — ONE-TIME MIGRATION for a legacy Orders sheet:
//  moves Status to column A, renames "Order ID" -> "Order Ref", drops the
//  invoice/payment columns that now live on the separate Invoices sheet
//  (LEGACY_INVOICE_COLS), and lays out every remaining column per the
//  current FIXED_COLS/ADMIN_COLS order, while preserving product columns
//  and all existing row data by matching on header name (not position).
//
//  RUN migrateOrdersInvoiceDataToInvoicesSheet_() FIRST if this sheet has
//  any existing Invoice No/payment data — this function drops those
//  columns without copying them anywhere.
//
//  BACK UP THE SHEET FIRST (File > Make a copy) — this rewrites the entire
//  header row and every row's column layout in place; there is no scripted
//  rollback. Only needed if this sheet predates the 2026-07-09 Order ID/
//  Version feature (a brand-new sheet already gets the right layout from
//  doPost_logOrder). Safe to re-run — a no-op if headers already match.
//  Run once from the Apps Script editor (▶ Run → migrateSheetColumns_).
// ─────────────────────────────────────────────

function migrateSheetColumns_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) { Logger.log("Sheet is empty — nothing to migrate."); return; }

  const allValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const oldHeaders = allValues[0].map(h => String(h).trim());

  const rename = { "Order ID": "Order Ref" };
  const renamedOldHeaders = oldHeaders.map(h => rename[h] || h);

  // Product columns = whatever isn't a known fixed/admin column, kept in
  // their existing relative order. LEGACY_INVOICE_COLS are "known" here
  // specifically so they're recognized and dropped, not mistaken for
  // product columns and kept around.
  const knownCols = new Set(FIXED_COLS.concat(ADMIN_COLS).concat(LEGACY_INVOICE_COLS));
  const productCols = renamedOldHeaders.filter(h => h && !knownCols.has(h));

  const newHeaders = FIXED_COLS.concat(productCols).concat(ADMIN_COLS);

  if (newHeaders.length === renamedOldHeaders.length &&
      newHeaders.every((h, i) => h === renamedOldHeaders[i])) {
    Logger.log("Sheet already matches the current column layout — nothing to do.");
    return;
  }

  const oldIdxByHeader = {};
  renamedOldHeaders.forEach((h, i) => { if (h && oldIdxByHeader[h] === undefined) oldIdxByHeader[h] = i; });

  const newValues = allValues.map((row, r) => {
    if (r === 0) return newHeaders;
    return newHeaders.map(h => {
      const oldIdx = oldIdxByHeader[h];
      return oldIdx !== undefined ? row[oldIdx] : "";
    });
  });

  // Rewrite in place. Clear first so any leftover cells beyond the new
  // column count don't linger with stale data.
  sheet.getRange(1, 1, lastRow, lastCol).clearContent();
  sheet.getRange(1, 1, newValues.length, newHeaders.length).setValues(newValues);

  const hRange = sheet.getRange(1, 1, 1, newHeaders.length);
  hRange.setBackground("#3A5428").setFontColor("#FFFFFF").setFontWeight("bold");
  ADMIN_COLS.forEach(col => {
    const idx = newHeaders.indexOf(col);
    if (idx > -1) sheet.getRange(1, idx + 1).setBackground("#7a6e58").setFontColor("#f0ede0");
  });

  // ROOT CAUSE of the "12/30/1899" / "31 Dec 1899" bug: clearContent() above
  // clears cell VALUES but deliberately leaves each cell's number format
  // untouched. Product columns just got physically repositioned (and
  // LEGACY_INVOICE_COLS like "Invoice Date"/"Payment Date" — real
  // Date-typed columns — just got dropped), so a product column can now
  // land on a column index that still carries a Date format from whatever
  // used to be there. Sheets then renders that column's plain 0/1 quantity
  // values using the stale Date format (0 = "12/30/1899", Sheets' date
  // epoch). Force plain-integer format on every product column so this
  // can't happen — this is what actually fixes it, not just the one-time
  // cleanup in fixProductColumnNumberFormat_.
  const knownColsForFormat = new Set(FIXED_COLS.concat(ADMIN_COLS));
  newHeaders.forEach((h, i) => {
    if (h && !knownColsForFormat.has(h)) {
      sheet.getRange(2, i + 1, newValues.length - 1, 1).setNumberFormat("0");
    }
  });

  Logger.log("Migrated " + (lastRow - 1) + " order rows to the new column layout.");
}

// ─────────────────────────────────────────────
//  fixProductColumnNumberFormat_ — ONE-TIME CLEANUP for a sheet that's
//  ALREADY showing the bug right now: product/item columns displaying
//  "12/30/1899", "31 Dec 1899", etc. for items that weren't part of that
//  order, instead of blank/0.
//
//  Root cause (see migrateSheetColumns_ and addItemToOrder_ above): a
//  column's number FORMAT is independent of its header/value, and neither
//  clearContent() (used when migrateSheetColumns_ reshuffles columns) nor
//  insertColumnBefore() (used when a new item is added) resets it. So a
//  product column can end up sitting on a physical column index that used
//  to hold a real Date-typed column (e.g. the old "Invoice Date"/"Payment
//  Date" columns, dropped to the Invoices sheet on 2026-07-12) and inherits
//  its Date format. The stored values were always correct plain numbers —
//  this only resets the DISPLAY format, no order data changes. Both
//  functions above now force plain-integer format going forward, so this is
//  only needed once, to clean up columns already affected. Safe to re-run.
//  Run once from the Apps Script editor via runFixProductColumnNumberFormat().
// ─────────────────────────────────────────────

function fixProductColumnNumberFormat_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) { Logger.log("Nothing to fix — sheet is empty."); return; }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const knownCols = new Set(FIXED_COLS.concat(ADMIN_COLS).concat(LEGACY_INVOICE_COLS));

  let fixedCols = 0;
  headers.forEach((h, i) => {
    if (h && !knownCols.has(h)) {
      sheet.getRange(2, i + 1, lastRow - 1, 1).setNumberFormat("0");
      fixedCols++;
    }
  });
  Logger.log("Reset number format on " + fixedCols + " product column(s) — reload the sheet to confirm the bogus dates are gone.");
}

// ─────────────────────────────────────────────
//  backfillGaplOrderIds_ — OPTIONAL one-time helper: assigns a GAPL Order ID
//  to already-confirmed legacy rows that don't have one yet. Run after
//  migrateSheetColumns_(). Note: since this script doesn't track the original
//  confirm date separately from order creation, backfilled IDs use *today's*
//  month, not the month the order was actually confirmed.
// ─────────────────────────────────────────────

function backfillGaplOrderIds_() {
  const sheet = getSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusIdx = headers.indexOf("Status");
  const gaplIdx = headers.indexOf("GAPL Order ID");
  if (statusIdx === -1 || gaplIdx === -1) {
    Logger.log("Run migrateSheetColumns_() first — Status/GAPL Order ID column missing.");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  let count = 0;
  values.forEach((row, i) => {
    const status = String(row[statusIdx] || "");
    const existing = String(row[gaplIdx] || "").trim();
    if (status && status !== "New" && !existing) {
      const gaplId = getNextGaplOrderId_();
      sheet.getRange(2 + i, gaplIdx + 1).setValue(gaplId);
      count++;
    }
  });
  Logger.log("Backfilled " + count + " GAPL Order IDs.");
}

function ensureAdminColumns_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  ADMIN_COLS.forEach(col => {
    if (!headers.includes(col)) {
      const newCol = sheet.getLastColumn() + 1;
      const cell   = sheet.getRange(1, newCol);
      cell.setValue(col);
      cell.setBackground("#7a6e58");
      cell.setFontColor("#f0ede0");
      cell.setFontWeight("bold");
    }
  });
}

// Stamps "Last Updated" on an Orders-sheet row — called from every admin
// write path (update/confirm/payment/credit note/add item) so admin.html can
// sort its order list by recency instead of sheet row order. Re-reads
// headers itself rather than trusting a caller-supplied array, since a
// mid-function column insert (e.g. addItemToOrder_'s new product column)
// would otherwise leave a stale index and stamp the wrong cell.
function touchLastUpdated_(sheet, rowIndex) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = headers.indexOf("Last Updated");
  if (idx === -1) return;
  sheet.getRange(rowIndex, idx + 1).setValue(
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss")
  );
}

function formatTimestamp_(val) {
  if (!val) return "";
  if (Object.prototype.toString.call(val) === "[object Date]") {
    return Utilities.formatDate(
      val, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss"
    );
  }
  return String(val);
}

// Same idea as formatTimestamp_ but for date-only admin fields (Invoice
// Date, Shipped Date, etc.) — Sheets silently converts a typed/written
// "dd/MM/yyyy"-looking string into a real Date cell, and getValue() then
// returns a JS Date object instead of that string. Every consumer downstream
// (admin.html's parseDate_, invoices.html's date-range filter) expects a
// plain "dd/MM/yyyy" string and breaks on anything else.
function formatDateField_(val) {
  if (!val) return "";
  if (Object.prototype.toString.call(val) === "[object Date]") {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "dd/MM/yyyy");
  }
  return String(val);
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseJsonSafe_(str) {
  try { return JSON.parse(str || "{}"); } catch (e) { return {}; }
}


// ─────────────────────────────────────────────
//  ONE-TIME MIGRATION RUNNERS — select one of these from the "Select
//  function to run" dropdown, not the underscore-suffixed function itself.
//  The Apps Script editor hides any function whose name ends in "_" from
//  that dropdown (its convention for "private" helpers) — these thin
//  wrappers exist purely so the real migration functions are actually
//  selectable and runnable from the editor UI.
// ─────────────────────────────────────────────

function runMigrateOrdersInvoiceData() { migrateOrdersInvoiceDataToInvoicesSheet_(); }
function runMigrateSheetColumns() { migrateSheetColumns_(); }
function runBackfillGaplOrderIds() { backfillGaplOrderIds_(); }
function runDeleteRevisedOrderRows() { deleteRevisedOrderRows_(); }
function runFixProductColumnNumberFormat() { fixProductColumnNumberFormat_(); }

// ─────────────────────────────────────────────
//  TEST FUNCTIONS — run these manually from
//  the Apps Script editor to verify everything
// ─────────────────────────────────────────────

function testNewOrder() {
  // Simulates an order arriving from index.html
  const mock = {
    postData: {
      contents: JSON.stringify({
        name:    "Priya Sharma",
        phone:   "9876543210",
        pincode: "411036",
        state:   "Maharashtra",
        address: "101 Green Park, Pune",
        notes:   "Please pack carefully",
        total:   3248,
        items: {
          "Mustard Oil — Organic (1 L)": 2,
          "A2 Bilona Cow Ghee (1 L)":    1,
          "Khapli Wheat Flour (2 kg)":   1
        }
      })
    }
  };
  const result = doPost(mock);
  Logger.log("New order result: " + result.getContent());
}

function testAdminList() {
  // Simulates an admin listing their own orders
  const mock = {
    parameter: { action: "list", password: TEST_ADMIN_PASSWORD }
  };
  const result = doGet(mock);
  const data   = JSON.parse(result.getContent());
  Logger.log("Orders found: " + data.data.length);
  if (data.data.length > 0) Logger.log("First order: " + JSON.stringify(data.data[0]));
}

function testAdminUpdate() {
  // Simulates marking row 2 as Packed
  // Run testAdminList() first to see real rowIndex values
  const mock = {
    postData: {
      contents: JSON.stringify({
        password: TEST_ADMIN_PASSWORD,
        action:   "update",
        rowIndex: 2,
        fields: {
          "Status":         "Packed",
          "Discount %":     10,
          "Discount Amount":324.8,
          "Final Total":    2923.2,
          "Admin Notes":    "Packed and ready for courier pickup"
        }
      })
    }
  };
  const result = doPost(mock);
  Logger.log("Update result: " + result.getContent());
}

function testGetNextInvoiceNo() {
  const mock = { postData: { contents: JSON.stringify({ password: TEST_ADMIN_PASSWORD, action: "getNextInvoiceNo" }) } };
  const result = doPost(mock);
  Logger.log("Invoice no result: " + result.getContent());
}

function testRecordPayment() {
  // Row 2 must already have an invoice (via testAdminUpdate() with an
  // "Invoice No" field, or generateInvoice() from admin.html) — recordPayment_
  // now returns an error for an order with no Invoices-sheet row.
  const mock = {
    postData: {
      contents: JSON.stringify({
        password: TEST_ADMIN_PASSWORD, action: "recordPayment", rowIndex: 2,
        amountPaid: 2923.2, paymentMode: "UPI", paymentRef: "UPI-REF-123",
        paymentDate: "08/07/2026"
      })
    }
  };
  const result = doPost(mock);
  Logger.log("Record payment result: " + result.getContent());
}

function testAddItemToOrder() {
  // Run testAdminList() first to see real rowIndex values
  const mock = {
    postData: {
      contents: JSON.stringify({
        password: TEST_ADMIN_PASSWORD, action: "addItemToOrder", rowIndex: 2,
        itemName: "Basmati Rice (1 kg)", qty: 2
      })
    }
  };
  const result = doPost(mock);
  Logger.log("Add item result: " + result.getContent());
}
