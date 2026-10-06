# Order & Invoice Lifecycle Upgrade — reference

Implemented 2026-07-08 across `admin.html` and `orders_code.gs`. Kept here for
future reference since it's the source spec both files were built from.

## Order statuses (6, replacing the old 5)

`New → Confirmed → Packed → Shipped → Delivered → Paid`, plus a `Cancelled`
off-ramp from `New`/`Confirmed`. Defined in `admin.html` as `ORDER_STATUSES`
(color, label, and valid `next` transitions per status). Action buttons in the
order card only ever show the valid next steps for the current status — there
is no free-form status dropdown anymore.

## Invoice statuses (6)

`Draft → Sent → Partially Paid → Paid`, plus `Overdue` (auto-computed, not
stored — see `computeInvoiceStatus()` in `admin.html`: Sent/Partially Paid
older than 15 days from `Invoice Date` displays as Overdue) and `Credit Note`
(reserved, no UI writes it yet).

## What's in `orders_code.gs`

- `ADMIN_COLS` extended with shipping (`Courier`, `AWB No`, `Shipped Date`,
  `Expected Delivery`, `Delivered Date`), payment (`Amount Paid`,
  `Balance Due`, `Payment Mode`, `Payment Ref`, `Payment Date`), and invoice
  lifecycle (`Invoice Status`, `Invoice Sent Date`) columns. Existing sheets
  migrate automatically — `ensureAdminColumns_()` appends any missing column
  the next time `getAllOrders`/`updateOrder`/etc. run, no manual sheet editing
  needed.
- `getNextInvoiceNo_()` — sequential invoice numbers tracked in an
  auto-created `Settings` sheet tab (`LastInvoiceNo` in B1). Replaces the old
  hardcoded `invoiceCounter` JS variable in `admin.html`.
- `recordPayment_()` — new `recordPayment` action. Writes Amount
  Paid/Balance Due/Payment Mode/Ref/Date and derives `Invoice Status`
  (Paid vs Partially Paid) and order `Status` (Paid vs stays Delivered) from
  whether the balance clears to zero.
- `addItemToOrder_()` — new `addItemToOrder` action. Sets an absolute qty on
  a product column for a given row, creating the column (inserted
  immediately before the first `ADMIN_COLS` column) if the product has never
  been ordered before.

**Deliberate deviation from the original spec:** the spec's Task 1f asked for
a `catalog` action on this script's `doGet`. That was skipped — the product
catalog already lives in a separate Google Sheet + Apps Script deployment
(`catalog_code.gs`, used by `products.html` and `index.html`). Duplicating
catalog data into the Orders sheet would mean two sources of truth. Instead,
`admin.html`'s "Add item" panel calls the Catalog deployment directly.

## What's in `admin.html`

- `CATALOG_API_URL` points at the Catalog deployment (same one `index.html`
  uses). Loaded on connect via `loadCatalog()`, which hits the **admin**
  `?action=list&key=` endpoint (not the public `?action=catalog`) so that
  pricing for products that have since gone inactive or out of stock still
  resolves on old orders — the public endpoint filters those out entirely,
  which would otherwise break historical order pricing. The public-endpoint
  subset (`Active=Y && Stock>0`) is filtered client-side into
  `CATALOG_ACTIVE` and used only for the "Add item" picker, so admins can't
  add currently-unavailable products to an order.
- Per-item `Disc %` column in the items table, plus an order-level `Discount %`
  field that pushes its value to every active line (`applyOrderDiscount`) and
  displays "Mixed" (via a muted placeholder, still editable to overwrite) when
  items diverge (`orderDiscountDisplay`). All order math
  (`computeOrderMath`) sums per-line discounts rather than applying one flat
  percentage to the subtotal.
- Add-item panel (search via `<input list>` + `<datalist>` against
  `CATALOG_ACTIVE`) and a ✕ delete-per-row button, both restricted to
  `New`/`Confirmed`/`Packed` orders. Deleting zeroes the item's qty (audit
  trail preserved in the sheet) and appends a `[Removed: X on dd/MM/yyyy]`
  note to Admin Notes.
- Shipping section (Courier/AWB/Shipped Date/Expected Delivery) appears from
  `Packed` onward — editable at `Packed`, read-only from `Shipped` on.
