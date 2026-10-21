/**
 * PETKIT litter boxes over their cloud, as devices.
 *
 * One connection is one PETKIT account. What it brings is its self-cleaning
 * litter boxes (a Pura Max is a `t4`; whichever type the account reports a box
 * as among `LITTER_TYPES` is read the same way); feeders, fountains and
 * purifiers on the same account are left out.
 *
 * The protocol is `integrations/petkit-api.ts`. What this file adds is what an
 * unofficial cloud needs from a polite client:
 *
 * - The session is kept rather than signed in for on every read. It rides on
 *   the stored credentials (`renew` replaces it a day before it lapses) and in
 *   memory, and a call answered "session ended" signs in once more and is
 *   tried again, once.
 * - The password is never stored: what is kept is its MD5, which is what their
 *   sign-in takes.
 * - Reads are held for a short while per account, so a screen opened in three
 *   tabs and the watcher's own timer spend one round of calls, and today's
 *   visits are read at most every few minutes. Commands are limited per account
 *   per minute. `device-watch` paces the account itself, with backoff.
 *
 * Server-only.
 */

import { createHash } from "node:crypto";
import { HomeError } from "../home-error";
import * as litter from "../litter-kinds";
import * as petkit from "../integrations/petkit-api";
import type { DeviceAction, DeviceCommand } from "../device-kinds";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const PETKIT_CLOUD = "petkit-cloud";

const LIST_TTL_MS = 20_000;
const RECORDS_TTL_MS = 5 * 60_000;
const RENEW_BEFORE_MS = 24 * 60 * 60_000;
const COMMANDS_PER_MINUTE = 8;

/** The fetch every call goes through; a test replaces it. */
let fetcher: petkit.Fetcher = (input, init) => fetch(input, init);

export function usePetkitFetch(next: petkit.Fetcher | null): void {
    fetcher = next ?? ((input, init) => fetch(input, init));
    sessions.clear();
    lists.clear();
    records.clear();
    commands.clear();
}

const sessions = new Map<string, petkit.PetkitSession>();
const lists = new Map<string, { at: number; value: Promise<DeviceSnapshot[]> }>();
const records = new Map<string, { at: number; uses: unknown[] }>();
const commands = new Map<string, number[]>();

function timezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

/** The account the stored credentials are, with the password as their MD5. */
function accountOf(credentials: Credentials): petkit.PetkitAccount {
    const email = credentials.email?.trim().toLowerCase();
    const country = credentials.country?.trim().toUpperCase();
    const typed = credentials.password ?? "";
    const passwordMd5 = credentials.passwordMd5?.trim() || (typed ? petkit.md5(typed) : "");
    if (!email || !country || !passwordMd5)
        throw new HomeError("That connection is missing its sign-in");
    return { email, country, passwordMd5, timezone: timezone() };
}

/** Which account this is, for the in-memory holds: never the credential. */
function keyOf(account: petkit.PetkitAccount): string {
    return createHash("sha256")
        .update(`${account.email}\n${account.country}\n${account.passwordMd5}`)
        .digest("hex");
}

function storedSession(credentials: Credentials): petkit.PetkitSession | null {
    const id = credentials.session;
    const gateway = credentials.sessionGateway;
    const until = Number(credentials.sessionUntil);
    if (!id || !gateway || !Number.isFinite(until) || until <= Date.now()) return null;
    return { id, gateway, until };
}

function asDriverError(caught: unknown): unknown {
    if (!(caught instanceof petkit.PetkitError)) return caught;
    const kind =
        caught.failure === "unauthorized" || caught.failure === "expired"
            ? "unauthorized"
            : caught.failure === "refused"
              ? "refused"
              : "unreachable";
    return new DriverError(caught.message, kind);
}

async function signIn(account: petkit.PetkitAccount): Promise<petkit.PetkitSession> {
    const session = await petkit.login(fetcher, account);
    sessions.set(keyOf(account), session);
    return session;
}

/** Run a call with a session, signing in again once if it has ended. */
async function withSession<T>(
    credentials: Credentials,
    run: (session: petkit.PetkitSession, account: petkit.PetkitAccount) => Promise<T>
): Promise<T> {
    const account = accountOf(credentials);
    const key = keyOf(account);
    try {
        let session = sessions.get(key) ?? storedSession(credentials);
        if (!session || session.until <= Date.now()) session = await signIn(account);
        try {
            return await run(session, account);
        } catch (caught) {
            if (!(caught instanceof petkit.PetkitError) || caught.failure !== "expired")
                throw caught;
            sessions.delete(key);
            return await run(await signIn(account), account);
        }
    } catch (caught) {
        throw asDriverError(caught);
    }
}

function sessionFields(session: petkit.PetkitSession): Record<string, string> {
    return {
        session: session.id,
        sessionGateway: session.gateway,
        sessionUntil: String(session.until)
    };
}

/** What is stored: the sign-in without the typed password. */
function storable(account: petkit.PetkitAccount, session: petkit.PetkitSession): Credentials {
    return {
        email: account.email,
        country: account.country,
        passwordMd5: account.passwordMd5,
        ...sessionFields(session)
    };
}

