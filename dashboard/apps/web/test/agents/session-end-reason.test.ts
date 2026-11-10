import { describe, expect, it } from "vitest";

import { normalizeHookEvent } from "@/lib/agents/session-hooks";

describe("a session that ends says why", () => {
    it("keeps the reason the tool reported", () => {
        const event = normalizeHookEvent({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
        expect(event).toMatchObject({ kind: "session.end", detail: "prompt_input_exit" });
    });

    it("ends with no detail when no reason was given", () => {
        expect(normalizeHookEvent({ hook_event_name: "SessionEnd" })).toMatchObject({ kind: "session.end", detail: "" });
    });

    it("still treats clear and resume as starting over", () => {
        expect(normalizeHookEvent({ hook_event_name: "SessionEnd", reason: "clear" })?.kind).toBe("session.clear");
        expect(normalizeHookEvent({ hook_event_name: "SessionEnd", reason: "resume" })?.kind).toBe("session.clear");
    });
});
