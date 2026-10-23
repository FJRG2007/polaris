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

/**
 * A call key's face: a filled tile in Polaris violet with a white glyph and the
 * Polaris mark faint behind it, the way a voice app's own deck keys look, so the
 * call controls read as one group at a glance. Hanging up is red, so the one
 * key that ends the call is never mistaken for the ones beside it.
 */
export type KeyLook = "call" | "hangup";

export interface KeyFace {
    readonly icon: string;
    readonly tone: KeyTone;
    /** Drawn as a call tile rather than the plugin's tinted square. */
    readonly look?: KeyLook;
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

/** Polaris violet, the colour of its mark. */
const CALL_TILE = "#7632EC";

/** A call tile's fill for a state: violet at rest, amber while nobody can hear
 *  you, red while the call is recorded. Hanging up is bright red during a call
 *  and a dim red with a pink glyph when there is no call to leave. */
function tileColors(look: KeyLook, tone: KeyTone): { fill: string; glyph: string } {
    if (look === "hangup")
        return tone === "bad"
            ? { fill: "#D83A3A", glyph: "#FFFFFF" }
            : { fill: "#4A2328", glyph: "#F87171" };
    if (tone === "warn") return { fill: BACKGROUND.warn, glyph: "#FFFFFF" };
    if (tone === "bad") return { fill: "#B91C1C", glyph: "#FFFFFF" };
    return { fill: CALL_TILE, glyph: "#FFFFFF" };
}

/** The Polaris mark, in its 32-unit box, as `src/app/icon.svg` draws it. */
const MARK_PATH = "M16 3Q17.6 12.6 29 16Q17.6 19.4 16 29Q14.4 19.4 3 16Q14.4 12.6 16 3Z";

function renderTile(face: KeyFace, look: KeyLook): string {
    const { fill, glyph } = tileColors(look, face.tone);
    const hasValue = face.value !== undefined && face.value !== "";
    // 24-unit icons: 64 px wide centred above the label, smaller with a value.
    const icon = hasValue
        ? `<g transform="translate(48 12) scale(2)">`
        : face.label
          ? `<g transform="translate(40 22) scale(2.667)">`
          : `<g transform="translate(36 36) scale(3)">`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
        `<rect width="144" height="144" rx="16" fill="${fill}"/>`,
        // The mark peeks in from the lower left, faint, as a brand watermark.
        `<path d="${MARK_PATH}" transform="translate(-26 58) scale(3.6)" fill="#FFFFFF" fill-opacity="0.14"/>`,
        face.on ? `<rect x="16" y="6" width="112" height="8" rx="4" fill="#FFFFFF"/>` : "",
        `${icon}<g fill="none" stroke="${glyph}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(face.icon)}</g></g>`,
        hasValue
            ? `<text x="72" y="${face.label ? 98 : 106}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#FFFFFF">${escapeXml(clip(face.value!, 7))}</text>`
            : "",
        face.label
            ? `<text x="72" y="128" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="600" fill="#FFFFFF">${escapeXml(clip(face.label, 13))}</text>`
            : "",
        "</svg>"
    ].join("");
}

/** The SVG for a key. */
export function renderKey(face: KeyFace): string {
    if (face.look) return renderTile(face, face.look);
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
