/**
 * How somebody has decided their profile should look.
 *
 * Four decisions, and none of them is a picture: a background for the band when
 * there is no banner over it, a ring around the face, a plate behind the name,
 * and a treatment on the card itself. They are catalogue choices rather than
 * uploads on purpose. A decoration somebody uploads is an image served next to
 * every face in the product - which is a moderation queue, a storage bill and a
 * way to put anything at all beside your name in a list of colleagues. A
 * catalogue is none of those, and it is the reason this can simply be on for
 * everybody instead of being sold.
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
 * A ring around a face.
 *
 * `colors` are the stops of a conic gradient, so one entry describes both a flat
 * ring (the same colour twice) and something that turns. A ring that turns says
 * so with `spin`, and everything that spins is behind `prefers-reduced-motion`
 * where it is drawn - a decoration is exactly the kind of ornament somebody
 * turns animation off to be rid of.
 */
export interface AvatarDecoration {
    readonly id: string;
    readonly label: string;
    readonly colors: readonly string[];
    /** How thick the ring is, as a fraction of the face's width. Small: this
     *  sits around faces drawn at 20 pixels in a list as well as at 72 on a
     *  card. */
    readonly width: number;
    readonly glow?: string;
    readonly spin?: boolean;
}

export const AVATAR_DECORATIONS: readonly AvatarDecoration[] = [
    {
        id: "aurora",
        label: "Aurora",
        colors: ["#3fd0c9", "#5b8def", "#a06bff", "#3fd0c9"],
        width: 0.08,
        glow: "#5b8def",
        spin: true
    },
    {
        id: "ember",
        label: "Ember",
        colors: ["#ff9a3c", "#ff5a5f", "#ffcc66", "#ff9a3c"],
        width: 0.08,
        glow: "#ff7043",
        spin: true
    },
    { id: "frost", label: "Frost", colors: ["#8fd8ff", "#c7ecff"], width: 0.07, glow: "#8fd8ff" },
    { id: "gold", label: "Gold", colors: ["#e8c26a", "#b8862b", "#f4dc9a", "#e8c26a"], width: 0.07 },
    { id: "moss", label: "Moss", colors: ["#7bc47f", "#3f8f5b"], width: 0.07 },
    { id: "rose", label: "Rose", colors: ["#ff9ec4", "#d94f8a"], width: 0.07, glow: "#ff7fb2" },
    { id: "ink", label: "Ink", colors: ["#4a4f5a", "#20242c"], width: 0.07 }
];

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
    readonly from: string;
    readonly to: string;
}

export const NAME_STYLES: readonly NameStyle[] = [
    { id: "aurora", label: "Aurora", from: "#3fd0c9", to: "#a06bff" },
    { id: "ember", label: "Ember", from: "#ffcc66", to: "#ff5a5f" },
    { id: "tide", label: "Tide", from: "#8fd8ff", to: "#3c8ce7" },
    { id: "moss", label: "Moss", from: "#a8e06b", to: "#3f8f5b" },
    { id: "gold", label: "Gold", from: "#f4dc9a", to: "#c99a2e" },
    { id: "rose", label: "Rose", from: "#ffc0d8", to: "#d94f8a" }
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
