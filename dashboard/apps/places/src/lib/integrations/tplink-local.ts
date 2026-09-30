/**
 * TP-Link's plugs, strips, switches and bulbs, on their own network.
 *
 * Three generations answer in three ways and none of them says which it is:
 *
 * - The old Kasa firmware: JSON with a running XOR, over TCP on port 9999.
 * - Kasa on newer firmware: the same JSON ("IOT") inside KLAP, over HTTP on 80,
 *   with the md5 version of the handshake.
 * - Tapo, and the newest Kasa: a different JSON ("SMART") inside KLAP, with the
 *   SHA-256 version.
 *
 * So a device is found by asking. The KLAP handshake is the same first step for
 * both versions, and which formula the device's answer matches says which one it
 * is - and so which JSON it speaks. A device that refuses the connection on 80 is
 * tried on 9999. Everything after that is the same two operations: read the
 * device, and tell it to switch.
 *
 * The protocols are TP-Link's and undocumented by them; this follows python-kasa,
 * which is where they are written down (`kasa/transports/*`,
 * `kasa/protocols/smartprotocol.py`, `kasa/iot/*`). Tapo plugs on firmware old
 * enough to use their earlier AES handshake are not reached by this.
 *
 * Server-only.
 */

import { lanRequest } from "./lan-http";
import { Socket, isIP } from "node:net";
import * as crypto from "./tplink-crypto";
import { DriverError } from "../drivers/contract";
import { forbiddenAddress, forbiddenError, guardedLookup } from "./lan-address";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const KLAP_PORT = 80;
const XOR_PORT = 9999;
const TIMEOUT_MS = 6000;

/** A reply from port 9999 larger than this is not a plug. */
const MAX_XOR_BYTES = 1_000_000;

function fromBase64(value: string): string {
    return Buffer.from(value, "base64").toString("utf8");
}

/**
 * The accounts a device may be holding instead of its owner's.
 *
 * python-kasa's `kasa/credentials.py`, as they store them (base64): a device
 * that has never been bound to a cloud account answers to TP-Link's setup
 * credentials or to none at all, and one that has been "will switch
 * intermittently between the users cloud credentials and default kasa
 * credentials". Trying them is what makes the second of those work at all.
 */
const DEFAULT_ACCOUNTS: readonly (readonly [string, string])[] = (
    [
        ["a2FzYUB0cC1saW5rLm5ldA==", "a2FzYVNldHVw"],
        ["dGVzdEB0cC1saW5rLm5ldA==", "dGVzdA=="]
    ] as const
).map(([user, pass]) => [fromBase64(user), fromBase64(pass)] as const);

/** Their codes for "that account is not the one this device holds". Anything
 *  else refuses the request without saying the credentials are wrong. */
const SMART_AUTH_ERRORS = new Set([-1501, 1111, -1005, 1100, 1003, -40412]);

export interface TplinkAddress {
    readonly host: string;
    readonly username: string;
    readonly password: string;
}

/** Which JSON a device speaks, found by how it answered. */
export type TplinkFamily = "smart" | "iot";

/** An open conversation with one device, for as long as one read or one press. */
export interface TplinkLink {
    readonly family: TplinkFamily;
    send(request: Record<string, unknown>): Promise<unknown>;
}

function refusedAccount(): DriverError {
    return new DriverError(
        "The device would not accept that TP-Link account. Use the email and password you sign into the Tapo or Kasa app with.",
        "unauthorized"
    );
}

function odd(): DriverError {
    return new DriverError("The device answered with something unexpected.", "refused");
}

function parse(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw odd();
    }
}

// ---------------------------------------------------------------------------
// Port 9999
// ---------------------------------------------------------------------------

/** One request on the old port: connect, write, read the length and the body,
 *  close. The reply is read by its length prefix rather than by the socket
 *  closing, which some firmware never does. */
