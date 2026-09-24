"use client";

/**
 * Formatted runs drawn the way the game draws them, for the previews.
 *
 * Deliberately styled like Minecraft rather than like the dashboard: the question
 * a preview answers is "what will this look like there". That includes the drop
 * shadow the game puts under all its text - one pixel down and right, the same
 * colour at a quarter of its brightness - which is also what keeps dark grey on a
 * dark sky readable in the game and has to be in the preview for it to tell the
 * truth about contrast.
 */

import type { MotdSpan } from "../lib/minecraft/motd";

/** The game's shadow colour for a text colour: a quarter of each channel. */
export function shadowOf(hex: string): string {
    const value = hex.replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return "rgba(0,0,0,0.6)";
    const quarter = (from: number) =>
        Math.floor(Number.parseInt(value.slice(from, from + 2), 16) / 4)
            .toString(16)
            .padStart(2, "0");
    return `#${quarter(0)}${quarter(2)}${quarter(4)}`;
}

/** One line of runs. `scale` is how many times the game's text size it is drawn
 *  at - a title is four, a subtitle two - and the shadow grows with it. */
export function McLine({
    spans,
    scale = 1,
    shadow = true
}: {
    spans: readonly MotdSpan[];
    scale?: number;
    shadow?: boolean;
}) {
    return (
        <>
            {spans.map((span, index) => (
                <span
                    key={index}
                    style={{
                        color: span.color,
                        fontWeight: span.bold ? 700 : 400,
                        fontStyle: span.italic ? "italic" : "normal",
                        textDecoration:
                            [
                                span.underline ? "underline" : "",
                                span.strikethrough ? "line-through" : ""
                            ]
                                .filter(Boolean)
                                .join(" ") || "none",
                        textShadow: shadow
                            ? `${Math.max(1, scale)}px ${Math.max(1, scale)}px 0 ${shadowOf(span.color)}`
                            : undefined,
                        // Minecraft redraws these characters every frame. A still
                        // cannot show that, so it shows that they are unreadable
                        // rather than showing them as readable.
                        opacity: span.obfuscated ? 0.45 : 1
                    }}
                >
                    {span.text}
                </span>
            ))}
        </>
    );
}
