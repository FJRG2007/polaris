/**
 * An IKEA DIRIGERA hub, over its local API.
 *
 * IKEA publish nothing about it; this follows the `dirigera` Python library
 * (Leggin/dirigera, `hub/auth.py` and `hub/hub.py`), which is where the API is
 * written down, and node-dirigera-promise for what the hub answers while it is
 * waiting for its button.
 *
 * The hub speaks HTTPS on 8443 with a certificate of its own that no public
 * authority vouches for. Every library for it switches verification off; this
 * does not. The certificate is recorded the moment the hub is paired - the one
 * time somebody is standing next to it pressing its button - and every call after
 * must be answered by exactly that certificate, checked before the token is sent.
 *
 * Pairing is OAuth with PKCE: ask for a code, wait for the action button on the
 * hub to be pressed, trade the code for a token. The wait is the awkward part,
 * so it is done here, polling, rather than asking somebody to press two things
 * in an order.
 *
 * Server-only.
 */

import { z } from "zod";
import { jsonOf, lanRequest } from "./lan-http";
import { DriverError } from "../drivers/contract";
import { createHash, randomInt } from "node:crypto";

const PORT = 8443;

/** How long the hub is given for its button to be pressed, and how often it is
 *  asked in the meantime. */
const PAIRING_WINDOW_MS = 60_000;
const PAIRING_POLL_MS = 2000;

/** The verifier's alphabet and length, as `auth.py` has them. */
const VERIFIER_ALPHABET = "_-~.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const VERIFIER_LENGTH = 128;

export interface DirigeraHub {
    readonly host: string;
    readonly token: string;
    /** SHA-256 of the certificate the hub presented when it was paired. */
    readonly fingerprint: string;
}

/** A PKCE verifier, from a secure random source (the reference uses Python's
 *  `random`, which is not one). */
export function codeVerifier(): string {
    let out = "";
    for (let index = 0; index < VERIFIER_LENGTH; index += 1) {
        out += VERIFIER_ALPHABET[randomInt(VERIFIER_ALPHABET.length)];
    }
    return out;
}

/** base64url(sha256(verifier)) with the padding removed - RFC 7636's S256. */
export function codeChallenge(verifier: string): string {
    return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function odd(): DriverError {
    return new DriverError("The device answered with something unexpected.", "refused");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pair with the hub. Resolves once its action button has been pressed and the
 * code traded for a token, or refuses when a minute goes by without it.
 */
export async function pairHub(
    host: string,
    options: { windowMs?: number; pollMs?: number; name?: string } = {}
): Promise<DirigeraHub> {
    const verifier = codeVerifier();
    const query = new URLSearchParams({
        audience: "homesmart.local",
        response_type: "code",
        code_challenge: codeChallenge(verifier),
        code_challenge_method: "S256"
    });
    const authorize = await lanRequest({
        url: `https://${host}:${PORT}/v1/oauth/authorize?${query}`,
        // The one call whose certificate is taken on trust, and recorded.
        trust: { pin: null }
    });
    const fingerprint = authorize.certificate?.fingerprint ?? "";
    const code = z.object({ code: z.string().min(1) }).safeParse(jsonOf(authorize));
    if (authorize.status !== 200 || !code.success || !fingerprint) {
        throw new DriverError("That address did not answer as a DIRIGERA hub.", "refused");
    }

    const form = new URLSearchParams({
        code: code.data.code,
        name: options.name ?? "Polaris",
        grant_type: "authorization_code",
        code_verifier: verifier
    }).toString();
    const deadline = Date.now() + (options.windowMs ?? PAIRING_WINDOW_MS);
    for (;;) {
        const token = await lanRequest({
            url: `https://${host}:${PORT}/v1/oauth/token`,
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form,
            trust: { pin: fingerprint }
        });
        if (token.status === 200) {
            const parsed = z.object({ access_token: z.string().min(1) }).safeParse(jsonOf(token));
            if (!parsed.success) throw odd();
            return { host, token: parsed.data.access_token, fingerprint };
        }
        // 403 is the hub still waiting for its button.
        if (token.status !== 403)
            throw new DriverError("The DIRIGERA hub would not pair with Polaris.", "refused");
        if (Date.now() >= deadline) {
            throw new DriverError(
                "The hub's action button was not pressed in time. Select Connect, then press the action button on the hub within a minute.",
                "refused"
            );
        }
        await sleep(options.pollMs ?? PAIRING_POLL_MS);
    }
}

const HUB_REFUSED =
    "The DIRIGERA hub no longer accepts Polaris. Connect it again and press the hub's button.";

async function call(
    hub: DirigeraHub,
    method: "GET" | "PATCH",
    path: string,
    body?: unknown
): Promise<unknown> {
    const response = await lanRequest({
        url: `https://${hub.host}:${PORT}/v1${path}`,
        method,
        headers: {
            authorization: `Bearer ${hub.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        trust: { pin: hub.fingerprint }
    });
    if (response.status === 401 || response.status === 403) {
        throw new DriverError(HUB_REFUSED, "unauthorized");
    }
    if (response.status < 200 || response.status >= 300) {
        throw new DriverError("The DIRIGERA hub refused the request.", "refused");
    }
    return method === "GET" ? jsonOf(response) : null;
}

const deviceSchema = z
    .object({
        id: z.string(),
        type: z.string().default(""),
        deviceType: z.string().default(""),
        isReachable: z.boolean().default(true),
        attributes: z.record(z.string(), z.unknown()).default({})
    })
    .passthrough();

export type DirigeraDevice = z.infer<typeof deviceSchema>;

/** Everything paired to the hub. */
export async function hubDevices(hub: DirigeraHub): Promise<DirigeraDevice[]> {
    const answer = await call(hub, "GET", "/devices");
    if (!Array.isArray(answer)) throw odd();
    return answer.flatMap((item) => {
        const parsed = deviceSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

/** Switch a light or an outlet. The body is a list of changes, as the hub
 *  expects it. */
export async function setOn(hub: DirigeraHub, deviceId: string, on: boolean): Promise<void> {
    await call(hub, "PATCH", `/devices/${encodeURIComponent(deviceId)}`, [
        { attributes: { isOn: on } }
    ]);
}

const hubEvent = z.object({
    type: z.string(),
    data: z.object({ id: z.string().optional() }).passthrough().optional()
});

/**
 * Hear the hub's devices change, over the event stream it serves at
 * `wss://<hub>:8443/v1` to the same bearer token (`hub.py`'s
 * `create_event_listener`), checked against the same pinned certificate before
 * the token is sent. Hands `changed` the device id of each event about one, or
 * null for an event about the hub as a whole. Resolves when the stream closes;
 * rejects when it could not be opened.
 */
export async function listenHub(
    hub: DirigeraHub,
    changed: (deviceId: string | null) => void,
    signal: AbortSignal
): Promise<void> {
    const { openLanSocket, eachMessage } = await import("./lan-socket");
    const ws = await openLanSocket({
        url: `wss://${hub.host}:${PORT}/v1`,
        headers: { authorization: `Bearer ${hub.token}` },
        trust: { pin: hub.fingerprint },
        signInRefused: HUB_REFUSED
    });
    await eachMessage(
        ws,
        (text) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(text) as unknown;
            } catch {
                return;
            }
            const event = hubEvent.safeParse(parsed);
            if (!event.success) return;
            // `deviceStateChanged`, `deviceAdded`, `deviceRemoved`, and the
            // same for scenes and rooms; only a device's are news here.
            if (event.data.type.startsWith("device")) changed(event.data.data?.id ?? null);
        },
        signal
    );
}
