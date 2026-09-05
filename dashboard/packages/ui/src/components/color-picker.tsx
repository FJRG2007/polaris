"use client";

/**
 * Picking a colour, in the product rather than in the browser.
 *
 * `<input type="color">` opens the operating system's colour dialog, which is a
 * different window in a different visual language on every machine - and on
 * Windows it is the one from 1995. It is also unreadable next to a dark
 * dashboard, cannot be styled at all, and on a phone it is whatever the platform
 * decides. A control that ships with the product looks like the product and
 * behaves the same everywhere.
 *
 * The shape is the one everybody has already used: a square for saturation and
 * value, a strip for hue, a box for the hex. Which means nothing has to be
 * learnt, and the box is what makes it exact - a picker with no way to type
 * `#5b8def` is a picker somebody has to fight to match a brand colour with.
 *
 * The square is a pointer surface and therefore the part that has to be
 * deliberate about the keyboard: the hue strip is a real range input, so it
 * arrows and it announces itself, and the hex box is the keyboard's path to any
 * colour at all. Somebody who cannot use a pointer is never left without a way
 * to reach a colour, which is the bar this has to clear.
 *
 * Controlled, and it emits six hex digits with a hash - the one spelling
 * everything downstream stores and checks.
 */

import { cn } from "../lib/cn";
import { hexToHsv, hsvToHex, type Hsv } from "@polaris/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** A handful of colours that look right on a dashboard, so the common case is
 *  one press rather than a drag. */
const SUGGESTED = [
    "#5b8def",
    "#3fd0c9",
    "#7bc47f",
    "#e8c26a",
    "#ff9a3c",
    "#ff5a5f",
    "#d94f8a",
    "#a06bff",
    "#4d5561",
    "#20242c"
];

export function ColorPicker({
    value,
    onChange,
    label,
    className
}: {
    /** Six hex digits with a hash. Anything else is treated as the default blue,
     *  because a picker cannot show a handle for a colour it cannot read. */
    value: string;
    onChange: (hex: string) => void;
    label?: string;
    className?: string;
}) {
    /**
     * The colour being dragged, in the space it is being dragged in.
     *
     * Held here rather than derived from the hex on every render, because hue and
     * saturation stop meaning anything at the edges: black is every hue at once,
     * so dragging to the bottom of the square and back would otherwise lose which
     * hue somebody had chosen, and the handle would jump to red.
     */
    const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { hue: 220, saturation: 70, value: 90 });
    /** What is in the hex box while it is being typed, which is allowed to be
     *  something that is not a colour yet. */
    const [typed, setTyped] = useState(value);
    const square = useRef<HTMLDivElement>(null);
    /** Whether the pointer is down on the square. State, so the window listeners
     *  below appear and disappear with the press rather than one render late. */
    const [dragging, setDragging] = useState(false);

    // A colour changed from outside - a preset pressed, a different gradient stop
    // selected - moves the handles. A colour this picker just emitted does not:
    // it is already where it was put, and re-deriving it would fight the drag.
    useEffect(() => {
        setTyped(value);
        const incoming = hexToHsv(value);
        if (!incoming || dragging) return;
        if (hsvToHex(hsv) === value.toLowerCase()) return;
        setHsv(incoming);
        // Only when the value came from elsewhere, which is what the guard above
        // decides; `hsv` is deliberately not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const emit = useCallback(
        (next: Hsv) => {
            setHsv(next);
            onChange(hsvToHex(next));
        },
        [onChange]
    );

    const aim = useCallback(
        (event: { clientX: number; clientY: number }) => {
            const box = square.current?.getBoundingClientRect();
            if (!box || box.width === 0 || box.height === 0) return;
            const across = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
            const down = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
            setHsv((was) => {
                const next = { hue: was.hue, saturation: across * 100, value: (1 - down) * 100 };
                onChange(hsvToHex(next));
                return next;
            });
        },
        [onChange]
    );

    /**
     * A drag that leaves the square is still a drag.
     *
     * Listened for on the window rather than on the square, because a handle
     * that stops at the edge while the pointer keeps going is the one thing that
     * makes a picker feel broken.
     *
     * `dragging` is state rather than a ref, and that is the fix rather than a
     * detail: as a ref, whether to listen was read during render, so the
     * listeners were only added on the render after the press and only taken
     * away on the render after the release - which meant the first pointer move
     * after letting go still moved the colour. State makes the effect re-run
     * when the press starts and when it ends, which is exactly when the
     * listeners should appear and disappear.
     */
    useEffect(() => {
        if (!dragging) return;
        const move = (event: PointerEvent) => aim(event);
        const stop = () => setDragging(false);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
        };
    }, [dragging, aim]);

    const hex = hsvToHex(hsv);

    return (
        <div className={cn("flex flex-col gap-2", className)}>
            <div
                ref={square}
                // The gradient underneath is the standard one: white to the hue
                // across, transparent to black down.
                style={{
                    backgroundColor: hsvToHex({ hue: hsv.hue, saturation: 100, value: 100 }),
                    backgroundImage:
                        "linear-gradient(to top, #000000, rgba(0,0,0,0)), linear-gradient(to right, #ffffff, rgba(255,255,255,0))"
                }}
                onPointerDown={(event) => {
                    setDragging(true);
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    aim(event);
                }}
                className="relative h-32 w-full cursor-crosshair rounded-md border border-border"
                role="presentation"
            >
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                    style={{
                        left: `${hsv.saturation}%`,
                        top: `${100 - hsv.value}%`,
                        backgroundColor: hex
                    }}
                />
            </div>

            <input
                type="range"
                min={0}
                max={359}
                step={1}
                value={Math.round(hsv.hue)}
                aria-label={label ? `${label}: hue` : "Hue"}
                onChange={(event) => emit({ ...hsv, hue: Number(event.target.value) })}
                className="h-3 w-full cursor-pointer appearance-none rounded-full border border-border"
                style={{
                    backgroundImage:
                        "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)"
                }}
            />

            <div className="flex items-center gap-2">
                <span
                    aria-hidden="true"
                    className="size-7 shrink-0 rounded-md border border-border"
                    style={{ backgroundColor: hex }}
                />
                <input
                    value={typed}
                    aria-label={label ? `${label}: hex` : "Hex colour"}
                    spellCheck={false}
                    onChange={(event) => {
                        const next = event.target.value;
                        setTyped(next);
                        // Emitted as soon as it is a colour, so the preview moves
                        // as the sixth digit is typed rather than on blur.
                        const parsed = hexToHsv(next);
                        if (!parsed) return;
                        setHsv(parsed);
                        onChange(hsvToHex(parsed));
                    }}
                    onBlur={() => setTyped(value)}
                    className="h-7 w-24 rounded-md border border-border bg-surface px-2 font-mono text-xs text-foreground outline-none focus-visible:border-border-strong"
                />
                <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                    {SUGGESTED.map((suggestion) => (
                        <button
                            key={suggestion}
                            type="button"
                            aria-label={suggestion}
                            title={suggestion}
                            onClick={() => {
                                const parsed = hexToHsv(suggestion);
                                if (parsed) emit(parsed);
                            }}
                            className="size-5 rounded border border-border transition-transform hover:scale-110"
                            style={{ backgroundColor: suggestion }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
