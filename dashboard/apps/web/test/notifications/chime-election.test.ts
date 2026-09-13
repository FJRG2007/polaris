/**
 * One sound per person, not per Polaris they have open.
 *
 * The tabs of a browser already agreed between themselves - they share a
 * connection and claim the moment in `localStorage`. The desktop app broke that
 * agreement without breaking any of its parts: it loads the same Polaris, runs the
 * same code, and Electron gives it a storage partition of its own, so its claim and
 * the browser's are written in two places neither can read. Two chimes for one
 * message, and nothing on the clients able to tell.
 *
 * What is tested here is the arbiter that replaced it: which connection of an
 * account is the one told to make the sound.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    chimingClient,
    closeLiveClient,
    liveClientChimes,
    openLiveClient,
    resetLiveClients,
    touchLiveClient,
    type LiveClient
} from "@/lib/notifications/live-clients";

const AT = 1_700_000_000_000;

function client(id: string, kind: "desktop" | "browser", opened: number): LiveClient {
    return { id, kind, opened, seen: opened };
}

beforeEach(() => resetLiveClients());

describe("which connection makes the sound", () => {
    it("has nobody to elect out of nothing", () => {
        expect(chimingClient([])).toBeNull();
    });

    it("elects the only one there is", () => {
        expect(chimingClient([client("a", "browser", AT)])).toBe("a");
    });

    it("prefers the desktop app over a browser", () => {
        // The whole point of the election. The app is the window with an icon in
        // the dock and the one that draws a notice the system shows, so it is
        // where somebody expects the sound to come from - and it wins even though
        // the browser tab was open first.
        const elected = chimingClient([
            client("tab", "browser", AT),
            client("app", "desktop", AT + 5_000)
        ]);
        expect(elected).toBe("app");
    });

    it("gives it to the one open longest when they are the same kind", () => {
        const elected = chimingClient([
            client("second", "browser", AT + 1_000),
            client("first", "browser", AT)
        ]);
        expect(elected).toBe("first");
    });

    it("answers the same whichever order they arrive in", () => {
        // Every connection asks this question separately, and they have to get the
        // same answer: an election that moved with the order would let two clients
        // trade the chime and sound a burst of messages on both.
        const one = client("one", "browser", AT);
        const two = client("two", "desktop", AT);
        const three = client("three", "browser", AT);
        expect(chimingClient([one, two, three])).toBe("two");
        expect(chimingClient([three, two, one])).toBe("two");
    });

    it("breaks a dead heat on the id rather than on chance", () => {
        const elected = chimingClient([client("b", "browser", AT), client("a", "browser", AT)]);
        expect(elected).toBe("a");
    });
});

describe("what the stream asks per frame", () => {
    it("tells a lone browser to chime", () => {
        openLiveClient("u1", "tab", "browser", AT);
        expect(liveClientChimes("u1", "tab", AT)).toBe(true);
    });

    it("silences the browser while the app is open", () => {
        openLiveClient("u1", "tab", "browser", AT);
        openLiveClient("u1", "app", "desktop", AT + 100);
        expect(liveClientChimes("u1", "app", AT + 200)).toBe(true);
        expect(liveClientChimes("u1", "tab", AT + 200)).toBe(false);
    });

    it("hands it back when the app is closed", () => {
        openLiveClient("u1", "tab", "browser", AT);
        openLiveClient("u1", "app", "desktop", AT + 100);
        closeLiveClient("u1", "app");
        expect(liveClientChimes("u1", "tab", AT + 200)).toBe(true);
    });

    it("keeps one account's connections out of another's", () => {
        openLiveClient("u1", "app", "desktop", AT);
        openLiveClient("u2", "tab", "browser", AT);
        // u2 has only their own connection, so the desktop app on somebody else's
        // account is none of their business.
        expect(liveClientChimes("u2", "tab", AT)).toBe(true);
    });

    it("stops believing a connection that never said goodbye", () => {
        // A process killed, or a socket that went away without unwinding. Left
        // believed in, it would hold the election and the device would go deaf -
        // which is the one way this is not allowed to be wrong.
        openLiveClient("u1", "app", "desktop", AT);
        openLiveClient("u1", "tab", "browser", AT + 100);
        expect(liveClientChimes("u1", "tab", AT + 200)).toBe(false);
        expect(liveClientChimes("u1", "tab", AT + 100_000)).toBe(true);
    });

    it("goes on believing a connection that keeps ticking", () => {
        openLiveClient("u1", "app", "desktop", AT);
        openLiveClient("u1", "tab", "browser", AT);
        for (let tick = 5_000; tick <= 100_000; tick += 5_000) {
            touchLiveClient("u1", "app", "desktop", AT + tick);
            touchLiveClient("u1", "tab", "browser", AT + tick);
        }
        expect(liveClientChimes("u1", "tab", AT + 100_000)).toBe(false);
        expect(liveClientChimes("u1", "app", AT + 100_000)).toBe(true);
    });

    it("hears a connection again after its feed stalled past the sweep", () => {
        openLiveClient("u1", "app", "desktop", AT);
        openLiveClient("u1", "tab", "browser", AT);
        // The app's poll hangs on a slow database for longer than a connection is
        // believed in without a word, so the next question sweeps it out from
        // under itself and the tab inherits the sound.
        touchLiveClient("u1", "tab", "browser", AT + 40_000);
        expect(liveClientChimes("u1", "tab", AT + 40_000)).toBe(true);
        // It is still open, and its next tick says so. A connection that could not
        // come back would go on losing an election it is no longer in - the app
        // would never chime again while it was running.
        touchLiveClient("u1", "app", "desktop", AT + 41_000);
        expect(liveClientChimes("u1", "app", AT + 41_000)).toBe(true);
        expect(liveClientChimes("u1", "tab", AT + 41_000)).toBe(false);
    });

    it("puts a connection the cap pushed out back in the election", () => {
        // Sixteen is the cap, and the seventeenth takes the place of the one heard
        // from longest ago - which here is a connection that is still open rather
        // than one nobody is behind.
        openLiveClient("u1", "app", "desktop", AT);
        for (let nth = 1; nth <= 16; nth += 1) openLiveClient("u1", `tab${nth}`, "browser", AT + nth);
        expect(liveClientChimes("u1", "app", AT + 20)).toBe(false);
        touchLiveClient("u1", "app", "desktop", AT + 20);
        expect(liveClientChimes("u1", "app", AT + 20)).toBe(true);
    });

    it("chimes for a caller nothing knows about", () => {
        // Never silent by default: an account with nothing registered - a first
        // frame, a restarted server - is treated as the only client there is.
        expect(liveClientChimes("nobody", "whoever", AT)).toBe(true);
    });
});
