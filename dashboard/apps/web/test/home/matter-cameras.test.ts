import { describe, expect, it } from "vitest";
import * as code from "@polaris-app/places/src/lib/matter-code";
import * as signaling from "../../../../services/matter-bridge/src/signaling.mjs";
import { backchannelCodec, talkPlayQuery } from "@polaris-app/places/src/lib/relay";
import { talkCodecFor } from "@polaris-app/places/src/lib/talk";
import { talkSupport } from "@polaris-app/places/src/lib/vendors";
import { parseCameraInput } from "@polaris-app/places/src/lib/schemas";
import { DEFAULT_DETECTION } from "@polaris-app/places/src/lib/detection";
import { cameraModel, searchModels, vendorForModel } from "@polaris-app/places/src/lib/camera-models";
import { commissionSentence } from "@polaris-app/places/src/lib/matter-bridge";
import { placesRefusalText } from "@polaris-app/places/src/lib/refusal-text";
import { placesCatalogs } from "@polaris-app/places/messages";

describe("Matter pairing codes", () => {
    it("accepts the specification's example manual codes and their spaced form", () => {
        // Matter Core spec 5.1.4.1 example: 3497-0112-332 (check digit 2).
        expect(code.matterCodeIssue("34970112332")).toBeNull();
        expect(code.matterCodeIssue(" 3497-0112-332 ")).toBeNull();
    });

    it("catches a mistyped digit with the check digit", () => {
        expect(code.matterCodeIssue("34970112333")).toBe("check");
        expect(code.matterCodeIssue("34971112332")).toBe("check");
    });

    it("calls a short or empty code unfinished, not wrong", () => {
        expect(code.matterCodeIssue("")).toBe("incomplete");
        expect(code.matterCodeIssue("3497")).toBe("incomplete");
    });

    it("refuses letters, wrong lengths and an impossible first digit", () => {
        expect(code.matterCodeIssue("3497a112332")).toBe("format");
        expect(code.matterCodeIssue("349701123321")).toBe("format");
        expect(code.matterCodeIssue("94970112332")).toBe("format");
    });

    it("takes a QR code's text and upper-cases it", () => {
        expect(code.normalizeMatterCode("mt:y.k90afn00ka0648g00")).toBe("MT:Y.K90AFN00KA0648G00");
        expect(code.matterCodeIssue("MT:Y.K90AFN00KA0648G00")).toBeNull();
        expect(code.matterCodeIssue("MT:short")).toBe("format");
    });

    it("keeps where a camera lives as a path that reads back", () => {
        expect(code.matterStreamPath(12, 1)).toBe("/cameras/12/1");
        expect(code.parseMatterPath("/cameras/12/1")).toEqual({ nodeId: 12, endpointId: 1 });
        expect(code.parseMatterPath("/h264Preview_01_main")).toBeNull();
        expect(code.parseMatterPath("/cameras/1/70000")).toBeNull();
    });

    it("builds the relay's WebRTC source on the bridge's own address", () => {
        expect(code.matterRelaySource("http://bridge-1:5590/", "/cameras/12/1", "s3cr+t")).toBe(
            "webrtc:ws://bridge-1:5590/cameras/12/1/webrtc?token=s3cr%2Bt"
        );
    });
});

