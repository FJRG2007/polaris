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
import { appLink, appTarget, arrivedFromOutside } from "@/lib/open-in-app";

/** This tab's own record of having tried, so a reload or the app's fallback never tries twice. */
const TRIED = "polaris.openInApp.tried";

function navigationType(): string {
    try {
        const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        return entry?.type ?? "navigate";
    } catch {
        return "navigate";
    }
}

function triedHere(): boolean {
    try {
        if (window.sessionStorage.getItem(TRIED)) return true;
        window.sessionStorage.setItem(TRIED, "1");
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
        const outside = arrivedFromOutside({
            referrer: document.referrer,
            origin: window.location.origin,
            path,
            navigation: navigationType(),
            tried: false
        });
        if (!outside || triedHere()) return;
        const controller = new AbortController();
        void fetch("/api/account/app-links", { cache: "no-store", signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((answer: { open?: boolean; phone?: boolean; desktop?: boolean } | null) => {
                if (!answer?.open) return;
                const target = appTarget(navigator.userAgent, {
                    phone: answer.phone === true,
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
