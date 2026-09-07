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
import { initials, tintFor } from "@/components/avatar";
import { markColor, plateFor } from "@/lib/mailbox/mark-plate";

/** How big the mark is sampled at. A logo's colour does not need more, and this
 *  is a canvas per sender rather than per message. */
const SAMPLE = 16;

/** What each mark turned out to need, by the address it came from. Held for the
 *  session: the answer cannot change while the picture behind it does not. */
const plates = new Map<string, string | null>();

/**
 * What is behind a mark, measured from the pixels the browser has already
 * decoded.
 *
 * Same-origin, because Polaris served it - so the canvas is readable rather than
 * tainted, and this is a measurement rather than a request. Anything that goes
 * wrong answers "no plate", which is what the column looked like before.
 */
function measure(image: HTMLImageElement): string | null {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
        return plateFor(markColor(context.getImageData(0, 0, SAMPLE, SAMPLE).data));
    } catch {
        return null;
    }
}

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
    const [plate, setPlate] = useState<string | null>(() => plates.get(address) ?? null);
    const label = name.trim() || address.split("@")[0] || address;

    useEffect(() => {
        setPlate(plates.get(address) ?? null);
    }, [address]);

    const settle = (image: HTMLImageElement): void => {
        if (plates.has(address)) {
            setPlate(plates.get(address) ?? null);
            return;
        }
        const found = measure(image);
        plates.set(address, found);
        setPlate(found);
    };

    /**
     * A picture the browser already had is complete before React mounts it, and
     * an onLoad that fired before there was a handler is one that never fires -
     * which would leave every second visit to a mailbox unplated. So the element
     * is asked whether it is already there, as well as being listened to.
     */
    const attach = (image: HTMLImageElement | null): void => {
        if (image?.complete && image.naturalWidth > 0) settle(image);
    };

    return (
        <span
            aria-hidden
            className={cn(
                "flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-medium text-white",
                className
            )}
            // A plate is only ever drawn under a mark that needs one, so a mark
            // that reads on both themes keeps the column as plain as it was.
            style={
                !drawn
                    ? { backgroundColor: tintFor(address || label) }
                    : plate
                      ? { backgroundColor: plate, padding: 2 }
                      : undefined
            }
        >
            {drawn && address ? (
                <img
                    src={`/api/mail/face/${encodeURIComponent(address)}`}
                    alt=""
                    className="size-full object-contain"
                    loading="lazy"
                    decoding="async"
                    ref={attach}
                    onLoad={(event) => settle(event.currentTarget)}
                    onError={() => setDrawn(false)}
                />
            ) : (
                initials(label)
            )}
        </span>
    );
}
