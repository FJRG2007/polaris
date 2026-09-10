/**
 * What this organization's projects used in a month, what that came to at the
 * instance's prices, and the budget it is measured against.
 *
 * `settings.manage`, the permission that already governs how the organization is
 * run: what it spends is the business of whoever holds its settings. The budget
 * and the price card are one row each and arrive with the page; the statement is
 * a month of metrics and is read after the screen has painted.
 */

import { BillingView } from "./billing-view";
import { getOrgBudget } from "@/lib/billing/budgets";
import { getBillingRates } from "@/lib/billing/rates";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationBillingPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org, user } = await requireOrgPage(slug, "settings.manage");
    const [rates, budget] = await Promise.all([getBillingRates(), getOrgBudget(org.id)]);

    return (
        <div className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">Billing</h2>
                <p className="text-muted-foreground text-sm">
                    What {org.name}&apos;s projects used each month, priced at this Polaris&apos;s rates, and the budget
                    it is measured against.
                </p>
            </div>
            <BillingView
                orgId={org.id}
                slug={org.slug}
                currency={rates?.currency ?? null}
                budget={budget}
                canSetPrices={user.isAdmin}
            />
        </div>
    );
}
