// @vitest-environment jsdom

/**
 * Send, and the chevron beside it.
 *
 * The button sends; the chevron holds sending later and putting the message
 * aside as a draft - each only where the box has somewhere for it to go. A
 * task's comment box has neither, so it keeps a plain send button, and a menu
 * that opens onto nothing is never drawn.
 */

import { DEFAULT_CHAT_RULES } from "@polaris/core";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/app/(app)/chat/composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { channelDraftKey, keepDraft, readDraft, savedDrafts } from "@/app/(app)/chat/drafts";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

// jsdom does no layout; ProseMirror asks for coordinates anyway.
if (!document.elementFromPoint) document.elementFromPoint = () => null;
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;

/** Node's own `localStorage` shadows the page's and is off without a file. */
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        clear: () => stored.clear()
    }
});

const KEY = channelDraftKey("c1");

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

function chatBox(extra: Partial<React.ComponentProps<typeof Composer>> = {}) {
    return render(
        <Composer
            channelId="c1"
            draftKey={KEY}
            rules={DEFAULT_CHAT_RULES}
            disabled={false}
            placeholder="Message"
            onSend={() => undefined}
            onSchedule={async () => ({})}
            {...extra}
        />
    );
}

/** What the editor is showing, once it has mounted. */
async function boxText(container: HTMLElement): Promise<string> {
    return waitFor(() => {
        const surface = container.querySelector<HTMLElement>(".ProseMirror");
        if (!surface) throw new Error("the editor did not mount");
        return surface.textContent ?? "";
    });
}

describe("the chevron beside send", () => {
    it("offers sending later and saving a draft in a conversation", async () => {
        keepDraft(KEY, "half a thought");
        const user = userEvent.setup();
        const { container } = chatBox();
        await waitFor(async () => expect(await boxText(container)).toContain("half a thought"));

        await user.click(screen.getByRole("button", { name: "More ways to send" }));
        expect(await screen.findByRole("menuitem", { name: /Schedule message/ })).toBeDefined();
        expect(screen.getByRole("menuitem", { name: /Save as draft/ })).toBeDefined();
    });

    it("opens the send-later dialog from the menu, which is the flow the old button opened", async () => {
        keepDraft(KEY, "for tomorrow");
        const user = userEvent.setup();
        const { container } = chatBox();
        await waitFor(async () => expect(await boxText(container)).toContain("for tomorrow"));

        await user.click(screen.getByRole("button", { name: "More ways to send" }));
        await user.click(await screen.findByRole("menuitem", { name: /Schedule message/ }));
        expect(await screen.findByText("Send this later")).toBeDefined();
        // And there is no second schedule button beside it any more.
        expect(screen.queryByRole("button", { name: "Schedule this message" })).toBeNull();
    });

    it("puts the message aside, empties the box, and lists it over the box", async () => {
        keepDraft(KEY, "not yet");
        const user = userEvent.setup();
        const { container } = chatBox();
        await waitFor(async () => expect(await boxText(container)).toContain("not yet"));

        await user.click(screen.getByRole("button", { name: "More ways to send" }));
        await user.click(await screen.findByRole("menuitem", { name: /Save as draft/ }));

        await waitFor(async () => expect(await boxText(container)).not.toContain("not yet"));
        expect(savedDrafts(KEY).map((draft) => draft.body)).toEqual(["not yet"]);
        // The box's own draft went with the box: coming back does not put the
        // same words in twice, once in the box and once in the list.
        expect(readDraft(KEY)).toBe("");
        expect(screen.getByText(/A saved draft: not yet/)).toBeDefined();
    });

    it("brings a saved draft back into the box", async () => {
        keepDraft(KEY, "first");
        const user = userEvent.setup();
        const { container } = chatBox();
        await waitFor(async () => expect(await boxText(container)).toContain("first"));
        await user.click(screen.getByRole("button", { name: "More ways to send" }));
        await user.click(await screen.findByRole("menuitem", { name: /Save as draft/ }));
        await waitFor(() => expect(savedDrafts(KEY)).toHaveLength(1));

        await user.click(screen.getByText(/A saved draft: first/));
        await user.click(await screen.findByRole("button", { name: /Restore/ }));

        await waitFor(async () => expect(await boxText(container)).toContain("first"));
        expect(savedDrafts(KEY)).toEqual([]);
        // It is the box's draft again, so it survives the tab closing like
        // anything else typed there.
        expect(readDraft(KEY)).toBe("first");
    });

    it("comes back with the conversation: a saved draft is listed on the next visit", async () => {
        keepDraft(KEY, "later");
        const user = userEvent.setup();
        const first = chatBox();
        await waitFor(async () => expect(await boxText(first.container)).toContain("later"));
        await user.click(screen.getByRole("button", { name: "More ways to send" }));
        await user.click(await screen.findByRole("menuitem", { name: /Save as draft/ }));
        await waitFor(() => expect(savedDrafts(KEY)).toHaveLength(1));
        cleanup();

        chatBox();
        expect(await screen.findByText(/A saved draft: later/)).toBeDefined();
    });
});

describe("a box with nowhere to send later or keep a draft", () => {
    it("is a plain send button, as under a task", () => {
        render(
            <Composer
                channelId={null}
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Comment"
                onSend={() => undefined}
            />
        );
        expect(screen.getByRole("button", { name: "Send" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "More ways to send" })).toBeNull();
    });

    it("offers only the draft in a thread, which has no send-later", async () => {
        keepDraft("thread:m1", "in the thread");
        const user = userEvent.setup();
        const { container } = render(
            <Composer
                channelId="c1"
                draftKey="thread:m1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Reply"
                onSend={() => undefined}
            />
        );
        await waitFor(async () => expect(await boxText(container)).toContain("in the thread"));
        await user.click(screen.getByRole("button", { name: "More ways to send" }));
        expect(await screen.findByRole("menuitem", { name: /Save as draft/ })).toBeDefined();
        expect(screen.queryByRole("menuitem", { name: /Schedule message/ })).toBeNull();
    });
});
