/**
 * Policies admin. Lists every policy with its document and attachments and lets
 * an admin author policies and bind them to users, groups, or roles. A policy is
 * a JSON document of allow/deny statements resolved by the @polaris/core engine;
 * the page resolves attachment ids to human labels so the bindings read clearly.
 *
 * Only the people a policy is attached to are read - by id - never the whole
 * directory: somebody to attach is found by name.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { PoliciesAdminLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function PoliciesAdminPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader
                title={t("policies.page.title")}
                description={t("policies.page.description")}
            />
            <PoliciesAdminLoader revision={Date.now()} />
        </>
    );
}
