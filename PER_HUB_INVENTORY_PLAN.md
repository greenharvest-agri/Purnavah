# Per-hub product inventory (products.html) + invoice identity (invoices.html)

## Context

Right now the Catalog sheet has one global `Stock` number per product, and
`confirmOrder_` (orders_code.dev.gs) decrements it unconditionally on order
confirm, regardless of who the order is assigned to. In reality, stock is
split across physical hubs run by different admins — some products only
exist at one hub, quantities differ, and confirming/assigning an order
should draw down the stock of whichever hub actually fulfills it.

This plan replaces the single `Stock` column with one column per hub
(hub == the admin who runs it, per the "admin 1 = hub 1, admin 2 = hub 2"
framing — no separate "Hub" entity needed), adds a hub-filter dropdown to
`products.html` so any admin can browse any hub's assortment and stock
levels, and wires order confirm/reassignment to move stock in the
corresponding hub's column.

**Built entirely dev-gated** (`?dev=1`), same as the rest of the multi-admin
work — `catalog_code.gs`/`orders_code.gs` (prod) and prod `products.html`
behavior are untouched until this is verified and explicitly promoted.

**Scope note (2026-09-20):** this doc originally covered `products.html`
stock only. It now also covers `invoices.html` — dividing invoices hub-wise
(each hub sees only its own) and making the invoice's printed company
identity (legal name/address/GSTIN/email/website) hub-specific instead of
always "Greenharvest Agriculture Private Limited" — see "Hub naming" right
below and the "Invoices: hub-wise legal identity" section further down.

## Hub naming (confirmed 2026-09-20)
The three hubs now have fixed display names, used everywhere a hub is
shown to a user (invoices, `products.html` hub columns/dropdown,
`orderAssignment.html` filter/roster) — replacing the earlier placeholder
labelling style (`"Hub — Admin 1"`) referenced further down this doc:
- **Hub Central** = the Super Admin's own hub (the Admins-tab row with
  `Role = Super Admin`). This **resolves** the first judgment call below —
  Super Admin now has a real hub, not "no hub of its own."
- **Hub North** = one Admin (`Role = Admin`).
- **Hub South** = the other Admin (`Role = Admin`).
Which existing Admins-tab row becomes North vs. South, and adding a 3rd
row if only one `Role = Admin` row exists today, is a manual data-entry
step (see "Manual steps" below), not a code decision.

New `Hub Name` column on the Admins tab (`Admin ID | Name | Role |
WhatsApp Number | UPI VPA | Active | Password | Hub Name | ...`) holds this
label per row. `Name` stays the person's own name, unchanged — `Hub Name`
is the branch/location label shown instead of (or alongside) personal
names in hub-facing UI. Blank-safe: a row with no `Hub Name` filled in yet
just falls back to displaying `Name`, so nothing breaks before the user
gets to filling it in.

## Assigning to Hub Central (2026-09-20 revision — supersedes the old "blank = Super Admin" convention for this feature)

`MULTI_ADMIN_WORKFLOW_PLAN.md` §5 established: blank `Assigned To`
implicitly means Super Admin, and `orderAssignment.html`'s assign
dropdown/filter bar hard-code this — Super Admin is excluded from the real
admin roster everywhere on that page (`ALL_ADMINS.filter(a => a.active &&
a.role !== 'Super Admin')`) and picking "Assign to: Super Admin" always
writes `Assigned To: ""` (`orderAssignment.html`'s `renderCard`/
`assignOrder`). That convention predates Hub Central being a real hub and
breaks under this plan: `decrementStock_`/`moveStock_` need a real `hubId`
to find a `Stock: <hubId>` column, and `""` can never resolve to one — an
order "assigned to Hub Central" under the old convention could never
actually decrement Hub Central's stock.

