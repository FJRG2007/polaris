/**
 * Polar's per-person settings as one row: memory on or off, what a chat shows
 * (`display.ts`), the model dictation hears with, whether a suggested next
 * message follows each answer, and the model titles and suggestions are
 * written with. No row means every default, and a stored helper model that no
 * longer reads is Automatic. Server-only.
 */

import { Prisma, prisma } from "@polaris/db";
import { transcriptionChoiceSchema } from "@/lib/polar/transcription";
import {
    displayOf,
    helperModelOf,
    type PolarDisplay,
    type PolarHelperModel,
    type PolarPreferencesPatch
} from "@/lib/polar/display";

export interface PolarPreferences extends PolarDisplay {
    memory: boolean;
    /** `provider/model`, or null for the fastest model a key is held for. */
    transcriptionModel: string | null;
    /** Null is Automatic. */
    helperModel: PolarHelperModel | null;
}

const SELECTED = {
    memory: true,
    suggestions: true,
    helperModel: true,
    showTokens: true,
    showCost: true,
    showContextBar: true,
    autoCompact: true,
    reopenLastChat: true,
    transcriptionModel: true
} as const;

/** A stored pick that still reads as one, or null. */
function transcriptionOf(row: { transcriptionModel?: unknown } | null): string | null {
    const parsed = transcriptionChoiceSchema.safeParse(row?.transcriptionModel);
    return parsed.success ? parsed.data : null;
}

export async function polarPreferences(userId: string): Promise<PolarPreferences> {
    const row = await prisma.polarPreference.findUnique({ where: { userId }, select: SELECTED });
    return preferencesOf(row);
}

/** A row read whole: anything missing or unreadable is its default. */
function preferencesOf(
    row: {
        memory?: unknown;
        suggestions?: unknown;
        transcriptionModel?: unknown;
        helperModel?: unknown;
    } | null
): PolarPreferences {
    return {
        memory: typeof row?.memory === "boolean" ? row.memory : true,
        transcriptionModel: transcriptionOf(row),
        helperModel: helperModelOf(row?.helperModel),
        ...displayOf(row)
    };
}

/** Applies a change, owner-scoped by the key, and answers the whole result. */
export async function setPolarPreferences(
    userId: string,
    patch: PolarPreferencesPatch
): Promise<PolarPreferences> {
    const switches = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => typeof value === "boolean")
    );
    const data = {
        ...switches,
        ...(patch.transcriptionModel !== undefined
            ? { transcriptionModel: patch.transcriptionModel }
            : {}),
        ...(patch.helperModel !== undefined
            ? { helperModel: patch.helperModel ?? Prisma.DbNull }
            : {})
    };
    const row = await prisma.polarPreference.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
        select: SELECTED
    });
    return preferencesOf(row);
}
