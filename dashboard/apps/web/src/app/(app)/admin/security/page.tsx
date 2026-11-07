/**
 * Management > Security: what this deployment demands of every account on it.
 *
 * Distinct from Account > Security, which is what one person demands of their own
 * account. The two do not overlap and neither can weaken the other: a person can
 * add protection here that the instance did not ask for, and cannot drop what it
 * did.
 *
 * Whether mail works is resolved on the server and handed down, because "accept
 * emailed codes" is a promise the deployment can only keep when it has a channel
 * to send from - and an administrator turning it on deserves to be told that now
 * rather than by a user who cannot finish signing in.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { SecurityAdminLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AdminSecurityPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader title={t("security.title")} description={t("security.description")} />
            <div className="flex flex-col gap-4">
                <SecurityAdminLoader revision={Date.now()} />
            </div>
        </>
    );
}