**Fix:** `orderAssignment.html`'s roster-building code (`renderFilterBar`,
`renderCard`'s assign-dropdown `active` list, and the hardcoded
`<option value="">Assign to: Super Admin</option>`) stops excluding
`role === 'Super Admin'` — Super Admin appears in both the filter and the
assign dropdown as a normal roster entry, labelled with its `Hub Name`
("Hub Central"), and selecting it writes that row's real `Admin ID`, not
blank. `adminName(adminId)` no longer special-cases blank as "Super Admin"
— blank now means **unassigned**, full stop, handled by the "confirm
blocked unless assigned" rule below exactly like any other hub. Pre-
existing legacy orders with blank `Assigned To` (predating this feature)
keep showing up in Super Admin's own `admin.html` bucket for visibility/
read access (`doGet`'s `list` scoping, `!o.assignedTo || o.assignedTo ===
admin.adminId`, is unchanged) but can't be confirmed until Super Admin
explicitly (re)assigns them to a real hub — including to Hub Central
itself — through the now-normal assign dropdown.

## Decisions already confirmed with the user
1. **Deduct trigger**: order confirm, but confirm is blocked unless already assigned to a hub/admin.
2. **Reassignment**: moves stock — rolls back the old hub, deducts the new hub.
3. **Edit rights**: an admin can only edit their own hub's stock; Super Admin can edit any hub. Viewing every hub stays open to everyone (unchanged philosophy for read access).
4. **Migration**: every hub starts at 0; admins re-enter real per-hub counts by hand (the old combined number isn't a reliable source to split).

## Two judgment calls flagged for the user (easy to change before/after building)
- ~~Super Admin has no hub of their own.~~ **Resolved 2026-09-20** by the
  "Hub naming" decision above: Super Admin's hub is Hub Central, a real
  hub exactly like Hub North/South. Super Admin's row gets a normal
  `Stock: <Super Admin's Admin ID>` column, and confirming an order
  already assigned to Hub Central (`Assigned To` = Super Admin's own
  Admin ID) is a normal, expected case, not a "hub not found" edge case.
  The blank-`Assigned To` check at confirm time (below) is unchanged —
  it's still just "was this assigned to *any* hub yet," Hub Central
  included.
- **The products.html dropdown** lists "All hubs" (default, unfiltered)
  plus one real entry per active hub-admin **including Hub Central**, now
  that Super Admin has real stock like every other hub — labelled with
  that hub's `Hub Name` (e.g. "Hub Central" / "Hub North" / "Hub South",
  falling back to personal `Name` if `Hub Name` is still blank), not a
  generic "Hub — Admin 1" placeholder.

## Data model change (manual, in the Google Sheet UI)
The Catalog sheet's existing `Stock` column stays in place but is no longer
read by any code (harmless dead column — can be deleted later if desired).
For each active hub-admin (Admins tab — Role = `Admin` **or** `Super
Admin`, e.g. `admin-b`, `admin-c`, and the Super Admin row too, per
"Assigning to Hub Central" above), manually add a new column at the end of
the Catalog sheet
named exactly `Stock: <Admin ID>` (Admin ID must match that admin's row in
the Admins tab exactly). This follows the same manual-column convention
already used for `Weight (kg)` / `Max Order Qty (kg)`.
- **Blank cell** = product not sold at that hub at all.
- **`0`** = sold there, currently out of stock.
- Any other number = current stock at that hub.
Adding a future hub/admin later just means adding one more `Stock: <id>`
column — no code change needed.

## Backend: `google-apps-script/catalog_code.dev.gs`
- `rowToObject` (admin `list`): replace the flat `stock` field with
  `stockByHub: [{ adminId, name, stock }]` (built by reading each active
  hub-admin's `Stock: <adminId>` column; blank → `stock: null` meaning "not
  available here"; `0`/number → real value) plus `totalStock` (sum,
  treating `null` as 0).
- `handlePublicCatalog` (customer storefront, index.html): compute
  `inStock` from the **sum of every `Stock: ` prefixed column** instead of
  the old single `Stock` cell. No other change — index.html itself needs no
  edits, since it only ever consumed the `inStock` boolean.
