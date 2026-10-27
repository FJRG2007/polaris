/**
 * Domain security (/admin/domains/security): every domain Polaris knows, checked
 * for spoofing, DNS, registration and HTTPS problems. Admin-only.
 *
 * Awaits nothing but the admin check: the inventory reads itself, after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { SecurityInventory } from "@/components/domain-security/security-inventory";

export const dynamic = "force-dynamic";

export default async function DomainSecurityPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col">
            <PageHeader
                title={t("domains.pages.security.title")}
                description={t("domains.pages.security.description")}
            />
            <Messages namespaces={["domainSecurity"]}>
                <SecurityInventory />
            </Messages>
        </div>
    );
}
