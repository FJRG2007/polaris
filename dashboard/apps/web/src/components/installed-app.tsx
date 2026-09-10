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
 */

import { Download } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

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
        void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }, []);
    return null;
}

/** Whether this window is the installed app rather than a browser tab. */
function runningInstalled(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;
}

export function InstallAppCard() {
    const prompt = useSyncExternalStore(
        subscribe,
        () => held,
        () => null
    );
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
                <CardTitle>Desktop app</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Install Polaris to open it in its own window, with its own icon in the dock,
                    taskbar or home screen. It updates with Polaris itself.
                </p>
                {installed ? (
                    <p className="text-sm">You are using the installed app.</p>
                ) : prompt ? (
                    <div>
                        <Button onClick={() => void install()}>
                            <Download className="size-4" /> Install Polaris
                        </Button>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Your browser installs it from its own menu: Install Polaris in Chrome and
                        Edge, Add to Dock in Safari, Add to Home Screen on a phone. It needs Polaris
                        to be open over https.
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
