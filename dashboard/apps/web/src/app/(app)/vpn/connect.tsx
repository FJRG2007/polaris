"use client";

/**
 * Connect: pick where to come out, on the map or the list, and connect from here
 * when this page is inside the Polaris app. A browser tab cannot start a VPN, so
 * it points at the app and the extension instead of asking anybody to set one up.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { useVpnRead } from "./use-vpn-read";
import { OwnVpns } from "./own-vpns";
import { Power, Trash2 } from "lucide-react";
import * as actions from "./connect-actions";
import { openProfileAction } from "./profile-actions";
import { desktopBridge } from "@/lib/desktop-bridge";
import { WorldMap, type MapPlace } from "./world-map";
import type { DesktopVpnStatus } from "@/lib/desktop-bridge";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

const GIB = 1024 ** 3;
/** A device counts as connected while its last handshake is this recent. */
const CONNECTED_MS = 3 * 60_000;

type Node = actions.ConnectAnswer["nodes"][number];
type TunnelCode = "denied" | "failed" | "noAnswer" | "unreachable";

const TUNNEL_CODES: ReadonlySet<string> = new Set<TunnelCode>([
    "denied",
    "failed",
    "noAnswer",
    "unreachable"
]);

function gib(bytes: string): string {
    return (Number(bytes) / GIB).toFixed(1);
}

function countryName(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
        return code;
    }
}

