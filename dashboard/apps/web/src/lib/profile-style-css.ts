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
 * The ring behind a face.
 *
 * A conic gradient with the stops spread evenly around it, which covers both a
 * flat ring - the same colour given twice - and one that reads as turning. The
 * first stop is repeated at the end by the catalogue where that matters, so the
 * seam does not show.
 */
export function ringBackground(decoration: AvatarDecoration): string {
    const stops = decoration.colors.map((color, index, all) => {
        const at = all.length === 1 ? 100 : (index / (all.length - 1)) * 100;
        return `${color} ${Math.round(at)}%`;
    });
    return `conic-gradient(from 0deg, ${stops.join(", ")})`;
}

/**
 * How thick the ring is, in pixels, for a face of this size.
 *
 * A fraction of the face rather than a fixed width, so the same decoration reads
 * the same at 20 pixels in a list and at 72 on a card - and floored at one
 * device pixel, because a ring rounded down to nothing is a decoration somebody
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
 * A name painted in two colours.
 *
 * The gradient is clipped to the glyphs, which every browser Polaris supports
 * does through `background-clip: text`. `color: transparent` is what makes the
 * clip visible - and it is also what makes this the one style here with a
 * fallback worth thinking about: a browser that ignores the clip would draw an
 * invisible name, so the colour is set from the gradient's first stop first and
 * only then made transparent. A name is not a place to be clever.
 */
export function nameStyleCss(style: NameStyle): CSSProperties {
    return {
        color: style.from,
        backgroundImage: `linear-gradient(92deg, ${style.from} 0%, ${style.to} 100%)`,
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent"
    } as CSSProperties;
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

/** The band of light an effect walks across a card, or nothing when it is only
 *  a frame. */
export function sheenCss(effect: ProfileEffect): CSSProperties | null {
    if (!effect.sheen) return null;
    return {
        backgroundImage: `linear-gradient(100deg, transparent 0%, ${effect.sheen}00 20%, ${effect.sheen}38 50%, ${effect.sheen}00 80%, transparent 100%)`
    };
}
