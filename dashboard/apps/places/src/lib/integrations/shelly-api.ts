/**
 * A Shelly, asked over HTTP on its own network.
 *
 * Two generations with two APIs. The first answers plain paths
 * (`/status`, `/relay/0?turn=on`) behind HTTP Basic; the second and everything
 * since answer JSON-RPC (`/rpc/Shelly.GetStatus`, `/rpc/Switch.Set`) behind
 * SHA-256 digest authentication. `/shelly` is open on both and says which one is
 * listening, so it is always asked first.
 *
 * Everything here is from Shelly's own API documentation
 * (shelly-api-docs.shelly.cloud, gen1 and gen2). Every answer is parsed against
 * a schema before anything reads it: this is somebody else's firmware, and a
 * shape that changed under us has to fail here, saying so.
 *
 * Server-only.
 */

import { z } from "zod";
import { DriverError } from "../drivers/contract";
import { createHash, randomBytes } from "node:crypto";
import { deviceOrigin, jsonOf, lanRequest, type LanResponse } from "./lan-http";

/** The user every second-generation Shelly authenticates as. Their docs: it
 *  "must be set to admin". */
const RPC_USER = "admin";

export interface ShellyAddress {
    /** `http://host[:port]`, already checked. */
    readonly origin: string;
    readonly username: string;
    readonly password: string;
}

export function shellyAddress(
    host: string,
    username: string,
    password: string
): ShellyAddress | null {
    const origin = deviceOrigin(host, "http");
    return origin ? { origin, username: username || RPC_USER, password } : null;
}

const infoSchema = z
    .object({
        // Second generation and later.
        id: z.string().optional(),
        gen: z.number().int().optional(),
        model: z.string().optional(),
        app: z.string().optional(),
        ver: z.string().optional(),
        profile: z.string().optional(),
        // First generation.
        type: z.string().optional(),
        fw: z.string().optional(),
        // Both.
        mac: z.string()
    })
    .passthrough();

export type ShellyInfo = z.infer<typeof infoSchema>;

function odd(): DriverError {
    return new DriverError("The device answered with something unexpected.", "refused");
}

function passwordRefused(): DriverError {
    return new DriverError(
        "The Shelly refused the password. It is the one set in the Shelly app under the device's authentication settings.",
        "unauthorized"
    );
}

function parsed<T>(schema: z.ZodType<T>, response: LanResponse): T {
    const result = schema.safeParse(jsonOf(response));
    if (!result.success) throw odd();
    return result.data;
}

/** What the device says it is. Never needs a password. */
export async function shellyInfo(address: ShellyAddress): Promise<ShellyInfo> {
    const response = await lanRequest({ url: `${address.origin}/shelly` });
    if (response.status !== 200) {
        throw new DriverError("That address answered, but not as a Shelly.", "refused");
    }
    const result = infoSchema.safeParse(jsonOf(response));
    if (!result.success)
        throw new DriverError("That address answered, but not as a Shelly.", "refused");
    return result.data;
}

/** Which API a device answers. A missing `gen` is the first generation, which
 *  predates the field. */
