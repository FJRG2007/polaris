"use client";

/**
 * The devices on the VPN: the reader's own, or every one for an administrator.
 * Each row has its name, owner, addresses and whether it is online; its owner
 * (or an administrator) renames or removes it, and an administrator approves
 * the exit node and the subnet routes it offers.
 *
 * Rename and route changes are shown at once and put back if the control
 * server refuses them. Only the list waits on the server; the heading and the
 * Add a device link paint first.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import * as actions from "../actions";
import { useVpnRead } from "../use-vpn-read";
import { useState, useTransition } from "react";
import type { VpnDevice } from "@/lib/vpn/service";
import { deviceNameSchema } from "@/lib/vpn/settings";
import { Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

type List = { devices: VpnDevice[] };

export function VpnDevicesSection({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("vpn");
    const read = useVpnRead<List>("devices", actions.listVpnDevicesAction, t("errors.generic"));
    const [removing, setRemoving] = useState<VpnDevice | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const devices = read.data?.devices ?? null;

    function replace(next: VpnDevice): void {
        if (!devices) return;
        read.set({ devices: devices.map((device) => (device.id === next.id ? next : device)) });
    }

    /** Show `optimistic` now, keep what the server answers, and put the row
     *  back when it refuses. */
    function change(
        before: VpnDevice,
        optimistic: VpnDevice,
        action: () => Promise<{ error: string } | { error?: undefined; device: VpnDevice }>
    ): void {
        setError(null);
        replace(optimistic);
        startTransition(async () => {
            const result = await action().catch(() => ({ error: t("errors.generic") }));
            if (result.error !== undefined) {
                replace(before);
                setError(result.error);
                return;
            }
            replace(result.device);
        });
    }

    function remove(device: VpnDevice): void {
        setError(null);
        startTransition(async () => {
            const result = await actions
                .removeVpnDeviceAction({ nodeId: device.id })
                .catch(() => ({ error: t("errors.generic") }));
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setRemoving(null);
            if (devices) read.set({ devices: devices.filter((one) => one.id !== device.id) });
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                    {isAdmin ? t("devices.adminIntro") : t("devices.intro")}
                </p>
                <ui.Button asChild size="sm">
                    <Link href="/apps/vpn/add">{t("actions.addDevice")}</Link>
                </ui.Button>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
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
                                <ui.Skeleton className="h-16 w-full" />
                            </li>
                        ))}
                    </ul>
                )
            ) : devices.length === 0 ? (
                <ui.EmptyState
                    title={t("devices.emptyTitle")}
                    description={t("devices.emptyBody")}
                    action={
                        <ui.Button asChild size="sm">
                            <Link href="/apps/vpn/add">{t("actions.addDevice")}</Link>
                        </ui.Button>
                    }
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {devices.map((device) => (
                        <DeviceRow
                            key={device.id}
                            device={device}
                            isAdmin={isAdmin}
                            busy={pending}
                            onRename={(name) =>
                                change(device, { ...device, name }, () =>
                                    actions.renameVpnDeviceAction({ nodeId: device.id, name })
                                )
                            }
                            onRoutes={(exitNode, routes) =>
                                change(
                                    device,
                                    {
                                        ...device,
                                        exitNode: { ...device.exitNode, approved: exitNode },
                                        routes: device.routes.map((one) => ({
                                            ...one,
                                            approved: routes.includes(one.route)
                                        }))
                                    },
                                    () =>
                                        actions.setVpnDeviceRoutesAction({
                                            nodeId: device.id,
                                            exitNode,
                                            routes
                                        })
                                )
                            }
                            onRemove={() => setRemoving(device)}
                        />
                    ))}
                </ul>
            )}
            <ui.ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                kind={t("devices.kind")}
                name={removing?.name ?? ""}
                description={t("devices.removeBody")}
                confirmLabel={t("devices.remove")}
                pending={pending}
                error={error}
                onConfirm={() => removing && remove(removing)}
            />
        </div>
    );
}