- Payment section appears at `Delivered`/`Paid` — a form above, a read-only
  summary once `Paid`. "Record payment" calls the `recordPayment` action
  directly (not the generic `update`/save path) since the backend derives
  balance/status from it.
- All qty/discount/OOS/delete inputs disable once status is `Shipped`,
  `Delivered`, `Paid`, or `Cancelled` (`LOCKED_STATUSES`).
- Invoice generation (`generateInvoice`) now fetches a sequential number from
  the sheet instead of incrementing a hardcoded JS counter, opens the result
  window synchronously (before the async fetch) to avoid popup blockers, and
  no longer touches the order's fulfillment `Status` — invoice lifecycle and
  order lifecycle are tracked independently. Regenerating an invoice that's
  already `Paid`/`Partially Paid` won't downgrade it back to `Sent`. The
  invoice PDF itself gained per-line Disc %/Disc Amt columns, a status
  watermark badge (DRAFT/SENT/PAID/etc., top-right, visible in print too),
  and a "Payment received" section when the order is `Paid`.

## Known follow-ups (not built)

- `Credit Note` invoice status has no UI path to set it yet.
- No UI transitions an invoice from `Sent` to `Draft` or back — generation
  goes straight to `Sent`.

## Order version history — "Update order" (2026-07-09)

Added `Order ID` and `Version` to `FIXED_COLS` in `orders_code.gs` (backfilled
onto existing rows the next time any admin action touches the sheet, via
`ensureIdentityColumns_()`; legacy rows get a fresh `Order ID` minted lazily
the first time they're versioned). `snapshotOrder_()` is the new
`snapshotOrder` action: it copies the full source row, overlays the same
`fields`/`items` payload shape `update` takes, bumps `Version`, and
**appends** it as a new row rather than overwriting — so every prior version
stays in the sheet as permanent history. Anything not present in `fields`
(e.g. invoice/payment columns) carries over unchanged from the source row.

`admin.html` gained an "Update order" button next to "Save changes"
(`updateOrderVersion()`). "Save changes" is unchanged — still an in-place
`update`. "Update order" hits `snapshotOrder` instead, then repoints the
order's local `rowIndex`/`editState` at the new row, so subsequent
Save/Payment/Status/Invoice actions on that card target the new version. The
old row is left as-is and only reappears as its own card in the list after a
manual "↻ Refresh" (`loadOrders()`) — by design, both versions stay visible
side by side rather than one being hidden; there's no grouping/collapsing by
`Order ID` in the UI. A `v{n}` badge shows in the card header once
`version > 1`.

**Not built:** no way to view/diff two versions of the same order side by
side, and duplicate-order detection (`o._dup`) doesn't know about `Order ID`
— two versions of the same order could theoretically get flagged as
duplicates of each other if that heuristic matches on name/phone/timestamp.

## v3 — Product IDs, stock decrement, 5-status workflow, Invoices page (2026-07-09)

This superseded the 6-status model above (New/Confirmed/Packed/Shipped/
Delivered/Paid/Cancelled) with a 5-status one — they cannot coexist, and this
is the current model. `index.html` was explicitly out of scope and untouched.

**Order statuses:** `New → Confirmed → Invoiced → Packed & Shipped →
Delivered`, plus `Cancelled` off-ramp from New/Confirmed. Defined in
`admin.html` as `ORDER_STATUSES`. Payment is **not** a fulfillment stage
anymore — it's a sub-state (`PAYMENT_STATES`: Unpaid/Paid/Partially
Paid/Overdue) layered on top of any invoiced order, computed by
`computePaymentState()`, shown only once `o.invoiceNo` exists. `recordPayment_`
in `orders_code.gs` no longer writes order `Status` — only `updateOrder`
(via `changeStatus`/`generateInvoice`) does.

**Confirmed → stock decrement:** clicking "Confirm order" now calls
`confirmOrderWithStockDecrement()` → `confirmOrder` action in `orders_code.gs`
(`confirmOrder_()`) → sets `Status: Confirmed`, stores a `{waKey: productId}`
map in the new `Product IDs JSON` admin column, and calls the **Catalog**
script's new `decrementStock` action via `UrlFetchApp` to reduce `Stock` for
each item. Negative stock is allowed but surfaced as a toast warning, not
blocked.

