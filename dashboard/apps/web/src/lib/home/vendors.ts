/**
 * What each make of camera answers on, so adding one does not start with the
 * owner reading a forum thread to find out its stream path.
 *
 * Two streams matter and they are not interchangeable. The main one is what gets
 * watched and recorded; the sub one is a small, low-frame-rate copy the same
 * camera also publishes, and it is what detection reads - running a detector on
 * a 4K stream is how one camera costs a whole machine. Every profile here names
 * both.
 *
 * These are starting points, not facts. The paths below are what each vendor
 * ships by default, and a camera is free to disagree - an older firmware, a
 * renamed profile, a channel that is not the first. So a camera that speaks
 * ONVIF is asked (see onvif.ts) and its answer wins; the profile is what makes
 * the common case work without asking, and what a camera that speaks nothing
 * else falls back to.
 *
 * Pure and client-safe: the add-camera form reads the same list the server does.
 */

/** A make Polaris knows something about beyond "it speaks RTSP". */
export interface CameraVendor {
    readonly id: string;
    readonly label: string;
    /** Path of the full-quality stream, below the host. */
    readonly mainPath: string;
    /** Path of the small stream detection reads. Absent when the make publishes
     *  only one, which is worth knowing: detection on that camera costs more. */
    readonly subPath?: string;
    /** Where its ONVIF service answers, when it is not the usual 80. */
    readonly onvifPort?: number;
    /** Whether the make's cameras generally point somewhere on command. Only a
     *  hint for the form - what a particular camera can do is asked of it. */
    readonly ptz?: boolean;
    /** What somebody adding one of these has to know first. Shown on the form,
     *  because every one of these is a support question that would otherwise be
     *  asked as "it says wrong password". */
    readonly note?: string;
    /**
     * The maker's own protocol, when using it beats RTSP.
     *
     * TP-Link is the case this exists for. Their cameras do speak RTSP, but only
     * after somebody digs a "camera account" out of a submenu of the phone app,
     * and that account is the single most common reason a Tapo camera will not
     * connect. The maker's own protocol takes the password they already know -
     * the one they log into the app with - and carries two-way audio besides.
     */
    readonly nativeScheme?: string;
    /** Whether the maker's protocol wants the account name as well, or just the
     *  password. TP-Link's wants only the password. */
    readonly nativePasswordOnly?: boolean;
}

export const CAMERA_VENDORS: readonly CameraVendor[] = [
    {
        // First in the list on purpose: it is the one that works with what
        // somebody already has, and the one that avoids the camera-account
        // detour every other Tapo setup starts with.
        id: "tapo-cloud",
        label: "TP-Link Tapo (Tapo password)",
        // Reached over TP-Link's own protocol rather than RTSP, so there are no
        // paths to resolve - the subtype does that job.
        mainPath: "",
        onvifPort: 2020,
        ptz: true,
        nativeScheme: "tapo",
        nativePasswordOnly: true,
        note: "The password you sign into the Tapo app with. No camera account, and the microphone works both ways."
    },
    {
        id: "tapo",
        label: "TP-Link Tapo (camera account)",
        mainPath: "/stream1",
        subPath: "/stream2",
        // Tapo does not answer ONVIF on 80. It listens on 2020, and only once a
        // camera account exists.
        onvifPort: 2020,
        ptz: true,
        note: "In the Tapo app: Settings > Advanced > Camera Account. The account you create there is the one Polaris needs - your TP-Link login will not work."
    },
    {
        id: "vigi",
        label: "TP-Link VIGI",
        mainPath: "/stream1",
        subPath: "/stream2",
        onvifPort: 2020,
        ptz: true,
        note: "Use the camera's own account, set when it was first configured in VIGI."
    },
    {
        id: "reolink",
        label: "Reolink",
        mainPath: "/h264Preview_01_main",
        subPath: "/h264Preview_01_sub",
        ptz: true
    },
    {
        id: "hikvision",
        label: "Hikvision",
        mainPath: "/Streaming/Channels/101",
        subPath: "/Streaming/Channels/102",
        ptz: true
    },
    {
        id: "dahua",
        label: "Dahua",
        mainPath: "/cam/realmonitor?channel=1&subtype=0",
        subPath: "/cam/realmonitor?channel=1&subtype=1",
        ptz: true
    },
    {
        id: "amcrest",
        label: "Amcrest",
        mainPath: "/cam/realmonitor?channel=1&subtype=0",
        subPath: "/cam/realmonitor?channel=1&subtype=1",
        ptz: true
    },
    {
        id: "onvif",
        label: "Any ONVIF camera",
        // Nothing is assumed: the camera is asked what it publishes.
        mainPath: "",
        ptz: true,
        note: "Polaris asks the camera what it streams. Most cameras made in the last ten years answer."
    },
    {
        id: "generic",
        label: "Something else",
        mainPath: "",
        note: "Paste the camera's RTSP address and Polaris will use exactly that."
    }
];

