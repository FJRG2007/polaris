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
 * It is the same face every account in Polaris has (`Avatar`), not a copy of
 * it: the initials are drawn first and the picture is laid over them once one
 * has actually arrived. That is what this used to get wrong. It drew the picture
 * and waited - an empty circle for as long as the server spent looking for a
 * mark, which on a cold mailbox is seconds - and a colleague with no photo is
 * answered with a transparent pixel rather than a refusal, so their circle
 * stayed empty for good. Now there is never a hole: letters until a real picture
 * loads, and letters again if none does.
 *
 * The picture is fetched by Polaris rather than by the browser, so the sender's
 * site learns that a server asked and nothing about the reader.
 *
 * A mark that cannot be seen is the other failure, and it is quieter. Most sites
 * publish a near-black logo on transparency, drawn for their own white page: in
 * the dark theme that is a hole where a logo should be. So the mark is measured
 * once it has loaded and given a plate when it needs one - the same
 * relative-luminance test that decides whether somebody's name is readable on the
 * plate they chose, applied to a picture instead of to letters. The measurement
 * costs one 16-pixel draw and is remembered for the rest of the session, so a
 * mailbox full of one shop measures it once.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { coversWhole, markColor, plateFor } from "@/lib/mailbox/mark-plate";

/** How big the mark is sampled at. A logo's colour does not need more, and this
 *  is a canvas per sender rather than per message. */
const SAMPLE = 16;

/** What a picture turned out to be, by the address it came from. Held for the
 *  session: the answer cannot change while the picture behind it does not. */
interface Measured {
    /** The plate behind a mark that needs one, else null. */
    readonly plate: string | null;
    /** Whether it fills its square - a photograph rather than a logo. */
    readonly whole: boolean;
}

const NOTHING_MEASURED: Measured = { plate: null, whole: false };

const measured = new Map<string, Measured>();

/**
 * What is behind a mark, measured from the pixels the browser has already
 * decoded.
 *
 * Same-origin, because Polaris served it - so the canvas is readable rather than
 * tainted, and this is a measurement rather than a request. Anything that goes
 * wrong answers "no plate", which is what the column looked like before.
 *
 * A picture that fills its square is never plated: it has its own background,
 * and a plate behind it only shows as a ring round its edge.
 */
function measure(image: HTMLImageElement): Measured {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return NOTHING_MEASURED;
        context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
        const pixels = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
        if (coversWhole(pixels)) return { plate: null, whole: true };
        return { plate: plateFor(markColor(pixels)), whole: false };
    } catch {
        return NOTHING_MEASURED;
    }
}

/** The name a sender is drawn by: what they call themselves, else the part of
 *  their address before the `@`, else the address. Never empty while there is
 *  an address, so there are always letters to draw. */
export function senderLabel(name: string, address: string): string {
    return name.trim() || address.split("@")[0] || address;
}

export function SenderFace({
    name,
    address,
    size = 28,
    className
}: {
    name: string;
    address: string;
    size?: number;
    className?: string;
}) {
    const [seen, setSeen] = useState<Measured>(() => measured.get(address) ?? NOTHING_MEASURED);
    const label = senderLabel(name, address);

    useEffect(() => {
        setSeen(measured.get(address) ?? NOTHING_MEASURED);
    }, [address]);

    const settle = (image: HTMLImageElement): void => {
        const known = measured.get(address);
        if (known) {
            setSeen(known);
            return;
        }
        const found = measure(image);
        measured.set(address, found);
        setSeen(found);
    };

    return (
        // Hidden from a screen reader: the name is beside it, and two letters
        // read out before every sender are noise.
        <span aria-hidden className={cn("inline-flex shrink-0", className)}>
            <Avatar
                // Keyed by the address so a row reused for another sender does
                // not carry the last one's loaded state across.
                key={address}
                person={{
                    id: null,
                    name: label,
                    image: address ? `/api/mail/face/${encodeURIComponent(address)}` : null
                }}
                size={size}
                status={false}
                tint={address || label}
                // A logo is drawn whole; a photograph fills the circle, the way
                // every other face in Polaris does.
                fit={seen.whole ? "cover" : "contain"}
                // A plate only under a mark that needs one, so a mark that reads
                // on both themes keeps the column as plain as it was.
                backdrop={seen.plate}
                onPicture={settle}
                // A mailbox is a long list; the rows below the fold are asked
                // for as they come near, with their letters showing until then.
                lazy
            />
        </span>
    );
}
