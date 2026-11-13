"use client";

/**
 * The devices that connect to the VPN's own servers from the Polaris app or
 * extension: the reader's own, or every one for an administrator, with whose it
 * is. A device appears the first time it connects, so adding one is getting the
 * apps; there is nothing to install from anybody else.
 *
 * Only the list waits on the server; the heading and the link paint first.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { Trash2 } from "lucide-react";
import { useVpnRead } from "../use-vpn-read";
import { useState, useTransition } from "react";
import * as actions from "../connect-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type * as service from "@/lib/vpn/wireguard-service";

/** A device counts as online while its last handshake is this recent. */
const ONLINE_MS = 3 * 60_000;

type Answer = { devices: Device[] };
type Device = Awaited<ReturnType<typeof service.devicesFor>>[number];

export function AppDevicesSection({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("vpn");
    const read = useVpnRead<Answer>(
        "app-devices",
        actions.vpnAppDevicesAction,
        t("errors.generic")
    );
    const [removing, setRemoving] = useState<Device | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const devices = read.data?.devices ?? null;

    function remove(device: Device): void {
        setError(null);
        startTransition(async () => {
            const result = await actions
                .removeVpnDeviceAction(device.id)
                .catch(() => ({ error: t("errors.generic") }));
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setRemoving(null);
            if (read.data)
                read.set({ devices: read.data.devices.filter((one) => one.id !== device.id) });
        });
    }

    const addDevice = (
        <ui.Button asChild size="sm">
            <Link href="/account/downloads">{t("appDevices.add")}</Link>
        </ui.Button>
    );

    return (
        <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-sm text-muted-foreground">
                    {isAdmin ? t("appDevices.adminIntro") : t("appDevices.intro")}
                </p>
                {addDevice}
            </div>
            {devices === null ? (
                read.error ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <p role="alert" className="text-sm text-danger">
                            {read.error}
                        </p>
                        <ui.Button size="sm" variant="ghost" onClick={read.reload}>
                            {t("actions.retry")}
                        </ui.Button>
                    </div>
                ) : (
                    <ul className="flex flex-col gap-2" aria-busy="true">
                        {[0, 1, 2].map((row) => (
                            <li key={row}>
                                <ui.Skeleton className="h-12 w-full" />
                            </li>
                        ))}
                    </ul>
                )
            ) : devices.length === 0 ? (
                <ui.EmptyState
                    title={t("appDevices.emptyTitle")}
                    description={t("appDevices.emptyBody")}
                    action={addDevice}
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {devices.map((device) => {
                        const seen = device.lastHandshake
                            ? new Date(device.lastHandshake).getTime()
                            : 0;
                        const online = Date.now() - seen < ONLINE_MS;
                        const owner = device.user.name || device.user.email;
                        return (
                            <li
                                key={device.id}
                                className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-medium" title={device.name}>
                                    {device.name}
                                </span>
                                <ui.Badge variant={online ? "success" : "neutral"}>
                                    {online ? t("connect.online") : t("connect.offline")}
                                </ui.Badge>
                                <span
                                    className="min-w-0 truncate text-muted-foreground"
                                    title={device.node.name}
                                >
                                    {device.node.name}
                                </span>
                                {device.node.exit === "tor" ? (
                                    <ui.Badge variant="neutral">{t("connect.tor")}</ui.Badge>
                                ) : null}
                                {isAdmin ? (
                                    <span
                                        className="min-w-0 truncate text-xs text-muted-foreground"
                                        title={owner}
                                    >
                                        {owner}
                                    </span>
                                ) : null}
                                <ui.Button
                                    size="icon"
                                    variant="ghost"
                                    className="ml-auto"
                                    aria-label={t("connect.remove")}
                                    title={t("connect.remove")}
                                    disabled={pending}
                                    onClick={() => setRemoving(device)}
                                >
                                    <Trash2 />
                                </ui.Button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <ui.ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                kind={t("devices.kind")}
                name={removing?.name ?? ""}
                description={t("appDevices.removeBody")}
                confirmLabel={t("connect.remove")}
                pending={pending}
                error={error}
                onConfirm={() => removing && remove(removing)}
            />
        </section>
    );
}
