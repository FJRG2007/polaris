/**
 * Polar's "Always allow", from the approval card.
 *
 * POST names a call the card is showing - the tool and its input - and answers
 * what it acts on by name (`target`) and whether a grant would cover that one
 * thing or the whole tool. With `allow: true` it also stores the grant. The
 * browser never names the target: the server reads it from the input, as the
 * person, the same way the chat's loop will when it checks the grant.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { callerMayUse } from "@/lib/mcp/protocol";
import { polarCaller as mcpCaller } from "@/lib/polar/tools";
import { callTarget, grantScope, grantableTool, saveGrant } from "@/lib/polar/tool-grants";

export const dynamic = "force-dynamic";

/** A tool's input as the card holds it; far more than any tool takes. */
const BODY_MAX = 64 * 1024;

const bodySchema = z
    .object({
        tool: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .regex(/^[a-z0-9_.-]+$/i),
        input: z.unknown(),
        allow: z.boolean().default(false)
    })
    .strict();

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-grants:${user.id}`, 60, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = bodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);

    const caller = await mcpCaller(user);
    const entry = await grantableTool(body.data.tool, (candidate) =>
        callerMayUse(candidate, caller)
    );
    if (!entry) return refuse("not_found", 404);
    const target = await callTarget(entry, body.data.input, caller);
    if (body.data.allow) await saveGrant(user.id, entry, target);
    return NextResponse.json({
        target: target ? { name: target.name, action: target.action ?? null } : null,
        scope: grantScope(entry, target) ? "target" : "tool",
        allowed: body.data.allow
    });
}
