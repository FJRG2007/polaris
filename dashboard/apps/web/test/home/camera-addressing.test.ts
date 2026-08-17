/**
 * The pure parts of reaching a camera: how an address is written down, how a
 * stream URL is built from it, and what a camera's own answers parse to.
 *
 * All of it is the kind of thing that is wrong once and then wrong everywhere -
 * a password with an @ in it silently addresses another host, a sweep of a /8
 * runs for an hour - so it is pinned here rather than found on a Sunday.
 */

import { describe, expect, it } from "vitest";
import { attrValues, tagValue, tagValues } from "@/lib/home/onvif";
import { hostsInCidr, vendorFromScopes } from "@/lib/home/discovery";
import { cameraVendor, redactRtspUrl, rtspUrl } from "@/lib/home/vendors";
import { normalizeAddress, normalizeCameraInput, normalizeStreamPath } from "@/lib/home/schemas";
import { DEFAULT_DETECTION, detectorReaches, needsSomewhereToRun, withinHours } from "@/lib/home/detection";

describe("addresses", () => {
    it("keeps just the host, however it was pasted", () => {
        expect(normalizeAddress("  RTSP://192.168.1.50:554/stream1  ")).toBe("192.168.1.50:554");
        expect(normalizeAddress("http://Camera.local/")).toBe("camera.local");
        expect(normalizeAddress("192.168.1.50")).toBe("192.168.1.50");
    });

    it("gives a stream path its leading slash and takes a host off it", () => {
        expect(normalizeStreamPath("stream1")).toBe("/stream1");
        expect(normalizeStreamPath("rtsp://192.168.1.50:554/h264Preview_01_main")).toBe("/h264Preview_01_main");
        expect(normalizeStreamPath("  ")).toBe("");
        expect(normalizeStreamPath("/stream1/")).toBe("/stream1");
    });

    it("normalizes every text field of a camera in one pass", () => {
        expect(
            normalizeCameraInput({ name: " Front door ", zone: " Outside ", address: "RTSP://10.0.0.4/x", username: " admin " })
        ).toEqual({ name: "Front door", zone: "Outside", address: "10.0.0.4", username: "admin" });
    });
});

describe("stream URLs", () => {
    const camera = { address: "192.168.1.50", rtspPort: 554 };

    it("encodes credentials, because camera passwords contain @ and /", () => {
        const url = rtspUrl(camera, "/stream1", { username: "polaris", password: "p@ss/word" });
        expect(url).toBe("rtsp://polaris:p%40ss%2Fword@192.168.1.50:554/stream1");
        // The host must still be the camera - an unencoded @ moves it.
        expect(new URL(url).hostname).toBe("192.168.1.50");
    });

    it("leaves out credentials when the camera needs none", () => {
        expect(rtspUrl(camera, "/stream1")).toBe("rtsp://192.168.1.50:554/stream1");
    });

    it("brackets a bare IPv6 address", () => {
        expect(rtspUrl({ address: "fd00::5", rtspPort: 554 }, "/stream1")).toBe("rtsp://[fd00::5]:554/stream1");
    });

    it("hides the password from anything a person reads", () => {
        const url = rtspUrl(camera, "/stream1", { username: "polaris", password: "hunter2" });
        expect(redactRtspUrl(url)).toBe("rtsp://polaris:***@192.168.1.50:554/stream1");
        expect(redactRtspUrl(url)).not.toContain("hunter2");
    });

    it("knows where Tapo listens, which is not where anything else does", () => {
        const tapo = cameraVendor("tapo");
        expect(tapo.onvifPort).toBe(2020);
        expect(tapo.mainPath).toBe("/stream1");
        expect(tapo.subPath).toBe("/stream2");
    });

    it("falls back to the generic profile for a make it does not know", () => {
        expect(cameraVendor("something-else").id).toBe("generic");
    });
});

describe("what a camera says", () => {
    // A real GetProfilesResponse, prefixes and all: the attribute quoting is what
    // a camera actually sends, so it stays as it is.
    const profiles =
        "<trt:GetProfilesResponse><trt:Profiles token=\"Profile_1\" fixed=\"true\"><tt:Name>mainStream</tt:Name><tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles><trt:Profiles token=\"Profile_2\"><tt:Name>minorStream</tt:Name><tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>640</tt:Width></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles></trt:GetProfilesResponse>";

    it("reads a value whatever prefix the vendor used", () => {
        expect(tagValue("<tds:Model>C200</tds:Model>", "Model")).toBe("C200");
        expect(tagValue("<Model>C200</Model>", "Model")).toBe("C200");
        expect(tagValue(profiles, "Name")).toBe("mainStream");
    });

    it("reads every repeat, in order", () => {
        expect(tagValues(profiles, "Name")).toEqual(["mainStream", "minorStream"]);
        expect(tagValues(profiles, "Width")).toEqual(["2560", "640"]);
    });

    it("reads profile tokens off the attribute they live in", () => {
        expect(attrValues(profiles, "Profiles", "token")).toEqual(["Profile_1", "Profile_2"]);
    });

    it("recognizes a make from its scopes", () => {
        expect(vendorFromScopes("onvif://www.onvif.org/name/TAPO%20C200")).toBe("tapo");
        expect(vendorFromScopes("onvif://www.onvif.org/hardware/DS-2CD2042WD Hikvision")).toBe("hikvision");
        expect(vendorFromScopes("onvif://www.onvif.org/name/IPCamera")).toBeNull();
    });
});

describe("sweeping a subnet", () => {
    it("lists the hosts of a /24 and leaves out network and broadcast", () => {
        const hosts = hostsInCidr("192.168.1.0/24");
        expect(hosts).toHaveLength(254);
        expect(hosts[0]).toBe("192.168.1.1");
        expect(hosts.at(-1)).toBe("192.168.1.254");
    });

    it("takes the network address from any host in the range", () => {
        expect(hostsInCidr("192.168.1.77/24")[0]).toBe("192.168.1.1");
    });

    it("refuses a range too wide to sweep", () => {
        expect(hostsInCidr("10.0.0.0/8")).toEqual([]);
        expect(hostsInCidr("nonsense")).toEqual([]);
    });
});

describe("the detection ladder", () => {
    it("has each rung reach every cheaper one", () => {
        expect(detectorReaches("faces", "motion")).toBe(true);
        expect(detectorReaches("motion", "objects")).toBe(false);
        expect(detectorReaches("none", "camera")).toBe(false);
    });

    it("only asks where to run for the rungs Polaris runs itself", () => {
        expect(needsSomewhereToRun("camera")).toBe(false);
        expect(needsSomewhereToRun("none")).toBe(false);
        expect(needsSomewhereToRun("objects")).toBe(true);
    });

    it("honours a window that wraps midnight, which is the usual one", () => {
        const night = { ...DEFAULT_DETECTION, hours: { from: 22, to: 6 } };
        expect(withinHours(night, 23)).toBe(true);
        expect(withinHours(night, 3)).toBe(true);
        expect(withinHours(night, 12)).toBe(false);
    });

    it("is on all day when no window was set", () => {
        expect(withinHours(DEFAULT_DETECTION, 4)).toBe(true);
    });
});