/** One make by id, or the generic profile for anything unrecognized. */
export function cameraVendor(id: string): CameraVendor {
    return CAMERA_VENDORS.find((vendor) => vendor.id === id) ?? CAMERA_VENDORS[CAMERA_VENDORS.length - 1]!;
}

/** The credentials a camera is reached with. Kept apart from the row so nothing
 *  that builds a URL can be handed a whole camera by accident. */
export interface CameraAuth {
    readonly username?: string | null;
    readonly password?: string | null;
}

/** Where a camera's stream is, ready to be opened.
 *
 *  Never send one of these to a browser: it carries the camera's password, and a
 *  camera password is a live view of somebody's home. The relay is given it
 *  server-side, and viewers are handed a Polaris URL instead. */
export function rtspUrl(
    camera: { address: string; rtspPort: number },
    path: string,
    auth: CameraAuth = {}
): string {
    // Encoded, because camera passwords are set in a phone app that happily
    // accepts an @ or a slash, and an unencoded one silently addresses a
    // different host.
    const credentials = auth.username
        ? `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password ?? "")}@`
        : "";
    const host = camera.address.includes(":") && !camera.address.startsWith("[") ? `[${camera.address}]` : camera.address;
    const suffix = path.startsWith("/") || path === "" ? path : `/${path}`;
    return `rtsp://${credentials}${host}:${camera.rtspPort}${suffix}`;
}

/** The same address with the password taken out, for anything a person reads:
 *  a log line, an error, the row on the settings screen. */
export function redactRtspUrl(url: string): string {
    return url.replace(/^([a-z]+:\/\/[^:/@]+):[^@]*@/i, "$1:***@");
}

/**
 * The address the relay is given for a camera, which is not always an RTSP one.
 *
 * A make with its own protocol gets that, because it is both easier for the
 * owner (the password they already have) and better (two-way audio). Everything
 * else gets RTSP. `quality` picks the stream: the good one to watch and record,
 * the small one to analyze.
 */
export function relaySource(
    camera: { vendor: string; address: string; rtspPort: number; mainPath?: string | null; subPath?: string | null },
    quality: "main" | "sub",
    auth: CameraAuth = {}
): string {
    const vendor = cameraVendor(camera.vendor);
    if (vendor.nativeScheme) {
        const credentials = vendor.nativePasswordOnly
            ? encodeURIComponent(auth.password ?? "")
            : `${encodeURIComponent(auth.username ?? "")}:${encodeURIComponent(auth.password ?? "")}`;
        // subtype=1 is the small stream, 0 the full one.
        return `${vendor.nativeScheme}://${credentials}@${camera.address}?subtype=${quality === "sub" ? 1 : 0}`;
    }
    const path = quality === "sub" ? camera.subPath || camera.mainPath || vendor.mainPath : camera.mainPath || vendor.mainPath;
    return rtspUrl(camera, path ?? "", auth);
}
