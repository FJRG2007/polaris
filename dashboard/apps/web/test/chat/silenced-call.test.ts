/**
 * A call "who can call you" keeps from ringing is written down as silenced
 * (ledger row 10), at most once per caller and conversation in a window.
 */

import { describe, expect, it } from "vitest";
import { noticeBody } from "@/lib/chat/notice-text";
import { SILENCED_CALL_WINDOW_MS, silencedCallDue } from "@/lib/chat/missed-call";

describe("silenced calls", () => {
    it("reads as a call that was silenced, naming the caller", () => {
        expect(noticeBody("silencedCall", { id: "ana", name: "Ana" }, null)).toBe(
            "[Ana](polaris:user/ana) called - silenced"
        );
    });

    it("writes one line per caller and conversation in a window", () => {
        const start = 1_000_000;
        expect(silencedCallDue("ana", "c1", start)).toBe(true);
        expect(silencedCallDue("ana", "c1", start + 1000)).toBe(false);
        expect(silencedCallDue("ana", "c2", start + 1000)).toBe(true);
        expect(silencedCallDue("bob", "c1", start + 1000)).toBe(true);
        expect(silencedCallDue("ana", "c1", start + SILENCED_CALL_WINDOW_MS)).toBe(true);
    });
});
