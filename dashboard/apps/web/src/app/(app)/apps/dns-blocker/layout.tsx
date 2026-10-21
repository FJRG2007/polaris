/**
 * Every screen of the Network filter (/apps/dns-blocker and its sections).
 *
 * A marketplace app: until it is installed every section offers the install.
 * The settings are one row, read here once and shared by the sections, so moving
 * between them keeps an edit not yet saved; where the blocker stands is asked of
 * port 53 after the first paint.
 */

import type { ReactNode } from "react";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { DnsBlockerInstallState } from "./install-state";
import { DnsBlockerProvider } from "./dns-blocker-context";
import { readSettings, DnsBlockerRefusal } from "@/lib/dns-blocker/service";

export const dynamic = "force-dynamic";

export default async function DnsBlockerLayout({ children }: { children: ReactNode }) {
    await requireAdmin();
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
                <PageHeader title={t("page.title")} description={t("page.description")} />
                {settings ? (
                    <DnsBlockerProvider initial={settings}>{children}</DnsBlockerProvider>
                ) : (
                    <DnsBlockerInstallState />
                )}
            </div>
        </Messages>
    );
}
