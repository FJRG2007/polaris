"use server";

/** Pin a record or a view to the CRM's rail, or take it off. */

import { z } from "zod";
import * as favorites from "../lib/favorites";
import { requireCrmActor } from "../lib/access";
import { CRM_OBJECTS } from "../model/objects";
import { invalid, outcome, type Outcome } from "../lib/outcome";

const favoriteSchema = z.object({
    kind: z.enum(["record", "view"]),
    object: z.enum(CRM_OBJECTS),
    targetId: z.string().uuid(),
    pinned: z.boolean()
});

export async function setFavoriteAction(input: unknown): Promise<Outcome<{ pinned: boolean }>> {
    const parsed = favoriteSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const { kind, object, targetId, pinned } = parsed.data;
    return outcome(async () => {
        const actor = await requireCrmActor();
        if (pinned) await favorites.addFavorite(actor, kind, object, targetId);
        else await favorites.removeFavorite(actor, kind, targetId);
        return { pinned };
    });
}
