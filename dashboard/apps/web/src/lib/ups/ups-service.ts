/**
 * The UPSes Polaris watches: stored, read over their connection, driven, and
 * watched for the moments somebody has to hear about.
 *
 * A UPS is reached one of three ways, and nothing outside this file cares
 * which: USB through the daemon of the machine the cable is in (today that is
 * the machine Polaris runs on - the only daemon the dashboard reaches), a NUT
 * server on the network, or an SNMP card read by `snmp-ups` on a machine's
 * daemon. Secrets are sealed with the master key and never leave the server.
 */

import type * as core from "@polaris/core";
import { networkDetails } from "@/lib/network-details";
import { z } from "zod";
import { createHmac } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { execCommand } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { usersWithPermission } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import { nutCommand, nutRead, nutSetVar } from "./nut-client";
import { getHostConnection } from "@/lib/host-service";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";
import { notifyOperators } from "@/lib/notifications/operators";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { DEFAULT_LOCALE, type Permission } from "@polaris/core";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { HostdClient, type HostdSnmpSource, type HostdUpsList } from "@polaris/hostd-client";
import * as upsData from "./ups-data";
import * as upsEvents from "./ups-events";
import * as upsReading from "./ups-reading";
import * as upsSettings from "./ups-settings";

type UpsRow = NonNullable<Awaited<ReturnType<typeof prisma.ups.findUnique>>>;

/** Why a UPS has no reading, in words the screen translates. */
export type UpsUnreachable =
    "fullEditionNeeded" | "updateNeeded" | "machineUnreachable" | "notFound" | "noAnswer";

export type UpsReadResult =
    | {
          ok: true;
          reading: upsReading.UpsReading;
          /** Every variable as the UPS says it, before any mapping. */
          vars: Record<string, string>;
          rw: upsSettings.UpsRwVar[];
      }
    | { ok: false; reason: UpsUnreachable };

/** What a browser may see of a UPS: everything but the secret. */
export interface UpsView {
    id: string;
    name: string;
    connection: "usb" | "nut" | "snmp";
    machineId: string | null;
    deviceId: string | null;
    host: string | null;
    port: number | null;
    upsName: string | null;
    username: string | null;
    snmpVersion: string | null;
    hasSecret: boolean;
    shutdown: upsReading.UpsShutdownInput;
    shutdownSentAt: string | null;
    settings: upsSettings.UpsSettingsInput;
    variableMap: upsSettings.VariableMap;
    reportLastAt: string | null;
    /** The Places place it stands in, or null. */
    placeId: string | null;
}

