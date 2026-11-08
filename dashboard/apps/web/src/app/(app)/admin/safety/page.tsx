/**
 * What needs an administrator (/admin/safety).
 *
 * One screen for one question. Reported messages were already here under their
 * own address; reported people and accounts that have shut themselves down had
 * nowhere to be. Three queues would have been three places to remember to look,
 * and a thing nobody looks at is not a queue.
 *
 * The two halves stay two services underneath, because they are two shapes: a
 * report about a message carries the message, and a case about a person carries
 * a person. What they share is the answer - somebody decides, and the decision is
 * recorded with their name on it.
 */

import { SeenOnVisit } from "@/components/seen-on-visit";
import { PageHeader } from "@polaris/ui";
import { SafetyLoader } from "./loader";
import { requireAdmin } from "@/lib/session";
import { SAFETY_CASE_STATUSES } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function SafetyPage({
    searchParams
}: {
    searchParams: Promise<{ status?: string }>;
}) {
    await requireAdmin();
    const status = (await searchParams).status;
    const t = await getTranslations("admin");
    const known = (SAFETY_CASE_STATUSES as readonly string[]).includes(status ?? "") || status === "all";

    return (
        <>
            <PageHeader
                title={t("safety.page.title")}
                description={t("safety.page.description")}
            />
            {/* The reports and cases this page lists are ones the reader has seen. */}
            <SeenOnVisit screen="/admin/safety" />
            <SafetyLoader
                status={typeof status === "string" ? status.slice(0, 40) : undefined}
                shownStatus={known ? (status as string) : "open"}
                revision={Date.now()}
            />
        </>
    );
}
