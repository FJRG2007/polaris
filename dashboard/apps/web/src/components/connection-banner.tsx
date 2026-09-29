"use client";

/**
 * Whether this device has a connection, said wherever the reader is.
 *
 * A page that stops loading, a message that never sends, a call that freezes:
 * without this they all look like Polaris failing, and the one cause the reader
 * can do something about - their own connection - is the one nothing names.
 * Mounted once, in the root layout, so every screen has it: the app, the public
 * pages and a guest's call alike.
 *
 * The state is the browser's own (`navigator.onLine` and its connection
 * events), through `useNetworkState`. It is instant because it is an event,
 * not a poll. "Back online" is said only after a real drop - never on a page
 * that simply opened online - and goes away by itself.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useNetworkState } from "@enigmax/primitives/react/network";

/** How long "back online" stays up. Long enough to be read, short enough not to
 *  sit over the page once it is no longer news. */
const RECOVERED_MS = 4000;

export function ConnectionBanner() {
    const t = useTranslations("components");
    const { online, recovered } = useNetworkState();
    const [back, setBack] = useState(false);

    useEffect(() => {
        if (!online) {
            setBack(false);
            return;
        }
        if (!recovered) return;
        setBack(true);
        const timer = setTimeout(() => setBack(false), RECOVERED_MS);
        return () => clearTimeout(timer);
    }, [online, recovered]);

    if (online && !back) return null;
    return (
        <div
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center px-4 pt-2"
        >
            <p
                className={cn(
                    "pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-sm shadow-popover",
                    online
                        ? "border-success-edge bg-success-soft text-success-ink"
                        : "border-danger-edge bg-danger-soft text-danger-ink"
                )}
            >
                {online ? (
                    <Wifi className="size-4 shrink-0" aria-hidden />
                ) : (
                    <WifiOff className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0">{online ? t("network.back") : t("network.offline")}</span>
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