**Invoiced is generated, not just marked:** clicking the "Invoiced" action
button calls `generateInvoice()` directly instead of a plain status update —
generating the invoice *is* the transition. `generateInvoice()` now also
writes `Status: Invoiced` (unless the order's already past that point —
reprinting an invoice on a `Packed & Shipped`/`Delivered` order does not
regress its status).

**Product ID (`catalog_code.gs`):** every catalog row now has an
auto-generated, non-editable `PRD-XXXXXX` id (`generateProductId_()`), first
column in `HEADERS`. **Existing Catalog sheets need a one-time manual
migration** — this is not automatic like `ensureAdminColumns_()`:
1. In the Catalog sheet, right-click column A's header → "Insert 1 column
   left" → type `Product ID` in the new A1 (this shifts existing data right
   so it lines up with the new `HEADERS` order).
2. Run `backfillProductIds()` once from the Apps Script editor to fill in
   IDs for existing rows.
3. Redeploy as a **new deployment** (per the gotcha above — editing an
   existing deployment doesn't reliably take effect).

`orders_code.gs`'s `Product IDs JSON` admin column *is* auto-migrated
(`ensureAdminColumns_()` already covers it) — no manual step needed there.

**Deviations from how this was originally specced**, made deliberately
rather than following the spec verbatim:
- The Excel export's GST figures (see `invoices.html` below) are computed
  from each item's actual `GST%`/`HSN` in the Catalog, not a hardcoded
  "oil/ghee = 5%, everything else = 0%" name-regex guess. The one remaining
  approximation: per-item discount % isn't persisted anywhere in the sheet
  (only the order-level aggregate `Discount Amount` is), so that aggregate is
  allocated back across items proportional to each item's gross value before
  computing tax — this still reconciles exactly to the sheet's recorded
  `Discount Amount`/`Final Total`.
- The invoice PDF's QR code uses `api.qrserver.com` instead of
  `chart.googleapis.com`'s old Image Charts endpoint, which Google shut down
  years ago and would have rendered a broken image.

**New file — `invoices.html`:** date-range-filtered invoice list (reads
both the Orders and Catalog deployments), payment-status filter chips
(All/Unpaid/Paid/Partially Paid/Overdue), and an Excel export
(`computeInvoiceTax()` + SheetJS) with one row per invoice: HSN codes, exact
CGST/SGST/IGST, taxable value, and payment status — meant to be handed to a
CA as-is. Independent connection setup (both Web App URLs + the shared admin
key) — doesn't share state with `admin.html`.

**Known follow-ups (not built):** no UI to view/diff order versions;
`_dup` duplicate detection still doesn't know about `Order ID`; no automatic
retry/backfill if `decrementStock` fails mid-confirm (the order still gets
marked Confirmed even if stock decrement errors — the toast surfaces this,
but nothing queues a retry).

## Credit Notes (invoices.html, 2026-07-09)

Full/partial credit notes — pick any subset of an invoice's items, at any
quantity up to what's remaining (already-credited qty is tracked and
subtracted), with a required reason. Two explicit product decisions: a
credit note **automatically reduces** the source order's `Final Total`/
`Balance Due` (clamped at 0, doesn't touch `Invoice Status` — a credit
bringing the balance to 0 isn't the same as the customer having paid), and
it produces a **printable document** (same pattern as the invoice PDF, red
"CREDIT NOTE" watermark, referencing the original Invoice No), not just a
table row.

**Backend (`orders_code.gs`):** new `createCreditNote`/`listCreditNotes`
actions, `getOrCreateCreditNotesSheet_()` (auto-creates a "Credit Notes" tab,
same pattern as `ensureAdminColumns_`), `getNextCreditNoteNo_()` (CN-000001,
counter in row 2 of the "Settings" tab, alongside `LastInvoiceNo` in row 1).
GST math is **not** recomputed server-side — `createCreditNote_()` just
persists whatever `items`/`taxableValue`/`cgst`/`sgst`/`igst`/`totalGst`/
`totalAmount` invoices.html sends (same pattern as `addItemToOrder_`/
`confirmOrder_` — this script deliberately never duplicates Catalog data).

**Frontend (`invoices.html`):** `computeCreditPreview(o, selections)` takes
`computeInvoiceTax(o)`'s exact per-line taxable/GST (already computed for
the full invoice) and scales each line by `creditQty / originalQty` — so a
2-of-5-units credit carries exactly 2/5 of that line's real taxable value
and GST, not a re-derived estimate. "Already credited" per item is computed
by summing `creditNotes` matched on **Invoice No** (not `rowIndex` —
Invoice No survives `admin.html`'s "Update order" versioning since
`snapshotOrder_` copies it through unchanged, so credit history stays
correct even after an order gets a new version row). A modal
(`openCreditNoteModal`/`renderCreditNoteModal`) shows invoiced/already-
credited/remaining/credit-qty per item with a live GST preview; submitting
calls `createCreditNote`, updates local order state, and opens the printable
document via `printCreditNote()`/`buildCreditNoteHtml()`. Each invoice row
shows a credit-note count linking to `openCreditNoteList()` (view + reprint
past notes) — full invoice list stays visible regardless, same non-
destructive-filtering principle as the deep-link feature above.

