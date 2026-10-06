# Review prompt: Purnavah order/pricing fixes

You are reviewing a set of diagnosed issues and proposed fixes for a live production
system (Purnavah — GAPL's order form + admin tooling, built on Google Sheets +
Apps Script). No code has been changed yet — this document is the investigation
output, to be reviewed **before** any implementation happens.

**Your job:** for each issue below, (1) verify the root-cause claim by reading the
cited files/lines yourself, (2) judge whether the proposed fix is correct, complete,
and safe given this is live financial/order data, and (3) flag anything the proposed
fix misses, especially edge cases, backward compatibility with existing sheet rows,
and interactions between fixes (several touch the same functions). Where you
disagree with a root cause or a fix, say so explicitly and explain why — do not
just rubber-stamp this document.

Relevant files:
- `index.html` — customer-facing order form
- `admin.html` — order admin (pricing, GST, invoicing, confirm/ship/pay)
- `invoices.html` — invoice list/reprint, shares `invoice-shared.js`
- `invoice-shared.js` — shared invoice HTML renderer + UPI link builder
- `google-apps-script/orders_code.gs` — Orders sheet backend (Apps Script)
- `google-apps-script/catalog_code.gs` — Catalog sheet backend (Apps Script)
- `google-apps-script/ORDER_INVOICE_LIFECYCLE.md` — prior design history or order/invoice fields

---

## Issue 1 — Pack size does not default to "1 kg"

**Finding:** `index.html:394`, inside `renderProductGrid()`:
```js
selectedVariant[gid] = group.variants[0].id;
```
The default selected pack-size variant for a product tile is whichever row happens
to come first in `group.variants`, which is derived from `PRODUCTS` array order —
itself just the row order of the Catalog Google Sheet. There is no rule preferring
"1 kg" (or any specific size) today.

**Proposed fix:** when initializing `selectedVariant[gid]`, prefer the variant whose
normalized pack size equals "1kg" (case/whitespace-insensitive compare, since the
sheet has inconsistent spacing like "1kg" vs "1 kg"), falling back to
`group.variants[0]` when no such variant exists in that product's group (e.g.
products only sold in grams, ml, or bundles).

```js
function normalizePackSize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}
function pickDefaultVariant(variants) {
  return variants.find(v => normalizePackSize(v.packSize) === '1kg') || variants[0];
}
// in renderProductGrid():
selectedVariant[gid] = pickDefaultVariant(group.variants).id;
```
Also update `updateVariantDisplay`/the `<select>`'s initial `value` (or re-render
after setting `selectedVariant`) so the dropdown UI reflects the new default, not
just the internal state.

**Review questions:** Does the pack-size dropdown's rendering (line ~400-404) need
the `<option selected>` attribute set explicitly, or does it rely on
`selectedVariant`/`updateVariantDisplay` alone? Check whether `<select>` picks
option 0 by default regardless of `selectedVariant`, which would make this fix a
no-op unless the dropdown's selected option is also driven from `selectedVariant`.

**Review verdict (confirmed + fix incomplete):** `index.html:394` verified exactly.
Answering the review question directly: yes, the `<select>`'s `.value` must be set
explicitly — `updateVariantDisplay()` (lines 473-491) never touches the select
element at all. Proof this is required, not optional: `resetForm()`
(`index.html:727-735`) already does exactly this by hand —
`selectedVariant[gid] = group.variants[0].id;` **and**
`select.value = group.variants[0].id;` — so the DOM-sync step is a known
requirement in this codebase already, just not centralized.
**Required addition:** `resetForm()` hardcodes `variants[0]` independently of
`renderProductGrid()`. If only `renderProductGrid()` is updated to call
`pickDefaultVariant()`, the 1kg default will hold for the first order per page
load but silently revert to arbitrary-first-variant on every order after that,
since `resetForm()` runs after every successful WhatsApp submission and has its
own separate hardcoded default. `resetForm()`'s two `variants[0]` references
must also call `pickDefaultVariant(group.variants).id`.

---

## Issue 2 — Coupon discount rendered as if it were a product line item

**Finding:** Data layer is fine — `couponCode`/`couponValue` are separate fields on
the order payload (`index.html:693-694`), never merged into `items{}`. The problem
is purely presentational: `updateSummary()` (`index.html:512-558`) renders the
coupon row with the identical `.summary-item` div markup used for real product
lines (compare line 533-536 vs 543-546) — same class, no divider, no heading — so
visually it reads as just another item in the list.

**Proposed fix:** give the coupon (and delivery) rows a visually distinct block,
separated from the items list by a divider/heading, e.g.:
```html
<div class="summary-items">...product rows...</div>
<div class="summary-discounts">
  <div class="summary-section-label">Discounts</div>
  <div class="summary-item summary-discount-row">Coupon ...</div>
</div>
<div class="summary-footer">Total</div>
```
This is a CSS/markup-only change — no computation changes needed here (that's
Issue 3).

**Review questions:** Is a new `.summary-discounts` block the simplest approach, or
should this be folded into the Issue 3 restructuring so there's only one rewrite of
`updateSummary()` instead of two passes?

**Review verdict (confirmed, worse than stated):** Verified `index.html:512-558`
exactly. One thing the finding understates: `.summary-discount-val{color:var(--moss)}`
(line 107) is a no-op today — `.summary-item-val`, the base class every row
already has, is *also* `color:var(--moss)` (line 90). So there is currently zero
visual differentiation on the coupon row, not even color, despite the class name
implying there should be. Doesn't change the proposed fix, just means less of the
"already there" styling exists than the finding suggests.

