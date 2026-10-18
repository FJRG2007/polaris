// @vitest-environment jsdom

/**
 * How a message's note is drawn: as a phone draws a conversation's notice.
 *
 * What is pinned: the face, who wrote it, where, and the words are on it; its
 * actions are icons that still carry a name; answering opens a field in place
 * and sends; a note standing for several messages shows how many and the last
 * lines; the keyboard reaches opening it and Escape sends it away; and a note
 * that is not about a conversation is drawn exactly as before.
 */

import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type Toast } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
    cleanup();
});

function Raise({ toast }: { toast: Toast }) {
    const api = useToast();
    useEffect(() => api.show(toast), [api, toast]);
    return null;
}

function draw(overrides: Partial<Toast> = {}) {
    const onPress = vi.fn();
    const send = vi.fn(async () => null);
    const mute = vi.fn(async () => null);
    const read = vi.fn(async () => null);
    const onGone = vi.fn();
    const toast: Toast = {
        key: "message:c1",
        title: "Ana in general",
        body: "are you coming?",
        icon: <span data-testid="face" />,
        onPress,
        onGone,
        reply: { placeholder: "Reply to Ana", send },
        actions: [
            {
                label: "Mute chat",
                icon: <span data-testid="mute-icon" />,
                choices: [{ label: "1 hour", run: mute }]
            },
            { label: "Mark as read", icon: <span data-testid="read-icon" />, run: read }
        ],
        conversation: {
            sender: "Ana",
            where: "#general",
            lines: [{ id: "m-1", text: "are you coming?" }],
            count: 1,
            countLabel: "1 messages"
        },
        ...overrides
    };
    render(
        <ToastProvider>
            <Raise toast={toast} />
        </ToastProvider>
    );
    return { onPress, send, mute, read, onGone };
}

describe("a message's note", () => {
    it("shows the face, who, where and what was said", async () => {
        draw();
        expect(await screen.findByTestId("face")).toBeTruthy();
        expect(screen.getByText("Ana")).toBeTruthy();
        expect(screen.getByText("#general")).toBeTruthy();
        expect(screen.getByText("are you coming?")).toBeTruthy();
        // One message is not a stack: no count.
        expect(screen.queryByText("1 messages")).toBeNull();
    });

    it("draws its actions as icons that keep their names", async () => {
        draw();
        for (const name of ["Reply", "Mute chat", "Mark as read", "Dismiss"]) {
            const button = await screen.findByRole("button", { name });
            expect(button.getAttribute("title")).toBe(name);
            // The words are not drawn: only the icon is.
            expect(button.textContent).toBe("");
        }
    });

    it("opens a field in place to answer, and sends it without opening the chat", async () => {
        const { send, onPress } = draw();
        fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
        const field = screen.getByRole("textbox", { name: "Reply to Ana" });
        // The icons give way to the field.
        expect(screen.queryByRole("button", { name: "Mark as read" })).toBeNull();
        fireEvent.change(field, { target: { value: " on my way " } });
        await act(async () => {
            fireEvent.keyDown(field, { key: "Enter" });
        });
        expect(send).toHaveBeenCalledWith("on my way");
        expect(screen.getByText("Sent")).toBeTruthy();
        expect(onPress).not.toHaveBeenCalled();
    });

    it("closes the field on Escape without sending the note away", async () => {
        const { onGone } = draw();
        fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
        expect(onGone).not.toHaveBeenCalled();
    });

    it("offers a mute's lengths on the note, then mutes", async () => {
        const { mute } = draw();
        fireEvent.click(await screen.findByRole("button", { name: "Mute chat" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
        });
        expect(mute).toHaveBeenCalledOnce();
    });

    it("marks read from its icon, and goes", async () => {
        const { read, onGone } = draw();
        await act(async () => {
            fireEvent.click(await screen.findByRole("button", { name: "Mark as read" }));
        });
        expect(read).toHaveBeenCalledOnce();
        expect(onGone).toHaveBeenCalledOnce();
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("stacks several messages: the count and the last lines, each named", async () => {
        draw({
            conversation: {
                sender: "Bruno",
                where: "#general",
                lines: [
                    { id: "m-1", author: "Ana", text: "first" },
                    { id: "m-2", author: "Ana", text: "second" },
                    { id: "m-3", author: "Bruno", text: "third" },
                    { id: "m-4", author: "Ana", text: "fourth" }
                ],
                count: 4,
                countLabel: "4 messages"
            }
        });
        expect(await screen.findByText("4 messages")).toBeTruthy();
        expect(screen.queryByText("first")).toBeNull();
        for (const text of ["second", "third", "fourth"]) {
            expect(screen.getByText(text)).toBeTruthy();
        }
    });

    it("opens the conversation from the keyboard, and Escape sends it away", async () => {
        const { onPress } = draw();
        const open = (await screen.findByText("are you coming?")).closest("button");
        expect(open).toBeTruthy();
        fireEvent.click(open!);
        expect(onPress).toHaveBeenCalledOnce();

        cleanup();
        const second = draw();
        const note = await screen.findByRole("status");
        fireEvent.keyDown(note, { key: "Escape" });
        expect(screen.queryByRole("status")).toBeNull();
        expect(second.onGone).toHaveBeenCalledOnce();
    });

    it("goes when swiped sideways, and stays when barely moved", async () => {
        const { onPress, onGone } = draw();
        const words = await screen.findByText("are you coming?");
        const card = words.closest("button")!.parentElement!;
        fireEvent.pointerDown(card, { button: 0, clientX: 100, pointerId: 1 });
        fireEvent.pointerMove(card, { clientX: 104, pointerId: 1 });
        fireEvent.pointerUp(card, { pointerId: 1 });
        expect(onGone).not.toHaveBeenCalled();

        fireEvent.pointerDown(card, { button: 0, clientX: 100, pointerId: 1 });
        fireEvent.pointerMove(card, { clientX: 250, pointerId: 1 });
        fireEvent.pointerUp(card, { pointerId: 1 });
        expect(onGone).toHaveBeenCalledOnce();
        expect(onPress).not.toHaveBeenCalled();
    });

    it("leaves every other note as it was", async () => {
        draw({ conversation: undefined });
        const note = await screen.findByRole("status");
        expect(note.hasAttribute("data-conversation-note")).toBe(false);
        // The plain note names its actions in words.
        expect(screen.getByRole("button", { name: "Mark as read" }).textContent).toContain(
            "Mark as read"
        );
    });
});
