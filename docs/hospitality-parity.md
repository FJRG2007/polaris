# Hospitality - feature parity ledger

What restaurant and bar point-of-sale products offer, and where Polaris's
Hospitality app stands on each. Features only (behaviour a restaurant uses), no
code, schema or wording taken from any product. Source: each product's public
feature pages and documentation, one pass, 2026-11-28.

Products: **Sq** Square for Restaurants, **To** Toast, **Ls** Lightspeed
Restaurant, **Rv** Revo XEF, **Ag** Agora, **La** Last.app, **Lo** Loyverse,
**Od** Odoo POS (restaurant), **TB** TouchBistro, **Su** SumUp / Zettle,
**Gl** Glop, **Ht** Hosteltactil, **uC** uniCenta, **Fl** Floreant, **Ch** chromis.

Status: **done** (on branch `hospitality-app`), **partial**, **planned (Mn)**,
**no** (out of scope, reason given).

## Catalogue

| Feature | Products | Polaris |
| --- | --- | --- |
| Products and categories, colours per category | all | done (M1) |
| Product images (upload, camera, paste) on the order grid | Sq To Ls Rv La Lo Od TB Su Gl | done (choose, camera, drop or paste; cropped square to WebP; stored on the NAS when there is one). Category pictures planned |
| Variants / sizes (cana, doble, jarra) | all | partial (M1: stored as modifier groups; editor in M2) |
| Modifier groups (required/optional, min/max, extra price) | all | done (M1) |
| Allergens (14 EU allergens) per product | Rv Ag La Ls Gl Ht | done (M1) |
| Descriptions and menu translations for tourists | Rv La Ls Od | M6 (QR menu) |
| Tax rates per product (IVA 10 / 21 / 4 / 0) | all | done (M1) |
| Import / export CSV and XLSX | Sq To Ls Rv Ag Lo Od Gl uC Ch | done (CSV with `;` or `,`, and native .xlsx both ways) |
| Bulk price update (percent / fixed, per category) | Ls Rv Ag Gl Ht | done (M1) |
| Time-based prices / happy hour | To Ls Rv Ag La Gl | M7 |
| Menu of the day (fixed-price set menu with choices) | Rv Ag La Gl Ht | M7 |
| Combos | Sq To Ls Od uC | M7 |
| Barcode / scanner input | Sq Lo Od Su uC Ch | M5 (search field accepts a scanned code) |

## Floor and orders

| Feature | Products | Polaris |
| --- | --- | --- |
| Floor plan with rooms / terrace, tables placed by drag | Sq To Ls Rv Ag La Od TB Gl Ht Fl | done (M2: rooms, drag on a grid) |
| Table shapes, seats, rename | Sq To Ls Rv Od TB Fl | done (M2) |
| Live table status (free / open / bill asked) | all restaurant ones | done (M2: free, open, not sent, bill asked) |
| Merge and split tables, move an order to another table | To Ls Rv Ag TB Gl Fl | done (move all of it, join an open table, or move some items and quantities to split a table) |
| Order taking on phone / tablet / handheld | Sq To Ls Rv Ag La Od TB Gl Ht | done (M2: phone full screen, tablet/desktop side by side) |
| Handheld (PDA) terminal flow, one-hand, small screen, PWA | To Rv Ag Gl Ht | M5 |
| Courses and "marchar" (fire the next course) | To Ls Rv Ag TB Gl | done (M2: course per line, Send fires) |
| Notes and modifiers per line | all | done (option picker with required groups and limits, kitchen note per line) |
| Covers (number of guests) | To Ls Rv TB Fl | partial (M2: seats of the table; editable later) |
| Takeaway and delivery orders | Sq To Ls Rv La Lo Od TB | M7 |
| Self-order QR at the table / kiosk | Sq To Ls Rv La Od | M6 |
| Reservations and waiting list | Sq To Ls Rv TB | M6 |
| Multi-terminal sync in real time | all | partial (M1: menu and sold-out live over the LAN; orders in M2) |

## Kitchen

| Feature | Products | Polaris |
| --- | --- | --- |
| Kitchen / bar display per station | Sq To Ls Rv Ag La Od TB Gl | done (M3) |
| Timers and colour by age | Sq To Ls Rv Od TB | done (M3: green, amber 10 min, red 20 min) |
| Bump (mark done), recall | Sq To Ls Rv Od TB | done (M3: tap to bump, undo instead of confirm) |
| Kitchen ticket printing per station | all | interface done (`apps/hospitality/src/model/print-contract.ts`); driver on `hospitality-printing` |

## Payments and cash