export function xorExchange(host: string, request: string, port = XOR_PORT): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = new Socket();
        let buffer = Buffer.alloc(0);
        const fail = (error: DriverError) => {
            socket.destroy();
            reject(error);
        };
        socket.setTimeout(TIMEOUT_MS, () =>
            fail(new DriverError("The device did not answer in time.", "unreachable"))
        );
        socket.setNoDelay(true);
        socket.once("error", (error: NodeJS.ErrnoException) =>
            fail(
                error instanceof DriverError
                    ? error
                    : error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
                    ? new DriverError("That address could not be found on this network.", "unreachable")
                    : new DriverError("Nothing answered on that address and port.", "unreachable")
            )
        );
        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 4) return;
            const length = buffer.readUInt32BE(0);
            if (length > MAX_XOR_BYTES) {
                fail(odd());
                return;
            }
            if (buffer.length < 4 + length) return;
            socket.destroy();
            resolve(crypto.xorDecrypt(buffer.subarray(4, 4 + length)));
        });
        const bare = host.replace(/^\[|\]$/g, "");
        if (isIP(bare) && forbiddenAddress(bare)) {
            fail(forbiddenError());
            return;
        }
        socket.connect({ port, host: bare, lookup: guardedLookup }, () => socket.write(crypto.xorEncrypt(request)));
    });
}

// ---------------------------------------------------------------------------
// KLAP
// ---------------------------------------------------------------------------

function cookieOf(headers: Readonly<Record<string, string | string[] | undefined>>): string | null {
    const raw = headers["set-cookie"];
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const line of lines) {
        const found = /(?:^|;\s*)TP_SESSIONID=([^;]+)/.exec(line);
        if (found) return found[1]!;
    }
    return null;
}

/**
 * The two handshakes, and which version and account the device accepted.
 *
 * Null when nothing on port 80 speaks KLAP at all, so the caller can try the old
 * port. A device that does speak it and matches none of the accounts is a wrong
 * password, which is said rather than retried elsewhere.
 */
async function klapHandshake(
    address: TplinkAddress
): Promise<{ session: crypto.KlapSession; cookie: string; version: crypto.KlapVersion } | null> {
    const base = `http://${address.host}:${KLAP_PORT}/app`;
    const localSeed = randomBytes(16);
    let first;
    try {
        first = await lanRequest({
            url: `${base}/handshake1`,
            method: "POST",
            body: localSeed,
            timeoutMs: TIMEOUT_MS
        });
    } catch (caught) {
        if (caught instanceof DriverError && caught.kind === "unreachable") {
            // An address that could not be found is not going to be found on
            // another port either.
            if (caught.message.startsWith("That address could not be found")) throw caught;
            return null;
        }
        throw caught;
    }
    if (first.status !== 200 || first.body.length !== 48) return null;
    const remoteSeed = first.body.subarray(0, 16);
    const serverHash = first.body.subarray(16);
    const cookie = cookieOf(first.headers);

    const accounts: (readonly [string, string])[] = [
        [address.username, address.password],
        ...DEFAULT_ACCOUNTS,
        ["", ""]
    ];
    for (const version of [2, 1] as const) {
        for (const [username, password] of accounts) {
            const auth = crypto.klapAuthHash(version, username, password);
            if (!crypto.klapServerHash(version, localSeed, remoteSeed, auth).equals(serverHash)) continue;
            const second = await lanRequest({
                url: `${base}/handshake2`,
                method: "POST",
                body: crypto.klapClientHash(version, localSeed, remoteSeed, auth),
                headers: cookie ? { cookie: `TP_SESSIONID=${cookie}` } : {},
                timeoutMs: TIMEOUT_MS
            });
            if (second.status !== 200) throw refusedAccount();
            return {
                session: new crypto.KlapSession(localSeed, remoteSeed, auth),
                cookie: cookie ?? "",
                version
            };
        }
    }
    throw refusedAccount();
}

function klapLink(
    address: TplinkAddress,
    handshake: { session: crypto.KlapSession; cookie: string; version: crypto.KlapVersion }
): TplinkLink {
    // The version is the family: the md5 handshake is the Kasa JSON, the
    // SHA-256 one is Tapo's.
    const family: TplinkFamily = handshake.version === 2 ? "smart" : "iot";
    return {
        family,
        async send(request) {
            const { body, seq } = handshake.session.encrypt(JSON.stringify(request));
            const answer = await lanRequest({
                url: `http://${address.host}:${KLAP_PORT}/app/request?seq=${seq}`,
                method: "POST",
                body,
                headers: handshake.cookie ? { cookie: `TP_SESSIONID=${handshake.cookie}` } : {},
                timeoutMs: TIMEOUT_MS
            });
            if (answer.status === 403) throw refusedAccount();
            if (answer.status !== 200) throw odd();
            let text: string;
            try {
                text = handshake.session.decrypt(answer.body, seq);
            } catch {
                throw odd();
            }
            return parse(text);
        }
    };
}

