/**
 * How long records are kept (/admin/retention).
 *
 * Three tables grow forever and nothing ever reads the old rows: the bell's
 * notifications, the activity every screen writes, and the audit trail. There
 * was no way to bound any of them and no way to be told there was a problem
 * until a disk filled - so this is the screen that says how long each is worth
 * keeping, with what is actually in them beside it.
 *
 * The counts are read here and not by the form: a number that arrives with the
 * page is a number somebody can act on, and this is a screen whose whole point is
 * to say what a period is going to take away.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { RetentionView } from "./retention-view";
import { retentionPolicy, retentionTotals } from "@/lib/retention-service";

export const dynamic = "force-dynamic";

export default async function RetentionPage() {
    await requireAdmin();
    const policy = await retentionPolicy();
    const totals = await retentionTotals(policy);

    return (
        // Narrow: three settings and nothing wide, so the column is centred in
        // the content area rather than left against the rail.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Keeping records"
                description="How long Polaris keeps what it writes down about people using it. Anything older is taken away on a schedule."
            />
            <RetentionView policy={policy} totals={totals} />
        </div>
    );
}
