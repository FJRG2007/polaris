/**
 * POST /api/computers/relay - the WebSocket sidecar on this node telling the
 * dashboard what its runner sockets said.
 *
 * Loopback only, behind the internal key the sidecar already uses for its
 * other calls. Three operations: check a runner's credential, record that a
 * runner connected or left here, and hand over one frame. A frame that waits
 * on a person (a permission prompt) holds this request until it is answered,
 * so the sidecar's call allows for that.
 */

import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import * as core from "@polaris/core";
import { authenticateRunner, recordPresence } from "@/lib/computers/computer-service";
import { handleRunnerMessage } from "@/lib/computers/computer-inbound";
import {
    listenForRunnerCommands,
    readCommand,
    relayTerminalOutput,
    sendToRunner
} from "@/lib/computers/computer-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const identitySchema = z.object({ runnerId: z.string().uuid(), userId: z.string().uuid() });

const bodySchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("auth"), token: z.string().min(1).max(200) }),
    z.object({ op: z.literal("presence"), runner: identitySchema, online: z.boolean() }),
    z.object({ op: z.literal("frame"), runner: identitySchema, message: z.unknown() }),
    // A terminal viewer here sending a command to a runner held on another node.
    z.object({ op: z.literal("command"), runnerId: z.string().uuid(), command: z.unknown() }),
    // A runner's terminal output, held here, for a viewer on `node`.
    z.object({
        op: z.literal("output"),
        node: z.string().min(1).max(255),
        runnerId: z.string().uuid(),
        sessionId: z.string().uuid(),
        data: z.string().max(Math.ceil(core.RUNNER_LIMITS.terminalChunkBytes / 3) * 4 + 4)
    })
]);

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(request: Request): Promise<Response> {
    const secret = process.env.POLARIS_AUTH_SECRET ?? "";
    if (!secret || !safeEqual(request.headers.get("x-internal-key") ?? "", secret))
        return Response.json({ error: "forbidden" }, { status: 403 });
    const raw = await request.text();
    // i18n-ignore read by a machine, not shown to a person
    if (raw.length > core.RUNNER_LIMITS.frameBytes + 1024) return Response.json({ error: "too large" }, { status: 413 });
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        json = null;
    }
    const parsed = bodySchema.safeParse(json);
    // i18n-ignore read by a machine, not shown to a person
    if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
    const body = parsed.data;
    if (body.op === "auth") return Response.json({ runner: await authenticateRunner(body.token) });

    if (body.op === "command") {
        // Output for this viewer comes back over NOTIFY, so this node listens.
        listenForRunnerCommands();
        const command = readCommand(body.command);
        // i18n-ignore read by a machine, not shown to a person
        if (!command || command.type === "close") return Response.json({ error: "invalid command" }, { status: 400 });
        return Response.json({ sent: await sendToRunner(body.runnerId, command) });
    }
    if (body.op === "output") {
        await relayTerminalOutput(body.node, body.runnerId, body.sessionId, body.data);
        return Response.json({ ok: true });
    }

    // The credential was checked when the socket opened; a runner revoked since
    // is closed by the revoke itself.
    if (body.op === "presence") {
        listenForRunnerCommands();
        await recordPresence(body.runner.runnerId, body.online);
        return Response.json({ ok: true });
    }
    const message = core.runnerMessageSchema.safeParse(body.message);
    // i18n-ignore read by a machine, not shown to a person
    if (!message.success) return Response.json({ error: "invalid frame" }, { status: 400 });
    const reply = await handleRunnerMessage(body.runner, message.data, request.signal);
    return Response.json({ reply });
}
