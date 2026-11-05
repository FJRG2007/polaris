/**
 * Midea dehumidifiers - Comfee, Inventor, Midea's own - over the network they
 * are on, translated into the words Places uses.
 *
 * The way midea-local (and Home Assistant's midea_ac_lan on top of it) works:
 * the MSmartHome account is only asked which dehumidifiers there are and for
 * the token and key each one shakes hands with. Reading and setting are done on
 * the unit itself, over TCP 6444 inside the v3 ("8370") envelope. The cloud says
 * nothing about where a unit is, so it is found by the same UDP scan
 * midea-local sends, at the addresses typed and on this network.
 *
 * Untested against a real unit: built against midea-local's own vectors
 * (`midea-protocol.ts`, `midea-cloud.ts`) and a simulated one in the tests.
 *
 * Server-only.
 */

import * as kinds from "../device-kinds";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { HomeError } from "../home-error";
import { createConnection } from "node:net";
import * as cloud from "../integrations/midea-cloud";
import * as protocol from "../integrations/midea-protocol";
import { forbiddenAddress } from "../integrations/lan-address";
import { subnetTargets, unitAddressOf } from "../integrations/lan-unit";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const MIDEA_LAN = "midea-lan";

/** Where a unit answers its v3 sessions. */
export const MIDEA_TCP_PORT = 6444;
/** Where a unit answers the scan; `discover.py` sends to both. */
export const MIDEA_SCAN_PORTS = [6445, 20086] as const;
const BROADCAST = "255.255.255.255";
const SCAN_WINDOW_MS = 2500;
const SOCKET_TIMEOUT_MS = 8000;
/** No answer from a unit is anywhere near this. */
const MAX_BUFFER = 64 * 1024;
const MAX_TYPED_ADDRESSES = 20;
/** How long an account's appliance list is trusted before MSmartHome is asked again. */
const LIST_TTL_MS = 10 * 60_000;
/** How long a unit the scan missed waits before a sync scans for it again. */
const SCAN_AGAIN_MS = 5 * 60_000;

// --- the two ways out, replaceable in tests ----------------------------------------

/** One TCP connection to a unit, read a chunk at a time. */
export interface MideaLink {
    write(data: Buffer): void;
    /** What arrived since the last read, waiting for it when nothing has. */
    read(timeoutMs: number): Promise<Buffer>;
    close(): void;
}

export interface MideaTransport {
    connect(address: string, port: number, timeoutMs: number): Promise<MideaLink>;
    /** Send the scan to each target and collect what answers in the window. */
    scan(
        targets: readonly string[],
        windowMs: number
    ): Promise<{ address: string; data: Buffer }[]>;
}

function netConnect(address: string, port: number, timeoutMs: number): Promise<MideaLink> {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: address, port });
        let pending = Buffer.alloc(0);
        let closed = false;
        let waiter: (() => void) | null = null;
        const wake = () => {
            const next = waiter;
            waiter = null;
            next?.();
        };
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
        socket.once("connect", () => {
            socket.setTimeout(0);
            resolve(link);
        });
        socket.on("error", (caught) => {
            closed = true;
            reject(caught);
            wake();
        });
        socket.on("close", () => {
            closed = true;
            wake();
        });
        socket.on("data", (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > MAX_BUFFER) socket.destroy(new Error("too much data"));
            wake();
        });
        const link: MideaLink = {
            write: (data) => void socket.write(data),
            read: (readTimeoutMs) =>
                new Promise<Buffer>((done, fail) => {
                    const take = () => {
                        clearTimeout(timer);
                        if (pending.length === 0) return fail(new Error("closed"));
                        const out = pending;
                        pending = Buffer.alloc(0);
                        done(out);
                    };
                    const timer = setTimeout(() => {
                        waiter = null;
                        fail(new Error("timeout"));
                    }, readTimeoutMs);
                    if (pending.length > 0 || closed) take();
                    else waiter = take;
                }),
            close: () => socket.destroy()
        };
    });
}

function udpScan(
    targets: readonly string[],
    windowMs: number
): Promise<{ address: string; data: Buffer }[]> {
    const broadcast = targets.includes(BROADCAST);
    const asked = new Set(targets);
    return new Promise((resolve) => {
        const replies: { address: string; data: Buffer }[] = [];
        const socket = createSocket({ type: "udp4" });
        const finish = () => {
            try {
                socket.close();
            } catch {
                // Already closed.
            }
            resolve(replies);
        };
        socket.on("error", finish);
        socket.on("message", (data, remote) => {
            if (!broadcast && !asked.has(remote.address)) return;
            if (data.length <= MAX_BUFFER) replies.push({ address: remote.address, data });
        });
        socket.bind(0, () => {
            if (broadcast) socket.setBroadcast(true);
            for (const target of targets)
                for (const port of MIDEA_SCAN_PORTS)
                    socket.send(protocol.DISCOVERY_MESSAGE, port, target, () => undefined);
            setTimeout(finish, windowMs);
        });
    });
}

