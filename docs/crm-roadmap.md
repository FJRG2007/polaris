# CRM - feature roadmap (parity with a professional CRM)

What a professional CRM offers and where Polaris CRM (`dashboard/apps/crm`)
stands against each. Pick items top-down within a priority. Keep it updated as
things land.

**Status:** have · partial · missing
**Priority:** P0 (core) · P1 (high) · P2 (nice-to-have)

## Data model

| Capability | Status | Priority | Notes |
| --- | --- | --- | --- |
| Companies, people, opportunities | have | P0 | Fixed objects in `CRM_OBJECTS`. |
| Custom fields | have | P0 | Typed slots per object (text, number, currency, date, select, relation...). |
| Custom objects | missing | P0 | Only the three built-in objects; no user-defined record types. |
| Relations between records | partial | P0 | Company - person - opportunity links; no many-to-many or relations to custom objects. |
| Field validation rules | missing | P2 | Required fields and per-field rules beyond the kind's own format. |
| Calculated / rollup fields | missing | P1 | Totals exist per list, not as stored fields on a record. |

## Lists and views

| Capability | Status | Priority | Notes |
| --- | --- | --- | --- |
| Table view, saved views, filters, sorts | have | P0 | Filtered and sorted in the database. |
| 100k+ records per list | have | P0 | Cursor pagination, list-order indexes, virtualized table. |
| Grouping and column totals | have | P1 | |
| Kanban board | have | P0 | Any object, by any groupable field; drag between and within columns. |
| Calendar view of date fields | missing | P2 | |
| Bulk edit, merge, trash and restore | have | P1 | |
| Favorites | have | P2 | |

## Activity and communication

| Capability | Status | Priority | Notes |
| --- | --- | --- | --- |
| Timeline per record | have | P0 | Notes, tasks and changes in one feed. |
| Notes and tasks | have | P0 | |
| Email shown on the record | partial | P0 | Reads mail with the contact from Polaris Mail; no external mailbox sync (IMAP/Gmail/Outlook) and no send-from-record tracking. |
| Calendar sync and meetings on the record | missing | P0 | No calendar provider sync; meetings are not logged automatically. |
| Calls logged on the record | missing | P2 | |
| Email templates and sequences | partial | P1 | A workflow can send an email; no reusable templates or multi-step sequences with reply detection. |

## Automation and insight

| Capability | Status | Priority | Notes |
| --- | --- | --- | --- |
| Workflows | have | P1 | Record, field-change, schedule, manual and webhook triggers; if/else, loops, delays and waits. |
| Workflow approvals | missing | P2 | No step that waits on a person's decision. |
| Dashboards and chart widgets | have | P1 | |
| Sales forecast | have | P1 | |
| Stage flow / pipeline analytics | partial | P2 | Stage flow panel; no conversion or velocity reports. |
| Audit log | have | P1 | |

## Access, data in and out

| Capability | Status | Priority | Notes |
| --- | --- | --- | --- |
| Roles with row scope and hidden / read-only fields | have | P0 | Enforced on the server, mirrored on screen. |
| Per-team record sharing and territories | missing | P2 | Row scope is all or own only. |
| CSV import with mapping | have | P0 | |
| CSV export | have | P0 | |
| Duplicate detection on create | have | P1 | Warns while typing; merge dialog. |
| Scheduled / fuzzy dedupe across the whole base | missing | P2 | |
| Public REST / GraphQL API with keys | missing | P0 | Only an inbound workflow webhook (`/api/crm/hooks/<secret>`). |
| Outbound webhooks on record events | partial | P1 | A workflow's HTTP request action; no subscription managed outside workflows. |
| Data enrichment (company from domain) | missing | P2 | |

## Platform

| Capability | Status | Priority | Notes |
| --- | --- | --- | --- |
| Responsive from 360px to ultrawide | have | P0 | Every CRM screen. |
| Native mobile app / offline | missing | P2 | Web only. |
| Personal and organization shelves | have | P0 | |
| Multi-currency | partial | P2 | Amounts carry a currency; no conversion rates. |
