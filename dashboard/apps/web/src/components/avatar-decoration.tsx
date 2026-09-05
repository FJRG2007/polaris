"use client";

/**
 * A decoration, drawn.
 *
 * The catalogue in `@polaris/core` is parameters - a radius, a thickness, a
 * count, a number of seconds - and this is the one place they become marks on a
 * screen. One component for every entry rather than a component per decoration:
 * the whole reason the catalogue is data is that a new decoration should be a
 * line in a list, not a new file, a licence and a size budget.
 *
 * It is SVG rather than a stack of gradients because the shapes are shapes. A
 * ring of beads, a piece of an arc with round ends, a dashed edge, four points
 * of light - those are two elements each here, and each of them was either
 * impossible or a pile of nested boxes as CSS. What it is NOT is a picture:
 * there is no file to fetch, nothing to go missing behind a proxy, and nothing
 * anybody can upload beside their name in a list of colleagues.
 *
 * Everything is drawn in a 100-unit box that the browser scales to whatever the
 * face is, so one decoration is the same ornament at 20 pixels beside a message
 * and at 96 on a profile card. Nothing is measured in pixels anywhere below.
 *
 * The band is the whole canvas. `Avatar` reserves `decoration.width` on each
 * side and draws the picture inside what is left, so the picture is never
 * covered and the face never grows - which is what keeps a decoration out of the
 * layout, and out of the way of the panel it is scrolling inside. Anything drawn
 * further in than that band is simply behind an opaque photograph.
 *
 * Movement is CSS classes with the pace applied inline from the catalogue, never
 * SMIL: `prefers-reduced-motion` is honoured for every animation in the product
 * by one rule in the design tokens, and an `<animateTransform>` would be the one
 * ornament in Polaris that ignored it.
 */

import { cn } from "@polaris/ui";
import { useId, type CSSProperties } from "react";
import {
    fittedDash,
    orbitPoints,
    type ArtMark,
    type AvatarDecoration,
    type DecorationLayer
} from "@polaris/core";

/** The box everything is drawn in. Half of it is the radius of the face. */
const BOX = 100;
const MIDDLE = BOX / 2;

/** A fraction of the face's width in the units of that box. */
function units(fraction: number): number {
    return fraction * BOX;
}

/** Rounded, so the markup does not carry seventeen digits of an irrational
 *  number for every point of every orbit. */
function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/** How a turning layer is paced: the catalogue's seconds, and its sign as a
 *  direction. Two rings turning opposite ways read as two rings; two turning the
 *  same way read as one that has been drawn twice. */
function turning(seconds: number | undefined) {
    if (seconds === undefined) return {};
    return {
        className: "profile-spin",
        style: {
            animationDuration: `${Math.abs(seconds)}s`,
            animationDirection: seconds < 0 ? ("reverse" as const) : ("normal" as const)
        }
    };
}

/** A point on the circle, from the top and clockwise, in box units. */
function onCircle(radius: number, degrees: number): { x: number; y: number } {
    const angle = ((degrees - 90) * Math.PI) / 180;
    return { x: MIDDLE + radius * Math.cos(angle), y: MIDDLE + radius * Math.sin(angle) };
}

/**
 * A four-pointed spark, centred on the origin.
 *
 * Drawn with curves pulled in towards the middle rather than as a diamond: a
 * star is the concavity between its points, and a polygon with straight edges
 * reads as a rotated square at every size a face is drawn at.
 */
function sparkPath(radius: number): string {
    const waist = round(radius * 0.16);
    const reach = round(radius);
    return [
        `M 0 ${-reach}`,
        `Q ${waist} ${-waist} ${reach} 0`,
        `Q ${waist} ${waist} 0 ${reach}`,
        `Q ${-waist} ${waist} ${-reach} 0`,
        `Q ${-waist} ${-waist} 0 ${-reach}`,
        "Z"
    ].join(" ");
}

/** One stroked layer's paint: a flat colour, or the gradient it was given. */
function paint(colors: readonly string[], gradientId: string): string {
    return colors.length > 1 ? `url(#${gradientId})` : (colors[0] ?? "#ffffff");
}

