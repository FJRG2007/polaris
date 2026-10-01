/**
 * A Philips Air+ purifier through Philips' cloud: the MQTT link the Air+ app
 * itself keeps to it, read and written in the app's own messages.
 *
 * From the community integrations' source (see `philips-cloud.ts`):
 * NikGro/philips-air-plus-homeassistant `mqtt_client.py`, and
 * renaudallard/homeassistant_philips_homeid `mqtt_api.py`, which adds what the
 * decompiled app does that the first does not - power through the AWS IoT
 * shadow, one port read at a time, and a busy unit asked again.
 *
 * - AWS IoT over a WebSocket on 443 (`ats.prod.eu-da.iot.versuni.com/mqtt`),
 *   let in by a custom authorizer: the access token and the signature the IoT
 *   API issued for it ride on the upgrade request as headers. A new token needs
 *   a new signature, or the broker refuses the connection.
 * - The unit is spoken to on `da_ctrl/<thing>/to_ncp` and answers on
 *   `.../from_ncp`: `getPort` and `setPort` commands carrying a correlation id
 *   that the reply echoes. It also pushes a port by itself when something
 *   changes. Ports here: `Status` (mode, fan, PM2.5, allergen index), `filtRd`
 *   (the filters) and `Config` (`ctn`, the model).
 * - Power is not a port. It is `powerOn` in the device's shadow, set by
 *   publishing a desired state to `$aws/things/<thing>/shadow/update` and read
 *   from the shadow's `get/accepted` and `update/accepted` topics. The fan
 *   speed idles to 0 while the unit is on, so it is only a fallback for an
 *   account whose broker will not hand out the shadow.
 * - The unit's network processor serves one request at a time: concurrent reads
 *   are answered `busy` and a burst can wedge it until it is unplugged. Reads are
 *   queued, a second apart, and a busy one is asked again a few times.
 *
 * One link per device, kept for as long as Polaris keeps reading it: a sync
 * finds it open and its pushes already in, rather than paying a TLS handshake
 * and an authorizer call every minute. A link that drops is reconnected with
 * a backoff that doubles from a second to five minutes (`mqtt_client.py`'s
 * `_reconnect_base` and `_reconnect_max_backoff`), and one nobody has used for a
 * quarter of an hour is closed, so a connection that was removed stops costing
 * anything soon after.
 *
 * Nothing here logs: a payload is the unit's, a header is a credential.
 *
 * Server-only.
 */

import mqtt from "mqtt";
import { randomBytes } from "node:crypto";
import { DriverError } from "../drivers/contract";
import { PHILIPS_REFUSED } from "./philips-sentences";

export const PHILIPS_MQTT_URL = "wss://ats.prod.eu-da.iot.versuni.com:443/mqtt";

/** One value a port holds. */
export type CloudValue = string | number | boolean;

/** What the link is let in with: the account's token and its signature. */
export interface CloudAuth {
    readonly accessToken: string;
    readonly signature: string;
    readonly clientId: string;
}

/** What has been heard from a unit, merged across its ports. */
export interface CloudState {
    /** Every key of `Status` and `filtRd` as last reported. */
    readonly properties: Readonly<Record<string, CloudValue>>;
    /** The shadow's `powerOn`, or null until the shadow has been read. */
    readonly powerOn: boolean | null;
    /** `ctn` from `Config`, or null until it has been read. */
    readonly model: string | null;
    /** When the unit itself last said anything, or 0. */
    readonly heardAt: number;
}

const PORT_GAP_MS = 1000;
const BUSY_RETRY_MS = 3000;
const BUSY_RETRIES = 3;
const WRITE_RETRIES = 3;
/** How long a request waits for the unit's answer. Replies are QoS 0, so one
 *  can be lost; this bounds what a lost one costs. */