export function generationOf(info: ShellyInfo): 1 | 2 {
    return typeof info.gen === "number" && info.gen >= 2 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Digest, for the second generation
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The digest response, as RFC 7616 defines it for `qop=auth` with SHA-256:
 * H(H(user:realm:password):nonce:nc:cnonce:qop:H(method:uri)).
 */
export function digestResponse(input: {
    readonly username: string;
    readonly password: string;
    readonly realm: string;
    readonly nonce: string;
    readonly nc: string;
    readonly cnonce: string;
    readonly qop: string;
    readonly method: string;
    readonly uri: string;
}): string {
    const ha1 = sha256Hex(`${input.username}:${input.realm}:${input.password}`);
    const ha2 = sha256Hex(`${input.method}:${input.uri}`);
    return sha256Hex(`${ha1}:${input.nonce}:${input.nc}:${input.cnonce}:${input.qop}:${ha2}`);
}

/** The parameters of a `WWW-Authenticate: Digest ...` challenge. */
export function digestChallenge(header: string): Record<string, string> | null {
    if (!/^\s*digest\s/i.test(header)) return null;
    const values: Record<string, string> = {};
    for (const match of header.matchAll(/([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/gi)) {
        values[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
    }
    return values.realm && values.nonce ? values : null;
}

/**
 * One RPC method, answered with its result.
 *
 * The params go in the body of a POST to `/rpc/<method>`, which their docs give
 * as equivalent to the whole JSON-RPC frame, and the reply is the result alone.
 * A device with a password answers the first attempt with a digest challenge;
 * the call is made again once with the answer to it.
 */
export async function shellyRpc(
    address: ShellyAddress,
    method: string,
    params: Record<string, unknown> = {}
): Promise<unknown> {
    const uri = `/rpc/${method}`;
    const body = JSON.stringify(params);
    const send = (authorization?: string) =>
        lanRequest({
            url: `${address.origin}${uri}`,
            method: "POST",
            body,
            headers: {
                "content-type": "application/json",
                ...(authorization ? { authorization } : {})
            }
        });

    let response = await send();
    if (response.status === 401) {
        if (!address.password) {
            throw new DriverError(
                "This Shelly has a password. Add it to the connection.",
                "unauthorized"
            );
        }
        const raw = response.headers["www-authenticate"];
        const challenge = digestChallenge(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
        if (!challenge) throw passwordRefused();
        const nc = "00000001";
        const cnonce = randomBytes(16).toString("hex");
        const qop = "auth";
        const answer = digestResponse({
            username: RPC_USER,
            password: address.password,
            realm: challenge.realm!,
            nonce: challenge.nonce!,
            nc,
            cnonce,
            qop,
            method: "POST",
            uri
        });
        response = await send(
            `Digest username="${RPC_USER}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", algorithm=SHA-256, response="${answer}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
        );
        if (response.status === 401) throw passwordRefused();
    }
    if (response.status === 429) {
        throw new DriverError(
            "The Shelly is refusing requests for a while after too many wrong passwords.",
            "unreachable"
        );
    }
    if (response.status !== 200)
        throw new DriverError("The device refused the request.", "refused");
    const result = jsonOf(response);
    if (result === null) throw odd();
    return result;
}

const rpcStatusSchema = z.record(z.string(), z.unknown());

/** Everything the device is doing, by component (`switch:0`, `light:0`, ...). */
export async function shellyStatus(address: ShellyAddress): Promise<Record<string, unknown>> {
    const result = rpcStatusSchema.safeParse(await shellyRpc(address, "Shelly.GetStatus"));
    if (!result.success) throw odd();
    return result.data;
}

/** Everything it is set to, by the same components - where the names are. */
export async function shellyConfig(address: ShellyAddress): Promise<Record<string, unknown>> {
    const result = rpcStatusSchema.safeParse(await shellyRpc(address, "Shelly.GetConfig"));
    if (!result.success) throw odd();
    return result.data;
}

// ---------------------------------------------------------------------------
// The first generation
// ---------------------------------------------------------------------------

function basic(address: ShellyAddress): Record<string, string> {
    if (!address.password) return {};
    const token = Buffer.from(`${address.username}:${address.password}`, "utf8").toString("base64");
    return { authorization: `Basic ${token}` };
}

/** One path on a first-generation device, as JSON. */
export async function shellyGet(
    address: ShellyAddress,
    path: string
): Promise<Record<string, unknown>> {
    const response = await lanRequest({ url: `${address.origin}${path}`, headers: basic(address) });
    if (response.status === 401) {
        if (!address.password) {
            throw new DriverError(
                "This Shelly has a password. Add it to the connection.",
                "unauthorized"
            );
        }
        throw passwordRefused();
    }
    if (response.status !== 200)
        throw new DriverError("The device refused the request.", "refused");
    return parsed(rpcStatusSchema, response);
}
