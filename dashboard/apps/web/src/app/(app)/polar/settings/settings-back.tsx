"use client";

/**
 * Back to the chat the settings were opened from: the address it was on (a
 * page the side panel was open on, where it still is), or Polar's own page for
 * somebody who came straight to this address. It goes to that address rather
 * than back in history, where the settings page visited before this one is.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { SETTINGS_FROM_CHAT_KEY, chatReturnPath } from "@/lib/polar/settings-path";

export function SettingsBack({ label }: { label: string }) {
    const [href, setHref] = useState("/polar");
    useEffect(() => {
        try {
            setHref(chatReturnPath(window.sessionStorage.getItem(SETTINGS_FROM_CHAT_KEY)));
        } catch {
            // Unknown; Back goes to Polar's own page.
        }
    }, []);
    return (
        <Link
            href={href}
            onClick={() => {
                try {
                    window.sessionStorage.removeItem(SETTINGS_FROM_CHAT_KEY);
                } catch {
                    // Nothing to forget.
                }
            }}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
            <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
            {label}
        </Link>
    );
}
