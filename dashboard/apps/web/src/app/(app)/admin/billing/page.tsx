/**
 * Billing (/admin/billing): what each project and organization on this Polaris
 * used in a month, priced at the rates the operator sets.
 *
 * Nobody pays Polaris; this is for the operator who charges the teams on the
 * instance back, or who wants to know what a project costs. The page clears the
 * admin gate and reads the price card, which is one row; the statement itself is
 * worked out from a month of metrics and is read after the screen has painted.
 */

import { requireAdmin } from "@/lib/session";
import { BillingView } from "./billing-view";
import { getBillingRates } from "@/lib/billing/rates";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
    await requireAdmin();
    const rates = await getBillingRates();
    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
            <BillingView rates={rates} />
        </div>
    );
}
