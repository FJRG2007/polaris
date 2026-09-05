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
import type { AvatarDecoration, NameStyle, Nameplate, ProfileEffect } from "@polaris/core";

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
export function nameStyleCss(style: NameStyle): CSSProperties {
    const stops = style.colors
        .map((color, index, all) => `${color} ${Math.round((index / (all.length - 1)) * 100)}%`)
        .join(", ");
    return {
        color: style.colors[0],
        backgroundImage: `linear-gradient(${style.moving ? 90 : 92}deg, ${stops})`,
        ...(style.moving
            ? { backgroundSize: "200% 100%", backgroundRepeat: "repeat-x" }
            : null),
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent"
    } as CSSProperties;
}

/**
 * The class a name wears while its colours are moving, or nothing.
 *
 * A class rather than more of the object above because keyframes cannot be
 * written in a `style` attribute, and the walk has to be one - see
 * `polaris-name-flow` in globals.css. Kept beside the properties it belongs with
 * so a caller cannot apply one without the other.
 */
export function nameStyleClass(style: NameStyle | null | undefined): string | undefined {
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
