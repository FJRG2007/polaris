// @vitest-environment jsdom

/**
 * A message costs an open tab no request of its own: the count is asked for
 * once per device, by the tab holding the wire, and handed to the others; and
 * the delivery a server already said is not said again from the device.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (frame: { data: string; owner: boolean }) => void;

const wire = vi.hoisted(() => ({
    handlers: [] as Handler[],
    peers: [] as Array<(message: unknown) => void>,
    posted: [] as unknown[]
}));

vi.mock("@/lib/shared-stream", () => ({
    subscribeSharedStream: (_path: string, _scope: string, handler: Handler) => {
        wire.handlers.push(handler);
        return () => undefined;
    },
    openPeerChannel: (_name: string, _scope: string, onMessage: (message: unknown) => void) => {
        wire.peers.push(onMessage);
        return { post: (message: unknown) => wire.posted.push(message), close: () => undefined };
    }
}));

const { ShelfScopeProvider } = await import("@/components/shelf-scope");
const { ChatUnreadProvider, useChatUnread } = await import("@/components/chat-unread");

function Badge() {
    return <span data-testid="badge">{useChatUnread().messages}</span>;
}

function tab() {
    return render(
        <ShelfScopeProvider shelf="personal">
            <ChatUnreadProvider initial={{ messages: 0, conversations: 0 }} enabled>
                <Badge />
            </ChatUnreadProvider>
        </ShelfScopeProvider>
    );
}

const posted = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ kind: "posted", seq: 1, channels: ["c1"], arrived: ["c1"], ...extra });

let fetches: string[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    wire.handlers = [];
    wire.peers = [];
    wire.posted = [];
    fetches = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            fetches.push(url);
            return new Response(JSON.stringify({ messages: 3, conversations: 1 }), {
                headers: { "content-type": "application/json" }
            });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("a message, on a device with a tab that does not hold the wire", () => {
    it("asks for nothing from that tab once the holder hands the count over", async () => {
        const view = tab();
        const [handler] = wire.handlers;
        await act(async () => {
            handler!({ data: posted({ delivered: true }), owner: false });
            // The holder answered before this tab's wait ran out.
            wire.peers[0]!({ messages: 3, conversations: 1 });
            await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(fetches).toEqual([]);
        expect(view.getByTestId("badge").textContent).toBe("3");
    });
});

describe("a message, on the tab that holds the wire", () => {
    it("asks for the count once and hands it over, and says no delivery the server said", async () => {
        tab();
        const [handler] = wire.handlers;
        await act(async () => {
            handler!({ data: posted({ delivered: true }), owner: true });
            handler!({ data: posted({ delivered: true }), owner: true });
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(fetches).toEqual(["/api/chat/unread"]);
        expect(wire.posted).toEqual([{ messages: 3, conversations: 1 }]);
    });

    it("still says the delivery to a server from before it said it itself", async () => {
        tab();
        const [handler] = wire.handlers;
        await act(async () => {
            handler!({ data: posted(), owner: true });
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(fetches).toEqual(["/api/chat/unread", "/api/chat/delivered"]);
    });
});