**Requires a new Orders deployment** (per the gotcha above) before
`createCreditNote`/`listCreditNotes` work live — `connect()` in
`invoices.html` tolerates `listCreditNotes` failing (falls back to an empty
list) so the page still loads against an un-redeployed backend, just without
credit note data.

## v4 — Order/Invoice Fix Plan execution (2026-07-12)

Implements the full plan at `.cursor/plans/order_invoice_fix_plan_b8247d99.plan.md`
(11 user-reported issues + Issues A–K from a code review pass) across all
8 phases. This is the biggest single change since v3 — read this section
before touching money math, order identity, confirm/stock-decrement, or
invoice rendering again.

**Dual ID schema (Issue 8):** `Order ID` renamed to **`Order Ref`**
(internal UUID, assigned at creation, unchanged across version rows —
`getAllOrders()`/`snapshotOrder_()` now expose/use `orderRef`, not
`orderId`). New **`GAPL Order ID`** column: blank until confirm, then
`GAPL - MM/YY - 00001` from `getNextGaplOrderId_()` (counter resets to 1
each calendar month, tracked in columns C/D of the `Settings` tab —
`getNextInvoiceNo_`/`getNextCreditNoteNo_` still use A/B and A2/B2, no
collision). Assigned idempotently in `confirmOrder_()` — a retry never
mints a second ID for the same order.

**Column layout (Issue 7/D):** `Status` moved to the first position in
`FIXED_COLS` (was appended after every dynamic product column in the old
`ADMIN_COLS`, landing around column AN on a real catalog). New sheets get
the correct layout automatically from `doPost_logOrder()`'s header-sync.
**The live production sheet needs a one-time manual migration** —
`migrateSheetColumns_()` reorders everything (Status→A, `Order ID`→`Order
Ref`, inserts the new columns below) by rewriting the sheet in place,
matching on header name so no data is lost. **Back up the sheet (File >
Make a copy) before running it** — there is no scripted rollback.
`ensureIdentityColumns_()` was also fixed to insert missing identity
columns right after `Timestamp` instead of at the sheet's end — it's now
purely a legacy-sheet safety net, since `FIXED_COLS` already gets this
right for anything created after this change shipped.

**New order columns:** `Email` (Issue 4/J), `Total Qty` + `Est. Weight
(kg)` (Issue 2 — total qty is the sum of active line quantities, not a
distinct-product count; weight comes from the Catalog's new `Weight (kg)`
column, falling back to parsing `Pack Size` via `parseWeightFromPackSize_`
if blank), `Stock Decremented` (Issue A — see below), `Item Discounts
JSON` (Issue 1 — the real per-line discount %, see below), `Client Order
ID` (Issue 5 — see dedup below).

**Catalog `Weight (kg)` column:** appended at the *end* of `HEADERS` in
`catalog_code.gs` (not inserted mid-array like `Product ID` was) —
deliberately the lowest-risk migration: just add a column named exactly
that at the end of the sheet, no need to shift anything. Run
`backfillCatalogWeights_()` once to fill it in from existing `Pack Size`
values; rows that never get backfilled still resolve a weight at read time
via the same fallback parser.

