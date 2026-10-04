/**
 * A Philips Hue bridge, over its local API (CLIP v2).
 *
 * The bridge speaks HTTPS with a certificate signed by Hue's own private
 * authority, and whose common name is the bridge's id. That is what makes it
 * checkable at all without a public name: the chain says it is a Hue bridge, the
 * name says it is this one. So every call is verified against the authorities
 * below, and against the id recorded when the bridge was paired - never with
 * verification switched off.
 *
 * Pairing is Hue's own: the link button on the bridge is pressed, and for the
 * next thirty seconds a POST to `/api` is answered with an application key
 * instead of "link button not pressed". Every later call carries that key.
 *
 * Endpoints and shapes are from Hue's CLIP v2 reference as the openhue OpenAPI
 * description and aiohue record it; every answer is parsed against a schema
 * before anything reads it.
 *
 * Server-only.
 */

import { z } from "zod";
import { DriverError } from "../drivers/contract";
import { jsonOf, lanRequest, type LanResponse } from "./lan-http";

/**
 * The authorities a bridge's certificate chains to.
 *
 * `root-bridge` (Philips Hue, 2017-2038) is the one Hue's "Using HTTPS" page
 * publishes; `Hue Root CA 01` (Signify Hue, 2025-2050) is its successor for
 * bridges issued since. Both as openHAB's Hue binding ships them
 * (`huebridge_cacert.pem`); the first is byte-identical to the copy taken from
 * Hue's own page.
 */
export const HUE_AUTHORITIES = [
    [
        "-----BEGIN CERTIFICATE-----",
        "MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw",
        "OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty",
        "b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5",
        "MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv",
        "b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86",
        "aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22",
        "jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV",
        "HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8",
        "ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz",
        "IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO",
        "MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2",
        "sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=",
        "-----END CERTIFICATE-----"
    ].join("\n"),
    [
        "-----BEGIN CERTIFICATE-----",
        "MIIBzDCCAXOgAwIBAgICEAAwCgYIKoZIzj0EAwIwPDELMAkGA1UEBhMCTkwxFDAS",
        "BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTAgFw0y",
        "NTAyMjUwMDAwMDBaGA8yMDUwMTIzMTIzNTk1OVowPDELMAkGA1UEBhMCTkwxFDAS",
        "BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTBZMBMG",
        "ByqGSM49AgEGCCqGSM49AwEHA0IABFfOO0jfSAUXGQ9kjEDzyBrcMQ3ItyA5krE+",
        "cyvb1Y3xFti7KlAad8UOnAx0FBLn7HZrlmIwm1QnX0fK3LPM13mjYzBhMB0GA1Ud",
        "DgQWBBTF1pSpsCASX/z0VHLigxU2CAaqoTAfBgNVHSMEGDAWgBTF1pSpsCASX/z0",
        "VHLigxU2CAaqoTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggq",
        "hkjOPQQDAgNHADBEAiAk7duT+IHbOGO4UUuGLAEpyYejGZK9Z7V9oSfnvuQ5BQIg",
        "IYSgwwxHXm73/JgcU9lAM6c8Bmu3UE3kBIUwBs1qXFw=",
        "-----END CERTIFICATE-----"
    ].join("\n")
].join("\n");

/** Whether a certificate's common name is the bridge Polaris paired with. The
 *  Bridge Pro writes its id in capitals; the id itself is not case-sensitive. */
export function isBridge(commonName: string, bridgeId: string): boolean {
    return commonName.trim().toLowerCase() === bridgeId.trim().toLowerCase();
}

/** The trust for a call to one bridge, or - with no id yet - to whichever Hue
 *  bridge answers, which is only ever the pairing call. */
function trustFor(bridgeId: string | null) {
    return {
        authority: HUE_AUTHORITIES,
        name: (commonName: string) =>
            bridgeId === null ? commonName.length > 0 : isBridge(commonName, bridgeId)
    };
}

export interface HueBridge {
    readonly host: string;
    readonly bridgeId: string;
    readonly appKey: string;
}

function keyRefused(): DriverError {
    return new DriverError(
        "The Hue bridge no longer accepts Polaris. Connect it again, pressing the button on the bridge first.",
        "unauthorized"
    );
}

function odd(): DriverError {
    return new DriverError("The device answered with something unexpected.", "refused");
}