/** How a drawing is paced when somebody points at it. Idle otherwise: nothing
 *  here runs until the face is under a pointer, which is what keeps a list of
 *  thirty faces still. */
function waking(layer: Extract<DecorationLayer, { kind: "art" }>) {
    if (layer.wake === undefined) return {};
    return {
        className: layer.motion === "bob" ? "profile-wake-bob" : "profile-wake-sway",
        style: { animationDuration: `${layer.wake}s` }
    };
}

function Mark({ mark }: { mark: ArtMark }) {
    // Strokes are round everywhere: a tail cut square is a tail that was
    // snapped off, and every line in a drawing this small is a limb or a
    // feather rather than a rule.
    const paints = {
        fill: mark.fill ?? "none",
        stroke: mark.stroke,
        strokeWidth: mark.width,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
        opacity: mark.opacity
    };
    if (mark.shape === "circle") {
        return <circle cx={mark.cx} cy={mark.cy} r={mark.r} {...paints} />;
    }
    if (mark.shape === "ellipse") {
        return (
            <ellipse
                cx={mark.cx}
                cy={mark.cy}
                rx={mark.rx}
                ry={mark.ry}
                transform={
                    mark.rotate === undefined
                        ? undefined
                        : `rotate(${mark.rotate} ${mark.cx} ${mark.cy})`
                }
                {...paints}
            />
        );
    }
    return <path d={mark.d} {...paints} />;
}

function Layer({ layer, gradientId }: { layer: DecorationLayer; gradientId: string }) {
    if (layer.kind === "art") {
        const wake = waking(layer);
        return (
            <g
                opacity={layer.opacity}
                className={wake.className}
                style={{
                    ...wake.style,
                    // Turned about the middle of what is drawn rather than the
                    // middle of the box, so a tail sways from where it joins and
                    // a hat tips on its own point.
                    transformOrigin: `${round(units(layer.bounds[0] + layer.bounds[2] / 2))}px ${round(units(layer.bounds[1] + layer.bounds[3]))}px`
                }}
            >
                {layer.marks.map((mark, index) => (
                    <Mark key={index} mark={mark} />
                ))}
            </g>
        );
    }

    if (layer.kind === "orbit") {
        const radius = units(layer.size) / 2;
        const spark = layer.shape === "star" ? sparkPath(radius) : null;
        return (
            <g {...turning(layer.spin)} opacity={layer.opacity}>
                {orbitPoints(layer.count, layer.at).map((point, index) => {
                    const x = round(MIDDLE + units(point.x));
                    const y = round(MIDDLE + units(point.y));
                    const color = layer.colors[index % layer.colors.length] ?? "#ffffff";
                    // Staggered, so a row of lights breathes rather than
                    // blinking in unison like an alarm.
                    const twinkle =
                        layer.twinkle === undefined
                            ? {}
                            : {
                                  className: "profile-twinkle",
                                  style: {
                                      animationDuration: `${layer.twinkle}s`,
                                      animationDelay: `${round((index / Math.max(1, layer.count)) * layer.twinkle)}s`
                                  }
                              };
                    if (spark) {
                        return (
                            <path
                                key={index}
                                d={spark}
                                fill={color}
                                transform={`translate(${x} ${y})`}
                                {...twinkle}
                            />
                        );
                    }
                    if (layer.shape === "petal") {
                        // Pointed outward: a petal lying across the ring reads as
                        // a smudge, and which way it lies is the whole shape.
                        const away = round((Math.atan2(point.y, point.x) * 180) / Math.PI + 90);
                        return (
                            <ellipse
                                key={index}
                                cx={x}
                                cy={y}
                                rx={round(radius * 0.55)}
                                ry={radius}
                                fill={color}
                                transform={`rotate(${away} ${x} ${y})`}
                                {...twinkle}
                            />
                        );
                    }
                    return <circle key={index} cx={x} cy={y} r={radius} fill={color} {...twinkle} />;
                })}
            </g>
        );
    }

    const radius = units(layer.at);
    const thickness = units(layer.thickness);
    const stroke = paint(layer.colors, gradientId);

    if (layer.kind === "arc") {
        const start = layer.start ?? 0;
        const from = onCircle(radius, start);
        const to = onCircle(radius, start + layer.sweep);
        return (
            <path
                d={`M ${round(from.x)} ${round(from.y)} A ${round(radius)} ${round(radius)} 0 ${layer.sweep > 180 ? 1 : 0} 1 ${round(to.x)} ${round(to.y)}`}
                fill="none"
                stroke={stroke}
                strokeWidth={round(thickness)}
                // Round ends, because an arc cut square looks broken off rather
                // than drawn.
                strokeLinecap="round"
                opacity={layer.opacity}
                {...turning(layer.spin)}
            />
        );
    }

    const dash = layer.dash ? fittedDash(layer.dash, layer.at) : null;
    return (
        <circle
            cx={MIDDLE}
            cy={MIDDLE}
            r={round(radius)}
            fill="none"
            stroke={stroke}
            strokeWidth={round(thickness)}
            // Flat ends, so the painted length is the length `fittedDash`
            // measured: round caps add half the stroke width at each end, which
            // is enough to close the gaps on a fine ring.
            strokeDasharray={dash ? `${round(units(dash[0]))} ${round(units(dash[1]))}` : undefined}
            opacity={layer.opacity}
            {...(layer.pulse === undefined
                ? turning(layer.spin)
                : {
                      className: "profile-pulse",
                      style: { animationDuration: `${layer.pulse}s` }
                  })}
        />
    );
}