**Unified GST math (Issue 1/10/C):** `admin.html`'s `computeOrderMath()`
(pre-GST subtotal/discount/"Payable", separately from a hardcoded
`/oil|ghee/i` regex GST calc inside `generateInvoice()`) is gone, replaced
by a single **`computeOrderTotals(o)`** that looks up each line's real
`gstPct`/`hsn` from the live Catalog and produces the full
subtotal→discount→taxable→CGST/SGST/IGST→grand-total breakdown, plus a
`lineItems` array in the exact shape `buildInvoiceHtml` expects. Used by
the pricing panel (now labeled Subtotal→Discount→Taxable→GST→**Total
payable**, GST-inclusive), `generateInvoice()`, the WhatsApp/email confirm
drafts, and `amountDue(o)` (post-invoice: the frozen `o.finalTotal`;
pre-invoice: the live `computeOrderTotals(o).grandTotal` — always
GST-inclusive either way, so there's no pre/post-GST number mismatch for
an admin to notice). `updateOrder()`/`snapshotOrder_()` in `orders_code.gs`
both now refuse to let a generic field update regress `Final Total` once
`Invoice No` is set — except `generateInvoice()`'s own update call, which
opts in via `allowFinalTotalUpdate: true` since re-invoicing is the one
legitimate way to change it (including on a reprint after items changed).

