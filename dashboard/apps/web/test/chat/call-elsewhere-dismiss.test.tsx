// @vitest-environment jsdom

/**
 * "You are in a call on another device", left alone.
 *
 * Dismissing the card used to hide it in the one tab it was pressed in: every
 * other open tab kept offering to move the call, and a new tab offered it again.
 * Leaving it is an answer about the call, so it holds in every tab of this
 * browser and after a reload, until a different call comes along.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ ask: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/(app)/chat/call-session", () => ({
    useCallHold: () => ({ session: null, enter: vi.fn() })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({ joinCallAction: vi.fn() }));
vi.mock("@/lib/chat/call-elsewhere-request", () => ({ askCallElsewhere: mocks.ask }));

const { CallElsewhere } = await import("@/app/(app)/chat/call-elsewhere");

const KEY = "polaris.call.elsewhere.dismissed";
const call = (meetingId: string) => ({ meetingId, channelId: "c1", title: "Standup" });

function show() {
    return render(
        <MessagesWrapper>
            <CallElsewhere />
        </MessagesWrapper>
    );
}

/** One browser's storage, shared by every tab rendered in a test. jsdom's own
 *  is not there under every Node the suite runs on. */
function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, String(value))
    };
}

beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    mocks.ask.mockResolvedValue(call("m1"));
});
afterEach(cleanup);

describe("dismissing the call-on-another-device card", () => {
    it("stays dismissed after a reload, for the same call", async () => {
        const first = show();
        fireEvent.click(await screen.findByRole("button", { name: "Leave it" }));
        expect(screen.queryByRole("status")).toBeNull();
        expect(window.localStorage.getItem(KEY)).toBe("m1");
        first.unmount();

        show();
        await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("goes from another open tab the moment it is dismissed in one", async () => {
        show();
        await screen.findByRole("status");
        // What the browser delivers to every other tab when one writes the key.
        act(() => {
            window.localStorage.setItem(KEY, "m1");
            window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "m1" }));
        });
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("asks again for a different call", async () => {
        window.localStorage.setItem(KEY, "m1");
        mocks.ask.mockResolvedValue(call("m2"));
        show();
        expect(await screen.findByRole("status")).toBeTruthy();
    });
});
