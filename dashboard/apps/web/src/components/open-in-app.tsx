"use client";

/**
 * Hands a Polaris link followed in a browser to the Polaris app on this device,
 * once per tab (see `lib/open-in-app` for when). Draws nothing until it has
 * handed one over, and then only a note saying so, which is where the setting
 * that turns this off is reached from.
 */

import { useEffect } from "react";
import { useToast } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { appLink, appTarget, arrivedFromOutside, holdForSignIn, TRIED_KEY } from "@/lib/open-in-app";

/** How this document was loaded, and on which path - not where the router has
 *  moved it since. */
function documentLoad(): { type: string; landing?: string } {
    try {
        const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        if (!entry) return { type: "navigate" };
        const url = new URL(entry.name);
        return { type: entry.type, landing: `${url.pathname}${url.search}` };
    } catch {
        return { type: "navigate" };
    }
}

function triedHere(): boolean {
    try {
        if (window.sessionStorage.getItem(TRIED_KEY)) return true;
        window.sessionStorage.setItem(TRIED_KEY, "1");
        return false;
    } catch {
        // No storage, no record: never try at all rather than on every load.
        return true;
    }
}

export function OpenInApp() {
    const t = useTranslations("components");
    const toast = useToast();
    const router = useRouter();

    useEffect(() => {
        const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const load = documentLoad();
        const outside = arrivedFromOutside({
            referrer: document.referrer,
            origin: window.location.origin,
            path,
            landing: load.landing,
            navigation: load.type,
            tried: false
        });
        if (!outside || triedHere()) return;
        const controller = new AbortController();
        void fetch("/api/account/app-links", { cache: "no-store", signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((answer: { open?: boolean; phone?: boolean; iphone?: boolean; desktop?: boolean } | null) => {
                if (!answer?.open) return;
                const target = appTarget(navigator.userAgent, {
                    phone: answer.phone === true,
                    iphone: answer.iphone === true,
                    desktop: answer.desktop === true
                });
                if (!target) return;
                window.location.href = appLink(target, window.location.origin, path);
                toast.show({
                    key: "open-in-app",
                    title: t("openInApp.opened"),
                    body: t("openInApp.how"),
                    onPress: () => router.push("/account/preferences#open-in-app")
                });
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, [router, t, toast]);

    return null;
}

/** On the sign-in screens: whatever the sign-in lands on stays in this browser. */
export function HoldOpenInApp() {
    useEffect(() => holdForSignIn(), []);
    return null;
}
