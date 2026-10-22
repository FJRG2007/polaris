/**
 * Talking to a camera in its own language.
 *
 * ONVIF is what nearly every camera made in the last decade speaks, and it is
 * the difference between a camera Polaris can only stare at and one it can ask
 * questions of: what are you, what do you publish, tell me when you see
 * something, point yourself over there. It is SOAP over HTTP with a WS-Security
 * header, which sounds worse than it is - the four calls this needs are short,
 * fixed documents, so they are written out here rather than dragged in behind a
 * SOAP library and an XML parser.
 *
 * Two deliberate departures from how the rest of Polaris reaches the outside:
 *
 * - It does NOT go through lib/safe-fetch. That module exists to refuse private
 *   addresses, and a camera is a private address - a guard that blocks 192.168.x
 *   would block every camera anybody owns. What replaces it is who may ask:
 *   adding a camera is an administrative grant precisely because it is the one
 *   place somebody can point Polaris at an address of their choosing.
 * - Nothing a camera says is echoed back. Only named fields are read out of the
 *   response, so a device that answers with something other than ONVIF cannot
 *   turn this into a way of reading internal services through the dashboard.
 *
 * Server-only.
 */

import { createHash, randomBytes } from "node:crypto";

/** Long enough for a camera on a tired access point, short enough that a screen
 *  waiting on one does not feel hung. */
const TIMEOUT_MS = 6000;

/** Cameras answer in kilobytes. Anything larger is not a camera, and reading it
 *  is how a probe of the wrong address becomes a memory problem. */
const MAX_BYTES = 512_000;

export interface OnvifEndpoint {
    readonly address: string;
    readonly port: number;
    readonly username?: string | null;
    readonly password?: string | null;
}

/** The WS-Security header a camera wants on every call.
 *
 *  The digest is Base64(SHA1(nonce + created + password)) with the nonce sent
 *  alongside, so the password itself never crosses the network - which matters
 *  on a LAN where ONVIF is plain HTTP. */
function securityHeader(username?: string | null, password?: string | null): string {
    if (!username) return "";
    const nonce = randomBytes(16);
    const created = new Date().toISOString();
    const digest = createHash("sha1")
        .update(
            Buffer.concat([
                nonce,
                Buffer.from(created, "utf8"),
                Buffer.from(password ?? "", "utf8")
            ])
        )
        .digest("base64");
    return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${escapeXml(username)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created></UsernameToken></Security></s:Header>`;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * The first value of an element, whatever namespace prefix the camera happens to
 * use. Vendors disagree about prefixes for the same element, so matching on the
 * local name is the only thing that works across makes.
 */
export function tagValue(xml: string, localName: string): string | null {
    const match = new RegExp(
        `<(?:[A-Za-z0-9._-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${localName}>`
    ).exec(xml);
    return match?.[1]?.trim() ?? null;
}

/** Every value of a repeated element, in document order. */
export function tagValues(xml: string, localName: string): string[] {
    const pattern = new RegExp(
        `<(?:[A-Za-z0-9._-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${localName}>`,
        "g"
    );
    return [...xml.matchAll(pattern)].map((match) => (match[1] ?? "").trim());
}

/** Every value of an attribute across repeated elements (profile tokens). */
export function attrValues(xml: string, localName: string, attribute: string): string[] {
    const pattern = new RegExp(
        `<(?:[A-Za-z0-9._-]+:)?${localName}\\b[^>]*?\\b${attribute}="([^"]+)"`,
        "g"
    );
    return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

/**
 * How a call failed. "refused" is the camera answering with an error, the only
 * one that says anything about what was asked. "timeout" is no answer before
 * the wait ran out - the camera may still carry the request out later.
 * "unreachable" is the connection failing, or the camera closing it unanswered.
 */
export type OnvifFailure = "refused" | "timeout" | "unreachable";

export class OnvifError extends Error {
    readonly failure: OnvifFailure;

    constructor(message: string, failure: OnvifFailure = "refused") {
        super(message);
        this.failure = failure;
    }

    get timedOut(): boolean {
        return this.failure === "timeout";
    }
}

/**
 * One SOAP call. `service` is the path below the host - the device service for
 * anything about the camera itself, the media or PTZ service for the rest.
 *
 * `timeoutMs` is for the calls whose answer is late by design, which is a long
 * poll: giving up on one before the camera was asked to answer does not end it
 * on the camera, it only leaves the camera holding a request nobody reads.
 */
async function call(
    endpoint: OnvifEndpoint,
    service: string,
    body: string,
    timeoutMs = TIMEOUT_MS
): Promise<string> {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${securityHeader(endpoint.username, endpoint.password)}<s:Body>${body}</s:Body></s:Envelope>`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`http://${endpoint.address}:${endpoint.port}${service}`, {
            method: "POST",
            headers: { "content-type": "application/soap+xml; charset=utf-8" },
            body: envelope,
            signal: controller.signal,
            // A camera is on the LAN and answers itself; a redirect off it is
            // not something to follow blindly from inside the network.
            redirect: "manual"
        });
        const text = (await response.text()).slice(0, MAX_BYTES);
        if (!response.ok) {
            // The camera's own reason when it gave one - "not authorized" is the
            // single most common answer here and the one worth passing on.
            const reason = tagValue(text, "Text") ?? tagValue(text, "faultstring");
            throw new OnvifError(reason || `The camera answered ${response.status}`);
        }
        return text;
    } catch (error) {
        if (error instanceof OnvifError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
            throw new OnvifError("The camera did not answer in time", "timeout");
        }
        throw new OnvifError("Could not reach the camera", "unreachable");
    } finally {
        clearTimeout(timer);
    }
}

