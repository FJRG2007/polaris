/**
 * How somebody has decided their profile should look.
 *
 * Five decisions, and none of them is a picture: a background for the band when
 * there is no banner over it, something worn around the face, a plate behind the
 * name, colours across the name itself, and a treatment on the card. They are
 * catalogue choices rather than uploads on purpose. A decoration somebody
 * uploads is an image served next to every face in the product - which is a
 * moderation queue, a storage bill and a way to put anything at all beside your
 * name in a list of colleagues. A catalogue is none of those, and it is the
 * reason this can simply be on for everybody instead of being sold.
 *
 * Everything in the catalogues is drawn from parameters - colours, an angle, a
 * width - rather than named art. So there is no asset to fetch, nothing to go
 * missing behind a proxy, and a new entry is a line in a list here rather than a
 * file, a licence and a size budget. It also means the renderer is one small
 * piece of code for all of them instead of a switch that grows by one arm per
 * entry.
 *
 * All of it is data and pure functions: the parsing of what was stored, the
 * checking of a colour, the CSS a choice turns into. What the browser does with
 * that is a component's business.
 */

/** A flat colour behind a profile, or two of them and an angle. */
export type BannerFill =
    | { readonly kind: "solid"; readonly color: string }
    | { readonly kind: "gradient"; readonly angle: number; readonly from: string; readonly to: string };

/** The whole of somebody's appearance, after checking. Every field is null for
 *  an account that has never opened the panel, which is almost all of them. */
export interface ProfileStyle {
    readonly banner: BannerFill | null;
    readonly decoration: string | null;
    readonly nameplate: string | null;
    readonly effect: string | null;
    readonly nameStyle: string | null;
}

export const NO_PROFILE_STYLE: ProfileStyle = {
    banner: null,
    decoration: null,
    nameplate: null,
    effect: null,
    nameStyle: null
};

/** Six hex digits with a hash. Three-digit shorthand, names and `rgb()` are all
 *  refused rather than converted: one stored spelling is what keeps a colour
 *  comparable, and every picker in the panel emits this one. */
const HEX = /^#[0-9a-f]{6}$/;

/** A colour as it will be stored, or null for anything that is not one. */
export function readHex(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const hex = value.trim().toLowerCase();
    return HEX.test(hex) ? hex : null;
}

/** An angle in degrees, wrapped into a turn. A gradient at 400 degrees is a
 *  gradient at 40, and refusing it would be refusing arithmetic. */
export function readAngle(value: unknown): number {
    const angle = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(angle)) return 135;
    return ((Math.round(angle) % 360) + 360) % 360;
}

/**
 * What was stored, as a fill.
 *
 * The stored form is a short tagged string - `solid:#1b6ac9`, or
 * `gradient:135:#1b6ac9:#8b3ad6` - rather than four columns. It is one value
 * that is only ever read and written whole, and the day a third kind of
 * background exists it is an arm here rather than a migration on a table every
 * account has a row in.
 *
 * Anything that does not parse is no fill at all: a profile falls back to the
 * colour taken from its own face, which is a good answer and never a wrong one.
 */
export function readFill(value: unknown): BannerFill | null {
    if (typeof value !== "string") return null;
    const parts = value.trim().split(":");
    if (parts[0] === "solid") {
        const color = readHex(parts[1]);
        return color ? { kind: "solid", color } : null;
    }
    if (parts[0] === "gradient") {
        const from = readHex(parts[2]);
        const to = readHex(parts[3]);
        if (!from || !to) return null;
        return { kind: "gradient", angle: readAngle(parts[1]), from, to };
    }
    return null;
}

export function writeFill(fill: BannerFill | null): string | null {
    if (!fill) return null;
    if (fill.kind === "solid") return `solid:${fill.color}`;
    return `gradient:${fill.angle}:${fill.from}:${fill.to}`;
}

/** The fill as CSS. A solid colour is still written as a gradient of itself so
 *  that whatever draws it has one property to set, and swapping between the two
 *  does not swap between `background-color` and `background-image`. */
