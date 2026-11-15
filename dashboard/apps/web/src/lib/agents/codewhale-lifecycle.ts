// Ported from `codewhaleActivity` in backend/internal/httpd/controllers/sessions.go
// and `CodewhaleLifecycleWebhookRequest` in controllers/dto.go of Agent
// Orchestrator (Apache-2.0, github.com/OrchestratorInc/agent-orchestrator,
// commit e4ded08c6f15).

import { z } from "zod";
import { HOOK_SIGNAL_EVENTS, type HookSignal } from "@polaris/core";

/** The lifecycle kinds Codewhale 0.10 posts. */
export const CODEWHALE_KINDS = [
    "session.started",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
    "turn.stalled",
    "session.ended",
    "subagent.spawned",
    "subagent.completed"
] as const;

const meta = z.string().trim().max(256);

/**
 * One webhook delivery: the provider's event envelope, schema version 1. Only
 * the fields Polaris reads are kept; the rest of the envelope is dropped.
 */
export const codewhaleLifecycleSchema = z.object({
    at: z.string().max(64).optional(),
    event: z.object({
        schema_version: z.literal(1),
        seq: z.number().int().nonnegative().optional(),
        event: meta.optional(),
        kind: z.enum(CODEWHALE_KINDS),
        thread_id: meta.min(1),
        turn_id: meta.optional(),
        timestamp: z.string().max(64).optional()
    })
});
export type CodewhaleLifecycle = z.infer<typeof codewhaleLifecycleSchema>;

/** The signal each kind reports; null for a subagent's, which say nothing
 *  about the session itself. Every end of a turn is a stop, as in AO. */
const SIGNALS: Readonly<Record<(typeof CODEWHALE_KINDS)[number], HookSignal | null>> = {
    "session.started": "session-start",
    "turn.started": "user-prompt-submit",
    "turn.completed": "stop",
    "turn.failed": "stop",
    "turn.interrupted": "stop",
    "turn.stalled": "stop",
    "session.ended": "session-end",
    "subagent.spawned": null,
    "subagent.completed": null
};

/**
 * The hook payload a delivery stands for, in the names the event reader
 * speaks, or null for one that says nothing. Codewhale's thread id is a
 * per-process id, not a conversation `--resume` takes, so it is not passed on
 * as the session's.
 */
export function codewhaleHookPayload(delivery: CodewhaleLifecycle): Record<string, string> | null {
    const signal = SIGNALS[delivery.event.kind];
    if (!signal) return null;
    return { hook_event_name: HOOK_SIGNAL_EVENTS[signal], codewhale_kind: delivery.event.kind };
}

/** When the event happened, in nanoseconds since the epoch, for ordering it
 *  beside the session's other events; null where it carries no usable time. */
export function codewhaleSequence(delivery: CodewhaleLifecycle): bigint | null {
    const at = Date.parse(delivery.event.timestamp ?? delivery.at ?? "");
    return Number.isFinite(at) && at > 0 ? BigInt(at) * 1_000_000n : null;
}
