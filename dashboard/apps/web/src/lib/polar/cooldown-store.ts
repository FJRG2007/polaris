/**
 * Automatic's cooldowns shared across processes and restarts: a provider out
 * of credit, one failing a moment ago, a model its provider does not serve to
 * this person. Each process keeps its own memo (`automatic.ts`) and mirrors
 * every entry here, in one `Setting` row per person, read back before
 * Automatic picks - so a refusal one instance saw reorders the next turn on
 * every other one, and survives a restart (LiteLLM's Router keeps its
 * cooldowns in Redis for the same reason).
 *
 * Advisory: it only reorders candidates. A failed read or write is logged and
 * ignored, and two processes writing at once may drop one entry, which costs
 * one more refused call. Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { adoptCooldown, type CooldownMemo } from "@/lib/polar/automatic";

/** Entries one person's row keeps at most; the soonest to end go first. */
const ENTRIES_MOST = 200;
/** How long a read is trusted before the row is read again. */
const READ_MS = 10_000;
/** Person rows whose last read this process remembers. */
const READS_MOST = 5_000;

const MEMOS = ["failing", "unpaid", "garbled", "gone", "echoed"] as const satisfies readonly CooldownMemo[];

const entrySchema = z.object({
    memo: z.enum(MEMOS),
    subject: z.string().min(1).max(300),
    until: z.number().int().positive()
});
const rowSchema = z.array(z.unknown()).max(ENTRIES_MOST * 2);

type Entry = z.infer<typeof entrySchema>;

/** The `Setting` key of one person's cooldowns. */
export function cooldownKey(userId: string): string {
    return `polar.cooldowns.${userId}`;
}

/** The live entries of a stored row; malformed or ended ones are dropped. Pure. */
export function liveEntries(value: string | null | undefined, now: number): Entry[] {
    if (!value) return [];
    let raw: unknown;
    try {
        raw = JSON.parse(value);
    } catch {
        return [];
    }
    const list = rowSchema.safeParse(raw);
    if (!list.success) return [];
    const out: Entry[] = [];
    for (const item of list.data) {
        const entry = entrySchema.safeParse(item);
        if (entry.success && entry.data.until > now) out.push(entry.data);
    }
    return out;
}

/** A row with `entry` merged in: one entry per memo and subject, the later
 *  end kept, bounded to `ENTRIES_MOST`. Pure. */
export function mergedEntries(entries: readonly Entry[], entry: Entry): Entry[] {
    const kept = entries.filter((other) => other.memo !== entry.memo || other.subject !== entry.subject);
    const same = entries.find((other) => other.memo === entry.memo && other.subject === entry.subject);
    kept.push(same && same.until > entry.until ? same : entry);
    return kept.sort((a, b) => b.until - a.until).slice(0, ENTRIES_MOST);
}

/** Writes in flight per person, so this process never races itself. */
const writing = new Map<string, Promise<void>>();

async function write(userId: string, entry: Entry): Promise<void> {
    const key = cooldownKey(userId);
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    const value = JSON.stringify(mergedEntries(liveEntries(row?.value, Date.now()), entry));
    await prisma.setting.upsert({
        where: { key },
        create: { key, value, scope: "polar-cooldowns", userId },
        update: { value }
    });
}

/** Mirrors one noted entry to the shared row, behind this person's earlier
 *  writes. Never throws. */
export function persistCooldown(userId: string, memo: CooldownMemo, subject: string, until: number): void {
    const parsed = entrySchema.safeParse({ memo, subject, until: Math.round(until) });
    if (!parsed.success) return;
    const previous = writing.get(userId) ?? Promise.resolve();
    const next = previous
        .then(() => write(userId, parsed.data))
        .catch((error: unknown) => console.warn("polar: could not share a cooldown", error))
        .finally(() => {
            if (writing.get(userId) === next) writing.delete(userId);
        });
    writing.set(userId, next);
}

const readAt = new Map<string, number>();

/** Reads this person's shared cooldowns into this process's memos, at most
 *  once every `READ_MS`. Never throws. */
export async function hydrateCooldowns(userId: string, now = Date.now()): Promise<void> {
    const last = readAt.get(userId);
    if (last !== undefined && now - last < READ_MS) return;
    if (readAt.size >= READS_MOST) readAt.clear();
    readAt.set(userId, now);
    try {
        const row = await prisma.setting.findUnique({
            where: { key: cooldownKey(userId) },
            select: { value: true }
        });
        for (const entry of liveEntries(row?.value, now)) {
            adoptCooldown(userId, entry.memo, entry.subject, entry.until, now);
        }
    } catch (error) {
        console.warn("polar: could not read the shared cooldowns", error);
    }
}

/** Test seam: forget when each row was read. */
export function forgetCooldownReads(): void {
    readAt.clear();
    writing.clear();
}