const DEFAULT_TRANSPORT: MideaTransport = { connect: netConnect, scan: udpScan };
let transport = DEFAULT_TRANSPORT;

/** Replace the sockets; for tests. No argument restores them. */
export function setMideaTransport(next?: MideaTransport): void {
    transport = next ?? DEFAULT_TRANSPORT;
}

// --- what is remembered between calls -----------------------------------------------

/** The key a unit took, and where it last answered, per appliance id. Kept per
 *  process: both are found again by the next sync when they are lost. */
const workingKeys = new Map<string, cloud.MideaKey>();
const addresses = new Map<string, string>();
/** When a scan last missed a unit, per appliance id and addresses typed. */
const missedAt = new Map<string, number>();
/** One MSmartHome session per account, kept until MSmartHome ends it. */
const sessions = new Map<string, Promise<cloud.MideaSession>>();
/** Each account's appliances as last listed. */
const listings = new Map<string, { at: number; value: Promise<cloud.MideaAppliance[]> }>();

/** Forget what was learned; for tests. */
export function forgetMideaUnits(): void {
    workingKeys.clear();
    addresses.clear();
    missedAt.clear();
    sessions.clear();
    listings.clear();
}

let messageId = 0;
function nextMessageId(): number {
    messageId = (messageId % 254) + 1;
    return messageId;
}

// --- credentials and errors ---------------------------------------------------------

interface MideaAccount {
    readonly email: string;
    readonly password: string;
    /** Which account this is, for the in-memory holds: never the credential. */
    readonly key: string;
}

function accountOf(credentials: Credentials): MideaAccount {
    const email = credentials.email?.trim().toLowerCase() ?? "";
    const password = credentials.password ?? "";
    if (!email || !password)
        throw new HomeError("That connection is missing its email or password");
    const key = createHash("sha256").update(`${email}\n${password}`).digest("hex");
    return { email, password, key };
}

/** The addresses typed, one per dehumidifier, each checked as any address is. */
async function typedAddresses(credentials: Credentials): Promise<string[]> {
    const typed = (credentials.hosts ?? "")
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (typed.length > MAX_TYPED_ADDRESSES)
        throw new HomeError(`Type at most ${MAX_TYPED_ADDRESSES} addresses`);
    return Promise.all(typed.map(unitAddressOf));
}

/** A cloud failure as the screen has to say it. */
export function mideaDriverError(caught: unknown): unknown {
    if (!(caught instanceof cloud.MideaCloudError)) return caught;
    if (caught.reason === "password") return new DriverError(caught.message, "unauthorized");
    if (caught.reason === "unreachable") return new DriverError(caught.message, "unreachable");
    return new DriverError(caught.message, "refused");
}

async function speaking<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (caught) {
        throw mideaDriverError(caught);
    }
}

// --- the cloud's part ---------------------------------------------------------------

interface Dehumidifier {
    readonly appliance: cloud.MideaAppliance;
    readonly account: MideaAccount;
}

/** Hold `entry` under `key` until `value` fails. */
function holding<V>(map: Map<string, V>, key: string, entry: V, value: Promise<unknown>): void {
    map.set(key, entry);
    value.catch(() => {
        if (map.get(key) === entry) map.delete(key);
    });
}

function sessionOf(account: MideaAccount): Promise<cloud.MideaSession> {
    const held = sessions.get(account.key);
    if (held) return held;
    const fresh = cloud.signIn(account.email, account.password);
    holding(sessions, account.key, fresh, fresh);
    return fresh;
}

/** A cloud call on the account's session; a kept session MSmartHome has ended
 *  is signed in again once. */
async function onSession<T>(
    account: MideaAccount,
    call: (session: cloud.MideaSession) => Promise<T>
): Promise<T> {
    const held = sessions.get(account.key);
    const session = await sessionOf(account);
    try {
        return await call(session);
    } catch (caught) {
        const ended = caught instanceof cloud.MideaCloudError && caught.reason === "password";
        if (!held || !ended) throw caught;
        if (sessions.get(account.key) === held) sessions.delete(account.key);
        return call(await sessionOf(account));
    }
}

