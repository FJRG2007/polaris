"use client";

/**
 * This server's address on the network changed.
 *
 * Shown on every screen to whoever manages the system for a week after a move,
 * because bookmarks, phones and other devices still point at the old address and
 * the person who has to fix that is the one reading this. Carries both addresses
 * that keep working, ready to copy. Dismissed per move, in this browser.
 */

import { Network, X } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { LanMove } from "@/lib/lan-address-follow";
import { useCallback, useEffect, useState } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { lanAddressMoveAction } from "@/app/(app)/lan-address-actions";

/** A move is rare; once every few minutes is plenty to notice one. */
const REFRESH_MS = 5 * 60_000;
const DISMISSED = "polaris.lanMove.dismissed";

/** The links that reach this Polaris after a move. */
export function lanMoveLinks(move: Pick<LanMove, "to">): string[] {
    return [`https://${move.to}`, "https://polaris.local"];
}

function readDismissed(): string | null {
    try {
        return localStorage.getItem(DISMISSED);
    } catch {
        return null;
    }
}

export function LanAddressBanner() {
    const t = useTranslations("components");
    const [dismissed, setDismissed] = useState<string | null>(null);
    useEffect(() => setDismissed(readDismissed()), []);

    const load = useCallback(() => lanAddressMoveAction(), []);
    const { data: move } = useLiveRead<LanMove | null>({
        load,
        cacheKey: "lan-address-move",
        intervalMs: REFRESH_MS
    });
    if (!move || dismissed === move.at) return null;

    const dismiss = () => {
        setDismissed(move.at);
        try {
            localStorage.setItem(DISMISSED, move.at);
        } catch {
            // Private mode: hidden for as long as the page lives.
        }
    };

    return (
        <div
            role="status"
            className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border border-warning-edge bg-warning-soft px-2.5 py-1.5 text-sm text-warning-ink sm:gap-y-2 sm:px-3 sm:py-2"
        >
            <Network className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 grow basis-56">
                <p className="font-medium break-words">{t("lanMove.title", { to: move.to })}</p>
                <p className="mt-0.5 text-xs break-words opacity-90">
                    {t("lanMove.body", { from: move.from })}
                </p>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {lanMoveLinks(move).map((link) => (
                        <li key={link} className="flex min-w-0 items-center gap-1">
                            <a
                                href={link}
                                className="min-w-0 truncate font-mono text-xs underline underline-offset-2"
                                title={link}
                            >
                                {link}
                            </a>
                            <CopyButton value={link} label={t("lanMove.copy")} />
                        </li>
                    ))}
                </ul>
            </div>
            <button
                type="button"
                aria-label={t("lanMove.dismiss")}
                title={t("lanMove.dismiss")}
                className="shrink-0 rounded p-1 opacity-70 hover:opacity-100"
                onClick={dismiss}
            >
                <X className="size-4 shrink-0" aria-hidden />
            </button>
        </div>
    );
}
