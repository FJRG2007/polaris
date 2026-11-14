// @vitest-environment jsdom

/**
 * The switch moves at once, comes back only on a refusal, and quick presses never
 * let an older answer overwrite a newer one.
 */

import { MessagesWrapper } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { refusalOf, useOptimisticToggle } from "@/lib/use-optimistic-toggle";

/** An action whose answers the test hands out one at a time. */
function controlled() {
    const calls: { next: boolean; answer: (result: unknown) => void }[] = [];
    const action = vi.fn(
        (next: boolean) =>
            new Promise<unknown>((resolve) => {
                calls.push({ next, answer: resolve });
            })
    );
    return { action, calls };
}

function mount(
    server: boolean,
    action: (next: boolean) => Promise<unknown>,
    options: Parameters<typeof useOptimisticToggle>[2] = {}
) {
    return renderHook(
        ({ value }: { value: boolean }) => useOptimisticToggle(value, action, options),
        { initialProps: { value: server }, wrapper: MessagesWrapper }
    );
}

describe("useOptimisticToggle", () => {
    it("flips before the server answers and keeps it once saved", async () => {
        const { action, calls } = controlled();
        const onSaved = vi.fn();
        const { result } = mount(false, action, { onSaved });

        act(() => result.current[1]());
        expect(result.current[0]).toBe(true);
        expect(result.current[2]).toBe(true);
        expect(action).toHaveBeenCalledWith(true);

        await act(async () => calls[0]!.answer({}));
        expect(result.current[0]).toBe(true);
        expect(result.current[2]).toBe(false);
        expect(onSaved).toHaveBeenCalledWith(true);
    });

    it("rolls back and reports the server's reason on a refusal", async () => {
        const { action, calls } = controlled();
        const onRefused = vi.fn();
        const { result } = mount(true, action, { onRefused });

        act(() => result.current[1](false));
        expect(result.current[0]).toBe(false);

        await act(async () => calls[0]!.answer({ error: "Not allowed here" }));
        expect(result.current[0]).toBe(true);
        expect(onRefused).toHaveBeenCalledWith("Not allowed here");
    });

    it("rolls back with a readable sentence when the action throws", async () => {
        const onRefused = vi.fn();
        const { result } = mount(false, () => Promise.reject(new Error("socket closed")), {
            onRefused
        });

        await act(async () => result.current[1]());
        expect(result.current[0]).toBe(false);
        expect(onRefused).toHaveBeenCalledWith("That change was not saved. It is back to how it was.");
    });

    it("serializes quick presses so the last one wins", async () => {
        const { action, calls } = controlled();
        const { result } = mount(false, action);

        act(() => result.current[1]());
        act(() => result.current[1]());
        act(() => result.current[1]());
        // Still one request in flight; the screen shows the latest press.
        expect(calls).toHaveLength(1);
        expect(result.current[0]).toBe(true);

        await act(async () => calls[0]!.answer({}));
        // The first save held `true`, which is also the latest intent: nothing more to send.
        expect(calls).toHaveLength(1);

        act(() => result.current[1]());
        act(() => result.current[1]());
        await act(async () => calls[1]!.answer({}));
        expect(calls.map((call) => call.next)).toEqual([true, false, true]);
        await act(async () => calls[2]!.answer({}));
        expect(result.current[0]).toBe(true);
        expect(result.current[2]).toBe(false);
    });

    it("does not send when a press is undone before the save starts", async () => {
        const { action, calls } = controlled();
        const { result } = mount(false, action);

        act(() => result.current[1]());
        act(() => result.current[1]());
        await act(async () => calls[0]!.answer({}));
        // The first went out as `true`; the undo then rides on the next save.
        expect(calls.map((call) => call.next)).toEqual([true, false]);
        await act(async () => calls[1]!.answer({}));
        expect(result.current[0]).toBe(false);
    });

    it("follows a new server value while nothing is in flight", () => {
        const { action } = controlled();
        const { result, rerender } = mount(false, action);

        rerender({ value: true });
        expect(result.current[0]).toBe(true);
    });
});

describe("refusalOf", () => {
    it("reads the shapes actions answer with", () => {
        expect(refusalOf(undefined)).toBeNull();
        expect(refusalOf({})).toBeNull();
        expect(refusalOf({ ok: true })).toBeNull();
        expect(refusalOf({ error: "No" })).toEqual({ message: "No" });
        expect(refusalOf({ ok: false })).toEqual({ message: null });
        expect(refusalOf({ error: true })).toEqual({ message: null });
    });
});
