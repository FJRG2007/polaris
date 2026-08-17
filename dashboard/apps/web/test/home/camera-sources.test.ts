/**
 * How a camera is handed to the relay, and what its own alerts are taken to mean.
 *
 * Both are places where being subtly wrong looks like a working system: a source
 * string the relay accepts but that points at the wrong stream, or a camera
 * reporting a person and Polaris writing it down as movement, which is exactly
 * the difference somebody chose the expensive setting for.
 */

import { parseServices } from "@/lib/home/onvif";
import { relaySource } from "@/lib/home/vendors";
import { describe, expect, it, vi } from "vitest";

// The watcher reaches the database to read a camera's quiet window; nothing in
// this file gets that far, but importing it does.
vi.mock("@polaris/db", () => ({ prisma: {} }));

const { kindForTopic } = await import("@/lib/home/watcher");

describe("what the relay is told to open", () => {
    const camera = { address: "192.168.1.50", rtspPort: 554, mainPath: "/stream1", subPath: "/stream2" };

    it("uses the maker's own protocol when there is one, with the password alone", () => {
        expect(relaySource({ ...camera, vendor: "tapo-cloud" }, "main", { password: "hunter2" })).toBe(
            "tapo://hunter2@192.168.1.50?subtype=0"
        );
    });

    it("asks that protocol for the small stream by subtype, not by path", () => {
        expect(relaySource({ ...camera, vendor: "tapo-cloud" }, "sub", { password: "hunter2" })).toBe(
            "tapo://hunter2@192.168.1.50?subtype=1"
        );
    });

    it("encodes a password with characters a URL would eat", () => {
        const source = relaySource({ ...camera, vendor: "tapo-cloud" }, "main", { password: "p@ss/word" });
        expect(source).toBe("tapo://p%40ss%2Fword@192.168.1.50?subtype=0");
        expect(new URL(source).hostname).toBe("192.168.1.50");
    });

    it("falls back to RTSP for everything else, on the right stream", () => {
        const auth = { username: "polaris", password: "secret" };
        expect(relaySource({ ...camera, vendor: "reolink" }, "main", auth)).toBe(
            "rtsp://polaris:secret@192.168.1.50:554/stream1"
        );
        expect(relaySource({ ...camera, vendor: "reolink" }, "sub", auth)).toBe(
            "rtsp://polaris:secret@192.168.1.50:554/stream2"
        );
    });

    it("reads the main stream when the camera publishes only one", () => {
        const single = { ...camera, subPath: "", vendor: "generic" };
        expect(relaySource(single, "sub", {})).toBe("rtsp://192.168.1.50:554/stream1");
    });
});

describe("what a camera's own alert means", () => {
    it("keeps a person a person, however the vendor spelled the topic", () => {
        expect(kindForTopic("tns1:RuleEngine/MyRuleDetector/PeopleDetect")).toBe("person");
        expect(kindForTopic("tns1:RuleEngine/HumanDetect")).toBe("person");
        expect(kindForTopic("tns1:RuleEngine/PersonDetector/Person")).toBe("person");
    });

    it("recognizes the other three it has an opinion about", () => {
        expect(kindForTopic("tns1:RuleEngine/VehicleDetect")).toBe("vehicle");
        expect(kindForTopic("tns1:RuleEngine/PetDetect")).toBe("animal");
        expect(kindForTopic("tns1:VideoSource/ImageTooDark/AnalyticsTamper")).toBe("tamper");
    });

    it("treats anything it does not know as movement, which is what it is underneath", () => {
        expect(kindForTopic("tns1:RuleEngine/CellMotionDetector/Motion")).toBe("motion");
        expect(kindForTopic("tns1:RuleEngine/SomethingNobodyHasSeenBefore")).toBe("motion");
    });
});

describe("where a camera keeps its services", () => {
    // Trimmed from a real GetCapabilities: the paths are per-vendor, which is the
    // whole reason this is asked rather than assumed. A hardcoded
    // "/onvif/ptz_service" is why the arrows did nothing on a camera that
    // answered everything else perfectly.
    const capabilities =
        "<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Events><tt:XAddr>http://192.168.1.50:2020/onvif/event</tt:XAddr></tt:Events><tt:Media><tt:XAddr>http://192.168.1.50:2020/onvif/Media</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>http://192.168.1.50:2020/onvif/PTZ</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>";

    it("reads each service out of its own section, not the first XAddr it sees", () => {
        expect(parseServices(capabilities)).toEqual({
            media: "/onvif/Media",
            ptz: "/onvif/PTZ",
            events: "/onvif/event"
        });
    });

    it("keeps only the path, because the address a camera reports is its own idea", () => {
        // Behind a repeater the host a camera names is frequently not one that
        // reaches it; the address that works is the one already being used.
        expect(parseServices(capabilities).ptz.startsWith("/")).toBe(true);
    });

    it("falls back to the usual paths when a camera says nothing", () => {
        expect(parseServices("")).toEqual({
            media: "/onvif/media_service",
            ptz: "/onvif/ptz_service",
            events: "/onvif/event_service"
        });
    });
});
