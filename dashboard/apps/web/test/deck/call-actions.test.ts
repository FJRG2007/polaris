/**
 * The call keys: what each one shows in a call and out of one, what a press
 * asks the tab on the call to do, and the refusals its owner reads.
 */

import type { DeckCaller } from "@/lib/deck/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Controls = {
    muted: boolean;
    deafened: boolean;
    camera: boolean;
    recording: boolean;
    sharing: boolean;
};

let live: { controls: Controls; mayRecord: boolean; mutedBeforeDeafen?: boolean } | null = null;
const flipCallSwitch = vi.fn();
const hangUpCall = vi.fn();
const playCallSound = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/chat/chat-guard", () => ({
    guardChat: async <T>(run: () => Promise<T>) => ({ value: await run() })
}));
vi.mock("@/lib/chat/call-remote-service", () => ({
    liveCallOf: async () => live,
    flipCallSwitch,
    hangUpCall,
    playCallSound,
    deckSounds: async () => []
}));

const { callDeckActions, noCallState, switchOn, switchState, callPress } =
    await import("../../src/lib/deck/call-actions");

const { defaultRef } = await import("../../src/lib/chat/soundboard");
const SOUND = defaultRef("applause");

const caller = (locale: DeckCaller["locale"] = "en-US"): DeckCaller => ({
    userId: "u1",
    isAdmin: false,
    keyId: "k1",
    scopes: ["chat.use"],
    locale
});

const action = (id: string) => callDeckActions().find((entry) => entry.id === id)!;

const QUIET: Controls = {
    muted: false,
    deafened: false,
    camera: false,
    recording: false,
    sharing: false
};

beforeEach(() => {
    vi.clearAllMocks();
    live = null;
});

describe("the call keys", () => {
    it("are the call's, under the chat's scope, woken by the call", () => {
        const ids = callDeckActions().map((entry) => entry.id);
        expect(ids).toEqual([
            "call.mic",
            "call.deafen",
            "call.camera",
            "call.record",
            "call.share",
            "call.hangup",
            "call.sound"
        ]);
        for (const entry of callDeckActions()) {
            expect(entry.area).toBe("call");
            expect(entry.scope).toBe("chat.use");
            expect(entry.wakes).toBe("call");
        }
        expect(action("call.mic").kind).toBe("toggle");
        expect(action("call.hangup").kind).toBe("run");
    });
});

describe("out of a call", () => {
    it("every key says so, in its reader's language", async () => {
        for (const entry of callDeckActions()) {
            expect(await entry.read!({}, caller())).toEqual({ tone: "idle", detail: "No call" });
        }
        expect(noCallState("es-ES")).toEqual({ tone: "idle", detail: "Colgado" });
    });

    it("a press does nothing and says why", async () => {
        flipCallSwitch.mockResolvedValue({ ok: false, refusal: "notInCall" });
        hangUpCall.mockResolvedValue({ ok: false, refusal: "notInCall" });
        playCallSound.mockResolvedValue({ ok: false, refusal: "notInCall" });
        const refused = { ok: false, message: "You are not in a call right now." };
        expect(await action("call.mic").run!({}, caller())).toEqual(refused);
        expect(await action("call.hangup").run!({}, caller())).toEqual(refused);
        expect(await action("call.sound").run!({ sound: SOUND }, caller())).toEqual(refused);
    });
});

