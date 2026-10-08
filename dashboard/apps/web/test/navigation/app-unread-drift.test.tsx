// @vitest-environment jsdom

/**
 * What a mark made in the app menu does to the badges before the server has it:
 * the number moves at once, goes back if the mark is refused, and once the
 * app's own count has moved, a refusal has nothing left to take back - the
 * badge is the server's number again, not that number plus the mark.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let chat = 5;

vi.mock("@/components/chat-unread", () => ({
    useChatUnread: () => ({ messages: chat, conversations: 1 })
}));
vi.mock("@/components/mail-unread", () => ({ useMailUnread: () => ({ messages: 0 }) }));
vi.mock("@/components/admin-waiting", () => ({ useAdminWaiting: () => ({ total: 0 }) }));

const { AppUnreadDriftProvider, useAppUnread, useNudgeAppUnread } = await import(
    "@/components/app-unread"
);

let shown = -1;
let nudge: ReturnType<typeof useNudgeAppUnread> = () => () => undefined;

function Badge() {
    shown = useAppUnread().chat ?? 0;
    nudge = useNudgeAppUnread();
    return null;
}

function Shell() {
    return (
        <AppUnreadDriftProvider>
            <Badge />
        </AppUnreadDriftProvider>
    );
}

beforeEach(() => {
    chat = 5;
});
afterEach(cleanup);

describe("a badge moved by the app menu", () => {
    it("moves at once and goes back when the mark is refused", () => {
        render(<Shell />);
        let undo = () => undefined as void;
        act(() => {
            undo = nudge("chat", -3);
        });
        expect(shown).toBe(2);
        act(() => undo());
        expect(shown).toBe(5);
    });

    it("is the server's number once that has moved, refused or not", () => {
        const view = render(<Shell />);
        let undo = () => undefined as void;
        act(() => {
            undo = nudge("chat", -3);
        });
        // A message arrived while the mark was on its way.
        chat = 6;
        view.rerender(<Shell />);
        expect(shown).toBe(6);
        act(() => undo());
        expect(shown).toBe(6);
    });
});