**Per-item discount persistence (Issue 1, partial fix on the v3
approximation above):** `admin.html` now writes `Item Discounts JSON` (`{
waKey: discountPct }`) on every save. `invoices.html`'s
`computeInvoiceTax()` uses it directly when present instead of allocating
the order-level `Discount Amount` aggregate proportionally by gross value —
that proportional-allocation fallback still exists and still runs for
**legacy rows saved before this shipped** (they'll never gain a persisted
per-item breakdown retroactively). `computeCreditPreview()`'s dependency on
`computeInvoiceTax()`'s exact output shape (`waKey, qty, hsn, taxable,
gstAmt, cgst, sgst, igst`) was preserved — credit notes still work
unchanged.

**Issue K — removed "Save changes":** it was a strict subset of "Update
order" (same field payload via the generic `update` action) minus version
history, the entire point of the versioning feature. `saveOrder()` and its
button are gone; "Update order" (`snapshotOrder`) is the only save path
now.

**Confirm modal (Issue 9) + retry-safe stock decrement (Issue A):**
clicking "Confirm order" now opens a modal (`openConfirmModal`) showing
total qty/est. weight/discount/total payable, with a WhatsApp/Email/Both/
**Skip** choice (Skip is a real first-class option — confirming without
sending anything is allowed, e.g. walk-ins or already-called customers).
The standalone "WhatsApp confirmation" button is gone, folded into this
flow. Backend: `confirmOrder_()` is now guarded by the new `Stock
Decremented` column, not `Status`— so **this resolves the v3 "no automatic
retry if decrementStock fails mid-confirm" follow-up**: a failed attempt
leaves `Stock Decremented = "N"` and stays retryable (surfaced in
`admin.html`'s Status panel as an explicit "Retry stock decrement" button
when `Status=Confirmed` but `stockDecremented` is false), while a
succeeded one is a safe no-op on re-confirm.

**Dedup (Issue 5/G) — this resolves the v3 "`_dup` doesn't know about
Order ID" follow-up:** `index.html`'s `sendWhatsApp()` now disables the
submit button for a cooldown after a valid submission and sends a fresh
`clientOrderId` (UUID) each attempt. `doPost_logOrder()` gained
`findRecentDuplicateOrder_()` — collapses an exact repeat of the same
`clientOrderId` within 10 minutes, or the same phone+total+item-set within
2 minutes (for older cached clients with no `clientOrderId`), returning the
existing row instead of appending a new one. `admin.html`'s
`flagDuplicates()` now excludes rows that only share an `Order Ref` (i.e.
version-history rows of one order no longer flag as duplicates of
themselves), and the order list defaults to showing only the latest
`Version` per `Order Ref` (`latestVersionsOnly()`), with a "Show version
history" toggle to reveal every version as its own card. Status
counts/revenue in the stats bar always use the latest-version set
regardless of the toggle, so a versioned order never double-counts.

**`index.html` (Issue 4):** the `#sendCopy` checkbox and its second
`wa.me` tab (to the customer's own number) are gone — only one tab opens,
to the business number. Added an optional `Email` field (validated only if
non-empty) and a check that the entered phone isn't the business's own
number (`8338962474`), which used to cause both WhatsApp tabs to open the
same chat.

**Invoice module unification (Issue 11):** `buildInvoiceHtml`/
`numberToWords`/`ORDER_FORM_URL` extracted into a new shared
`invoice-shared.js`, loaded by both `admin.html` and `invoices.html` — the
printed invoice is now byte-for-byte the same regardless of which page
generated it. `invoices.html` gained a per-row "View"/"Hide" toggle that
expands an inline detail panel (line items, GST split, payment status) plus
a "Print / Reprint invoice" button (`buildInvoiceFromOrder()` +
`reprintInvoice()`) — no more forced round-trip to `admin.html` just to see
or reprint an invoice. The admin.html→invoices.html deep link
(`openInInvoices()`) now also auto-expands the target row's detail panel,
not just highlighting it.

**Cumulative partial payments (Issue F):** `recordPayment_()`'s
`amountPaid` parameter is now **this payment's amount**, added onto
whatever `Amount Paid` already holds — previously it overwrote the column
absolutely, so a second partial payment silently erased the first. Returns
the new cumulative `amountPaid` so `admin.html` can update its local state
correctly. The payment form's input label changed from the ambiguous
"Amount paid" to "This payment", with a hint showing what's already been
recorded — it already defaulted to the remaining balance, so this aligns
the label with behavior that existed on the frontend but not the backend.

**Admin key rotation (Issue H):** `purnavah-admin-2026` is hardcoded in 5
places — `admin.html`, `invoices.html`, `products.html` (the `adminKey`
input's `value=` default) and the `ADMIN_KEY` constant in both
`orders_code.gs` and `catalog_code.gs`. `index.html` has no admin action
and doesn't contain it. To rotate: (1) pick a new key, (2) update
`ADMIN_KEY` in both `.gs` files and redeploy **both** as new deployments
(editing an existing deployment doesn't reliably take effect — see the
gotcha above), (3) update the default `value=` in all three admin HTML
pages, (4) redeploy/republish the static site. There's no secrets vault or
per-admin key here by design (single shared key, matching how this was
built) — rotation is a manual, all-at-once operation, not a rolling one.

**Known follow-ups still not built:** no UI to view/diff two order
versions side by side (only view them as separate cards); `Credit Note`
still has no invoice-status UI path of its own (credit notes are a
separate document/sheet, not an `Invoice Status` value); per-item discount
history for rows saved before Phase 1 can't be reconstructed, only
allocated proportionally; `backfillGaplOrderIds_()` assigns legacy
already-confirmed orders a GAPL ID dated to *when the backfill runs*, not
when they were actually confirmed (this script doesn't track a separate
confirm-date field).

**Deployment checklist:** both `orders_code.gs` and `catalog_code.gs`
changed — both need **new deployments** (per the gotcha above), with the
URLs updated in every HTML page that references them. One-time manual
steps in the Apps Script editor, in this order: back up the Orders sheet,
then `migrateSheetColumns_()`, optionally `backfillGaplOrderIds_()`; on the
Catalog sheet, add the `Weight (kg)` column at the end, then run
`backfillCatalogWeights_()`.

## v5 — Separate Invoices sheet, required email, "Revised" version marker (2026-07-12)

User-requested follow-up to v4, same session. Three changes:

**Email is now required** on `index.html` — was optional as of v4's Phase 5;
`sendWhatsApp()` now rejects an empty email the same way name/phone/pincode
are rejected.

**Invoice/payment data moved to a separate "Invoices" sheet.** Previously
these lived as `ADMIN_COLS` on the Orders sheet itself (v2). Now they're a
new auto-created **"Invoices"** sheet tab —
`Order ID | GAPL Order ID | Customer Name | Order Status | Invoice No |
Invoice Date | Invoice Status | Invoice Sent Date | Amount Paid |
Balance Due | Payment Mode | Payment Ref | Payment Date` — joined back to
the Orders sheet by **Order ID** (= Orders' `Order Ref`, the stable UUID
that survives version bumps, so one Invoices row covers every version of
an order with no copying needed). `Final Total`, `Discount %`/`Discount
Amount` stayed on the Orders sheet — only invoice-lifecycle metadata and
payment fields moved.

- **`Order Status`** on the Invoices row is **live-synced**, not a frozen
  snapshot — every place that changes an order's `Status` on the Orders
  sheet (`updateOrder()`, `confirmOrder_()`, `snapshotOrder_()`) also calls
  the new `upsertInvoiceRow_(orderRef, {...})` to mirror it. This was an
  explicit choice over a simpler frozen-snapshot alternative — it means
  reporting off the Invoices sheet alone shows each order's current status,
  at the cost of every status-changing code path needing to remember to
  call `upsertInvoiceRow_`. A row is only ever **created** the first time
  `"Invoice No"` is set for an Order Ref (a pure status-sync call for a
  never-invoiced order is correctly a no-op, not a blank orphan row) — see
  `upsertInvoiceRow_()`'s gating logic.
- **`getAllOrders()`** reads the Invoices sheet once per call
  (`getInvoiceDataByOrderRef_()`) and merges each order's invoice/payment
  fields into the same object shape as before — **`admin.html` and
  `invoices.html` needed zero client-side changes** for reading. Writes are
  similarly transparent: `updateOrder()` now routes any field in
  `LEGACY_INVOICE_COLS` to `upsertInvoiceRow_()` instead of writing an
  Orders-sheet column that no longer exists, so `generateInvoice()`'s
  existing payload (still sends `"Invoice No"`, `"Invoice Date"`, etc. in
  one `action:'update'` call) keeps working unchanged.
- **`recordPayment_()`** now reads/accumulates `Amount Paid` from the
  Invoices sheet (by Order Ref) instead of the Orders sheet, and returns an
  explicit error — `"No invoice found for this order"` — if called before
  an invoice exists, rather than silently creating a phantom row.
- **`createCreditNote_()`** still reduces `Final Total` on the Orders sheet
  (by `rowIndex`, unchanged) but now reduces `Balance Due` on the Invoices
  sheet (by Order Ref) — the two fields split across sheets per the same
  boundary as everything else.
- **`hasInvoice_(orderRef)`** replaces the old "check the Orders sheet's own
  `Invoice No` column" logic everywhere that mattered (`updateOrder()`'s
  Final-Total guard, `snapshotOrder_()`'s carry-over guard).

**Migration for an existing Orders sheet with invoice/payment data
already in it:** run `migrateOrdersInvoiceDataToInvoicesSheet_()` **first**
— copies every row with a non-blank `Invoice No` into the new Invoices
sheet by Order Ref, without touching the Orders sheet. *Then* run
`migrateSheetColumns_()` (already updated to recognize
`LEGACY_INVOICE_COLS` as columns to drop, not product columns to keep) to
actually remove the old columns from Orders. Back up first, same as any
other `migrateSheetColumns_()` run.

**"Revised" status marks superseded versions.** `snapshotOrder_()` (the
"Update order" action) already appended a new version row and left the old
one untouched — old and new both showed whatever `Status` they last had,
which could look identical and confusing without cross-referencing
`Version` numbers. Now the **source row's `Status` is set to `"Revised"`**
the moment a new version is appended, and the Invoices row (if any) is
live-synced to the **new** version's real status, not `"Revised"` — a
version bump isn't itself a business-status change. `admin.html` gained a
`Revised` entry in `ORDER_STATUSES` (muted/stone color, no `next`
transitions) and added it to `LOCKED_STATUSES` (no item/discount editing,
no Update-order/Generate-invoice buttons — a locked-note points to the
latest version instead). This is a persisted, sheet-visible marker in
addition to (not instead of) `admin.html`'s existing client-side
`latestVersionsOnly()` collapsing from v4 — someone reading the raw sheet
directly, or another tool querying it, can now tell a row is superseded
without knowing about Order Ref/Version at all.