function appliancesOf(account: MideaAccount, fresh: boolean): Promise<cloud.MideaAppliance[]> {
    const held = listings.get(account.key);
    if (!fresh && held && Date.now() - held.at < LIST_TTL_MS) return held.value;
    const value = onSession(account, cloud.listAppliances);
    holding(listings, account.key, { at: Date.now(), value }, value);
    return value;
}

async function dehumidifiers(credentials: Credentials, fresh = false): Promise<Dehumidifier[]> {
    const account = accountOf(credentials);
    return speaking(async () =>
        (await appliancesOf(account, fresh))
            .filter((appliance) => appliance.type === protocol.A1)
            .map((appliance) => ({ appliance, account }))
    );
}

async function keysFor(unit: Dehumidifier): Promise<cloud.MideaKey[]> {
    const known = workingKeys.get(unit.appliance.id);
    if (known) return [known];
    return speaking(() =>
        onSession(unit.account, (session) => cloud.applianceKeys(session, unit.appliance.id))
    );
}

// --- where the units are ------------------------------------------------------------

const missKey = (credentials: Credentials, applianceId: string) =>
    `${applianceId}\n${credentials.hosts ?? ""}`;

/** Whether a scan missed this unit too recently to scan for it again yet. */
function missedLately(credentials: Credentials, applianceId: string): boolean {
    const at = missedAt.get(missKey(credentials, applianceId));
    return at !== undefined && Date.now() - at < SCAN_AGAIN_MS;
}

/** Scan for the units, at the addresses typed and on this network, keep
 *  where each answered, and note which of `wanted` did not. */
async function locateUnits(credentials: Credentials, wanted: readonly string[]): Promise<void> {
    const typed = await typedAddresses(credentials);
    const targets = [...new Set([BROADCAST, ...typed, ...(await subnetTargets())])];
    const replies = await transport.scan(targets, SCAN_WINDOW_MS);
    for (const reply of replies) {
        if (forbiddenAddress(reply.address)) continue;
        const id = protocol.discoveredId(reply.data);
        if (id !== null) addresses.set(id.toString(), reply.address);
    }
    for (const id of wanted) {
        if (addresses.has(id)) missedAt.delete(missKey(credentials, id));
        else missedAt.set(missKey(credentials, id), Date.now());
    }
}

// --- the unit's part ----------------------------------------------------------------

/** Read until `pick` finds what it is looking for in the decoded messages. */
async function readUntil<T>(
    link: MideaLink,
    session: protocol.Session8370,
    pick: (message: Buffer) => T | null
): Promise<T> {
    let buffer = Buffer.alloc(0);
    for (;;) {
        buffer = Buffer.concat([buffer, await link.read(SOCKET_TIMEOUT_MS)]);
        // What a unit sends, bare, for a token or key it does not take.
        if (buffer.toString("latin1") === "ERROR")
            throw new protocol.MideaProtocolError("The device refused the key", "auth");
        const decoded = session.decode(buffer);
        buffer = decoded.rest;
        for (const message of decoded.messages) {
            const found = pick(message);
            if (found !== null) return found;
        }
    }
}

/** A v3 session with one unit: the handshake done with the first key it
 *  takes, then each frame asked and its status read back. */
class UnitSession {
    private constructor(
        private readonly link: MideaLink,
        private readonly session: protocol.Session8370,
        private readonly deviceId: bigint
    ) {}

    static async open(
        address: string,
        applianceId: string,
        keys: readonly cloud.MideaKey[]
    ): Promise<UnitSession> {
        let refused = false;
        for (const key of keys) {
            let link: MideaLink;
            try {
                link = await transport.connect(address, MIDEA_TCP_PORT, SOCKET_TIMEOUT_MS);
            } catch {
                throw unreachableAt(address);
            }
            const session = new protocol.Session8370();
            try {
                link.write(
                    session.encode(Buffer.from(key.token, "hex"), protocol.HANDSHAKE_REQUEST)
                );
                await readUntil(link, session, (message) =>
                    session.accept(message, Buffer.from(key.key, "hex"))
                );
                workingKeys.set(applianceId, key);
                return new UnitSession(link, session, BigInt(applianceId));
            } catch (caught) {
                link.close();
                // Hung up on mid-handshake is a key refused, as midea-local reads
                // it (`AuthException` on an incomplete read).
                const hungUp = caught instanceof Error && caught.message === "closed";
                if (caught instanceof protocol.MideaProtocolError || hungUp) {
                    refused = true;
                    continue;
                }
                throw unreachableAt(address);
            }
        }
        workingKeys.delete(applianceId);
        throw refused
            ? new DriverError(
                  `The dehumidifier at ${address} refused the key MSmartHome gave for it. Remove it from the MSmartHome app, add it again, and sync.`,
                  "refused"
              )
            : new DriverError(
                  "MSmartHome gave no key for this dehumidifier. Sync again in a minute.",
                  "refused"
              );
    }

