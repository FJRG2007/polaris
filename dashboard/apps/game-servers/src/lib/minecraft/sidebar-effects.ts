/**
 * The side panel's effects: what a line looks like at one step of its
 * animation.
 *
 * Every effect works on the line as the game will draw it - its characters with
 * their own colour and styles, values already filled in - and hands back the
 * same text written out again, so a bold heading stays bold while a shine runs
 * across it. The colours the effects make are the game's six-digit ones, which
 * is what makes a rainbow a gradient rather than the same six named colours.
 *
 * One command carries about a thousand bytes, and a colour per character is a
 * lot of them:
 * `fits` is asked of each try, and a line that does not fit is drawn again with
 * neighbouring characters sharing a colour until it does.
 *
 * Pure, so every step can be asserted and the preview draws exactly what the
 * players see.
 */

import type { SidebarEffect } from "./sidebar";
import { MOTD_COLORS, motdSpans } from "./motd";

/** One character with the formatting it is drawn in. */
interface Glyph {
    readonly ch: string;
    readonly color: string;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly strikethrough: boolean;
    readonly obfuscated: boolean;
}

/** The effects' own colours when none were chosen. */
export const EFFECT_DEFAULT_COLORS: Readonly<Record<string, readonly string[]>> = {
    wave: ["#ffaa00", "#ffff55"],
    shine: ["#ffffff"],
    blink: ["#555555"]
};

/** Steps a shine waits off the end of the line before it comes round again. */
const SHINE_PAUSE = 8;
/** Steps typing holds the whole line before it starts over. */
const TYPE_HOLD = 6;
/** Spaces between the end of a scrolling line and its start coming round. */
const SCROLL_GAP = 3;

function glyphs(text: string): Glyph[] {
    const spans = motdSpans(text)[0] ?? [];
    return spans.flatMap((span) =>
        [...span.text].map((ch) => ({
            ch,
            color: span.color.toLowerCase(),
            bold: span.bold,
            italic: span.italic,
            underline: span.underline,
            strikethrough: span.strikethrough,
            obfuscated: span.obfuscated
        }))
    );
}

const NAMED = new Map(
    Object.entries(MOTD_COLORS).map(([code, color]) => [color.hex.toLowerCase(), code])
);

/** A colour as `&` codes: the named one where there is one, which is shorter. */
function colorCode(hex: string): string {
    const named = NAMED.get(hex);
    if (named) return `&${named}`;
    return `&x${[...hex.slice(1)].map((digit) => `&${digit}`).join("")}`;
}

function styleCodes(glyph: Glyph): string {
    return `${glyph.bold ? "&l" : ""}${glyph.italic ? "&o" : ""}${glyph.underline ? "&n" : ""}${
        glyph.strikethrough ? "&m" : ""
    }${glyph.obfuscated ? "&k" : ""}`;
}

/** Glyphs written back as text, a code only where the formatting changes. A
 *  colour clears the styles in the game, so the styles follow every colour. */
function written(all: readonly Glyph[]): string {
    let out = "";
    let current = "";
    for (const glyph of all) {
        const codes = `${colorCode(glyph.color)}${styleCodes(glyph)}`;
        if (codes !== current) {
            out += codes;
            current = codes;
        }
        out += glyph.ch;
    }
    return out;
}

function hexOf(r: number, g: number, b: number): string {
    const part = (value: number) =>
        Math.round(Math.max(0, Math.min(255, value)))
            .toString(16)
            .padStart(2, "0");
    return `#${part(r)}${part(g)}${part(b)}`;
}

function rgbOf(hex: string): [number, number, number] {
    return [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16)
    ];
}

/** A bright colour at `hue` degrees round the wheel. */
function hue(degrees: number): string {
    const h = (((degrees % 360) + 360) % 360) / 60;
    const x = 1 - Math.abs((h % 2) - 1);
    const [r, g, b] =
        h < 1
            ? [1, x, 0]
            : h < 2
              ? [x, 1, 0]
              : h < 3
                ? [0, 1, x]
                : h < 4
                  ? [0, x, 1]
                  : h < 5
                    ? [x, 0, 1]
                    : [1, 0, x];
    // Lifted towards white, so it reads on the panel's dark background.
    return hexOf(90 + r * 165, 90 + g * 165, 90 + b * 165);
}

function mix(from: string, to: string, amount: number): string {
    const [ar, ag, ab] = rgbOf(from);
    const [br, bg, bb] = rgbOf(to);
    return hexOf(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount);
}

/** The effect's colour number `index`, or its default. */
function colorOf(effect: SidebarEffect, index: number): string {
    return (
        effect.colors[index] ??
        EFFECT_DEFAULT_COLORS[effect.kind]?.[index] ??
        "#ffffff"
    ).toLowerCase();
}

/** Recolour each character, `group` of them sharing one colour. */
function recolored(
    all: readonly Glyph[],
    group: number,
    color: (index: number) => string
): Glyph[] {
    return all.map((glyph, index) => ({
        ...glyph,
        color: color(Math.floor(index / group) * group)
    }));
}

/** One try at the effect, with `group` characters to a colour. */
function drawn(all: readonly Glyph[], effect: SidebarEffect, step: number, group: number): string {
    const length = all.length;
    switch (effect.kind) {
        case "rainbow":
            return written(
                recolored(all, group, (index) =>
                    hue((index * 360) / Math.max(length, 12) + step * 30)
                )
            );
        case "wave":
            return written(
                recolored(all, group, (index) =>
                    mix(
                        colorOf(effect, 0),
                        colorOf(effect, 1),
                        (Math.sin(index * 0.5 - step * 0.8) + 1) / 2
                    )
                )
            );
        case "shine": {
            const at = (step % (length + SHINE_PAUSE)) - 2;
            const glint = colorOf(effect, 0);
            return written(
                all.map((glyph, index) =>
                    Math.abs(index - at) <= 1 ? { ...glyph, color: glint } : glyph
                )
            );
        }
        case "typewriter": {
            const shown = Math.min(length, step % (length + TYPE_HOLD));
            return written(all.slice(0, shown));
        }
        case "blink":
            return step % 2 === 0
                ? written(all)
                : written(all.map((glyph) => ({ ...glyph, color: colorOf(effect, 0) })));
        case "scroll": {
            if (length <= effect.width) return written(all);
            const blank: Glyph = { ...all[all.length - 1]!, ch: " " };
            const loop = [...all, ...Array.from({ length: SCROLL_GAP }, () => blank)];
            const start = step % loop.length;
            return written(
                Array.from(
                    { length: effect.width },
                    (_, index) => loop[(start + index) % loop.length]!
                )
            );
        }
        default:
            return written(all);
    }
}

/**
 * The line at `step` of its effect. Unchanged for "none" and for an empty line.
 * `fits` says whether a result can be sent in one command; where it cannot,
 * neighbouring characters share a colour until it can, and as a last resort the
 * line is drawn without the effect.
 */
export function applyEffect(
    text: string,
    effect: SidebarEffect,
    step: number,
    fits: (text: string) => boolean = () => true
): string {
    if (effect.kind === "none") return text;
    const all = glyphs(text);
    if (all.length === 0) return text;
    for (const group of [1, 2, 3, 4, 6, 8, all.length]) {
        const out = drawn(all, effect, Math.max(0, Math.floor(step)), group);
        if (fits(out)) return out;
    }
    return fits(text) ? text : written(all.slice(0, 1));
}