const DEVICE_SERVICE = "/onvif/device_service";

export interface DeviceInformation {
    readonly manufacturer: string;
    readonly model: string;
    readonly firmware: string;
    readonly serial: string;
}

/** What the camera says it is. Also the cheapest proof that the credentials are
 *  right: it is the call every camera refuses first when they are not. */
export async function getDeviceInformation(endpoint: OnvifEndpoint): Promise<DeviceInformation> {
    const xml = await call(
        endpoint,
        DEVICE_SERVICE,
        '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>'
    );
    return {
        manufacturer: tagValue(xml, "Manufacturer") ?? "",
        model: tagValue(xml, "Model") ?? "",
        firmware: tagValue(xml, "FirmwareVersion") ?? "",
        serial: tagValue(xml, "SerialNumber") ?? ""
    };
}

/**
 * Where this camera's services actually live.
 *
 * The one path fixed by the standard is the device service; everything else is
 * wherever the maker put it, and they disagree - `/onvif/media_service`,
 * `/onvif/Media`, `/onvif/ptz`, sometimes on another port entirely. Hardcoding
 * one spelling is why a camera answers "what are you" perfectly and then ignores
 * every arrow: the request went to a path that is not there.
 *
 * So the camera is asked. `GetCapabilities` is the Profile S call every camera
 * supporting any of this implements, and it names an address per service. Only
 * the path is kept - the address a camera reports is the one it believes it has,
 * which behind a repeater is frequently not the one that reaches it.
 *
 * Cached per camera: it is a fact about the firmware, not about the moment, and
 * asking before every arrow press would put a round trip in front of something
 * that has to feel immediate.
 */
export interface OnvifServices {
    readonly media: string;
    readonly ptz: string;
    readonly events: string;
}

/** What each service is called in a capabilities document, and what Polaris
 *  falls back to when the camera does not name one. */
const SERVICE_FALLBACK: OnvifServices = {
    media: "/onvif/media_service",
    ptz: "/onvif/ptz_service",
    events: "/onvif/event_service"
};

const services = new Map<string, { value: OnvifServices; at: number }>();
const SERVICES_TTL_MS = 10 * 60_000;

/** The path part of an address a camera reported, or null when it reported
 *  nothing usable. */
function pathOfXAddr(value: string | null): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return `${url.pathname}${url.search}` || null;
    } catch {
        return value.startsWith("/") ? value : null;
    }
}

