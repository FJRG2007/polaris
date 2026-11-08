/**
 * A phone claims a pad: by the code the game shows, or by the pad's id when
 * the phone is signed in to the account that opened it. Codes are six digits,
 * so failed claims are limited per reader.
 */

import { z } from "zod";
import { claimPad } from "@/lib/arcade/phone-pads";
import { padError, padReader } from "@/lib/arcade/pad-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.union([
    z
        .object({
            code: z
                .string()
                .trim()
                .regex(/^\d{6}$/)
        })
        .strict(),
    z
        .object({
            id: z
                .string()
                .trim()
                .regex(/^[0-9a-f]{32}$/)
        })
        .strict()
]);

/** Failed claims a reader may make in a window before being told to wait. */
const MAX_FAILURES = 10;
const WINDOW_MS = 60_000;
const KEY = Symbol.for("polaris.arcade.pad-claim-failures");
const store = globalThis as unknown as Record<symbol, Map<string, number[]> | undefined>;
const failures: Map<string, number[]> = (store[KEY] ??= new Map());

function recentFailures(userId: string, now: number): number[] {
    const kept = (failures.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
    if (kept.length) failures.set(userId, kept);
    else failures.delete(userId);
    return kept;
}

export async function POST(request: Request): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    const now = Date.now();
    if (recentFailures(user.id, now).length >= MAX_FAILURES)
        return padError("tooManyRequests", 429);
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return padError("invalidRequest", 400);
    const claimed = claimPad(body.data, { userId: user.id, name: user.name });
    if (!claimed) {
        failures.set(user.id, [...recentFailures(user.id, now), now]);
        return padError("notFound", 404);
    }
    return Response.json(claimed, { headers: { "Cache-Control": "no-store" } });
}
