/**
 * A call survives a link being clicked.
 *
 * The client library hangs up on `beforeunload` unless told not to, and that
 * event fires the moment a link is followed - including one the desktop app
 * cancels and opens in the system browser, so the page never leaves. The
 * listener is only attached once a room connects, which needs a call server,
 * so what is asserted is the option the room actually ends up with, read back
 * from the real client: ours, and the library's default it overrides.
 */

import { Room } from "livekit-client";
import { describe, expect, it } from "vitest";
import { CALL_ROOM_OPTIONS } from "@/app/(app)/chat/call-room-options";

describe("call room options", () => {
    it("leaves hanging up on a page leave to the call hook", () => {
        expect(new Room(CALL_ROOM_OPTIONS).options.disconnectOnPageLeave).toBe(false);
    });

    it("overrides a default that would hang up on a clicked link", () => {
        expect(new Room().options.disconnectOnPageLeave).toBe(true);
    });

    it("keeps the rest of what every call is opened with", () => {
        const { options } = new Room(CALL_ROOM_OPTIONS);
        expect(options.dynacast).toBe(true);
        expect(options.stopLocalTrackOnUnpublish).toBe(false);
        expect(options.publishDefaults?.videoCodec).toBe("vp9");
    });
});
