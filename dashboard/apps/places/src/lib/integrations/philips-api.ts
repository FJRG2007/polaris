/**
 * Philips air purifiers' local protocol: finding units, reading one and telling
 * it what to do.
 *
 * Written from aioairctrl's `coap/client.py` (betaboon, MIT) and philips-airctrl
 * 1.2.0's (domalab, MIT, the library Home Assistant's Philips integration pins),
 * and from that integration's `client.py` for the units that only push:
 *
 * - **Sync**: `POST /sys/dev/sync` with eight random upper-case hex digits; the
 *   unit answers with its counter, which every message sealed afterwards moves
 *   on by one (`philips-crypto.ts`).
 * - **Status**: `GET /sys/dev/status` with Observe 0 - the units only serve it as
 *   an observation - answered sealed, `{"state": {"reported": {...}}}`. A one-off
 *   read stops listening after the first answer, as `get_status(observe=False)`.
 * - **Control**: `POST /sys/dev/control` with `{"state": {"desired":
 *   {"CommandType": "app", "DeviceId": "", "EnduserId": "", ...}}}` sealed; the
 *   answer is plain JSON, `{"status": "success"}` or not. Not success is synced
 *   again and resent, as `set_control_values` does.
 * - **Info**: `GET /sys/dev/info`, plain JSON with the model id, which every
 *   firmware serves without a sync - so it is what a scan asks.
 * - **Nudge**: firmware that never answers a status read pushes one when
 *   something changes, so a value is written and put back on the same link
 *   while the observation is open (`async_fetch_status_with_nudge`).
 *
 * Every message is non-confirmable, as the libraries send them; the unit is
 * known to reuse message ids, so nothing is matched by id - only by token.
 *
 * Server-only.
 */

import { randomBytes } from "node:crypto";
import { DriverError } from "../drivers/contract";
import { CoapCode, CoapType, type CoapMessage } from "./coap";
import { coapScan, openCoapLink, type CoapLink } from "./philips-udp";
import { PhilipsCipher, PhilipsDigestError, openPhilips, pythonJson } from "./philips-crypto";
import {
    PHILIPS_GARBLED,
    PHILIPS_LOCAL_OFF,
    PHILIPS_QUIET,
    PHILIPS_REFUSED
} from "./philips-sentences";

/** How long one request is given. A unit on a busy access point is slow now
 *  and then; anything past this is retried rather than waited on. */
export const REQUEST_WINDOW_MS = 4000;
/** How long a scan listens for units to say what they are. */
export const SCAN_WINDOW_MS = 3000;
/** `_NUDGE_REGISTER_DELAY`, `_NUDGE_WAIT_TIMEOUT`, `_NUDGE_ATTEMPTS`. */
export const NUDGE_REGISTER_MS = 2000;
export const NUDGE_WAIT_MS = 12000;
const NUDGE_ATTEMPTS = 2;
/** `set_control_values` retries five times; three is as sure on a unit that
 *  answers at all, and keeps a press from hanging for half a minute. */
const CONTROL_RETRIES = 3;
/** `RETRY_DELAY`. */
const RETRY_DELAY_MS = 500;

const STATUS_PATH = ["sys", "dev", "status"];
const CONTROL_PATH = ["sys", "dev", "control"];
const SYNC_PATH = ["sys", "dev", "sync"];
const INFO_PATH = ["sys", "dev", "info"];

/** What a unit reports, by its own key names. */
export type PhilipsStatus = Readonly<Record<string, unknown>>;

/** The sentences a reader sees, shared with the refusal table. */
export { PHILIPS_GARBLED, PHILIPS_LOCAL_OFF, PHILIPS_QUIET, PHILIPS_REFUSED };

function quiet(): DriverError {
    return new DriverError(PHILIPS_QUIET, "unreachable");
}

