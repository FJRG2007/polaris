/** CRM: the companies a team is working, with their owner, size and revenue. */

import { PAGE_FILL } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { VIEWER, TEAM, ago, id } from "../fixtures/people";
import { defaultConfig } from "../../../apps/crm/src/model/views";
import type { CrmRecord } from "../../../apps/crm/src/model/objects";
import { ListScreen } from "../../../apps/crm/src/screens/list-screen";

const VIEW = id("crm-view", 1);

const owner = (who: { id: string; name: string }) => ({ id: who.id, name: who.name });

/** Invented companies on example domains. */
const COMPANIES = [
    { name: "Northwind Traders", domain: "northwind.example.com", who: TEAM.ana, staff: 240, revenue: 4_800_000, city: "Madrid", ideal: true },
    { name: "Bluebird Logistics", domain: "bluebird.example.com", who: TEAM.sam, staff: 85, revenue: 1_250_000, city: "Lisbon", ideal: true },
    { name: "Fernhill Studio", domain: "fernhill.example.org", who: VIEWER, staff: 12, revenue: 380_000, city: "Valencia", ideal: false },
    { name: "Cobalt Energy", domain: "cobalt.example.net", who: TEAM.lena, staff: 1_100, revenue: 22_000_000, city: "Berlin", ideal: true },
    { name: "Harbor & Pine", domain: "harborpine.example.com", who: TEAM.priya, staff: 46, revenue: 920_000, city: "Porto", ideal: false },
    { name: "Lumen Health", domain: "lumen.example.org", who: TEAM.kenji, staff: 310, revenue: 6_400_000, city: "Lyon", ideal: true },
    { name: "Quarry Labs", domain: "quarry.example.com", who: TEAM.ana, staff: 28, revenue: 540_000, city: "Seville", ideal: false },
    { name: "Atlas Freight", domain: "atlas.example.net", who: TEAM.sam, staff: 520, revenue: 9_700_000, city: "Milan", ideal: true },
    { name: "Willow Bakery", domain: "willow.example.com", who: VIEWER, staff: 9, revenue: 160_000, city: "Bilbao", ideal: false }
];

export const crm = defineScene({
    id: "crm",
    path: "/crm/companies",
    // The rail's pinned views: none yet.
    api: () => ({ "GET /api/apps/favorites": () => ({ favorites: [] }) }),
    actions: (ctx) => {
        const records: CrmRecord[] = COMPANIES.map((company, n) => ({
            id: id("crm-company", n + 1),
            position: n,
            deletedAt: null,
            values: {
                name: company.name,
                domain: company.domain,
                accountOwner: owner(company.who),
                employees: company.staff,
                annualRevenue: { amount: company.revenue, currency: "EUR" },
                city: company.city,
                idealCustomer: company.ideal,
                createdAt: ago(ctx.now, (n + 2) * 1440 * 6)
            }
        }));
        const config = defaultConfig("companies");
        const view = {
            id: VIEW,
            name: "",
            kind: "table" as const,
            config: {
                ...config,
                columns: config.columns.map((column) =>
                    column.key === "annualRevenue" ? { ...column, aggregate: "sum" as const } : column
                )
            }
        };
        const can = { read: true, edit: true, delete: true };
        const revenue = COMPANIES.reduce((sum, company) => sum + company.revenue, 0);
        return {
            openListAction: () => ({
                ok: true,
                view,
                views: [view],
                can: { companies: can, people: can, opportunities: can },
                people: [VIEWER, ...Object.values(TEAM)].map(owner),
                shelfName: null,
                fields: [],
                favoriteViews: [],
                rule: null
            }),
            listRecordsAction: () => ({ ok: true, records, total: records.length }),
            listGroupsAction: () => ({ ok: true, groups: [] }),
            totalsAction: (input: { asked?: { key: string; aggregate: string }[] }) => ({
                ok: true,
                totals: (input.asked ?? []).map((asked) =>
                    asked.key === "annualRevenue"
                        ? { ...asked, value: null, money: [{ amount: revenue, currency: "EUR" }] }
                        : { ...asked, value: records.length }
                )
            })
        };
    },
    render: () => (
        <Chrome>
            <div className={PAGE_FILL}>
                <ListScreen object="companies" />
            </div>
        </Chrome>
    )
});