/** The block of a capabilities document describing one service, whatever prefix
 *  it carries. */
function sectionOf(xml: string, name: string): string | null {
    const match = new RegExp(
        `<(?:[A-Za-z0-9._-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${name}>`
    ).exec(xml);
    return match?.[1] ?? null;
}

/**
 * The three service paths out of a capabilities document.
 *
 * Pure, so the one thing that decides whether an arrow works can be pinned by a
 * test rather than discovered against a camera. Each service is read out of its
 * OWN section: they all carry an element called XAddr, so reading the document
 * as a whole would give whichever came first for all three - and the arrows
 * would post PTZ commands at the media service.
 */
export function parseServices(xml: string): OnvifServices {
    const read = (name: string, fallback: string): string => {
        const section = sectionOf(xml, name);
        return (section ? pathOfXAddr(tagValue(section, "XAddr")) : null) ?? fallback;
    };
    return {
        media: read("Media", SERVICE_FALLBACK.media),
        ptz: read("PTZ", SERVICE_FALLBACK.ptz),
        events: read("Events", SERVICE_FALLBACK.events)
    };
}

export async function getServices(endpoint: OnvifEndpoint): Promise<OnvifServices> {
    const key = `${endpoint.address}:${endpoint.port}`;
    const known = services.get(key);
    if (known && Date.now() - known.at < SERVICES_TTL_MS) return known.value;

    // A camera that will not answer this still gets the usual paths tried: the
    // call failing is not proof that nothing is there.
    const xml = await call(
        endpoint,
        DEVICE_SERVICE,
        '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>'
    ).catch(() => "");

    const value = parseServices(xml);
    services.set(key, { value, at: Date.now() });
    return value;
}

/** Forget what a camera said about itself - after its address or its account
 *  changes, when the old answer describes a different device. */
export function forgetServices(address: string, port: number): void {
    services.delete(`${address}:${port}`);
}

export interface MediaProfile {
    readonly token: string;
    readonly name: string;
    /** Pixels across, when the camera says. What separates the stream worth
     *  watching from the one worth analyzing. */
    readonly width: number;
    /** The video encoding as the camera names it - "H264", "H265", "JPEG" -
     *  or "" when it does not say. */
    readonly encoding: string;
}

/**
 * The profiles in a GetProfiles answer, widest first. Pure for the test.
 *
 * Each profile is read from its own element. Reading the whole answer at once
 * pairs the n-th token with the n-th name and width, and a profile carries
 * several of each - its source's, its encoder's - so the pairs drift.
 */
export function parseProfiles(xml: string): MediaProfile[] {
    const blocks = xml.split(/<(?:[A-Za-z0-9._-]+:)?Profiles\b/).slice(1);
    return blocks
        .map((block) => {
            const token = /^[^>]*?\btoken="([^"]+)"/.exec(block)?.[1] ?? "";
            const encoder = tagValue(block, "VideoEncoderConfiguration") ?? block;
            const width = Number.parseInt(tagValue(encoder, "Width") ?? "", 10);
            return {
                token,
                name: tagValue(block, "Name") ?? token,
                width: Number.isFinite(width) ? width : 0,
                encoding: (tagValue(encoder, "Encoding") ?? "").toUpperCase()
            };
        })
        .filter((profile) => profile.token !== "")
        .sort((left, right) => right.width - left.width);
}

/** The streams this camera publishes, widest first, so the first is the main one
 *  and the last is the small one detection should read. */
export async function getProfiles(endpoint: OnvifEndpoint): Promise<MediaProfile[]> {
    const xml = await call(
        endpoint,
        (await getServices(endpoint)).media,
        '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>'
    );
    return parseProfiles(xml);
}

/**
 * The profile to watch and the one to analyze. Pure for the test.
 *
 * Only video profiles count. A Tapo C210 publishes a third one, a 640x360 JPEG
 * still at one frame a second on /stream8, and as the narrowest it used to be
 * picked as the small stream: the wall's thumbnails came out gray or empty,
 * because the relay was decoding stills from a stream meant for something else.
 */
