/**
 * The signed-in person's Polar memories: GET lists them with whether memory is
 * on, POST saves one by hand, DELETE clears them all. Text that looks like a
 * secret is refused (`memory.ts`).
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { memoryTextSchema } from "@/lib/polar/shared";
import { rateLimit } from "@/lib/rate-limit-service";
import {
    addPolarMemory,
    clearPolarMemories,
    listPolarMemories,
    polarMemoryEnabled
} from "@/lib/polar/memory";

export const dynamic = "force-dynamic";

const postSchema = z.object({ text: memoryTextSchema }).strict();

/** Writes to the memory list, per person per minute. */
const MEMORY_WRITES_PER_MINUTE = 60;

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const [enabled, memories] = await Promise.all([
        polarMemoryEnabled(user.id),
        listPolarMemories(user.id)
    ]);
    return NextResponse.json({ enabled, memories });
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const limited = await rateLimit(`polar-memory:${user.id}`, MEMORY_WRITES_PER_MINUTE, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const body = postSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const saved = await addPolarMemory(user.id, body.data.text);
    if (typeof saved === "string") return NextResponse.json({ error: saved }, { status: 400 });
    return NextResponse.json({ memory: saved });
}

export async function DELETE(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    await clearPolarMemories(user.id);
    return NextResponse.json({ ok: true });
}