- New GET action `?action=hubs` (password-gated like `list`, open to any
  active admin — not Super-Admin-only, unlike `?action=admins`): returns
  `[{ adminId, name }]` for **every active hub-admin row — Role=`Admin`
  and Role=`Super Admin` alike** (see "Assigning to Hub Central" above;
  excluding Super Admin here would silently drop Hub Central from
  products.html's dropdown/columns, contradicting the resolved judgment
  call below). Deliberately narrower than `handleAdmins` (no WhatsApp/UPI
  exposure) since every admin — not just Super Admin — needs this to
  populate products.html's dropdown and per-hub columns.
- `handleUpdate(body, admin)` — needs `admin` passed in from `doPost` (it
  currently only receives `body`). Add authorization: for any key in
  `body.fields` matching `Stock: <hubId>`, reject with an error if
  `admin.role !== 'Super Admin' && hubId !== admin.adminId`. This is the
  actual enforcement of "own hub only edit, Super Admin edits any" — the
  products.html UI will also disable those inputs client-side, but the
  server check is the real guard.
- `decrementStock_`: add a required `hubId` to the payload; target
  `Stock: <hubId>` instead of `Stock`. If that column doesn't exist for a
  given product (blank/not provisioned at that hub), report a per-item
  error the same way a missing product already does today — non-fatal to
  the batch, matching existing behavior.
- New action `moveStock_` (internalKey-gated, like `decrementStock`):
  `{ internalKey, action: 'moveStock', fromHubId, toHubId, items }` — under
  one lock, increments `Stock: <fromHubId>` (rollback) and decrements
  `Stock: <toHubId>` (deduct) for each item. Missing/blank fromHubId skips
  the rollback; a missing toHubId column surfaces as a per-item warning,
  same non-fatal philosophy as above.
- `doPost` router: pass `admin` into `handleUpdate`; add the `moveStock`
  branch next to the existing `decrementStock` one.

## Backend: `google-apps-script/orders_code.dev.gs`
- `confirmOrder_(body, admin)`: right after the existing
  `assertOrderAccess_` call (before any writes — Status, GAPL Order ID,
  etc.), read the row's `Assigned To` cell; if blank, return
  `{ status: 'error', message: 'Assign this order to a hub before confirming.' }`
  and do nothing else. Further down, where it already POSTs
  `action: 'decrementStock'` to the Catalog script (~line 1104), add
  `hubId: assignedTo` to that payload.