export function fillCss(fill: BannerFill): string {
    if (fill.kind === "solid") return `linear-gradient(${fill.color}, ${fill.color})`;
    return `linear-gradient(${fill.angle}deg, ${fill.from} 0%, ${fill.to} 100%)`;
}

/**
 * One painted layer of a decoration.
 *
 * A decoration is a small stack of these rather than a single band of colour,
 * which is the whole difference between a ring and something worth choosing: a
 * quiet track with one bright bead running round it, a dashed edge turning under
 * a still one, four points of light that come and go. Three families cover all
 * of it - a circle, a piece of a circle, and a handful of glyphs spaced around
 * one - so the renderer stays one small piece of code instead of a switch that
 * grows an arm per entry, and a new decoration is a line in a list here.
 *
 * Every distance is a fraction of the face's width, never a length: the same
 * decoration is drawn at 20 pixels beside a message and at 72 on a card, and a
 * geometry in pixels would be a different ornament at each of them. `at` is the
 * radius the layer is drawn on, measured from the middle of the face, so 0.5 is
 * its outer edge.
 *
 * `spin`, `twinkle` and `pulse` are the seconds one whole cycle takes, and every
 * cycle ends exactly where it began - a turn is a full turn, a twinkle comes
 * back to the opacity it started at. An animation that visibly finishes and
 * starts again reads as a fault rather than as an ornament, which is the one
 * thing an ornament may not do. `spin` is signed, and negative turns the other
 * way: two rings turning opposite ways is what makes them read as two rings.
 *
 * Everything that moves is behind `prefers-reduced-motion` where it is drawn - a
 * decoration is exactly the kind of ornament somebody turns animation off to be
 * rid of.
 */
/**
 * One mark in a drawn decoration.
 *
 * Shapes rather than only path data, because most of what a drawing is made of
 * is circles and ellipses and writing those as arcs is how a cat ends up with
 * one ear. Coordinates are in the same 100-unit box everything else is drawn in,
 * so a mark is placed once and is the same ornament at 20 pixels in a list and
 * at 96 on a card.
 */
