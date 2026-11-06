"use client";

/**
 * Polaris as an app of its own: the service worker that keeps an installed
 * window from opening onto a browser error page, and the offer to install.
 *
 * The browser decides whether Polaris can be installed - it has to be served over
 * https, and it has to not be installed already - and says so with
 * `beforeinstallprompt`. That event is held here so the offer can be shown where
 * somebody looks for it, instead of in a bar the browser draws when it likes.
 * Browsers without the event (Safari, Firefox) install from their own menu, and
 * the row says where.
 *
 * On the downloads page the offer is a row of the desktop card, under the native
 * desktop app's (`desktop/` in the repository) own downloads. Whether there is
 * one to download is a question for GitHub, so that list streams in behind a
 * boundary of its own and nothing here waits on it. Inside that app the offer says so instead of offering to install anything.
 */

import { Download } from "lucide-react";
import { listenToWorker } from "@/lib/desktop-notify";
import { useDesktopBridge } from "@/components/desktop-app";
import { readDesktopUpdateCheck, type DesktopUpdateCheck } from "@/lib/desktop-bridge";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button } from "@polaris/ui";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

/** The event Chromium browsers fire when Polaris can be installed. Not in the DOM
 *  typings, so only what is used here is described. */
interface InstallPrompt extends Event {
    prompt(): Promise<void>;
    readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let held: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const announce = (): void => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
    window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        held = event as InstallPrompt;
        announce();
    });
    window.addEventListener("appinstalled", () => {
        held = null;
        announce();
    });
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Registers the service worker once per page load. Mounted in the app chrome. */
export function ServiceWorkerRegistration() {
    useEffect(() => {
        if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
        listenToWorker();
        void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }, []);
    return null;
}

/** Whether this window is the installed app rather than a browser tab. */
function runningInstalled(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * What the page says inside the desktop app instead of offering to install it,
 * with "Check for updates" for an app new enough to answer it.
 */
function UsingDesktop({ version }: { version: string }) {
    const t = useTranslations("components");
    const desktop = useDesktopBridge();
    const [checking, setChecking] = useState(false);
    const [found, setFound] = useState<DesktopUpdateCheck | null>(null);
    const [restarting, setRestarting] = useState(false);
    const [restartFailed, setRestartFailed] = useState(false);
    const check = desktop?.checkForUpdates;

    const run = async (): Promise<void> => {
        if (!check) return;
        setChecking(true);
        setRestartFailed(false);
        try {
            setFound(readDesktopUpdateCheck(await check()));
        } catch {
            setFound({ kind: "failed" });
        } finally {
            setChecking(false);
        }
    };

    const restart = async (): Promise<void> => {
        if (!desktop?.installUpdate) return;
        setRestarting(true);
        setRestartFailed(false);
        try {
            const outcome = await desktop.installUpdate();
            if (!outcome.ok) setRestartFailed(true);
        } catch {
            setRestartFailed(true);
        } finally {
            setRestarting(false);
        }
    };

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm">
                {version
                    ? t("installApp.usingDesktopVersion", { version })
                    : t("installApp.usingDesktop")}
            </p>
            {check ? (
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={checking}
                        onClick={() => void run()}
                    >
                        {checking ? t("installApp.checking") : t("installApp.checkUpdates")}
                    </Button>
                    {found?.kind === "ready" && desktop?.installUpdate ? (
                        <Button size="sm" disabled={restarting} onClick={() => void restart()}>
                            {t("installApp.restart")}
                        </Button>
                    ) : null}
                    {restartFailed ? (
                        <p className="min-w-0 text-sm text-destructive" role="alert">
                            {t("installApp.check.restartFailed")}
                        </p>
                    ) : found ? (
                        <p className="min-w-0 text-sm text-muted-foreground" role="status">
                            {found.kind === "current"
                                ? t("installApp.check.current", { version: found.version })
                                : found.kind === "downloading"
                                  ? t("installApp.check.downloading", { version: found.version })
                                  : found.kind === "ready"
                                    ? t("installApp.check.ready", { version: found.version })
                                    : found.kind === "available"
                                      ? t("installApp.check.available", { version: found.version })
                                      : found.kind === "unsupported"
                                        ? t("installApp.check.unsupported")
                                        : t("installApp.check.failed")}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/** The native app's downloads, or inside that app, that it is the one in use. */
export function NativeAppOffer({ children }: { children: ReactNode }) {
    const desktop = useDesktopBridge();
    return desktop ? <UsingDesktop version={desktop.version} /> : <>{children}</>;
}

/**
 * The offer to install Polaris as an app, or what is true instead: that this is
 * the desktop app, that it is installed already, or where the browser keeps its
 * own install entry. Nothing in it waits on the network, so it draws with the
 * page; the native builds are listed above it, in the same card.
 */
export function InstallAppOffer() {
    const t = useTranslations("components");
    const prompt = useSyncExternalStore(
        subscribe,
        () => held,
        () => null
    );
    const desktop = useDesktopBridge();
    const [installed, setInstalled] = useState(false);
    useEffect(() => setInstalled(runningInstalled()), [prompt]);

    const install = async (): Promise<void> => {
        if (!prompt) return;
        await prompt.prompt();
        const choice = await prompt.userChoice.catch(() => null);
        if (choice?.outcome === "accepted") {
            held = null;
            announce();
        }
    };

    // The desktop card above already says which version this is and offers its
    // update; saying it again here drew the same block twice on one page.
    if (desktop)
        return <p className="text-sm text-muted-foreground">{t("installApp.desktopHasWindow")}</p>;
    if (installed) return <p className="text-sm">{t("installApp.installed")}</p>;
    if (prompt)
        return (
            <div>
                <Button onClick={() => void install()}>
                    <Download className="size-4" /> {t("installApp.install")}
                </Button>
            </div>
        );
    return <p className="text-sm text-muted-foreground">{t("installApp.fromMenu")}</p>;
}
