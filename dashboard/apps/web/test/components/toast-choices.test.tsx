// @vitest-environment jsdom

/**
 * An action with several ways of doing it - muting a conversation for an hour,
 * a day, for good - offered on the note itself.
 *
 * What is pinned: pressing the action shows its choices instead of running
 * anything and without opening what the note points at; a choice runs and the
 * note goes; Cancel puts the note back as it was; a choice that did not work
 * says why and keeps the note; the note does not time out while choosing.
 */

import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastAction } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

function Raise({ actions, onPress }: { actions: ToastAction[]; onPress: () => void }) {
    const toast = useToast();
    useEffect(() => {
        toast.show({ key: "message:c1", title: "Ana", body: "are you coming?", onPress, actions });
    }, [toast, actions, onPress]);
    return null;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function draw(hour: () => Promise<string | null>, forever = vi.fn(async () => null)) {
    const onPress = vi.fn();
    const actions: ToastAction[] = [
        {
            label: "Mute chat",
            choices: [
                { label: "1 hour", run: hour },
                { label: "Until I unmute", run: forever }
            ]
        }
    ];
    render(
        <ToastProvider>
            <Raise actions={actions} onPress={onPress} />
        </ToastProvider>
    );
    return { onPress, forever };
}

describe("choices on a note", () => {
    it("shows them instead of running anything, and runs the one picked", async () => {
        const hour = vi.fn(async () => null);
        const { onPress, forever } = draw(hour);

        fireEvent.click(screen.getByRole("button", { name: "Mute chat" }));
        expect(hour).not.toHaveBeenCalled();
        expect(onPress).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
        });
        expect(hour).toHaveBeenCalledOnce();
        expect(forever).not.toHaveBeenCalled();
        expect(screen.queryByText("Ana")).toBeNull();
    });

    it("puts the note back on Cancel", () => {
        draw(vi.fn(async () => null));
        fireEvent.click(screen.getByRole("button", { name: "Mute chat" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("button", { name: "Mute chat" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "1 hour" })).toBeNull();
    });

    it("says why a choice did not work and keeps the note", async () => {
        draw(vi.fn(async () => "That could not be muted"));
        fireEvent.click(screen.getByRole("button", { name: "Mute chat" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
        });
        expect(screen.getByRole("alert").textContent).toBe("That could not be muted");
        expect(screen.getByText("Ana")).toBeTruthy();
    });

    it("does not time out while somebody is choosing", () => {
        vi.useFakeTimers();
        draw(vi.fn(async () => null));
        fireEvent.click(screen.getByRole("button", { name: "Mute chat" }));
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByRole("button", { name: "1 hour" })).toBeTruthy();
    });
});
