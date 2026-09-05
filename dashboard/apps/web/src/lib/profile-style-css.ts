/**
 * A catalogue choice as CSS.
 *
 * The catalogue in `@polaris/core` is parameters - colours, a width, an angle -
 * and this is the one place they become properties. Two reasons it is a module
 * rather than a handful of inline objects: every one of these values ends up in
 * a `style` attribute on a page other people read, so having a single seam
 * between "an id somebody stored" and "a property a browser applies" is what
 * makes that reviewable; and the same decoration is drawn on a face in a list, a
 * face on a card and a face in a preview, which is three components that must
 * not each invent their own ring.
 *
 * Everything here is pure and takes a catalogue entry rather than an id, so the
 * check that an id is one Polaris shipped has already happened by the time
 * anything gets here.
 */

import type { CSSProperties } from "react";
import type {
    AvatarDecoration,
    NameFont,
    NameLook,
    NameStyle,
    Nameplate,
    ProfileEffect
} from "@polaris/core";

/**
 * How wide the band a decoration is drawn in is, in pixels, for a face of this
 * size.
 *
 * A fraction of the face rather than a fixed width, so the same decoration reads
 * the same at 20 pixels in a list and at 72 on a card - and floored at one
 * device pixel, because a band rounded down to nothing is a decoration somebody
 * chose and cannot see.
 */
export function ringWidth(decoration: AvatarDecoration, size: number): number {
    return Math.max(1, Math.round(size * decoration.width));
}

/** The glow around it, or nothing. Sized off the face for the same reason the
 *  ring is. */
export function ringGlow(decoration: AvatarDecoration, size: number): string | undefined {
    if (!decoration.glow) return undefined;
    return `0 0 ${Math.max(4, Math.round(size * 0.18))}px ${decoration.glow}66`;
}

/** The plate a name sits on. */
export function nameplateCss(plate: Nameplate): CSSProperties {
    return {
        background: `linear-gradient(${plate.angle}deg, ${plate.from} 0%, ${plate.to} 100%)`,
        // A decision rather than a calculation: contrast against a gradient
        // depends on where the letters land on it, which is not something a
        // formula over two stops can answer.
        color: plate.dark ? "#1c1917" : "#ffffff"
    };
}

/**
 * A name painted in its owner's colours.
 *
 * The gradient is clipped to the glyphs, which every browser Polaris supports
 * does through `background-clip: text`. `color: transparent` is what makes the
 * clip visible - and it is also what makes this the one style here with a
 * fallback worth thinking about: a browser that ignores the clip would draw an
 * invisible name, so the colour is set from the gradient's first stop first and
 * only then made transparent. A name is not a place to be clever.
 *
 * A moving one is the same gradient tiled and walked across the letters by
 * exactly one tile per cycle, which is why its last colour is its first: the
 * frame the walk ends on is the frame it started from, so there is no instant
 * where it jumps back to the beginning. Exactly 90 degrees for the same reason -
 * a slanted gradient meets the next tile at a slightly different colour on every
 * line of the letters, and the join stops being invisible.
 */
/**
 * The letterforms, as stacks the machine already has.
 *
 * Not fetched. A display name is drawn in every list in the product, so a face
 * that arrives over the network is a hundred names reflowing a moment after the
 * page settles, and one that fails to arrive is a hundred names in a fallback
 * nobody picked. Everything here can be promised at any size, offline, on the
 * first paint.
 *
 * `caps` is the one that is not a family. Small capitals are a real typographic
 * variation of the face already in use, which is a different letterform for no
 * file at all - and on a name it reads as deliberate where a second sans would
 * read as a mistake.
 */
