# Multi-Admin Workflow — Design Document

Status: **✅ §13 BUILT (dev-gated), 2026-09-15 — see §14 for what's done and what's still manual.**
§1-12 below describe a dropdown-based identity model that was built dev-gated on 2026-09-15, then
explicitly replaced by the user the same day with a different architecture (dedicated Super Admin
page, real per-admin passwords, per-admin filtering on more pages) — §1-12 are kept for history/
reference only; their identity/visibility model (§3/§4) is NOT what's live now. §13 is the design
this build followed; §14 records what was actually implemented and the manual steps (redeploy,
Admins-tab Password column, test) still needed before it can be exercised end-to-end.
Covers: `admin.html`, `invoices.html`, `products.html`, `finance.html`, `google-apps-script/orders_code.dev.gs`, `google-apps-script/catalog_code.dev.gs`, and the new `superadmin.html`.

## 1. Goal

Today, all four admin pages are single-user: one shared `ADMIN_KEY` password, one shared UPI ID
(`UPI_VPA` in `invoice-shared.js`), and no concept of "who is looking at this." This document
proposes making them multi-user for three people:

- **User A — Super Admin.** Sees every order, assigns orders to Admin B, Admin C, or keeps them.
- **User B — Admin**
- **User C — Admin**

The customer-facing order form (`index.html`) and the "order → WhatsApp to the business number"
step are **unchanged** — this is purely about what happens to an order after it lands in the
Orders sheet.

## 2. New concept: an "Admins" list

A new **"Admins" tab** in the Catalog spreadsheet (same spreadsheet that already has "Catalog" and
"Coupons" tabs — this mirrors the pattern already used for those, and was already scoped once
before for a Google-Sign-In login plan that was never built — see §7).

| Column | Example | Purpose |
|---|---|---|
| Admin ID | `superadmin`, `admin-b`, `admin-c` | stable key, never renamed even if display name changes |
| Name | "User A" | shown in dropdowns, WhatsApp messages |
| Role | `Super Admin` / `Admin` | drives permissions |
| WhatsApp Number | `91XXXXXXXXXX` | where assignment notifications get sent |
| UPI VPA | `admin-b@upi` | this admin's own payment-collection UPI ID (§6) |
| Active | `Y`/`N` | deactivate someone without deleting the row |

`catalog_code.gs` already owns Catalog + Coupons, so it gains one more read endpoint
(`?action=admins`) that both `admin.html`/`invoices.html`/`products.html`/`finance.html` and
`orders_code.gs` (cross-script call, same pattern as `confirmOrder → decrementStock`) can use —
this keeps a single source of truth instead of duplicating an Admins tab in the Orders spreadsheet.

## 3. Identity: how does a page know "who is using it right now"?

The request specifically describes a **dropdown**, not a per-person login: whoever opens the page
picks their name from a list before doing anything. That is a deliberate, much lighter-weight
design than the Google Sign-In plan recorded earlier (see §7) — worth being explicit about the
trade-off:

- **Dropdown-only (what's described here):** anyone who has the existing shared `ADMIN_KEY`
  can open any admin page and *claim to be* any name in the dropdown, including Super Admin.
  There's no real authentication of identity — it's a convenience selector, not a security
  boundary. Fine for three trusted people who already share one password today.
- **Real per-person login (Google Sign-In plan, already designed, not built):** would make the
  identity claim trustworthy, at the cost of the one-time Google Cloud Console setup already
  described in that plan.

**Decision (confirmed 2026-09-15):** build the dropdown version, keeping the existing shared
`ADMIN_KEY` exactly as-is — no new auth mechanism as part of this plan. Google Sign-In remains a
later hardening step if the trust-based dropdown ever becomes a problem (e.g. an admin denies
assigning themselves something), not part of this build.

Mechanically: each admin page keeps its existing `ADMIN_KEY` gate as-is, and after connecting,
shows a "Who are you?" dropdown (populated from the new Admins list) before the orders/products/
finance data loads. The chosen name is kept in `localStorage` so it persists across page reloads
on that device, and can always be changed via the dropdown.

## 4. Order assignment flow

1. Customer submits the order on `index.html` → WhatsApp message to the business number (Super
   Admin's number) + logged to the Orders sheet. **No change here.**
2. Every new order is implicitly **assigned to Super Admin** by default (nobody has to manually
   assign incoming orders before anyone sees them — Super Admin already sees everything).
3. `admin.html` gets a new **"Assigned to"** control at the top of the page, above the order list
   and above the existing status filter chips (`New`/`Confirmed`/.../`all` — see
   `admin.html`'s `currentFilter`/`setFilter`). It works like this:
   - **Super Admin** sees a dropdown of all admins + "All orders" + "Unassigned to me". Selecting
     a name filters the visible list to that admin's orders (or shows all).
   - **Admin B / Admin C** only ever see their own assigned orders — the dropdown is either
     locked to their own name or hidden entirely (their identity from §3 already determines this).
4. Each order card gets a new **"Assign to…"** control, visible **only to Super Admin**:
   - a small dropdown/button per card (or a bulk action) to assign/reassign the order to
     Super Admin, Admin B, or Admin C.
   - Assigning/reassigning is a normal write to the Orders sheet (new column, §5) — same
     save-and-refresh pattern as every other order edit today.
5. On assignment (or reassignment), Super Admin gets a **pre-filled WhatsApp message ready to
   send to the assigned admin** — same mechanical pattern as the existing customer-confirmation
   WhatsApp button (`sendConfirmWhatsApp` in `admin.html`): it opens a `wa.me/<admin's number>`
   link with the message text already filled in, and Super Admin still has to hit Send in
   WhatsApp themselves. **This is not a silent/automatic push notification** — nothing in this
   codebase talks to the WhatsApp Business API; every "send on WhatsApp" feature today is a
   click-to-open-prefilled-chat pattern, and assignment notifications would work the same way.
   Message content: order ref/customer name/item count + "New order assigned to you — please
   confirm ASAP", plus maybe a deep link if `admin.html` supports one (it already has an order
   deep-link scroll/highlight per the code comments).
6. From here, the assigned admin's day-to-day flow (confirm → invoice → pack & ship → deliver →
   payment) is **completely unchanged** — only *who* can see/act on the order differs.

## 5. Orders sheet changes

One new column, added the same way every other `ADMIN_COLS` entry is (auto-created on the sheet
if missing, per the existing pattern in `orders_code.gs`):

- **`Assigned To`** — the admin's stable `Admin ID` (not display name, so renames in the Admins
  tab don't orphan old orders). Blank/missing = defaults to Super Admin.

Not adding (kept out of scope unless you want it): a separate "assignment history" log. The
existing `Last Updated` column already gets stamped on every admin write, so a reassignment is
visible as "this order changed recently" even without a dedicated history — matches how the rest
of the sheet already treats edits (in-place, not versioned) apart from the one explicit
"Update order" versioning feature.

## 6. Per-admin UPI routing

Today, exactly one UPI ID is hardcoded (`UPI_VPA` in `invoice-shared.js`) and used everywhere:
the order-confirmation WhatsApp/email message, the confirm-modal preview link, and the invoice PDF
QR/link. The request is for each admin's *order confirmation to the customer* to carry **that
admin's own UPI ID** instead.

Proposed change:
- `buildUpiPayLink(amount, note)` gains a third parameter, the VPA to use, defaulting to the
  existing company `UPI_VPA` if none is supplied (keeps every non-admin-specific caller working
  unchanged).
- `sendConfirmWhatsApp` / `sendConfirmEmail` / the confirm-modal preview in `admin.html` look up
  the *assigned admin's* UPI VPA (from the Admins list, §2) and pass it in.
- **Open question worth deciding before building:** should the invoice PDF (`invoices.html` /
  `invoice-shared.js`'s `buildInvoiceHtml`) also switch to the assigned admin's UPI, or keep the
  single company UPI since the invoice is the formal GST document (`Sold By` stays
  "Greenharvest Agriculture Private Limited" either way — only the payment-collection UPI would
  differ, not the legal seller)? Recommend: **yes, keep them consistent** — a customer who pays
  the confirmation message's UPI and later opens the invoice PDF for the same order shouldn't see
  a different UPI ID and wonder which one is real.
- **Snapshot, don't re-look-up-live:** once an order is confirmed, the UPI VPA used should be
  **stored on the order** (new `ADMIN_COLS` field, e.g. `Confirming Admin UPI`), not recomputed
  from the Admins tab every time the invoice/confirmation is reopened. This matches the existing
  pattern for coupon %/item discounts — if an admin's UPI ID is edited later, past invoices
  shouldn't silently start pointing payments at a different account.

## 7. Relationship to the existing Google Sign-In plan

A prior session already designed (but did not build) replacing the shared `ADMIN_KEY` password
with real "Sign in with Google," including an "Admins" sheet tab very similar to §2 above. That
plan is a **superset** of the identity piece here: if it's ever built, its Admins tab and this
document's Admins tab should be **the same tab** (Role/UPI/WhatsApp columns just get added to it),
not two parallel admin lists. This document's dropdown-based identity (§3) is the
faster-to-build, lower-security path; the Google Sign-In plan remains available as a later
upgrade without redoing the Admins-list data model.

## 8. `invoices.html` and `finance.html`

- **`invoices.html`**: reads Orders + Catalog independently for CA/tax reporting. Should probably
  gain the same "Assigned to" filter as `admin.html` for consistency, so an admin can pull just
  their own invoices — low priority, doesn't block the core workflow.
- **`finance.html`**: P&L/expenses dashboard (revenue, credit notes, expenses). This is
  business-wide financial data, not per-order task data — recommend this stays **Super Admin
  only** (the "Who are you?" dropdown from §3 could simply not grant Admin B/C access to this
  page at all, or show a read-only "ask Super Admin" message). Needs an explicit decision, since
  nothing about the current page distinguishes roles at all.

## 9. Decisions (confirmed by user 2026-09-15, implemented as described)

1. **Reassignment is Super-Admin-only.** Admin B/C can never reassign an order to each other or to
   themselves — only Super Admin's "Assign to…" control writes `Assigned To`.
2. **Visibility is "my own orders only"** for Admin B/C — not read-only access to each other's
   orders. Enforced as a hard filter in `admin.html`'s `render()` / `invoices.html`'s
   `getFilteredByChip()`, not just a hidden control.
3. **No separate "claim" action.** Super Admin assigns to themselves via the same "Assign to…"
   control used for Admin B/C (selecting "Super Admin" from the dropdown) — no dedicated
   self-assign/claim button was built.
4. **`products.html` stays equal access for all three admins** — no write restriction was added;
   the identity dropdown there is cosmetic (keeps the shared "who am I" localStorage identity in
   sync across pages) and gates nothing.
5. **WhatsApp assignment notification includes a deep link** into `admin.html`, pre-filled with the
   Orders URL/key and an `orderRef` (matched by the stable Order Ref, not `rowIndex`) — scrolls to
   and expands that order once the page auto-connects. Same `wa.me/<number>?text=` click-to-send
   pattern as every other WhatsApp feature here (never silent/automatic).
6. **Invoice PDF also uses the assigned admin's UPI**, not just the WhatsApp/email confirmation —
   snapshotted once at `confirmOrder_` time (`Confirming Admin UPI`, idempotent like GAPL Order ID)
   and reused by both `admin.html`'s `generateInvoice()` and `invoices.html`'s
   `buildInvoiceFromOrder()`.
7. **`finance.html` is Super-Admin-only** in dev mode — Admin B/C see a "Super Admin only" message
   instead of the P&L dashboard. Off in prod (dev mode off), finance.html is fully open to whoever
   has the admin key, same as today.

## 10. Suggested build order (once this doc is agreed)

1. Admins tab in the Catalog sheet + `catalog_code.gs` `?action=admins` endpoint.
2. "Who are you?" dropdown on all four pages, `localStorage`-persisted.
3. `Assigned To` column in `orders_code.gs` (+ new deployment, per the known GAS redeploy gotcha)
   and the assign/reassign UI + filter dropdown in `admin.html`.
4. WhatsApp assignment-notification message (click-to-send, same pattern as customer confirmation).
5. Per-admin UPI routing through `buildUpiPayLink`, confirmation messages, and (pending the §6
   decision) the invoice PDF, with the snapshot-at-confirm-time field.
6. `invoices.html` assigned-to filter; `finance.html` access decision (§8).

## 11. Dev-mode gating (confirmed 2026-09-15) — build entirely behind `?dev=1`, zero prod impact

**Requirement:** every piece of this feature must only activate when dev mode is on. With dev mode
off, all four admin pages must behave **exactly** as they do today — same shared `ADMIN_KEY`, same
single UPI, no dropdown, no Assigned To column/filter — byte-for-byte the existing logic and flow,
undisturbed. This is a hard constraint on *how* the plan gets built, not a new feature of its own.

This is realistic here because of two independent layers that already exist in this repo, both of
which this feature reuses rather than inventing new ones:

**Layer 1 — separate dev spreadsheets/scripts.** `google-apps-script/catalog_code.dev.gs` and
`orders_code.dev.gs` are already bound to their own DEV Google Sheets, entirely separate from the
prod Catalog/Orders sheets (separate `ADMIN_KEY`, and the dev Orders script's `CATALOG_API_URL`
already points at the dev Catalog deployment, not prod — see each file's header comment). This
means the new **Admins tab**, the new **Assigned To** column, and the new `?action=admins` /
`decrementStock`-style cross-script calls only need to be added to the DEV sheets and
`*_code.dev.gs` files at first. The prod sheets (`catalog_code.gs`/`orders_code.gs`) and their
live spreadsheets are **not touched at all** until a specific piece is verified and explicitly
promoted — matching the dev→prod porting workflow already documented at the top of both `.dev.gs`
files ("make your changes here first ... Once verified, port the same change into catalog_code.gs
... and paste THAT into the live Apps Script project"). Even if a client-side gate below were ever
buggy, there is no assignment/UPI/Admins-tab logic on the prod backend to accidentally hit.

**Layer 2 — client-side `DEV_MODE` flag, extended to all four admin pages.** `index.html` already
has this (`DEV_MODE = new URLSearchParams(location.search).get('dev') === '1'`, gating
`CATALOG_API_URL`/`SHEETS_WEBHOOK_URL`). `admin.html`, `invoices.html`, `products.html`, and
`finance.html` don't have it yet (they take the Apps Script URL as a manual setup-bar text input
instead) — this plan adds the same `DEV_MODE` const to each:
- When `?dev=1` is **absent** (default): setup-bar URL fields default to the existing prod URLs,
  exactly as today. None of the new multi-admin UI renders — no "Who are you?" dropdown, no
  Assigned To filter/column, no per-admin UPI lookup, no Admins-tab fetch. Every existing code path
  (single shared `ADMIN_KEY`, single `UPI_VPA`, current order/invoice flows) runs completely
  unmodified — this plan must not touch that code path's behavior, only wrap new code around it.
- When `?dev=1` **is present**: setup-bar URL fields default to the DEV Catalog/Orders deployment
  URLs instead (same two URLs already wired into `index.html`'s `DEV_CATALOG_API_URL`/
  `DEV_SHEETS_WEBHOOK_URL`), and the new multi-admin UI/logic (dropdown, Admins-tab fetch,
  Assigned To filter + assign control, WhatsApp assignment message, per-admin UPI routing) is
  active — all of it talking only to the DEV deployments from Layer 1, never prod.

**How to apply when implementing each build-order step above:** every new UI element and every new
fetch call this plan introduces must be wrapped in `if (DEV_MODE) { ... }` (or equivalent —
conditional render/conditional endpoint call), never unconditional. Promotion to prod (making this
real for the three actual admins day-to-day) is a **separate, later, explicit step** — port the
verified `.dev.gs` changes into the prod `.gs` files, redeploy (new deployment, not edited — the
known gotcha), and only then remove or invert the `DEV_MODE` gates in the four HTML files. Don't
do that promotion as part of the initial build without being asked.

## 12. One-time manual setup needed before this can actually be tested

The code is in place, but three things only a human can do are still required — none of this
happens automatically:

1. **Redeploy the DEV Apps Script projects.** `catalog_code.dev.gs` and `orders_code.dev.gs` in
   the repo now have the Admins/`Assigned To`/`Confirming Admin UPI` code, but the *live* DEV
   deployments won't run it until you paste the updated file contents into each DEV Apps Script
   editor and create a **new deployment** (per the known "editing a deployment in place silently
   doesn't take effect" gotcha — see `MULTI_ADMIN_WORKFLOW_PLAN.md`'s sibling doc
   `project-purnavah-website-admin` memory, or just: Deploy → New deployment → Web app → Deploy).
   The DEV URLs already wired into the four HTML files' `DEV_CATALOG_API_URL`/`DEV_ORDERS_API_URL`
   consts assume the deployment URL doesn't change — if a new deployment gives a different `/exec`
   URL, update those consts too.
2. **Create the "Admins" tab.** Open the DEV Catalog spreadsheet's Apps Script editor, select
   `setupAdminsSheet` from the function dropdown, run it once. Then add one row per admin by hand:
   Admin ID (e.g. `superadmin`/`admin-b`/`admin-c`), Name, Role (`Super Admin`/`Admin`), WhatsApp
   Number (e.g. `91XXXXXXXXXX`), UPI VPA, Active (`Y`).
3. **Test via `?dev=1`** — e.g. `admin.html?dev=1`. Connect with the DEV admin key
   (`purnavah-admin-2026-DEV`). The "Who are you?" dropdown should appear once the Admins tab has
   at least one row.

## 13. MAJOR REVISION (2026-09-15) — dedicated Super Admin page + real per-admin passwords

**This section supersedes §3/§4's identity and visibility model.** The dropdown built in §1-12 was
a convenience selector, not a security boundary — anyone with the one shared `ADMIN_KEY` could
claim to be anyone. The user has now asked for something structurally different: a genuinely
separate, exclusive assignment page for Super Admin, and real distinct passwords per admin instead
of one shared key + a self-reported dropdown. **No code has been written for this revision — it is
still being scoped.**

### What's clearly decided

- **A new, separate, independent page exists only for Super Admin** (not `admin.html`) — working
  name `superadmin.html` until the user says otherwise. On it, Super Admin sees **every** order and
  assigns each one to an admin (same "Assign to…" mechanic already built, just relocated here).
  Confirmed 2026-09-15: the per-admin breakdown is a **filter**, not multiple simultaneous
  sections — Super Admin picks an admin (or "All") from a filter control and the order list narrows
  to that admin's orders, each shown with its current status. Same mechanic as the "Assigned to"
  filter already built into `admin.html` for Super Admin in the superseded version — it just moves
  to this new page instead.
- **Access to this new page is exclusive to Super Admin.** Admin A/B have no way into it at all —
  not even a locked-down/read-only view.
- **`admin.html`, `invoices.html`, AND `finance.html` all become hard per-admin-scoped** — confirmed
  2026-09-15: Admin A cannot access Admin B's data on any of these three pages, and vice versa (not
  just `admin.html`). Each page shows only the orders (or, for `finance.html`, the revenue/expenses)
  belonging to whichever admin is logged in. `products.html` is the one exception — stays
  equal-access for everyone (point 3 below).
- **Every admin gets their own distinct password** — Super Admin, Admin A, and Admin B each have a
  *different* credential, not one shared `ADMIN_KEY` plus a self-picked dropdown name. This is the
  part that turns identity from a convenience selector into an actual access boundary.

### Decisions (confirmed by user 2026-09-15)

1. **Real server-side enforcement.** Each admin's password is validated by the Apps Script backend
   itself, which then only returns/accepts that admin's own orders. A leaked or guessed password
   cannot be used to widen visibility beyond one admin's own data — this is a real backend change
   to `orders_code.dev.gs`/`catalog_code.dev.gs`, not a client-side-only distinction. Every action
   that currently checks `body.key !== ADMIN_KEY` needs to instead resolve *which* admin a
   submitted password belongs to (via the Admins tab, see point 5) and scope the response/mutation
   to that admin — `?action=list` for a non-Super-Admin password must only return orders whose
   `Assigned To` matches that admin's ID; write actions (`update`/`confirmOrder`/etc.) must reject
   or ignore attempts to touch an order not assigned to the authenticated admin.
2. **Super Admin uses both.** The new dedicated page (assignment/overview) AND `admin.html` (for
   orders assigned to Super Admin themselves, same day-to-day flow as any other admin) — Super
   Admin is not restricted to only the new page.
3. **`products.html` stays equal-access for all admins**, unchanged from the original §9 decision —
   no per-admin scoping, since there's no per-admin catalog data to scope.
4. **`finance.html` becomes multi-admin, not Super-Admin-only.** Admin A/B each see a finance view
   scoped to just their own assigned orders' revenue/expenses; Super Admin still sees the full
   company-wide P&L, separately. This reverses the earlier §9 "Super-Admin-only" decision for this
   page specifically — the access restriction on `finance.html` is gone; what changes per identity
   is which orders/expenses it aggregates over.
5. **Passwords live in a new `Password` column on the existing "Admins" tab** (§2) — one lookup
   covers both authentication and identity resolution (submit a password → backend finds the
   matching Admins-tab row → that row's Admin ID/Role scopes the rest of the request). Replaces
   `ADMIN_KEY` as the credential checked on every action; every request needs to carry a password
   instead of (or in addition to) the old shared key. **Confirmed 2026-09-15: Super Admin's
   password is just another row in this same Admins tab/Password column — no separate top-level
   check.** One uniform lookup path for all three identities; `Role` alone (`Super Admin` vs
   `Admin`) is what differentiates permissions/scope once the row is found.
6. **Build this dev-gated first**, same approach as §11 — behind `?dev=1`, against the separate DEV
   Apps Script deployments/spreadsheets, with prod (`admin.html`/`invoices.html`/`products.html`/
   `finance.html` with no `?dev=1`, and `catalog_code.gs`/`orders_code.gs`) completely unaffected,
   before ever promoting this live.
7. **Internal server-to-server calls keep a separate fixed secret, not a per-admin password.**
   `orders_code.dev.gs`'s `decrementStock` call into `catalog_code.dev.gs` (currently
   `key: ADMIN_KEY`, see line ~1002) is a backend-to-backend call, not a human login — rewriting
   every `body.key !== ADMIN_KEY` check into a password→Admins-row lookup must **not** touch this
   call. Introduce a distinct internal secret (e.g. `INTERNAL_KEY`, defined in both `.dev.gs` files
   the same way `ADMIN_KEY` already is) used only for this cross-script call, so it's decoupled
   from any individual admin's password and doesn't break if that admin's password is later
   rotated. (Confirmed 2026-09-15.)
8. **`finance.html`'s per-admin view is revenue-only.** Admin A/B's scoped finance view shows only
   the revenue attributable to their own assigned orders — no expense line, since expenses
   (packaging, delivery, misc.) aren't tied to any order or admin today and there's no attribution
   mechanism for them. The full company P&L, including expenses, remains a Super-Admin-only view
   (this reads as a narrower reversal of the original §9.7 "Super-Admin-only" call: Admin A/B now
   get *something* on this page, just revenue rather than full P&L). (Confirmed 2026-09-15.)
9. **Duplicate passwords across Admins-tab rows are rejected, not just documented.** Since identity
   is resolved by matching a submitted password against the Admins tab (point 5), two active rows
   sharing a password would make that lookup ambiguous — a real identity-collision bug, not just a
   sloppy setup. `setupAdminsSheet` (or the `admins`/auth-lookup code path) must validate that no
   two **active** rows share a password value and fail loudly (clear error, not a silent
   first-match) if they do. (Confirmed 2026-09-15.)

### Remaining items — implementation details, not open product decisions

All product-level decisions are now confirmed (points 1-9 above). What's left is ordinary
implementation judgment to apply while building, not something requiring another round of
questions: the new page's exact filename (default: `superadmin.html` unless told otherwise); the
precise shape of rewriting `body.key !== ADMIN_KEY` into a password→Admins-row lookup across every
admin-facing action in both `.dev.gs` files (excluding the internal `decrementStock` call, point 7
above); the exact name/value of the new internal secret constant (point 7); relabeling
`admin.html`/`invoices.html`/`finance.html`'s "Admin Key" field to "Password" and removing the now-
dead `localStorage` "Who are you?" dropdown code (§3, superseded); and `finance.html`'s per-admin
revenue-only view's exact layout/wording (can follow the page's existing style).

## 14. §13 BUILD LOG (2026-09-15) — what's actually in the repo now, and what's still manual

**This is BUILT, not just planned. Verify current code before re-describing it (grep first if this
feels stale).** Same dev-gating discipline as §11/§13 point 6: everything below lives only in
`*.dev.gs` and `?dev=1` code paths — `catalog_code.gs`/`orders_code.gs` (prod) and every page's
default (no `?dev=1`) behavior are untouched.

**Backend — `catalog_code.dev.gs`:**
- `ADMIN_KEY` renamed to `INTERNAL_KEY` — now used ONLY for server-to-server calls
  (`decrementStock`, `resolveAdmin`), never a human credential.
- `resolveAdminByPassword_(password)` — single lookup against the Admins tab's new `Password`
  column (added to `setupAdminsSheet()`'s header list), active rows only, throws a loud config
  error if two active rows share a password (point 9).
- `?action=whoAmI` (GET, any active admin's own password) — returns just the caller's own identity.
- `?action=admins` (GET) is now password-gated AND Super-Admin-role-gated, and strips `Password`
  from the response — it's the roster used only by `superadmin.html` now, not a client-picked
  dropdown.
- `doPost`'s `add`/`update`/`delete` (products.html) now require any active admin's password
  (equal access, point 3); `decrementStock`/`resolveAdmin` require `internalKey === INTERNAL_KEY`.

**Backend — `orders_code.dev.gs`:**
- `ADMIN_KEY` renamed to `INTERNAL_KEY` (point 7) — `decrementStock`'s payload now sends
  `internalKey`, never a password.
- `resolveAdmin_(password)` — cross-script POST to `CATALOG_API_URL`'s new `resolveAdmin` action
  (this script has no direct access to the Admins tab, same reason `decrementStock` is
  cross-script).
- `assertOrderAccess_(sheet, headers, rowIndex, admin)` — Super Admin unrestricted; every other
  admin can only touch a row whose `Assigned To` matches their own Admin ID. Called from
  `updateOrder`, `recordPayment_`, `addItemToOrder_`, `confirmOrder_`, `createCreditNote_` before
  any mutation.
- `updateOrder` additionally rejects any `fields["Assigned To"]` write from a non-Super-Admin
  (reassignment stays Super-Admin-only, §9 point 1, unchanged).
- `doGet`'s `list` action is now self-scoped for every identity, Super Admin included (blank
  `Assigned To` counts as Super Admin's). New `listAll` action (Super-Admin-only) returns every
  order unfiltered — used by `superadmin.html`. `listCreditNotes` scopes the same way, cross-
  referenced against each note's source order.
- `test*()` functions at the bottom now use a `TEST_ADMIN_PASSWORD` placeholder const — fill in a
  real Admins-tab password before running any of them from the Apps Script editor.

**Frontend — all four existing pages (`admin.html`, `invoices.html`, `products.html`,
`finance.html`):**
- "Admin Key" field relabeled "Password" (point: relabeling, done). The old
  `ADMINS`/`loadAdmins()`/`currentAdminId()`/`setCurrentAdminId()`/`isSuperAdmin()`/dropdown code
  (§3) is removed — replaced by `CURRENT_ADMIN` + `loadWhoAmI()`, resolved once at Connect via
  `?action=whoAmI`, plus a read-only "Logged in as X (Role)" bar (no picker).
- New `authParam()`/`authQuery()` helpers on every page: prod sends `key` (unchanged), dev sends
  `password` — same input field either way, only the wire field name differs by `DEV_MODE`.
- `admin.html`: the "Assign to…" control, its filter bar, and the WhatsApp assignment notification
  are REMOVED from this page entirely — relocated to `superadmin.html`. Client-side per-admin
  filtering in `render()` is gone too — the backend's `list` action already scopes it. A
  "Super Admin →" nav link appears only when `CURRENT_ADMIN.role === 'Super Admin'`.
- `invoices.html`: uses `listAll` when logged in as Super Admin (full GST/CA visibility, per this
  session's confirmed decision), `list` (self-scoped) otherwise. Client-side identity filter
  removed — same reasoning.
- `finance.html`: Super Admin still gets the full P&L (`listAll` + `listExpenses`, unchanged from
  today); Admin A/B get `list` (their own orders' revenue only) and skip the expenses fetch
  entirely — `#expensesCard`/`#profitCard`/`#catBreakdownSection`/`#logExpenseSection`/
  `#expenseTableContainer` are hidden for them (point 8/§13 point 4). Note: this page's Expenses
  data still comes from the local mock server (`local-server/`) by default, unrelated to this
  auth rewrite and NOT touched this session — see the page's own setup-hint.
- `products.html`: identity display only (no gating — point 3, equal access unchanged); same
  `authParam()`/`authQuery()` wire-format switch for its add/update/delete/list calls.

**New page — `superadmin.html`:** exclusive to Super Admin (any other identity, or a failed
password, sees an access-denied message, never a locked-down view). Fetches every order via
`listAll` and the full roster via `?action=admins`; a "Filter by admin" control (All / Super Admin /
each active admin) narrows the list without splitting it into sections (confirmed 2026-09-15). Each
order card has an "Assign to…" dropdown (writes `Assigned To` via the ordinary `update` action) that
fires the same click-to-open `wa.me` WhatsApp notification (deep-linking into `admin.html?dev=1`)
that used to live on `admin.html` before this revision. Always operates in "dev" terms (always
sends `password`, defaults its URL fields to the DEV deployments) since there is no prod counterpart
of this page at all.

### Manual setup still needed before this can actually be tested

Mirrors §12's pattern — none of this happens automatically:

1. **Redeploy the DEV Apps Script projects** — `catalog_code.dev.gs` and `orders_code.dev.gs` have
   the new code, but the *live* DEV deployments won't run it until you paste the updated file
   contents into each DEV Apps Script editor and create a **new deployment** (editing in place
   doesn't take effect — the known gotcha). If a new deployment gives a different `/exec` URL,
   update the `DEV_CATALOG_API_URL`/`DEV_ORDERS_API_URL` consts in all five HTML files (`admin.html`,
   `invoices.html`, `products.html`, `finance.html`, `superadmin.html`) and `orders_code.dev.gs`'s own
   `CATALOG_API_URL`.
2. **Add a `Password` column to the existing "Admins" tab** (re-run `setupAdminsSheet()` if the tab
   doesn't exist yet — it now creates the column; an existing tab needs the column added by hand)
   and fill in a real, distinct password per admin row — Super Admin's row included, same column, no
   separate mechanism. Passwords must be unique across active rows or every authenticated request
   will fail with the duplicate-password config error (point 9) until fixed.
3. **Decide/confirm the `INTERNAL_KEY` value** in both `.dev.gs` files (currently
   `purnavah-internal-2026-DEV` in both, must match each other) — rotate it if you want a value the
   old dropdown-build's `ADMIN_KEY` never was.
4. **Test via `?dev=1`** on the four existing pages, and `superadmin.html` directly (no `?dev=1`
   needed there — see above). Confirm: each admin's own password logs them into their own
   `admin.html` bucket; Super Admin's password unlocks `superadmin.html` and shows every order; a
   wrong/blank password is rejected; reassigning an order from `superadmin.html` actually moves it
   between buckets on `admin.html`.