/**
 * What somebody chose, over the band around their face.
 *
 * Sits behind the picture in the stacking order, so the only part of it that
 * shows is what falls in the band. Nothing here is announced or pressable: it is
 * ornament on a face that already carries the person's name.
 */
export function AvatarDecorationArt({
    decoration,
    front = false,
    className,
    style
}: {
    decoration: AvatarDecoration;
    /**
     * Which half to draw.
     *
     * Almost everything goes behind the picture, where only the band shows - a
     * ring is a ring precisely because the face covers its middle. A worn thing
     * is the other case: it rests on the rim and hangs over it, so it is drawn
     * again on top. Two passes rather than one because there is a photograph in
     * between them, and SVG cannot be interleaved with something that is not in
     * the same document.
     */
    front?: boolean;
    className?: string;
    style?: CSSProperties;
}) {
    // Gradient ids are document-wide, and a busy screen draws thirty faces. A
    // per-instance prefix is what stops the second avatar's ring being painted
    // with the first one's colours.
    // React's own ids carry colons, and a colon in a fragment identifier is a
    // reference some browsers decline to resolve. Dropped rather than escaped.
    const seed = useId().replace(/:/g, "");
    const layers = decoration.layers
        .map((layer, index) => ({ layer, index }))
        .filter(({ layer }) => (layer.kind === "art" && layer.front === true) === front);
    // A pass with nothing in it draws no element at all: most decorations have
    // no front half, and an empty overlay on every face in a list is thirty
    // nodes for nothing.
    if (layers.length === 0) return null;
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            viewBox={`0 0 ${BOX} ${BOX}`}
            className={cn("pointer-events-none absolute inset-0 size-full", className)}
            style={style}
        >
            <defs>
                {layers.map(({ layer, index }) =>
                    layer.kind !== "art" && layer.colors.length > 1 ? (
                        <linearGradient key={index} id={`${seed}-${index}`} x1="0" y1="0" x2="1" y2="1">
                            {layer.colors.map((color, stop, all) => (
                                <stop
                                    key={stop}
                                    offset={`${Math.round((stop / (all.length - 1)) * 100)}%`}
                                    stopColor={color}
                                />
                            ))}
                        </linearGradient>
                    ) : null
                )}
            </defs>
            {layers.map(({ layer, index }) => (
                <Layer key={index} layer={layer} gradientId={`${seed}-${index}`} />
            ))}
        </svg>
    );
}
