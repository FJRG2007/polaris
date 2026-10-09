/**
 * Every total a view can ask for, under every field, builds a query the
 * database accepts: no column that is not text is ever compared with "".
 */

import { describe, expect, it, vi } from "vitest";

const delegate = vi.hoisted(() => ({
    count: vi.fn(async () => 3),
    groupBy: vi.fn(async () => []),
    aggregate: vi.fn(async () => ({}))
}));

vi.mock("@polaris/db", () => ({
    prisma: { crmCompany: delegate, crmPerson: delegate, crmOpportunity: delegate },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));

import { computeTotals } from "@polaris-app/crm/src/lib/totals";
import { aggregatesFor } from "@polaris-app/crm/src/model/views";
import { FIELDS, type CrmObject } from "@polaris-app/crm/src/model/objects";

const NOT_TEXT = new Set(["employees", "annualRevenue", "idealCustomer", "createdAt", "updatedAt", "amount", "closeDate"]);

function blankCompared(value: unknown): string[] {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
        inner === "" && NOT_TEXT.has(key) ? [key] : blankCompared(inner)
    );
}

const can = { read: true, edit: true, delete: true };
const actor = {
    shelf: { orgId: null, userId: "u1", key: "user:u1" },
    can: { companies: can, people: can, opportunities: can }
} as never;

describe("computeTotals", () => {
    for (const object of Object.keys(FIELDS) as CrmObject[]) {
        for (const field of FIELDS[object]) {
            for (const aggregate of aggregatesFor(field.kind)) {
                it(`${object}.${field.key} ${aggregate}`, async () => {
                    vi.clearAllMocks();
                    const totals = await computeTotals(actor, object, [{ key: field.key, aggregate }], {});
                    expect(totals).toHaveLength(1);
                    const calls = [...delegate.count.mock.calls, ...delegate.groupBy.mock.calls, ...delegate.aggregate.mock.calls];
                    expect(blankCompared(calls)).toEqual([]);
                });
            }
        }
    }
});
