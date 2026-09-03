/**
 * The cameras that publish no RTSP at all.
 *
 * TP-Link's battery models - C400, C410, C420, C425, D230 - have no RTSP and no
 * ONVIF on any port, with any account. They are reachable only over the maker's
 * own protocol, which is how the phone app talks to them, and everything Polaris
 * normally assumes about a camera is wrong for one: there is no stream path to
 * resolve, nothing to ask what it publishes, no movement it can report, and no
 * wire paying for the connection.
 *
 * Each of those is a place where being wrong looks like a working system - a
 * setup screen that blames the password for a camera that is fine, a detection
 * rung switched on that can never fire, a wall that quietly flattens a battery
 * overnight. So each of them is a test.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DETECTION } from "@/lib/home/detection";
import { normalizeCameraInput, parseCameraInput } from "@/lib/home/schemas";
import {
    CAMERA_VENDORS,
    TAPO_NATIVE_PORT,
    cameraVendor,
    onBattery,
    relaySource,
    reportsOwnAlerts
} from "@/lib/home/vendors";

const c410 = { vendor: "tapo-battery", address: "192.168.1.64", rtspPort: 554 };

describe("a battery Tapo, as the relay is told about it", () => {
    it("is opened over the maker's protocol, on the password alone", () => {
        expect(relaySource(c410, "main", { password: "hunter2" })).toBe(
            "tapo://hunter2@192.168.1.64?subtype=0"
        );
    });

    it("reads the small stream by subtype, since it has no paths to read it by", () => {
        expect(relaySource(c410, "sub", { password: "hunter2" })).toBe(
            "tapo://hunter2@192.168.1.64?subtype=1"
        );
    });

    it("never falls back to RTSP, whatever paths were left on the row", () => {
        const source = relaySource(
            { ...c410, mainPath: "/stream1", subPath: "/stream2" },
            "main",
            { password: "hunter2" }
        );
        expect(source.startsWith("tapo://")).toBe(true);
    });

    it("encodes a Tapo password that a URL would eat", () => {
        const source = relaySource(c410, "main", { password: "p@ss/word" });
        expect(source).toBe("tapo://p%40ss%2Fword@192.168.1.64?subtype=0");
        expect(new URL(source).hostname).toBe("192.168.1.64");
    });
});

describe("what the profile claims about it", () => {
    it("says it speaks no ONVIF, so nothing tries to ask it anything", () => {
        expect(cameraVendor("tapo-battery").noOnvif).toBe(true);
        expect(reportsOwnAlerts("tapo-battery")).toBe(false);
    });

    it("claims no ONVIF port, which is what keeps the movement arrows away", () => {
        expect(cameraVendor("tapo-battery").onvifPort).toBeUndefined();
        expect(cameraVendor("tapo-battery").ptz).toBe(false);
    });

    it("names the port its own protocol answers on, for the one check there is", () => {
        expect(cameraVendor("tapo-battery").nativePort).toBe(TAPO_NATIVE_PORT);
    });

    it("is the only make so far that spends a charge to be watched", () => {
        expect(onBattery("tapo-battery")).toBe(true);
        for (const vendor of CAMERA_VENDORS) {
            if (vendor.id === "tapo-battery") continue;
            expect(onBattery(vendor.id)).toBe(false);
        }
    });

    it("leaves the wired Tapo profiles alone", () => {
        expect(reportsOwnAlerts("tapo-cloud")).toBe(true);
        expect(reportsOwnAlerts("tapo")).toBe(true);
        expect(onBattery("tapo-cloud")).toBe(false);
    });
});

describe("the rung a camera like this is left on", () => {
    const base = { vendor: "tapo-battery", detector: "camera" };

    it("drops the camera's own alerts, which it has no way to send", () => {
        expect(normalizeCameraInput(base).detector).toBe("none");
    });

    it("drops them for an API call as well as for the form", () => {
        expect(normalizeCameraInput({ ...base, name: " Garden " })).toEqual({
            vendor: "tapo-battery",
            detector: "none",
            name: "Garden"
        });
    });

    it("does not move a rung the owner chose deliberately", () => {
        expect(normalizeCameraInput({ ...base, detector: "objects" }).detector).toBe("objects");
        expect(normalizeCameraInput({ ...base, detector: "none" }).detector).toBe("none");
    });

    it("leaves a camera that can report its own movement where it was", () => {
        expect(normalizeCameraInput({ ...base, vendor: "tapo-cloud" }).detector).toBe("camera");
        expect(normalizeCameraInput({ ...base, vendor: "reolink" }).detector).toBe("camera");
    });
});

describe("what is stored when the rung was never named", () => {
    const payload = (vendor: string) => ({
        name: "Garden",
        vendor,
        address: "192.168.1.64",
        detection: DEFAULT_DETECTION
    });

    // The rung the schema fills in when a payload leaves it out is the camera's
    // own alerts, so a body with no `detector` key has nothing for the
    // normalizer to correct and arrives at the database on the one setting this
    // camera can never honour.
    it("does not let the field's own default put back the rung that cannot fire", () => {
        expect(parseCameraInput(payload("tapo-battery")).detector).toBe("none");
    });

    it("still fills it in for a camera that can report its own movement", () => {
        expect(parseCameraInput(payload("tapo-cloud")).detector).toBe("camera");
    });

    it("leaves everything else the schema settles alone", () => {
        const parsed = parseCameraInput({ ...payload("tapo-battery"), address: "192.168.1.64" });
        expect(parsed.rtspPort).toBe(554);
        expect(parsed.recording).toBe("motion");
        expect(parsed.enabled).toBe(true);
    });
});
