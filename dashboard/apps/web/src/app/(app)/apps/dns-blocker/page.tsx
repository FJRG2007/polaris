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
import { DnsInsightsCard } from "./dns-insights";
import { DnsBlockerView } from "./dns-blocker-view";
import { DnsBlockerInstallState } from "./install-state";
import { getTranslations } from "@/lib/i18n/request";
import { readSettings, DnsBlockerRefusal } from "@/lib/dns-blocker/service";

export const dynamic = "force-dynamic";

export default async function DnsBlockerPage() {
    await requireAdmin();
    const [t, settings] = await Promise.all([
        getTranslations("dnsBlocker"),
        readSettings().catch((error: unknown) => {
            if (error instanceof DnsBlockerRefusal) return null;
            throw error;
        })
    ]);
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col">
            <PageHeader title={t("page.title")} description={t("page.description")} />
            {settings ? (
                <div className="flex flex-col gap-4">
                    <DnsBlockerView initial={settings} />
                    <DnsInsightsCard />
                </div>
            ) : (
                <DnsBlockerInstallState />
            )}
        </div>
    );
}
