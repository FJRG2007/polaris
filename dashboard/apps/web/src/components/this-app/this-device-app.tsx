"use client";

/**
 * The Polaris app this page runs in, at the top of Downloads: its version, a
 * check for a newer one, the download's progress and the restart into it.
 * Nothing in a browser, where Downloads is only the list of what to install.
 *
 * Drawn from what the app knows at once (its version is on the bridge itself),
 * so it never waits. With no connection - Downloads opened from the window's
 * cache - a check cannot answer, so it is held with a reason; a restart into an
 * update already downloaded needs none and stays.
 */

import * as core from "@polaris/core/app-settings";
import { useEffect, useRef, useState } from "react";
import { Button, Card, CardBody } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useNetworkState } from "@enigmax/primitives/react/network";
import { phoneAppSettings, type PhoneAppSettings } from "@/lib/mobile-bridge";
import { useDesktopBridge, usePhoneAppSettings } from "@/components/desktop-app";
import { readDesktopUpdateCheck, type DesktopUpdateCheck, type PolarisDesktop } from "@/lib/desktop-bridge";

export function ThisDeviceApp() {
    const bridge = useDesktopBridge();
    const phone = usePhoneAppSettings();
    if (bridge && (bridge.checkForUpdates || bridge.updateReady || bridge.appSettings)) {
        return <DesktopApp bridge={bridge} />;
    }
    if (phone) {
        const settings = phoneAppSettings();
        if (settings) return <PhoneApp settings={settings} />;
    }
    return null;
}

function Shell({ label, hint, children }: { label: string; hint: string | null; children: React.ReactNode }) {
    const t = useTranslations("appSettings");
    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <h2 className="text-sm font-medium">{t("updates.title")}</h2>
                    <span className="truncate text-sm" title={label}>
                        {label}
                    </span>
                    {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-2">{children}</div>
            </CardBody>
        </Card>
    );
}

type UpdateState = { readonly kind: "idle" } | { readonly kind: "checking" } | DesktopUpdateCheck;

/** The last state this session, so Downloads opened again mid-check or mid-download picks it up. */
let lastDesktopState: UpdateState = { kind: "idle" };

/** Only for tests. */
export function forgetDesktopUpdateState(): void {
    lastDesktopState = { kind: "idle" };
}

function DesktopApp({ bridge }: { bridge: PolarisDesktop }) {
    const t = useTranslations("appSettings");
    const [state, setStateRaw] = useState<UpdateState>(lastDesktopState);
    const { online } = useNetworkState();
    const live = useRef(true);
    const setState = (next: UpdateState) => {
        lastDesktopState = next;
        if (live.current) setStateRaw(next);
    };

    // An update already downloaded, or one that finishes while the page is open.
    useEffect(() => {
        live.current = true;
        void bridge
            .updateReady?.()
            .then((ready) => {
                if (ready) setState({ kind: "ready", version: ready.version });
            })
            .catch(() => undefined);
        const stop = bridge.onUpdateReady?.((ready) => {
            if (ready) setState({ kind: "ready", version: ready.version });
        });
        return () => {
            live.current = false;
            stop?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bridge]);

    const message = (() => {
        switch (state.kind) {
            case "idle":
                return null;
            case "checking":
                return t("updates.checking");
            case "current":
                return t("updates.current");
            case "downloading":
                return t("updates.downloading", { version: state.version });
            case "ready":
                return t("updates.ready", { version: state.version });
            case "available":
                return t("updates.availableBelow", { version: state.version });
            case "failed":
                return t("updates.failed");
            case "unsupported":
                return t("updates.unsupported");
        }
    })();
    const busy = state.kind === "checking" || state.kind === "downloading";
    const waiting = !online && state.kind !== "ready";

    return (
        <Shell label={t("updates.version", { version: bridge.version })} hint={waiting ? t("updates.offline") : message}>
            {state.kind === "ready" && bridge.installUpdate ? (
                <Button size="sm" onClick={() => void bridge.installUpdate?.()}>
                    {t("updates.restart")}
                </Button>
            ) : bridge.checkForUpdates ? (
                <Button
                    size="sm"
                    variant="secondary"
                    aria-disabled={busy || waiting}
                    title={waiting ? t("updates.offline") : undefined}
                    onClick={() => {
                        if (busy || waiting) return;
                        setState({ kind: "checking" });
                        void bridge
                            .checkForUpdates?.()
                            .catch(() => null)
                            .then((found) => setState(readDesktopUpdateCheck(found)));
                    }}
                >
                    {t("updates.check")}
                </Button>
            ) : null}
        </Shell>
    );
}

type PhoneUpdateState = { readonly kind: "idle" } | { readonly kind: "checking" } | core.AppPhoneUpdateCheck;

function PhoneApp({ settings }: { settings: PhoneAppSettings }) {
    const t = useTranslations("appSettings");
    const [snapshot] = useState<core.AppPhoneSnapshot | null>(() => settings.read());
    const [state, setState] = useState<PhoneUpdateState>({ kind: "idle" });
    const { online } = useNetworkState();
    const live = useRef(true);
    useEffect(() => {
        live.current = true;
        return () => {
            live.current = false;
        };
    }, []);
    if (!snapshot) return null;

    const message = (() => {
        if (snapshot.updates === "store") return t("updates.unsupported");
        switch (state.kind) {
            case "idle":
                return null;
            case "checking":
                return t("updates.checking");
            case "current":
                return t("updates.current");
            case "available":
                return t("phone.updateOffered", { version: state.version });
            case "store":
                return t("updates.unsupported");
            case "failed":
                return t("updates.failed");
        }
    })();
    const busy = state.kind === "checking";
    const waiting = !online && snapshot.updates === "check";

    return (
        <Shell label={t("updates.version", { version: snapshot.version })} hint={waiting ? t("updates.offline") : message}>
            {snapshot.updates === "check" && (
                <Button
                    size="sm"
                    variant="secondary"
                    aria-disabled={busy || waiting}
                    title={waiting ? t("updates.offline") : undefined}
                    onClick={() => {
                        if (busy || waiting) return;
                        setState({ kind: "checking" });
                        void settings.checkForUpdates().then((answer) => {
                            if (live.current) setState(answer);
                        });
                    }}
                >
                    {t("updates.check")}
                </Button>
            )}
        </Shell>
    );
}
