/**
 * The hourly pass that tells an organization its budget is nearly spent.
 *
 * Pinned here: that nothing is measured without prices or against a budget in
 * another currency, that each threshold reaches everybody who runs the
 * organization's settings once a month, and that the announcement is claimed
 * before anybody is told - so a second runner that got past the lease finds it
 * taken and stays quiet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const updateMany = vi.fn();
const getBillingRates = vi.fn();
const readStatement = vi.fn();
const notify = vi.fn(async () => undefined);
const orgPeopleHolding = vi.fn(async () => ["owner1", "admin2"]);

vi.mock("@polaris/db", () => ({ prisma: { organizationBudget: { findMany, updateMany } } }));
vi.mock("@/lib/billing/rates", () => ({ getBillingRates }));
vi.mock("@/lib/billing/statement", () => ({ readStatement }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/orgs/org-service", () => ({ orgPeopleHolding }));

const { sweepBudgets } = await import("../../src/lib/billing/budgets");

const NOW = new Date("2026-09-20T10:00:00Z");
const RATES = { currency: "EUR", cpuHour: 0.02, memoryGbHour: null, storageGbMonth: null, egressGb: null };

function budgetRow(overrides: Record<string, unknown> = {}) {
    return {
        orgId: "o1",
        amount: 100,
        alertedMonth: null,
        alertedLevel: 0,
        org: { slug: "acme", name: "Acme" },
        ...overrides
    };
}

/** The statement the pass reads, with Acme having spent `spent`. */
function spending(spent: number) {
    return {
        monthLabel: "September 2026",
        statement: {
            owners: [
                { owner: { kind: "org", id: "o1", name: "Acme", handle: "acme" }, projects: 1, cost: { total: spent } }
            ]
        }
    };
}

beforeEach(() => {
    findMany.mockReset();
    updateMany.mockReset();
    getBillingRates.mockReset();
    readStatement.mockReset();
    notify.mockClear();
    orgPeopleHolding.mockClear();
    getBillingRates.mockResolvedValue(RATES);
    updateMany.mockResolvedValue({ count: 1 });
});

describe("measuring budgets", () => {
    it("measures nothing when the instance has no prices", async () => {
        getBillingRates.mockResolvedValue(null);
        expect(await sweepBudgets(NOW)).toEqual({ checked: 0, announced: 0 });
        expect(findMany).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it("only reads budgets set in the prices' currency", async () => {
        findMany.mockResolvedValue([]);
        await sweepBudgets(NOW);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { currency: "EUR" } }));
        expect(readStatement).not.toHaveBeenCalled();
    });

    it("tells everybody who runs the organization's settings at 80%", async () => {
        findMany.mockResolvedValue([budgetRow()]);
        readStatement.mockResolvedValue(spending(85));

        expect(await sweepBudgets(NOW)).toEqual({ checked: 1, announced: 1 });
        expect(readStatement).toHaveBeenCalledWith({ kind: "orgs", orgIds: ["o1"] }, "2026-09", NOW);
        expect(orgPeopleHolding).toHaveBeenCalledWith("o1", "settings.manage");
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "owner1",
                event: "billing.budget",
                level: "warning",
                href: "/account/organizations/acme/billing",
                title: "Acme has used 80% of its budget for September 2026"
            })
        );
        // Claimed against what was read, so a pass that got there first wins.
        expect(updateMany).toHaveBeenCalledWith({
            where: { orgId: "o1", amount: 100, currency: "EUR", alertedMonth: null, alertedLevel: 0 },
            data: { alertedMonth: "2026-09", alertedLevel: 80 }
        });
    });

    it("stays quiet when the budget was changed while it was being measured", async () => {
        findMany.mockResolvedValue([budgetRow()]);
        readStatement.mockResolvedValue(spending(90));
        updateMany.mockImplementation(async ({ where }: { where: { amount: number } }) => ({
            count: where.amount === 500 ? 1 : 0
        }));
        expect(await sweepBudgets(NOW)).toEqual({ checked: 1, announced: 0 });
        expect(notify).not.toHaveBeenCalled();
    });

    it("says nothing again for a threshold already announced this month", async () => {
        findMany.mockResolvedValue([budgetRow({ alertedMonth: "2026-09", alertedLevel: 80 })]);
        readStatement.mockResolvedValue(spending(95));
        expect(await sweepBudgets(NOW)).toEqual({ checked: 1, announced: 0 });
        expect(notify).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("announces going over, as a danger, once past 100%", async () => {
        findMany.mockResolvedValue([budgetRow({ alertedMonth: "2026-09", alertedLevel: 80 })]);
        readStatement.mockResolvedValue(spending(130));
        await sweepBudgets(NOW);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({ level: "danger", title: "Acme has gone past its budget for September 2026" })
        );
    });

    it("stays quiet when another runner claimed the announcement first", async () => {
        findMany.mockResolvedValue([budgetRow()]);
        readStatement.mockResolvedValue(spending(90));
        updateMany.mockResolvedValue({ count: 0 });
        expect(await sweepBudgets(NOW)).toEqual({ checked: 1, announced: 0 });
        expect(notify).not.toHaveBeenCalled();
    });

    it("starts a new month with nothing announced", async () => {
        findMany.mockResolvedValue([budgetRow({ alertedMonth: "2026-08", alertedLevel: 100 })]);
        readStatement.mockResolvedValue(spending(81));
        expect(await sweepBudgets(NOW)).toEqual({ checked: 1, announced: 1 });
    });
});
