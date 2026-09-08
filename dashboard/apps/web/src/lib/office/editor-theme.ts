/**
 * The embedded editors, wearing Polaris' colours.
 *
 * Two of the five kinds of document are drawn by an engine that brought its own
 * interface with it - the spreadsheet's grid and chrome, the diagram's canvas
 * and panels - and both of them default to a white page. On a dark Polaris that
 * is a rectangle of daylight in the middle of the screen; on either theme it is
 * an application somebody embedded rather than a screen of this one.
 *
 * The spreadsheet takes a palette, which is what this file is. The canvas takes
 * a word, `dark` or `light`, and both get that from `lib/page-theme`.
 *
 * The spreadsheet engine draws its own chrome - the toolbar, the sheet tabs, the
 * menus, the right-click menu on a cell - from a palette of its own, and two
 * things move all of it at once. Both are handed to it at startup:
 *
 * - **The palette**, below. Univer asks for ten steps of each colour and uses
 *   them everywhere, so replacing two of those ramps - the accent and the greys -
 *   moves everything it draws at once. The numbers are Polaris' own tokens, the
 *   same violet and the same neutrals the rest of the dashboard is built from,
 *   written as hex because a canvas engine cannot read a CSS variable.
 * - **Dark mode**, which is a flag rather than a palette: the engine picks which
 *   end of each ramp to use from it. It is read from the page - the same
 *   attribute every other component here reads - and set again whenever somebody
 *   changes it, so a spreadsheet left open does not stay light while the rest of
 *   the screen goes dark.
 *
 * What this cannot do is make Univer's menus into Polaris' menus. They are its
 * own components; what is available is their colour, and that is what is taken.
 */

/** Polaris' accent, as the ten steps an engine wants. Hue 258, the violet in
 *  `--primary`, with 500 and 600 landing exactly on the dark and light theme's
 *  own accent. */
const PRIMARY = {
    50: "#F5F1FE",
    100: "#EAE3FD",
    200: "#D6C7F9",
    300: "#BBA2F6",
    400: "#9974F1",
    500: "#7E4FEE",
    600: "#6833E6",
    700: "#5722D3",
    800: "#4B1FB2",
    900: "#411D96"
} as const;

/** The neutrals, from the same hue every surface and border in Polaris uses.
 *  The light end is the light theme's page and borders, the dark end is the dark
 *  theme's card and border - so the engine's chrome sits at the same depth as
 *  the panel around it instead of floating on a shade of its own. */
const GRAY = {
    50: "#F6F6F9",
    100: "#F3F4F7",
    200: "#DEE1E7",
    300: "#BEC2D0",
    400: "#818798",
    500: "#5C6170",
    600: "#373A43",
    700: "#25272D",
    800: "#1B1D22",
    900: "#141619"
} as const;

/** The engine's own theme with Polaris' two ramps in it. Everything else - the
 *  reds, greens and yellows a spreadsheet uses to mean something rather than to
 *  decorate - is left exactly as it was. */
export function polarisUniverTheme<T extends object>(base: T): T {
    return { ...base, primary: { ...PRIMARY }, gray: { ...GRAY } };
}
