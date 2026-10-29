/**
 * An update of this app that is downloaded and installed and only waits for a
 * restart, as the dashboard is told it - the moment that needs the person, and
 * the only one the page offers a button for. Null while there is none.
 *
 * Checked with a schema on both sides of the bridge: before the main process
 * sends it, and again in the page's preload before the page hears it.
 */

import { z } from "zod";

export const updateReadySchema = z
    .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(64) })
    .strict()
    .nullable();

export type UpdateReady = z.infer<typeof updateReadySchema>;

/** The state as the page may hear it: anything that is not one is no update. */
export function readUpdateReady(raw: unknown): UpdateReady {
    const parsed = updateReadySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
