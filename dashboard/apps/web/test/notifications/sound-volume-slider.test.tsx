// @vitest-environment jsdom

/**
 * The volume slider: applied as it moves, saved once it settles, put back when
 * the server refuses it, and not saved at all when it ends where it started.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    }
});

const save = vi.fn(async (_input: { volume: number }) => ({}) as { error?: string });

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/account/notifications/actions", () => ({
    saveNotificationRuleAction: vi.fn(),
    saveSoundVolumeAction: (input: { volume: number }) => save(input),
    createDestinationAction: vi.fn(),
    deleteDestinationAction: vi.fn(),
    setDestinationEnabledAction: vi.fn(),
    testDestinationAction: vi.fn(),
    createSmsSenderAction: vi.fn(),
    deleteSmsSenderAction: vi.fn(),
    saveSmsSenderAction: vi.fn(),
    testSmsSenderAction: vi.fn()
}));

const { NotificationSettingsView } = await import(
    "@/app/(app)/account/notifications/notification-settings-view"
);
const sound = await import("@/lib/notification-sound");

function slider(): HTMLInputElement {
    return screen.getByLabelText("Sound volume") as HTMLInputElement;
}

beforeEach(() => {
    vi.useFakeTimers();
    save.mockClear();
    save.mockImplementation(async () => ({}));
    sound.adoptSoundVolume(100);
    render(<NotificationSettingsView rules={[]} destinations={[]} senders={[]} deliveries={[]} />);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the volume slider", () => {
    it("applies at once and saves once it settles", async () => {
        fireEvent.change(slider(), { target: { value: "40" } });
        fireEvent.change(slider(), { target: { value: "35" } });
        expect(sound.soundVolume()).toBe(35);
        expect(save).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith({ volume: 35 });
        expect(slider().value).toBe("35");
    });

    it("puts the volume back when the save is refused", async () => {
        save.mockImplementation(async () => ({ error: "Pick a volume between 0 and 100." }));
        fireEvent.change(slider(), { target: { value: "20" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        expect(sound.soundVolume()).toBe(100);
        expect(slider().value).toBe("100");
        expect(screen.getByText("Pick a volume between 0 and 100.")).toBeTruthy();
    });

    it("saves nothing when it ends where it started", async () => {
        fireEvent.change(slider(), { target: { value: "50" } });
        fireEvent.change(slider(), { target: { value: "100" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });
        expect(save).not.toHaveBeenCalled();
    });
});
