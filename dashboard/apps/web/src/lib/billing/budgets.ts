/**
 * An organization's monthly budget, and the pass that says when it is nearly
 * spent.
 *
 * A budget is measured against the organization's statement for the running
 * month, priced at the instance's rates - so with no rates there is nothing to
 * measure, and nothing is announced. A budget set in one currency is never read
 * against prices in another: the pass skips it and the screen asks for it again.
 *
 * Each threshold is announced once a month to everybody who runs the
 * organization's settings, which is who can raise the budget or cut the spend.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getBillingRates } from "./rates";
import { readStatement } from "./statement";
import { notify } from "@/lib/notifications/dispatch";
import { orgPeopleHolding } from "@/lib/orgs/org-service";

export interface OrgBudget {
    readonly amount: number;
    readonly currency: core.CurrencyCode;
}

/** The organization's budget, or null when it has none. */
export async function getOrgBudget(orgId: string): Promise<OrgBudget | null> {
    const row = await prisma.organizationBudget.findUnique({
        where: { orgId },
        select: { amount: true, currency: true }
    });
    if (!row || !core.isBillingCurrency(row.currency)) return null;
    return { amount: row.amount, currency: row.currency };
}

/**
 * Set or change the budget. What was already announced this month is forgotten,
 * so a raised budget is measured afresh rather than staying quiet because the old
 * one had already been told it was spent.
 */
export async function setOrgBudget(orgId: string, budget: OrgBudget): Promise<void> {
    await prisma.organizationBudget.upsert({
        where: { orgId },
        create: { orgId, amount: budget.amount, currency: budget.currency },
        update: { amount: budget.amount, currency: budget.currency, alertedMonth: null, alertedLevel: 0 }
    });
}

export async function clearOrgBudget(orgId: string): Promise<void> {
    await prisma.organizationBudget.deleteMany({ where: { orgId } });
}

/** Every organization's budget amount, for the instance statement. Only those in
 *  the prices' currency: another one is not a number the statement can compare. */
export async function budgetsIn(currency: core.CurrencyCode): Promise<Map<string, number>> {
    const rows = await prisma.organizationBudget.findMany({
        where: { currency },
        select: { orgId: true, amount: true }
    });
    return new Map(rows.map((row) => [row.orgId, row.amount]));
}

/**
 * Measure every budget against this month's spend, and tell the people running
 * each organization that has crossed a threshold it has not been told about.
 *
 * One statement for all of them rather than one each: the expensive half is
 * reading the month's figures, and it is the same read whichever organization
 * asks. The announcement is written down before anybody is told, so a pass that
 * dies half-way through its recipients does not tell the first ones twice.
 */
export async function sweepBudgets(now: Date = new Date()): Promise<{ checked: number; announced: number }> {
    const rates = await getBillingRates();
    if (!rates) return { checked: 0, announced: 0 };
    const budgets = await prisma.organizationBudget.findMany({
        where: { currency: rates.currency },
        select: {
            orgId: true,
            amount: true,
            alertedMonth: true,
            alertedLevel: true,
            org: { select: { slug: true, name: true } }
        }
    });
    if (budgets.length === 0) return { checked: 0, announced: 0 };

    const month = core.billingMonthOf(now);
    const view = await readStatement({ kind: "orgs", orgIds: budgets.map((budget) => budget.orgId) }, month, now);
    const spentBy = new Map(
        view.statement.owners
            .filter((entry) => entry.owner.kind === "org")
            .map((entry) => [entry.owner.id, entry.cost?.total ?? 0])
    );

    let announced = 0;
    for (const budget of budgets) {
        const spent = spentBy.get(budget.orgId) ?? 0;
        const due = core.budgetAlertDue({
            spent,
            budget: budget.amount,
            month,
            alertedMonth: budget.alertedMonth,
            alertedLevel: budget.alertedLevel
        });
        if (due === null) continue;

        // Claimed before anybody is told, and only if nobody else claimed it
        // first: the job is leased, and this is what keeps a second runner that
        // got past the lease from telling everybody again.
        const claimed = await prisma.organizationBudget.updateMany({
            where: {
                orgId: budget.orgId,
                amount: budget.amount,
                currency: rates.currency,
                alertedMonth: budget.alertedMonth,
                alertedLevel: budget.alertedLevel
            },
            data: { alertedMonth: month, alertedLevel: due }
        });
        if (claimed.count === 0) continue;

        const format = core.createDisplayFormat({ ...core.DISPLAY_DEFAULTS, currency: rates.currency });
        const title =
            due >= 100
                ? `${budget.org.name} has gone past its budget for ${view.monthLabel}`
                : `${budget.org.name} has used ${due}% of its budget for ${view.monthLabel}`;
        const body = `${format.currency(spent)} of ${format.currency(budget.amount)} so far this month.`;
        for (const userId of await orgPeopleHolding(budget.orgId, "settings.manage")) {
            await notify({
                userId,
                event: "billing.budget",
                title,
                body,
                href: `/account/organizations/${budget.org.slug}/billing`,
                level: due >= 100 ? "danger" : "warning",
                audience: "group",
                audienceLabel: `${budget.org.name} admins`,
                metadata: { orgId: budget.orgId, month, threshold: due }
            });
        }
        announced += 1;
    }
    return { checked: budgets.length, announced };
}
