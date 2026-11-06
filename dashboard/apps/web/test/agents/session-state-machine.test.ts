/**
 * What each Claude hook does to a session's state, and what a hook that arrives
 * out of order does (nothing). Pure: the payloads are the shapes Claude Code
 * posts, run through the same normaliser and reducer the ingest route uses.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import {
    CLAUDE_HOOK_EVENTS,
    claudeHookSettings,
    normalizeHookEvent
} from "@/lib/agents/session-hooks";

/** The state a session in `from` lands in after one hook, or `from` when the
 *  hook says nothing. */
function after(payload: Record<string, unknown>, from: core.AgentSessionState = "working") {
    const event = normalizeHookEvent(payload);
    if (!event) return from;
    return core.replaySessionState([event], from);
}

describe("each hook's transition", () => {
    it("SessionStart leaves the agent at its prompt, not working", () => {
        expect(after({ hook_event_name: "SessionStart", source: "startup" }, "starting")).toBe(
            "idle"
        );
    });

    it("UserPromptSubmit starts work", () => {
        expect(after({ hook_event_name: "UserPromptSubmit", prompt: "fix it" }, "idle")).toBe(
            "working"
        );
    });

    it("PermissionRequest needs the person, and says which tool", () => {
        const payload = {
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_input: { command: "rm -rf build" }
        };
        expect(after(payload)).toBe("waiting");
        expect(normalizeHookEvent(payload)).toEqual({
            kind: "permission",
            detail: "Bash: rm -rf build",
            subject: "Bash"
        });
    });

    it("Notification asking for something needs the person", () => {
        expect(
            after({
                hook_event_name: "Notification",
                notification_type: "permission_prompt",
                message: "Allow?"
            })
        ).toBe("waiting");
    });

    it("the idle nudge after a finished turn moves nothing", () => {
        expect(
            normalizeHookEvent({
                hook_event_name: "Notification",
                notification_type: "idle_prompt"
            })
        ).toBeNull();
        expect(
            after({ hook_event_name: "Notification", notification_type: "idle_prompt" }, "idle")
        ).toBe("idle");
    });

    it("Stop ends the turn", () => {
        expect(after({ hook_event_name: "Stop" })).toBe("idle");
    });

    it("StopFailure ends the turn with its reason and keeps the session alive", () => {
        const payload = {
            hook_event_name: "StopFailure",
            error: "rate_limit",
            error_details: "429"
        };
        expect(normalizeHookEvent(payload)).toEqual({
            kind: "turn.failed",
            detail: "rate_limit: 429",
            subject: ""
        });
        const state = after(payload);
        expect(state).toBe("idle");
        expect(core.isSessionOver(state)).toBe(false);
        expect(normalizeHookEvent({ hook_event_name: "StopFailure" })?.detail).toBe(
            "The turn stopped on an error"
        );
    });

    it("a manual PostCompact returns to the prompt; an automatic one says nothing", () => {
        expect(after({ hook_event_name: "PostCompact", trigger: "manual" })).toBe("idle");
        expect(normalizeHookEvent({ hook_event_name: "PostCompact", trigger: "auto" })).toBeNull();
    });

    it("PreCompact is no longer a reason to show Working", () => {
        expect(normalizeHookEvent({ hook_event_name: "PreCompact" })).toBeNull();
    });

    it("SessionEnd from /clear or a resume does not end the session", () => {
        for (const reason of ["clear", "resume"]) {
            const event = normalizeHookEvent({ hook_event_name: "SessionEnd", reason });
            expect(event?.kind).toBe("session.clear");
            expect(after({ hook_event_name: "SessionEnd", reason }, "idle")).toBe("idle");
        }
    });

    it("SessionEnd for any other reason still ends it", () => {
        expect(after({ hook_event_name: "SessionEnd", reason: "logout" }, "idle")).toBe("stopped");
    });

    it("registers the hooks these transitions need, and not PreCompact", () => {
        const names = CLAUDE_HOOK_EVENTS.map((entry) => entry.event);
        for (const name of [
            "PermissionRequest",
            "StopFailure",
            "PostCompact",
            "SessionStart",
            "Stop"
        ])
            expect(names).toContain(name);
        expect(names).not.toContain("PreCompact");
        const settings = claudeHookSettings("/s/hook.sh") as { hooks: Record<string, unknown> };
        expect(Object.keys(settings.hooks)).toEqual(names);
    });
});

describe("hooks that arrive out of order", () => {
    const at = (n: number): bigint => BigInt(n);

    it("applies a newer event", () => {
        expect(
            core.applySessionEvents(
                { state: "working", seq: at(10) },
                [{ kind: "turn.end" }],
                at(11)
            )
        ).toEqual({ state: "idle", seq: at(11), stale: false });
    });

    it("ignores a tool call that overtook the Stop ending its turn", () => {
        // Stop (seq 20) landed first; the PreToolUse from seq 15 arrives late.
        const settled = core.applySessionEvents(
            { state: "working", seq: at(10) },
            [{ kind: "turn.end" }],
            at(20)
        );
        expect(
            core.applySessionEvents(
                { state: settled.state, seq: settled.seq },
                [{ kind: "tool.start" }],
                at(15)
            )
        ).toEqual({ state: "idle", seq: at(20), stale: true });
    });

    it("applies equal sequences, which is what a seconds-only clock sends", () => {
        expect(
            core.applySessionEvents({ state: "idle", seq: at(5) }, [{ kind: "prompt" }], at(5))
                .state
        ).toBe("working");
    });

    it("applies an event with no sequence, as an older hook script sends", () => {
        expect(
            core.applySessionEvents({ state: "idle", seq: at(5) }, [{ kind: "prompt" }], null)
        ).toEqual({ state: "working", seq: at(5), stale: false });
    });

    it("never reopens a session that is over", () => {
        expect(
            core.applySessionEvents({ state: "stopped", seq: null }, [{ kind: "prompt" }], at(9))
                .state
        ).toBe("stopped");
    });

    it("reads the hook's clock in nanoseconds, whatever date printed", () => {
        expect(core.parseHookSequence("1730000000123456789")).toBe(1730000000123456789n);
        // A date without %N prints seconds and junk: read as whole seconds.
        expect(core.parseHookSequence("1730000000N")).toBe(1730000000000000000n);
        expect(core.parseHookSequence("1730000000%N")).toBe(1730000000000000000n);
        expect(core.parseHookSequence("")).toBeNull();
        expect(core.parseHookSequence(null)).toBeNull();
        expect(core.parseHookSequence("abc")).toBeNull();
        expect(core.parseHookSequence("1".repeat(25))).toBeNull();
    });
});
