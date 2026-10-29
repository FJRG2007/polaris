"use client";

/**
 * Add a device: the official Tailscale app on each platform, pointed at this
 * VPN's control server instead of Tailscale's. The steps follow Tailscale's own
 * guide for a custom control server (tailscale.com/kb/1507); a platform whose
 * app has no field for it is given the one command it takes.
 *
 * A device that cannot open a browser to sign in - a server, a router, a TV
 * without a keyboard - takes a one-time key instead, made here for an hour.
 *
 * The platform list is a radio group of buttons, so it moves with the arrow
 * keys and a TV remote's D-pad as well as a pointer.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import * as actions from "../actions";
import { QRCodeSVG } from "qrcode.react";
import { useVpnRead } from "../use-vpn-read";
import { KeyRound, Loader2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";

const PLATFORMS = [
    "windows",
    "macos",
    "linux",
    "ios",
    "android",
    "androidTv",
    "appleTv",
    "router"
] as const;
type Platform = (typeof PLATFORMS)[number];

/** How many numbered steps each platform's guide has (`add.<platform>.stepN`). */
const STEPS: Record<Platform, number> = {
    windows: 3,
    macos: 3,
    linux: 2,
    ios: 4,
    android: 4,
    androidTv: 3,
    appleTv: 3,
    router: 2
};

/** The command a platform's guide shows, with the login server filled in. */
function commandFor(platform: Platform, server: string, key: string | null): string | null {
    if (platform === "windows" || platform === "macos" || platform === "linux")
        return `tailscale login --login-server=${server}`;
    if (platform === "router") return `tailscale up --login-server=${server} --authkey=${key ?? "<key>"}`;
    return null;
}

export function AddDeviceSection() {
    const t = useTranslations("vpn");
    const read = useVpnRead<actions.VpnOverview>("overview", actions.vpnOverviewAction, t("errors.generic"));
    const [platform, setPlatform] = useState<Platform>("windows");
    const [key, setKey] = useState<{ key: string; expiresAt: string } | null>(null);
    const [keyError, setKeyError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const tabs = useRef<(HTMLButtonElement | null)[]>([]);
    const status = read.data?.status ?? null;
    const server = status?.loginServer ?? null;

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        const step =
            event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
        if (step === 0) return;
        event.preventDefault();
        const next = (PLATFORMS.indexOf(platform) + step + PLATFORMS.length) % PLATFORMS.length;
        setPlatform(PLATFORMS[next] ?? "windows");
        tabs.current[next]?.focus();
    }

    function createKey(): void {
        setKeyError(null);
        startTransition(async () => {
            const result = await actions.createVpnKeyAction().catch(() => ({ error: t("errors.generic") }));
            if (result.error !== undefined) setKeyError(result.error);
            else setKey({ key: result.key, expiresAt: result.expiresAt });
        });
    }

    const command = server ? commandFor(platform, server, key?.key ?? null) : null;

    return (
        <div className="flex flex-col gap-4">
            <ui.Card>
                <ui.CardHeader>
                    <ui.CardTitle>{t("add.serverTitle")}</ui.CardTitle>
                </ui.CardHeader>
                <ui.CardBody>
                    {status === null ? (
                        read.error ? (
                            <p role="alert" className="text-sm text-danger">
                                {read.error}
                            </p>
                        ) : (
                            <div className="flex items-center gap-4" aria-busy="true">
                                <ui.Skeleton className="size-28" />
                                <ui.Skeleton className="h-5 w-64 max-w-full" />
                            </div>
                        )
                    ) : server && status.state === "running" ? (
                        <div className="flex min-w-0 flex-wrap items-center gap-4">
                            <div className="rounded-md bg-white p-2">
                                <QRCodeSVG value={server} size={112} bgColor="#ffffff" fgColor="#000000" />
                            </div>
                            <div className="flex min-w-0 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">{t("overview.loginServer")}</span>
                                <div className="flex min-w-0 items-center gap-2">
                                    <code className="truncate font-mono text-sm" title={server}>
                                        {server}
                                    </code>
                                    <ui.CopyButton value={server} label={t("overview.copy")} />
                                </div>
                                <p className="text-xs text-muted-foreground">{t("add.qrHint")}</p>
                            </div>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            {t("add.notRunning")}{" "}
                            <Link className="text-primary underline" href="/apps/vpn">
                                {t("add.openOverview")}
                            </Link>
                        </p>
                    )}
                </ui.CardBody>
            </ui.Card>

            <ui.Card>
                <ui.CardHeader>
                    <ui.CardTitle>{t("add.platformTitle")}</ui.CardTitle>
                </ui.CardHeader>
                <ui.CardBody className="flex flex-col gap-4">
                    <div
                        role="radiogroup"
                        aria-label={t("add.platformTitle")}
                        className="flex flex-wrap gap-2"
                        onKeyDown={onKeyDown}
                    >
                        {PLATFORMS.map((one, index) => (
                            <button
                                key={one}
                                ref={(node) => {
                                    tabs.current[index] = node;
                                }}
                                type="button"
                                role="radio"
                                aria-checked={platform === one}
                                tabIndex={platform === one ? 0 : -1}
                                onClick={() => setPlatform(one)}
                                className={ui.buttonVariants({
                                    size: "sm",
                                    variant: platform === one ? "primary" : "outline"
                                })}
                            >
                                {t(`add.${one}.name`)}
                            </button>
                        ))}
                    </div>
                    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
                        {Array.from({ length: STEPS[platform] }, (_, index) => (
                            <li key={index}>{t(`add.${platform}.step${index + 1}` as "add.windows.step1")}</li>
                        ))}
                    </ol>
                    {command ? (
                        <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2">
                            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
                                {command}
                            </code>
                            <ui.CopyButton value={command} label={t("add.copyCommand")} />
                        </div>
                    ) : null}
                </ui.CardBody>
            </ui.Card>

            <ui.Card>
                <ui.CardHeader>
                    <ui.CardTitle>{t("add.keyTitle")}</ui.CardTitle>
                </ui.CardHeader>
                <ui.CardBody className="flex flex-col items-start gap-3">
                    <p className="text-sm text-muted-foreground">{t("add.keyBody")}</p>
                    {key ? (
                        <div className="flex w-full min-w-0 flex-col gap-1">
                            <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2">
                                <code className="min-w-0 flex-1 truncate font-mono text-xs" title={key.key}>
                                    {key.key}
                                </code>
                                <ui.CopyButton value={key.key} label={t("add.copyKey")} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {t("add.keyExpires", { time: new Date(key.expiresAt).toLocaleTimeString() })}
                            </p>
                        </div>
                    ) : null}
                    <ui.Button
                        size="sm"
                        variant="outline"
                        disabled={pending || status?.state !== "running"}
                        title={status?.state !== "running" ? t("add.notRunning") : undefined}
                        onClick={createKey}
                    >
                        {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
                        {key ? t("add.anotherKey") : t("add.createKey")}
                    </ui.Button>
                    {keyError ? (
                        <p role="alert" className="text-sm text-danger">
                            {keyError}
                        </p>
                    ) : null}
                </ui.CardBody>
            </ui.Card>
        </div>
    );
}
