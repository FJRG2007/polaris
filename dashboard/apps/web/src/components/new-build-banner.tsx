"use client";

/**
 * "Polaris has been updated" - the offer to pick it up.
 *
 * A tab open across an update is holding a bundle the server no longer knows, and
 * the way that surfaces on its own is a click that fails for no visible reason.
 * So the tab asks, on a slow timer and whenever it comes back to the foreground,
 * and says so the moment the answer changes.
 *
 * It offers rather than acts. A reload costs whatever is half-written on the
 * screen - a message, a task, a form - so the tab keeps working on the old build
 * for as long as the reader wants it to, and this waits in the corner stack the
 * shell lays out - above a ringing call rather than over it, which is what two
 * cards that each pinned themselves to the same corner used to do. The one
 * thing it does not do is go away by itself: dismissing hides it for this tab,
 * and the next failed action brings it straight back, because by then it is the
 * explanation for what just happened.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@polaris/ui";
import { ArrowUpCircle, RotateCcw } from "lucide-react";
import { useHeldCall } from "@/app/(app)/chat/call-hold";
import { rememberCall } from "@/app/(app)/chat/call-resume";
import { checkForNewBuild, newBuildReady, rememberServedBuild, subscribeToBuild } from "@/lib/new-build";

/** Slow on purpose. Nothing here is urgent - the failure it prevents needs the
 *  reader to click something first - and every open tab pays for it. */
const POLL_MS = 2 * 60 * 1000;

export function NewBuildBanner({ served }: { served: string | null }) {
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
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onWake);
            window.removeEventListener("focus", onWake);
        };
    }, [served]);

    // Dismissed, then something failed and asked again: that answer is why it
    // failed, so it comes back.
    useEffect(() => {
        if (ready) setDismissed(false);
    }, [ready]);

    if (!ready || dismissed) return null;

    return (
        <div
            role="status"
            className="pointer-events-auto flex w-72 flex-col gap-3 rounded-lg border border-border-strong bg-elevated p-3 shadow-modal"
        >
            <span className="flex items-center gap-2.5">
                <ArrowUpCircle className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 text-sm font-medium">Polaris has been updated</span>
            </span>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
                This tab is still running the previous version. Reload when you are ready -
                anything half-written on this page is lost
                {held?.session ? ", though you will come straight back into your call" : ""}.
            </p>
            <span className="flex items-center gap-2">
                <Button size="sm" className="flex-1" onClick={reload}>
                    <RotateCcw className="size-4" />
                    Reload
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    title="Hide until something needs it"
                    onClick={() => setDismissed(true)}
                >
                    Later
                </Button>
            </span>
        </div>
    );
}