export function toView(row: UpsRow): UpsView {
    return {
        id: row.id,
        name: row.name,
        placeId: row.placeId,
        connection: row.connection as UpsView["connection"],
        machineId: row.machineId,
        deviceId: row.deviceId,
        host: row.host,
        port: row.port,
        upsName: row.upsName,
        username: row.username,
        snmpVersion: row.snmpVersion,
        hasSecret: row.encryptedSecret !== null,
        shutdown: {
            enabled: row.shutdownEnabled,
            belowCharge: row.shutdownBelowCharge,
            belowRuntimeMin: row.shutdownBelowRuntimeMin,
            protectedMachineIds: row.protectedMachineIds
        },
        shutdownSentAt: row.shutdownSentAt?.toISOString() ?? null,
        settings: {
            currency: row.currency,
            pricePerKwh: row.pricePerKwh,
            nominalPowerW: row.nominalPowerW,
            retentionDays: row.retentionDays,
            notifyKinds: row.notifyKinds.filter((kind): kind is upsEvents.UpsEventKind =>
                (upsEvents.UPS_EVENT_KINDS as readonly string[]).includes(kind)
            ),
            reportSchedule: (upsSettings.REPORT_SCHEDULES as readonly string[]).includes(
                row.reportSchedule
            )
                ? (row.reportSchedule as upsSettings.ReportSchedule)
                : "off",
            netserverEnabled: row.netserverEnabled
        },
        variableMap: upsSettings.readVariableMap(row.variableMap),
        reportLastAt: row.reportLastAt?.toISOString() ?? null
    };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

interface UpsSecret {
    password?: string;
    community?: string;
    authPassword?: string;
    privPassword?: string;
}

function seal(secret: UpsSecret) {
    const blob = encryptSecret(JSON.stringify(secret), loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

function open(row: UpsRow): UpsSecret {
    if (!row.encryptedSecret || !row.secretNonce || !row.secretKeyId) return {};
    try {
        return JSON.parse(
            decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedSecret),
                    nonce: Buffer.from(row.secretNonce),
                    keyId: row.secretKeyId
                },
                loadEnv().POLARIS_MASTER_KEY
            )
        ) as UpsSecret;
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function listUps(): Promise<UpsView[]> {
    const rows = await prisma.ups.findMany({ orderBy: { createdAt: "asc" }, take: 200 });
    return rows.map(toView);
}

export async function getUps(id: string): Promise<UpsRow | null> {
    return prisma.ups.findUnique({ where: { id } });
}

/** The columns an input sets; secrets merge with what is stored. */
function columnsFor(input: upsReading.UpsConnectionInput, stored: UpsSecret) {
    const empty = {
        machineId: null,
        deviceId: null,
        host: null,
        port: null,
        upsName: null,
        username: null,
        snmpVersion: null
    };
    if (input.connection === "usb") {
        return {
            ...empty,
            name: input.name,
            connection: "usb",
            machineId: input.machineId,
            deviceId: input.deviceId,
            encryptedSecret: null,
            secretNonce: null,
            secretKeyId: null
        };
    }
    if (input.connection === "nut") {
        const password = input.password || stored.password;
        return {
            ...empty,
            name: input.name,
            connection: "nut",
            host: input.host,
            port: input.port,
            upsName: input.upsName,
            username: input.username || null,
            ...(password
                ? seal({ password })
                : { encryptedSecret: null, secretNonce: null, secretKeyId: null })
        };
    }
    const missing = upsReading.missingSnmpField(input, {
        community: Boolean(stored.community),
        authPassword: Boolean(stored.authPassword),
        privPassword: Boolean(stored.privPassword)
    });
    if (missing) throw new z.ZodError([{ code: "custom", path: [missing], message: "required" }]);
    const v3 = input.snmpVersion === "v3";
    const secret: UpsSecret = v3
        ? {
              authPassword: input.authPassword || stored.authPassword,
              privPassword: input.privPassword || stored.privPassword
          }
        : { community: input.community || stored.community };
    return {
        ...empty,
        name: input.name,
        connection: "snmp",
        machineId: input.machineId,
        host: input.host,
        port: input.port,
        snmpVersion: input.snmpVersion,
        username: v3 ? input.username || null : null,
        ...seal(secret)
    };
}

export async function createUps(input: upsReading.UpsConnectionInput): Promise<string> {
    if (input.connection === "usb") {
        const key = `${input.machineId}/${input.deviceId}`;
        return serialUsb(async () => {
            const row = await prisma.ups.create({ data: columnsFor(input, {}) });
            // Added by hand after being removed: watched again from now on.
            await forgetDismissed(key);
            return row.id;
        });
    }
    const row = await prisma.ups.create({ data: columnsFor(input, {}) });
    if (input.connection === "snmp") await syncSnmp();
    return row.id;
}

export async function updateUpsConnection(
    id: string,
    input: upsReading.UpsConnectionInput
): Promise<boolean> {
    const row = await getUps(id);
    if (!row) return false;
    await prisma.ups.update({
        where: { id },
        data: columnsFor(input, row.connection === input.connection ? open(row) : {})
    });
    if (row.connection === "snmp" || input.connection === "snmp") await syncSnmp();
    return true;
}

export async function updateUpsShutdown(
    id: string,
    input: upsReading.UpsShutdownInput
): Promise<boolean> {
    const result = await prisma.ups.updateMany({
        where: { id },
        data: {
            shutdownEnabled: input.enabled,
            shutdownBelowCharge: input.belowCharge,
            shutdownBelowRuntimeMin: input.belowRuntimeMin,
            protectedMachineIds: input.protectedMachineIds
        }
    });
    return result.count > 0;
}

/**
 * Put a UPS in a place, or take it out of one (null).
 *
 * The place is read from the table rather than through the Places app: a UPS
 * is core (it shuts machines down) and must not depend on an app being loaded.
 * Answers false for a UPS or a place that does not exist.
 */
export async function updateUpsPlace(id: string, placeId: string | null): Promise<boolean> {
    if (
        placeId &&
        !(await prisma.place.findUnique({ where: { id: placeId }, select: { id: true } }))
    )
        return false;
    const result = await prisma.ups.updateMany({ where: { id }, data: { placeId } });
    return result.count > 0;
}

/** Every place a UPS can be put in, by name. Empty when Places is not installed. */
export async function placeChoices(): Promise<{ id: string; name: string }[]> {
    return prisma.place.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 200
    });
}