| Feature | Products | Polaris |
| --- | --- | --- |
| Discounts: line / order, percent / amount, reasons | all | done (order and line, percent or amount, with a reason) |
| Discounts gated by permission | Sq To Ls Rv Ag Od TB | done (M3: `hospitality.manage`; a dedicated permission planned) |
| Split bill (by item, equal parts) | Sq To Ls Rv Ag Od TB Su | done (by item, remembering what is paid; equal parts; whole bill) |
| Cash, card, mixed payments, change due | all | done (M3: quick notes, change, partial payments) |
| Tips | Sq To Ls TB Su | done (5 %, 10 % or a typed amount at payment; in the X/Z report). Per-venue suggestions planned (M7) |
| Card terminal integration | Sq To Ls Rv Su | no - card terminal is a separate device; amount recorded as card |
| Shift open with float, close with count | Sq Ls Rv Ag Lo Od Gl Ht uC Ch | done (M3) |
| Cash in / out with reason | Ls Rv Ag Lo Od Gl uC Ch | done (M3) |
| Blind count | Ls Rv Ag Gl | done (M3: expected shown only after the count) |
| X and Z reports | Rv Ag Gl Ht uC Ch Fl | done (M3/M4: X live, Z numbered per venue; printing via the printer layer) |
| Shift handover between staff | Rv Ag Gl Ht | done (M3: open orders carry to the next shift) |
| Cash drawer kick | all | interface done (`openDrawer`); driver on `hospitality-printing` |

## Fiscal (Spain)

| Feature | Products | Polaris |
| --- | --- | --- |
| Simplified invoice numbering, unbroken series per year | Rv Ag La Gl Ht | done (M3: per venue and year, counter in the closing transaction) |
| Full invoice to a company on request | Rv Ag La Gl Ht | M7 |
| Verifactu (chained hash + QR, AEAT submission) | Rv Ag La Gl Ht | no - fiscal signing not implemented; tickets are not Verifactu records yet |
| TicketBAI (Basque Country) | Rv Ag Gl | no - same as above |

## Offline

