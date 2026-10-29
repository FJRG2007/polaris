"use client";

/**
 * What the VPN screens show before the app is installed: what it is, and the
 * install for an administrator. Installing runs nothing; the control server
 * starts only when an administrator turns it on afterwards.
 */

import Link from "next/link";
import { useState, useTransition } from "react";
import { installVpnAppAction } from "./actions";
import { Button, EmptyState } from "@polaris/ui";
import { Loader2, Waypoints } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const LISTING = "/admin/apps?app=vpn";

export function VpnInstallState({ canInstall }: { canInstall: boolean }) {
    const t = useTranslations("vpn");
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    function install(): void {
        setError(null);
        startTransition(async () => {
            const result = await installVpnAppAction();
            if (result.error) {
                setError(result.error);
                return;
            }
            // A full load: the rail and the search above this page gain the app too.
            window.location.assign("/apps/vpn");
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <EmptyState
                icon={<Waypoints />}
                title={t("install.title")}
                description={canInstall ? t("install.body") : t("install.askAdmin")}
                action={
                    canInstall ? (
                        <>
                            <Button size="sm" onClick={install} disabled={pending}>
                                {pending ? <Loader2 className="animate-spin" /> : null}
                                {pending ? t("install.pending") : t("install.install")}
                            </Button>
                            <Button asChild size="sm" variant="ghost">
                                <Link href={LISTING}>{t("install.view")}</Link>
                            </Button>
                        </>
                    ) : undefined
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
