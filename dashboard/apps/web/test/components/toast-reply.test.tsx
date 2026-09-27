// @vitest-environment jsdom

/**
 * Answering a message on its note, without going to the conversation.
 *
 * What is pinned: the field opens from the note and pressing it does not open
 * what the note points at; the note does not go while the answer is being
 * written; Enter sends it, and the note says it went and then goes; an answer
 * that did not go says why and keeps what was written.
 */

import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastReply } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

function Raise({ reply, onPress }: { reply: ToastReply; onPress: () => void }) {
    const toast = useToast();
    useEffect(() => {
        toast.show({ key: "message:c1", title: "Ana", body: "are you coming?", onPress, reply });
    }, [toast, reply, onPress]);
    return null;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function draw(send: ToastReply["send"]) {
    const onPress = vi.fn();
    const reply = { placeholder: "Reply to Ana", send };
    render(
        <ToastProvider>
            <Raise reply={reply} onPress={onPress} />
        </ToastProvider>
    );
    return { onPress };
}

describe("answering on the note", () => {
    it("sends what was written, says it went, and then goes - without opening the conversation", async () => {
        const send = vi.fn(async () => null);
        const { onPress } = draw(send);
        fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
        const field = screen.getByRole("textbox", { name: "Reply to Ana" });
        fireEvent.change(field, { target: { value: "  on my way " } });
        await act(async () => {
            fireEvent.keyDown(field, { key: "Enter" });
        });
        expect(send).toHaveBeenCalledWith("on my way");
        expect(onPress).not.toHaveBeenCalled();
        expect(screen.getByText("Sent")).toBeTruthy();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1700));
        });
        expect(screen.queryByText("Ana")).toBeNull();
    });

    it("stays while the answer is being written, past the time a note lasts", async () => {
        vi.useFakeTimers();
        draw(vi.fn(async () => null));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10);
        });
        fireEvent.click(screen.getByRole("button", { name: "Reply" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(screen.getByRole("textbox", { name: "Reply to Ana" })).toBeTruthy();
    });

    it("says why an answer did not go, and keeps it to try again", async () => {
        draw(vi.fn(async () => "You cannot post in this conversation"));
        fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
        const field = screen.getByRole("textbox", { name: "Reply to Ana" });
        fireEvent.change(field, { target: { value: "hello" } });
        await act(async () => {
            fireEvent.keyDown(field, { key: "Enter" });
        });
        expect(screen.getByRole("alert").textContent).toBe("You cannot post in this conversation");
        expect((field as HTMLInputElement).value).toBe("hello");
    });

    it("sends nothing empty", async () => {
        const send = vi.fn(async () => null);
        draw(send);
        fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
        const field = screen.getByRole("textbox", { name: "Reply to Ana" });
        fireEvent.change(field, { target: { value: "   " } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(send).not.toHaveBeenCalled();
    });
});
