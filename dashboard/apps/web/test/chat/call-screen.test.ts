/**
 * Asking a browser for a screen, and what is remembered about one that cannot
 * carry its sound.
 *
 * The press that opens the picker is spent by the first request, so the retry
 * that follows a rejection is liable to be refused before a picker appears. A
 * browser that has once said it cannot carry a screen's sound is therefore not
 * asked again: the first request has to be the one that works.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    }
});

const asked: MediaStreamConstraints[] = [];
const screen = { id: "screen" } as unknown as MediaStream;
let answer: (constraints: MediaStreamConstraints) => Promise<MediaStream>;

vi.stubGlobal("navigator", {
    mediaDevices: {
        getDisplayMedia: (constraints: MediaStreamConstraints) => {
            asked.push(constraints);
            return answer(constraints);
        }
    }
});

const { openScreen } = await import("../../src/app/(app)/chat/call-media");

const failure = (name: string) => Object.assign(new Error(name), { name });
/** A browser that takes a picture but rejects the whole request over the sound. */
const pictureOnly = async (constraints: MediaStreamConstraints) => {
    if (constraints.audio) throw failure("NotSupportedError");
    return screen;
};

beforeEach(() => {
    store.clear();
    asked.length = 0;
    answer = async () => screen;
});

describe("asking for a screen", () => {
    it("asks for its sound as well, where nothing says otherwise", async () => {
        await expect(openScreen({})).resolves.toBe(screen);
        expect(asked).toHaveLength(1);
        expect(asked[0]!.audio).toBeTruthy();
    });

    it("asks again for the picture alone where the sound is refused", async () => {
        answer = pictureOnly;
        await expect(openScreen({})).resolves.toBe(screen);
        expect(asked).toHaveLength(2);
        expect(asked[1]!.audio).toBeUndefined();
    });

    it("does not ask that browser for sound a second time", async () => {
        answer = pictureOnly;
        await openScreen({});
        asked.length = 0;
        await expect(openScreen({})).resolves.toBe(screen);
        expect(asked).toHaveLength(1);
        expect(asked[0]!.audio).toBeUndefined();
    });

    it("takes a refusal as the answer, without asking again", async () => {
        answer = async () => {
            throw failure("NotAllowedError");
        };
        await expect(openScreen({})).rejects.toThrow();
        expect(asked).toHaveLength(1);

        // Cancelling the picker says nothing about the sound, so the next press
        // still asks for it.
        answer = async () => screen;
        await openScreen({});
        expect(asked[1]!.audio).toBeTruthy();
    });
});
