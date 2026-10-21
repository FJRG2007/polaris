/**
 * What a key looks like: one SVG, drawn from its state.
 *
 * Rendered rather than picked from bundled images, so a colour, a count or a
 * line of status needs no file per combination. 144 by 144, the size the
 * Stream Deck app draws a key at on a high-density deck; it scales down.
 *
 * Pure: no SDK, so the tests draw keys without a Stream Deck.
 */

import { iconMarkup } from "./icons";

/** How a key is coloured: its state's tone, or one of the plugin's own. */
export type KeyTone = "ok" | "warn" | "bad" | "idle" | "off";

const BACKGROUND: Record<KeyTone, string> = {
    ok: "#14532d",
    warn: "#78350f",
    bad: "#7f1d1d",
    idle: "#1f2937",
    off: "#111827"
};

const ACCENT: Record<KeyTone, string> = {
    ok: "#4ade80",
    warn: "#fbbf24",
    bad: "#f87171",
    idle: "#a78bfa",
    off: "#6b7280"
};

export interface KeyFace {
    readonly icon: string;
    readonly tone: KeyTone;
    /** Drawn large, under the icon: a count, a time. */
    readonly value?: string;
    /** One short line at the bottom. */
    readonly label?: string;
    /** A toggle that is on gets a bar across the top. */
    readonly on?: boolean;
}

/** Text safe inside SVG markup. */
export function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** At most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
    const chars = [...text];
    return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The SVG for a key. */
export function renderKey(face: KeyFace): string {
    const accent = ACCENT[face.tone];
    const hasValue = face.value !== undefined && face.value !== "";
    // With a value the icon moves up and shrinks to leave it room.
    const icon = hasValue
        ? `<g transform="translate(48 14) scale(2)">`
        : `<g transform="translate(36 26) scale(3)">`;
    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
        `<rect width="144" height="144" rx="16" fill="${BACKGROUND[face.tone]}"/>`,
        face.on ? `<rect x="16" y="6" width="112" height="8" rx="4" fill="${accent}"/>` : "",
        `${icon}<g fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(face.icon)}</g></g>`,
        hasValue
            ? `<text x="72" y="${face.label ? 98 : 106}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#ffffff">${escapeXml(clip(face.value!, 7))}</text>`
            : "",
        face.label
            ? `<text x="72" y="130" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#e5e7eb">${escapeXml(clip(face.label, 13))}</text>`
            : "",
        "</svg>"
    ];
    return parts.join("");
}

/** The same SVG as the data URL `setImage` and a dial's pixmap take. */
export function keyImage(face: KeyFace): string {
    return `data:image/svg+xml;charset=utf8,${encodeURIComponent(renderKey(face))}`;
}