export function pickProfiles(profiles: readonly MediaProfile[]): {
    main: MediaProfile | undefined;
    sub: MediaProfile | undefined;
} {
    const video = profiles.filter((profile) => profile.encoding !== "JPEG");
    const usable = video.length > 0 ? video : profiles;
    return {
        main: usable[0],
        sub: usable.length > 1 ? usable[usable.length - 1] : undefined
    };
}

/**
 * Where one profile's stream actually is.
 *
 * The camera answers with a full RTSP URL, and it is the authority: a vendor
 * default path is a guess, and this is the camera saying. The credentials are
 * stripped if it embedded any - Polaris keeps those in one place, encrypted, and
 * a URL that carries them is one that ends up in a log.
 */
export async function getStreamUri(
    endpoint: OnvifEndpoint,
    profileToken: string
): Promise<string | null> {
    const xml = await call(
        endpoint,
        (await getServices(endpoint)).media,
        `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup xmlns="http://www.onvif.org/ver10/schema"><Stream>RTP-Unicast</Stream><Transport><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${escapeXml(profileToken)}</ProfileToken></GetStreamUri>`
    );
    const uri = tagValue(xml, "Uri");
    return uri ? uri.replace(/^(rtsp:\/\/)[^@/]*@/i, "$1") : null;
}

/** Which way a camera is being asked to move, as a fraction of its top speed. */
export interface PtzVector {
    readonly pan: number;
    readonly tilt: number;
    readonly zoom: number;
}

/**
 * When each camera was last pointed somewhere, by address and port.
 *
 * Some cameras answer ONVIF one request at a time. A Tapo C200 holds every
 * other call - an arrow press included - for as long as an events long poll is
 * open on it, so the event watcher reads this and stands aside while somebody
 * is steering. Measured on one: a clock query sent during a ten-second pull
 * answered after 9.5 s, the moment the pull did.
 */
const steeredAt = new Map<string, number>();

/** How long after the last arrow the event watcher keeps standing aside. */
export const STEERING_GRACE_MS = 15_000;

function endpointKey(endpoint: OnvifEndpoint): string {
    return `${endpoint.address}:${endpoint.port}`;
}

/** Whether somebody pointed this camera within the last `withinMs`. */
export function recentlySteered(
    endpoint: OnvifEndpoint,
    withinMs = STEERING_GRACE_MS,
    now = Date.now()
): boolean {
    const at = steeredAt.get(endpointKey(endpoint));
    return at !== undefined && now - at < withinMs;
}

function noteSteering(endpoint: OnvifEndpoint): void {
    steeredAt.set(endpointKey(endpoint), Date.now());
}

/**
 * The longest one press may move a camera, as the camera's own timer.
 *
 * Polaris stops a camera on release, and again when a start answered after the
 * release. This is what holds when neither reaches it: a camera told to move
 * with a limit stops on its own when the limit runs out, rather than at the end
 * of its range or at its own default (20 s on a C200, 180 s on a C210).
 */
export const MOVE_LIMIT_SECONDS = 10;

/** Cameras that refused a move carrying a limit, and are sent moves without
 *  one. Learned per camera rather than assumed per make. */
const noMoveLimit = new Set<string>();

/** The ContinuousMove body, with the limit or without it. Pure for the test. */
export function continuousMoveBody(
    profileToken: string,
    vector: PtzVector,
    limitSeconds: number | null
): string {
    const clamp = (value: number) => Math.max(-1, Math.min(1, value)).toFixed(2);
    const limit = limitSeconds ? `<Timeout>PT${limitSeconds}S</Timeout>` : "";
    return `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken><Velocity xmlns="http://www.onvif.org/ver10/schema"><PanTilt x="${clamp(vector.pan)}" y="${clamp(vector.tilt)}"/><Zoom x="${clamp(vector.zoom)}"/></Velocity>${limit}</ContinuousMove>`;
}