function DeviceRow({
    device,
    isAdmin,
    busy,
    onRename,
    onRoutes,
    onRemove
}: {
    device: VpnDevice;
    isAdmin: boolean;
    busy: boolean;
    onRename: (name: string) => void;
    onRoutes: (exitNode: boolean, routes: string[]) => void;
    onRemove: () => void;
}) {
    const t = useTranslations("vpn");
    const [editing, setEditing] = useState<string | null>(null);
    const parsed = editing === null ? null : deviceNameSchema.safeParse(editing);
    const owner = device.owner.displayName || device.owner.email || device.owner.name;
    const approvedRoutes = device.routes.filter((one) => one.approved).map((one) => one.route);

    function save(): void {
        if (!parsed?.success) return;
        setEditing(null);
        if (parsed.data !== device.name) onRename(parsed.data);
    }

    return (
        <li className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                    className={`size-2 shrink-0 rounded-full ${device.online ? "bg-success" : "bg-muted-foreground/40"}`}
                    aria-hidden
                />
                {editing === null ? (
                    <span className="min-w-0 truncate font-medium" title={device.name}>
                        {device.name}
                    </span>
                ) : (
                    <form
                        className="flex min-w-0 items-center gap-1"
                        onSubmit={(event) => {
                            event.preventDefault();
                            save();
                        }}
                    >
                        <ui.Input
                            autoFocus
                            aria-label={t("devices.name")}
                            aria-invalid={parsed?.success === false && editing !== ""}
                            className="h-8 w-48"
                            value={editing}
                            onChange={(event) => setEditing(event.target.value)}
                            onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
                        />
                        <ui.Button
                            type="submit"
                            size="icon"
                            variant="ghost"
                            aria-label={t("devices.saveName")}
                            title={t("devices.saveName")}
                            aria-disabled={!parsed?.success}
                        >
                            <Check />
                        </ui.Button>
                        <ui.Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={t("actions.cancel")}
                            title={t("actions.cancel")}
                            onClick={() => setEditing(null)}
                        >
                            <X />
                        </ui.Button>
                    </form>
                )}
                <ui.Badge variant={device.online ? "success" : "neutral"}>
                    {device.online ? t("devices.online") : t("devices.offline")}
                </ui.Badge>
                <div className="ml-auto flex items-center gap-1">
                    {editing === null ? (
                        <ui.Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("devices.rename")}
                            title={t("devices.rename")}
                            disabled={busy}
                            onClick={() => setEditing(device.name)}
                        >
                            <Pencil />
                        </ui.Button>
                    ) : null}
                    <ui.Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("devices.remove")}
                        title={t("devices.remove")}
                        disabled={busy}
                        onClick={onRemove}
                    >
                        {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    </ui.Button>
                </div>
            </div>
            {editing !== null && parsed?.success === false && editing !== "" ? (
                <p className="text-xs text-danger">{t("devices.badName")}</p>
            ) : null}
            <dl className="grid min-w-0 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                {isAdmin ? (
                    <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{t("devices.owner")}</dt>
                        <dd className="truncate" title={owner}>
                            {owner}
                        </dd>
                    </div>
                ) : null}
                <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{t("devices.addresses")}</dt>
                    {device.addresses.map((address) => (
                        <dd key={address} className="flex min-w-0 items-center gap-1">
                            <code className="truncate font-mono text-xs" title={address}>
                                {address}
                            </code>
                            <ui.CopyButton value={address} label={t("devices.copyAddress")} />
                        </dd>
                    ))}
                </div>
                <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{t("devices.lastSeen")}</dt>
                    <dd>
                        {device.online
                            ? t("devices.now")
                            : device.lastSeen
                              ? new Date(device.lastSeen).toLocaleString()
                              : t("devices.never")}
                    </dd>
                </div>
            </dl>
            {device.exitNode.offered || device.routes.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-border pt-2">
                    {device.exitNode.offered ? (
                        <label className="flex items-center justify-between gap-3 text-sm">
                            <span className="min-w-0">
                                {t("devices.exitNode")}
                                {!isAdmin ? (
                                    <span className="block text-xs text-muted-foreground">
                                        {t("devices.adminApproves")}
                                    </span>
                                ) : null}
                            </span>
                            <ui.Switch
                                checked={device.exitNode.approved}
                                disabled={!isAdmin || busy}
                                onChange={(on: boolean) => onRoutes(on, approvedRoutes)}
                            />
                        </label>
                    ) : null}
                    {device.routes.map((one) => (
                        <label key={one.route} className="flex items-center justify-between gap-3 text-sm">
                            <span className="min-w-0 truncate">
                                {t("devices.subnet", { route: one.route })}
                            </span>
                            <ui.Switch
                                checked={one.approved}
                                disabled={!isAdmin || busy}
                                onChange={(on: boolean) =>
                                    onRoutes(
                                        device.exitNode.approved,
                                        on
                                            ? [...approvedRoutes, one.route]
                                            : approvedRoutes.filter((route) => route !== one.route)
                                    )
                                }
                            />
                        </label>
                    ))}
                </div>
            ) : null}
        </li>
    );
}
