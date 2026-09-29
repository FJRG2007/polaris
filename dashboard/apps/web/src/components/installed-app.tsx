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
 * the card says where.
 *
 * The same card mentions the native desktop app (`desktop/` in the repository).
 * Whether there is one to download is a question for GitHub, so the offer is
 * handed in as `nativeApp` - the page streams it in behind a boundary of its own,
 * and nothing here waits on it. Inside that app the card says so instead of
 * offering to install anything.
 */

import { Download } from "lucide-react";
import { listenToWorker } from "@/lib/desktop-notify";
import { useDesktopBridge } from "@/components/desktop-app";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
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

export function InstallAppCard({ nativeApp }: { nativeApp: ReactNode }) {
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

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("installApp.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {desktop ? (
                    <p className="text-sm">
                        {desktop.version
                            ? t("installApp.usingDesktopVersion", { version: desktop.version })
                            : t("installApp.usingDesktop")}
                    </p>
                ) : (
                    <>
                        <p className="text-sm text-muted-foreground">{t("installApp.intro")}</p>
                        {installed ? (
                            <p className="text-sm">{t("installApp.installed")}</p>
                        ) : prompt ? (
                            <div>
                                <Button onClick={() => void install()}>
                                    <Download className="size-4" /> {t("installApp.install")}
                                </Button>
                            </div>
                        ) : (
                            <p className="text-sm text-muted-foreground">{t("installApp.fromMenu")}</p>
                        )}
                        <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                            <p className="text-sm text-muted-foreground">{t("installApp.native")}</p>
                            {nativeApp}
                        </div>
                    </>
                )}
            </CardBody>
        </Card>
    );
}