describe("in a call", () => {
    it("shows the microphone lit and crossed out while muted", async () => {
        live = { controls: { ...QUIET, muted: true }, mayRecord: false };
        expect(await action("call.mic").read!({}, caller())).toMatchObject({
            tone: "warn",
            on: true,
            icon: "mic-off",
            detail: "Muted"
        });
        live = { controls: QUIET, mayRecord: false };
        expect(await action("call.mic").read!({}, caller("es-ES"))).toMatchObject({
            tone: "idle",
            on: false,
            icon: "mic",
            detail: "Mic sí"
        });
    });

    it("shows deafen, camera and recording as the seat last said", async () => {
        live = {
            controls: { ...QUIET, deafened: true, camera: true, recording: true },
            mayRecord: true
        };
        expect(await action("call.deafen").read!({}, caller())).toMatchObject({
            on: true,
            icon: "headphone-off"
        });
        expect(await action("call.camera").read!({}, caller())).toMatchObject({
            tone: "ok",
            on: true,
            icon: "video"
        });
        expect(await action("call.record").read!({}, caller())).toMatchObject({
            tone: "bad",
            on: true,
            detail: "Recording"
        });
        expect(await action("call.hangup").read!({}, caller())).toMatchObject({
            tone: "bad",
            icon: "phone-off",
            detail: "In a call"
        });
    });

    it("muting answers with the key muted: the command is for the microphone", async () => {
        // Asked to turn the microphone off, which is the key on.
        flipCallSwitch.mockResolvedValue({
            ok: true,
            on: false,
            live: { controls: QUIET, mayRecord: false }
        });
        expect(await action("call.mic").run!({}, caller())).toMatchObject({
            ok: true,
            state: switchState("mic", true, "en-US")
        });
        expect(flipCallSwitch).toHaveBeenCalledWith("u1", "mic");
    });

    it("turning the camera on answers with the camera on", async () => {
        flipCallSwitch.mockResolvedValue({
            ok: true,
            on: true,
            live: { controls: QUIET, mayRecord: false }
        });
        expect(await action("call.camera").run!({}, caller())).toMatchObject({
            ok: true,
            state: switchState("camera", true, "en-US")
        });
    });

    it("refuses recording to somebody the call screen would refuse it to", async () => {
        flipCallSwitch.mockResolvedValue({ ok: false, refusal: "mayNotRecord" });
        expect(await action("call.record").run!({}, caller("es-ES"))).toEqual({
            ok: false,
            message: "Solo el anfitrión graba esta llamada."
        });
    });

    it("shows a share lit while the seat is sharing its screen", async () => {
        live = { controls: { ...QUIET, sharing: true }, mayRecord: false };
        expect(await action("call.share").read!({}, caller())).toMatchObject({
            tone: "ok",
            on: true,
            icon: "screen-share",
            detail: "Live"
        });
    });

    it("stopping a share answers with the key off", async () => {
        flipCallSwitch.mockResolvedValue({
            ok: true,
            on: false,
            live: { controls: { ...QUIET, sharing: true }, mayRecord: false }
        });
        expect(await action("call.share").run!({}, caller())).toMatchObject({
            ok: true,
            state: switchState("share", false, "en-US")
        });
        expect(flipCallSwitch).toHaveBeenCalledWith("u1", "share");
    });

    it("starting a share says a screen is to be picked, not that it went live", async () => {
        flipCallSwitch.mockResolvedValue({
            ok: true,
            on: true,
            live: { controls: QUIET, mayRecord: false }
        });
        expect(await action("call.share").run!({}, caller("es-ES"))).toMatchObject({
            ok: true,
            state: { ...switchState("share", false, "es-ES"), detail: "Elige pantalla" }
        });
    });

    it("hanging up leaves the key out of a call", async () => {
        hangUpCall.mockResolvedValue({ ok: true });
        expect(await action("call.hangup").run!({}, caller())).toEqual({
            ok: true,
            state: { tone: "idle", detail: "No call" }
        });
    });

    it("plays the sound picked, and takes only a sound reference", async () => {
        playCallSound.mockResolvedValue({ ok: true });
        expect(await action("call.sound").run!({ sound: SOUND }, caller())).toEqual({
            ok: true
        });
        expect(playCallSound).toHaveBeenCalledWith("u1", SOUND);
        expect(action("call.sound").options.safeParse({}).success).toBe(false);
    });
});

