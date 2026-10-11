"use client";

/**
 * "Polaris has been updated" - the offer to pick it up.
 *
 * A tab open across an update is holding a bundle the server no longer knows, and
 * the way that surfaces on its own is a click that fails for no visible reason.
 * So the tab asks, on a slow timer and whenever it comes back to the foreground,
 * and says so the moment the answer changes.
 *
 * When reloading would cost nothing (see `lib/reload-safety`), the tab takes the
 * update by itself, at a moment nobody is looking: as soon as it goes to the
 * background, or after a couple of minutes with no hand on it. (A link pressed
 * on the old bundle needs nothing from here: the router sees the server's build
 * differ from its own and loads the page in full.) Never during a call, a
 * recording, a transfer, media playing or anything half-typed - then it offers
 * rather than acts, because a reload costs whatever is half-written on the
 * screen, and the tab keeps working on the old build for as long as the reader
 * wants it to. The offer waits in the corner stack the shell lays out - above a ringing call rather than over it, which is what two
 * cards that each pinned themselves to the same corner used to do. The one
 * thing it does not do is go away by itself: dismissing hides it for this tab,
 * and the next failed action brings it straight back, because by then it is the
 * explanation for what just happened.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowUpCircle, RotateCcw } from "lucide-react";
import { useHeldCall } from "@/app/(app)/chat/call-hold";
import { rememberCall } from "@/app/(app)/chat/call-resume";
import {
    checkForNewBuild,
    newBuildReady,
    rememberServedBuild,
    subscribeToBuild,
    watchForStaleFailures
} from "@/lib/new-build";
import { reloadNow, safeToReload } from "@/lib/reload-safety";

/** Slow on purpose. Nothing here is urgent - the failure it prevents needs the
 *  reader to click something first - and every open tab pays for it. */
const POLL_MS = 2 * 60 * 1000;

/** How long a visible tab has to sit untouched before it updates by itself. */
const IDLE_MS = 2 * 60 * 1000;

/** Where the tab remembers taking an update by itself. During a rollover two
 *  builds answer side by side, and a reload can land on the old one and see the
 *  new one again; this keeps that from becoming a loop. */
const AUTO_KEY = "polaris.autoBuildReloadAt";
const AUTO_COOLDOWN_MS = 10 * 60 * 1000;

/** Claim the one automatic reload this tab gets per cooldown. False when it was
 *  already spent, or when storage is refused and the claim cannot be kept. */
function claimAutoReload(): boolean {
    try {
        const last = Number(window.sessionStorage.getItem(AUTO_KEY) ?? "0");
        if (Number.isFinite(last) && Date.now() - last < AUTO_COOLDOWN_MS) return false;
        window.sessionStorage.setItem(AUTO_KEY, String(Date.now()));
        return true;
    } catch {
        return false;
    }
}

export function NewBuildBanner({ served }: { served: string | null }) {
    const t = useTranslations("components");
    const [dismissed, setDismissed] = useState(false);
    const ready = useSyncExternalStore(subscribeToBuild, newBuildReady, () => false);
    // Null on an instance without Chat, where there is no call to lose.
    const held = useHeldCall();

    /**
     * Take the update, and come back to the call.
     *
     * Reloading replaces the tab, which drops the room's participant - so
     * without this the one thing this button costs somebody on a call is the
     * call, and the offer becomes one they learn to dismiss. The call is written
     * down here and walked back into on the way in.
     */
    const reload = () => {
        if (held?.session) rememberCall(held.session, held.withVideo, held.viewerId);
        window.location.reload();
    };

    useEffect(() => {
        rememberServedBuild(served);
        if (served === null) return;
        void checkForNewBuild();
        const timer = setInterval(() => void checkForNewBuild(), POLL_MS);
        // A tab that was in the background for an hour is the one most likely to be
        // stale, and it is about to be clicked.
        const onWake = () => {
            if (document.visibilityState === "visible") void checkForNewBuild();
        };
        document.addEventListener("visibilitychange", onWake);
        window.addEventListener("focus", onWake);
        // And whatever fails without anybody catching it, which is the case the
        // poll is too slow for: the click has already been pressed.
        const unwatch = watchForStaleFailures();
        return () => {
            clearInterval(timer);
            unwatch();
            document.removeEventListener("visibilitychange", onWake);
            window.removeEventListener("focus", onWake);
        };
    }, [served]);

    // Dismissed, then something failed and asked again: that answer is why it
    // failed, so it comes back.
    useEffect(() => {
        if (ready) setDismissed(false);
    }, [ready]);

    // Taking the update by itself. A call is never interrupted for it: the
    // reader is in it, and walking back in is for when they chose the reload.
    const inCall = Boolean(held?.session);
    useEffect(() => {
        if (!ready || inCall) return;
        const quietly = () => {
            if (safeToReload() && claimAutoReload()) reloadNow();
        };
        // In the background: nobody is looking, so the tab is fresh when they come back.
        const onHide = () => {
            if (document.visibilityState === "hidden") quietly();
        };
        if (document.visibilityState === "hidden") quietly();
        document.addEventListener("visibilitychange", onHide);

        // Untouched for a while in the foreground - unless they said Later.
        let idle: ReturnType<typeof setTimeout> | null = null;
        const rearm = () => {
            if (idle) clearTimeout(idle);
            idle = dismissed ? null : setTimeout(quietly, IDLE_MS);
        };
        const activity = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
        for (const name of activity) window.addEventListener(name, rearm, { passive: true });
        rearm();

        return () => {
            if (idle) clearTimeout(idle);
            document.removeEventListener("visibilitychange", onHide);
            for (const name of activity) window.removeEventListener(name, rearm);
        };
    }, [ready, inCall, dismissed]);

    if (!ready || dismissed) return null;

    return (
        <div
            role="status"
            className="pointer-events-auto flex w-72 flex-col gap-3 rounded-lg border border-border-strong bg-elevated p-3 shadow-modal"
        >
            <span className="flex items-center gap-2.5">
                <ArrowUpCircle className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 text-sm font-medium">{t("build.title")}</span>
            </span>
            <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
                {t("build.body", { call: held?.session ? "yes" : "no" })}
            </p>
            <span className="flex items-center gap-2">
                <Button size="sm" className="flex-1" onClick={reload}>
                    <RotateCcw className="size-4" />
                    {t("build.reload")}
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    title={t("build.hide")}
                    onClick={() => setDismissed(true)}
                >
                    {t("build.later")}
                </Button>
            </span>
        </div>
    );
}
