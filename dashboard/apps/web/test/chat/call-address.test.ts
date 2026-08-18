/**
 * Working out where to dial the call server from inside the browser.
 *
 * The whole point of the path form is that nobody maintains an address: one
 * deployment is reached at `polaris.local` from the sofa and at a domain from a
 * phone on mobile data, and the call server is on whichever of those the reader
 * actually used. Only the page knows that, so only the page can answer it.
 *
 * The scheme is the half that silently breaks calls. A browser on HTTPS refuses
 * to open a plain WebSocket, so an address that comes back as `ws://` on an
 * HTTPS page is one the call never reaches - it fails before a byte is sent,
 * and what it looks like from a chair is a call that connects to silence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { callServerUrl } = await import("@/app/(app)/chat/call-address");

/** Stand the module on a page at a given origin. */
function pageAt(protocol: string, host: string): void {
    vi.stubGlobal("window", { location: { protocol, host } });
}

afterEach(() => vi.unstubAllGlobals());

describe("a path, which is what this instance's own call server is", () => {
    it("takes the host the reader actually reached Polaris on", () => {
        pageAt("http:", "polaris.local");
        expect(callServerUrl("/livekit")).toBe("ws://polaris.local/livekit");
    });

    it("follows the same page to a different host, with nothing reconfigured", () => {
        // The phone. Same deployment, same .env, different address - and this is
        // the case a written-down hostname gets wrong.
        pageAt("https:", "polaris.example.com");
        expect(callServerUrl("/livekit")).toBe("wss://polaris.example.com/livekit");
    });

    it("keeps a non-default port, since that is part of the host", () => {
        pageAt("http:", "192.168.1.10:8080");
        expect(callServerUrl("/livekit")).toBe("ws://192.168.1.10:8080/livekit");
    });

    it("leaves no doubled slash where the client appends its own", () => {
        pageAt("https:", "polaris.example.com");
        expect(callServerUrl("/livekit/")).toBe("wss://polaris.example.com/livekit");
    });
});

describe("a whole address, which is a server somebody else runs", () => {
    it("is dialled as written", () => {
        pageAt("https:", "polaris.example.com");
        expect(callServerUrl("wss://calls.example.com")).toBe("wss://calls.example.com");
        expect(callServerUrl("ws://calls.example.com:7880")).toBe("ws://calls.example.com:7880");
    });

    it("is dialled as a socket when it was written as a page", () => {
        pageAt("https:", "polaris.example.com");
        expect(callServerUrl("https://calls.example.com")).toBe("wss://calls.example.com");
        expect(callServerUrl("http://calls.example.com")).toBe("ws://calls.example.com");
    });

    it("never takes the page's host", () => {
        pageAt("https:", "polaris.example.com");
        expect(callServerUrl("wss://calls.example.com")).not.toContain("polaris.example.com");
    });
});
