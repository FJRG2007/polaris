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
    /** Where that protocol answers, for the one thing Polaris can check before a
     *  camera is saved: that something is there at all. */
    readonly nativePort?: number;
    /** Where the same make answers for everything that is not video, when it
     *  uses a second port for it. Only ever asked as a second question after the
     *  first one failed, to tell "not there" from "there and not sharing". */
    readonly nativeControlPort?: number;
    /**
     * What has to be switched on in the maker's own app before any of this
     * works, in the words of that app's menu.
     *
     * Recent firmware refuses every local connection until it is, which reaches
     * somebody as a camera that answers nothing with a password they know is
     * right. It is not a Polaris setting and Polaris cannot set it, so the only
     * useful thing to do with it is say it where the failure appears.
     */
    readonly appConsent?: string;
    /**
     * The make speaks no ONVIF whatsoever.
     *
     * Not the same as having no ONVIF port in this profile - most makes here
     * simply answer on 80 and say nothing about it. This is the stronger claim,
     * and it takes two things away: the camera cannot be asked what it streams,
     * and it cannot report its own movement, so the cheapest rung of detection
     * is a rung that would never fire on it.
     */
    readonly noOnvif?: boolean;
    /**
     * It runs on a battery, so a connection is not free.
     *
     * On these makes it is stronger than a cost: the camera takes its radio down
     * between events, so it is not on the network at all for most of the day and
     * nothing Polaris can send will bring it back. Waking one goes through the
     * maker's own cloud, which is what the phone app is doing when it opens the
     * live view.
     *
     * Every other camera here is on a wire and costs the same whether anybody is
     * watching or not. These cost their own charge: holding the stream open is
     * what the battery is spent on, and a wall left open on one overnight is a
     * camera that is flat by morning. So Polaris connects to one only while
     * somebody is actually looking, and says so rather than quietly draining it.
     */
    readonly battery?: boolean;
}

/** Where TP-Link's own protocol answers. Not a guess: it is the port go2rtc's
 *  `tapo://` source dials, and the relay is what holds these connections. */
export const TAPO_NATIVE_PORT = 8800;

/** Where the same cameras answer for everything that is not video. Worth knowing
 *  separately: a camera that answers here and not on the port above is on the
 *  network and declining to share, which is a different problem with a different
 *  fix from one that answers nowhere. */
export const TAPO_CONTROL_PORT = 443;

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
        nativePort: TAPO_NATIVE_PORT,
        nativeControlPort: TAPO_CONTROL_PORT,
        appConsent: "Me > Third-Party Services > Third-Party Compatibility",
        note: "The password for your TP-Link account - the one you sign into the Tapo app with, not one set on the camera. No camera account, and the microphone works both ways."
    },
    {
        // The battery models, which are not a variation on the one above: they
        // publish no RTSP and no ONVIF at all, at any port, with any account.
        // TP-Link says so themselves, and it is not a setting anybody can turn
        // on - the camera is asleep most of the time and a protocol built on a
        // permanent connection has nothing to connect to. The maker's own
        // protocol is the only way in, which is also how the phone app does it.
        id: "tapo-battery",
        label: "TP-Link Tapo (battery, no RTSP)",
        mainPath: "",
        // Fixed lenses, every one of them, so there is nothing to point.
        ptz: false,
        noOnvif: true,
        battery: true,
        nativeScheme: "tapo",
        nativePasswordOnly: true,
        nativePort: TAPO_NATIVE_PORT,
        nativeControlPort: TAPO_CONTROL_PORT,
        appConsent: "Me > Third-Party Services > Third-Party Compatibility",
        note: "For the ones with a battery in them - C400, C410, C420, C425, D230 - which publish no RTSP however they are configured. One of these is asleep almost all the time and answers nothing at all while it is: it wakes on its own movement, or when the Tapo app opens it. Polaris can watch one while it is awake and cannot wake one itself, so treat it as a camera you look in on rather than one that is always there."
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

/** Whether watching this camera spends a charge rather than a wire. */
export function onBattery(vendorId: string): boolean {
    return cameraVendor(vendorId).battery === true;
}

/** The makes that do, as a list a query can be written against - the sweeps
 *  decide which cameras to dial in the database rather than in a loop. */
export const BATTERY_VENDORS: readonly string[] = CAMERA_VENDORS.filter(
    (vendor) => vendor.battery === true
).map((vendor) => vendor.id);

/**
 * Whether this camera can tell Polaris it saw something by itself.
 *
 * The cheapest rung of detection is the camera's own alerts, and they arrive
 * over ONVIF. A make that speaks none cannot send them - so offering that rung
 * for one is offering a setting that costs nothing and does nothing, which is
 * the worst of the two.
 */
export function reportsOwnAlerts(vendorId: string): boolean {
    return cameraVendor(vendorId).noOnvif !== true;
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
 * Every credential taken out of a piece of text, wherever in it they are.
 *
 * `redactRtspUrl` reads one address that starts the string and expects a name
 * beside the password. Neither holds for what comes back from the relay: its
 * message is a sentence with an address somewhere inside it, and on the maker's
 * own protocol the password stands alone - `tapo://secret@host` has nothing
 * before the `@` but the secret itself, so a redaction looking for `user:pass`
 * leaves it untouched and prints it.
 *
 * Anything between a scheme and an `@` is therefore treated as a credential,
 * which over-redacts a bare username and never under-redacts a password. That is
 * the right way round for text on its way to a screen or a log.
 */
export function redactSource(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@");
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
