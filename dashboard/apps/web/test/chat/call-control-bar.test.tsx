// @vitest-environment jsdom

/**
 * The control bar of a call, laid out the way voice clients draw it: the
 * microphone and the camera as split buttons in one tray, the sharing controls
 * and "more" in a second, and leaving apart. A muted microphone reads red and a
 * camera that is on reads green; the microphone's menu holds its device, its
 * noise profile, the output, the volume, the level and deafening. On a narrow
 * bar the sharing group folds into its "more" menu.
 */

import { CallRoom } from "@/app/(app)/chat/call-room";
import type { CallState } from "@/app/(app)/chat/use-call";
import { NOISE_LEVELS } from "@/app/(app)/chat/mic-cleanup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const recording = { supported: true, seconds: 0, start: () => undefined, stop: () => undefined };
vi.mock("@/app/(app)/chat/call-session", () => ({ useHeldCall: () => ({ recording }) }));
vi.mock("@/app/(app)/chat/meeting-actions", () => ({}));
vi.mock("@/app/(app)/chat/soundboard-actions", () => ({
    callSoundboardAction: async () => ({}),
    favoriteSoundAction: async () => ({}),
    playSoundAction: async () => ({})
}));
vi.mock("@/app/(app)/chat/call-notice-strip", () => ({
    CallNoticeStrip: () => null,
    useCallNotices: () => ({ top: null, rest: [], consequences: [], mic: null })
}));
vi.mock("@/app/(app)/chat/call-hands-panel", () => ({ HandStrip: () => null }));
vi.mock("@/app/(app)/chat/call-combine-panel", () => ({
    CombineRequestDialog: () => null,
    CombineStrip: () => null
}));
vi.mock("@/app/(app)/chat/actions", () => ({ searchPeopleAction: async () => ({ people: [] }) }));
// One output to pick, which jsdom has no way to list.
vi.mock("@/app/(app)/chat/speaker-device", async (original) => ({
    ...(await original<typeof import("@/app/(app)/chat/speaker-device")>()),
    useSpeakers: () => ({
        devices: [{ id: "s1", label: "Fixture headphones" }],
        chosenId: "s1",
        choose: () => undefined
    })
}));

const toggleDeafen = vi.fn();

/** A room of two, with the state under test laid over it. Anything else is a
 *  function that does nothing or an empty value. */
function callWith(over: Record<string, unknown> = {}): CallState {
    const base: Record<string, unknown> = {
        participantId: "p-ada",
        meeting: {
            hostId: "ada",
            participants: [
                { id: "p-ada", userId: "ada", name: "Ada", admission: "admitted" },
                { id: "p-alan", userId: "alan", name: "Alan", admission: "admitted" }
            ]
        },
        screens: new Map(),
        remote: new Map(),
        states: new Map(),
        speaking: new Set(),
        reactions: [],
        hands: [],
        audioMembers: [],
        localScreen: null,
        localStream: null,
        ended: false,
        error: "",
        micOn: true,
        cameraOn: false,
        deafened: false,
        sharing: false,
        microphones: [{ id: "m1", label: "Fixture desk mic" }],
        microphoneId: "m1",
        cameras: [],
        cleanMic: NOISE_LEVELS[0]!.value,
        audio: { ok: true },
        moderation: { serverMuted: false, serverDeafened: false },
        toggleDeafen,
        ...over
    };
    return new Proxy(base, {
        get: (target, key) => {
            if (typeof key !== "string" || key in target) return target[key as string];
            return /^(set|toggle|choose|refresh|pick|flip|combine|ask|answer|leave|lower|react)/.test(
                key
            )
                ? () => undefined
                : undefined;
        }
    }) as unknown as CallState;
}

/** A bar this wide, as the observer reports it once the room has mounted. */
function barWidth(width: number): void {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(private readonly report: ResizeObserverCallback) {}
            observe(element: Element) {
                this.report(
                    [{ target: element, contentRect: { width } } as unknown as ResizeObserverEntry],
                    this as unknown as ResizeObserver
                );
            }
            disconnect() {}
            unobserve() {}
        }
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    toggleDeafen.mockClear();
});

function room(over: Record<string, unknown> = {}, viewerId: string | null = "ada") {
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    return render(
        <CallRoom
            meetingId="m1"
            place="direct"
            viewerId={viewerId ?? undefined}
            call={callWith(over)}
            onLeave={() => undefined}
        />
    );
}