describe("Matter bridge signalling", () => {
    const target = { nodeId: 12, endpointId: 1 };

    it("reads the relay's offer and candidates and nothing else", () => {
        expect(
            signaling.parseRelayMessage(JSON.stringify({ type: "webrtc/offer", value: "v=0\r\n" }))
        ).toEqual({ type: "offer", sdp: "v=0\r\n" });
        expect(
            signaling.parseRelayMessage(
                JSON.stringify({ type: "webrtc/candidate", value: "candidate:1 1 udp 1 10.0.0.2 5000 typ host" })
            )
        ).toEqual({ type: "candidate", candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host" });
        expect(signaling.parseRelayMessage("not json")).toBeNull();
        expect(signaling.parseRelayMessage(JSON.stringify({ type: "webrtc/offer", value: "x" }))).toBeNull();
    });

    it("starts a live view with talkback only when the camera can play it", () => {
        expect(signaling.startStreamArgs(target, "v=0", "k", true)).toEqual({
            node_id: 12,
            endpoint_id: 1,
            stream_usage: "LiveView",
            sdp: "v=0",
            talkback: true,
            client_session_key: "k"
        });
        expect(signaling.startStreamArgs(target, "v=0", "k", false).talkback).toBe(false);
    });

    it("files the relay's candidates under the offer's first media section", () => {
        const mid = signaling.firstMid("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:v0\r\nm=audio\r\na=mid:a1\r\n");
        expect(mid).toBe("v0");
        expect(signaling.candidateArgs(target, "k", "candidate:x", mid).ice_candidates).toEqual([
            { candidate: "candidate:x", sdpMid: "v0", sdpMLineIndex: 0 }
        ]);
    });

    it("turns the camera's answer, candidates and end into the relay's messages", () => {
        const callback = (event_type: string, data: unknown, key = "k") => ({
            event: "webrtc_callback",
            data: { event_type, client_session_key: key, data }
        });
        expect(signaling.relayMessagesFor(callback("answer", { sdp: "v=0 answer" }), "k")).toEqual({
            send: [{ type: "webrtc/answer", value: "v=0 answer" }]
        });
        expect(
            signaling.relayMessagesFor(
                callback("ice_candidates", {
                    ice_candidates: [{ candidate: "candidate:a", sdpMid: "0", sdpMLineIndex: 0 }, { candidate: "" }]
                }),
                "k"
            )
        ).toEqual({ send: [{ type: "webrtc/candidate", value: "candidate:a" }] });
        expect(signaling.relayMessagesFor(callback("end", { reason: 1 }), "k")).toBe("end");
        expect(
            signaling.relayMessagesFor({ event: "camera_session_ended", data: { client_session_key: "k" } }, "k")
        ).toBe("end");
        expect(signaling.relayMessagesFor(callback("answer", { sdp: "v=0" }, "other"), "k")).toBeNull();
    });

    it("finds the camera endpoint by its WebRTC provider cluster", () => {
        expect(signaling.cameraEndpoint({ "0/40/1": "x", "2/1363/0": [], "1/1363/1": [] })).toBe(1);
        expect(signaling.cameraEndpoint({ "0/40/1": "x", "1/6/0": true })).toBeNull();
    });

    it("says a camera can talk only with a speaker and half or full duplex", () => {
        expect(signaling.canTalk({ features: ["Video", "Speaker"], audio: { two_way_talk_support: "FullDuplex" } })).toBe(true);
        expect(signaling.canTalk({ features: ["Video", "Speaker"], audio: { two_way_talk_support: "HalfDuplex" } })).toBe(true);
        expect(signaling.canTalk({ features: ["Video"], audio: { two_way_talk_support: "FullDuplex" } })).toBe(false);
        expect(signaling.canTalk({ features: ["Speaker"], audio: { two_way_talk_support: "NotSupported" } })).toBe(false);
        expect(signaling.canTalk({ features: ["Speaker"] })).toBe(false);
    });

    it("names the camera a path is for, and nothing else", () => {
        expect(signaling.cameraPath("/cameras/12/1/webrtc")).toEqual({ nodeId: 12, endpointId: 1, rest: "/webrtc" });
        expect(signaling.cameraPath("/cameras/12/1")).toEqual({ nodeId: 12, endpointId: 1, rest: "" });
        expect(signaling.cameraPath("/cameras/../1")).toBeNull();
        expect(signaling.commissionRefusal("passcode-mismatch")).toBe("passcode-mismatch");
        expect(signaling.commissionRefusal("weird")).toBe("failed");
    });
});

describe("talking through any camera with a way back", () => {
    it("reads the speaker codec off the relay connection, A-law first", () => {
        expect(backchannelCodec(["video, recvonly, H264", "audio, recvonly, AAC/16000", "audio, sendonly, PCMU/8000, PCMA/8000"])).toBe("pcma");
        expect(backchannelCodec(["audio, sendonly, PCMU/8000"])).toBe("pcmu");
        expect(backchannelCodec(["audio, sendonly, OPUS/48000/2"])).toBe("opus");
        expect(backchannelCodec(["audio, sendonly, MPEG4-GENERIC/16000"])).toBe("aac");
        expect(backchannelCodec(["video, recvonly, H264", "audio, recvonly, PCMA/8000"])).toBeNull();
        expect(backchannelCodec([])).toBeNull();
    });

    it("offers Talk on a Tapo always, on other makes only with a backchannel", () => {
        expect(talkSupport("tapo-cloud")).not.toBe("no");
        expect(talkSupport("reolink")).toBe("probe");
        expect(talkSupport("matter")).toBe("probe");
        expect(talkCodecFor("probe", ["audio, sendonly, PCMU/8000"])).toBe("pcmu");
        expect(talkCodecFor("probe", ["audio, recvonly, PCMU/8000"])).toBeNull();
        expect(talkCodecFor("rtsp", [])).toBeNull();
        expect(talkCodecFor("yes", [])).toBe("pcma");
        expect(talkCodecFor("no", ["audio, sendonly, PCMA/8000"])).toBeNull();
    });

    it("sends A-law straight and transcodes for any other speaker", () => {
        const direct = new URLSearchParams(talkPlayQuery("cam", true)).get("src") ?? "";
        expect(direct.startsWith("rtsp://127.0.0.1:8554/")).toBe(true);
        expect(direct.endsWith("?audio=pcma")).toBe(true);
        const opus = new URLSearchParams(talkPlayQuery("cam", true, "opus")).get("src") ?? "";
        expect(opus.startsWith("ffmpeg:rtsp://127.0.0.1:8554/")).toBe(true);
        expect(opus.endsWith("#audio=opus")).toBe(true);
        expect(new URLSearchParams(talkPlayQuery("cam", false, "opus")).get("src")).toBe("");
    });
});

describe("adding a Matter camera", () => {
    const payload = (password?: string) => ({
        name: "Front door",
        vendor: "matter",
        modelId: "matter-other",
        address: "10.0.1.70",
        detection: DEFAULT_DETECTION,
        ...(password === undefined ? {} : { password })
    });

    it("is found as a model of its own and reached as Matter", () => {
        expect(searchModels("doorbell").map((model) => model.id)).toContain("matter-other");
        expect(cameraModel("matter-other")?.connections).toEqual(["matter"]);
        expect(vendorForModel("matter-other", null)).toBe("matter");
    });

    it("stores the code as the bridge reads it and refuses one with a wrong digit", () => {
        expect(parseCameraInput(payload("3497-0112-332")).password).toBe("34970112332");
        expect(() => parseCameraInput(payload("3497-0112-333"))).toThrow(/not one a Matter camera gives/);
        // An edit of a camera already added sends no code at all.
        expect(parseCameraInput(payload()).password).toBeUndefined();
        expect(parseCameraInput(payload()).detector).not.toBe("camera");
    });

    it("says every refusal of the bridge in Spanish", () => {
        const t = placesCatalogs.translator("es-ES", "places");
        const reasons = ["invalid-payload", "passcode-mismatch", "not-discovered", "timeout", "attestation-rejected", "not-a-camera", "other"];
        for (const reason of reasons) {
            const english = commissionSentence(reason);
            expect(placesRefusalText(t, english)).not.toBe(english);
        }
    });
});