const FACES: Record<NameFont, CSSProperties> = {
    sans: {},
    serif: { fontFamily: 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif' },
    mono: { fontFamily: "var(--font-mono)" },
    rounded: {
        fontFamily:
            'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Segoe UI Variable", var(--font-sans)'
    },
    caps: { fontVariantCaps: "small-caps", letterSpacing: "0.03em" }
};

/** The stops of a gradient, evenly spaced. */
function ramp(colors: readonly string[]): string {
    if (colors.length === 1) return `${colors[0]}, ${colors[0]}`;
    return colors
        .map((color, index, all) => `${color} ${Math.round((index / (all.length - 1)) * 100)}%`)
        .join(", ");
}

/** Paint poured through the letters rather than behind them. */
function throughLetters(image: string, moving: boolean): CSSProperties {
    return {
        backgroundImage: image,
        ...(moving ? { backgroundSize: "200% 100%", backgroundRepeat: "repeat-x" } : null),
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent"
    } as CSSProperties;
}

/**
 * A name, painted the way its owner chose.
 *
 * Seven effects, and the reason there are seven rather than one is that a
 * gradient was the only thing the old catalogue could make - so every name that
 * was anything at all was the same idea in different colours.
 *
 * What none of them touch is the size or the face's metrics. `toon` and `pop`
 * carry weight because an outline needs a stem to sit on and a hard shadow needs
 * something to cast one, and that is as far as it goes: a name a row taller than
 * its neighbours is not personalisation, it is a fight over a column.
 */
export function nameLookCss(look: NameLook): CSSProperties {
    const face = FACES[look.font];
    const first = look.colors[0] ?? "#ffffff";
    const second = look.colors[1] ?? first;

    switch (look.effect) {
        case "solid":
            return { ...face, color: first };

        case "neon":
            // The glow is three shadows of the same colour at growing radii,
            // which is what makes it read as light coming off the letters
            // rather than as a blurred copy behind them.
            return {
                ...face,
                color: first,
                textShadow: `0 0 4px ${first}66, 0 0 10px ${first}59, 0 0 22px ${first}40`
            };

        case "toon":
            // Painted, then outlined under it: `paint-order` is what stops the
            // stroke eating half the stem from the inside, which on a name at
            // list size is the difference between bold and smudged.
            return {
                ...face,
                color: first,
                fontWeight: 700,
                WebkitTextStrokeWidth: "0.06em",
                WebkitTextStrokeColor: "rgba(0,0,0,0.65)",
                paintOrder: "stroke fill"
            } as CSSProperties;

        case "pop":
            // A sticker: one hard offset, no blur. The offset is in em so it is
            // the same picture at twenty pixels and at forty.
            return {
                ...face,
                color: first,
                fontWeight: 700,
                textShadow: `0.055em 0.055em 0 rgba(0,0,0,0.55)`
            };

        case "gummy":
            // Two tones down the letters rather than across them, with a soft
            // light under the top edge. Vertical because that is where a
            // rounded, wet-looking thing takes its highlight from.
            return {
                ...face,
                fontWeight: 700,
                ...throughLetters(`linear-gradient(180deg, ${ramp([first, second])})`, false),
                filter: `drop-shadow(0 0.04em 0.02em ${second}55)`
            };

        case "prism":
            return {
                ...face,
                color: first,
                ...throughLetters(`linear-gradient(90deg, ${ramp(look.colors)})`, true)
            };

        case "gradient":
        default:
            return {
                ...face,
                color: first,
                ...throughLetters(`linear-gradient(92deg, ${ramp([first, second])})`, false)
            };
    }
}

/** The old shape, kept for the catalogue entries the picker still draws as
 *  swatches. Everything that paints a real name goes through `nameLookCss`. */
export function nameStyleCss(style: NameStyle): CSSProperties {
    return nameLookCss({
        effect: style.moving ? "prism" : "gradient",
        font: "sans",
        colors: style.colors,
        moving: style.moving === true
    });
}

/**
 * The class a name wears while its colours are moving, or nothing.
 *
 * A class rather than more of the object above because keyframes cannot be
 * written in a `style` attribute, and the walk has to be one - see
 * `polaris-name-flow` in globals.css. Kept beside the properties it belongs with
 * so a caller cannot apply one without the other.
 */
export function nameStyleClass(
    style: { readonly moving?: boolean } | null | undefined
): string | undefined {
    return style?.moving ? "profile-name-flow" : undefined;
}

/** The edge an effect puts on a card, or nothing when it only carries a sheen. */
export function frameCss(effect: ProfileEffect): CSSProperties | null {
    if (!effect.frame) return null;
    return {
        // Drawn as a border-coloured image rather than a shadow so the corner
        // radius is the card's own and the edge does not sit outside it.
        borderColor: "transparent",
        backgroundImage: `linear-gradient(hsl(var(--card)), hsl(var(--card))), linear-gradient(120deg, ${effect.frame.from} 0%, ${effect.frame.to} 100%)`,
        backgroundOrigin: "border-box",
        backgroundClip: "padding-box, border-box"
    };
}

/**
 * The band of light an effect walks across a card, or nothing when it is only a
 * frame.
 *
 * It used to be a narrow element pushed from one side of the card to the other
 * and then held off-screen for most of the cycle before snapping back to the
 * start. On screen that is not a surface catching the light: the band crosses,
 * vanishes, waits, and reappears out of nowhere, which reads as something
 * failing rather than as an ornament.
 *
 * So the light is a tile instead of an element. One tile is two card widths - a
 * bright streak in the middle and transparency at both ends, which is what lets
 * the tiles meet invisibly - repeated across a layer four card widths wide, and
 * the layer is walked by exactly one tile per cycle. The frame it ends on is
 * pixel-for-pixel the frame it started from, so it never restarts: light simply
 * keeps passing, about every half cycle. `SHEEN_LAYER` carries the geometry the
 * arithmetic depends on, so the two cannot drift apart.
 */
export function sheenCss(effect: ProfileEffect): CSSProperties | null {
    if (!effect.sheen) return null;
    return {
        backgroundImage: `linear-gradient(100deg, transparent 0%, ${effect.sheen}00 22%, ${effect.sheen}3d 50%, ${effect.sheen}00 78%, transparent 100%)`,
        // Half of a layer that is four cards wide: one tile is two card widths.
        backgroundSize: "50% 100%",
        backgroundRepeat: "repeat-x"
    };
}

/**
 * The layer that light is painted on, wherever a card wears one.
 *
 * Four times the card's width and started at its left edge, so that after being
 * walked one tile to the left - `polaris-sheen` in globals.css - it still covers
 * the card from edge to edge. Exported rather than written out per card because
 * the width here and the walk in the stylesheet are one calculation in two
 * places, and a card that disagreed with the stylesheet would show the layer's
 * own edge crossing it.
 */
export const SHEEN_LAYER = "profile-sheen pointer-events-none absolute inset-y-0 left-0 z-10 w-[400%]";
