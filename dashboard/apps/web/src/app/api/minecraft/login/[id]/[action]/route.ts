/**
 * What Polaris's login mod asks, from inside a Minecraft server.
 *
 * Not a session route: the caller is a server, and it proves which one with the
 * token its environment carries. Every answer is about that server's players and
 * nobody else's.
 *
 * A player the server's list does not allow is answered with `refused`, the
 * sentence the mod kicks them with, on every question about them.
 *
 * The status codes are the mod's vocabulary, and it tells the player what each
 * one means - so a wrong password and a wrong token are different codes (403 and
 * 401), and neither is ever the other.
 */

import { z } from "zod";
import * as login from "@/lib/apps/minecraft/polaris-login";
import * as service from "@/lib/apps/minecraft/polaris-login-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every body the mod sends is a few short strings. */
const MAX_BODY = 2048;

const player = z.string().regex(login.PLAYER_NAME, "That is not a player name");
/** A password being given: anything that could have been set. */
const given = z.string().min(1).max(login.MAX_PASSWORD);
/** A password being set. */
const chosen = z
    .string()
    .min(login.MIN_PASSWORD, `A password needs at least ${login.MIN_PASSWORD} characters`)
    .max(login.MAX_PASSWORD, `A password can have at most ${login.MAX_PASSWORD} characters`)
    .regex(/^[^\p{Cc}]+$/u, "A password cannot contain control characters");
const label = z.string().trim().min(1).max(32);
/** Where the player connects from, as the server saw it. Checked for being an
 *  address where it is used. */
const address = z.string().trim().max(64).optional();

const BODIES = {
    hello: z.object({ mod: label, minecraft: label }),
    status: z.object({ player, address }),
    register: z.object({ player, address, password: chosen }),
    login: z.object({ player, address, password: given }),
    password: z.object({ player, current: given, next: chosen })
} as const;

type Action = keyof typeof BODIES;

function isAction(value: string): value is Action {
    return Object.hasOwn(BODIES, value);
}

const reply = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
    Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

function refused(result: service.LoginResult): Response {
    switch (result.kind) {
        case "wrong":
            return reply(403, { error: "wrong-password" });
        case "unknown":
            return reply(404, { error: "not-registered" });
        case "throttled": {
            const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
            return reply(
                429,
                { error: "throttled", retryAfterSeconds: seconds },
                { "retry-after": String(seconds) }
            );
        }
        case "ok":
            return reply(200, { ok: true });
    }
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string; action: string }> }
): Promise<Response> {
    const { id, action } = await params;
    if (!isAction(action)) return reply(404, { error: "unknown-action" });
    if (!z.string().uuid().safeParse(id).success) return reply(401, { error: "unauthorized" });

    const server = await service.authorizeMod(request, id);
    if (!server) return reply(401, { error: "unauthorized" });

    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413, { error: "too-large" });
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return reply(400, { error: "invalid", message: "The request is not JSON" });
    }

    try {
        switch (action) {
            case "hello": {
                const body = BODIES.hello.safeParse(json);
                if (!body.success) return invalid(body.error);
                await service.recordCheckIn(server, {
                    modVersion: body.data.mod,
                    gameVersion: body.data.minecraft
                });
                return reply(200, { ok: true });
            }
            case "status": {
                const body = BODIES.status.safeParse(json);
                if (!body.success) return invalid(body.error);
                const [registered, turnedAway] = await Promise.all([
                    service.isRegistered(server, body.data.player),
                    service.joinRefusal(server, body.data.player, body.data.address)
                ]);
                return reply(
                    200,
                    turnedAway ? { registered, refused: turnedAway } : { registered }
                );
            }
            case "register": {
                const body = BODIES.register.safeParse(json);
                if (!body.success) return invalid(body.error);
                const turnedAway = await service.joinRefusal(
                    server,
                    body.data.player,
                    body.data.address
                );
                if (turnedAway) return reply(403, { error: "not-listed", refused: turnedAway });
                const created = await service.register(
                    server,
                    body.data.player,
                    body.data.password
                );
                return created ? reply(200, { ok: true }) : reply(409, { error: "registered" });
            }
            case "login": {
                const body = BODIES.login.safeParse(json);
                if (!body.success) return invalid(body.error);
                const turnedAway = await service.joinRefusal(
                    server,
                    body.data.player,
                    body.data.address
                );
                if (turnedAway) return reply(403, { error: "not-listed", refused: turnedAway });
                return refused(
                    await service.checkPassword(server, body.data.player, body.data.password)
                );
            }
            case "password": {
                const body = BODIES.password.safeParse(json);
                if (!body.success) return invalid(body.error);
                return refused(
                    await service.changePassword(
                        server,
                        body.data.player,
                        body.data.current,
                        body.data.next
                    )
                );
            }
        }
    } catch (caught) {
        console.error(`[minecraft-login] ${action} failed for ${id}`, caught);
        return reply(500, { error: "failed" });
    }
}

/** The first problem, in a sentence the mod can show the player as it is. */
function invalid(error: z.ZodError): Response {
    return reply(400, {
        error: "invalid",
        message: error.issues[0]?.message ?? "The request is not valid"
    });
}
