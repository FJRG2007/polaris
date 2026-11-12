"use client";

import { useState } from "react";
import { Webhook } from "lucide-react";

/**
 * A webhook's face: its picture when it has one, drawn over the webhook mark,
 * so a picture that is missing or fails to load leaves the mark showing.
 */
export function WebhookFace({ src, size = 28 }: { src?: string | null; size?: number }) {
    const [failed, setFailed] = useState<string | null>(null);
    const shown = src && failed !== src ? src : null;
    return (
        <span
            className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 text-primary"
            style={{ width: size, height: size }}
            aria-hidden="true"
        >
            <Webhook className="size-4 shrink-0" />
            {shown && (
                // eslint-disable-next-line @next/next/no-img-element -- served by Polaris, sized here
                <img
                    src={shown}
                    alt=""
                    width={size}
                    height={size}
                    loading="lazy"
                    className="absolute inset-0 size-full object-cover"
                    onError={() => setFailed(shown)}
                />
            )}
        </span>
    );
}
