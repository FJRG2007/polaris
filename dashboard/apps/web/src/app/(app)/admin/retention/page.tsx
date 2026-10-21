/**
 * How long records are kept (/admin/retention).
 *
 * Three tables grow forever and nothing ever reads the old rows: the bell's
 * notifications, the activity every screen writes, and the audit trail. There
 * was no way to bound any of them and no way to be told there was a problem
 * until a disk filled - so this is the screen that says how long each is worth
 * keeping, with what is actually in them beside it.
 *
 * The counts are not read here: an unfiltered count over the activity and audit
 * tables is a scan, and the page drew nothing until it finished. The view asks
 * `/api/admin/retention/totals` after the first paint and keeps the last answer,
 * so a revisit shows the numbers at once.
 *
 * The mail body cache is the fourth thing that grows without a bound and the one
 * that grows fastest, so it is here too - as a count of messages rather than a
 * period, which is why it is its own card and not a fourth row of the table.
 *
 * Its count is fetched by the card for itself as well. The three tables are counted on an indexed timestamp; a
 * held body is `bodyText` or `bodyHtml` being set, which no index answers, over
 * the largest table in the product - so awaiting it here held the whole
 * navigation to /admin/retention for as long as that scan took. The card draws
 * without it and fills the number in.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { MailBodyForm } from "./mail-body-form";
import { getTranslations } from "@/lib/i18n/request";
import { RetentionView } from "./retention-view";
import { getSetting } from "@/lib/setting-store";
import { MAIL_BODY_KEEP_KEY, mailBodyKeep } from "@polaris/core";
import { retentionPolicy } from "@/lib/retention-service";

export const dynamic = "force-dynamic";

export default async function RetentionPage() {
    await requireAdmin();
    // Two settings rows and the words; the counts are the view's to ask for. What
    // the mail window is set to is read here, what it is holding the card asks for.
    const [t, policy, storedKeep] = await Promise.all([
        getTranslations("admin"),
        retentionPolicy(),
        getSetting(MAIL_BODY_KEEP_KEY)
    ]);

    return (
        // Narrow: three settings and nothing wide, so the column is centred in
        // the content area rather than left against the rail.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("retention.title")} description={t("retention.description")} />
            <RetentionView policy={policy} />
            <div className="mt-4">
                <MailBodyForm kept={mailBodyKeep(storedKeep)} />
            </div>
        </div>
    );
}
