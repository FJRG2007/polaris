/**
 * Chat moderation, from inside a Minecraft server: the rules its mod or plugin
 * applies (GET, every half minute), and each line it stopped (POST, answered
 * with what the player is told).
 *
 * Not a session route: the caller is a server, proving which one with the token
 * its environment carries - the same one the anti-cheat and the login use. What
 * it sends is treated as untrusted like any other body, and checked field by
 * field before anything is kept.
 */

import { z } from "zod";
import { PLAYER_NAME } from "../../../../../lib/minecraft/polaris-login";
import { BLOCK_REASONS } from "../../../../../lib/minecraft/chat-moderation";
import * as service from "../../../../../lib/minecraft/chat-moderation-service";
import { authorizeReporter } from "../../../../../lib/minecraft/polaris-anticheat-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One line of chat and a few short fields. */
const MAX_BODY = 8 * 1024;

const block = z.object({
    player: z.string().regex(PLAYER_NAME, "That is not a player name"),
    uuid: z.string().max(40).optional(),
    reason: z.enum(BLOCK_REASONS),
    detail: z.string().max(120).default(""),
    text: z.string().min(1).max(256),
    command: z.boolean().default(false),
    at: z.number().int().positive()
});

const reply = (status: number, content: Record<string, unknown>) =>
    Response.json(content, { status, headers: { "cache-control": "no-store" } });

/** The build the server runs, as its client names itself. */
function versionOf(request: Request): string {
    const agent = request.headers.get("user-agent") ?? "";
    return /^Polaris-Minecraft\/(\S{1,80})/.exec(agent)?.[1] ?? "";
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return reply(401, { error: "unauthorized" });
    const server = await authorizeReporter(request, id);
    if (!server) return reply(401, { error: "unauthorized" });
    return reply(200, await service.rulesForServer(server.installedAppId, versionOf(request)));
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return reply(401, { error: "unauthorized" });
    const server = await authorizeReporter(request, id);
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
    const valid = block.safeParse(parsed);
    if (!valid.success) return reply(400, { error: "invalid" });

    const answer = await service.recordBlock(server, valid.data);
    if ("limited" in answer) return reply(429, { error: "slow-down" });
    return reply(200, answer);
}