export type ArtMark = { readonly fill?: string; readonly stroke?: string; readonly width?: number; readonly opacity?: number } & (
    | { readonly shape: "path"; readonly d: string }
    | { readonly shape: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
    | {
          readonly shape: "ellipse";
          readonly cx: number;
          readonly cy: number;
          readonly rx: number;
          readonly ry: number;
          /** Degrees, clockwise, about its own centre. */
          readonly rotate?: number;
      }
);

export type DecorationLayer =
    | {
          readonly kind: "ring";
          readonly at: number;
          readonly thickness: number;
          /** One colour for a flat ring, two for a gradient across it. */
          readonly colors: readonly string[];
          readonly opacity?: number;
          /** How long a painted piece is and how long the gap after it, in the
           *  same fractions of the face. A dashed ring reads as machined where a
           *  solid one reads as a border. */
          readonly dash?: readonly [number, number];
          readonly spin?: number;
          readonly pulse?: number;
      }
    | {
          readonly kind: "arc";
          readonly at: number;
          readonly thickness: number;
          readonly colors: readonly string[];
          /** How much of the circle it covers, in degrees, and where it starts -
           *  zero being the top. */
          readonly sweep: number;
          readonly start?: number;
          readonly opacity?: number;
          readonly spin?: number;
      }
    | {
          readonly kind: "art";
          /**
           * The corner and size of what is drawn, as fractions of the face.
           *
           * Declared rather than measured: path data cannot be asked how big it
           * is without a browser, and the one thing every decoration has to
           * promise - that it never grows the layout - has to be checkable in a
           * test. So the author states the box and `layerReach` believes them,
           * and a drawing that wandered outside it is a drawing that was clipped
           * rather than one that pushed a row apart.
           */
          readonly bounds: readonly [number, number, number, number];
          readonly marks: readonly ArtMark[];
          /**
           * Drawn over the face rather than behind it.
           *
           * The one exception to "a decoration paints in the band". A cat asleep
           * on somebody's head is on their head: it rests on the rim and a paw
           * hangs over it, and drawn behind the photograph it is a pair of ears
           * with no cat. Covering a corner of your own picture is the whole
           * point of wearing one, which is not true of a ring.
           */
          readonly front?: boolean;
          readonly opacity?: number;
          /**
           * Seconds, and only while somebody is pointing at the face.
           *
           * A drawing that moves on its own is a drawing that moves in thirty
           * places at once on a busy screen, which is a fidgeting list rather
           * than an ornament. Waking when it is looked at is the whole charm and
           * costs nothing when nobody is.
           */
          readonly wake?: number;
          readonly motion?: "sway" | "bob";
      }
    | {
          readonly kind: "orbit";
          readonly shape: "dot" | "star" | "petal";
          readonly at: number;
          /** How wide one glyph is, as a fraction of the face. */
          readonly size: number;
          readonly count: number;
          /** Taken in turn, so two colours alternate around the circle. */
          readonly colors: readonly string[];
          readonly opacity?: number;
          readonly spin?: number;
          readonly twinkle?: number;
      };

/**
 * Something worn around a face.
 *
 * `width` is the band the decoration is given on every side, and it is the only
 * field the rest of the product reads: the picture is drawn inward by that much
 * so a decoration never grows the face, never changes a layout, and is never cut
 * in half by a scrolling panel. What somebody gives up for one is a couple of
 * pixels of their own photograph.
 */
export interface AvatarDecoration {
    readonly id: string;
    readonly label: string;
    /** How much of the face's width the decoration takes on each side, as a
     *  fraction. Small: this sits around faces drawn at 20 pixels in a list as
     *  well as at 72 on a card. */
    readonly width: number;
    readonly layers: readonly DecorationLayer[];
    readonly glow?: string;
}

/**
 * The gallery.
 *
 * Every one of them is free and every one is available to everybody. That is the
 * point of a catalogue drawn from parameters: it costs nothing to give away, so
 * there is nothing here to buy, earn or unlock.
 *
 * The seven ids at the top are the ones profiles already hold, so they keep
 * their names and are only drawn better. An id withdrawn from this list stops
 * being drawn everywhere at once - see `readProfileStyle`.
 */
export const AVATAR_DECORATIONS: readonly AvatarDecoration[] = [
    {
        id: "aurora",
        label: "Aurora",
        width: 0.09,
        glow: "#5b8def",
        layers: [
            { kind: "ring", at: 0.45, thickness: 0.035, colors: ["#3fd0c9", "#a06bff"], opacity: 0.5 },
            {
                kind: "arc",
                at: 0.45,
                thickness: 0.045,
                colors: ["#5b8def", "#a06bff"],
                sweep: 110,
                spin: 6
            }
        ]
    },
    {
        id: "ember",
        label: "Ember",
        width: 0.09,
        glow: "#ff7043",
        layers: [
            {
                kind: "ring",
                at: 0.45,
                thickness: 0.05,
                colors: ["#ff9a3c", "#ff5a5f"],
                dash: [0.07, 0.05],
                spin: 12
            },
            {
                kind: "orbit",
                shape: "star",
                at: 0.455,
                size: 0.05,
                count: 3,
                colors: ["#ffcc66"],
                twinkle: 3
            }
        ]
    },
    {
        id: "frost",
        label: "Frost",
        width: 0.075,
        glow: "#8fd8ff",
        layers: [
            { kind: "ring", at: 0.475, thickness: 0.018, colors: ["#c7ecff"], opacity: 0.8 },
            { kind: "ring", at: 0.44, thickness: 0.03, colors: ["#8fd8ff", "#c7ecff"] }
        ]
    },
    {
        id: "gold",
        label: "Gold",
        width: 0.08,
        layers: [
            { kind: "ring", at: 0.482, thickness: 0.014, colors: ["#f4dc9a"], opacity: 0.85 },
            { kind: "ring", at: 0.445, thickness: 0.036, colors: ["#e8c26a", "#b8862b"] },
            {
                kind: "orbit",
                shape: "dot",
                at: 0.463,
                size: 0.022,
                count: 8,
                colors: ["#f4dc9a"],
                opacity: 0.9
            }
        ]
    },
    {
        id: "moss",
        label: "Moss",
        width: 0.09,
        layers: [
            { kind: "ring", at: 0.443, thickness: 0.026, colors: ["#3f8f5b", "#7bc47f"] },
            {
                kind: "orbit",
                shape: "petal",
                at: 0.468,
                size: 0.055,
                count: 10,
                colors: ["#7bc47f", "#3f8f5b"]
            }
        ]
    },
    {
        id: "rose",
        label: "Rose",
        width: 0.08,
        glow: "#ff7fb2",
        layers: [
            { kind: "ring", at: 0.448, thickness: 0.03, colors: ["#ff9ec4", "#d94f8a"] },
            {
                kind: "orbit",
                shape: "dot",
                at: 0.476,
                size: 0.028,
                count: 6,
                colors: ["#ffc0d8"],
                spin: 18
            }
        ]
    },
    {
        id: "ink",
        label: "Ink",
        width: 0.075,
        layers: [
            { kind: "ring", at: 0.472, thickness: 0.022, colors: ["#4a4f5a"] },
            { kind: "ring", at: 0.442, thickness: 0.024, colors: ["#20242c"] }
        ]
    },
    {
        id: "orbit",
        label: "Orbit",
        width: 0.07,
        glow: "#5b8def",
        layers: [
            { kind: "ring", at: 0.465, thickness: 0.012, colors: ["#5b8def"], opacity: 0.4 },
            {
                kind: "orbit",
                shape: "dot",
                at: 0.465,
                size: 0.05,
                count: 1,
                colors: ["#8fd8ff"],
                spin: 5
            }
        ]
    },
    {
        id: "pulse",
        label: "Pulse",
        width: 0.08,
        layers: [
            { kind: "ring", at: 0.452, thickness: 0.03, colors: ["#3fd0c9", "#134e5e"] },
            {
                kind: "ring",
                at: 0.484,
                thickness: 0.014,
                colors: ["#3fd0c9"],
                opacity: 0.7,
                pulse: 3.2
            }
        ]
    },
    {
        id: "circuit",
        label: "Circuit",
        width: 0.085,
        layers: [
            {
                kind: "ring",
                at: 0.478,
                thickness: 0.014,
                colors: ["#3fd0c9"],
                dash: [0.03, 0.03],
                opacity: 0.75,
                spin: 20
            },
            {
                kind: "ring",
                at: 0.443,
                thickness: 0.028,
                colors: ["#134e5e", "#3fd0c9"],
                dash: [0.1, 0.04],
                spin: -14
            }
        ]
    },
    {
        id: "nova",
        label: "Nova",
        width: 0.09,
        glow: "#a06bff",
        layers: [
            {
                kind: "ring",
                at: 0.448,
                thickness: 0.028,
                colors: ["#a06bff", "#ff9ec4"],
                opacity: 0.75
            },
            {
                kind: "orbit",
                shape: "star",
                at: 0.47,
                size: 0.06,
                count: 4,
                colors: ["#ffffff", "#ffc0d8"],
                twinkle: 2.4
            }
        ]
    },
    {
        id: "bloom",
        label: "Bloom",
        width: 0.095,
        layers: [
            { kind: "ring", at: 0.428, thickness: 0.02, colors: ["#d94f8a"], opacity: 0.8 },
            {
                kind: "orbit",
                shape: "petal",
                at: 0.462,
                size: 0.06,
                count: 8,
                colors: ["#ff9ec4", "#a06bff"],
                spin: 30
            }
        ]
    },
    {
        id: "eclipse",
        label: "Eclipse",
        width: 0.08,
        layers: [
            { kind: "ring", at: 0.465, thickness: 0.016, colors: ["#4d5561"], opacity: 0.6 },
            {
                kind: "arc",
                at: 0.465,
                thickness: 0.048,
                colors: ["#e8c26a", "#b8862b"],
                sweep: 220,
                start: 200
            }
        ]
    },
    {
        id: "tide",
        label: "Tide",
        width: 0.09,
        glow: "#3c8ce7",
        layers: [
            {
                kind: "arc",
                at: 0.468,
                thickness: 0.028,
                colors: ["#8fd8ff", "#3c8ce7"],
                sweep: 140,
                spin: 8
            },
            {
                kind: "arc",
                at: 0.432,
                thickness: 0.028,
                colors: ["#3c8ce7", "#134e5e"],
                sweep: 140,
                start: 180,
                spin: -8
            }
        ]
    },

    // ---------------------------------------------------------------------
    // Worn
    //
    // Not rings. A thing sitting on somebody's head, which is a different kind
    // of ornament and needed a different kind of layer - see `art`. They are
    // drawn here as shapes and coordinates for the same reason the rings are
    // parameters: there is no file to fetch, nothing to go missing behind a
    // proxy, nothing to license, and adding one is a line in a list.
    //
    // They stir only under a pointer. Thirty faces in a list all fidgeting on
    // their own is a list nobody can read down; the same thirty waking one at a
    // time as somebody moves across them is the charm.
    // ---------------------------------------------------------------------
    {
        id: "cat",
        label: "Cat",
        width: 0.1,
        layers: [
            {
                kind: "art",
                // Sits on the rim and hangs over it, which is why it is drawn in
                // front. Behind the photograph this is two ears and no cat.
                bounds: [0.27, 0.06, 0.46, 0.26],
                front: true,
                wake: 2.4,
                motion: "sway",
                marks: [
                    // The tail first, so the body sits over where it joins.
                    {
                        shape: "path",
                        d: "M 35 30 C 28 30 28 21 33 19",
                        stroke: "#e8934a",
                        width: 3.4
                    },
                    { shape: "ellipse", cx: 47, cy: 25, rx: 13, ry: 7, fill: "#f2a25c" },
                    // Ears before the head, so their bases are covered by it and
                    // they read as growing out of it rather than stuck on.
                    { shape: "path", d: "M 56 17 L 57 8.5 L 63.5 14 Z", fill: "#f2a25c" },
                    { shape: "path", d: "M 66 13 L 71.5 8 L 71.5 16.5 Z", fill: "#f2a25c" },
                    { shape: "path", d: "M 57.6 15 L 58.2 11 L 61.6 14 Z", fill: "#f6bda6" },
                    { shape: "path", d: "M 67.4 13.4 L 70.2 10.6 L 70.2 15.2 Z", fill: "#f6bda6" },
                    { shape: "circle", cx: 62, cy: 22, r: 8, fill: "#f2a25c" },
                    // Asleep: two closed curves rather than two dots, which is
                    // the whole difference between a sleeping cat and a staring
                    // one.
                    {
                        shape: "path",
                        d: "M 57.6 22.4 q 2 2.2 4 0",
                        stroke: "#5a3a22",
                        width: 1.1
                    },
                    {
                        shape: "path",
                        d: "M 63.4 22.4 q 2 2.2 4 0",
                        stroke: "#5a3a22",
                        width: 1.1
                    },
                    { shape: "path", d: "M 61 25.6 L 63.4 25.6 L 62.2 27 Z", fill: "#d1705a" }
                ]
            }
        ],
        glow: "#f2a25c"
    },
    {
        id: "wings",
        label: "Wings",
        width: 0.1,
        layers: [
            {
                kind: "art",
                bounds: [0.1, 0.2, 0.8, 0.34],
                front: true,
                opacity: 0.94,
                wake: 3.2,
                motion: "bob",
                marks: [
                    {
                        shape: "path",
                        d: "M 40 26 C 26 24 14 32 12 44 C 20 40 26 42 30 46 C 30 38 34 30 40 26 Z",
                        fill: "#eef3ff",
                        stroke: "#c3d0ea",
                        width: 1
                    },
                    {
                        shape: "path",
                        d: "M 60 26 C 74 24 86 32 88 44 C 80 40 74 42 70 46 C 70 38 66 30 60 26 Z",
                        fill: "#eef3ff",
                        stroke: "#c3d0ea",
                        width: 1
                    },
                    // The feather lines. Three each, because the shape reads as a
                    // wing only once something inside it runs the way feathers do.
                    { shape: "path", d: "M 36 30 C 28 32 22 38 19 44", stroke: "#c3d0ea", width: 0.8 },
                    { shape: "path", d: "M 34 35 C 28 37 24 41 22 46", stroke: "#c3d0ea", width: 0.8 },
                    { shape: "path", d: "M 64 30 C 72 32 78 38 81 44", stroke: "#c3d0ea", width: 0.8 },
                    { shape: "path", d: "M 66 35 C 72 37 76 41 78 46", stroke: "#c3d0ea", width: 0.8 }
                ]
            }
        ],
        glow: "#dbe6ff"
    },
    {
        id: "party",
        label: "Party hat",
        width: 0.1,
        layers: [
            {
                kind: "art",
                bounds: [0.34, 0.05, 0.32, 0.22],
                front: true,
                wake: 1.8,
                motion: "bob",
                marks: [
                    { shape: "path", d: "M 50 6.5 L 60 24 L 40 24 Z", fill: "#5b8def" },
                    // Two stripes rather than a pattern: at twenty pixels a
                    // pattern is a texture, and a texture on a cone is a smudge.
                    { shape: "path", d: "M 46.2 13 L 53.8 13 L 55.6 16 L 44.4 16 Z", fill: "#f6c445" },
                    { shape: "ellipse", cx: 50, cy: 24, rx: 10.6, ry: 2.6, fill: "#3f6fd0" },
                    { shape: "circle", cx: 50, cy: 6.2, r: 3, fill: "#f6c445" }
                ]
            }
        ],
        glow: "#5b8def"
    }
];

/**
 * How far out and how far in a layer reaches, as fractions of the face's width.
 *
 * The one thing a decoration must not do is escape the band reserved for it: a
 * ring wider than its `width` covers the picture, and one wider than half the
 * face is drawn outside the box the layout gave it and is cut in half by the
 * first panel it scrolls inside. Written out here so the catalogue can be
 * checked rather than eyeballed - see the test beside this file.
 */
export function layerReach(layer: DecorationLayer): { readonly outer: number; readonly inner: number } {
    // A drawing is a box rather than a radius, so its reach is how far its
    // corners are from the middle. The near corner can be well inside the band -
    // that is what `front` is for - and the far one is what must not leave the
    // square.
    if (layer.kind === "art") {
        const [x, y, width, height] = layer.bounds;
        const corners = [
            [x, y],
            [x + width, y],
            [x, y + height],
            [x + width, y + height]
        ];
        const spans = corners.map(([px = 0, py = 0]) => Math.hypot(px - 0.5, py - 0.5));
        return { outer: Math.max(...spans), inner: Math.min(...spans) };
    }
    const half = layer.kind === "orbit" ? layer.size / 2 : layer.thickness / 2;
    return { outer: layer.at + half, inner: layer.at - half };
}

/**
 * A dash pattern stretched so a whole number of them goes round the circle.
 *
 * A dashed ring is drawn from one point and painted round; if the pattern does
 * not divide the circumference, the last dash meets the first as a stub, and
 * that seam is the one place on the ring the eye lands. Worse on a ring that
 * turns, where the flaw is carried round and round in front of the reader.
 *
 * So the pattern is nudged rather than the ring: the closest whole number of
 * repeats is chosen and the dash and the gap are scaled to fit it exactly. The
 * dash asked for in the catalogue is what it looks like, not what it measures.
 */
export function fittedDash(
    dash: readonly [number, number],
    radius: number
): readonly [number, number] {
    const circumference = 2 * Math.PI * radius;
    const pattern = dash[0] + dash[1];
    if (pattern <= 0 || circumference <= 0) return dash;
    const repeats = Math.max(1, Math.round(circumference / pattern));
    const scale = circumference / (repeats * pattern);
    return [dash[0] * scale, dash[1] * scale];
}

/** Every colour a decoration paints with, so they can all be checked at once. */
export function decorationColors(decoration: AvatarDecoration): readonly string[] {
    const colors = decoration.layers.flatMap((layer) =>
        layer.kind === "art"
            ? layer.marks.flatMap((mark) => [mark.fill, mark.stroke].filter((c): c is string => !!c))
            : [...layer.colors]
    );
    return decoration.glow ? [...colors, decoration.glow] : colors;
}

/** Whether anything in a decoration moves. What the picker says out loud, so
 *  somebody who does not want movement can pick without trying each one. */
export function decorationMoves(decoration: AvatarDecoration): boolean {
    return decoration.layers.some(
        (layer) =>
            ("spin" in layer && layer.spin !== undefined) ||
            ("twinkle" in layer && layer.twinkle !== undefined) ||
            ("pulse" in layer && layer.pulse !== undefined) ||
            // Counted, even though it only stirs under a pointer. Somebody who
            // turns movement off is telling the product they do not want to be
            // surprised by it, and "only when you touch it" is still a surprise.
            ("wake" in layer && layer.wake !== undefined)
    );
}

/**
 * Where the glyphs of an orbit sit, as offsets from the middle of the face in
 * fractions of its width.
 *
 * From the top and clockwise, because that is where the eye starts and a single
 * bead parked at three o'clock looks like a mistake. Fractions rather than
 * coordinates so whatever draws them owns its own units.
 */
export function orbitPoints(
    count: number,
    at: number
): readonly { readonly x: number; readonly y: number }[] {
    const points: { x: number; y: number }[] = [];
    for (let index = 0; index < count; index += 1) {
        const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
        points.push({ x: at * Math.cos(angle), y: at * Math.sin(angle) });
    }
    return points;
}

/**
 * The plate a name is drawn on in a list.
 *
 * Two colours and an angle, plus whether the text on it wants to be dark - which
 * is a decision rather than a calculation, because contrast against a gradient
 * depends on where the letters land on it.
 */
export interface Nameplate {
    readonly id: string;
    readonly label: string;
    readonly from: string;
    readonly to: string;
    readonly angle: number;
    readonly dark?: boolean;
}

export const NAMEPLATES: readonly Nameplate[] = [
    { id: "dusk", label: "Dusk", from: "#3b2f63", to: "#7b4397", angle: 100 },
    { id: "tide", label: "Tide", from: "#134e5e", to: "#3c8ce7", angle: 100 },
    { id: "ember", label: "Ember", from: "#7a2d1f", to: "#e0642c", angle: 100 },
    { id: "moss", label: "Moss", from: "#1d4b31", to: "#5aa469", angle: 100 },
    { id: "slate", label: "Slate", from: "#2b2f36", to: "#4d5561", angle: 100 },
    { id: "gold", label: "Gold", from: "#b8862b", to: "#f4dc9a", angle: 100, dark: true },
    { id: "rose", label: "Rose", from: "#8c2f52", to: "#ff9ec4", angle: 100 }
];

/**
 * What is done to the card itself.
 *
 * Discord keeps effects and frames apart. Here they are one choice, because they
 * are one question - what this card does that a plain one does not - and two
 * separate pickers would let somebody pick a combination that fights itself
 * without ever having been asked to look at the two together.
 *
 * `sheen` is a slow band of light across the top; `frame` is a coloured edge on
 * the card. An entry may carry either or both.
 */
export interface ProfileEffect {
    readonly id: string;
    readonly label: string;
    readonly sheen?: string;
    readonly frame?: { readonly from: string; readonly to: string };
}

export const PROFILE_EFFECTS: readonly ProfileEffect[] = [
    { id: "sheen", label: "Sheen", sheen: "#ffffff" },
    { id: "halo", label: "Halo", sheen: "#a06bff", frame: { from: "#a06bff", to: "#5b8def" } },
    { id: "gilded", label: "Gilded", frame: { from: "#e8c26a", to: "#b8862b" } },
    { id: "current", label: "Current", sheen: "#3fd0c9", frame: { from: "#3fd0c9", to: "#134e5e" } },
    { id: "coal", label: "Coal", frame: { from: "#4d5561", to: "#20242c" } }
];

/**
 * How the display name is painted.
 *
 * A name is the one piece of somebody's profile that appears in a hundred places
 * they do not control, so the catalogue here is deliberately quiet: two colours
 * across the letters, at most. Nothing here changes the weight, the size or the
 * face - a name that is bigger than everybody else's in a list is not
 * personalisation, it is a fight over a column.
 */
export interface NameStyle {
    readonly id: string;
    readonly label: string;
    /** The stops, in order. Two for a still name; three or more for one that
     *  moves, and then the last has to be the first again - see `moving`. */
    readonly colors: readonly string[];
    /**
     * Whether the colours walk across the letters.
     *
     * The walk is one tile of the gradient per cycle, so the frame it ends on is
     * the frame it started from and there is no moment where it snaps back. That
     * only holds while the last colour equals the first, which is why the two
     * live together and why the test beside this file checks it: a moving name
     * that jumps is a name that looks broken several times a minute, in every
     * list its owner appears in.
     */
    readonly moving?: boolean;
}

export const NAME_STYLES: readonly NameStyle[] = [
    { id: "aurora", label: "Aurora", colors: ["#3fd0c9", "#a06bff"] },
    { id: "ember", label: "Ember", colors: ["#ffcc66", "#ff5a5f"] },
    { id: "tide", label: "Tide", colors: ["#8fd8ff", "#3c8ce7"] },
    { id: "moss", label: "Moss", colors: ["#a8e06b", "#3f8f5b"] },
    { id: "gold", label: "Gold", colors: ["#f4dc9a", "#c99a2e"] },
    { id: "rose", label: "Rose", colors: ["#ffc0d8", "#d94f8a"] },
    {
        id: "flow",
        label: "Flow",
        colors: ["#3fd0c9", "#5b8def", "#a06bff", "#3fd0c9"],
        moving: true
    },
    {
        id: "blaze",
        label: "Blaze",
        colors: ["#ffcc66", "#ff5a5f", "#ff9a3c", "#ffcc66"],
        moving: true
    },
    {
        id: "prism",
        label: "Prism",
        colors: ["#8fd8ff", "#a06bff", "#ff9ec4", "#8fd8ff"],
        moving: true
    },
    {
        id: "shimmer",
        label: "Shimmer",
        colors: ["#f4dc9a", "#c99a2e", "#fff3cf", "#f4dc9a"],
        moving: true
    }
];

function pick<T extends { readonly id: string }>(catalogue: readonly T[], id: unknown): T | null {
    if (typeof id !== "string") return null;
    return catalogue.find((entry) => entry.id === id) ?? null;
}

export function decorationOf(id: unknown): AvatarDecoration | null {
    return pick(AVATAR_DECORATIONS, id);
}

export function nameplateOf(id: unknown): Nameplate | null {
    return pick(NAMEPLATES, id);
}

export function effectOf(id: unknown): ProfileEffect | null {
    return pick(PROFILE_EFFECTS, id);
}

export function nameStyleOf(id: unknown): NameStyle | null {
    return pick(NAME_STYLES, id);
}

/**
 * A stored row as a style, with every choice checked against the catalogue it
 * came from.
 *
 * An id that is no longer in a catalogue is dropped rather than kept: an entry
 * withdrawn - because it rendered badly, or because it was a mistake - has to
 * stop being drawn everywhere at once, and a row still naming it would otherwise
 * be a decoration nothing knows how to draw and something has to guess about.
 */
export function readProfileStyle(row: {
    readonly banner?: unknown;
    readonly decoration?: unknown;
    readonly nameplate?: unknown;
    readonly effect?: unknown;
    readonly nameStyle?: unknown;
} | null | undefined): ProfileStyle {
    if (!row) return NO_PROFILE_STYLE;
    return {
        banner: readFill(row.banner),
        decoration: decorationOf(row.decoration)?.id ?? null,
        nameplate: nameplateOf(row.nameplate)?.id ?? null,
        effect: effectOf(row.effect)?.id ?? null,
        nameStyle: nameStyleOf(row.nameStyle)?.id ?? null
    };
}

/** Whether a style says anything at all. A row of nulls is one more row and one
 *  more thing to send; nothing draws differently for it. */
export function styleIsPlain(style: ProfileStyle): boolean {
    return (
        style.banner === null &&
        style.decoration === null &&
        style.nameplate === null &&
        style.effect === null &&
        style.nameStyle === null
    );
}
