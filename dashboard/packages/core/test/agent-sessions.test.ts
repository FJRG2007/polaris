/**
 * The session state machine and the keystrokes that steer one.
 *
 * Two things here are worth a test rather than a reading. The first is the
 * working/waiting/idle split, because it is what decides whether anybody gets
 * interrupted and it is derived from events rather than asked for. The second is
 * the prompt sanitiser, which is a security boundary: prompts arrive from issues
 * and comments that strangers wrote, and they are delivered by writing bytes into
 * a terminal that a full-screen program is reading.
 */

import { describe, expect, it } from "vitest";
import {
    isSessionListening,
    isSessionOver,
    promptKeystrokes,
    promptSubmitDelayMs,
    replaySessionState,
    sanitizeAgentPrompt,
    sessionBranchName,
    stateAfterEvent
} from "../src/agent-sessions.js";

/** Built rather than typed: a literal escape in a source file is invisible in
 *  every diff and every review that would have to catch it going missing. */
const ESC = String.fromCharCode(27);

describe("what an event says about a session", () => {
    it("treats a tool call as proof the agent is working", () => {
        expect(stateAfterEvent("tool.start")).toBe("working");
    });

    it("says nothing when a tool finishes, so a turn does not flicker to idle mid-way", () => {
        expect(stateAfterEvent("tool.end")).toBeNull();
        expect(stateAfterEvent("tool.failed")).toBeNull();
    });

    it("separates being blocked on a person from having finished", () => {
        expect(stateAfterEvent("permission")).toBe("waiting");
        expect(stateAfterEvent("question")).toBe("waiting");
        expect(stateAfterEvent("turn.end")).toBe("idle");
    });
});

describe("replaySessionState", () => {
    it("settles a reattached session from its history alone", () => {
        expect(
            replaySessionState([
                { kind: "session.start" },
                { kind: "prompt" },
                { kind: "tool.start" },
                { kind: "tool.end" },
                { kind: "turn.end" }
            ])
        ).toBe("idle");
    });

    it("leaves a session blocked on a permission prompt in the state that interrupts somebody", () => {
        expect(
            replaySessionState([{ kind: "prompt" }, { kind: "tool.start" }, { kind: "permission" }])
        ).toBe("waiting");
    });

    it("keeps a session that has reported nothing at whatever it was", () => {
        expect(replaySessionState([], "working")).toBe("working");
    });

    it("does not let a finished session be talked back into working", () => {
        expect(isSessionOver(replaySessionState([{ kind: "session.end" }]))).toBe(true);
        expect(isSessionListening("idle")).toBe(true);
        expect(isSessionListening("working")).toBe(false);
    });
});

describe("sanitizeAgentPrompt", () => {
    it("makes an escape sequence visible instead of letting it drive the terminal", () => {
        const sanitized = sanitizeAgentPrompt(`ship it${ESC}[2J${ESC}[H`);
        expect(sanitized).not.toContain(ESC);
        expect(sanitized).toBe("ship it<ESC>[2J<ESC>[H");
    });

    it("refuses to let a pasted carriage return submit half a prompt", () => {
        expect(sanitizeAgentPrompt("first\r\nsecond\rthird")).toBe("first\nsecond\nthird");
    });

    it("drops the other control characters rather than passing them through", () => {
        expect(sanitizeAgentPrompt(`a${String.fromCharCode(7)}b${String.fromCharCode(127)}c`)).toBe(
            "abc"
        );
    });

    it("leaves ordinary prose exactly as it was written", () => {
        const prose = "Fix the 404 on /apps/deploy - it should be a redirect, not a page.";
        expect(sanitizeAgentPrompt(prose)).toBe(prose);
    });
});

describe("promptKeystrokes", () => {
    it("wraps the prompt in bracketed paste so a newline in it is text, not Enter", () => {
        const { paste, submit } = promptKeystrokes("line one\nline two");
        expect(paste.startsWith(`${ESC}[200~`)).toBe(true);
        expect(paste.endsWith(`${ESC}[201~`)).toBe(true);
        expect(paste).toContain("line one\nline two");
        expect(submit).toBe("\r");
    });

    it("sanitises on the way in, so an escape cannot close the paste early", () => {
        expect(promptKeystrokes(`x${ESC}[201~rm -rf /`).paste).toBe(
            `${ESC}[200~x<ESC>[201~rm -rf /${ESC}[201~`
        );
    });
});

describe("promptSubmitDelayMs", () => {
    it("waits for the fixed cost even on an empty prompt", () => {
        expect(promptSubmitDelayMs(0)).toBe(500);
    });

    it("grows with the prompt rather than capping, which is the mid-paste submit", () => {
        expect(promptSubmitDelayMs(4096)).toBe(501);
        expect(promptSubmitDelayMs(4_096_000)).toBe(1500);
    });
});

describe("sessionBranchName", () => {
    it("reads as the session it belongs to and stays unique", () => {
        expect(
            sessionBranchName("018f2a3b-4c5d-7e8f-9012-3456789abcde", "Fix the login redirect")
        ).toBe("agent/fix-the-login-redirect-018f2a3b");
    });

    it("still names a branch when the title has nothing usable in it", () => {
        expect(sessionBranchName("018f2a3b-4c5d-7e8f-9012-3456789abcde", "***")).toBe(
            "agent/018f2a3b"
        );
    });
});
