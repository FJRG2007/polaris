/**
 * An update of this app that is downloaded and installed and only waits for a
 * restart, as the dashboard is told it - the moment that needs the person, and
 * the only one the page offers a button for. Null while there is none.
 *
 * Checked with a schema on both sides of the bridge: before the main process
 * sends it, and again in the page's preload before the page hears it.
 */

// The tree-shaken build of zod: this is read in the page's preload, which runs
// before every load of the dashboard, and the full one is most of a megabyte.
import * as z from "zod/mini";

export const updateReadySchema = z.nullable(
    z.strictObject({ version: z.string().check(z.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), z.maxLength(64)) })
);

export type UpdateReady = z.infer<typeof updateReadySchema>;

/** The state as the page may hear it: anything that is not one is no update. */
export function readUpdateReady(raw: unknown): UpdateReady {
    const parsed = updateReadySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