/**
 * Start moving, and keep moving until told to stop or the limit runs out.
 *
 * Continuous rather than absolute on purpose: a person holding an arrow expects
 * the camera to travel while they hold it, and absolute moves turn that into a
 * series of jumps. The stop is not optional - a camera left moving keeps going -
 * so every caller pairs this with ptzStop, and the UI sends it on both mouse-up
 * and mouse-leave.
 */
export async function ptzMove(
    endpoint: OnvifEndpoint,
    profileToken: string,
    vector: PtzVector
): Promise<void> {
    noteSteering(endpoint);
    const service = (await getServices(endpoint)).ptz;
    const key = endpointKey(endpoint);
    if (noMoveLimit.has(key)) {
        await call(endpoint, service, continuousMoveBody(profileToken, vector, null));
        return;
    }
    try {
        await call(endpoint, service, continuousMoveBody(profileToken, vector, MOVE_LIMIT_SECONDS));
    } catch (error) {
        // Only a refusal says the limit itself might be the problem. A camera
        // that did not answer may yet act on the move, and sending a second one
        // behind it would only queue more travel.
        if (!(error instanceof OnvifError) || error.timedOut) throw error;
        await call(endpoint, service, continuousMoveBody(profileToken, vector, null));
        noMoveLimit.add(key);
    }
}

/** Stop waits longer than anything else: it is the one call that has to land,
 *  and on a camera that queues its requests it lands behind whatever is ahead. */
const STOP_TIMEOUT_MS = 15_000;

export async function ptzStop(endpoint: OnvifEndpoint, profileToken: string): Promise<void> {
    noteSteering(endpoint);
    await call(
        endpoint,
        (await getServices(endpoint)).ptz,
        `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`,
        STOP_TIMEOUT_MS
    );
}

export interface PtzPreset {
    readonly token: string;
    readonly name: string;
}

/** The positions somebody already saved on this camera. */
export async function getPresets(
    endpoint: OnvifEndpoint,
    profileToken: string
): Promise<PtzPreset[]> {
    const xml = await call(
        endpoint,
        (await getServices(endpoint)).ptz,
        `<GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken></GetPresets>`
    );
    const tokens = attrValues(xml, "Preset", "token");
    const names = tagValues(xml, "Name");
    return tokens.map((token, index) => ({ token, name: names[index] ?? token }));
}

export async function gotoPreset(
    endpoint: OnvifEndpoint,
    profileToken: string,
    preset: string
): Promise<void> {
    noteSteering(endpoint);
    await call(
        endpoint,
        (await getServices(endpoint)).ptz,
        `<GotoPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken><PresetToken>${escapeXml(preset)}</PresetToken></GotoPreset>`
    );
}

/**
 * Ask the camera to hold a mailbox of the things it notices.
 *
 * This is the whole reason the cheapest detector costs nothing: the camera is
 * already deciding that something moved, so Polaris subscribes and reads that
 * decision instead of looking at pixels itself. The subscription expires unless
 * it is pulled from, which is the behavior we want - a Polaris that stops asking
 * stops costing the camera anything.
 */
export async function createPullPoint(endpoint: OnvifEndpoint): Promise<string | null> {
    const xml = await call(
        endpoint,
        (await getServices(endpoint)).events,
        '<CreatePullPointSubscription xmlns="http://www.onvif.org/ver10/events/wsdl"><InitialTerminationTime>PT60S</InitialTerminationTime></CreatePullPointSubscription>'
    );
    // The camera answers with the address its mailbox lives at, which is usually
    // a full URL on itself.
    return tagValue(xml, "Address");
}

/**
 * How long one events pull asks the camera to wait for something to happen.
 *
 * Short on purpose. A camera that serves one request at a time - a Tapo C200 -
 * holds every other call behind an open pull, so this is also the longest an
 * arrow press can sit waiting for the camera to take it. A camera with nothing
 * to report answers an empty pull this often, which is a small SOAP document.
 */
export const PULL_WAIT_SECONDS = 2;

