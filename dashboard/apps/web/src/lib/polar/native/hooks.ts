/**
 * How a native session tells Polaris what it is doing: the same hook payloads
 * Claude Code sends (https://code.claude.com/docs/en/hooks), posted to the
 * same session routes with the same per-session token, so turn status, todos,
 * questions, plans, the transcript path and permission prompts all land in the
 * code that already reads them (session-hook-ingest.ts,
 * session-permissions.ts, session-asks.ts).
 *
 * `HookSink` is the seam: `httpHookSink` posts to Polaris; a test records.
 */

export type HookPayload = Readonly<Record<string, unknown>> & {
    readonly hook_event_name: string;
    readonly session_id: string;
    readonly transcript_path: string;
    readonly cwd: string;
    readonly permission_mode: string;
};

/** What the permission route answers: Claude Code's hook output shape, or
 *  `{}` for no decision. */
export type HookDecision = Record<string, unknown>;

export interface HookSink {
    /** Fire and forget: an event the session page reads. */
    event(payload: HookPayload): Promise<void>;
    /** A prompt or question held until a person answers, or the wait ends. */
    decide(payload: HookPayload, signal: AbortSignal): Promise<HookDecision>;
}

export interface HttpHookTarget {
    /** `/api/agents/sessions/<id>/events` on this Polaris. */
    readonly eventsUrl: string;
    /** `/api/agents/sessions/<id>/permission`. */
    readonly permissionUrl: string;
    /** The session's reporting token. */
    readonly token: string;
    readonly fetchImpl?: typeof fetch;
}

/** A little longer than the server's own wait (PERMISSION_WAIT_MS, 120 s), so
 *  the server is always the side that gives up first. */
export const DECISION_TIMEOUT_MS = 130_000;
const EVENT_TIMEOUT_MS = 4_000;

export function httpHookSink(target: HttpHookTarget): HookSink {
    const send = target.fetchImpl ?? fetch;
    let seq = 0;
    const post = (url: string, payload: HookPayload, signal: AbortSignal, extra: Record<string, string> = {}) =>
        send(url, {
            method: "POST",
            headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json", ...extra },
            body: JSON.stringify(payload),
            signal
        });
    const event = async (payload: HookPayload) => {
        try {
            await post(target.eventsUrl, payload, AbortSignal.timeout(EVENT_TIMEOUT_MS), {
                "x-polaris-seq": String(++seq)
            });
        } catch {
            // An event that does not arrive costs a status update, never the turn.
        }
    };
    return {
        event,
        async decide(payload, signal) {
            await event(payload);
            try {
                const response = await post(
                    target.permissionUrl,
                    payload,
                    AbortSignal.any([signal, AbortSignal.timeout(DECISION_TIMEOUT_MS)])
                );
                if (!response.ok) return {};
                const body: unknown = await response.json();
                return body && typeof body === "object" ? (body as HookDecision) : {};
            } catch {
                return {};
            }
        }
    };
}

export interface ReadDecision {
    readonly behavior: "allow" | "deny" | "none";
    readonly message: string;
    readonly updatedInput: Record<string, unknown> | null;
    /** "Always allow": the tool is allowed for the rest of the session. */
    readonly always: boolean;
}

/** Reads a decision the way Claude Code would: allow, deny with a reason, or
 *  none. Pure. */
export function readDecision(decision: HookDecision): ReadDecision {
    const output = (decision.hookSpecificOutput ?? {}) as Record<string, unknown>;
    // PreToolUse (questions, plans): permissionDecision.
    if (typeof output.permissionDecision === "string") {
        const said = output.permissionDecision;
        return {
            behavior: said === "allow" ? "allow" : said === "deny" ? "deny" : "none",
            message: typeof output.permissionDecisionReason === "string" ? output.permissionDecisionReason : "",
            updatedInput:
                output.updatedInput && typeof output.updatedInput === "object"
                    ? (output.updatedInput as Record<string, unknown>)
                    : null,
            always: false
        };
    }
    // PermissionRequest: decision.behavior.
    const inner = (output.decision ?? {}) as Record<string, unknown>;
    if (inner.behavior === "allow" || inner.behavior === "deny") {
        return {
            behavior: inner.behavior,
            message: typeof inner.message === "string" ? inner.message : "",
            updatedInput: null,
            always: Array.isArray(inner.updatedPermissions) && inner.updatedPermissions.length > 0
        };
    }
    return { behavior: "none", message: "", updatedInput: null, always: false };
}