function localOff(): DriverError {
    return new DriverError(PHILIPS_LOCAL_OFF, "refused");
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function object(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** `{"state": {"reported": {...}}}`, opened, or null for anything else. */
export function reportedOf(sealed: Buffer | undefined): PhilipsStatus | null {
    if (!sealed) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(openPhilips(sealed.toString("utf8")));
    } catch (error) {
        if (error instanceof PhilipsDigestError)
            throw new DriverError(PHILIPS_GARBLED, "unreachable");
        return null;
    }
    return object(object(object(parsed)?.state)?.reported);
}

/** The control message, as the libraries write it. */
export function controlPayload(values: Readonly<Record<string, unknown>>): string {
    return pythonJson({
        state: { desired: { CommandType: "app", DeviceId: "", EnduserId: "", ...values } }
    });
}

/**
 * One conversation with one unit, over one link: the counter it handed over at
 * sync, and a token per request.
 */
export class PhilipsSession {
    private cipher: PhilipsCipher | null = null;
    private messageId = randomBytes(2).readUInt16BE(0);

    constructor(readonly link: CoapLink) {}

    static async open(address: string): Promise<PhilipsSession> {
        try {
            return new PhilipsSession(await openCoapLink(address));
        } catch {
            throw quiet();
        }
    }

    private nextId(): number {
        this.messageId = (this.messageId + 1) & 0xffff;
        return this.messageId;
    }

    /** Send a request and wait for the answer that carries its token. */
    async request(
        code: number,
        path: readonly string[],
        options: {
            readonly observe?: number;
            readonly payload?: Buffer;
            readonly token?: Buffer;
        } = {},
        windowMs = REQUEST_WINDOW_MS
    ): Promise<CoapMessage | null> {
        const token = options.token ?? randomBytes(4);
        this.link.send({
            type: CoapType.NON,
            code,
            messageId: this.nextId(),
            token,
            path,
            ...(options.observe !== undefined ? { observe: options.observe } : {}),
            ...(options.payload ? { payload: options.payload } : {})
        });
        return this.link.next(
            (message) => message.code !== CoapCode.EMPTY && message.token.equals(token),
            windowMs
        );
    }

    /** Ask the unit for its counter. */
    async sync(): Promise<void> {
        const answer = await this.request(CoapCode.POST, SYNC_PATH, {
            payload: Buffer.from(randomBytes(4).toString("hex").toUpperCase(), "ascii")
        });
        if (!answer?.payload) throw this.link.refused ? localOff() : quiet();
        try {
            this.cipher = new PhilipsCipher(answer.payload.toString("ascii"));
        } catch {
            throw new DriverError(PHILIPS_GARBLED, "unreachable");
        }
    }

    /** One read of the status, then no more listening. */
    async status(windowMs = REQUEST_WINDOW_MS): Promise<PhilipsStatus | null> {
        const answer = await this.request(CoapCode.GET, STATUS_PATH, { observe: 0 }, windowMs);
        return answer ? reportedOf(answer.payload) : null;
    }

    /** Set these values. True once the unit said success. */
    async control(values: Readonly<Record<string, unknown>>): Promise<boolean> {
        if (!this.cipher) await this.sync();
        const sealed = this.cipher!.seal(controlPayload(values));
        const answer = await this.request(CoapCode.POST, CONTROL_PATH, {
            payload: Buffer.from(sealed, "ascii")
        });
        if (!answer?.payload) return false;
        try {
            return object(JSON.parse(answer.payload.toString("utf8")))?.status === "success";
        } catch {
            return false;
        }
    }

    /** The plain identity resource. */
    async info(windowMs = REQUEST_WINDOW_MS): Promise<Record<string, unknown> | null> {
        const answer = await this.request(CoapCode.GET, INFO_PATH, {}, windowMs);
        if (!answer?.payload) return null;
        try {
            return object(JSON.parse(answer.payload.toString("utf8")));
        } catch {
            return null;
        }
    }

    close(): void {
        this.link.close();
    }
}

/**
 * Read a unit's status: sync, then one read - and when that goes unanswered,
 * the whole thing again on a fresh link, which is what gets a unit whose CoAP
 * has wedged (a known firmware fault) talking again. Throws the firmware
 * sentence when the unit's address refuses the port outright.
 */
export async function readPhilips(address: string): Promise<PhilipsStatus> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const session = await PhilipsSession.open(address);
        try {
            await session.sync();
            const status = await session.status();
            if (status) return status;
            if (session.link.refused) throw localOff();
        } catch (error) {
            if (!(error instanceof DriverError) || error.message !== PHILIPS_QUIET || attempt === 1)
                throw error;
        } finally {
            session.close();
        }
        await wait(RETRY_DELAY_MS);
    }
    throw quiet();
}

