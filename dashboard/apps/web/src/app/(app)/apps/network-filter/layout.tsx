/**
 * Every screen of the Network filter (/apps/network-filter and its sections).
 *
 * A marketplace app: until it is installed every section offers the install.
 * The settings are one row, read here once and shared by the sections, so moving
 * between them keeps an edit not yet saved; where the blocker stands is asked of
 * port 53 after the first paint.
 *
 * Somebody an administrator shared the statistics with (`dns.filter`) gets the
 * header marked as shared and the Overview, which shows them the long-term
 * statistics only; every other section stays with administrators.
 */

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Badge, PageHeader } from "@polaris/ui";
import { homePathForUser, requireUser } from "@/lib/session";
import { dnsFilterReach } from "@/lib/dns-blocker/access";
import { DnsShareButton } from "./share-button";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { DnsBlockerInstallState } from "./install-state";
import { DnsBlockerProvider } from "./dns-blocker-context";
import { readSettings, DnsBlockerRefusal } from "@/lib/dns-blocker/service";

export const dynamic = "force-dynamic";

export default async function DnsBlockerLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const reach = await dnsFilterReach(user);
    if (!reach) redirect(`${await homePathForUser(user)}?denied=1`);
    if (reach === "shared") {
        const t = await getTranslations("dnsBlocker");
        return (
            <Messages namespaces={["dnsBlocker"]}>
                <div className="mx-auto flex w-full max-w-6xl flex-col">
                    <PageHeader
                        title={t("page.title")}
                        description={t("page.description")}
                        actions={<Badge variant="neutral">{t("shared.sharedWithYou")}</Badge>}
                    />
                    {children}
                </div>
            </Messages>
        );
    }
    const [t, settings] = await Promise.all([
        getTranslations("dnsBlocker"),
        readSettings().catch((error: unknown) => {
            if (error instanceof DnsBlockerRefusal) return null;
            throw error;
        })
    ]);
    return (
        <Messages namespaces={["dnsBlocker"]}>
            <div className="mx-auto flex w-full max-w-6xl flex-col">
                <PageHeader
                    title={t("page.title")}
                    description={t("page.description")}
                    actions={settings ? <DnsShareButton /> : undefined}
                />
                {settings ? (
                    <DnsBlockerProvider initial={settings}>{children}</DnsBlockerProvider>
                ) : (
                    <DnsBlockerInstallState />
                )}
            </div>
        </Messages>
    );
}
