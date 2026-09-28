/**
 * What Polaris's anti-cheat plugin caught, from inside a Minecraft server.
 *
 * Not a session route: the caller is a server, proving which one with the token
 * its environment carries, and everything it sends is about that server's own
 * players. Every field is checked before anything is kept: a server is software
 * somebody else can run, so its body is treated as untrusted like any other.
 */

import { z } from "zod";
import { PLAYER_NAME } from "../../../../../lib/minecraft/polaris-login";
import * as service from "../../../../../lib/minecraft/polaris-anticheat-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The plugin sends at most 200 flags of a few short fields each. */
const MAX_BODY = 128 * 1024;

const flag = z.object({
    player: z.string().regex(PLAYER_NAME, "That is not a player name"),
    uuid: z.string().max(40).optional(),
    check: z
        .string()
        .trim()
        .min(1)
        .max(48)
        .regex(/^[A-Za-z0-9 _.-]+$/, "That is not a check name"),
    vl: z.number().finite().min(0).max(1_000_000),
    verbose: z.string().max(300),
    at: z.number().int().positive()
});

const body = z.object({ flags: z.array(flag).min(1).max(200) });

const reply = (status: number, content: Record<string, unknown>) =>
    Response.json(content, { status, headers: { "cache-control": "no-store" } });

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return reply(401, { error: "unauthorized" });
    const server = await service.authorizeReporter(request, id);
    if (!server) return reply(401, { error: "unauthorized" });

    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) return reply(413, { error: "too-large" });
    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413, { error: "too-large" });
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return reply(400, { error: "invalid" });
    }
    const valid = body.safeParse(parsed);
    if (!valid.success) return reply(400, { error: "invalid" });

    const kept = await service.recordFlags(server, valid.data.flags);
    if (kept.limited) return reply(429, { error: "slow-down" });
    return reply(200, { kept: kept.kept });
}