function untrusted(caught: unknown): never {
    // A certificate that does not chain to Hue's authority is, in practice, a
    // bridge old enough to sign its own - or not a Hue bridge at all.
    if (caught instanceof DriverError && caught.message.startsWith("The device's certificate")) {
        throw new DriverError(
            "That address did not answer with a Hue bridge certificate. Check the address, and update the bridge in the Hue app if it is an old one.",
            "refused"
        );
    }
    throw caught;
}

/**
 * Which bridge is at an address: its id, read from the certificate it presents
 * and checked against what `/api/config` - which needs no key - says it is.
 */
export async function identifyBridge(host: string): Promise<string> {
    return (await bridgeAt(host)).bridgeId;
}

const configSchema = z
    .object({
        bridgeid: z.string(),
        name: z.string().max(200).optional(),
        modelid: z.string().max(60).optional(),
        mac: z.string().max(40).optional()
    })
    .passthrough();

/** A bridge as `/api/config` names it, behind a certificate that proves it. */
export interface HueBridgeFound {
    readonly bridgeId: string;
    readonly name: string;
    readonly model: string;
    readonly mac: string | null;
}

/** The bridge at an address, as `identifyBridge` checks it, with the name and
 *  model it gives - for the dialog to offer. */
export async function bridgeAt(host: string, timeoutMs?: number): Promise<HueBridgeFound> {
    let response: LanResponse;
    try {
        response = await lanRequest({
            url: `https://${host}/api/config`,
            trust: trustFor(null),
            ...(timeoutMs ? { timeoutMs } : {})
        });
    } catch (caught) {
        untrusted(caught);
    }
    const said = configSchema.safeParse(jsonOf(response));
    const presented = response.certificate?.commonName ?? "";
    if (!said.success || !presented || !isBridge(presented, said.data.bridgeid)) {
        throw new DriverError(
            "That address did not answer with a Hue bridge certificate. Check the address, and update the bridge in the Hue app if it is an old one.",
            "refused"
        );
    }
    const mac = said.data.mac?.trim().toUpperCase() ?? "";
    return {
        bridgeId: presented.toLowerCase(),
        name: said.data.name?.trim() || "Hue Bridge",
        model: said.data.modelid?.trim() || "",
        mac: /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null
    };
}

/**
 * Signify's discovery service: the bridges that last called home from the
 * same public address, by their address on the LAN. What Home Assistant's
 * `aiohue.discovery.discover_nupnp` asks when mDNS finds nothing. Public, no
 * key; Signify allows about one request in fifteen minutes from an address,
 * so its answer is kept that long.
 */
const NUPNP = "https://discovery.meethue.com/";
const NUPNP_TTL_MS = 15 * 60 * 1000;
const NUPNP_FAILED_TTL_MS = 60 * 1000;
let nupnp: { at: number; ttl: number; addresses: string[] } | null = null;

/** For tests: forget the discovery service's last answer. */
export function resetHueDiscovery(): void {
    nupnp = null;
}

export async function nupnpAddresses(): Promise<string[]> {
    if (nupnp && Date.now() - nupnp.at < nupnp.ttl) return nupnp.addresses;
    const remember = (addresses: string[], ttl: number): string[] => {
        nupnp = { at: Date.now(), ttl, addresses };
        return addresses;
    };
    try {
        const response = await fetch(NUPNP, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(4_000)
        });
        if (!response.ok)
            return remember([], response.status === 429 ? NUPNP_TTL_MS : NUPNP_FAILED_TTL_MS);
        const parsed = z
            .array(
                z
                    .object({ internalipaddress: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/) })
                    .passthrough()
            )
            .max(32)
            .safeParse(JSON.parse(await response.text()) as unknown);
        if (!parsed.success) return remember([], NUPNP_FAILED_TTL_MS);
        return remember(
            parsed.data.map((entry) => entry.internalipaddress),
            NUPNP_TTL_MS
        );
    } catch {
        return remember([], NUPNP_FAILED_TTL_MS);
    }
}

const pairingSchema = z
    .array(
        z.object({
            success: z
                .object({ username: z.string(), clientkey: z.string().optional() })
                .optional(),
            error: z
                .object({ type: z.number().int(), description: z.string().optional() })
                .optional()
        })
    )
    .min(1);

