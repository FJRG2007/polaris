"use client";

/**
 * What the Ad blocker screen shows before the app is installed: what it is, and
 * the install. Installing runs nothing; the DNS server starts only when somebody
 * turns blocking on afterwards.
 */

import Link from "next/link";
import { Loader2, ShieldBan } from "lucide-react";
import { useState, useTransition } from "react";
import { Button, EmptyState } from "@polaris/ui";
import { installDnsBlockerAppAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

const LISTING = "/apps/marketplace?app=dns-blocker";

export function DnsBlockerInstallState() {
    const t = useTranslations("dnsBlocker");
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    function install(): void {
        setError(null);
        startTransition(async () => {
            const result = await installDnsBlockerAppAction();
            if (result.error) {
                setError(result.error);
                return;
            }
            // A full load: the rail and the search above this page gain the app too.
            window.location.assign("/apps/dns-blocker");
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <EmptyState
                icon={<ShieldBan />}
                title={t("install.title")}
                description={t("install.body")}
                action={
                    <>
                        <Button size="sm" onClick={install} disabled={pending}>
                            {pending ? <Loader2 className="animate-spin" /> : null}
                            {pending ? t("install.pending") : t("install.install")}
                        </Button>
                        <Button asChild size="sm" variant="ghost">
                            <Link href={LISTING}>{t("install.view")}</Link>
                        </Button>
                    </>
                }
            />
            {error ? (
                <p role="alert" className="text-center text-sm text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
