/**
 * Asking where this account's call is, from the browser.
 *
 * It used to be a server action fired by the frame of every screen as it was
 * drawn - which put a router action in flight during the first hydration and,
 * on a visit that redirected, crashed the tab (React #310). It is a plain GET now;
 * these pin that it stays one and that every failure still reads as "no call".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { askCallElsewhere, CALL_ELSEWHERE_PATH } from "@/lib/chat/call-elsewhere-request";

const call = { meetingId: "m1", channelId: "c1", participantId: "p1", title: "Grace" };

function answer(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe("askCallElsewhere", () => {
    it("asks the route with a plain uncached GET", async () => {
        const fetch = answer({ call });
        vi.stubGlobal("fetch", fetch);
        await askCallElsewhere();
        expect(fetch).toHaveBeenCalledWith(CALL_ELSEWHERE_PATH, { cache: "no-store" });
    });

    it("hands back the call the route found", async () => {
        vi.stubGlobal("fetch", answer({ call }));
        expect(await askCallElsewhere()).toEqual(call);
    });

    it("reads no call as null", async () => {
        vi.stubGlobal("fetch", answer({ call: null }));
        expect(await askCallElsewhere()).toBeNull();
    });

    it("reads a refusal as no call", async () => {
        vi.stubGlobal("fetch", answer({ error: "Unauthorized" }, 401));
        expect(await askCallElsewhere()).toBeNull();
    });

    it("reads an answer of the wrong shape as no call", async () => {
        vi.stubGlobal("fetch", answer({ call: { meetingId: 7 } }));
        expect(await askCallElsewhere()).toBeNull();
    });

    it("reads a network failure as no call", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            })
        );
        expect(await askCallElsewhere()).toBeNull();
    });
});