function xorLink(address: TplinkAddress): TplinkLink {
    return {
        family: "iot",
        async send(request) {
            return parse(await xorExchange(address.host, JSON.stringify(request)));
        }
    };
}

/**
 * A conversation with whatever is at the address.
 *
 * `prefer` is only the order of asking. A Tapo is tried on KLAP first because it
 * has nothing else; an old Kasa is tried on 9999 first because that is quicker
 * than waiting for port 80 to say no.
 */
export async function openTplink(address: TplinkAddress, prefer: "klap" | "xor"): Promise<TplinkLink> {
    if (prefer === "xor") {
        try {
            const link = xorLink(address);
            await link.send({ system: { get_sysinfo: {} } });
            return link;
        } catch (caught) {
            if (!(caught instanceof DriverError) || caught.kind !== "unreachable") throw caught;
            if (caught.message.startsWith("That address could not be found")) throw caught;
        }
        const handshake = await klapHandshake(address);
        if (!handshake) throw new DriverError("Nothing answered on that address and port.", "unreachable");
        return klapLink(address, handshake);
    }
    const handshake = await klapHandshake(address);
    if (handshake) return klapLink(address, handshake);
    return xorLink(address);
}

// ---------------------------------------------------------------------------
// The SMART JSON (Tapo)
// ---------------------------------------------------------------------------

/** One id per process, as their app keeps one per install. */
const TERMINAL = createHash("md5").update(randomUUID()).digest("base64");

/** Ask a SMART device one thing. The error code is checked here, once. */
export async function smartCall(
    link: TplinkLink,
    method: string,
    params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const answer = await link.send({
        method,
        ...(params ? { params } : {}),
        request_time_milis: Date.now(),
        terminal_uuid: TERMINAL
    });
    if (!answer || typeof answer !== "object") throw odd();
    const code = (answer as { error_code?: unknown }).error_code;
    if (typeof code === "number" && code !== 0) {
        if (SMART_AUTH_ERRORS.has(code)) throw refusedAccount();
        throw new DriverError("The device refused the request.", "refused");
    }
    const result = (answer as { result?: unknown }).result;
    return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

/** How many pages of a strip's outlets to walk, at most. A strip has six. */
const MAX_CHILD_PAGES = 10;

/** Every outlet on a strip, walking their pages the way their app does. */
export async function smartChildren(link: TplinkLink): Promise<Record<string, unknown>[]> {
    const children: Record<string, unknown>[] = [];
    for (let page = 0; page < MAX_CHILD_PAGES; page += 1) {
        const result = await smartCall(
            link,
            "get_child_device_list",
            page === 0 ? undefined : { start_index: children.length }
        );
        const list = Array.isArray(result.child_device_list) ? result.child_device_list : [];
        children.push(...list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object"));
        const sum = typeof result.sum === "number" ? result.sum : children.length;
        if (list.length === 0 || children.length >= sum) break;
    }
    return children;
}

/** Tell one outlet of a strip what to do, through the strip. */
export async function smartChildCall(
    link: TplinkLink,
    childId: string,
    method: string,
    params: Record<string, unknown>
): Promise<void> {
    const result = await smartCall(link, "control_child", {
        device_id: childId,
        requestData: { method, params }
    });
    const inner = (result.responseData as { error_code?: unknown } | undefined)?.error_code;
    if (typeof inner === "number" && inner !== 0) {
        throw new DriverError("The device refused the request.", "refused");
    }
}

// ---------------------------------------------------------------------------
// The IOT JSON (Kasa)
// ---------------------------------------------------------------------------

/** Ask an IOT device one thing, addressed to one of a strip's outlets where
 *  `childId` is given. */
export async function iotCall(
    link: TplinkLink,
    target: string,
    command: string,
    argument: Record<string, unknown> = {},
    childId?: string
): Promise<Record<string, unknown>> {
    const request: Record<string, unknown> = { [target]: { [command]: argument } };
    if (childId) request.context = { child_ids: [childId] };
    const answer = await link.send(request);
    const section = (answer as Record<string, unknown> | null)?.[target] as Record<string, unknown> | undefined;
    const result = section?.[command] as Record<string, unknown> | undefined;
    const code = result?.err_code ?? section?.err_code;
    if (!result || (typeof code === "number" && code !== 0)) {
        throw new DriverError("The device refused the request.", "refused");
    }
    return result;
}
