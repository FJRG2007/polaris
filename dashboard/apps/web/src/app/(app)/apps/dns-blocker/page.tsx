/**
 * Ad blocker (/apps/dns-blocker). A DNS server for the whole network that leaves
 * out ads, trackers and malware: where it stands, what to type into the router,
 * and what it blocks.
 *
 * A marketplace app: until it is installed this screen offers the install. The
 * settings are one row and come with the page; where the blocker stands is asked
 * of port 53 after the first paint.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { DnsBlockerView } from "./dns-blocker-view";
import { DnsBlockerInstallState } from "./install-state";
import { routerBrandsFor } from "@/lib/router-guide";
import { getTranslations } from "@/lib/i18n/request";
import { routerGuideIn } from "@/app/(app)/admin/domains/router-words";
import { readSettings, DnsBlockerRefusal } from "@/lib/dns-blocker/service";

export const dynamic = "force-dynamic";

export default async function DnsBlockerPage() {
    await requireAdmin();
    const [t, tAdmin, settings] = await Promise.all([
        getTranslations("dnsBlocker"),
        getTranslations("admin"),
        readSettings().catch((error: unknown) => {
            if (error instanceof DnsBlockerRefusal) return null;
            throw error;
        })
    ]);
    const brands = routerBrandsFor("dns").map((entry) => ({
        value: entry.id,
        label: routerGuideIn(tAdmin, entry).label
    }));
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col">
            <PageHeader title={t("page.title")} description={t("page.description")} />
            {settings ? (
                <DnsBlockerView initial={settings} brands={brands} />
            ) : (
                <DnsBlockerInstallState />
            )}
        </div>
    );
}