| Feature | Products | Polaris |
| --- | --- | --- |
| Works with no internet on the local network | Rv Ag Gl Ht uC Fl Ch Lo | done (M1: served by the venue's own Polaris; no external call in the path) |
| Device keeps taking orders when it loses the LAN | Sq To Ls Lo | done (M4: IndexedDB queue, replay with device-made ids) |

## Degraded modes

The venue keeps serving through every failure below. Each screen shows a
banner while something is degraded ("Sin conexion: N pendientes" with the
server away, "Enviando N" while the queue drains) and clears it once all is
live. Recovery is automatic: the queue on each device replays in order on
the `online` event, when the screen is shown again and every 15 seconds, and
every write carries ids made on the device, stored once by the database, so a
replay changes nothing twice. Tests: `apps/web/test/hospitality/model/degraded-modes.test.ts`
and `offline-replay.test.ts`.

| Failure | What keeps working | What does not, until it is back | Recovery |
| --- | --- | --- | --- |
| Polaris update or restart | Every screen stays up; orders, rounds, kitchen marks, payments and cash movements are kept on the device (IndexedDB, survives the reload the update causes) | Nothing new from other devices reaches the screen | Queue replays in order; a request applied before the answer was lost is a no-op |
| Server down for minutes | Same as a restart: waiters keep taking orders, the kitchen keeps the tickets it last showed (kept across a reload) and marks them, the till takes cash and records cash in/out, and says a payment is saved on the device | New orders from other devices do not reach the kitchen; card terminals that need the server; a ticket number for a payment taken offline (given when it lands) | Same as a restart |
| Internet down | Everything: devices talk to the venue's own Polaris on the LAN and no Hospitality screen or action calls anything outside it | Nothing in Hospitality | Nothing to do |
| Printer down | Orders and payments are unaffected; printing is a job of its own | Paper tickets for that printer | Print jobs are deduplicated by job id, so a retry never prints twice (lands with the printing work, not on this branch yet) |
| One device dead | Every other device; what it had already sent is on the server | The work still queued on that device | Its queue is in its own storage and replays, once, when it is back; nothing else waits on it |

## Stock, staff, customers

| Feature | Products | Polaris |
| --- | --- | --- |
| Stock with recipes (escandallos), low-stock alerts | Ls Rv Ag Lo Od Gl uC | M8 |
| Suppliers and purchase orders | Ls Rv Ag Lo Od Gl uC | M8 |
| Staff roles and permissions | all | done (M1: `hospitality.use`, `hospitality.manage` in Capabilities); staff profiles without accounts planned (M5) |
| Staff clock-in | Sq To Ls Rv Ag Lo TB | M8 |
| Customer accounts / loyalty | Sq To Ls Rv La Lo Od TB | M8 |
| Sales reports by product / waiter / hour | all | M4 (by product + payment method), rest M8 |

## Ease of use

| Feature | Products | Polaris |
| --- | --- | --- |
| First-run setup with a sample menu and floor | Sq Lo TB | done (M1: sample menu, venue and 8 tables in one tap) |
| Big touch targets, colour-coded, few words | all | done (M1: standard and simple view, one flag, remembered per device) |

## Owner additions (2026-11-28)

| Feature | Products | Polaris |
| --- | --- | --- |
| Multi-venue: own floor, devices, staff, printers, cash; shared menu with per-venue price and availability; reports across venues | Ls Rv Ag La Od | partial (M1: every table venue-scoped, per-venue price/availability override, venue picker) |
| Sold out ("86") in one tap from any device, live | Sq To Ls Rv La | done (M1, per venue) |
| Availability by day/time, per channel, stock-driven sold out | To Ls Rv La | planned (M7) |
| Device linking by QR and short code (reusing Polaris device sign-in), revocable per-device tokens, last seen | Sq To Ls Rv | planned (M5) |
| Staff profiles without a Polaris account; shared device modes none (default), tap, tap + PIN, shift | Sq To Ls Rv Ag | planned (M5; `HospitalityStaff` and `staffMode` already in the schema) |
| Three layouts: handheld portrait, tablet landscape, desktop management | Sq To Ls Rv | planned (M2 onward) |
| Promotions: 2x1, combos, % or fixed off, happy hour, promo codes, dates, stacking, roles | To Ls Rv Ag La | planned (M7) |
| Tips: per venue, suggested %, on ticket and payment, split among staff, in cash close | Sq To Ls TB Su | planned (M3/M7) |
| Service charge, terrace surcharge, minimum spend, rounding, per-venue receipt texts | To Ls Rv Ag | planned (M7; receipt texts and currency per venue in M1) |
| Kiosk / QR self-order, menu translations | Sq To Ls Rv La Od | planned (M6) |
| Reservations, waiting list | Sq To Ls Rv TB | planned (M6) |
| Stock, recipes (escandallos), low-stock alerts, suppliers, purchase orders | Ls Rv Ag Lo Od Gl uC | planned (M8) |
| Clock-in, customer accounts, loyalty, delivery/takeaway, menu of the day | various | planned (M7/M8) |

## Numier ecosystem (target customer's current system)

The owner's first customer runs Numier (Sevilla) and finds it hard to set up,
unreliable on the handhelds, slow to add products to, and impossible to use
without a training course. Everything below has to exist here and be doable
with no training: guided first steps, working defaults, undo. Features only, as
Numier describes them publicly; nothing of its code or wording is used.

| Numier module | What a venue uses it for | Polaris |
| --- | --- | --- |
| TPV | The main till: tables, orders, payments, cash | done (M1-M4: menu, floor, orders, kitchen, payments, till X/Z, offline queue) |
| PDA | An Android order taker with payment on it | partial: order screen works on a phone today; installable PWA + device linked by code (M5, data layer done) planned; card payment on the handheld depends on the terminal integration below |
| COCINA | Kitchen monitor: touch, pass control, pending dishes | partial: kitchen display done (bump/recall per line); station display on a TV as a linked device, timers, colour by age, sound (A1) planned |
| ONLINE | Managing every venue from anywhere | planned: the venue's own Polaris reached through Polaris's remote access, relay and domains, with no router configuration by the owner; cross-venue reports in A5 |
| KIOSCO | Self-service kiosk paying by card | planned (M6, with the QR/kiosk work); card payment needs the terminal integration |
| CARTA DIGITAL | QR menu for customers with live availability | planned (M6): menu, allergens, translations, 86 live |
| PEDIDOS | Order and pay at the table from the customer's phone; delivery and take away | planned (M6 order at table, M7 take away/delivery); online payment needs a payment provider |
| INVENTARIO | Phone as an inventory scanner: barcode by camera, counts | planned (M8 stock), scanning through the camera |
| FACTURA QR | QR on the ticket so the customer issues their own full invoice | planned (with A2 printing: QR in the ticket document; a public invoice-request page) |
| CONTROL HORARIO | Staff time clock, NFC with a PIN fallback; Spain's registro de jornada | planned (M8 clock-in): staff profiles (M5) + PIN; NFC where the device reads it (Web NFC on Android Chrome) |
| CASH | Cash machines (CashGuard, Cashlogy) | planned, needs hardware: their integration protocols to be researched before any claim |
| API | Integrations with other systems | planned: Polaris's existing API keys and scopes (`hospitality.*`) |
| Verifactu | Signed, chained invoice records sent to the tax agency; required to sell in Spain from 2027 | no, pending the owner's decision. Nothing here signs invoices or claims to |
| Card terminals: Redsys, Dojo | Card payment sent to the terminal, result back on the order | planned, needs each provider's integration and a terminal to test against |
| CoverManager | Reservations | planned (M6 reservations; CoverManager sync after) |
| Gstock | Stock and purchasing | planned (A4 suppliers / M8 stock; Gstock sync after) |