/**
 * How long Polaris waits for a pull to come back: the wait it asked the camera
 * for, plus the time any other call gets.
 *
 * Never less than the wait itself. Giving up on a pull before the camera was due
 * to answer is what kept a C200 saturated: the camera went on holding the pull
 * nobody read, the watcher counted it a failure and opened a new subscription
 * two seconds later, and the camera filled up with abandoned subscriptions
 * until it refused new ones and answered everything else 5-15 s late.
 */
export function pullTimeoutMs(waitSeconds: number): number {
    return waitSeconds * 1000 + TIMEOUT_MS;
}

export interface OnvifNotification {
    /** The topic as the camera words it, e.g. "tns1:RuleEngine/CellMotionDetector/Motion". */
    readonly topic: string;
    /** Whether the thing being reported is happening now or has just stopped. */
    readonly active: boolean;
}

/**
 * Read whatever the camera has put in the mailbox since the last read.
 *
 * `subscription` is the address the camera gave back. A camera that has forgotten
 * the subscription answers with a fault, which the caller treats as "make a new
 * one" rather than as a failure - subscriptions expiring is normal operation.
 */
export async function pullMessages(
    endpoint: OnvifEndpoint,
    subscription: string,
    waitSeconds = PULL_WAIT_SECONDS
): Promise<OnvifNotification[]> {
    const path = subscriptionPath(subscription);
    const wait = Math.max(1, Math.min(60, waitSeconds));
    const xml = await call(
        endpoint,
        path,
        `<PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl"><Timeout>PT${wait}S</Timeout><MessageLimit>32</MessageLimit></PullMessages>`,
        pullTimeoutMs(wait)
    );
    const topics = tagValues(xml, "Topic");
    // The camera reports the state as an attribute of an item named Value, and
    // both spellings are in the wild.
    const values = [...xml.matchAll(/\bName="IsMotion"[^>]*\bValue="([^"]+)"/g)].map(
        (match) => match[1]
    );
    return topics.map((topic, index) => ({
        topic,
        active: (values[index] ?? "true").toLowerCase() === "true"
    }));
}

/** The path part of the address a camera handed back for its mailbox. Cameras
 *  answer with an absolute URL on themselves, and some answer with one on an
 *  address only they can see, so only the path is kept and it is asked for on
 *  the address Polaris already knows works. */
function subscriptionPath(subscription: string): string {
    try {
        return new URL(subscription).pathname + new URL(subscription).search;
    } catch {
        return subscription.startsWith("/") ? subscription : `/${subscription}`;
    }
}

export interface CameraProbe {
    readonly device: DeviceInformation;
    readonly profiles: MediaProfile[];
    /** The stream to watch and the one to analyze, as the camera itself gave
     *  them. Either can be null on a camera that publishes only one. */
    readonly mainUrl: string | null;
    readonly subUrl: string | null;
    readonly ptz: boolean;
}

/**
 * Everything worth knowing about a camera, asked in one go.
 *
 * This is what the add-camera screen runs. It is also the answer to why the
 * vendor paths in vendors.ts are only starting points: when this succeeds, what
 * the camera said replaces them.
 */
export async function probeCamera(endpoint: OnvifEndpoint): Promise<CameraProbe> {
    const device = await getDeviceInformation(endpoint);
    const profiles = await getProfiles(endpoint).catch(() => [] as MediaProfile[]);
    const { main, sub } = pickProfiles(profiles);
    const [mainUrl, subUrl] = await Promise.all([
        main ? getStreamUri(endpoint, main.token).catch(() => null) : Promise.resolve(null),
        sub ? getStreamUri(endpoint, sub.token).catch(() => null) : Promise.resolve(null)
    ]);
    // Asked rather than assumed: a make that generally moves says nothing about
    // the one bolted to a wall, and an arrow that does nothing is worse than no
    // arrow.
    const ptz = main
        ? await getPresets(endpoint, main.token)
              .then(() => true)
              .catch(() => false)
        : false;
    return { device, profiles, mainUrl, subUrl, ptz };
}