    async ask(frame: Buffer, address: string): Promise<protocol.A1Status> {
        const message = protocol.packet(this.deviceId, frame, protocol.packetTime(new Date()));
        this.link.write(this.session.encode(message, protocol.ENCRYPTED_REQUEST));
        try {
            return await readUntil(this.link, this.session, (answer) => {
                const plain = protocol.unpacket(answer);
                return plain ? protocol.parseA1(plain) : null;
            });
        } catch (caught) {
            if (caught instanceof DriverError) throw caught;
            throw unreachableAt(address);
        }
    }

    close(): void {
        this.link.close();
    }
}

function unreachableAt(address: string): DriverError {
    return new DriverError(
        `The dehumidifier did not answer at ${address}. Check it is switched on and on the same network as Polaris.`,
        "unreachable"
    );
}

function offline(name: string): DriverError {
    return new DriverError(
        `${name} shows as offline in the MSmartHome app. Check it is plugged in and on Wi-Fi.`,
        "unreachable"
    );
}

function notFound(name: string): DriverError {
    return new DriverError(
        `${name} did not answer the scan on this network. Type its IP address in the connection: your router's list of devices shows it.`,
        "unreachable"
    );
}

async function withUnit<T>(
    unit: Dehumidifier,
    use: (session: UnitSession, address: string) => Promise<T>
): Promise<T> {
    const address = addresses.get(unit.appliance.id);
    if (!address) throw notFound(unit.appliance.name);
    const session = await UnitSession.open(address, unit.appliance.id, await keysFor(unit));
    try {
        return await use(session, address);
    } finally {
        session.close();
    }
}

// --- translation ----------------------------------------------------------------------

const uniqueModes = [...new Set(Object.values(protocol.A1_MODES))];
const uniqueSpeeds = [
    ...new Set(Object.values(protocol.A1_SPEEDS).filter((speed) => speed !== null))
];

/** A status in the `air` document every purifier and dehumidifier is read in. */
export function mideaAir(status: protocol.A1Status): kinds.AirSettings | null {
    const inRange = (value: number) =>
        value >= protocol.A1_MIN_HUMIDITY && value <= protocol.A1_MAX_HUMIDITY ? value : null;
    const percent = (value: number) => (value >= 0 && value <= 100 ? value : undefined);
    const temperature = (value: number) => (value >= -50 && value <= 100 ? value : undefined);
    return kinds.airSettings({
        mode: protocol.A1_MODES[status.modeCode] ?? null,
        modes: uniqueModes,
        speed: protocol.A1_SPEEDS[status.fanCode] ?? null,
        speeds: uniqueSpeeds,
        // midea-local sets no step, so Home Assistant's default of one.
        humidity: {
            target: inRange(status.targetHumidity),
            min: protocol.A1_MIN_HUMIDITY,
            max: protocol.A1_MAX_HUMIDITY,
            step: 1
        },
        options: {},
        readings: {
            humidity: percent(status.currentHumidity),
            temperature: temperature(status.currentTemperature)
        },
        filters: [],
        tankFull: status.tankFull
    });
}

export function mideaSnapshot(
    appliance: cloud.MideaAppliance,
    status: protocol.A1Status | null
): DeviceSnapshot {
    return {
        externalId: appliance.id,
        kind: "dehumidifier",
        name: appliance.name.slice(0, 120),
        model: appliance.model || null,
        firmware: null,
        state: status ? (status.power ? "on" : "off") : "unknown",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: status !== null,
        air: status ? mideaAir(status) : null
    };
}

/** The set that does what was asked, built on the status just read: a set
 *  replaces the whole state, so everything else stays as the unit has it. */
