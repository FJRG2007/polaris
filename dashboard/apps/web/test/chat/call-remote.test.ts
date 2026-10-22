/**
 * A call worked from a deck: what the tab on the call does with a command, and
 * who may record. A command says where a switch should end up, so the same
 * command arriving twice is still one press.
 */

import { describe, expect, it } from "vitest";
import {
    callRemoteSchema,
    mayRecordCall,
    remoteStep,
    type RemoteControls
} from "../../src/lib/chat/call-remote";

const IDLE: RemoteControls = {
    micOn: true,
    deafened: false,
    cameraOn: false,
    recording: false,
    canRecord: true
};

describe("remoteStep", () => {
    it("flips a switch that is not where the command wants it", () => {
        expect(remoteStep({ command: "mic", on: false }, IDLE)).toBe("toggleMic");
        expect(remoteStep({ command: "deafen", on: true }, IDLE)).toBe("toggleDeafen");
        expect(remoteStep({ command: "camera", on: true }, IDLE)).toBe("toggleCamera");
    });

    it("does nothing for a switch already there, so a repeat is harmless", () => {
        expect(remoteStep({ command: "mic", on: true }, IDLE)).toBeNull();
        expect(remoteStep({ command: "deafen", on: false }, IDLE)).toBeNull();
        expect(remoteStep({ command: "camera", on: false }, IDLE)).toBeNull();
        expect(remoteStep({ command: "record", on: false }, IDLE)).toBeNull();
    });

    it("unmutes a deafened seat the way the mute button does, by undeafening too", () => {
        const deafened = { ...IDLE, micOn: false, deafened: true };
        expect(remoteStep({ command: "mic", on: true }, deafened)).toBe("toggleMic");
        expect(remoteStep({ command: "mic", on: false }, deafened)).toBeNull();
        expect(remoteStep({ command: "mic", on: true }, { ...deafened, micOn: true })).toBe(
            "toggleDeafen"
        );
    });

    it("starts and stops recording, and never starts where it cannot record", () => {
        expect(remoteStep({ command: "record", on: true }, IDLE)).toBe("startRecording");
        expect(remoteStep({ command: "record", on: false }, { ...IDLE, recording: true })).toBe(
            "stopRecording"
        );
        expect(
            remoteStep({ command: "record", on: true }, { ...IDLE, canRecord: false })
        ).toBeNull();
        // Stopping is always allowed, whatever this browser can do.
        expect(
            remoteStep(
                { command: "record", on: false },
                { ...IDLE, recording: true, canRecord: false }
            )
        ).toBe("stopRecording");
    });

    it("always hangs up and always plays a sound", () => {
        expect(remoteStep({ command: "hangup" }, IDLE)).toBe("hangup");
        expect(remoteStep({ command: "sound", played: {} as never }, IDLE)).toBe("sound");
    });
});

describe("callRemoteSchema", () => {
    it("takes a switch with where it should end up, and nothing looser", () => {
        expect(callRemoteSchema.safeParse({ command: "mic", on: true }).success).toBe(true);
        expect(callRemoteSchema.safeParse({ command: "mic" }).success).toBe(false);
        expect(callRemoteSchema.safeParse({ command: "mic", on: "yes" }).success).toBe(false);
        expect(callRemoteSchema.safeParse({ command: "flip" }).success).toBe(false);
        expect(callRemoteSchema.safeParse({ command: "hangup" }).success).toBe(true);
    });
});

describe("mayRecordCall", () => {
    it("lets the host record any call", () => {
        expect(mayRecordCall({ viewerId: "u1", hostId: "u1", channelKind: "public" })).toBe(true);
        expect(mayRecordCall({ viewerId: "u1", hostId: "u1", channelKind: null })).toBe(true);
    });

    it("lets anybody record a direct message or a group, where all are equals", () => {
        expect(mayRecordCall({ viewerId: "u2", hostId: "u1", channelKind: "dm" })).toBe(true);
        expect(mayRecordCall({ viewerId: "u2", hostId: "u1", channelKind: "group" })).toBe(true);
    });

    it("keeps everybody else in a channel's call from recording", () => {
        expect(mayRecordCall({ viewerId: "u2", hostId: "u1", channelKind: "public" })).toBe(false);
        expect(mayRecordCall({ viewerId: "u2", hostId: null, channelKind: null })).toBe(false);
    });

    it("never lets nobody record, even where the host is unknown", () => {
        expect(mayRecordCall({ viewerId: null, hostId: null, channelKind: "dm" })).toBe(false);
        expect(
            mayRecordCall({ viewerId: undefined, hostId: undefined, channelKind: "group" })
        ).toBe(false);
    });
});