---

## Issue 3 — Bill should be sectioned: Items → GST → Grand Total → then coupon deducted

**Finding:** `index.html` currently has no GST computation at all in the customer
order summary — it only does item subtotal → optional coupon deduction → delivery
→ total. GST math only exists downstream, in `admin.html`/`invoice-shared.js`
(`computeOrderTotals`, `buildInvoiceHtml`), which apply discount **before** GST
(discount reduces taxable value, standard practice for a legal GST invoice) — the
opposite order to what's being asked here for the customer-facing summary.

**Proposed fix (index.html order summary only):**
1. Render an "Items" section (unchanged product rows).
2. Render a "GST" section: sum `qty * mrp * gstPct/100` per item. **Requires the
   public catalog endpoint to expose `gstPct` to shoppers** — check whether
   `catalog_code.gs`'s public `?action=catalog` handler currently strips
   `gstPct`/`hsn` from the response (it's documented as "only shopper-facing
   fields"). If so, this fix has a dependency on a `catalog_code.gs` change to
   expose `gstPct` publicly (read-only, no admin-key gate needed for a tax rate).
3. Grand Total = items subtotal + GST (**no discount applied yet**).
4. After Grand Total, show "Coupon applied: −₹X" and delivery, then Final Payable.

**Explicitly out of scope / do not change:** the legal invoice math in
`invoice-shared.js`/`admin.html` (`computeOrderTotals`), which must keep applying
discount before GST for GST-compliance reasons. This issue is scoped to the
customer-facing order-summary widget only — flag clearly if the fix strays into
`invoice-shared.js`.

**Review questions:** Confirm whether `catalog_code.gs`'s public action already
includes `gstPct` (re-check the live field list — don't assume from memory) before
treating this as blocked. Also confirm the delivery-charge-threshold logic
(`FREE_DELIVERY_THRESHOLD`) should key off pre-GST, pre-discount subtotal as it
does today, or whether adding a GST section changes what "the order value" means
for that threshold.

**Review verdict (confirmed):** Verified directly in `catalog_code.gs` —
`handlePublicCatalog()` (lines 142-171) omits `gstPct`/`hsn`; the doc comment at
line 139 states this is deliberate. The dependency on a `catalog_code.gs` change
is real, not speculative. Minor precision note: `invoice-shared.js`'s
`buildInvoiceHtml()` does no tax computation at all — it's a pure renderer of a
pre-computed line-items array (the actual math lives only in `admin.html`'s
`computeOrderTotals` and `invoices.html`'s `computeInvoiceTax`). The "flag if the
fix strays into invoice-shared.js" warning is harmless but there's no computation
logic there to stray into.

---

## Issue 4 — All 3 live orders share the same GAPL Order ID

**Finding:** Verified directly against the live Orders sheet (`?action=list`):
three separate orders (`d46b6b47…`, `878e0a9d…`, `0e9df551…`), confirmed on three
*different calendar days* (23, 24, 27 July), all carry
`"gaplOrderId":"GAPL - 07/26 - 00001"`. Multi-day spacing rules out a same-instant
race condition. Tracing `getNextGaplOrderId_()` / `confirmOrder_()`
(`orders_code.gs:748-773`, `910-945`) line-by-line, the logic as written in this
repo is internally consistent and should produce 00001 → 00002 → 00003 (reads a
persisted counter in the "Settings" sheet, columns C/D, one row per month,
increments, writes back). Since live behavior contradicts that, the most likely
explanation is that **the Apps Script deployment behind the live Orders webhook is
running older code than this repo** — a stale/edited-not-redeployed deployment.
This exact failure mode (edit script → Deploy → Manage deployments → "New
version" → silently doesn't take effect on `/exec`) is already a documented,
previously-confirmed recurring issue for this exact script (see prior project
notes / `ORDER_INVOICE_LIFECYCLE.md` if it's referenced there).

**Proposed fix:**
1. **Operational, not code:** open the Apps Script editor bound to the Orders
   sheet, diff its `getNextGaplOrderId_`/`confirmOrder_` against
   `orders_code.gs` in this repo. If they differ, do a **brand-new deployment**
   (Deploy → New deployment → Web app), not an edit of the existing one, and
   update the live URL wherever it's referenced (`admin.html`, `index.html`,
   `invoices.html`).
2. **Defensive code fix regardless:** wrap the read-increment-write in
   `getNextGaplOrderId_()` in `LockService.getScriptLock()` so concurrent
   `confirmOrder_` calls can't race even if deploy staleness is later ruled out
   as the sole cause:
   ```js
   function getNextGaplOrderId_() {
     const lock = LockService.getScriptLock();
     lock.waitLock(10000);
     try {
       // existing read/increment/write logic
     } finally {
       lock.releaseLock();
     }
   }
   ```
3. **Data repair:** the three already-confirmed live orders need their
   `GAPL Order ID` cells manually corrected in the sheet (or via a one-off script)
   once the counter is fixed, since `confirmOrder_`'s idempotent check will not
   reassign an ID that's already non-empty.

**Review questions:** Is there a way to confirm deployment staleness more
directly (e.g., adding a temporary version-stamp log line and checking Apps
Script's execution log) before assuming it, since I could not inspect the live
deployed source directly? Should the lock's `waitLock` timeout/behavior on
failure (currently would throw and abort the whole `confirmOrder_` call) be
handled more gracefully?

**Review verdict (alternative root cause found — check this first):** The
deployment-staleness theory is plausible and the "editing an existing deployment
doesn't reliably take effect" gotcha is genuinely documented repeatedly in
`ORDER_INVOICE_LIFECYCLE.md` (lines 162-163, 388-389, 405-406). But there is a
more likely, and far cheaper to verify, cause the finding missed:
`getNextGaplOrderId_()` (`orders_code.gs:756-772`) stores the month key as the
**string** `"07/26"` via plain `setValue()`, with no `setNumberFormat("@")` ever
applied to that Settings-sheet column. Google Sheets auto-coerces strings that
look like dates when the cell format is Automatic — `"07/26"` is a textbook
trigger for that. If it silently becomes a Date instead of the literal string,
`monthCol.indexOf(monthKey)` (line 759) will **never** match the existing row, so
every confirm in the same month falls into the `rowIdx === -1` branch and creates
a **new** Settings row with the counter reset to `1` — producing "00001" on every
order in the same month, on any day, regardless of which deployment is live. This
fits the evidence (3 different days, all "00001") at least as well as staleness,
without requiring assumptions about code we can't inspect. Note
`getNextInvoiceNo_`/`getNextCreditNoteNo_` (lines 707-738) never hit this because
they key off a plain numeric cell (B1/B2) — only the GAPL ID counter uses a
date-shaped string as a lookup key.
**Action:** open the Settings sheet and check column C directly (right-aligned /
date-formatted, or multiple "07/26" rows each with counter 1) *before* attempting
to diff deployed vs. repo code — it's a 1-minute check vs. an unverifiable one.
Fix regardless: `settings.getRange(newRow, 3).setNumberFormat("@").setValue(monthKey)`.
The `LockService` wrap is good defense-in-depth but addresses a *third*, different
failure mode (true concurrency) that the multi-day evidence already rules out as
the primary cause — don't let it stand in as "the fix" without also checking the
above.
On the lock-failure question: yes, needs graceful handling, concretely because of
call order in `confirmOrder_` — `Status` is set to `"Confirmed"` (line 926)
*before* GAPL ID assignment (940-945) and *before* stock decrement (947+). If
`getNextGaplOrderId_()` throws on a lock timeout, the function aborts with the
order already flipped to "Confirmed" but with no GAPL ID and
`Stock Decremented` still "N" — a worse partial state than not confirming at all.
Wrap the lock call in its own try/catch with a clear admin-facing error, and
consider moving the Status write to the end of the function.

---

## Issue 5 — Order `878e0a9d-6954-4616-88f5-36373106d032` shows different values in different places (3987 vs 4340)

**Finding:** Root cause confirmed with direct evidence, not speculation.
`computeOrderTotals()` in `admin.html:988`:
```js
const product = CATALOG.find(c => c.waKey === name);
if (!product) { unknownItems.push(name); return; }
```
matches each order line item to a catalog product by **exact string equality on
`waKey`** (`displayName + " (" + packSize + ")"`), not by Product ID. I fetched the
live catalog (`?action=list` on the Catalog webhook) and checked all 17 items
stored on this specific order: **9 of 17 no longer match any current catalog
entry**, because their Display Name / Pack Size text has since been edited (in
`products.html`) after this order was placed:

| Order's stored item text | Current catalog text |
|---|---|
| `A2 Bilona Cow Ghee (1 L)` | `A2 Bilona (Desi Gir) Cow Ghee ` / `1 L` (renamed + trailing space) |
| `White Urad Split — Organic (500g)` | `Urad White Split - Organic` / `500 g` (word order + dash + spacing changed) |
| `Sesame Oil — Organic (500 ml)` | `Sesame Oil  — Organic` (double-space typo) / `500 ml` |
| `JeeraPhool Aromatic Rice (1 kg)` | `JeeraPhool Aromatic Rice — Chemical Free` / `1 kg` (renamed) |
| `VishnuBhog Rice (1 kg)` | `VishnuBhog Rice — Chemical Free` / `1 kg` (renamed) |
| `Whole Spice Bundle (6 sachets) — Organic` | `Whole Spice Bundle — Organic` / `6 sachets` (word order swapped) |
| `Ground Spice Bundle (4 sachets) — Organic` | `Ground Spice Bundle — Organic` / `4 sachets` (word order swapped) |
| `Red Rajma — Organic (500g)` | `Red Rajma  - Organic` / `500 g` (double-space + dash + spacing) |
| `Kabuli Chana — Organic (500g)` | `Kabuli chana - Organic` / `500g` (case + dash changed) |

Every unmatched item is silently excluded from `subtotal`/`taxable`/`totalGst`/
`grandTotal` (pushed into `unknownItems` instead), and separately, if
`unknownItems.length > 0`, invoice generation is hard-blocked
(`admin.html:1566-1568`: `"Cannot generate invoice — missing price for: ..."`).
This is why the pricing panel figure has drifted from the originally-quoted
`orderTotal`/`finalTotal` (3987) — it is recomputing from *today's* catalog state,
successfully pricing only 8 of 17 items, not reproducing what the customer was
actually quoted at order time. (Note: my own recompute of just the 8 matched items
came to ~2136, not 4340 — the exact 4340 figure may reflect a different catalog
state at the moment it was observed, or a different UI surface than
`computeOrderTotals`; the reviewer should re-check this figure against current
live data rather than trust the number verbatim, but the *mechanism* — text-based
matching silently breaking on catalog edits — is solidly confirmed regardless.)

**Proposed fix:** see Issue 6 — this is fixed by making product resolution use
Product ID instead of `waKey` text.

**Review questions:** Re-fetch the live catalog and order data at review time
(don't trust the numbers above as still-current) and re-verify the exact 4340
figure's origin — check `invoices.html` too, since it independently re-implements
similar pricing logic and may be where "4340" was actually observed rather than
`admin.html`'s pricing panel.

**Review verdict (confirmed):** Root mechanism verified directly against
`computeOrderTotals` (`admin.html:988-989`). The self-caveat about the unverified
"4340" figure is the right call — agreed, don't trust it without a live re-check.
No changes needed to this issue.

---

## Issue 6 — Products should always resolve via Product ID, not name/waKey

**Finding:** The data needed to do this already exists but isn't being used.
`confirmOrder_()` (`orders_code.gs:950-951`) already captures a
`{ "WA Key at order time": "PRD-XXXXXX" }` map into the "Product IDs JSON" column
at confirm time. However, `getAllOrders()` (`orders_code.gs:510-609`) **never
includes this field in its returned object** — admin.html has no access to it at
all today, which is why `computeOrderTotals` has no choice but to match by
`waKey`.

**Proposed fix (two parts):**

1. **`orders_code.gs`, `getAllOrders()`:** add the parsed map to the returned
   order object, e.g.:
   ```js
   productIdMap: parseJsonSafe_(row[adminIdx["Product IDs JSON"]]),
   ```
   (mirrors how `itemDiscounts` is already exposed one line below it).

2. **`admin.html`, `computeOrderTotals()`:** for each item name in `ed.items`,
   resolve the catalog product by ID first, falling back to `waKey` text match
   only when no ID is recorded (legacy orders confirmed before this column
   existed, or unconfirmed "New" orders that never went through `confirmOrder_`):
   ```js
   Object.entries(ed.items).forEach(([name, qty]) => {
     if (ed.oos.has(name) || ed.deleted.has(name) || qty <= 0) return;
     const productId = (o.productIdMap || {})[name];
     const product = productId
       ? CATALOG.find(c => c.productId === productId)
       : CATALOG.find(c => c.waKey === name);
     if (!product) { unknownItems.push(name); return; }
     // ...unchanged from here
   });
   ```
   Same pattern applies anywhere else that currently does
   `CATALOG.find(c => c.waKey === ...)` — search for all occurrences, not just
   this one function (e.g. `invoices.html` may duplicate similar logic; check
   before assuming `admin.html` is the only place).

**Review questions:**
- For **unconfirmed** orders (`Status = "New"`, never through `confirmOrder_`),
  `productIdMap` will be `{}` — confirm the fallback-to-`waKey` path is
  correct/acceptable there (there's no ID yet to use, so this is unavoidable, but
  worth stating explicitly rather than silently falling through).
- Since `Product ID` is stable but `waKey` isn't, should `Product IDs JSON` be
  captured earlier than confirm time (e.g. at order-log time in
  `doPost_logOrder`) so even "New" orders have IDs from the start, removing the
  fallback path's blast radius? This is a bigger change — flag it as a
  discussion point, not a required part of this fix.
- Does fixing this retroactively repair the 9 unmatched items on order
  `878e0a9d…`? No — that order's `Product IDs JSON` was captured at confirm time
  using the *old* `waKey` strings as map keys, which is fine (the map's keys are
  order-time text, values are IDs, and IDs don't change) — so yes, this fix
  should make all 17 items resolve correctly for that order once deployed,
  **provided** the live Orders deployment actually has this data captured
  correctly (tie-in with Issue 4's deployment-staleness concern — verify the
  live `Product IDs JSON` cell for this order actually contains a real map, not
  `"{}"`, before assuming the fix is sufficient on its own).

**Review verdict (fix sound, but retroactive-repair claim is not fully
supported):** Verified `getAllOrders()` (`orders_code.gs:510-609`) has no
`productIdMap` field and `confirmOrder_` does capture it (950-951) — the two-part
fix is correct as far as it goes.

The gap: the fix's soundness depends on `productIdMap` having actually captured
an ID at confirm time, and that capture is *itself* a waKey text-match against
the catalog, done client-side in `admin.html`'s `doConfirmOrder()`:
```js
// admin.html:1185-1194
await loadCatalog();              // refreshes CATALOG right before matching
...
const pid = productId(waKey);     // productId() = CATALOG.find(c => c.waKey === waKey), line 286-288
if (pid) productIdMap[waKey] = pid; else missingIds.push(waKey);
```
So if a product was renamed in `products.html` **before this order was
confirmed** (not just "before now," which is what the finding checked),
`productId(waKey)` would already have returned null at confirm time, and that
item's ID was never captured at all — `Product IDs JSON` is missing it, not
merely unexposed. No amount of exposing/reading `productIdMap` after the fact
repairs that; it would need a one-off manual data repair (matching old text to
the new catalog by other means, e.g. price/order-history) for that specific
item/order. The review question "does this retroactively repair order
878e0a9d's 9 items?" can't be answered "yes, provided deployment is fresh" — it
also requires confirming those renames happened *after that order's confirm
timestamp specifically*, which the finding doesn't establish. Check the live
`Product IDs JSON` cell for that order directly (as already suggested) but read
a negative result as "these renames predate this order's confirm — permanent gap
for this one order, needs manual repair" rather than only "redeploy and it's
fixed."

Additionally (see Issue 10's verdict below): the same `CATALOG.find(c =>
c.waKey === ...)` pattern also appears in `admin.html` at lines 282, 287
(`unitPrice`/`productId`), 1127 (`confirmAddItem`), and 1162
(`computeConfirmPreview` — feeds weight estimates, see Issue 10), plus
`invoices.html:421`. All six sites need the ID-first fix, not just
`computeOrderTotals`.

---

## Issue 7 — Coupon/discount has, at least once, been treated exactly like a removable product row

**Finding:** Direct evidence from the live Orders sheet: order `d46b6b47…`
(rowIndex 2) has `adminNotes` containing
`[Removed: Coupon Discount % on 24/07/2026]`, and its persisted
`itemDiscounts` JSON contains a `"Coupon Discount %": 0` entry sitting
alongside real product names (`"Mustard Oil — Regular (1 L)": 0`, etc.) — i.e.
the string "Coupon Discount %" (the *column name* for the coupon's stored
value) ended up as an *item key* in the per-item discount map, and someone
clicked the same "✕ Remove item" control on it that removes a real product
line (`admin.html:1090-1097`, `deleteItem(rowIndex, name)`).

I could **not** find a code path in the current `admin.html` that writes
`ed.items['Coupon Discount %']` or `ed.itemDiscounts['Coupon Discount %']`
directly — `getEdit()` (line 551-565), `applyOrderDiscount` (1100-1110),
`updateItemDisc` (1074-1078), and `confirmAddItem` (1120-1134) all key strictly
off real product names (`Object.keys(o.items)` / a matched catalog product).
Server-side, `getAllOrders()`'s `items` object is also confirmed clean (built
only from product columns, excluding `ADMIN_COLS` which includes the exact
string `"Coupon Discount %"`). This means either (a) an older/different
version of `admin.html` had this bug and has since been fixed, but the bad
data it wrote is still sitting in the sheet, or (b) there's a path I haven't
found. **Do not treat this as fully explained** — re-search the current code
(and check whether a different tool/script ever writes to this sheet) before
concluding it can't recur.

**Proposed fix (defense in depth, independent of finding the exact historical
cause):**
1. The items table's row-union logic (`admin.html:704-706`,
   `itemNames = Object.keys(o.items) ∪ Object.keys(ed.items)`) should
   explicitly exclude any name that matches an `ADMIN_COLS` value (or at
   minimum, exclude the literal coupon/discount column names) before
   rendering rows — so even if `ed.items` or `ed.itemDiscounts` ever gets a
   non-product key again, it physically cannot render as a fake item row with
   a working delete button.
2. This is the same fix Issue 2 needs — the coupon should never be
   representable as a name/qty/discount row at all; it should only ever be
   read from `o.couponCode`/`o.couponDiscountPct` and rendered as the
   dedicated banner that already exists at `admin.html:782` (which is correct
   — the bug is that *something else* also let it leak into the editable
   items table).
3. **Data repair:** strip the stray `"Coupon Discount %"` key out of the
   persisted `Item Discounts JSON` for order `d46b6b47…` (and scan all other
   orders for the same contamination) so `computeOrderTotals`/invoice
   generation don't carry a bogus zero-discount line item forward.

**Review verdict (confirmed, agree with cautious framing):** Independently
traced `getEdit`, `deleteItem`, `applyOrderDiscount`, `updateItemDisc`, and
`confirmAddItem` — agree that no current code path writes `"Coupon Discount %"`
as an item key, and the server-side `items` build already excludes `ADMIN_COLS`.
The "can't fully explain it, don't claim it can't recur" framing is the right
confidence level here — nothing to add or contradict.

---

## Issue 8 — Order card header shows pre-discount total ("order confirmed page" total is missing the discount)

**Finding:** `admin.html:682`:
```js
<div class="order-total">₹${(o.finalTotal || o.orderTotal || 0).toLocaleString('en-IN')}</div>
```
`orderTotal` is the raw pre-discount, pre-coupon item subtotal submitted by
`index.html` (`data.total`, computed *before* the coupon deduction — see
`index.html:641-648` vs the coupon-adjusted `payable` at line 651-656, which is
a local variable **never sent to the backend**). `finalTotal` starts blank/0 on
every new order (confirmed: `doPost_logOrder`'s row-building switch,
`orders_code.gs:464-492`, has no case for "Final Total" — it's explicitly left
blank on creation) and is only populated once an admin explicitly saves
changes or generates an invoice in `admin.html` (`generateInvoice()`,
line 1631-1649, or the analogous "Save changes" handler). Until then, the
card header falls back to `orderTotal` — the **undiscounted** figure — while
the WhatsApp message shown to the business at order-placement time
(`index.html:666`, `"Order Total: ₹${payable}"`) already reflects the coupon
discount. This is exactly the discrepancy reported: discounted total "on top"
(the order-placement WhatsApp message), undiscounted total on the order
card/"order confirmed page" until someone manually saves/invoices it.

**Proposed fix:** two independent options, pick one (or both) after review:
1. **Compute, don't rely on a stale persisted field:** change the card header
   to always show a live-computed discounted total
   (`amountDue(o)`/`computeOrderTotals(o).grandTotal`, already used elsewhere
   in this file) instead of `o.finalTotal || o.orderTotal`, so it reflects the
   coupon default the moment the order loads, with no dependency on a prior
   manual save. This matches how `amountDue()` already reasons about
   pre-invoice vs post-invoice state (`admin.html:1039-1042`) — reuse it here
   directly.
2. **Persist the true total earlier:** have `index.html` send the
   coupon-discounted `payable` as (or alongside) `Order Total`, so the raw
   sheet value itself isn't misleading even before any admin action. This
   changes what "Order Total" means historically, so cross-check anywhere else
   that reads `o.orderTotal` expecting the pre-discount figure (e.g. the
   `⚠ Recalculated subtotal ... differs from sheet's Order Total` warning at
   `admin.html:797-798`, which explicitly compares `totals.subtotal` — pre-
   discount — against `o.orderTotal`, so redefining `orderTotal` would need
   that comparison updated too).

**Review questions:** Prefer option 1 (compute live) unless there's a reason
the sheet's raw "Order Total" needs to reflect the discount for
reporting/export purposes elsewhere (check `invoices.html`'s summary/export
and any Google Sheets formulas the business may have layered on top of the
raw columns before assuming this is purely cosmetic).

**Review verdict (confirmed, two gaps to account for):** Verified exactly
(`admin.html:682-683`, `orderTotal` = pre-coupon `data.total` per
`orders_code.gs:478`). Two things option 1 needs to account for:
1. `computeOrderTotals(o).grandTotal` is **GST-inclusive but
   delivery-exclusive**; the WhatsApp order-placement total the customer saw is
   **GST-exclusive but delivery-inclusive**. Switching the header to option 1
   fixes "discount is missing" but the header number still won't numerically
   match what the customer was quoted — it'll differ by (GST − delivery). Be
   explicit with the user about which number the header should mean (amount
   legally owed vs. what the customer was told) before shipping, so this isn't
   reported as a second bug after the fix lands.
2. Same catalog-matching dependency flagged for Issue 11: if any item is in
   `unknownItems`, `computeOrderTotals` silently excludes it from `grandTotal`,
   so a live-computed header could *under*-total an order with a renamed
   product. The cross-cutting section calls this sequencing out for Issue 11
   but not for Issue 8 — it applies equally here and should be sequenced after
   the Issue 6 fix too.

---

## Issue 9 — Invoice shows no discount even though the discount was correctly sent to the customer

**Finding:** `invoices.html` has its **own separate** re-implementation of the
tax/discount computation, `computeInvoiceTax()` (lines 417-454), which reads
only `o.discountAmount` (an order-level aggregate) and `o.itemDiscounts`
(the persisted per-item JSON) — confirmed via grep that `invoices.html`
**never references `o.couponDiscountPct` or `o.couponCode` anywhere**. Both
`discountAmount` and `itemDiscounts` are blank/zero on the sheet until
`admin.html` explicitly persists them (via "Save changes" or
`generateInvoice()`, `admin.html:1644-1647`). The coupon-seeded default
discount only exists as **ephemeral client-side state** inside `admin.html`'s
`getEdit()` (line 560: `o.discountPct || o.couponDiscountPct || 0`) — it is
never true "on the record" until an admin's session running `admin.html`
happens to persist it. If an invoice is generated straight from
`invoices.html` (a separate page with no knowledge of coupons at all), or if
the admin.html save that would have persisted it never happened (e.g. because
of the Issue 7 "removed Coupon Discount %" scenario, or simply because
`sendConfirmWhatsApp`/`sendConfirmEmail` at confirm time don't persist
anything — they only read live-computed totals, they don't save them), the
invoice ends up computed with zero discount, contradicting what the customer
was already told.

**Proposed fix:**
1. `invoices.html`'s `computeInvoiceTax()` should fall back to
   `o.couponDiscountPct` (same precedence `admin.html`'s `getEdit()` already
   uses: persisted per-item → persisted order-level → coupon default) instead
   of silently treating "nothing persisted" as "no discount." Mirror
   `admin.html:560`'s fallback chain exactly so the two pages can't disagree.
2. More robust alternative: make `confirmOrder_()` (`orders_code.gs`) persist
   the coupon-derived `Discount %`/`Discount Amount`/`Item Discounts JSON` at
   **confirm time**, not leave it to whichever admin.html session happens to
   save later — so the discount is "on the record" the moment an order is
   confirmed, regardless of which page later generates the invoice. This is a
   bigger change (moves discount-application earlier in the lifecycle) — flag
   as a discussion point rather than assuming it's wanted without
   confirmation.

**Review questions:** Does fix option 1 alone fully resolve this, or does the
underlying "discount isn't real until someone happens to save it" design flaw
need option 2 regardless? Check whether `invoices.html` can generate an
invoice for an order that was never opened in `admin.html` at all (if so,
option 1 is necessary, not just nice-to-have).

**Review verdict (disagree with the root cause — likely not reachable as
described):** Checked exactly the review question above: can `invoices.html`
generate a new invoice independent of `admin.html`? No — every entry point is
gated on `o.invoiceNo` already being truthy:
- `filterInvoices()` (line 364): `if (!o.invoiceNo || !o.invoiceDate) return false;`
- `reprintInvoice()` (line 248): `if (!o || !o.invoiceNo) { toast('This order has no invoice yet'...)`
- `openCreditNoteModal()` (line 509): same guard.

`invoices.html` only ever *redisplays/reprints* an invoice already created by
`admin.html`'s `generateInvoice()` — and that function (`admin.html:1561-1650`)
calls `getEdit(o)` itself (line 1563) and unconditionally persists
`Discount Amount`/`Item Discounts JSON` from the live, coupon-seeded `ed` state
at generation time (lines 1644-1647). So by construction, any order that ever
reaches `invoices.html` should already have the correct discount on the sheet —
"generated straight from invoices.html, a page with no knowledge of coupons"
does not appear to be a reachable code path.

**Likely real bug instead**, same area, `admin.html:560`:
```js
const defaultPct = o.discountPct || o.couponDiscountPct || 0;
```
Classic "0 is falsy" bug: if an admin ever explicitly sets Discount % to
**exactly 0** (deliberately overriding/removing a customer's coupon) and saves,
then on the *next* fresh session/reload `o.discountPct` is `0` — falsy — so the
chain falls through to `o.couponDiscountPct` again, silently **reinstating** the
coupon discount the admin explicitly removed. This is the actual
"discount isn't a single source of truth" gap, and it lives in `admin.html`, not
`invoices.html`.

**Recommendation:** before implementing this fix as written, get a real example
of an invoiced order with a coupon that shows zero discount in `invoices.html`.
If one exists, it's very likely caused by the falsy-zero bug above — fix belongs
in `admin.html:560` (distinguish "never set" from "explicitly set to 0," e.g. via
a separate override flag, not a `||` chain on a number that can legitimately be
zero), not as duplicated fallback logic copied into `invoices.html`, which
wouldn't address the real cause and would propagate the same footgun into a
second file.

---

## Issue 10 — Wrong price/product name for some orders after confirmation (cross-reference)

**Finding:** Same root cause as Issues 5/6 — `waKey`-text-based catalog
matching breaks silently whenever a product's Display Name/Pack Size is
edited after orders referencing it were placed. This manifests in at least
three places independently, since each re-implements its own lookup:
`admin.html`'s `computeOrderTotals()` (line 988), `invoices.html`'s
`computeInvoiceTax()` (line 421), and — per Issue 11 below — would also affect
any per-item price shown in the WhatsApp confirmation message once that's
added. No new root cause here; this confirms the Issue 6 fix (resolve via
Product ID, exposed through `getAllOrders()`'s new `productIdMap` field) needs
to be applied to **all three** lookup sites, not just `admin.html`, or the bug
will simply resurface in `invoices.html`/the WhatsApp message while looking
fixed in the pricing panel.

**Review questions:** Grep both `admin.html` and `invoices.html` for every
`CATALOG.find(c => c.waKey === ...)` occurrence (there may be more than the
ones already cited) and confirm each is updated consistently, using the same
ID-first-fallback-to-name pattern.

**Review verdict (confirmed, one site missed):** Agree with the "one root cause,
three symptoms" framing. A fourth symptom this document doesn't catch:
`computeConfirmPreview()` (`admin.html:1156-1166`), used for the estimated
package weight —
```js
const product = CATALOG.find(c => c.waKey === name);
if (product) estWeight += qty * (Number(product.weightKg) || 0);
```
This feeds the confirm-modal preview, both `sendConfirmWhatsApp`/
`sendConfirmEmail` (via `preview.estWeight`), and gets **permanently persisted**
to the sheet's `Est. Weight (kg)` column via `confirmOrder_`. A renamed product
silently drops out of the weight estimate the same way it drops out of pricing.
Full grep result, all sites needing the ID-first fix: `admin.html` lines 282,
287 (`unitPrice`/`productId`), 988 (`computeOrderTotals`), 1127
(`confirmAddItem`, via `CATALOG_ACTIVE.find`), 1162 (`computeConfirmPreview`);
`invoices.html` line 421 (`computeInvoiceTax`). Six sites total, not two.

---

## Issue 11 — WhatsApp order-confirmation message shows no per-item price or discounted price

**Finding:** `admin.html:1408-1437`, `sendConfirmWhatsApp()`:
```js
let lines = activeItems.map(([name, qty]) => `• ${name} × ${qty}`).join('\n');
```
`activeItems` comes from `buildConfirmLines()` (line 1401-1406), which is just
`Object.entries(ed.items)` filtered for OOS/deleted/qty>0 — plain name and
quantity, nothing else. Meanwhile `computeOrderTotals(o)` (already called two
lines above, into `totals`) has already computed a full `totals.lineItems`
array with `price`, `discPct`, `discAmt`, and `amount` (taxable value) per
item — it's simply not used here. Only the final `totals.grandTotal` makes it
into the message. The identical gap exists in `sendConfirmEmail()`
(line 1439-1469, same `activeItems`-based `lines`).

**Proposed fix:** build the message lines from `totals.lineItems` instead of
`activeItems`, showing original price and post-discount price per item, e.g.:
```js
let lines = totals.lineItems.map(li =>
  li.discAmt > 0
    ? `• ${li.name} × ${li.qty} — ₹${li.price.toFixed(2)} each (₹${(li.amount / li.qty).toFixed(2)} after ${li.discPct}% off)`
    : `• ${li.name} × ${li.qty} — ₹${li.price.toFixed(2)} each`
).join('\n');
```
**Important interaction with Issue 10:** `totals.lineItems` only contains
items that successfully matched a catalog product — anything in
`totals.unknownItems` is silently absent. If this fix ships before Issue 6/10
is fixed, previously-fine messages (built from raw `ed.items`, which always
has every item) would start **silently dropping unmatched items** from the
confirmation message entirely, which is worse than the current no-price
version. **Sequence this fix after Issue 6/10's Product-ID matching fix**, or
add an explicit fallback line for anything in `unknownItems` (name × qty,
"price unavailable") so nothing silently disappears from what the customer
sees.

**Review questions:** Confirm the desired price format with the user before
implementing (per-unit price vs line total, whether to show both pre- and
post-discount, whether this should also apply to `sendConfirmEmail()` — the
finding implies yes, matching the existing pattern of these two functions
being near-duplicates of each other).

**Review verdict (confirmed):** Verified exactly (`admin.html:1401-1406,
1408-1437, 1439-1469`). The sequencing warning (must ship after Issue 6/10) is
correct and important — agreed, no changes.

---

## Cross-cutting review checks

- Issues 4 and 6 both touch `orders_code.gs` — sequence the deploy so both land
  in the same new deployment rather than two separate stale-deploy risks.
- Issue 6's `admin.html` fix and Issue 3's `index.html` fix are independent
  files/pages; no ordering dependency between them.
- **Issues 5, 6, and 10 are one root cause with three symptoms** (pricing
  panel, invoice line items, and — once Issue 11 ships — the confirmation
  message). Fix the Product-ID-first lookup once, as a shared/duplicated
  pattern in both `admin.html` and `invoices.html`, not just in the one place
  the bug happened to be first noticed. Do not mark this done after patching
  only `computeOrderTotals()`.
- **Issues 2, 7, 8, and 9 are one theme**: discount/coupon state is not a
  reliable single source of truth. It exists correctly as ephemeral in-memory
  state in `admin.html` the moment an order card is opened, but (a) can leak
  into the items table as if it were a product (Issue 7), (b) isn't reflected
  in the sheet's raw totals until an explicit save (Issue 8), and (c) is
  invisible to any other page/flow that doesn't go through `admin.html`'s
  `getEdit()` (Issue 9). Consider whether these four should be fixed together
  via one structural change (e.g., persist the coupon-derived discount at
  confirm time, per Issue 9's option 2) rather than four separate patches that
  might leave the underlying "discount isn't real until someone happens to
  save it" design gap in place.
- **Issue 11 depends on Issue 6/10 being fixed first** (see Issue 11's own
  note) — implementing it against the current `waKey`-based
  `computeOrderTotals()` would make already-broken orders silently lose items
  from the customer-facing message instead of just mispricing them.
- No git repository is in use for this project (confirmed: working directory has
  no `.git`) — there is no safety net for these edits. Recommend taking a manual
  backup of `admin.html`, `orders_code.gs`, `invoices.html`, and `index.html`
  before editing, and suggest to the user that this project would benefit from
  being put under git.
- After fixes land, run manual testing end-to-end (per the original request) —
  at minimum: place a test order on `index.html` and confirm 1 kg is
  preselected and the summary is sectioned correctly with the coupon shown as a
  distinct discount, not a line item; confirm it in `admin.html` and check the
  GAPL Order ID increments, the card header total matches the discounted
  amount immediately (no save needed), and the WhatsApp confirmation shows
  per-item pricing; edit that product's display name in `products.html`
  afterward and confirm `admin.html`'s pricing panel *and* `invoices.html`'s
  generated invoice still resolve it correctly via Product ID; generate the
  invoice and confirm the discount matches what was already sent to the
  customer.

---

## Review pass — summary of amendments (2026-07-28)

Full per-issue verdicts are inlined above (search "Review verdict"). Headline
changes to the plan before implementation starts:

1. **Issue 1** needs `resetForm()` updated too (`index.html:731,733`), or the
   1kg default only survives the first order per page load.
2. **Issue 4** — check the Settings sheet's column C directly first (likely
   auto-date-coercion of the `"MM/yy"` string key causing a fresh row +
   counter reset every confirm) before assuming/diffing deployment staleness.
   Fix needs `setNumberFormat("@")` on that column regardless of what else is
   done. Also fix the operation order in `confirmOrder_` (Status is set before
   ID assignment/stock decrement) so a lock-timeout doesn't leave a
   half-confirmed order.
3. **Issue 6** — the "retroactively repairs order 878e0a9d" claim is only true
   if that order's renames happened *after* its confirm timestamp, not just
   "after order placement." Verify before assuming the ID fix alone closes out
   Issue 5's specific order. Also: two more call sites found beyond the two
   already cited — see Issue 10's verdict for the full list of six.
4. **Issue 8** — option 1's live-computed total is GST-inclusive/
   delivery-exclusive, which still won't numerically match the
   GST-exclusive/delivery-inclusive WhatsApp-quoted total. Confirm with the
   user which figure the header should represent. Also needs the same
   Issue-6-first sequencing already called out for Issue 11.
5. **Issue 9 — likely wrong root cause.** `invoices.html` has no code path to
   generate a new invoice (every entry point requires `o.invoiceNo` already
   set), so "generated straight from invoices.html" doesn't appear reachable.
   Suspect the real bug is the `o.discountPct || o.couponDiscountPct || 0`
   falsy-zero fallback in `admin.html:560` instead. Get a concrete repro before
   implementing either proposed fix.
6. **Issue 10 / cross-cutting "one root cause"** — six `CATALOG.find(c =>
   c.waKey === ...)` sites need the ID-first fix, not two:
   `admin.html` 282, 287, 988, 1127, 1162 (`computeConfirmPreview`, which also
   silently drops renamed items from the persisted weight estimate — not
   previously listed), and `invoices.html:421`.
7. No git repo — strongly recommend `git init` plus commits between each
   issue's fix given how many of these touch the same shared functions
   (`computeOrderTotals`, `getEdit`, `getAllOrders`) — there is currently zero
   rollback path on live financial data.
