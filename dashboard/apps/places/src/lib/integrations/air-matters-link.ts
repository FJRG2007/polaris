/**
 * One device on Philips' fan and heater cloud, through its AWS IoT device
 * shadow: what it reports, and what it is asked to become.
 *
 * From Yooork/HA_Philips_Air_Plus `device_connection.py`, read from its source:
 *
 * - MQTT 3.1.1 over a WebSocket on 443 to the address `mqttInfo` handed out,
 *   signed by AWS (SigV4) in its query. That address is good for ONE
 *   connection: once a socket closes, the next one needs a fresh address, so a
 *   reconnect always starts by asking for one. The client id must be the one
 *   that came with it.
 * - Everything is the shadow of the thing named after the device: `get` answers
 *   on `get/accepted` with the reported state; a change is a `desired` patch
 *   published on `update`; the device answers with its new reported state on
 *   `update/documents` (and pushes `update/accepted` by itself whenever
 *   somebody changes it on the unit or in the app).
 * - No `Origin` header on the upgrade: AWS refuses one it does not expect, and
 *   the WebSocket client here sends none unless told to.
 *
 * One link per device, kept while Polaris keeps reading it, so the device's
 * own pushes land between two syncs; a link nobody has used for a quarter of an
 * hour is closed. A link that fails waits before the next attempt, doubling
 * from a second to five minutes, so a cloud that is down is not hammered.
 *
 * Nothing here logs: a payload is the device's, an address is a credential.
 *
 * Server-only.
 */

import mqtt from "mqtt";
import { DriverError } from "../drivers/contract";
import type { AirMattersTarget } from "./air-matters";

/** One value a shadow reports. */
export type ShadowValue = string | number | boolean;

const CONNECT_MS = 15_000;
const REPLY_MS = 6000;
const KEEPALIVE_S = 30;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
export const SHADOW_IDLE_MS = 15 * 60 * 1000;

function quiet(): DriverError {
    return new DriverError("The device did not answer through Philips' cloud.", "unreachable");
}

/** Only the flat values of a reported state; anything nested is not a reading. */
function flat(value: unknown): Record<string, ShadowValue> {
    const out: Record<string, ShadowValue> = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === "string" || typeof entry === "boolean") out[key] = entry;
        else if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
    }
    return out;
}

/** The reported state a shadow message carries, and whether it is the whole
 *  state or only what changed. */
export function shadowReported(
    topic: string,
    payload: string
): { reported: Record<string, ShadowValue>; whole: boolean } | null {
    let message: unknown;
    try {
        message = JSON.parse(payload) as unknown;
    } catch {
        return null;
    }
    if (!message || typeof message !== "object") return null;
    const body = message as {
        state?: { reported?: unknown };
        current?: { state?: { reported?: unknown } };
    };
    if (topic.endsWith("/get/accepted")) {
        return body.state?.reported ? { reported: flat(body.state.reported), whole: true } : null;
    }
    if (topic.endsWith("/update/documents")) {
        const reported = body.current?.state?.reported;
        return reported ? { reported: flat(reported), whole: true } : null;
    }
    if (topic.endsWith("/update/accepted")) {
        return body.state?.reported ? { reported: flat(body.state.reported), whole: false } : null;
    }
    return null;
}

export class ShadowLink {
    private client: mqtt.MqttClient | null = null;
    private opening: Promise<void> | null = null;
    private failures = 0;
    private retryAt = 0;
    private idleTimer: NodeJS.Timeout | null = null;
    private waiting: (() => void)[] = [];
    private current: { reported: Record<string, ShadowValue>; heardAt: number } = {
        reported: {},
        heardAt: 0
    };

    constructor(
        readonly thing: string,
        private readonly onIdle: (link: ShadowLink) => void
    ) {}

    /** What was last heard, merged. */
    get reported(): Readonly<Record<string, ShadowValue>> {
        return { ...this.current.reported };
    }

    get heardAt(): number {
        return this.current.heardAt;
    }

    get connected(): boolean {
        return this.client?.connected === true;
    }

