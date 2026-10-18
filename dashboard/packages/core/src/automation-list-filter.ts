/**
 * The automations list filtered to what one app made: `/automations?app=<id>`,
 * and `&ref=<id>` for one thing of that app, such as a place. The address is the
 * filter, so an app's screens link to it and a reload or a shared link keeps it.
 */

import { z } from "zod";

/** The list's own address. */
export const AUTOMATIONS_LIST_PATH = "/automations";

/** The filter as the address carries it, checked before any query reads it. */
export const automationsListFilterSchema = z.object({
    app: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    ref: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,120}$/)
        .nullish()
        .transform((value) => value ?? null)
});

export type AutomationsListFilter = z.infer<typeof automationsListFilterSchema>;

/** Where the list filtered to one app's automations - and one thing of it - is. */
export function automationsListHref(app: string, ref?: string | null): string {
    const query = new URLSearchParams({ app });
    if (ref) query.set("ref", ref);
    return `${AUTOMATIONS_LIST_PATH}?${query.toString()}`;
}
