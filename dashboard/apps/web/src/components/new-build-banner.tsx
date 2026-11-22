"use client";

/**
 * Taking a Polaris update without bothering anybody, and the offer when it
 * cannot be taken quietly.
 *
 * A tab open across an update is holding a bundle the server no longer knows, and
 * the way that surfaces on its own is a click that fails for no visible reason.
 * So the tab asks, on a slow timer, when it goes out of sight and when it comes
 * back, and takes the new build by itself whenever reloading costs nothing (see
 * `lib/reload-safety`):
 *
 * - Out of sight: a hidden tab, a minimized window, the desktop app in the tray
 *   (`lib/idle`, which hears the desktop window itself). Nobody is looking, so
 *   the reload is invisible and the page is fresh when they come back.
 * - Coming back: if the new build is already known, the page reloads in the
 *   moment it is restored, before anything has been pressed - the reader sees
 *   the page they left, on the new build.
 *
 * Never in front of somebody using the page: a page in sight is not reloaded,
 * however long it sits untouched, because a form left half filled while the
 * reader looks something up is exactly what an idle timer would throw away.
 *
 * "Costs nothing" is decided by the page itself (`lib/work-in-progress`): any
 * field changed and not saved, an open dialog, a save on its way all block it.
 * Reloading writes down the scroll and every unsaved field and puts them back
 * on the new page; the chat box keeps its own draft. A link pressed on the
 * old bundle needs nothing from here: the router sees the server's build differ
 * from its own and loads the page in full.
 *
 * The card appears only when an update is needed and could not be taken: a
 * call, a recording, a transfer, media playing or unsaved work - or when a
 * click already failed for want of it. Then it offers rather than acts, and the tab keeps working on the old
 * build for as long as the reader wants it to. Dismissing hides it for this tab,
 * and the next failed action brings it straight back, because by then it is the
 * explanation for what just happened.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowUpCircle, RotateCcw } from "lucide-react";
import { isIdle, onIdleChange } from "@/lib/idle";
import { useHeldCall } from "@/app/(app)/chat/call-hold";
import { rememberCall } from "@/app/(app)/chat/call-resume";
import {
    checkForNewBuild,
    newBuildReady,
    rememberServedBuild,
    staleFailureSeen,
    subscribeToBuild,
    watchForStaleFailures
} from "@/lib/new-build";
import { reloadNow, restoreAfterReload, safeToReload } from "@/lib/reload-safety";

/** Slow on purpose. Nothing here is urgent - the failure it prevents needs the
 *  reader to click something first - and every open tab pays for it. */
const POLL_MS = 2 * 60 * 1000;

/** Where the tab remembers taking an update by itself. During a rollover two
 *  builds answer side by side, and a reload can land on the old one and see the
 *  new one again; this keeps that from becoming a loop. */
const AUTO_KEY = "polaris.autoBuildReloadAt";
const AUTO_COOLDOWN_MS = 10 * 60 * 1000;

/** The presses that mean somebody is using the page again. */
const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

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
    // An update was needed and could not be taken quietly: the only time the
    // card is shown.
    const [blocked, setBlocked] = useState(false);
    const ready = useSyncExternalStore(subscribeToBuild, newBuildReady, () => false);
    const refused = useSyncExternalStore(subscribeToBuild, staleFailureSeen, () => false);
    // Null on an instance without Chat, where there is no call to lose.
    const held = useHeldCall();
    const inCall = Boolean(held?.session);

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
        reloadNow();
    };

    /** Take the new build by itself if that costs nothing, or say it is waiting.
     *  A call is never interrupted for it: walking back in is for when the
     *  reader chose the reload. */
    const attempt = useCallback(() => {
        if (!newBuildReady()) return;
        if (!inCall && safeToReload() && claimAutoReload()) reloadNow();
        else setBlocked(true);
    }, [inCall]);
    // Read from listeners that outlive a render.
    const attemptRef = useRef(attempt);
    useEffect(() => {
        attemptRef.current = attempt;
    }, [attempt]);

    // Whatever the reload before this one wrote down.
    useEffect(() => restoreAfterReload(), []);

    useEffect(() => {
        rememberServedBuild(served);
        if (served === null) return;
        const take = (moved: boolean) => {
            if (moved && isIdle()) attemptRef.current();
        };
        void checkForNewBuild().then(take);
        const timer = setInterval(() => void checkForNewBuild().then(take), POLL_MS);

        // Out of sight and back again. A tab that was away for an hour is the one
        // most likely to be stale, and it is about to be clicked.
        let touched = false;
        const onTouch = () => {
            touched = true;
        };
        const stopIdle = onIdleChange((idle) => {
            touched = false;
            // Already known: decided now, while the page is still out of sight
            // or not yet pressed. Otherwise asked, and decided on the answer.
            const decide = () => {
                if (!touched) attemptRef.current();
            };
            if (newBuildReady()) decide();
            else
                void checkForNewBuild().then((moved) => {
                    if (moved && (idle ? isIdle() : !isIdle())) decide();
                });
        });
        for (const name of ACTIVITY) window.addEventListener(name, onTouch, { capture: true, passive: true });
        const onFocus = () => void checkForNewBuild();
        window.addEventListener("focus", onFocus);
        // And whatever fails without anybody catching it, which is the case the
        // poll is too slow for: the click has already been pressed.
        const unwatch = watchForStaleFailures();
        return () => {
            clearInterval(timer);
            stopIdle();
            unwatch();
            for (const name of ACTIVITY) window.removeEventListener(name, onTouch, { capture: true });
            window.removeEventListener("focus", onFocus);
        };
    }, [served]);

    // Out of sight already when the new build was seen. And something failed for
    // want of it: the reader is in front of the page, so it is offered, never
    // done under them. Dismissed before, the card comes back, because it is the
    // reason for the failure.
    useEffect(() => {
        if (!ready) return;
        if (isIdle()) attempt();
        if (refused) {
            setBlocked(true);
            setDismissed(false);
        }
    }, [ready, refused, attempt]);

    if (!ready || !blocked || dismissed) return null;

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