/** The UPSes that shut this machine (a metric subject) down, for its own screen. */
export async function upsProtecting(
    machineSubject: string
): Promise<{ id: string; name: string }[]> {
    return prisma.ups.findMany({
        where: { protectedMachineIds: { has: machineSubject } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 20
    });
}

export async function updateUpsSettings(
    id: string,
    input: upsSettings.UpsSettingsInput
): Promise<boolean> {
    const result = await prisma.ups.updateMany({ where: { id }, data: input });
    return result.count > 0;
}

export async function updateUpsVariableMap(
    id: string,
    map: upsSettings.VariableMap
): Promise<boolean> {
    const result = await prisma.ups.updateMany({ where: { id }, data: { variableMap: map } });
    return result.count > 0;
}

export async function removeUps(id: string): Promise<boolean> {
    const row = await prisma.ups.findUnique({
        where: { id },
        select: { connection: true, machineId: true, deviceId: true }
    });
    const removed = await serialUsb(async () => {
        const gone = await prisma.ups.deleteMany({ where: { id } });
        // A USB UPS somebody removed is not added back by itself while it stays plugged in.
        if (gone.count > 0 && row?.connection === "usb")
            await rememberDismissed(`${row.machineId}/${row.deviceId}`);
        return gone;
    });
    if (removed.count > 0) await syncSnmp();
    return removed.count > 0;
}

export async function upsHistory(
    id: string,
    hours: number
): Promise<
    {
        ts: string;
        charge: number | null;
        load: number | null;
        runtimeS: number | null;
        inputV: number | null;
        inputHz: number | null;
        outputV: number | null;
        batteryV: number | null;
        powerW: number | null;
    }[]
> {
    const rows = await prisma.upsSample.findMany({
        where: { upsId: id, ts: { gte: new Date(Date.now() - hours * 3_600_000) } },
        orderBy: { ts: "asc" },
        select: {
            ts: true,
            charge: true,
            load: true,
            runtimeS: true,
            inputV: true,
            inputHz: true,
            outputV: true,
            batteryV: true,
            powerW: true
        },
        take: 24 * 60 * 7
    });
    return rows.map((row) => ({ ...row, ts: row.ts.toISOString() }));
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Only the machine Polaris runs on has a daemon the dashboard can reach. */
function daemonFor(machineId: string | null): HostdClient | null {
    return machineId === LOCAL_HOST_SUBJECT ? new HostdClient() : null;
}

/** The local daemon's USB listing, asked for once however many read it. */
export type UsbListing = () => Promise<HostdUpsList | null>;

export function usbListing(): UsbListing {
    let pending: Promise<HostdUpsList | null> | null = null;
    return () => (pending ??= new HostdClient().ups());
}

/** What the local daemon sees on its USB bus; null without one. */
export async function discoverUsb(
    listUsb: UsbListing = usbListing()
): Promise<HostdUpsList | "updateNeeded" | null> {
    try {
        const list = await listUsb();
        if (list === null || !list.available) return "updateNeeded";
        return list;
    } catch {
        return null;
    }
}

/** What the machine daemon needs to run `snmp-ups` for this UPS. */
function snmpSource(row: UpsRow): HostdSnmpSource {
    const secret = open(row);
    const version = (row.snmpVersion ?? "v2c") as HostdSnmpSource["version"];
    return {
        address: `${row.host ?? ""}${row.port && row.port !== 161 ? `:${row.port}` : ""}`,
        version,
        ...(version === "v3"
            ? {
                  user: row.username ?? "",
                  ...(secret.authPassword ? { authPassword: secret.authPassword } : {}),
                  ...(secret.privPassword ? { privPassword: secret.privPassword } : {})
              }
            : { community: secret.community ?? "" })
    };
}

/** Whether the daemon would take this source; one it refuses would sink the whole set. */
function usableSource(source: HostdSnmpSource): boolean {
    if (source.version !== "v3") return Boolean(source.community);
    return Boolean(source.user) && !(source.privPassword && !source.authPassword);
}

/**
 * Tell the local daemon exactly which SNMP UPSes to drive, so one removed or
 * moved to another address stops being polled and its credentials leave the
 * daemon's configuration. Best-effort: a daemon that is down or predates the
 * call is told again on the watcher's next pass.
 */
export async function syncSnmp(): Promise<void> {
    try {
        const rows = await prisma.ups.findMany({
            where: { connection: "snmp", machineId: LOCAL_HOST_SUBJECT },
            take: 200
        });
        await new HostdClient().upsSnmpSet(rows.map(snmpSource).filter(usableSource));
    } catch {
        // No daemon (the limited edition) has no SNMP drivers to tell.
    }
}

/** A reading out of what the UPS answered, with its variable mapping applied. */
function answered(
    row: UpsRow,
    vars: Record<string, string>,
    commands: string[],
    rw: upsSettings.UpsRwVar[]
): UpsReadResult {
    const mapped = upsSettings.applyVariableMap(vars, upsSettings.readVariableMap(row.variableMap));
    return { ok: true, reading: upsReading.readingFromVars(mapped, commands), vars, rw };
}

export async function readUps(
    row: UpsRow,
    listUsb: UsbListing = usbListing(),
    { writable = false }: { writable?: boolean } = {}
): Promise<UpsReadResult> {
    try {
        if (row.connection === "nut") {
            if (!row.host || !row.upsName) return { ok: false, reason: "notFound" };
            const answer = await nutRead(
                { host: row.host, port: row.port ?? 3493, upsName: row.upsName },
                { writable }
            );
            return answered(row, answer.vars, answer.commands, answer.rw);
        }
        const daemon = daemonFor(row.machineId);
        if (!daemon) return { ok: false, reason: "machineUnreachable" };
        if (row.connection === "usb") {
            const list = await listUsb();
            if (list === null || !list.available) return { ok: false, reason: "updateNeeded" };
            const found = list.devices.find((one) => one.device.id === row.deviceId);
            if (!found) return { ok: false, reason: "notFound" };
            if (!found.vars) return { ok: false, reason: "noAnswer" };
            return answered(row, found.vars, found.commands ?? [], found.rw ?? []);
        }
        const reading = await daemon.upsSnmp(snmpSource(row));
        if (reading === null || reading.available === false)
            return { ok: false, reason: "updateNeeded" };
        if (!reading.vars) return { ok: false, reason: "noAnswer" };
        return answered(row, reading.vars, reading.commands ?? [], reading.rw ?? []);
    } catch {
        // No daemon at all is the limited edition.
        if (row.connection !== "nut" && !(await daemonAnswers())) {
            return { ok: false, reason: "fullEditionNeeded" };
        }
        return { ok: false, reason: "noAnswer" };
    }
}

async function daemonAnswers(): Promise<boolean> {
    try {
        await new HostdClient().health();
        return true;
    } catch {
        return false;
    }
}

/** One UPS with what it says now, for the list and the detail routes. */
export interface UpsSnapshotEntry {
    ups: UpsView;
    result: UpsReadResult;
}

/** Every UPS read at once; one that does not answer is its reason, not a failure. */
export async function upsSnapshot(listUsb: UsbListing = usbListing()): Promise<UpsSnapshotEntry[]> {
    const rows = await prisma.ups.findMany({ orderBy: { createdAt: "asc" }, take: 200 });
    return Promise.all(
        rows.map(async (row) => ({ ups: toView(row), result: await readUps(row, listUsb) }))
    );
}

/** Where the UPS reached over the network are, by id. One read of the host's
 *  table serves them all. */
export async function upsNetwork(
    known: readonly UpsView[]
): Promise<Record<string, core.LanDetails>> {
    const found = await Promise.all(
        known.map(async (ups) => [ups.id, await networkDetails(ups.host)] as const)
    );
    return Object.fromEntries(found.filter(([, details]) => details !== null)) as Record<
        string,
        core.LanDetails
    >;
}

/** A UPS on a machine's USB bus that is not added yet, offered in one click. */
export interface UsbOffer {
    machineId: string;
    deviceId: string;
    name: string;
    serial: string;
}

export type UsbDiscovery =
    | { state: "ok"; offers: UsbOffer[] }
    | { state: "updateNeeded" | "fullEditionNeeded"; offers: [] };

/** What the local daemon sees on USB, less what is already added. */
export async function usbOffers(
    known: readonly UpsView[],
    listUsb: UsbListing = usbListing()
): Promise<UsbDiscovery> {
    const list = await discoverUsb(listUsb);
    if (list === null) return { state: "fullEditionNeeded", offers: [] };
    if (list === "updateNeeded") return { state: "updateNeeded", offers: [] };
    const added = new Set(
        known
            .filter((one) => one.connection === "usb")
            .map((one) => `${one.machineId}/${one.deviceId}`)
    );
    return {
        state: "ok",
        offers: list.devices
            .filter((one) => !added.has(`${LOCAL_HOST_SUBJECT}/${one.device.id}`))
            .map((one) => ({
                machineId: LOCAL_HOST_SUBJECT,
                deviceId: one.device.id,
                name:
                    [one.device.manufacturer, one.device.product]
                        .filter(Boolean)
                        .join(" ")
                        .trim() || `${one.device.vendorId}:${one.device.productId}`,
                serial: one.device.serial
            }))
    };
}

/** USB UPSes somebody removed, as `machine/device`: offered again, never added by themselves. */
const DISMISSED_KEY = "ups.usb.dismissed";
const DISMISSED_MOST = 200;
const dismissedSchema = z.array(z.string().max(300)).max(DISMISSED_MOST);

let usbQueue: Promise<unknown> = Promise.resolve();

/** One change to the USB rows or the removed list at a time, so none reads what another is writing. */
function serialUsb<T>(work: () => Promise<T>): Promise<T> {
    const run = usbQueue.then(work, work);
    usbQueue = run.catch(() => undefined);
    return run;
}

async function readDismissed(): Promise<Set<string>> {
    const raw = await getSetting(DISMISSED_KEY);
    if (!raw) return new Set();
    try {
        const parsed = dismissedSchema.safeParse(JSON.parse(raw));
        return new Set(parsed.success ? parsed.data : []);
    } catch {
        return new Set();
    }
}

async function rememberDismissed(key: string): Promise<void> {
    const dismissed = await readDismissed();
    if (dismissed.has(key)) return;
    await setSetting(DISMISSED_KEY, JSON.stringify([...dismissed, key].slice(-DISMISSED_MOST)));
}

async function forgetDismissed(key: string): Promise<void> {
    const dismissed = await readDismissed();
    if (!dismissed.delete(key)) return;
    await setSetting(DISMISSED_KEY, dismissed.size > 0 ? JSON.stringify([...dismissed]) : null);
}

let adopting: Promise<number> | null = null;

/**
 * Start watching every UPS the local daemon sees on USB that is not watched yet,
 * the way a NUT install picks up a UPS on its own: plugging one in is the whole
 * setup. One somebody removed stays offered instead. The number added; one pass
 * at a time, so the watcher and an open list never add the same UPS twice.
 */
export function adoptUsb(listUsb: UsbListing = usbListing()): Promise<number> {
    adopting ??= serialUsb(async () => {
        try {
            const seen = await usbOffers([], listUsb);
            if (seen.state !== "ok" || seen.offers.length === 0) return 0;
            const watched = await prisma.ups.findMany({
                where: {
                    connection: "usb",
                    machineId: LOCAL_HOST_SUBJECT,
                    deviceId: { in: seen.offers.map((one) => one.deviceId) }
                },
                select: { deviceId: true }
            });
            const taken = new Set(watched.map((one) => one.deviceId));
            const dismissed = await readDismissed();
            let added = 0;
            for (const offer of seen.offers) {
                if (taken.has(offer.deviceId)) continue;
                if (dismissed.has(`${offer.machineId}/${offer.deviceId}`)) continue;
                const input = upsReading.upsConnectionSchema.safeParse({
                    connection: "usb",
                    name: offer.name.slice(0, 80),
                    machineId: offer.machineId,
                    deviceId: offer.deviceId
                });
                if (!input.success) continue;
                await prisma.ups.create({ data: columnsFor(input.data, {}) });
                added += 1;
            }
            return added;
        } finally {
            adopting = null;
        }
    });
    return adopting;
}

/** The offers a list shows: only the USB UPSes somebody removed, since the rest are added by themselves. */
export async function dismissedOffers(discovery: UsbDiscovery): Promise<UsbDiscovery> {
    if (discovery.state !== "ok") return discovery;
    const dismissed = await readDismissed();
    return {
        state: "ok",
        offers: discovery.offers.filter((one) => dismissed.has(`${one.machineId}/${one.deviceId}`))
    };
}

export type UpsCommandResult = "ok" | "unsupported" | "refused" | "unreachable" | "loginNeeded";

/** Run one instant command the UPS itself lists. */
export async function runUpsCommand(row: UpsRow, command: string): Promise<UpsCommandResult> {
    try {
        const now = await readUps(row);
        if (now.ok && !now.reading.commands.includes(command)) return "unsupported";
        if (row.connection === "nut") {
            const { password } = open(row);
            if (!row.username || !password || !row.host || !row.upsName) return "loginNeeded";
            await nutCommand(
                { host: row.host, port: row.port ?? 3493, upsName: row.upsName },
                row.username,
                password,
                command
            );
            return "ok";
        }
        const daemon = daemonFor(row.machineId);
        if (!daemon) return "unreachable";
        const id =
            row.connection === "usb" ? row.deviceId : (await daemon.upsSnmp(snmpSource(row)))?.id;
        if (!id) return "unreachable";
        const answer = await daemon.upsCommand(id, command);
        if (answer === null) return "unreachable";
        if (answer.ok) return "ok";
        return answer.error?.includes("support") ? "unsupported" : "refused";
    } catch (error) {
        return error instanceof Error && error.message === "CMD-NOT-SUPPORTED"
            ? "unsupported"
            : "refused";
    }
}

export type UpsSetResult = UpsCommandResult | "invalid";

/** Set one variable the UPS lists as writable, checked against its kind first. */
export async function setUpsVar(
    row: UpsRow,
    name: string,
    value: string
): Promise<{ outcome: UpsSetResult; error?: string }> {
    try {
        const now = await readUps(row, usbListing(), { writable: true });
        if (!now.ok) return { outcome: "unreachable" };
        const rw = now.rw.find((one) => one.name === name);
        if (!rw) return { outcome: "unsupported" };
        const error = upsSettings.rwValueError(rw, value);
        if (error) return { outcome: "invalid", error };
        if (row.connection === "nut") {
            const { password } = open(row);
            if (!row.username || !password || !row.host || !row.upsName)
                return { outcome: "loginNeeded" };
            await nutSetVar(
                { host: row.host, port: row.port ?? 3493, upsName: row.upsName },
                row.username,
                password,
                name,
                value
            );
            return { outcome: "ok" };
        }
        const daemon = daemonFor(row.machineId);
        if (!daemon) return { outcome: "unreachable" };
        const id =
            row.connection === "usb" ? row.deviceId : (await daemon.upsSnmp(snmpSource(row)))?.id;
        if (!id) return { outcome: "unreachable" };
        const answer = await daemon.upsSet(id, name, value);
        if (answer === null) return { outcome: "unreachable" };
        return { outcome: answer.ok ? "ok" : "refused" };
    } catch {
        return { outcome: "refused" };
    }
}

// ---------------------------------------------------------------------------
// Network UPS service (netserver)
// ---------------------------------------------------------------------------

/** The login other machines' upsmon uses. Derived from the master key, so it
 *  needs no storage, is the same after every restart, and repairs itself. */
export function netserverLogin(): { user: string; password: string; port: number } {
    const password = createHmac("sha256", loadEnv().POLARIS_MASTER_KEY)
        .update("polaris-ups-netserver")
        .digest("hex")
        .slice(0, 32);
    return { user: "upsmon-remote", password, port: 3493 };
}

/** The name the machine daemon serves a UPS under. */
export function daemonUpsName(
    row: Pick<UpsRow, "connection" | "deviceId" | "host" | "port">
): string | null {
    if (row.connection === "usb") return row.deviceId;
    if (row.connection !== "snmp" || !row.host) return null;
    return upsSettings.snmpUpsName(
        `${row.host}${row.port && row.port !== 161 ? `:${row.port}` : ""}`
    );
}

/** Whether a UPS can be offered to the network: one this machine's daemon drives. */
export function canOfferNetwork(row: Pick<UpsRow, "connection" | "machineId">): boolean {
    return row.connection !== "nut" && row.machineId === LOCAL_HOST_SUBJECT;
}

/** Make the local daemon offer, or stop offering, its UPSes to the network. */
async function syncNetserver(rows: readonly UpsRow[]): Promise<void> {
    const wanted = rows.some((row) => canOfferNetwork(row) && row.netserverEnabled)
        ? netserverLogin()
        : null;
    await new HostdClient().upsNetserver(wanted).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/** Power one machine off: through its daemon, or over its SSH login. */
export async function powerOffMachine(machineId: string): Promise<boolean> {
    try {
        if (machineId === LOCAL_HOST_SUBJECT)
            return (await new HostdClient().hostPowerOff()) === true;
        const host = await prisma.host.findUnique({
            where: { id: machineId },
            select: { ownerId: true }
        });
        if (!host) return false;
        const connection = await getHostConnection(machineId, host.ownerId);
        const lease = await borrowSsh("exec", machineId, {
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey ?? [],
            readyTimeoutMs: 10_000
        });
        try {
            // Fixed text, no input: root powers off directly, anybody else
            // through passwordless sudo. The connection drops as it goes down.
            await execCommand(
                lease.client,
                'sh -c \'if [ "$(id -u)" = 0 ]; then p=; else p="sudo -n"; fi; $p systemctl poweroff || $p shutdown -h now\'',
                {}
            ).catch(() => undefined);
        } finally {
            lease.release();
        }
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

const TICK_MS = 30_000;
const SAMPLE_EVERY_MS = 60_000;
const DAY_MS = 24 * 3_600_000;
/** Events and actions are kept a year; hourly energy five. */
const LOG_KEEP_MS = 365 * DAY_MS;
const ENERGY_KEEP_MS = 1830 * DAY_MS;
const PRUNE_EVERY_MS = 3_600_000;
const REPORT_RETRY_MS = 3_600_000;
/** UPSes read at once, so one slow to answer never holds up the rest's shutdown. */
const READ_CONCURRENCY = 8;
/** Who hears about a UPS: whoever may open its screen and act on it. */
const UPS_PERMISSION: Permission = "system.manage";
const lastSample = new Map<string, number>();
const lastReportTry = new Map<string, number>();
let lastPrune = 0;
/** Per UPS, the protected machines this outage's power-off has not reached
 *  yet. Retried every pass while the UPS stays on battery. */
const powerOffPending = new Map<string, Set<string>>();

/** An alert in each reader's words, and in the default language when theirs cannot be worked out. */
function inWords(say: (t: NamespaceTranslator<"notices">) => { title: string; body: string }) {
    return { ...say(translatorFor(DEFAULT_LOCALE, "notices")), say };
}

/** The notice words each kind is told in. The first five keep the words they
 *  had before the event log; every other kind has its own. */
const KIND_WORDS = {
    ONBATT: "ups.onBattery",
    ONLINE: "ups.online",
    LOWBATT: "ups.lowBattery",
    TEST: "ups.test",
    REPLBATT: "ups.replaceBattery",
    FSD: "ups.kinds.FSD",
    CAL: "ups.kinds.CAL",
    TRIM: "ups.kinds.TRIM",
    BOOST: "ups.kinds.BOOST",
    OFF: "ups.kinds.OFF",
    OVERLOAD: "ups.kinds.OVERLOAD",
    BYPASS: "ups.kinds.BYPASS",
    COMMOK: "ups.kinds.COMMOK",
    COMMBAD: "ups.kinds.COMMBAD",
    NOCOMM: "ups.kinds.NOCOMM",
    SHUTDOWN: "ups.kinds.SHUTDOWN"
} as const satisfies Record<upsEvents.UpsEventKind, string>;

/** Log one event, tell whoever may act on the UPS if it notifies for this
 *  kind, and start the automations that follow it. */
async function announce(
    row: UpsRow,
    kind: upsEvents.UpsEventKind,
    at: number,
    reading: upsReading.UpsReading | null,
    detail: string | null = null
): Promise<void> {
    await upsData.recordEvent(row.id, kind, new Date(at), detail);
    const event = upsEvents.KIND_NOTICE[kind];
    if (row.notifyKinds.includes(kind)) {
        const outcome = upsReading.testOutcome(reading?.testResult ?? null);
        const tone = upsEvents.UPS_EVENT_TONE[kind];
        await notifyOperators({
            permission: UPS_PERMISSION,
            event,
            ...inWords((t) => ({
                title: t(`${KIND_WORDS[kind]}.title` as const, { name: row.name }),
                body: t(`${KIND_WORDS[kind]}.body` as const, {
                    charge: reading?.charge == null ? "?" : Math.round(reading.charge),
                    minutes: reading?.runtimeS == null ? "?" : Math.round(reading.runtimeS / 60),
                    result: reading?.testResult ?? detail ?? ""
                })
            })),
            ...((kind === "TEST" && outcome === "failed") || tone === "danger"
                ? { level: "danger" as const }
                : {}),
            href: `/places/ups/${row.id}?tab=events`,
            metadata: { upsId: row.id, kind }
        }).catch((error: unknown) =>
            console.error("polaris: could not report a UPS event:", error)
        );
    }
    const { raiseAutomationEventEverywhere } = await import("@/lib/deploy/automations");
    await raiseAutomationEventEverywhere(event);
}

/** How a protected machine is named to the people told about it. */
async function machineName(machineId: string): Promise<string> {
    if (machineId === LOCAL_HOST_SUBJECT) {
        return (await getLocalServerName().catch(() => null)) ?? LOCAL_SERVER_FALLBACK_NAME;
    }
    const host = await prisma.host
        .findUnique({ where: { id: machineId }, select: { name: true } })
        .catch(() => null);
    return host?.name ?? machineId;
}

async function reportPowerOffFailed(row: UpsRow, machineId: string): Promise<void> {
    const machine = await machineName(machineId);
    await notifyOperators({
        permission: UPS_PERMISSION,
        event: "ups.shutdownFailed",
        ...inWords((t) => ({
            title: t("ups.shutdownFailed.title", { machine }),
            body: t("ups.shutdownFailed.body", { name: row.name })
        })),
        level: "danger",
        actionRequired: true,
        href: `/places/ups/${row.id}`,
        metadata: { upsId: row.id, machineId }
    }).catch((error: unknown) =>
        console.error("polaris: could not report a failed UPS shutdown:", error)
    );
}

/**
 * Power off `machineIds` in turn, the machine Polaris runs on last so the
 * others are told first. One that fails stays pending for the next pass, and is
 * reported the first time it fails in an outage rather than on every retry.
 */
async function powerOff(row: UpsRow, machineIds: readonly string[]): Promise<void> {
    const order = [...machineIds].sort(
        (a, b) => Number(a === LOCAL_HOST_SUBJECT) - Number(b === LOCAL_HOST_SUBJECT)
    );
    const reported = powerOffPending.get(row.id) ?? new Set<string>();
    const pending = new Set<string>();
    for (const machineId of order) {
        if (await powerOffMachine(machineId)) continue;
        pending.add(machineId);
        if (!reported.has(machineId)) await reportPowerOffFailed(row, machineId);
    }
    if (pending.size > 0) powerOffPending.set(row.id, pending);
    else powerOffPending.delete(row.id);
}

/** The flags a row last saw; a row from before the event log has only its
 *  power state, which is enough not to raise "on battery" twice. */
function flagsBefore(row: UpsRow): string | null {
    if (row.lastFlags !== null) return row.lastFlags;
    const memory = upsReading.decodeMemory(row.lastStatus, row.lastTestResult);
    if (!memory) return null;
    const flags =
        memory.power === "online" ? ["OL"] : memory.power === "battery" ? ["OB"] : ["OB", "LB"];
    if (memory.replaceBattery) flags.push("RB");
    return upsEvents.normalizeFlags(flags.join(" "));
}

/** A UPS that does not answer: COMMBAD now, NOCOMM once it stays quiet. */
async function watchUnreachable(row: UpsRow, now: number): Promise<void> {
    const nocommLogged =
        row.commLostAt !== null &&
        (await prisma.upsEvent.count({
            where: { upsId: row.id, kind: "NOCOMM", ts: { gte: row.commLostAt } }
        })) > 0;
    const comm = upsEvents.commEvents(row.commLostAt, false, now, nocommLogged);
    if (comm.commLostAt?.getTime() !== row.commLostAt?.getTime()) {
        await prisma.ups.update({ where: { id: row.id }, data: { commLostAt: comm.commLostAt } });
    }
    for (const kind of comm.events) await announce(row, kind, now, null);
}

/** Add this reading's energy to its hour. */
async function addEnergy(
    row: UpsRow,
    powerW: number | null,
    now: number,
    elapsedMs: number
): Promise<void> {
    const wh = upsSettings.energyWh(powerW, elapsedMs);
    if (wh <= 0) return;
    const cost = upsSettings.costOf(wh, row.pricePerKwh);
    const hour = upsSettings.hourOf(now);
    await prisma.upsEnergyHour
        .upsert({
            where: { upsId_hour: { upsId: row.id, hour } },
            create: { upsId: row.id, hour, wh, cost, currency: row.currency },
            update: { wh: { increment: wh }, cost: { increment: cost } }
        })
        .catch(() => undefined);
}

/** Write a due report into the drive of everyone who may act on the UPS, and
 *  tell them it is there. */
async function sendReport(row: UpsRow, now: number): Promise<void> {
    const schedule = row.reportSchedule as upsSettings.ReportSchedule;
    if (!upsSettings.reportDue(schedule, row.reportLastAt, now) || schedule === "off") return;
    if (now - (lastReportTry.get(row.id) ?? 0) < REPORT_RETRY_MS) return;
    lastReportTry.set(row.id, now);
    const period = upsSettings.previousPeriod(schedule, now);
    try {
        for (const userId of await usersWithPermission(UPS_PERMISSION)) {
            const words = await wordsFor(userId, "notices");
            const t: upsData.ReportWords = (key, values) => words(`ups.${key}` as const, values);
            const content = await upsData.buildReport(row, period, t);
            const name = `${upsData.fileStem(row.name)}-${schedule}-${period.from.toISOString().slice(0, 10)}.md`;
            await upsData.saveToDrive(userId, name, content);
            await notify({
                userId,
                event: "ups.report",
                title: words("ups.report.ready.title", { name: row.name }),
                body: words("ups.report.ready.body", { file: `${upsData.DRIVE_FOLDER}/${name}` }),
                audience: "admins",
                href: "/drive",
                metadata: { upsId: row.id }
            }).catch(() => undefined);
        }
        await prisma.ups.update({ where: { id: row.id }, data: { reportLastAt: new Date(now) } });
    } catch (error) {
        console.error("polaris: a UPS report could not be written:", error);
    }
}

/** Old readings past each UPS's own retention, and old logs. Hourly at most. */
async function prune(rows: readonly UpsRow[], now: number): Promise<void> {
    if (now - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = now;
    for (const row of rows) {
        await prisma.upsSample
            .deleteMany({
                where: { upsId: row.id, ts: { lt: new Date(now - row.retentionDays * DAY_MS) } }
            })
            .catch(() => undefined);
    }
    await prisma.upsEvent
        .deleteMany({ where: { ts: { lt: new Date(now - LOG_KEEP_MS) } } })
        .catch(() => undefined);
    await prisma.upsAction
        .deleteMany({ where: { ts: { lt: new Date(now - LOG_KEEP_MS) } } })
        .catch(() => undefined);
    await prisma.upsEnergyHour
        .deleteMany({ where: { hour: { lt: new Date(now - ENERGY_KEEP_MS) } } })
        .catch(() => undefined);
}

/** One UPS's pass: sample, log and alert on a change, shut down when due. */
async function watchOne(row: UpsRow, now: number, listUsb: UsbListing): Promise<void> {
    const result = await readUps(row, listUsb);
    if (!result.ok) {
        if (result.reason !== "fullEditionNeeded" && result.reason !== "updateNeeded") {
            await watchUnreachable(row, now);
        }
        return;
    }
    const reading = result.reading;
    const previous = lastSample.get(row.id);
    if (previous === undefined || now - previous >= SAMPLE_EVERY_MS) {
        lastSample.set(row.id, now);
        const powerW = upsSettings.powerWatts({
            realPowerW: reading.realPowerW,
            load: reading.load,
            nominalPowerW: reading.nominalPowerW,
            overrideW: row.nominalPowerW
        });
        await prisma.upsSample
            .create({
                data: {
                    upsId: row.id,
                    ts: new Date(now),
                    charge: reading.charge,
                    runtimeS: reading.runtimeS,
                    load: reading.load,
                    inputV: reading.inputV,
                    inputHz: reading.inputHz,
                    outputV: reading.outputV,
                    batteryV: reading.batteryV,
                    powerW
                }
            })
            .catch(() => undefined);
        // The first sample after a restart has no interval to count.
        if (previous !== undefined) await addEnergy(row, powerW, now, now - previous);
    }
    const memory = upsReading.memoryOf(reading);
    const testEvent = upsReading
        .upsTransitions(upsReading.decodeMemory(row.lastStatus, row.lastTestResult), memory)
        .includes("ups.test");
    // Firmware that says "replace" only in the test result counts as RB.
    const flags = upsEvents.normalizeFlags(
        `${reading.flags}${reading.status.replaceBattery ? " RB" : ""}`
    );
    const kinds = upsEvents.flagEvents(flagsBefore(row), flags);
    const comm = upsEvents.commEvents(row.commLostAt, true, now, false);
    const due = upsReading.shutdownDue(reading, {
        enabled: row.shutdownEnabled,
        belowCharge: row.shutdownBelowCharge,
        belowRuntimeMin: row.shutdownBelowRuntimeMin
    });
    const encoded = upsReading.encodeMemory(memory);
    // Back on the mains ends the outage: the next one may shut down again.
    const rearm = reading.status.online && row.shutdownSentAt !== null;
    const send = due && !row.shutdownSentAt;
    // Written on a change only: a steady UPS is no write every pass.
    if (
        encoded.lastStatus !== row.lastStatus ||
        encoded.lastTestResult !== row.lastTestResult ||
        flags !== row.lastFlags ||
        row.commLostAt !== null ||
        rearm ||
        send
    ) {
        await prisma.ups.update({
            where: { id: row.id },
            data: {
                ...encoded,
                lastFlags: flags,
                commLostAt: null,
                ...(rearm ? { shutdownSentAt: null } : {}),
                ...(send ? { shutdownSentAt: new Date(now) } : {})
            }
        });
    }
    if (reading.status.online) powerOffPending.delete(row.id);
    for (const kind of comm.events) await announce(row, kind, now, reading);
    for (const kind of kinds) await announce(row, kind, now, reading);
    if (testEvent) await announce(row, "TEST", now, reading, reading.testResult);
    await sendReport(row, now);
    if (send) {
        await announce(row, "SHUTDOWN", now, reading, String(row.protectedMachineIds.length));
        powerOffPending.delete(row.id);
        await powerOff(row, row.protectedMachineIds);
    } else if (row.shutdownSentAt && reading.status.onBattery) {
        const retry = [...(powerOffPending.get(row.id) ?? [])].filter((id) =>
            row.protectedMachineIds.includes(id)
        );
        if (retry.length > 0) await powerOff(row, retry);
    }
}

/** One pass over every UPS, a few read side by side. */
export async function watchUpsOnce(now = Date.now()): Promise<void> {
    await syncSnmp();
    const listUsb = usbListing();
    await adoptUsb(listUsb).catch((error: unknown) =>
        console.error("polaris: a UPS on USB could not be added:", error)
    );
    const rows = await prisma.ups.findMany({ take: 200 });
    await syncNetserver(rows);
    const queue = [...rows];
    await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
            for (let row = queue.shift(); row; row = queue.shift()) {
                await watchOne(row, now, listUsb).catch((error: unknown) =>
                    console.error("polaris: the UPS watcher failed on one UPS:", error)
                );
            }
        })
    );
    await prune(rows, now);
}

const STARTED = Symbol.for("polaris.ups.watch");

/** Start the watcher once per process. */
export function startUpsWatch(): void {
    const holder = globalThis as { [STARTED]?: boolean };
    if (holder[STARTED]) return;
    holder[STARTED] = true;
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await watchUpsOnce();
        } catch (error) {
            console.error("polaris: the UPS watcher failed a pass:", error);
        } finally {
            running = false;
        }
    };
    setInterval(() => void run(), TICK_MS).unref?.();
    void run();
}