export function ConnectSection({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("vpn");
    const locale = useLocale();
    const read = useVpnRead<actions.ConnectAnswer>(
        "connect",
        actions.connectAction,
        t("errors.generic")
    );
    const [picked, setPicked] = useState<string | null>(null);
    const [tunnel, setTunnel] = useState<DesktopVpnStatus | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const data = read.data;
    const desktop = desktopBridge()?.vpn ?? null;
    const blocked = data && data.standing !== "active" ? data.standing : null;
    const nodes = data?.nodes ?? [];
    const profiles = data?.profiles ?? [];

    useEffect(() => {
        void desktop?.status().then(setTunnel);
    }, [desktop]);

    const where = (node: Node): string =>
        [node.city, node.country ? countryName(node.country, locale) : null]
            .filter(Boolean)
            .join(", ");
    const places = useMemo<MapPlace[]>(
        () =>
            [
                ...nodes.filter((node) => node.exit !== "tor"),
                ...profiles
            ].flatMap((place) =>
                place.country
                    ? [{ id: place.id, country: place.country, label: place.name }]
                    : []
            ),
        [nodes, profiles]
    );
    const active = tunnel?.nodeId ?? null;
    const selected = picked ?? active ?? nodes[0]?.id ?? profiles[0]?.id ?? null;
    const chosen = nodes.find(({ id }) => id === selected) ?? null;
    const chosenProfile = profiles.find(({ id }) => id === selected) ?? null;

    function tunnelError(code: string): string {
        return t(`connect.tunnel.${TUNNEL_CODES.has(code) ? (code as TunnelCode) : "failed"}`);
    }

    function remove(id: string): void {
        setError(null);
        startTransition(async () => {
            const result = await actions.removeVpnDeviceAction(id);
            if (result.error !== undefined) setError(result.error);
            read.reload();
        });
    }

    function connect(node: Node): void {
        if (!desktop) return;
        setError(null);
        startTransition(async () => {
            const publicKey = await desktop.key();
            if (!publicKey) return setError(t("connect.tunnel.denied"));
            const result = await actions.connectThisDeviceAction({
                nodeId: node.id,
                name: await desktop.deviceName(),
                publicKey
            });
            if (result.error !== undefined) return setError(result.error);
            const up = await desktop.up({ ...result.connection, nodeId: node.id });
            if (!up.ok) setError(tunnelError(up.error));
            setTunnel(await desktop.status());
            read.reload();
        });
    }

    function connectProfile(id: string): void {
        if (!desktop) return;
        setError(null);
        startTransition(async () => {
            const opened = await openProfileAction(id);
            if (opened.error !== undefined) return setError(opened.error);
            const { profile } = opened;
            const [address = "", ...moreAddresses] = profile.addresses;
            const up = await desktop.up({
                nodeId: id,
                address,
                dns: profile.dns,
                nodePublicKey: profile.publicKey,
                endpoint: profile.endpoint,
                port: profile.port,
                own: {
                    privateKey: profile.privateKey,
                    presharedKey: profile.presharedKey,
                    moreAddresses,
                    allowedIps: profile.allowedIps,
                    mtu: profile.mtu
                }
            });
            if (!up.ok) setError(tunnelError(up.error));
            setTunnel(await desktop.status());
        });
    }

    function disconnect(): void {
        if (!desktop) return;
        setError(null);
        startTransition(async () => {
            const down = await desktop.down();
            if (!down.ok) setError(tunnelError(down.error));
            setTunnel(await desktop.status());
        });
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
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

            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <ui.Card className="min-w-0 p-3">
                    <WorldMap
                        places={places}
                        selected={selected}
                        active={active}
                        onSelect={setPicked}
                    />
                </ui.Card>
                <section className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("connect.locations")}</h2>
                    {data === null ? (
                        <ui.Skeleton className="h-24 w-full" />
                    ) : nodes.length === 0 ? (
                        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                            <p>{t("connect.noNodes")}</p>
                            {isAdmin ? (
                                <Link
                                    href="/admin/apps/vpn/settings"
                                    className="w-fit text-primary hover:underline"
                                >
                                    {t("connect.setUp")}
                                </Link>
                            ) : null}
                        </div>
                    ) : (
                        <div
                            role="radiogroup"
                            aria-label={t("connect.locations")}
                            className="flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain"
                        >
                            {nodes.map((node) => (
                                <button
                                    key={node.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={node.id === selected}
                                    onClick={() => setPicked(node.id)}
                                    className={ui.cn(
                                        "flex min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                                        node.id === selected ? "bg-muted" : "hover:bg-muted/60"
                                    )}
                                >
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate font-medium" title={node.name}>
                                            {node.name}
                                        </span>
                                        {where(node) ? (
                                            <span className="truncate text-xs text-muted-foreground">
                                                {where(node)}
                                            </span>
                                        ) : null}
                                    </span>
                                    {node.exit === "tor" ? (
                                        <ui.Badge variant="neutral">{t("connect.tor")}</ui.Badge>
                                    ) : null}
                                    {node.id === active ? (
                                        <ui.Badge variant="success">{t("connect.online")}</ui.Badge>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    )}
                    {data ? (
                        <OwnVpns
                            profiles={profiles}
                            selected={selected}
                            active={active}
                            where={(profile) =>
                                [
                                    profile.city,
                                    profile.country ? countryName(profile.country, locale) : null
                                ]
                                    .filter(Boolean)
                                    .join(", ")
                            }
                            onSelect={setPicked}
                            onChanged={read.reload}
                            onError={setError}
                        />
                    ) : null}
                    {chosen?.exit === "tor" ? (
                        <p className="text-xs text-muted-foreground">{t("connect.torHint")}</p>
                    ) : null}
                </section>
            </div>

            {desktop ? (
                <div className="flex flex-wrap items-center gap-2">
                    {active ? (
                        <ui.Button variant="outline" disabled={pending} onClick={disconnect}>
                            <Power />
                            {t("connect.disconnect")}
                        </ui.Button>
                    ) : null}
                    {chosenProfile && chosenProfile.id !== active ? (
                        <ui.Button disabled={pending} onClick={() => connectProfile(chosenProfile.id)}>
                            <Power />
                            {t(active ? "connect.switchTo" : "connect.connectTo", {
                                name: chosenProfile.name
                            })}
                        </ui.Button>
                    ) : null}
                    {chosen && chosen.id !== active ? (
                        <ui.Button
                            disabled={pending || !!blocked}
                            onClick={() => connect(chosen)}
                        >
                            <Power />
                            {t(active ? "connect.switchTo" : "connect.connectTo", {
                                name: chosen.name
                            })}
                        </ui.Button>
                    ) : null}
                </div>
            ) : (
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                    <p className="text-muted-foreground">{t("connect.useApps")}</p>
                    <Link href="/account/downloads" className="w-fit text-primary hover:underline">
                        {t("connect.getApps")}
                    </Link>
                    <p className="text-xs text-muted-foreground">{t("connect.noPhoneApp")}</p>
                </div>
            )}
            {isAdmin ? (
                <Link
                    href="/admin/domains/remote-access"
                    className="w-fit text-sm text-primary hover:underline"
                >
                    {t("connect.remoteAccess")}
                </Link>
            ) : null}

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("connect.devices")}</h2>
                {data === null ? (
                    <ui.Skeleton className="h-16 w-full" />
                ) : data.devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("connect.empty")}</p>
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
                                        <ui.Badge variant="neutral">{t("connect.tor")}</ui.Badge>
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
        </div>
    );
}
