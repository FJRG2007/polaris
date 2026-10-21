/**
 * Display defaults admin (/admin/display): the units and formats new accounts
 * start from and every account that has not chosen its own keeps following.
 *
 * Only the header is drawn here. The values come from `/api/admin/display`
 * after the first paint (see `DisplayAdminPanel`), so opening the screen never
 * waits on a read before anything is on it.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { DisplayAdminPanel } from "./display-admin-panel";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function DisplayAdminPage() {
    const [, t] = await Promise.all([requireAdmin(), getTranslations("admin")]);

    return (
        // Narrow page: centre the column in the content area, header included, so
        // the form does not sit against the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("display.title")} description={t("display.description")} />
            {/* The form is the account page's too, and its words are there. */}
            <Messages namespaces={["account"]}>
                <DisplayAdminPanel />
            </Messages>
        </div>
    );
}
