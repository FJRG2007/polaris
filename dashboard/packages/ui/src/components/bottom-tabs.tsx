"use client";

/**
 * The tab bar along the bottom of a phone screen, the way WhatsApp, Telegram
 * and every phone app since switch between the few places an app has.
 *
 * Phones only (`md:hidden`): on anything wider the same places are a rail or a
 * column, which has the room. At the bottom because that is where a thumb
 * already is; each tab is the full height of a finger, an icon over a short
 * name, the open one marked by the circle behind its icon. It clears the home
 * indicator on phones that draw one (`--safe-bottom`).
 *
 * An app passes its own tabs, so a third-party app gets the same bar as
 * Polaris's own.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";

export interface BottomTab {
    readonly id: string;
    readonly label: string;
    readonly icon: ReactNode;
    readonly active: boolean;
    /** Something waiting there, counted. Zero or absent draws nothing. */
    readonly badge?: number;
    readonly onSelect: () => void;
}

export function BottomTabs({
    tabs,
    label,
    className
}: {
    tabs: readonly BottomTab[];
    /** What the bar is, for a screen reader: "Chat sections". */
    label: string;
    className?: string;
}) {
    return (
        <nav
            aria-label={label}
            className={cn(
                "flex shrink-0 border-t border-border bg-surface pb-[var(--safe-bottom)] md:hidden",
                className
            )}
        >
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    onClick={tab.onSelect}
                    aria-current={tab.active ? "page" : undefined}
                    className={cn(
                        // The focus ring is drawn on the circle, not around the whole tab:
                        // a WebView keeps a tapped tab focused, which outlined it as a
                        // rectangle after every tap.
                        "group flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-[0.6875rem] font-medium outline-none transition-colors duration-fast [-webkit-tap-highlight-color:transparent] focus-visible:outline-none",
                        tab.active ? "text-foreground" : "text-muted-foreground"
                    )}
                >
                    <span
                        className={cn(
                            "relative flex size-9 items-center justify-center rounded-full transition-colors duration-fast group-active:bg-muted/70 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-ring [&_svg]:size-5 [&_svg]:shrink-0",
                            tab.active && "bg-muted"
                        )}
                    >
                        {tab.icon}
                        {tab.badge ? (
                            <span className="pointer-events-none absolute -top-0.5 -end-1 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 text-primary-foreground">
                                {tab.badge > 99 ? "99+" : tab.badge}
                            </span>
                        ) : null}
                    </span>
                    <span className="max-w-full truncate" title={tab.label}>{tab.label}</span>
                </button>
            ))}
        </nav>
    );
}
