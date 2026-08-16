/**
 * The themes a Polaris can be read in.
 *
 * A control plane is looked at for hours, so which one somebody wants is a
 * matter of the room they are in and their own eyes rather than a house style -
 * which is why the operator sets the default and, unless they say otherwise,
 * each account may pick its own.
 *
 * A theme is a class on the document and a block of colour tokens in
 * `tokens.css`; nothing else in the interface knows a theme exists. That is the
 * whole point of the token layer, and it is why adding one here is adding one
 * block of variables rather than touching a screen.
 *
 * `dark` is the bare `:root`, so it carries no class - it is what the tokens
 * define before any theme is chosen.
 */

export const THEME_IDS = ["dark", "light", "system", "midnight", "graphite"] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeInfo {
    readonly id: ThemeId;
    readonly label: string;
    /** One line about when somebody would pick it. */
    readonly description: string;
    /**
     * What the browser should assume about the page's own colours: it decides
     * the colour of scrollbars, form controls it draws itself, and the flash
     * before the first paint. `system` follows the machine.
     */
    readonly scheme: "dark" | "light" | "system";
}

export const THEMES: readonly ThemeInfo[] = [
    {
        id: "dark",
        label: "Dark",
        description: "The default. Quiet surfaces with a trace of blue in them.",
        scheme: "dark"
    },
    {
        id: "light",
        label: "Light",
        description: "White surfaces, for a bright room.",
        scheme: "light"
    },
    {
        id: "system",
        label: "Follow the system",
        description: "Dark or light, whichever this machine is set to.",
        scheme: "system"
    },
    {
        id: "midnight",
        label: "Midnight",
        description: "Nearly black, with the panels further apart. For a dark room.",
        scheme: "dark"
    },
    {
        id: "graphite",
        label: "Graphite",
        description: "Grey with no colour cast, for anyone the blue tint bothers.",
        scheme: "dark"
    }
];

export const THEME_LABELS: Readonly<Record<ThemeId, string>> = Object.fromEntries(
    THEMES.map((theme) => [theme.id, theme.label])
) as Record<ThemeId, string>;

/** The class the document carries for a theme, or "" for the one that is the
 *  bare token set. */
export function themeClass(theme: ThemeId): string {
    return theme === "dark" ? "" : theme;
}

/** Whether an id names a theme this build has. Anything else - a theme removed
 *  since somebody chose it, a value from an older release - reads as unset and
 *  follows the layer below rather than leaving somebody on a blank page. */
export function isThemeId(value: unknown): value is ThemeId {
    return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}
