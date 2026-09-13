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
 *
 * The mail body cache is the fourth thing that grows without a bound and the one
 * that grows fastest, so it is here too - as a count of messages rather than a
 * period, which is why it is its own card and not a fourth row of the table.
 *
 * Its count is the exception to the paragraph above: it is the only one the card
 * fetches for itself. The three tables are counted on an indexed timestamp; a
 * held body is `bodyText` or `bodyHtml` being set, which no index answers, over
 * the largest table in the product - so awaiting it here held the whole
 * navigation to /admin/retention for as long as that scan took. The card draws
 * without it and fills the number in.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { MailBodyForm } from "./mail-body-form";
import { RetentionView } from "./retention-view";
import { getSetting } from "@/lib/setting-store";
import { MAIL_BODY_KEEP_KEY, mailBodyKeep } from "@polaris/core";
import { retentionPolicy, retentionTotals } from "@/lib/retention-service";

export const dynamic = "force-dynamic";

export default async function RetentionPage() {
    await requireAdmin();
    const policy = await retentionPolicy();
    const totals = await retentionTotals(policy);
    // What the window is set to. What it is actually holding - the number that
    // says whether the setting is doing anything - the card asks for itself.
    const storedKeep = await getSetting(MAIL_BODY_KEEP_KEY);

    return (
        // Narrow: three settings and nothing wide, so the column is centred in
        // the content area rather than left against the rail.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Keeping records"
                description="How long Polaris keeps what it writes down about people using it. Anything older is taken away on a schedule."
            />
            <RetentionView policy={policy} totals={totals} />
            <div className="mt-4">
                <MailBodyForm kept={mailBodyKeep(storedKeep)} />
            </div>
        </div>
    );
}