    private topic(which: string): string {
        return `$aws/things/${this.thing}/shadow/${which}`;
    }

    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), SHADOW_IDLE_MS);
        this.idleTimer.unref?.();
    }

    close(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.drop();
        this.onIdle(this);
    }

    private drop(): void {
        const client = this.client;
        this.client = null;
        this.opening = null;
        client?.removeAllListeners();
        client?.end(true);
        this.release();
    }

    /** Wake everything waiting for an answer; they look at what arrived. */
    private release(): void {
        const waiting = this.waiting;
        this.waiting = [];
        for (const wake of waiting) wake();
    }

    private failed(client: mqtt.MqttClient): void {
        if (this.client === client) this.client = null;
        client.removeAllListeners();
        client.end(true);
        this.release();
        this.failures++;
        this.retryAt =
            Date.now() + Math.min(RETRY_FIRST_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    }

    /** Backoff state, for tests. */
    get retry(): { failures: number; at: number } {
        return { failures: this.failures, at: this.retryAt };
    }

    /** Open the link if it is not, with a fresh address: one is good for one
     *  connection only. */
    private async ensure(target: () => Promise<AirMattersTarget>): Promise<void> {
        this.touch();
        if (this.connected) return;
        if (Date.now() < this.retryAt) throw quiet();
        if (!this.opening) {
            const opening = this.connect(target).finally(() => {
                if (this.opening === opening) this.opening = null;
            });
            this.opening = opening;
        }
        await this.opening;
    }

    private async connect(target: () => Promise<AirMattersTarget>): Promise<void> {
        let where: AirMattersTarget;
        try {
            where = await target();
        } catch (caught) {
            this.failures++;
            this.retryAt =
                Date.now() + Math.min(RETRY_FIRST_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
            throw caught;
        }
        const client = mqtt.connect({
            protocol: "wss",
            hostname: where.hostname,
            port: 443,
            // Byte for byte: the signature covers it.
            path: where.path,
            clientId: where.clientId,
            protocolVersion: 4,
            clean: true,
            keepalive: KEEPALIVE_S,
            connectTimeout: CONNECT_MS,
            // The address is spent once this socket closes; reconnecting is
            // this class's job, with a new one.
            reconnectPeriod: 0,
            resubscribe: false
        });
        this.client = client;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const fail = () => {
                if (settled) return;
                settled = true;
                this.failed(client);
                reject(quiet());
            };
            client.once("connect", () => {
                if (this.client !== client) return fail();
                client.subscribe(
                    [
                        this.topic("get/accepted"),
                        this.topic("update/accepted"),
                        this.topic("update/documents")
                    ],
                    { qos: 1 },
                    (error, granted) => {
                        if (this.client !== client) return fail();
                        if (error || !granted?.some((grant) => grant.qos !== 128)) return fail();
                        settled = true;
                        this.failures = 0;
                        this.retryAt = 0;
                        resolve();
                    }
                );
            });
            client.on("message", (topic, payload) => this.heard(topic, payload.toString("utf8")));
            client.on("error", fail);
            client.on("close", () => {
                if (!settled) return fail();
                // Spent: the next use asks for a new address.
                if (this.client === client) this.failed(client);
            });
        });
    }

    private heard(topic: string, payload: string): void {
        const message = shadowReported(topic, payload);
        if (!message) return;
        this.current = {
            reported: message.whole
                ? message.reported
                : { ...this.current.reported, ...message.reported },
            heardAt: Date.now()
        };
        if (message.whole) this.release();
    }

    private publish(topic: string, payload: string): Promise<void> {
        const client = this.client;
        if (!client?.connected) return Promise.reject(quiet());
        return new Promise((resolve, reject) => {
            client.publish(topic, payload, { qos: 1, retain: false }, (error) =>
                error ? reject(quiet()) : resolve()
            );
        });
    }

    /** Settles when the next whole state arrives, or after a moment. */
    private nextWhole(): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, REPLY_MS);
            this.waiting.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /** Ask for the whole reported state and wait a moment for it. True once it
     *  came. */
    private async pull(): Promise<boolean> {
        const before = this.current.heardAt;
        const answered = this.nextWhole();
        await this.publish(this.topic("get"), "{}");
        await answered;
        return this.current.heardAt > before;
    }

    /** What the device reports now, and whether it answered. */
    async read(
        target: () => Promise<AirMattersTarget>
    ): Promise<{ reported: Readonly<Record<string, ShadowValue>>; answered: boolean }> {
        await this.ensure(target);
        const answered = await this.pull();
        return { reported: this.reported, answered };
    }

    /** Ask the device to become something: a `desired` patch on its shadow,
     *  never retained. The device answers with its new state on
     *  `update/documents`; only where that does not come is it asked for. */
    async desire(
        target: () => Promise<AirMattersTarget>,
        patch: Readonly<Record<string, ShadowValue>>
    ): Promise<void> {
        await this.ensure(target);
        const before = this.current.heardAt;
        const answered = this.nextWhole();
        await this.publish(this.topic("update"), JSON.stringify({ state: { desired: patch } }));
        await answered;
        if (this.current.heardAt === before) await this.pull().catch(() => false);
    }
}

/** Every link this process holds, by account and device. */
const links = new Map<string, ShadowLink>();

export function shadowLink(account: string, thing: string): ShadowLink {
    const key = `${account}\u0000${thing}`;
    let link = links.get(key);
    if (!link) {
        link = new ShadowLink(thing, (closed) => {
            if (links.get(key) === closed) links.delete(key);
        });
        links.set(key, link);
    }
    return link;
}

export function closeShadowLinks(account: string): void {
    for (const [key, link] of [...links]) {
        if (key.startsWith(`${account}\u0000`)) link.close();
    }
}

/** For tests: close everything and start clean. */
export function resetShadowLinks(): void {
    for (const link of [...links.values()]) link.close();
    links.clear();
}
