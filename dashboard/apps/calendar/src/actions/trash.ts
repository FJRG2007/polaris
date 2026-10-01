"use server";

/** The trash: list, restore, delete for good, empty. */

import { z } from "zod";
import * as trash from "../lib/trash";
import type { TrashItemView } from "../lib/wire";
import { requireCalendarUser } from "../lib/access";
import { isKnownZone, uuidSchema } from "../lib/schemas";
import { invalid, outcome, type Outcome } from "../lib/outcome";

const target = z.object({ kind: z.enum(["calendar", "event"]), id: uuidSchema });

export async function listTrashAction(): Promise<
    Outcome<{ items: TrashItemView[]; retentionDays: number }>
> {
    return outcome(async () => ({
        items: await trash.listTrash(await requireCalendarUser()),
        retentionDays: trash.RETENTION_DAYS
    }));
}

export async function restoreTrashAction(input: unknown): Promise<Outcome<object>> {
    const parsed = target
        .extend({ zone: z.string().max(64).refine(isKnownZone).default("UTC") })
        .safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await trash.restoreTrash(
            await requireCalendarUser(),
            parsed.data.kind,
            parsed.data.id,
            parsed.data.zone
        );
        return {};
    });
}

export async function purgeTrashAction(input: unknown): Promise<Outcome<object>> {
    const parsed = target.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await trash.purgeTrash(await requireCalendarUser(), parsed.data.kind, parsed.data.id);
        return {};
    });
}

export async function emptyTrashAction(): Promise<Outcome<{ removed: number }>> {
    return outcome(async () => ({ removed: await trash.emptyTrash(await requireCalendarUser()) }));
}
