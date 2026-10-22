/**
 * A camera's small stream is a video stream, never its JPEG stills.
 *
 * A Tapo C210 publishes three profiles: 2304x1296 and 1280x720 H264, and a
 * 640x360 JPEG at one frame a second on /stream8. The JPEG one is the
 * narrowest, so picking "the narrowest" made it the small stream, and the
 * wall's thumbnails - which read the small stream - came out gray or empty.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: Array<{ id: string; subPath: string | null }> = [];
const published: string[] = [];
let stored: Record<string, string | null> = {};
let profilesXml = "";
const uris: Record<string, string> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: { subPath: string | null };
            }) => {
                updates.push({ id: where.id, subPath: data.subPath });
                stored[where.id] = data.subPath;
            }
        }
    }
}));

vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    cameraTarget: async (_install: string, id: string) => ({
        id,
        address: "10.0.9.20",
        onvifPort: 2020,
        username: "viewer",
        password: "fixture-password",
        subPath: stored[id]
    })
}));

vi.mock("@polaris-app/places/src/lib/relay", () => ({
    publishCamera: async (_relay: unknown, camera: { id: string }) => {
        published.push(camera.id);
    }
}));

vi.mock("@polaris-app/places/src/lib/onvif", async (original) => {
    const real = await original<typeof import("@polaris-app/places/src/lib/onvif")>();
    return {
        ...real,
        getProfiles: async () => real.parseProfiles(profilesXml),
        getStreamUri: async (_endpoint: unknown, token: string) => uris[token] ?? null
    };
});

const { parseProfiles, pickProfiles } = await import("@polaris-app/places/src/lib/onvif");
const { repairStillStreams } = await import("@polaris-app/places/src/lib/still-streams");

/** A GetProfiles answer shaped like the one a C210 gives. */
function profile(token: string, name: string, encoding: string, width: number): string {
    return `<trt:Profiles fixed="true" token="${token}"><tt:Name>${name}</tt:Name><tt:VideoSourceConfiguration token="vsrc"><tt:Name>VideoSourceConfig</tt:Name><tt:Bounds x="0" y="0" width="2304" height="1296"/></tt:VideoSourceConfiguration><tt:VideoEncoderConfiguration token="venc_${token}"><tt:Name>VideoEncoder_${token}</tt:Name><tt:Encoding>${encoding}</tt:Encoding><tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${Math.round((width * 9) / 16)}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>`;
}

const C210 = `<trt:GetProfilesResponse>${profile("profile_1", "mainStream", "H264", 2304)}${profile("profile_2", "minorStream", "H264", 1280)}${profile("profile_3", "jpegStream", "JPEG", 640)}</trt:GetProfilesResponse>`;

describe("reading a camera's profiles", () => {
    it("pairs each token with its own name, width and encoding", () => {
        expect(parseProfiles(C210)).toEqual([
            { token: "profile_1", name: "mainStream", width: 2304, encoding: "H264" },
            { token: "profile_2", name: "minorStream", width: 1280, encoding: "H264" },
            { token: "profile_3", name: "jpegStream", width: 640, encoding: "JPEG" }
        ]);
    });

    it("picks the narrowest video profile as the small stream, not the stills", () => {
        const { main, sub } = pickProfiles(parseProfiles(C210));
        expect(main?.token).toBe("profile_1");
        expect(sub?.token).toBe("profile_2");
    });

    it("still picks the narrowest when every profile is video", () => {
        const xml = `${profile("a", "main", "H264", 1920)}${profile("b", "minor", "H264", 640)}`;
        expect(pickProfiles(parseProfiles(xml)).sub?.token).toBe("b");
    });

    it("has no small stream when the stills are the only other profile", () => {
        const xml = `${profile("a", "main", "H264", 1920)}${profile("b", "jpeg", "JPEG", 640)}`;
        const { main, sub } = pickProfiles(parseProfiles(xml));
        expect(main?.token).toBe("a");
        expect(sub).toBeUndefined();
    });
});

describe("cameras saved reading the stills", () => {
    const relay = { baseUrl: "http://relay", username: "u", password: "p" } as never;
    const camera = (id: string, subPath: string | null, vendor = "tapo") => ({
        id,
        installedAppId: "install",
        enabled: true,
        power: "wired",
        vendor,
        subPath
    });

    beforeEach(() => {
        updates.length = 0;
        published.length = 0;
        stored = {};
        profilesXml = C210;
        uris.profile_1 = "rtsp://10.0.9.20:554/stream1";
        uris.profile_2 = "rtsp://10.0.9.20:554/stream2";
        uris.profile_3 = "rtsp://10.0.9.20:554/stream8";
    });

    it("are moved to the video stream and republished, once", async () => {
        const moved = await repairStillStreams(relay, [camera("c1", "/stream8")], () => true);
        expect(moved).toBe(1);
        expect(updates).toEqual([{ id: "c1", subPath: "/stream2" }]);
        expect(published).toEqual(["c1"]);

        expect(await repairStillStreams(relay, [camera("c1", "/stream8")], () => true)).toBe(0);
    });

    it("leave a path the camera does not call its stills alone", async () => {
        expect(await repairStillStreams(relay, [camera("c2", "/custom")], () => true)).toBe(0);
        expect(await repairStillStreams(relay, [camera("c3", "/stream2")], () => true)).toBe(0);
        expect(updates).toEqual([]);
    });

    it("skip a make that speaks no ONVIF, or never reads the path", async () => {
        const skipped = [
            camera("c4", "/stream8", "tapo-battery"),
            camera("c6", "/stream8", "tapo-cloud")
        ];
        expect(await repairStillStreams(relay, skipped, () => true)).toBe(0);
        expect(updates).toEqual([]);
    });

    it("are left for the next pass once the time for this one has run out", async () => {
        const spent = Date.now() - 1;
        expect(await repairStillStreams(relay, [camera("c7", "/stream8")], () => true, spent)).toBe(
            0
        );
        expect(updates).toEqual([]);

        expect(await repairStillStreams(relay, [camera("c7", "/stream8")], () => true)).toBe(1);
        expect(updates).toEqual([{ id: "c7", subPath: "/stream2" }]);
    });

    it("fall back to the main stream when there is no other video profile", async () => {
        profilesXml = `${profile("profile_1", "main", "H264", 1920)}${profile("profile_3", "jpeg", "JPEG", 640)}`;
        await repairStillStreams(relay, [camera("c5", "/stream8")], () => true);
        expect(updates).toEqual([{ id: "c5", subPath: null }]);
    });
});
