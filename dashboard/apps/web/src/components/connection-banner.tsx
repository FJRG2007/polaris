"use client";

/**
 * Whether this device can reach Polaris, said wherever the reader is.
 *
 * A page that stops loading, a message that never sends, a call that freezes:
 * without this they all look the same, and the reader cannot tell their own
 * connection from Polaris being down. So the two are said apart. Mounted once, in
 * the root layout, so every screen has it: the app, the public pages and a
 * guest's call alike.
 *
 * - No connection: the browser's own state (`navigator.onLine` and its events),
 *   through `useNetworkState`. Instant, because it is an event, not a poll.
 * - Can't reach Polaris: the device is online but Polaris does not answer - a
 *   server that is down or restarting, or a network holding requests for its own
 *   sign-in page. From `lib/reachability`, which asks only after something the
 *   app was already doing failed, and never while everything works.
 * - Updating: the same silence while this device has an update rolling over,
 *   which is expected and says so instead of sounding like a failure.
 *
 * "Back" is said only after a real drop, and goes away by itself. When Polaris
 * comes back on a new build, the new-build card is what speaks - it has the
 * reload to offer - so this says nothing rather than saying it twice.
 */

import { Button, cn } from "@polaris/ui";
import { Wifi, WifiOff, CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useNetworkState } from "@enigmax/primitives/react/network";
import { checkForNewBuild } from "@/lib/new-build";
import { updateInProgress } from "@/lib/update-in-progress";
import {
    noteRequestFailure,
    probeNow,
    reachability,
    subscribeReachability,
    type Reachability
} from "@/lib/reachability";

/** How long "back" stays up. Long enough to be read, short enough not to sit
 *  over the page once it is no longer news. */
const RECOVERED_MS = 4000;

const SERVER_SNAPSHOT: Reachability = { reachable: true, recoveries: 0 };

type Back = "none" | "online" | "polaris";

export function ConnectionBanner() {
    const t = useTranslations("components");
    const { online, recovered } = useNetworkState();
    const reach = useSyncExternalStore(subscribeReachability, reachability, () => SERVER_SNAPSHOT);
    const [back, setBack] = useState<Back>("none");
    const [retrying, setRetrying] = useState(false);
    const seenRecoveries = useRef(reach.recoveries);

    // A request nothing caught is still a signal: an action awaited with no
    // handler of its own, refused because nothing answered.
    useEffect(() => {
        const onRejection = (event: PromiseRejectionEvent) => noteRequestFailure(event.reason);
        window.addEventListener("unhandledrejection", onRejection);
        return () => window.removeEventListener("unhandledrejection", onRejection);
    }, []);

    useEffect(() => {
        if (!online) {
            setBack("none");
            return;
        }
        if (!recovered) return;
        setBack("online");
    }, [online, recovered]);

    useEffect(() => {
        if (reach.recoveries === seenRecoveries.current) return;
        seenRecoveries.current = reach.recoveries;
        let cancelled = false;
        // Came back on a new build: the new-build card says so, with its reload.
        void checkForNewBuild().then((moved) => {
            if (!cancelled && !moved) setBack("polaris");
        });
        return () => {
            cancelled = true;
        };
    }, [reach.recoveries]);

    useEffect(() => {
        if (back === "none") return;
        const timer = setTimeout(() => setBack("none"), RECOVERED_MS);
        return () => clearTimeout(timer);
    }, [back]);

    const state = !online
        ? "offline"
        : !reach.reachable
          ? updateInProgress()
              ? "updating"
              : "unreachable"
          : back === "none"
            ? null
            : back === "polaris"
              ? "polarisBack"
              : "back";
    if (state === null) return null;

    const good = state === "back" || state === "polarisBack";
    const Icon = state === "offline" ? WifiOff : state === "unreachable" ? CloudOff : state === "updating" ? RefreshCw : Wifi;

    async function retry() {
        setRetrying(true);
        await probeNow();
        setRetrying(false);
    }

    return (
        <div
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center px-4 pt-2"
        >
            <p
                className={cn(
                    "pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-sm shadow-popover",
                    good
                        ? "border-success-edge bg-success-soft text-success-ink"
                        : state === "offline"
                          ? "border-danger-edge bg-danger-soft text-danger-ink"
                          : "border-warning-edge bg-warning-soft text-warning-ink"
                )}
            >
                <Icon className={cn("size-4 shrink-0", state === "updating" && "animate-spin")} aria-hidden />
                <span className="min-w-0">{t(`network.${state}`)}</span>
                {state === "unreachable" ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 px-2"
                        onClick={() => void retry()}
                        disabled={retrying}
                    >
                        {t("network.retry")}
                    </Button>
                ) : null}
            </p>
        </div>
    );
}

/**
 * The same, inside a call, for a connection that is there but thin: a call is
 * the one place a slow line is felt at once, as frozen video and clipped voices.
 * Nothing is said anywhere else - a slow line that only loads pages a little
 * later is not worth a banner.
 */
export function SlowConnectionNotice() {
    const t = useTranslations("components");
    const { online, slow } = useNetworkState();
    if (!online || !slow) return null;
    return (
        <p
            role="status"
            className="flex shrink-0 items-center gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-warning-ink"
        >
            <Wifi className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{t("network.slowCall")}</span>
        </p>
    );
}