const REPLY_MS = 6000;
const CONNECT_MS = 15_000;
const KEEPALIVE_S = 60;
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;
/** A link nobody has used for this long is closed. */
export const IDLE_MS = 15 * 60 * 1000;
/** How often the filters and the model are read again; they hardly move. */
const SLOW_PORTS_MS = 10 * 60 * 1000;
/** A unit heard from within this long is online even if this read was lost. */
const HEARD_RECENTLY_MS = 2 * 60 * 1000;

const NCP_OK = 0;
const NCP_BUSY = 1;

interface Reply {
    readonly status: number | null;
    readonly properties: Record<string, CloudValue>;
}

function quiet(): DriverError {
    return new DriverError("The device did not answer through Philips' cloud.", "unreachable");
}

function busy(): DriverError {
    return new DriverError("The device is busy. Try again in a moment.", "refused");
}

function refusedLink(): DriverError {
    return new DriverError(
        "Philips' cloud would not let Polaris reach this device. Connect the account again.",
        "unauthorized"
    );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every JSON object in one payload. The broker may hand over several in one
 * frame (`_on_message`), so a payload is read object by object rather than
 * dropped whole for not being one document.
 */
export function cloudMessages(payload: string): Record<string, unknown>[] {
    const found: Record<string, unknown>[] = [];
    let depth = 0;
    let start = -1;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < payload.length; index++) {
        const char = payload[index]!;
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") {
            if (depth === 0) start = index;
            depth++;
        } else if (char === "}" && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                try {
                    const value = JSON.parse(payload.slice(start, index + 1)) as unknown;
                    if (value && typeof value === "object" && !Array.isArray(value))
                        found.push(value as Record<string, unknown>);
                } catch {
                    // A fragment that is not JSON is skipped; the next one may be.
                }
                start = -1;
            }
        }
    }
    return found;
}

/** Only the flat values a port reports; anything nested is not a reading. */
function flat(value: unknown): Record<string, CloudValue> {
    const out: Record<string, CloudValue> = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === "string" || typeof entry === "boolean") out[key] = entry;
        else if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
    }
    return out;
}

/** An NCP command, as the app writes one (`_build_command_payload`). */
export function ncpCommand(
    command: "getPort" | "setPort",
    port: string,
    properties: Readonly<Record<string, CloudValue>>,
    cid: string = randomBytes(4).toString("hex"),
    now: Date = new Date()
): { cid: string; payload: string } {
    const time = `${now.toISOString().slice(0, 19)}Z`;
    return {
        cid,
        payload: JSON.stringify({
            cid,
            time,
            type: "command",
            cn: command,
            ct: "mobile",
            data: { portName: port, properties }
        })
    };
}

/** Why a link could not be opened: refused by the broker, or not reached. */
function connectFailure(error: Error & { code?: number | string }): DriverError {
    // A refused authorizer answers the WebSocket upgrade with 401 or 403; a
    // refused CONNECT is return code 4 or 5 (134/135 in MQTT 5).
    if ([4, 5, 134, 135].includes(Number(error.code)) || /\b40[13]\b/.test(error.message)) {
        return refusedLink();
    }
    return new DriverError("Philips' cloud could not be reached.", "unreachable");
}

export class CloudLink {
    private client: mqtt.MqttClient | null = null;
    private auth: CloudAuth | null = null;
    private opening: Promise<void> | null = null;
    private failures = 0;
    private retryAt = 0;
    private retryTimer: NodeJS.Timeout | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private refused = false;
    private shadowGranted = false;
    private chain: Promise<unknown> = Promise.resolve();
    private abandon: (() => void) | null = null;
    private readonly pending = new Map<string, (reply: Reply | null) => void>();
    private slowReadAt = 0;
    private current: {
        properties: Record<string, CloudValue>;
        powerOn: boolean | null;
        model: string | null;
        heardAt: number;
    } = { properties: {}, powerOn: null, model: null, heardAt: 0 };

    constructor(
        readonly thing: string,
        private readonly onIdle: (link: CloudLink) => void
    ) {}

