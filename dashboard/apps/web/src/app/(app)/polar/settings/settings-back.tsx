"use client";

/**
 * Back to the chat the settings were opened from: the page the side panel was
 * open on (it is still open there), or Polar's own page for somebody who came
 * straight to this address.
 */

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

export function SettingsBack({ label }: { label: string }) {
    const router = useRouter();
    return (
        <a
            href="/polar"
            onClick={(event) => {
                // Only a visit that came from inside the app goes back; any
                // other goes to the chat page rather than to another site.
                const inside =
                    window.history.length > 1 &&
                    document.referrer.startsWith(window.location.origin);
                if (!inside) return;
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