/**
 * Ask a bridge for a key. Only answered within thirty seconds of its button
 * being pressed; before that it says "link button not pressed" (type 101), which
 * becomes the one sentence somebody needs.
 */
export async function pairBridge(host: string, bridgeId: string): Promise<string> {
    const response = await lanRequest({
        url: `https://${host}/api`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ devicetype: "polaris#places", generateclientkey: true }),
        trust: trustFor(bridgeId)
    });
    const parsed = pairingSchema.safeParse(jsonOf(response));
    if (!parsed.success) throw odd();
    const first = parsed.data[0]!;
    if (first.success) return first.success.username;
    if (first.error?.type === 101) {
        throw new DriverError(
            "Press the link button on the Hue bridge, then select Connect within 30 seconds.",
            "refused"
        );
    }
    throw new DriverError("The Hue bridge would not pair with Polaris.", "refused");
}

const envelopeSchema = z.object({
    errors: z.array(z.object({ description: z.string() }).passthrough()).default([]),
    data: z.array(z.unknown()).default([])
});

async function clip(
    bridge: HueBridge,
    method: "GET" | "PUT",
    path: string,
    body?: unknown
): Promise<unknown[]> {
    const response = await lanRequest({
        url: `https://${bridge.host}/clip/v2/resource/${path}`,
        method,
        headers: {
            "hue-application-key": bridge.appKey,
            ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        trust: trustFor(bridge.bridgeId)
    });
    // The bridge answers a wrong key with a page of HTML rather than JSON, so
    // the status is what is read.
    if (response.status === 401 || response.status === 403) throw keyRefused();
    if (response.status === 429 || response.status === 503) {
        throw new DriverError("The Hue bridge is busy. Try again in a moment.", "unreachable");
    }
    const parsed = envelopeSchema.safeParse(jsonOf(response));
    if (!parsed.success) throw odd();
    if (response.status >= 400 || parsed.data.errors.length > 0) {
        throw new DriverError("The Hue bridge refused the request.", "refused");
    }
    return parsed.data.data;
}

const resourceRef = z.object({ rid: z.string(), rtype: z.string() });

const lightSchema = z
    .object({
        id: z.string(),
        owner: resourceRef,
        metadata: z
            .object({ name: z.string().default(""), archetype: z.string().default("") })
            .partial()
            .default({}),
        on: z.object({ on: z.boolean() }).optional()
    })
    .passthrough();

const deviceSchema = z
    .object({
        id: z.string(),
        product_data: z
            .object({
                model_id: z.string().optional(),
                product_name: z.string().optional(),
                product_archetype: z.string().optional(),
                software_version: z.string().optional()
            })
            .passthrough()
            .default({}),
        metadata: z
            .object({ name: z.string().default("") })
            .partial()
            .default({}),
        services: z.array(resourceRef).default([])
    })
    .passthrough();

const connectivitySchema = z
    .object({ id: z.string(), owner: resourceRef, status: z.string() })
    .passthrough();

export type HueLight = z.infer<typeof lightSchema>;
export type HueDevice = z.infer<typeof deviceSchema>;
export type HueConnectivity = z.infer<typeof connectivitySchema>;

function each<S extends z.ZodTypeAny>(schema: S, items: unknown[]): z.infer<S>[] {
    return items.flatMap((item): z.infer<S>[] => {
        const parsed = schema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

/** Every light, the devices they belong to, and whether each device is on the
 *  Zigbee network right now. Three reads, one answer. */
export async function readBridge(bridge: HueBridge): Promise<{
    lights: HueLight[];
    devices: HueDevice[];
    connectivity: HueConnectivity[];
}> {
    const [lights, devices, connectivity] = await Promise.all([
        clip(bridge, "GET", "light"),
        clip(bridge, "GET", "device"),
        clip(bridge, "GET", "zigbee_connectivity")
    ]);
    return {
        lights: each(lightSchema, lights),
        devices: each(deviceSchema, devices),
        connectivity: each(connectivitySchema, connectivity)
    };
}

/** Switch one light service on or off. A plug is a light service too. */
export async function switchLight(bridge: HueBridge, lightId: string, on: boolean): Promise<void> {
    await clip(bridge, "PUT", `light/${encodeURIComponent(lightId)}`, { on: { on } });
}