/** Set values on a unit: synced, sent, and on anything but success synced
 *  again and resent. */
export async function controlPhilips(
    address: string,
    values: Readonly<Record<string, unknown>>
): Promise<void> {
    const session = await PhilipsSession.open(address);
    try {
        for (let attempt = 0; attempt <= CONTROL_RETRIES; attempt += 1) {
            if (attempt > 0) await wait(RETRY_DELAY_MS);
            try {
                await session.sync();
            } catch (error) {
                if (attempt === CONTROL_RETRIES) throw error;
                continue;
            }
            if (await session.control(values)) return;
        }
        throw session.link.refused ? localOff() : new DriverError(PHILIPS_REFUSED, "refused");
    } finally {
        session.close();
    }
}

/** The plain identity of a unit, or null when nothing answers. */
export async function infoPhilips(address: string): Promise<Record<string, unknown> | null> {
    const session = await PhilipsSession.open(address);
    try {
        return await session.info();
    } finally {
        session.close();
    }
}

/**
 * Read a unit that only pushes: open the observation, let it register, then
 * write each value of the nudge in turn on the same link until a push arrives
 * (`async_fetch_status_with_nudge`). The link is handed back open, still
 * observing, for whoever wants the pushes after this one.
 */
export async function nudgedPhilips(
    address: string,
    nudge: readonly (readonly [string, unknown])[]
): Promise<{ status: PhilipsStatus; session: PhilipsSession; token: Buffer }> {
    const session = await PhilipsSession.open(address);
    try {
        await session.sync();
        const token = randomBytes(4);
        const pushed = session.request(
            CoapCode.GET,
            STATUS_PATH,
            { observe: 0, token },
            NUDGE_REGISTER_MS
        );
        const first = await pushed;
        if (first) {
            const status = reportedOf(first.payload);
            if (status) return { status, session, token };
        }
        for (let attempt = 0; attempt < NUDGE_ATTEMPTS; attempt += 1) {
            for (const [key, value] of nudge)
                await session.control({ [key]: value }).catch(() => false);
            const push = await session.link.next(
                (message) => message.code !== CoapCode.EMPTY && message.token.equals(token),
                NUDGE_WAIT_MS
            );
            const status = push ? reportedOf(push.payload) : null;
            if (status) return { status, session, token };
        }
        throw session.link.refused ? localOff() : quiet();
    } catch (error) {
        session.close();
        throw error;
    }
}

/** A unit as a scan found it. */
export interface PhilipsFound {
    readonly address: string;
    readonly model: string;
    readonly name: string;
    readonly deviceId: string;
}

/** Ask these addresses who is a Philips air purifier: the plain identity
 *  resource, which needs no sync. Each address once. */
export async function scanPhilips(
    targets: readonly string[],
    windowMs = SCAN_WINDOW_MS
): Promise<PhilipsFound[]> {
    if (targets.length === 0) return [];
    const replies = await coapScan(
        targets,
        {
            type: CoapType.NON,
            code: CoapCode.GET,
            messageId: randomBytes(2).readUInt16BE(0),
            token: randomBytes(4),
            path: INFO_PATH
        },
        windowMs
    );
    const found = new Map<string, PhilipsFound>();
    for (const { address, message } of replies) {
        if (found.has(address) || !message.payload) continue;
        let info: Record<string, unknown> | null = null;
        try {
            info = object(JSON.parse(message.payload.toString("utf8")));
        } catch {
            continue;
        }
        const model = typeof info?.modelid === "string" ? info.modelid.trim() : "";
        if (!model) continue;
        found.set(address, {
            address,
            model: model.slice(0, 120),
            name: typeof info?.name === "string" ? info.name.trim().slice(0, 120) : "",
            deviceId: typeof info?.device_id === "string" ? info.device_id.trim().slice(0, 120) : ""
        });
    }
    return [...found.values()];
}
