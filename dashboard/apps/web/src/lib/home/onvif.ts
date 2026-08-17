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
        .update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(password ?? "", "utf8")]))
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
    const match = new RegExp(`<(?:[A-Za-z0-9._-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${localName}>`).exec(
        xml
    );
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
    const pattern = new RegExp(`<(?:[A-Za-z0-9._-]+:)?${localName}\\b[^>]*?\\b${attribute}="([^"]+)"`, "g");
    return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

export class OnvifError extends Error {}

/**
 * One SOAP call. `service` is the path below the host - the device service for
 * anything about the camera itself, the media or PTZ service for the rest.
 */
async function call(endpoint: OnvifEndpoint, service: string, body: string): Promise<string> {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${securityHeader(endpoint.username, endpoint.password)}<s:Body>${body}</s:Body></s:Envelope>`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
            throw new OnvifError("The camera did not answer in time");
        }
        throw new OnvifError("Could not reach the camera");
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
        "<GetDeviceInformation xmlns=\"http://www.onvif.org/ver10/device/wsdl\"/>"
    );
    return {
        manufacturer: tagValue(xml, "Manufacturer") ?? "",
        model: tagValue(xml, "Model") ?? "",
        firmware: tagValue(xml, "FirmwareVersion") ?? "",
        serial: tagValue(xml, "SerialNumber") ?? ""
    };
}

export interface MediaProfile {
    readonly token: string;
    readonly name: string;
    /** Pixels across, when the camera says. What separates the stream worth
     *  watching from the one worth analyzing. */
    readonly width: number;
}

/** The streams this camera publishes, widest first, so the first is the main one
 *  and the last is the small one detection should read. */
export async function getProfiles(endpoint: OnvifEndpoint): Promise<MediaProfile[]> {
    const xml = await call(endpoint, "/onvif/media_service", "<GetProfiles xmlns=\"http://www.onvif.org/ver10/media/wsdl\"/>");
    const tokens = attrValues(xml, "Profiles", "token");
    const names = tagValues(xml, "Name");
    const widths = tagValues(xml, "Width").map((value) => Number.parseInt(value, 10));
    return tokens
        .map((token, index) => ({
            token,
            name: names[index] ?? token,
            width: Number.isFinite(widths[index]) ? (widths[index] as number) : 0
        }))
        .sort((left, right) => right.width - left.width);
}

/**
 * Where one profile's stream actually is.
 *
 * The camera answers with a full RTSP URL, and it is the authority: a vendor
 * default path is a guess, and this is the camera saying. The credentials are
 * stripped if it embedded any - Polaris keeps those in one place, encrypted, and
 * a URL that carries them is one that ends up in a log.
 */
export async function getStreamUri(endpoint: OnvifEndpoint, profileToken: string): Promise<string | null> {
    const xml = await call(
        endpoint,
        "/onvif/media_service",
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
 * Start moving, and keep moving until told to stop.
 *
 * Continuous rather than absolute on purpose: a person holding an arrow expects
 * the camera to travel while they hold it, and absolute moves turn that into a
 * series of jumps. The stop is not optional - a camera left moving keeps going -
 * so every caller pairs this with ptzStop, and the UI sends it on both mouse-up
 * and mouse-leave.
 */
export async function ptzMove(endpoint: OnvifEndpoint, profileToken: string, vector: PtzVector): Promise<void> {
    const clamp = (value: number) => Math.max(-1, Math.min(1, value)).toFixed(2);
    await call(
        endpoint,
        "/onvif/ptz_service",
        `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken><Velocity xmlns="http://www.onvif.org/ver10/schema"><PanTilt x="${clamp(vector.pan)}" y="${clamp(vector.tilt)}"/><Zoom x="${clamp(vector.zoom)}"/></Velocity></ContinuousMove>`
    );
}

export async function ptzStop(endpoint: OnvifEndpoint, profileToken: string): Promise<void> {
    await call(
        endpoint,
        "/onvif/ptz_service",
        `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`
    );
}

export interface PtzPreset {
    readonly token: string;
    readonly name: string;
}

/** The positions somebody already saved on this camera. */
export async function getPresets(endpoint: OnvifEndpoint, profileToken: string): Promise<PtzPreset[]> {
    const xml = await call(
        endpoint,
        "/onvif/ptz_service",
        `<GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${escapeXml(profileToken)}</ProfileToken></GetPresets>`
    );
    const tokens = attrValues(xml, "Preset", "token");
    const names = tagValues(xml, "Name");
    return tokens.map((token, index) => ({ token, name: names[index] ?? token }));
}

export async function gotoPreset(endpoint: OnvifEndpoint, profileToken: string, preset: string): Promise<void> {
    await call(
        endpoint,
        "/onvif/ptz_service",
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
        "/onvif/event_service",
        "<CreatePullPointSubscription xmlns=\"http://www.onvif.org/ver10/events/wsdl\"><InitialTerminationTime>PT60S</InitialTerminationTime></CreatePullPointSubscription>"
    );
    // The camera answers with the address its mailbox lives at, which is usually
    // a full URL on itself.
    return tagValue(xml, "Address");
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
    waitSeconds = 20
): Promise<OnvifNotification[]> {
    const path = subscriptionPath(subscription);
    const xml = await call(
        endpoint,
        path,
        `<PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl"><Timeout>PT${Math.max(1, Math.min(60, waitSeconds))}S</Timeout><MessageLimit>32</MessageLimit></PullMessages>`
    );
    const topics = tagValues(xml, "Topic");
    // The camera reports the state as an attribute of an item named Value, and
    // both spellings are in the wild.
    const values = [...xml.matchAll(/\bName="IsMotion"[^>]*\bValue="([^"]+)"/g)].map((match) => match[1]);
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
    const main = profiles[0];
    const sub = profiles.length > 1 ? profiles[profiles.length - 1] : undefined;
    const [mainUrl, subUrl] = await Promise.all([
        main ? getStreamUri(endpoint, main.token).catch(() => null) : Promise.resolve(null),
        sub ? getStreamUri(endpoint, sub.token).catch(() => null) : Promise.resolve(null)
    ]);
    // Asked rather than assumed: a make that generally moves says nothing about
    // the one bolted to a wall, and an arrow that does nothing is worse than no
    // arrow.
    const ptz = main ? await getPresets(endpoint, main.token).then(() => true).catch(() => false) : false;
    return { device, profiles, mainUrl, subUrl, ptz };
}