describe("a press drawn before the tab has done it", () => {
    const mic = (on: boolean) => switchState("mic", on, "en-US");
    const deafen = (on: boolean) => switchState("deafen", on, "en-US");

    it("deafening shows the microphone muted too, as the call screen does", async () => {
        live = { controls: QUIET, mayRecord: false };
        expect((await action("call.deafen").read!({}, caller())).press).toEqual({
            face: deafen(true),
            also: [{ action: "call.mic", face: mic(true) }]
        });
    });

    it("undeafening gives the microphone back as it was before", async () => {
        const deafened = { ...QUIET, deafened: true, muted: true };
        live = { controls: deafened, mayRecord: false, mutedBeforeDeafen: false };
        expect((await action("call.deafen").read!({}, caller())).press).toEqual({
            face: deafen(false),
            also: [{ action: "call.mic", face: mic(false) }]
        });
        // Muted before: it stays muted, so the microphone's key is not touched.
        live = { controls: deafened, mayRecord: false, mutedBeforeDeafen: true };
        expect((await action("call.deafen").read!({}, caller())).press).toEqual({
            face: deafen(false)
        });
        // Not seen deafening: what comes back is not guessed.
        live = { controls: deafened, mayRecord: false };
        expect((await action("call.deafen").read!({}, caller())).press).toEqual({
            face: deafen(false)
        });
    });

    it("unmuting while deafened takes the headphones off too", async () => {
        live = { controls: { ...QUIET, deafened: true, muted: true }, mayRecord: false };
        expect((await action("call.mic").read!({}, caller())).press).toEqual({
            face: mic(false),
            also: [{ action: "call.deafen", face: deafen(false) }]
        });
        live = { controls: { ...QUIET, muted: true }, mayRecord: false };
        expect((await action("call.mic").read!({}, caller())).press).toEqual({ face: mic(false) });
    });

    it("hanging up shows every call key out of the call", async () => {
        live = { controls: QUIET, mayRecord: false };
        const press = (await action("call.hangup").read!({}, caller())).press!;
        expect(press.face).toEqual(noCallState("en-US"));
        expect(press.also!.map((also) => also.action)).toEqual([
            "call.mic",
            "call.deafen",
            "call.camera",
            "call.record",
            "call.share",
            "call.sound"
        ]);
        for (const also of press.also!) expect(also.face).toEqual(noCallState("en-US"));
    });

    it("a share or a recording the call will not start keeps its face", () => {
        expect(callPress("record", { controls: QUIET, mayRecord: false }, "en-US")).toEqual({
            noop: true
        });
        expect(callPress("share", { controls: QUIET, mayRecord: false }, "en-US").face).toEqual(
            expect.objectContaining({ on: false, detail: "Pick a screen" })
        );
    });

    it("a deafen run answers with what pressing it again does", async () => {
        flipCallSwitch.mockResolvedValue({
            ok: true,
            on: true,
            live: { controls: QUIET, mayRecord: false }
        });
        const result = await action("call.deafen").run!({}, caller());
        expect(result).toMatchObject({ ok: true, state: deafen(true) });
        expect(result.ok && result.state?.press).toEqual({
            face: deafen(false),
            also: [{ action: "call.mic", face: mic(false) }]
        });
    });
});

describe("switchOn", () => {
    it("reads each switch from the seat's controls", () => {
        const all: Controls = {
            muted: true,
            deafened: true,
            camera: true,
            recording: true,
            sharing: true
        };
        for (const which of ["mic", "deafen", "camera", "record", "share"] as const) {
            expect(switchOn(which, all)).toBe(true);
            expect(switchOn(which, QUIET)).toBe(false);
        }
    });
});

describe("the call keys' names", () => {
    it("are in both catalogs, so a picker never shows a key without one", async () => {
        const catalogs = await Promise.all(
            ["en-US", "es-ES"].map(
                async (locale) =>
                    (await import(`../../messages/${locale}/api.json`)).default as {
                        deck: { actions: Record<string, string> };
                    }
            )
        );
        for (const entry of callDeckActions()) {
            for (const catalog of catalogs)
                expect(catalog.deck.actions[entry.id.replace(".", "_")]).toBeTruthy();
        }
    });
});
