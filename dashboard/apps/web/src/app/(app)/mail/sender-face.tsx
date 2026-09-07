"use client";

/**
 * The face beside a conversation.
 *
 * A column of names is harder to scan than a column of faces, and almost every
 * message in a mailbox comes from an organisation with a mark. Where Polaris can
 * get one it draws it; where it cannot it draws initials on a colour derived
 * from the address, which is stable, so the same sender is the same colour on
 * every screen and two senders in a list are tellable apart before their names
 * are read.
 *
 * The picture is fetched by Polaris rather than by the browser, so the sender's
 * site learns that a server asked and nothing about the reader. The `<img>`
 * failing is not an error state - it is the ordinary answer for a sender with no
 * mark, and it is what puts the initials back.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { initials, tintFor } from "@/components/avatar";

export function SenderFace({
    name,
    address,
    className
}: {
    name: string;
    address: string;
    className?: string;
}) {
    const [drawn, setDrawn] = useState(true);
    const label = name.trim() || address.split("@")[0] || address;

    return (
        <span
            aria-hidden
            className={cn(
                "flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-medium text-white",
                className
            )}
            style={drawn ? undefined : { backgroundColor: tintFor(address || label) }}
        >
            {drawn && address ? (
                <img
                    src={`/api/mail/face/${encodeURIComponent(address)}`}
                    alt=""
                    className="size-full object-contain"
                    loading="lazy"
                    decoding="async"
                    onError={() => setDrawn(false)}
                />
            ) : (
                initials(label)
            )}
        </span>
    );
}
