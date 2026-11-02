"use client";

/**
 * Connect: pick where to come out, name the device, and take the configuration to the
 * official WireGuard app. The configuration appears once, since its key is not kept.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { QRCodeSVG } from "qrcode.react";
import { useVpnRead } from "./use-vpn-read";
import * as actions from "./connect-actions";
import { useState, useTransition } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const GIB = 1024 ** 3;
/** A device counts as connected while its last handshake is this recent. */
const CONNECTED_MS = 3 * 60_000;

function gib(bytes: string): string {
    return (Number(bytes) / GIB).toFixed(1);
}

export function ConnectSection({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("vpn");
    const read = useVpnRead<actions.ConnectAnswer>(
        "connect",
        actions.connectAction,
        t("errors.generic")
    );
    const [adding, setAdding] = useState(false);
    const [made, setMade] = useState<{ config: string; fileName: string } | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const data = read.data;
    const blocked = data && data.standing !== "active" ? data.standing : null;
    const full = data ? data.devices.length >= data.deviceLimit : false;

    function remove(id: string): void {
        setError(null);
        startTransition(async () => {
            const result = await actions.removeVpnDeviceAction(id);
            if (result.error !== undefined) setError(result.error);
            read.reload();
        });
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("connect.intro")}</p>
            {read.error ? <p className="text-sm text-danger">{read.error}</p> : null}
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            {blocked ? (
                <p className="text-sm text-warning">{t(`connect.standing.${blocked}`)}</p>
            ) : null}
            {data && data.dataLimitGb !== null ? (
                <p className="text-sm text-muted-foreground">
                    {t("connect.usage", { used: gib(data.usedBytes), limit: data.dataLimitGb })}
                </p>
            ) : null}
            <section className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium">{t("connect.devices")}</h2>
                    <ui.Button
                        size="sm"
                        disabled={!data || !!blocked || full || data.nodes.length === 0}
                        title={full ? t("connect.full", { count: data?.deviceLimit ?? 0 }) : undefined}
                        onClick={() => setAdding(true)}
                    >
                        <Plus />
                        {t("connect.add")}
                    </ui.Button>
                </div>
                {data?.nodes.length === 0 && isAdmin ? (
                    <Link
                        href="/admin/vpn/settings"
                        className="text-primary w-fit text-sm hover:underline"
                    >
                        {t("connect.setUp")}
                    </Link>
                ) : null}
                {data === null ? (
                    <ui.Skeleton className="h-16 w-full" />
                ) : data.devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {data.nodes.length === 0 ? t("connect.noNodes") : t("connect.empty")}
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {data.devices.map((device) => {
                            const seen = device.lastHandshake
                                ? new Date(device.lastHandshake).getTime()
                                : 0;
                            const online = Date.now() - seen < CONNECTED_MS;
                            return (
                                <li
                                    key={device.id}
                                    className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                                >
                                    <span className="min-w-0 truncate font-medium" title={device.name}>
                                        {device.name}
                                    </span>
                                    <ui.Badge variant={online ? "success" : "neutral"}>
                                        {online ? t("connect.online") : t("connect.offline")}
                                    </ui.Badge>
                                    <span className="min-w-0 truncate text-muted-foreground">
                                        {device.node.name}
                                    </span>
                                    {device.node.exit === "tor" ? (
                                        <ui.Badge variant="neutral">Tor</ui.Badge>
                                    ) : null}
                                    <ui.Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("connect.remove")}
                                        title={t("connect.remove")}
                                        disabled={pending}
                                        onClick={() => remove(device.id)}
                                    >
                                        <Trash2 />
                                    </ui.Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
            {adding && data ? (
                <AddDevice
                    nodes={data.nodes}
                    onClose={() => setAdding(false)}
                    onMade={(next) => {
                        setAdding(false);
                        setMade(next);
                        read.reload();
                    }}
                />
            ) : null}
            {made ? <DeviceConfig made={made} onClose={() => setMade(null)} /> : null}
        </div>
    );
}

function AddDevice({
    nodes,
    onClose,
    onMade
}: {
    nodes: actions.ConnectAnswer["nodes"];
    onClose: () => void;
    onMade: (made: { config: string; fileName: string }) => void;
}) {
    const t = useTranslations("vpn");
    const [name, setName] = useState("");
    const [nodeId, setNodeId] = useState(nodes[0]?.id ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const chosen = nodes.find(({ id }) => id === nodeId);

    function add(): void {
        if (name.trim() === "" || pending) return;
        setError(null);
        startTransition(async () => {
            const result = await actions.addVpnDeviceAction({ nodeId, name });
            if (result.error !== undefined) setError(result.error);
            else onMade(result);
        });
    }

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("connect.add")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("connect.addBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                        {`${t("connect.name")} *`}
                        <ui.Input
                            value={name}
                            maxLength={40}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    <ui.Select
                        aria-label={t("connect.location")}
                        value={nodeId}
                        onValueChange={setNodeId}
                        options={nodes.map(({ id, name: label, exit }) => ({
                            value: id,
                            label: exit === "tor" ? `${label} (Tor)` : label
                        }))}
                    />
                    {chosen?.exit === "tor" ? (
                        <p className="text-xs text-muted-foreground">{t("connect.torHint")}</p>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" onClick={onClose}>
                        {t("connect.cancel")}
                    </ui.Button>
                    <ui.Button size="sm" aria-disabled={name.trim() === "" || pending} onClick={add}>
                        {t("connect.create")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}

function DeviceConfig({
    made,
    onClose
}: {
    made: { config: string; fileName: string };
    onClose: () => void;
}) {
    const t = useTranslations("vpn");

    function download(): void {
        const url = URL.createObjectURL(new Blob([made.config], { type: "text/plain" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = made.fileName;
        link.click();
        URL.revokeObjectURL(url);
    }

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("connect.madeTitle")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("connect.madeBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col items-center gap-3">
                    <div className="rounded-md bg-white p-3">
                        <QRCodeSVG value={made.config} size={220} level="L" />
                    </div>
                    <p className="text-center text-xs text-muted-foreground">{t("connect.once")}</p>
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="secondary" size="sm" onClick={download}>
                        <Download />
                        {t("connect.download")}
                    </ui.Button>
                    <ui.Button size="sm" onClick={onClose}>
                        {t("connect.done")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}
