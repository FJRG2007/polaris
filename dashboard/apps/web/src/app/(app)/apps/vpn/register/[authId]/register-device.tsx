"use client";

/**
 * A device asking to join the VPN, as the person signed in here sees it: the
 * request, and "Add this device", which adds it to their own devices. Nothing
 * happens until they press it - opening a link is never consent.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import * as actions from "@/app/(app)/apps/vpn/actions";
import { useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CheckCircle2, Loader2, MonitorSmartphone } from "lucide-react";

export function RegisterDevice({
    authId,
    account,
    isAdmin
}: {
    authId: string | null;
    account: string;
    isAdmin: boolean;
}) {
    const t = useTranslations("vpn");
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [added, setAdded] = useState<string | null>(null);

    if (!authId) {
        return <ui.EmptyState title={t("register.badTitle")} description={t("register.badBody")} />;
    }

    function add(): void {
        setError(null);
        startTransition(async () => {
            const result = await actions
                .registerVpnDeviceAction({ authId })
                .catch(() => ({ error: t("errors.generic") }));
            if (result.error !== undefined) setError(result.error);
            else setAdded(result.device.name);
        });
    }

    if (added) {
        return (
            <ui.EmptyState
                icon={<CheckCircle2 />}
                title={t("register.addedTitle", { name: added })}
                description={t("register.addedBody")}
                action={
                    <ui.Button asChild size="sm">
                        <Link href="/apps/vpn/devices">{t("register.openDevices")}</Link>
                    </ui.Button>
                }
            />
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <ui.EmptyState
                icon={<MonitorSmartphone />}
                title={t("register.title")}
                description={t(isAdmin ? "register.adminBody" : "register.body", { account })}
                action={
                    <>
                        <ui.Button size="sm" autoFocus onClick={add} disabled={pending}>
                            {pending ? <Loader2 className="animate-spin" /> : null}
                            {t("register.add")}
                        </ui.Button>
                        <ui.Button asChild size="sm" variant="ghost">
                            <Link href="/apps/vpn">{t("actions.cancel")}</Link>
                        </ui.Button>
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
