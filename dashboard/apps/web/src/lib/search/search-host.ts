/**
 * What a page hosting the search outside the dashboard's frame hands the
 * palette: Polaris Desktop's Alt+Space window draws the very same
 * `CommandPalette` on `/launcher` and gives it this.
 *
 * The palette keeps every row of its own - recents, pages, the index, commands,
 * the calculator - and only asks the host for what a browser cannot see
 * (installed programs, the clipboard history, the web search), drawn as extra
 * groups after its own. Opening a Polaris result is the host's too: the
 * desktop shows it in its main window instead of navigating the search window.
 */

import { z } from "zod";

/** The kinds of row a host may add, each drawn with its own icon and words. */
export const HOST_ROW_KINDS = ["answer", "app", "polar", "web", "clip"] as const;

export type HostRowKind = (typeof HOST_ROW_KINDS)[number];

/** One row the host found. Validated: it crosses a process boundary. */
export const hostRowSchema = z.object({
    id: z.string().min(1).max(40),
    kind: z.enum(HOST_ROW_KINDS),
    title: z.string().max(400),
    subtitle: z.string().max(400),
    /** A program's own icon, as a PNG data URL, when the host has one. */
    icon: z
        .string()
        .max(200_000)
        .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
        .nullish()
});

export type HostRow = z.infer<typeof hostRowSchema>;

/** The host's answer, read without trusting it: anything malformed is dropped. */
export function readHostRows(raw: unknown): HostRow[] {
    const rows = z.object({ rows: z.array(z.unknown()).max(200) }).safeParse(raw);
    if (!rows.success) return [];
    return rows.data.rows.flatMap((row) => {
        const parsed = hostRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
    });
}

export interface SearchHost {
    /** Rows only the host can find, for what is typed. */
    readonly query: (text: string) => Promise<unknown>;
    /** Run one of those rows. */
    readonly run: (id: string) => void;
    /** Open a Polaris address (a path of this instance). */
    readonly navigate: (href: string) => void;
    /** Put the search away. */
    readonly close: () => void;
    /** Called each time the host brings the search back up. */
    readonly onOpened: (listener: () => void) => void;
}

/** A path of this instance, and nothing that leaves it. */
export function isInstancePath(href: string): boolean {
    return /^\/(?!\/)/.test(href) && !href.includes("\\");
}
