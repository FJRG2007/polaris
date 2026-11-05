/**
 * Badges admin (/admin/badges): the instance's own badges and who has them.
 * Only the header is drawn here; the badges load after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { BadgesAdmin } from "./badges-admin";
import { getTranslations } from "@/lib/i18n/request";
import { instanceTag } from "@/lib/name-tags/name-tag-service";
import { InstanceNameTag } from "./instance-name-tag";

export const dynamic = "force-dynamic";

export default async function BadgesAdminPage() {
    const [, t, tag] = await Promise.all([requireAdmin(), getTranslations("admin"), instanceTag()]);
    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title={t("overview.sections.badges.title")}
                description={t("overview.sections.badges.description")}
            />
            <div className="mb-4">
                <InstanceNameTag initial={tag} />
            </div>
            <BadgesAdmin />
        </div>
    );
}
