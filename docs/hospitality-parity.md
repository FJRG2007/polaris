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
| Product images (upload, camera, paste) on the order grid | Sq To Ls Rv La Lo Od TB Su Gl | partial (M1: picture link shown on the grid); upload/camera/crop via Polaris storage planned (M5) |
| Variants / sizes (cana, doble, jarra) | all | partial (M1: stored as modifier groups; editor in M2) |
| Modifier groups (required/optional, min/max, extra price) | all | done (M1) |
| Allergens (14 EU allergens) per product | Rv Ag La Ls Gl Ht | done (M1) |
| Descriptions and menu translations for tourists | Rv La Ls Od | M6 (QR menu) |
| Tax rates per product (IVA 10 / 21 / 4 / 0) | all | done (M1) |
| Import / export CSV and XLSX | Sq To Ls Rv Ag Lo Od Gl uC Ch | done (M1: CSV, Excel-compatible, `;` or `,`); native XLSX planned (M5) |
| Bulk price update (percent / fixed, per category) | Ls Rv Ag Gl Ht | done (M1) |
| Time-based prices / happy hour | To Ls Rv Ag La Gl | M7 |
| Menu of the day (fixed-price set menu with choices) | Rv Ag La Gl Ht | M7 |
| Combos | Sq To Ls Od uC | M7 |
| Barcode / scanner input | Sq Lo Od Su uC Ch | M5 (search field accepts a scanned code) |

## Floor and orders

| Feature | Products | Polaris |
| --- | --- | --- |
| Floor plan with rooms / terrace, tables placed by drag | Sq To Ls Rv Ag La Od TB Gl Ht Fl | planned (M2) |
| Table shapes, seats, rename | Sq To Ls Rv Od TB Fl | planned (M2) |
| Live table status (free / open / bill asked) | all restaurant ones | planned (M2) |
| Merge and split tables, move an order to another table | To Ls Rv Ag TB Gl Fl | planned (M2) |
| Order taking on phone / tablet / handheld | Sq To Ls Rv Ag La Od TB Gl Ht | planned (M2) |
| Handheld (PDA) terminal flow, one-hand, small screen, PWA | To Rv Ag Gl Ht | M5 |
| Courses and "marchar" (fire the next course) | To Ls Rv Ag TB Gl | planned (M2) |
| Notes and modifiers per line | all | planned (M2) |
| Covers (number of guests) | To Ls Rv TB Fl | planned (M2) |
| Takeaway and delivery orders | Sq To Ls Rv La Lo Od TB | M7 |
| Self-order QR at the table / kiosk | Sq To Ls Rv La Od | M6 |
| Reservations and waiting list | Sq To Ls Rv TB | M6 |
| Multi-terminal sync in real time | all | partial (M1: menu and sold-out live over the LAN; orders in M2) |

## Kitchen

| Feature | Products | Polaris |
| --- | --- | --- |
| Kitchen / bar display per station | Sq To Ls Rv Ag La Od TB Gl | planned (M3) |
| Timers and colour by age | Sq To Ls Rv Od TB | planned (M3) |
| Bump (mark done), recall | Sq To Ls Rv Od TB | planned (M3) |
| Kitchen ticket printing per station | all | interface done (`apps/hospitality/src/model/print-contract.ts`); driver on `hospitality-printing` |

## Payments and cash

| Feature | Products | Polaris |
| --- | --- | --- |
| Discounts: line / order, percent / amount, reasons | all | planned (M3) |
| Discounts gated by permission | Sq To Ls Rv Ag Od TB | planned (M3) |
| Split bill (by item, equal parts) | Sq To Ls Rv Ag Od TB Su | planned (M3) |
| Cash, card, mixed payments, change due | all | planned (M3) |
| Tips | Sq To Ls TB Su | planned (M3) |
| Card terminal integration | Sq To Ls Rv Su | no - card terminal is a separate device; amount recorded as card |
| Shift open with float, close with count | Sq Ls Rv Ag Lo Od Gl Ht uC Ch | planned (M3) |
| Cash in / out with reason | Ls Rv Ag Lo Od Gl uC Ch | planned (M3) |
| Blind count | Ls Rv Ag Gl | planned (M3) |
| X and Z reports | Rv Ag Gl Ht uC Ch Fl | planned (M4) |
| Shift handover between staff | Rv Ag Gl Ht | planned (M3) |
| Cash drawer kick | all | interface done (`openDrawer`); driver on `hospitality-printing` |

## Fiscal (Spain)

| Feature | Products | Polaris |
| --- | --- | --- |
| Simplified invoice numbering, unbroken series per year | Rv Ag La Gl Ht | planned (M3) |
| Full invoice to a company on request | Rv Ag La Gl Ht | M7 |
| Verifactu (chained hash + QR, AEAT submission) | Rv Ag La Gl Ht | no - fiscal signing not implemented; tickets are not Verifactu records yet |
| TicketBAI (Basque Country) | Rv Ag Gl | no - same as above |

## Offline

| Feature | Products | Polaris |
| --- | --- | --- |
| Works with no internet on the local network | Rv Ag Gl Ht uC Fl Ch Lo | done (M1: served by the venue's own Polaris; no external call in the path) |
| Device keeps taking orders when it loses the LAN | Sq To Ls Lo | planned (M4) |

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