    get state(): CloudState {
        return { ...this.current, properties: { ...this.current.properties } };
    }

    get connected(): boolean {
        return this.client?.connected === true;
    }

    private topic(which: "to" | "from"): string {
        return `da_ctrl/${this.thing}/${which === "to" ? "to_ncp" : "from_ncp"}`;
    }

    private shadow(which: "get" | "update"): string {
        return `$aws/things/${this.thing}/shadow/${which}`;
    }

    /** Somebody used the link: push back the moment it closes for idleness. */
    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
        this.idleTimer.unref?.();
    }

    /** Close it for good and let the owner forget it. */
    close(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.idleTimer = null;
        this.retryTimer = null;
        this.drop();
        this.onIdle(this);
    }

    /**
     * Make sure the link is open with these credentials. A changed token means
     * a reconnect, since the broker only checks them at the upgrade; a link in
     * its backoff is not tried again before its time, so a broker that is down
     * is not hammered by every sync.
     */
    async ensure(auth: CloudAuth): Promise<void> {
        this.touch();
        const changed =
            !this.auth ||
            this.auth.accessToken !== auth.accessToken ||
            this.auth.signature !== auth.signature ||
            this.auth.clientId !== auth.clientId;
        if (changed) {
            this.auth = auth;
            this.refused = false;
            this.failures = 0;
            this.retryAt = 0;
            if (this.client || this.opening) this.drop();
        }
        if (this.connected) return;
        if (this.refused) throw refusedLink();
        if (Date.now() < this.retryAt) throw quiet();
        await this.open();
    }

    /** Let go of the current socket without giving up on the link. */
    private drop(): void {
        const client = this.client;
        this.client = null;
        client?.removeAllListeners();
        client?.end(true);
        this.abandon?.();
        this.abandon = null;
        this.opening = null;
        this.lose();
    }

    /** Answer every request still waiting as unanswered. */
    private lose(): void {
        for (const [cid, answer] of this.pending) {
            this.pending.delete(cid);
            answer(null);
        }
    }

    private open(): Promise<void> {
        if (!this.opening) {
            const opening = this.connect().finally(() => {
                if (this.opening === opening) this.opening = null;
            });
            this.opening = opening;
        }
        return this.opening;
    }

    private connect(): Promise<void> {
        const auth = this.auth;
        if (!auth) return Promise.reject(refusedLink());
        const client = mqtt.connect(PHILIPS_MQTT_URL, {
            clientId: auth.clientId,
            protocolVersion: 4,
            clean: true,
            keepalive: KEEPALIVE_S,
            connectTimeout: CONNECT_MS,
            // Reconnecting is this class's job: mqtt.js would replay the old
            // token's headers, and only `ensure` knows the new ones.
            reconnectPeriod: 0,
            resubscribe: false,
            wsOptions: {
                headers: {
                    "x-amz-customauthorizer-name": "CustomAuthorizer",
                    "x-amz-customauthorizer-signature": auth.signature,
                    tenant: "da",
                    "content-type": "application/json",
                    "token-header": `Bearer ${auth.accessToken.trim()}`
                }
            }
        });
        this.client = client;

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            this.abandon = () => {
                if (settled) return;
                settled = true;
                reject(quiet());
            };
            client.once("connect", () => {
                if (this.client !== client) return;
                client.subscribe(
                    [
                        this.topic("from"),
                        `${this.shadow("get")}/accepted`,
                        `${this.shadow("update")}/accepted`
                    ],
                    { qos: 0 },
                    (error, granted) => {
                        if (this.client !== client) return;
                        if (error || !granted?.some((grant) => grant.qos !== 128)) {
                            settled = true;
                            this.failed(client);
                            reject(quiet());
                            return;
                        }
                        // The unit's own topic is what matters; the shadow is
                        // what power is read from where the broker hands it out.
                        this.shadowGranted = granted.some(
                            (grant) => grant.topic.includes("/shadow/") && grant.qos !== 128
                        );
                        this.failures = 0;
                        this.retryAt = 0;
                        this.slowReadAt = 0;
                        settled = true;
                        this.abandon = null;
                        resolve();
                    }
                );
            });
            client.on("message", (topic, payload) => this.heard(topic, payload.toString("utf8")));
            client.on("error", (error: Error & { code?: number | string }) => {
                if (this.client !== client || settled) return;
                settled = true;
                const failure = connectFailure(error);
                if (failure.kind === "unauthorized") this.refused = true;
                this.failed(client);
                reject(failure);
            });
            client.on("close", () => {
                if (this.client !== client) return;
                if (!settled) {
                    settled = true;
                    this.failed(client);
                    reject(quiet());
                    return;
                }
                this.failed(client);
            });
        });
    }

    /** A socket that failed or dropped: forget it and try again later. */
    private failed(client: mqtt.MqttClient): void {
        if (this.client === client) this.client = null;
        client.removeAllListeners();
        client.end(true);
        this.abandon = null;
        this.lose();
        if (this.refused) return;
        this.failures++;
        const delay = Math.min(RETRY_FIRST_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
        this.retryAt = Date.now() + delay;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.connected && !this.refused && this.auth) void this.open().catch(() => {});
        }, delay);
        this.retryTimer.unref?.();
    }

    /** Backoff state, for tests and for a screen that wants to say "trying again". */
    get retry(): { failures: number; at: number } {
        return { failures: this.failures, at: this.retryAt };
    }

    private heard(topic: string, payload: string): void {
        for (const message of cloudMessages(payload)) {
            if (topic.includes("/shadow/")) {
                const state = message.state as { reported?: Record<string, unknown> } | undefined;
                const power = state?.reported?.powerOn;
                if (typeof power === "boolean") this.current.powerOn = power;
                continue;
            }
            this.current.heardAt = Date.now();
            const data = message.data as { portName?: unknown; properties?: unknown } | undefined;
            const properties = flat(data?.properties);
            const port = typeof data?.portName === "string" ? data.portName : "";
            if (port === "Config") {
                const ctn = properties.ctn;
                if (typeof ctn === "string" && ctn.trim()) this.current.model = ctn.trim();
            } else if (Object.keys(properties).length > 0) {
                this.current.properties = { ...this.current.properties, ...properties };
            }
            const cid = typeof message.cid === "string" ? message.cid : "";
            const answer = cid ? this.pending.get(cid) : undefined;
            if (answer && message.type !== "event") {
                this.pending.delete(cid);
                answer({
                    status: typeof message.status === "number" ? message.status : null,
                    properties
                });
            }
        }
    }

    private publish(topic: string, payload: string, qos: 0 | 1): Promise<void> {
        const client = this.client;
        if (!client?.connected) return Promise.reject(quiet());
        return new Promise((resolve, reject) => {
            client.publish(topic, payload, { qos, retain: false }, (error) =>
                error ? reject(quiet()) : resolve()
            );
        });
    }

    /** One NCP command and its answer, or null where none came in time. */
    private async ask(
        command: "getPort" | "setPort",
        port: string,
        properties: Readonly<Record<string, CloudValue>>
    ): Promise<Reply | null> {
        const { cid, payload } = ncpCommand(command, port, properties);
        const answer = new Promise<Reply | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(cid);
                resolve(null);
            }, REPLY_MS);
            this.pending.set(cid, (reply) => {
                clearTimeout(timer);
                resolve(reply);
            });
        });
        try {
            await this.publish(this.topic("to"), payload, 1);
        } catch (caught) {
            this.pending.delete(cid);
            throw caught;
        }
        return answer;
    }

    /** Run one exchange with the unit after every one before it, a gap apart. */
    private queued<T>(run: () => Promise<T>): Promise<T> {
        const next = this.chain.then(run, run);
        this.chain = next.then(
            () => sleep(PORT_GAP_MS),
            () => sleep(PORT_GAP_MS)
        );
        return next;
    }

    /** Read one port, asking again while the unit says it is busy. True once it
     *  answered. */
    private readPort(port: string): Promise<boolean> {
        return this.queued(async () => {
            for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
                const reply = await this.ask("getPort", port, {});
                if (!reply) return false;
                if (reply.status !== NCP_BUSY) return true;
                await sleep(BUSY_RETRY_MS);
            }
            return false;
        });
    }

    /**
     * What the unit is doing now: its status read afresh, the slow ports and the
     * shadow when they are due, and whether it answered. A unit whose read is
     * lost but was heard from a moment ago is still online.
     *
     * A purifier reports on `Status` and its filters on `filtRd`; a kitchen
     * appliance names its own status port (`venusaf_s` on a Venus 2 airfryer)
     * and has no filters, so both are the caller's to say.
     */
    async read(
        auth: CloudAuth,
        ports: { readonly status: string; readonly slow: readonly string[] } = {
            status: "Status",
            slow: ["filtRd"]
        }
    ): Promise<{ state: CloudState; online: boolean }> {
        await this.ensure(auth);
        const slow = Date.now() - this.slowReadAt > SLOW_PORTS_MS || !this.current.model;
        if (this.shadowGranted && (slow || this.current.powerOn === null)) {
            await this.publish(this.shadow("get"), "{}", 0).catch(() => {});
        }
        const answered = await this.readPort(ports.status);
        if (answered && slow) {
            this.slowReadAt = Date.now();
            for (const port of ports.slow) await this.readPort(port);
            if (!this.current.model) await this.readPort("Config");
        }
        const online = answered || Date.now() - this.current.heardAt < HEARD_RECENTLY_MS;
        return { state: this.state, online };
    }

    /** Set values on a port - `Control` unless the unit names another - asking
     *  again on busy as the app does: up to three times, each after 300 to
     *  1000 ms. The status port is read again afterwards. */
    async write(
        auth: CloudAuth,
        properties: Readonly<Record<string, CloudValue>>,
        ports: { readonly control: string; readonly status: string } = {
            control: "Control",
            status: "Status"
        }
    ): Promise<void> {
        await this.ensure(auth);
        await this.queued(async () => {
            for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
                const reply = await this.ask("setPort", ports.control, properties);
                if (!reply) throw quiet();
                if (reply.status === NCP_OK || reply.status === null) {
                    this.current.properties = { ...this.current.properties, ...properties };
                    return;
                }
                if (reply.status !== NCP_BUSY) throw new DriverError(PHILIPS_REFUSED, "refused");
                if (attempt < WRITE_RETRIES) await sleep(300 + Math.random() * 700);
            }
            throw busy();
        });
        await this.readPort(ports.status).catch(() => false);
    }

    /** Switch it on or off: a desired `powerOn` on the shadow. */
    async power(auth: CloudAuth, on: boolean): Promise<void> {
        await this.ensure(auth);
        await this.publish(
            this.shadow("update"),
            JSON.stringify({ state: { desired: { powerOn: on } } }),
            1
        );
        if (this.shadowGranted) this.current.powerOn = on;
        await this.readPort("Status").catch(() => false);
    }
}

/** Every link this process holds, by account and thing. */
const links = new Map<string, CloudLink>();

export function cloudLink(account: string, thing: string): CloudLink {
    const key = `${account}\u0000${thing}`;
    let link = links.get(key);
    if (!link) {
        link = new CloudLink(thing, (closed) => {
            if (links.get(key) === closed) links.delete(key);
        });
        links.set(key, link);
    }
    return link;
}

/** Close every link of one account, when it is disconnected. */
export function closeCloudLinks(account: string): void {
    for (const [key, link] of [...links]) {
        if (key.startsWith(`${account}\u0000`)) link.close();
    }
}

/** For tests: close everything and start clean. */
export function resetCloudLinks(): void {
    for (const link of [...links.values()]) link.close();
    links.clear();
}
