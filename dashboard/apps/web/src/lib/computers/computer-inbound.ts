/**
 * What a runner said, acted on. The sidecar relays every frame except terminal
 * output here (`POST /api/runners/relay`); this is the only place a runner's
 * words change anything.
 *
 * A frame about a session only counts for a session placed on this runner:
 * a runner can never write into somebody else's session, nor into one of its
 * owner's sessions that runs elsewhere. Hooks and permission prompts go
 * through the same code as a container session's HTTP hook
 * (`session-hook-ingest.ts`), so the screens cannot tell the difference.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as computers from "./computer-service";
import { touchSession } from "@/lib/agents/session-live";
import { listenForRunnerCommands } from "./computer-commands";
import { deliverChatEvent } from "@/lib/polar/claude-subscription/turns";
import { finishSession, recordSessionEvents } from "@/lib/agents/session-service";
import { decidePermissionHook, ingestHookPayload } from "@/lib/agents/session-hook-ingest";

export async function handleRunnerMessage(
    identity: core.RunnerIdentity,
    message: core.RunnerMessage,
    signal?: AbortSignal
): Promise<core.ServerCommand | null> {
    // This node holds a runner from now on, so it must hear other nodes'
    // commands for it.
    listenForRunnerCommands();
    switch (message.type) {
        case "hello":
            await computers.recordHello(identity.runnerId, message.runnerVersion);
            return null;
        case "capabilities":
            await computers.recordCapabilities(identity.runnerId, message);
            return null;
        case "heartbeat":
            await computers.recordSeen(identity.runnerId);
            return null;
        case "error":
            console.error(`[runner] ${identity.runnerId}: ${message.code}: ${message.message}`);
            return null;
        case "chat.event":
            deliverChatEvent(identity.runnerId, message);
            return null;
        case "toolchain.progress":
            // enigma: logged only until the runner's progress reaches the
            // session screen; see TOOLCHAIN-PLAN.md.
            if (message.step === "failed") console.error(`[runner] ${identity.runnerId}: preparing ${message.tool} failed: ${message.code ?? "unknown"}`);
            return null;
        case "terminal.output":
            // Never relayed here; the sidecar fans it out itself.
            return null;
        default:
            break;
    }

    const session = await prisma.agentSession.findFirst({
        where: { id: message.sessionId, runnerId: identity.runnerId, place: "computer" },
        select: { id: true, cli: true, state: true }
    });
    if (!session) return { type: "error", code: "unknown_session", message: "No such session on this computer" };
    const over = core.isSessionOver(session.state as core.AgentSessionState);

    switch (message.type) {
        case "session.started":
            await prisma.agentSession.updateMany({
                where: { id: session.id },
                data: { workdir: message.workdir }
            });
            touchSession(session.id);
            return null;
        case "session.ended":
            if (!over)
                await finishSession(
                    session.id,
                    message.reason === "failed" ? "failed" : "stopped",
                    message.reason === "failed" ? (message.detail ?? null) : null
                );
            return null;
        case "hook":
            if (!over) await ingestHookPayload(session, message.payload, core.parseHookSequence(message.seq));
            return null;
        case "event":
            if (!over)
                await recordSessionEvents(
                    session.id,
                    [{ kind: message.kind, detail: message.detail, subject: "" }],
                    null
                );
            return null;
        case "permission.request": {
            const decision = over ? {} : await decidePermissionHook(session.id, message.payload, signal);
            return {
                type: "permission.decision",
                requestId: message.requestId,
                sessionId: session.id,
                decision
            };
        }
    }
}