// --- reading -------------------------------------------------------------------

function num(value: unknown): number | null {
    const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    const n = num(value);
    return n === null ? null : n !== 0;
}

function clampInt(value: number | null, min: number, max: number): number | null {
    return value === null ? null : Math.min(max, Math.max(min, Math.round(value)));
}

function isoOf(seconds: number | null): string | null {
    if (seconds === null || seconds <= 0) return null;
    const ms = seconds > 1e12 ? seconds : seconds * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A visit out of one of today's records, or null for a record that is not
 *  one (a cleaning, a dump). A visit is the one that weighed a cat. */
export function useOf(entry: unknown): litter.LitterUse | null {
    const record = petkit.asRecord(entry);
    const content = petkit.asRecord(record?.content);
    if (!record || !content) return null;
    const grams = clampInt(num(content.petWeight), 0, 30_000);
    const timeIn = num(content.timeIn);
    const timeOut = num(content.timeOut);
    if (!grams && record.petId === undefined) return null;
    const at = isoOf(timeIn ?? num(record.timestamp));
    if (!at) return null;
    const seconds =
        timeIn !== null && timeOut !== null && timeOut >= timeIn
            ? clampInt(timeOut - timeIn, 0, 24 * 60 * 60)
            : null;
    const pet =
        typeof record.petName === "string" && record.petName.trim()
            ? record.petName.trim().slice(0, 80)
            : null;
    return { at, pet, grams: grams || null, seconds };
}

/** One box's detail, and today's records, as the kind Places draws. */
export function litterOf(
    device: petkit.PetkitDevice,
    detail: Record<string, unknown>,
    uses: readonly unknown[]
): litter.LitterView {
    const state = petkit.asRecord(detail.state) ?? {};
    const settings = petkit.asRecord(detail.settings) ?? {};
    const work = petkit.asRecord(state.workState);
    const workMode = work ? clampInt(num(work.workMode), 0, 99) : null;
    const options: Partial<Record<litter.LitterOption, boolean>> = {};
    for (const option of litter.LITTER_OPTIONS) {
        const value = bool(settings[litter.LITTER_OPTION_KEYS[option]]);
        if (value !== null) options[option] = value;
    }
    const read = uses
        .map(useOf)
        .filter((use): use is litter.LitterUse => use !== null)
        .sort((a, b) => b.at.localeCompare(a.at));
    const errorMsg =
        typeof state.errorMsg === "string" && state.errorMsg.trim()
            ? state.errorMsg.trim().slice(0, 300)
            : null;
    const lastOut = isoOf(num(detail.lastOutTime));
    return {
        type: device.type,
        status: litter.litterStatusOf(workMode, work !== null),
        workMode,
        litterPercent: clampInt(num(state.sandPercent), 0, 100),
        litterLow: bool(state.sandLack),
        binFull: bool(state.boxFull),
        deodorizerDays: clampInt(num(state.deodorantLeftDays), 0, 3650),
        usesToday: clampInt(num(detail.inTimes) ?? num(state.usedTimes), 0, 1000),
        lastUseAt: read[0]?.at ?? lastOut,
        uses: read.slice(0, litter.MAX_LITTER_USES),
        fault: errorMsg,
        options,
        // `deodorantReset` is the N50's, on a T4/T5/T6 (`command.py`).
        deodorizerResettable: device.type === "t4" || device.type === "t5" || device.type === "t6"
    };
}

function snapshotOf(
    device: petkit.PetkitDevice,
    detail: Record<string, unknown>,
    uses: readonly unknown[]
): DeviceSnapshot {
    const state = petkit.asRecord(detail.state) ?? {};
    const view = litterOf(device, detail, uses);
    // `pim`: 0 offline, 1 on mains, 2 on battery (the HA integration's map).
    const pim = num(state.pim);
    const firmware = detail.firmware;
    return {
        externalId: String(device.id),
        kind: "litter",
        name: device.name || (typeof detail.name === "string" ? detail.name : "") || "Litter box",
        model: `PETKIT ${device.type.toUpperCase()}`,
        firmware:
            typeof firmware === "string" || typeof firmware === "number" ? String(firmware) : null,
        state: view.status === "idle" ? "off" : "on",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: pim === null ? true : pim !== 0,
        litter: view
    };
}

async function readAll(credentials: Credentials): Promise<DeviceSnapshot[]> {
    return withSession(credentials, async (session, account) => {
        const devices = (await petkit.listDevices(fetcher, session, account.timezone)).filter(
            (device) => petkit.isLitterType(device.type)
        );
        const out: DeviceSnapshot[] = [];
        for (const device of devices) {
            const detail = await petkit.deviceDetail(fetcher, session, account.timezone, device);
            const key = `${keyOf(account)}:${device.id}`;
            const held = records.get(key);
            let uses = held && Date.now() - held.at < RECORDS_TTL_MS ? held.uses : null;
            if (!uses) {
                try {
                    uses = await petkit.deviceRecords(
                        fetcher,
                        session,
                        petkit.deviceZone(detail, account.timezone),
                        device
                    );
                    records.set(key, { at: Date.now(), uses });
                } catch (caught) {
                    // The visits are the extra; the box's own state still draws.
                    if (caught instanceof petkit.PetkitError && caught.failure === "expired")
                        throw caught;
                    uses = held?.uses ?? [];
                }
            }
            out.push(snapshotOf(device, detail, uses));
        }
        return out;
    });
}

// --- commands ------------------------------------------------------------------

function spendCommand(account: petkit.PetkitAccount): void {
    const key = keyOf(account);
    const now = Date.now();
    const recent = (commands.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= COMMANDS_PER_MINUTE)
        throw new DriverError(
            "Too many commands to PETKIT in a minute; try again shortly",
            "refused"
        );
    recent.push(now);
    commands.set(key, recent);
}

/** What one action is on the wire, given the box as it is now. */
export function wireFor(
    type: string,
    action: DeviceAction,
    view: litter.LitterView | null,
    command?: DeviceCommand
):
    | { kind: "control"; key: "start_action" | "stop_action" | "continue_action"; value: number }
    | { kind: "settings"; kv: Record<string, number> }
    | { kind: "deodorant" } {
    if (action === "clean") return { kind: "control", key: "start_action", value: 0 };
    if (action === "dump") return { kind: "control", key: "start_action", value: 1 };
    if (action === "pause" || action === "resume") {
        if (!view || view.status === "idle" || view.workMode === null)
            throw new DriverError("There is nothing running on it to pause or resume", "refused");
        return {
            kind: "control",
            key: action === "pause" ? "stop_action" : "continue_action",
            value: view.workMode
        };
    }
    if (action === "reset-deodorizer") {
        if (type === "t4" || type === "t5" || type === "t6") return { kind: "deodorant" };
        throw new DriverError("This box's deodorizer cannot be reset from here", "refused");
    }
    if (action === "set-option") {
        const parsed = litter.litterCommandSchema.safeParse(command);
        if (!parsed.success) throw new DriverError("Say what to set it to", "refused");
        return {
            kind: "settings",
            kv: { [litter.LITTER_OPTION_KEYS[parsed.data.option]]: parsed.data.on ? 1 : 0 }
        };
    }
    throw new DriverError("That device cannot be told to do that", "refused");
}

export const petkitCloudDriver: DeviceDriver = {
    connection: PETKIT_CLOUD,

    async verify(credentials) {
        const account = accountOf(credentials);
        try {
            const session = await signIn(account);
            await petkit.listDevices(fetcher, session, account.timezone);
            return storable(account, session);
        } catch (caught) {
            throw asDriverError(caught);
        }
    },

    async renew(credentials) {
        const account = accountOf(credentials);
        const held = sessions.get(keyOf(account));
        const stored = storedSession(credentials);
        // A sign-in made in memory after an ended session is written back, so
        // a restart does not sign in again.
        if (held && held.id !== stored?.id && held.until - Date.now() > RENEW_BEFORE_MS)
            return storable(account, held);
        if (stored && stored.until - Date.now() > RENEW_BEFORE_MS) return null;
        try {
            return storable(account, await signIn(account));
        } catch (caught) {
            throw asDriverError(caught);
        }
    },

    async list(credentials) {
        const key = keyOf(accountOf(credentials));
        const held = lists.get(key);
        if (held && Date.now() - held.at < LIST_TTL_MS) return held.value;
        const value = readAll(credentials);
        lists.set(key, { at: Date.now(), value });
        value.catch(() => lists.delete(key));
        return value;
    },

    async probe(credentials) {
        const account = accountOf(credentials);
        lists.delete(keyOf(account));
        for (const key of records.keys()) if (key.startsWith(keyOf(account))) records.delete(key);
    },

    async act(credentials, device, action, command) {
        const account = accountOf(credentials);
        spendCommand(account);
        const id = Number(device.externalId);
        if (!Number.isSafeInteger(id))
            throw new DriverError("That device is not on this account", "refused");
        await withSession(credentials, async (session, signed) => {
            const known = (await petkit.listDevices(fetcher, session, signed.timezone)).find(
                (entry) => entry.id === id && petkit.isLitterType(entry.type)
            );
            if (!known) throw new DriverError("That device is not on this account", "refused");
            let view: litter.LitterView | null = null;
            if (action === "pause" || action === "resume") {
                const detail = await petkit.deviceDetail(fetcher, session, signed.timezone, known);
                view = litterOf(known, detail, []);
            }
            const wire = wireFor(known.type, action, view, command);
            if (wire.kind === "control")
                await petkit.controlDevice(
                    fetcher,
                    session,
                    signed.timezone,
                    known,
                    wire.key,
                    wire.value
                );
            else if (wire.kind === "settings")
                await petkit.updateSettings(fetcher, session, signed.timezone, known, wire.kv);
            else await petkit.resetDeodorant(fetcher, session, signed.timezone, known);
        });
        // What it did is read fresh at the follow-up, not from the hold.
        lists.delete(keyOf(account));
    }
};