export function mideaCommand(
    status: protocol.A1Status,
    action: kinds.DeviceAction,
    command: kinds.DeviceCommand | undefined
): protocol.A1Command {
    const base = { ...protocol.commandFromStatus(status), promptTone: true };
    if (action === "turn-on") return { ...base, power: true };
    if (action === "turn-off") return { ...base, power: false };
    const setting = kinds.airCommandOf(command);
    if (setting?.action === "set-mode" && setting.action === action) {
        if (!uniqueModes.includes(setting.mode as protocol.A1Mode))
            throw new DriverError("This dehumidifier has no such mode.", "refused");
        return {
            ...base,
            power: true,
            modeCode: protocol.a1ModeCode(setting.mode as protocol.A1Mode)
        };
    }
    if (setting?.action === "set-fan" && setting.action === action) {
        if (!uniqueSpeeds.includes(setting.speed as protocol.A1Speed))
            throw new DriverError("This dehumidifier has no such fan speed.", "refused");
        return { ...base, fanCode: protocol.a1SpeedCode(setting.speed as protocol.A1Speed) };
    }
    if (setting?.action === "set-humidity" && setting.action === action) {
        if (setting.target < protocol.A1_MIN_HUMIDITY || setting.target > protocol.A1_MAX_HUMIDITY)
            throw new DriverError(
                `A dehumidifier takes ${protocol.A1_MIN_HUMIDITY} to ${protocol.A1_MAX_HUMIDITY}% humidity.`,
                "refused"
            );
        return { ...base, targetHumidity: Math.round(setting.target) };
    }
    throw new DriverError("A dehumidifier cannot do that.", "refused");
}

// --- the driver -----------------------------------------------------------------------

export const mideaLanDriver: DeviceDriver = {
    connection: MIDEA_LAN,

    /** That the account signs in, that it has a dehumidifier, and that every
     *  address typed is one a unit can be at. */
    async verify(credentials) {
        await typedAddresses(credentials);
        const units = await dehumidifiers(credentials, true);
        if (units.length === 0) {
            throw new DriverError(
                "That MSmartHome account has no dehumidifier. Add it in the MSmartHome app first, then connect again.",
                "refused"
            );
        }
    },

    async list(credentials) {
        const units = await dehumidifiers(credentials);
        const unfound = units
            .filter((unit) => unit.appliance.online && !addresses.has(unit.appliance.id))
            .map((unit) => unit.appliance.id);
        if (unfound.some((id) => !missedLately(credentials, id)))
            await locateUnits(credentials, unfound);
        const failures: DriverError[] = [];
        const read = async (unit: Dehumidifier) => {
            if (!unit.appliance.online) return null;
            try {
                return await withUnit(unit, (session, address) =>
                    session.ask(protocol.a1Query(nextMessageId()), address)
                );
            } catch (caught) {
                if (!(caught instanceof DriverError)) throw caught;
                // Gone from where it was: scanned for again on the next sync.
                if (caught.kind === "unreachable") addresses.delete(unit.appliance.id);
                failures.push(caught);
                return null;
            }
        };
        const statuses = await Promise.all(units.map(read));
        // Nothing read at all: the account says why, rather than every unit
        // only showing as offline.
        const first = failures[0];
        if (first && statuses.every((status) => status === null)) throw first;
        return units.map((unit, index) => mideaSnapshot(unit.appliance, statuses[index] ?? null));
    },

    async act(credentials, device, action, command) {
        const find = async (fresh: boolean) =>
            (await dehumidifiers(credentials, fresh)).find(
                (entry) => entry.appliance.id === device.externalId
            );
        let unit = await find(false);
        if (!unit?.appliance.online) unit = await find(true);
        if (!unit)
            throw new DriverError(
                "That dehumidifier is no longer on the MSmartHome account.",
                "refused"
            );
        if (!unit.appliance.online) throw offline(unit.appliance.name);
        const send = () =>
            withUnit(unit, async (session, address) => {
                const status = await session.ask(protocol.a1Query(nextMessageId()), address);
                await session.ask(
                    protocol.a1Set(mideaCommand(status, action, command), nextMessageId()),
                    address
                );
            });
        const wanted = [unit.appliance.id];
        if (!addresses.has(unit.appliance.id)) await locateUnits(credentials, wanted);
        try {
            await send();
        } catch (caught) {
            // Moved since the last sync: scanned for once, and asked again where
            // it answers now.
            if (!(caught instanceof DriverError) || caught.kind !== "unreachable") throw caught;
            const before = addresses.get(unit.appliance.id);
            addresses.delete(unit.appliance.id);
            await locateUnits(credentials, wanted);
            const after = addresses.get(unit.appliance.id);
            if (!after || after === before) throw caught;
            await send();
        }
    }
};
