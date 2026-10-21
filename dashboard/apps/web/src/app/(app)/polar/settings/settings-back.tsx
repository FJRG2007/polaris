"use client";

/**
 * Back to the chat the settings were opened from: the page the side panel was
 * open on (it is still open there), or Polar's own page for somebody who came
 * straight to this address.
 */

import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { SETTINGS_FROM_CHAT_KEY } from "@/lib/polar/settings-path";

export function SettingsBack({ label }: { label: string }) {
    const router = useRouter();
    const fromChat = useRef(false);
    useEffect(() => {
        try {
            if (window.sessionStorage.getItem(SETTINGS_FROM_CHAT_KEY) === null) return;
            fromChat.current = true;
            window.sessionStorage.removeItem(SETTINGS_FROM_CHAT_KEY);
        } catch {
            // Unknown; Back goes to Polar's own page.
        }
    }, []);
    return (
        <a
            href="/polar"
            onClick={(event) => {
                // Only a visit the chat opened goes back; any other goes to
                // the chat page rather than to another site.
                if (!fromChat.current || window.history.length < 2) return;
                event.preventDefault();
                router.back();
            }}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
            <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
            {label}
        </a>
    );
}
