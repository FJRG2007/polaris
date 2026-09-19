// @vitest-environment jsdom

/**
 * The badges follow the shelf switch.
 *
 * The switch re-renders the frame with the new shelf's counts, but a provider
 * that took its count with `useState(initial)` kept the one it was born with -
 * so the badge went on saying Mail had three waiting over a shelf whose Mail had
 * none. What is asserted is that a switch takes the server's new seed, and that
 * anything else leaves alone a count the page has since moved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { notificationStreamPath } from "@/lib/notifications/stream-path";
import { ShelfScopeProvider, useShelfSeed } from "@/components/shelf-scope";
import { ChatUnreadProvider, useChatUnread } from "@/components/chat-unread";
import { MailUnreadProvider, useMailUnread } from "@/components/mail-unread";

afterEach(cleanup);

function Badges() {
    return (
        <span data-testid="badges">
            {useMailUnread().messages}/{useChatUnread().messages}
        </span>
    );
}

function Frame({ shelf, mail, chat }: { shelf: string; mail: number; chat: number }) {
    return (
        <ShelfScopeProvider shelf={shelf}>
            <ChatUnreadProvider initial={{ messages: chat, conversations: chat ? 1 : 0 }} enabled={false}>
                <MailUnreadProvider initial={{ messages: mail, mailboxes: mail ? 1 : 0 }} enabled={false}>
                    <Badges />
                </MailUnreadProvider>
            </ChatUnreadProvider>
        </ShelfScopeProvider>
    );
}

describe("a badge across a shelf switch", () => {
    it("shows the new shelf's count as soon as the shelf changes", () => {
        const view = render(<Frame shelf="acme" mail={3} chat={4} />);
        expect(view.getByTestId("badges").textContent).toBe("3/4");

        view.rerender(<Frame shelf="personal" mail={0} chat={1} />);
        expect(view.getByTestId("badges").textContent).toBe("0/1");
    });
});

describe("the bell's live feed across a shelf switch", () => {
    it("is a different address per shelf, so switching opens the new shelf's feed", () => {
        // A connection is served the shelf that was open when it opened; one
        // address for every shelf would keep feeding the shelf just left.
        expect(notificationStreamPath("acme")).toContain("shelf=acme");
        expect(notificationStreamPath("personal")).not.toBe(notificationStreamPath("acme"));
    });
});

describe("state seeded per shelf", () => {
    let set: ((value: number) => void) | null = null;

    function Counter({ initial }: { initial: number }) {
        const [value, setValue] = useShelfSeed(initial);
        set = setValue;
        return <span data-testid="count">{value}</span>;
    }

    it("keeps what the page moved it to while the shelf stays put", () => {
        const view = render(
            <ShelfScopeProvider shelf="personal">
                <Counter initial={2} />
            </ShelfScopeProvider>
        );
        act(() => set?.(7));
        // A refresh of the frame on the same shelf is not a reason to throw away
        // a count the live channel has already brought up to date.
        view.rerender(
            <ShelfScopeProvider shelf="personal">
                <Counter initial={2} />
            </ShelfScopeProvider>
        );
        expect(view.getByTestId("count").textContent).toBe("7");

        view.rerender(
            <ShelfScopeProvider shelf="acme">
                <Counter initial={5} />
            </ShelfScopeProvider>
        );
        expect(view.getByTestId("count").textContent).toBe("5");
    });
});