- The generic `update` action handler (~orders_code.dev.gs:684-768, the one
  that already special-cases `Assigned To` as Super-Admin-only at line 711):
  when `body.fields` changes `Assigned To` **and** the row's
  `Stock Decremented` is `Y`:
  - Capture the row's current `Assigned To` value as `oldAssignedTo` before
    overwriting it.
  - Reject if the new value is blank ("Can't unassign a confirmed order —
    reassign to a specific hub instead.").
  - After the field write succeeds, build `items` the same way
    `confirmOrder_` does (using the row's already-stored
    `Product IDs JSON` + current product-column quantities), and POST
    `action: 'moveStock'` to the Catalog script with
    `{ fromHubId: oldAssignedTo, toHubId: newAssignedTo, items }`. Log/report
    failures the same non-blocking way `confirmOrder_` already does for
    `decrementStock` (reassignment still completes even if the stock-move
    call fails — matches this codebase's existing "retryable, don't
    half-break the primary action" pattern).
  - **Also re-snapshot `Confirming Admin UPI` on reassignment** (fixes a
    gap found in review): today `Confirming Admin UPI` is written once,
    idempotently, at `confirmOrder_` time and never touched again — by
    design, so an admin editing their own UPI later doesn't retroactively
    change past invoices (`MULTI_ADMIN_WORKFLOW_PLAN.md` §6). But this
    plan's `d.hub` company-identity block is resolved **live** from the
    order's *current* `Assigned To` on every render/reprint — so after a
    reassignment the two would point at different hubs (new hub's
    letterhead/GSTIN, old hub's UPI payment target), which is a real
    problem once hubs are separate legal entities, not just a display
    inconsistency. Fix: in this same reassignment branch, after the
    `moveStock` call, overwrite `Confirming Admin UPI` with the new
    hub-admin's current UPI VPA (looked up from the Admins roster by
    `newAssignedTo`) — the one deliberate exception to the "idempotent,
    never re-written" rule, scoped only to the reassignment path, so the
    printed invoice's payment target always matches whichever hub's
    identity it's currently showing.
- No changes needed to `admin.html` — it already surfaces any
  `data.message` from a failed action as a toast (`doConfirmOrder` at
  admin.html:1658 already does `if (data.status !== 'ok') throw new
  Error(data.message)`), so the new "assign before confirming" error will
  show up automatically.

## Frontend: `products.html`
- At connect time, also call the new `?action=hubs` (alongside the existing
  `whoAmI`) to get the active hub roster.
- New dropdown in the toolbar: "All hubs" (default) + one option per hub
  (labelled with that admin's name). Selecting a specific hub filters the
  product list to rows where that hub's `stockByHub` entry is non-null
  (i.e., actually sold there) — "All hubs" shows everything unfiltered.
- Table: replace the single "Stock" column with one column per active hub
  (from the `?action=hubs` roster), always shown regardless of the filter
  selection, so any admin can compare hubs side by side. Each cell is an
  editable `<input>` when `CURRENT_ADMIN.role === 'Super Admin' ||
  CURRENT_ADMIN.adminId === hub.adminId`, otherwise a disabled/read-only
  input (still visible, just not editable) — mirrors the server-side rule
  in `handleUpdate` above. A blank cell displays empty (not "0"); typing a
  value (including `0`) makes that product "available" at that hub going
  forward.
- `saveRow`'s `fields` payload sends one `Stock: <hubId>` key per hub column
  actually present/editable in the row (never a key for a disabled cell —
  it already can't produce an `onchange` event to populate `editState`).
- Add-product panel: replace the single "Stock" field with one numeric
  field per active hub, same edit-permission rule as the table (only your
  own hub / Super Admin's are enabled), defaulting to blank.

## Invoices: hub-wise legal identity (confirmed 2026-09-20)

Today every invoice (`invoice-shared.js`'s `buildInvoiceHtml`) hardcodes
one company block no matter who confirmed the order: legal name
("Greenharvest Agriculture Private Limited"), address, GSTIN
(`22AALCG0905G1Z1`), email, and website — plus the same email/website
repeated in the footer "Thank you" note, and the company name reused as
the UPI payee name. **Confirmed with the user: Hub Central/North/South
are fully separate legal entities for invoicing** — each hub prints its
own Company Name, Address, GSTIN, Email, and Website on its own invoices,
not just a different address under one shared registration.

**Also confirmed: access scoping needs no change.** Hub North/South
(regular Admins) already only ever fetch `?action=list` on
`invoices.html` (their own assigned orders only) — this was already true
before this session. **Hub Central (Super Admin) keeps its existing
carve-out**: still fetches `?action=listAll` (every hub's invoices,
needed for GST/CA reporting across all three hubs) in addition to being
treated as Hub Central's own admin for orders assigned directly to it.
This update is about the printed company-identity block being correct
per hub, not a new restriction.

### Data model change (Admins tab, manual — same convention as `Hub Name` above)
Add these columns to the Admins tab, one value per hub-admin row
(Hub Central's row needs real values too — it's a normal hub now, same as
the stock section above):
- `Company Name` — the legal entity name printed on that hub's invoices
- `Company Address`
- `GSTIN`
- `Company Email`
- `Company Website`
- `Company Phone` (optional — folds the footer's currently-hardcoded
  "Call/WhatsApp" number into the hub-wise set too; drop this column if
  that number should actually stay one company-wide number instead)

### Backend: `google-apps-script/catalog_code.dev.gs`
- `handleAdmins` (`?action=admins`) and `resolveAdminByPassword_`/`whoAmI`:
  include the new `Hub Name`/`Company Name`/`Company Address`/`GSTIN`/
  `Company Email`/`Company Website`/`Company Phone` fields on every
  returned admin object, same blank-safe treatment as the rest of the row.
- New action `updateHubInfo` (Super-Admin-gated, like `admins`):
  `{ password, action: 'updateHubInfo', adminId, fields: { 'Hub Name': ...,
  'Company Name': ..., ... } }` — writes only to this fixed whitelist of
  columns on the target `adminId`'s row (never `Password`/`Role`/`Active`
  — same narrow-whitelist pattern as the hub-stock authorization in
  `handleUpdate` above). Reject if `adminId` doesn't match an existing row.

### Frontend: `orderAssignment.html` — new "Manage Hub Info" section
Super-Admin-only (the whole page already is), placed near the existing
roster/filter UI. For each active hub-admin (reusing the `admins` fetch
already made at connect time): an editable form — Hub Name, Company Name,
Address, GSTIN, Email, Website, Phone — pre-filled from the roster. Save
posts `updateHubInfo` to the Catalog script and refreshes the local roster
on success (same optimistic-update-then-confirm pattern `assignOrder`
already uses).

### Frontend: `invoices.html` / `admin.html` — passing hub info into the invoice
Both pages already resolve an order's assigned admin from the roster for
other purposes (`adminName(adminId)` in `orderAssignment.html`,
`assignedAdminUpi()` in `admin.html`). Add the equivalent: when building
`d` for `buildInvoiceHtml` (`buildInvoiceFromOrder` in `invoices.html`;
the analogous function in `admin.html`), resolve `o.assignedTo` against
the roster and pass `d.hub = { name, companyName, address, gstin, email,
website, phone }` (`null`/omitted if unresolved, e.g. a legacy unassigned
order). No new order-row columns needed for the identity block itself — a
hub's legal identity is stable, so a live roster lookup at render/reprint
time is enough and always reflects the latest info if a hub's registered
address/GSTIN ever changes. UPI VPA is the one exception that still needs
snapshotting for idempotency, **but see the reassignment fix in the
`orders_code.dev.gs` section above** — reassignment now re-snapshots
`Confirming Admin UPI` too, specifically so it never drifts out of sync
with this live-resolved identity block after a hub changes.

### `invoice-shared.js`: `buildInvoiceHtml(d)` reads `d.hub` with a hardcoded fallback
Every hardcoded company reference becomes `d.hub?.<field> || <today's
hardcoded value>`, so with no `d.hub` (every prod invoice, and any dev
invoice for an order with no resolvable assignee) the output stays
byte-for-byte identical to today:
- The `.company` block (~invoice-shared.js:200-206): `d.hub?.companyName`,
  `d.hub?.address`, `d.hub?.gstin`, `d.hub?.email`, `d.hub?.website`.
- `buildUpiPayLink`'s payee name — currently the module-level
  `UPI_PAYEE_NAME` constant — gains a 4th param for the payee name,
  passed as `d.hub?.companyName` (defaults to `UPI_PAYEE_NAME`, mirroring
  how the existing 3rd param already defaults to `UPI_VPA`).
- The footer "Thank you" note (~line 230) currently repeats the email/
  website literally — swap those two spots to the same `d.hub?.email`/
  `d.hub?.website` (with the same fallback) so the letterhead and footer
  never disagree on one invoice.
- `Company Phone`, if kept: the `qrSection`'s hardcoded "Call / WhatsApp:
  +91 83389 62474" line becomes `d.hub?.phone`, same number as fallback.
This file is shared by `admin.html` and `invoices.html` for invoice
rendering, so one change here covers both pages' printed output.

## Manual steps needed (outside this codebase, in Google Sheets/Apps Script)
1. In the DEV Catalog Google Sheet, add one `Stock: <Admin ID>` column per
   active hub-admin — Super Admin's row included (matching the Admins
   tab's Admin ID column exactly).
2. Redeploy both DEV Apps Script projects as **new deployments** (the
   known "edit existing deployment silently doesn't take effect" gotcha) —
   Catalog first, then Orders (Orders calls into Catalog, so Catalog must
   be live first). Update the rotated URLs into `products.html`/
   `admin.html`/`orderAssignment.html`/`invoices.html`/`index.html` DEV
   consts, and grep-confirm no stale URLs remain.
3. Enter real per-hub stock numbers for existing products (migration
   decision: starts at 0, not auto-split).
4. Add the new `Hub Name`/`Company Name`/`Company Address`/`GSTIN`/
   `Company Email`/`Company Website`/`Company Phone` columns to the
   Admins tab (same manual-column convention as `Stock: <id>` above).
5. Decide which existing Admins-tab row becomes Hub North vs. Hub South;
   add a 3rd row if only one `Role = Admin` row exists today (confirm
   current sheet state rather than assuming — per most recent session
   notes only one Admin row was filled in as of 2026-09-18). Fill in real
   Hub Name/Company Name/Address/GSTIN/Email/Website (and Phone, if kept)
   for **all three hubs, including Hub Central** — either directly on the
   sheet or via the new "Manage Hub Info" section once built.

## Verification
- Curl `?action=hubs&password=...` against the redeployed DEV Catalog URL
  and confirm it returns the expected hub roster (no WhatsApp/UPI/Password
  fields).
- In `products.html?dev=1`: confirm the per-hub columns render, a
  non-Super-Admin's own-hub cell is editable and every other hub's cell is
  disabled, and Super Admin can edit any hub. Save one change per case and
  reload to confirm it persisted.
- Place a test order via `index.html?dev=1`, confirm `inStock` still
  reflects the sum across hubs (e.g. a product with stock only in Hub 2
  still shows purchasable).
- In `admin.html?dev=1`/`orderAssignment.html`: try confirming an
  unassigned order as Super Admin and confirm it's rejected with the new
  message; assign it to a hub, confirm again, and check that hub's stock
  column decremented by the right amount.
- Reassign that same now-confirmed order to a different hub via
  `orderAssignment.html` and confirm the original hub's stock is restored
  and the new hub's stock is decremented.
- Generate/reprint an invoice for an order assigned to each of the three
  hubs and confirm the company block, GSTIN, email, and website match
  that hub's own values (not always Greenharvest's).
- Confirm a prod invoice (no `?dev=1`), or a dev order with no resolvable
  assignee, still renders the original hardcoded Greenharvest block
  byte-for-byte.
- As a Hub North/South admin, confirm `invoices.html?dev=1` only lists
  that hub's own orders; as Hub Central (Super Admin), confirm it still
  lists every hub's invoices.
- In `orderAssignment.html?dev=1`, confirm the new "Manage Hub Info"
  section is Super-Admin-only, edit one hub's info as Super Admin, save,
  reload to confirm it persisted, and confirm it shows correctly on that
  hub's next invoice.
- Curl `?action=hubs&password=...` again and confirm Hub Central's row
  (Role = Super Admin) is included, not just the two Admin rows.
- In `orderAssignment.html?dev=1`, confirm Super Admin now appears as a
  normal option in both the filter bar and each order's "Assign to…"
  dropdown (not a separate hardcoded blank-value option), and assigning an
  order to it writes Super Admin's real Admin ID, not a blank cell.
- Reassign a confirmed order from one hub to another, then reprint its
  invoice: confirm the company letterhead/GSTIN **and** the UPI QR both
  reflect the new hub, not a mix of old and new.
- Find (or create) a legacy order with blank `Assigned To`, confirm it's
  rejected by the new "assign before confirming" check, assign it to a
  hub via `orderAssignment.html`, and confirm it can then be confirmed and
  decrements that hub's stock correctly.
