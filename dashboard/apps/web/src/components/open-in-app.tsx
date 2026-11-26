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

/** This document's one decision, shared by every caller (`appHandoff`). */
let handoff: Promise<boolean> | null = null;

async function decideHandoff(): Promise<boolean> {
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
    if (!outside || triedHere()) return false;
    try {
        const response = await fetch("/api/account/app-links", { cache: "no-store" });
        const answer = (response.ok ? await response.json() : null) as {
            open?: boolean;
            phone?: boolean;
            iphone?: boolean;
            desktop?: boolean;
        } | null;
        if (!answer?.open) return false;
        const target = appTarget(navigator.userAgent, {
            phone: answer.phone === true,
            iphone: answer.iphone === true,
            desktop: answer.desktop === true
        });
        if (!target) return false;
        window.location.href = appLink(target, window.location.origin, path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Whether this load handed its page to the app, deciding it - and handing it
 * over - the first time anything asks. Once per document, whoever asks first:
 * the note below, or a screen that is about to raise a prompt of its own. A
 * lock screen waits on it before asking for a passkey, because a page handed to
 * the app is one the person is about to use there - a Windows Hello prompt from
 * the tab left behind is a second ceremony for the same tap.
 */
export function appHandoff(): Promise<boolean> {
    handoff ??= decideHandoff();
    return handoff;
}

export function OpenInApp() {
    const t = useTranslations("components");
    const toast = useToast();
    const router = useRouter();

    useEffect(() => {
        let live = true;
        void appHandoff().then((handed) => {
            if (!handed || !live) return;
            toast.show({
                key: "open-in-app",
                title: t("openInApp.opened"),
                body: t("openInApp.how"),
                onPress: () => router.push("/account/preferences#open-in-app")
            });
        });
        return () => {
            live = false;
        };
    }, [router, t, toast]);

    return null;
}

/** On the sign-in screens: whatever the sign-in lands on stays in this browser. */
export function HoldOpenInApp() {
    useEffect(() => holdForSignIn(), []);
    return null;
}
