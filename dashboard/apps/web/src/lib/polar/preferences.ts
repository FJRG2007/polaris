/**
 * Polar's per-person settings as one row: memory on or off, what a chat
 * shows (`display.ts`), and the model dictation hears with. No row means
 * every default. Server-only.
 */

import { prisma } from "@polaris/db";
import { transcriptionChoiceSchema } from "@/lib/polar/transcription";
import { displayOf, type PolarDisplay, type PolarPreferencesPatch } from "@/lib/polar/display";

export interface PolarPreferences extends PolarDisplay {
    memory: boolean;
    /** `provider/model`, or null for the fastest model a key is held for. */
    transcriptionModel: string | null;
}

const SELECTED = {
    memory: true,
    showTokens: true,
    showCost: true,
    showContextBar: true,
    autoCompact: true,
    transcriptionModel: true
} as const;

/** A stored pick that still reads as one, or null. */
function transcriptionOf(row: { transcriptionModel?: string | null } | null): string | null {
    const parsed = transcriptionChoiceSchema.safeParse(row?.transcriptionModel);
    return parsed.success ? parsed.data : null;
}

export async function polarPreferences(userId: string): Promise<PolarPreferences> {
    const row = await prisma.polarPreference.findUnique({ where: { userId }, select: SELECTED });
    return {
        memory: row?.memory ?? true,
        transcriptionModel: transcriptionOf(row),
        ...displayOf(row)
    };
}

/** Applies a change, owner-scoped by the key, and answers the whole result. */
export async function setPolarPreferences(
    userId: string,
    patch: PolarPreferencesPatch
): Promise<PolarPreferences> {
    const data = Object.fromEntries(
        Object.entries(patch).filter(
            ([key, value]) =>
                typeof value === "boolean" ||
                (key === "transcriptionModel" && (value === null || typeof value === "string"))
        )
    ) as PolarPreferencesPatch;
    const row = await prisma.polarPreference.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
        select: SELECTED
    });
    return { memory: row.memory, transcriptionModel: transcriptionOf(row), ...displayOf(row) };
}
