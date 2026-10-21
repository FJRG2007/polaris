// @vitest-environment jsdom
/**
 * The caret beside Polar's microphone: the inputs this browser has, with the
 * one in use checked and an offer to ask for names before any permission,
 * and the transcription models grouped by provider, the one in use checked.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { TranscriptionOption } from "@/lib/polar/transcription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { DictationMenu } = await import("@/components/polar/polar-voice");
const { transcriptionOptions } = await import("@/lib/polar/transcription");

let devices: Array<{ kind: string; deviceId: string; label: string }> = [];
const getUserMedia = vi.fn();

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

beforeEach(() => {
    window.localStorage.clear();
    devices = [];
    getUserMedia.mockReset();
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            enumerateDevices: async () => devices,
            getUserMedia,
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    });
});
afterEach(() => cleanup());

const OPTIONS: TranscriptionOption[] = transcriptionOptions(new Set(["openai", "groq"]));

function open(transcriber: string | null, onTranscriber = vi.fn()) {
    render(
        <DictationMenu
            transcribers={OPTIONS}
            transcriber={transcriber}
            onTranscriber={onTranscriber}
        />,
        { wrapper: MessagesWrapper }
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Microphone and model" }), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse"
    });
    return onTranscriber;
}

function checked(item: HTMLElement): boolean {
    return item.querySelector("svg")?.getAttribute("class")?.includes("opacity-100") ?? false;
}

describe("the dictation menu", () => {
    it("lists the models by provider, fastest first, with the one in use checked", async () => {
        const onTranscriber = open("openai/whisper-1");
        fireEvent.click(await screen.findByRole("menuitem", { name: /Model/ }));
        const groq = await screen.findByRole("group", { name: "Groq" });
        const openai = screen.getByRole("group", { name: "OpenAI" });
        expect(
            groq.compareDocumentPosition(openai) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        const whisper = screen.getByRole("menuitem", { name: "Whisper" });
        expect(checked(whisper)).toBe(true);
        expect(checked(screen.getByRole("menuitem", { name: "Whisper Large v3 Turbo" }))).toBe(
            false
        );
        fireEvent.click(screen.getByRole("menuitem", { name: "Whisper Large v3" }));
        expect(onTranscriber).toHaveBeenCalledWith("groq/whisper-large-v3");
    });

    it("lists the microphones, checks the remembered one and remembers a new pick", async () => {
        devices = [
            { kind: "audioinput", deviceId: "built-in", label: "Built-in Microphone" },
            { kind: "audioinput", deviceId: "headset", label: "USB Headset" },
            { kind: "videoinput", deviceId: "camera", label: "Camera" }
        ];
        window.localStorage.setItem("polaris.mic.device", "headset");
        open(null);
        fireEvent.click(await screen.findByRole("menuitem", { name: /^Microphone$/ }));
        const headset = await screen.findByRole("menuitem", { name: "USB Headset" });
        expect(checked(headset)).toBe(true);
        expect(screen.queryByRole("menuitem", { name: "Camera" })).toBeNull();
        expect(screen.queryByText("Allow the microphone to see names")).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Built-in Microphone" }));
        expect(window.localStorage.getItem("polaris.mic.device")).toBe("built-in");
    });

    it("offers to ask for names before any permission, and says when it was refused", async () => {
        devices = [{ kind: "audioinput", deviceId: "one", label: "" }];
        getUserMedia.mockRejectedValue(new Error("NotAllowedError"));
        open(null);
        fireEvent.click(await screen.findByRole("menuitem", { name: /^Microphone$/ }));
        expect(await screen.findByRole("menuitem", { name: "Microphone 1" })).toBeTruthy();
        expect(checked(screen.getByRole("menuitem", { name: "System default" }))).toBe(true);
        fireEvent.click(
            screen.getByRole("menuitem", { name: "Allow the microphone to see names" })
        );
        await waitFor(() =>
            expect(screen.getByText("Blocked. Allow it in the browser.")).toBeTruthy()
        );
        expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    });
});