function open(button: HTMLElement): void {
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

const group = (name: RegExp) => screen.getByRole("group", { name });

describe("the call's control bar", () => {
    it("groups the microphone and camera, the sharing controls, and leaves hang-up apart", () => {
        barWidth(900);
        room({ sharing: true });
        const media = group(/bar\.media/);
        expect(within(media).getByRole("button", { name: /callRoom\.mute$/ })).toBeTruthy();
        expect(within(media).getByRole("button", { name: /startVideo/ })).toBeTruthy();
        // Each of the two is a split button: the control and its menu.
        expect(within(media).getAllByRole("button", { name: /deviceSettings/ })).toHaveLength(2);

        const sharing = group(/bar\.sharing/);
        expect(within(sharing).getByRole("button", { name: /stopSharing/ })).toBeTruthy();
        expect(within(sharing).getByRole("button", { name: /callRoom\.react$/ })).toBeTruthy();
        expect(within(sharing).getByRole("button", { name: /moreForThisCall/ })).toBeTruthy();

        const leave = screen.getByRole("button", { name: /leaveTheCall/ });
        expect(leave.closest('[role="group"]')).toBeNull();
        // No third button for deafening: it is in the microphone's menu.
        expect(screen.queryByRole("button", { name: /deafen/i })).toBeNull();
    });

    // One outline per group: the buttons inside draw none of their own (a
    // second border inside the pill), and a neutral one shows a background only
    // on hover. Transparent rather than removed, so nothing resizes on hover.
    it("draws one border per group, none per button", () => {
        barWidth(900);
        room({ sharing: true });
        for (const name of [/bar\.media/, /bar\.sharing/]) {
            const cluster = group(name);
            expect(cluster.className).toContain("[&_button]:border-transparent");
            expect(cluster.className).toContain("[&_button.bg-muted]:bg-transparent");
            expect(cluster.className).toContain("[&_button.bg-muted:hover]:bg-card-hover");
        }
        for (const chevron of screen.getAllByRole("button", { name: /deviceSettings/ })) {
            expect(chevron.className).not.toMatch(/border-l/);
        }
    });

    it("tints a muted microphone red and a camera that is on green", () => {
        room({ micOn: false, cameraOn: true });
        const mic = screen.getByRole("button", { name: /unmute/ });
        const camera = screen.getByRole("button", { name: /stopVideo/ });
        expect(mic.className).toContain("bg-danger-soft");
        expect(camera.className).toContain("bg-success-soft");
        expect(mic.getAttribute("aria-pressed")).toBe("true");
    });

    it("leaves a live microphone and a camera that is off neutral", () => {
        room();
        const mic = screen.getByRole("button", { name: /callRoom\.mute$/ });
        const camera = screen.getByRole("button", { name: /startVideo/ });
        expect(mic.className).not.toMatch(/bg-(danger|success)\/15/);
        expect(camera.className).not.toMatch(/bg-(danger|success)\/15/);
    });

    it("shows a deafened seat on the microphone, in red", () => {
        room({ deafened: true });
        const mic = screen.getByRole("button", { name: /callRoom\.mute$/ });
        expect(mic.className).toContain("bg-danger-soft");
        expect(mic.getAttribute("title")).toMatch(/withKey|youCannotHearAnybodyAnd/);
    });

    it("opens the microphone's menu with its devices, profile, volume, level and deafen", () => {
        room();
        const [micMenu] = within(group(/bar\.media/)).getAllByRole("button", {
            name: /deviceSettings/
        });
        open(micMenu!);
        const menu = screen.getByRole("menu");
        const text = menu.textContent ?? "";
        expect(text).toContain("inputDevice");
        expect(text).toContain("Fixture desk mic");
        expect(text).toContain("inputProfile");
        expect(text).toContain("outputDevice");
        expect(text).toContain("Fixture headphones");
        expect(text).toContain("microphoneVolume");
        expect(text).toContain("inputLevel");
        expect(within(menu).getByRole("slider", { name: /microphoneVolume/ })).toBeTruthy();

        const deafen = within(menu).getByRole("menuitemcheckbox", { name: /deafen/ });
        expect(deafen.getAttribute("aria-checked")).toBe("false");
        fireEvent.click(deafen);
        expect(toggleDeafen).toHaveBeenCalledTimes(1);

        const settings = within(menu).getByRole("menuitem", { name: /voiceSettings/ });
        expect(settings.getAttribute("href")).toBe("/account/devices");
    });

    it("folds the sharing group into its menu on a narrow bar", () => {
        barWidth(360);
        room({ sharing: true });
        const sharing = group(/bar\.sharing/);
        expect(within(sharing).queryByRole("button", { name: /stopSharing/ })).toBeNull();
        expect(within(sharing).queryByRole("button", { name: /callRoom\.react$/ })).toBeNull();
        open(within(sharing).getByRole("button", { name: /moreForThisCall/ }));
        const menu = screen.getByRole("menu");
        expect(within(menu).getByRole("menuitem", { name: /stopSharing/ })).toBeTruthy();
        expect(within(menu).getByRole("menuitem", { name: /callRoom\.react$/ })).toBeTruthy();
        expect(within(menu).getByRole("menuitem", { name: /voiceSettings/ })).toBeTruthy();
    });

    it("never offers a guest the way to the devices screen", () => {
        barWidth(900);
        room({}, null);
        open(within(group(/bar\.media/)).getAllByRole("button", { name: /deviceSettings/ })[0]!);
        const menu = screen.getByRole("menu");
        expect(within(menu).getByRole("menuitemcheckbox", { name: /deafen/ })).toBeTruthy();
        expect(within(menu).queryByRole("menuitem", { name: /voiceSettings/ })).toBeNull();
        cleanup();

        room({}, null);
        const sharing = group(/bar\.sharing/);
        expect(within(sharing).queryByRole("button", { name: /moreForThisCall/ })).toBeNull();
    });

    it("measures the bar before the first paint, not after the observer", () => {
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
            width: 360
        } as DOMRect);
        room({ sharing: true });
        const sharing = group(/bar\.sharing/);
        expect(within(sharing).queryByRole("button", { name: /stopSharing/ })).toBeNull();
        vi.restoreAllMocks();
    });
});
