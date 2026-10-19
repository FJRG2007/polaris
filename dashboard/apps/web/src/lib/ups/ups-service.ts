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

import { z } from "zod";
import { loadEnv } from "@polaris/config";
import { execCommand } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { prisma } from "@polaris/db";
import { nutCommand, nutRead } from "./nut-client";
import { getHostConnection } from "@/lib/host-service";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { notifyOperators } from "@/lib/notifications/operators";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { DEFAULT_LOCALE, type Permission } from "@polaris/core";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { HostdClient, type HostdSnmpSource, type HostdUpsList } from "@polaris/hostd-client";
import * as upsReading from "./ups-reading";

type UpsRow = NonNullable<Awaited<ReturnType<typeof prisma.ups.findUnique>>>;

/** Why a UPS has no reading, in words the screen translates. */
export type UpsUnreachable =
    | "fullEditionNeeded"
    | "updateNeeded"
    | "machineUnreachable"
    | "notFound"
    | "noAnswer";

export type UpsReadResult =
    | { ok: true; reading: upsReading.UpsReading }
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
}

export function toView(row: UpsRow): UpsView {
    return {
        id: row.id,
        name: row.name,
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
        shutdownSentAt: row.shutdownSentAt?.toISOString() ?? null
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
    const row = await prisma.ups.create({ data: columnsFor(input, {}) });
    if (input.connection === "snmp") await syncSnmp();
    return row.id;
}

export async function updateUpsConnection(id: string, input: upsReading.UpsConnectionInput): Promise<boolean> {
    const row = await getUps(id);
    if (!row) return false;
    await prisma.ups.update({
        where: { id },
        data: columnsFor(input, row.connection === input.connection ? open(row) : {})
    });
    if (row.connection === "snmp" || input.connection === "snmp") await syncSnmp();
    return true;
}

export async function updateUpsShutdown(id: string, input: upsReading.UpsShutdownInput): Promise<boolean> {
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

export async function removeUps(id: string): Promise<boolean> {
    const removed = await prisma.ups.deleteMany({ where: { id } });
    if (removed.count > 0) await syncSnmp();
    return removed.count > 0;
}

export async function upsHistory(
    id: string,
    hours: number
): Promise<{ ts: string; charge: number | null; load: number | null; runtimeS: number | null; inputV: number | null }[]> {
    const rows = await prisma.upsSample.findMany({
        where: { upsId: id, ts: { gte: new Date(Date.now() - hours * 3_600_000) } },
        orderBy: { ts: "asc" },
        select: { ts: true, charge: true, load: true, runtimeS: true, inputV: true },
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
export async function discoverUsb(listUsb: UsbListing = usbListing()): Promise<HostdUpsList | "updateNeeded" | null> {
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

export async function readUps(row: UpsRow, listUsb: UsbListing = usbListing()): Promise<UpsReadResult> {
    try {
        if (row.connection === "nut") {
            if (!row.host || !row.upsName) return { ok: false, reason: "notFound" };
            const answer = await nutRead({ host: row.host, port: row.port ?? 3493, upsName: row.upsName });
            return { ok: true, reading: upsReading.readingFromVars(answer.vars, answer.commands) };
        }
        const daemon = daemonFor(row.machineId);
        if (!daemon) return { ok: false, reason: "machineUnreachable" };
        if (row.connection === "usb") {
            const list = await listUsb();
            if (list === null || !list.available) return { ok: false, reason: "updateNeeded" };
            const found = list.devices.find((one) => one.device.id === row.deviceId);
            if (!found) return { ok: false, reason: "notFound" };
            if (!found.vars) return { ok: false, reason: "noAnswer" };
            return { ok: true, reading: upsReading.readingFromVars(found.vars, found.commands ?? []) };
        }
        const reading = await daemon.upsSnmp(snmpSource(row));
        if (reading === null || reading.available === false) return { ok: false, reason: "updateNeeded" };
        if (!reading.vars) return { ok: false, reason: "noAnswer" };
        return { ok: true, reading: upsReading.readingFromVars(reading.vars, reading.commands ?? []) };
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
    return Promise.all(rows.map(async (row) => ({ ups: toView(row), result: await readUps(row, listUsb) })));
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
        known.filter((one) => one.connection === "usb").map((one) => `${one.machineId}/${one.deviceId}`)
    );
    return {
        state: "ok",
        offers: list.devices
            .filter((one) => !added.has(`${LOCAL_HOST_SUBJECT}/${one.device.id}`))
            .map((one) => ({
                machineId: LOCAL_HOST_SUBJECT,
                deviceId: one.device.id,
                name:
                    [one.device.manufacturer, one.device.product].filter(Boolean).join(" ").trim() ||
                    `${one.device.vendorId}:${one.device.productId}`,
                serial: one.device.serial
            }))
    };
}

export type UpsCommandResult = "ok" | "unsupported" | "refused" | "unreachable" | "loginNeeded";

export async function runUpsCommand(row: UpsRow, command: upsReading.UpsCommand): Promise<UpsCommandResult> {
    try {
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
            row.connection === "usb"
                ? row.deviceId
                : (await daemon.upsSnmp(snmpSource(row)))?.id;
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

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/** Power one machine off: through its daemon, or over its SSH login. */
export async function powerOffMachine(machineId: string): Promise<boolean> {
    try {
        if (machineId === LOCAL_HOST_SUBJECT) return (await new HostdClient().hostPowerOff()) === true;
        const host = await prisma.host.findUnique({ where: { id: machineId }, select: { ownerId: true } });
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
                "sh -c 'if [ \"$(id -u)\" = 0 ]; then p=; else p=\"sudo -n\"; fi; $p systemctl poweroff || $p shutdown -h now'",
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
const KEEP_MS = 30 * 24 * 3_600_000;
/** UPSes read at once, so one slow to answer never holds up the rest's shutdown. */
const READ_CONCURRENCY = 8;
/** Who hears about a UPS: whoever may open its screen and act on it. */
const UPS_PERMISSION: Permission = "system.manage";
const lastSample = new Map<string, number>();
/** Per UPS, the protected machines this outage's power-off has not reached
 *  yet. Retried every pass while the UPS stays on battery. */
const powerOffPending = new Map<string, Set<string>>();

/** An alert in each reader's words, and in the default language when theirs cannot be worked out. */
function inWords(say: (t: NamespaceTranslator<"notices">) => { title: string; body: string }) {
    return { ...say(translatorFor(DEFAULT_LOCALE, "notices")), say };
}

const EVENT_WORDS = {
    "ups.onBattery": { title: "ups.onBattery.title", body: "ups.onBattery.body" },
    "ups.online": { title: "ups.online.title", body: "ups.online.body" },
    "ups.lowBattery": { title: "ups.lowBattery.title", body: "ups.lowBattery.body" },
    "ups.test": { title: "ups.test.title", body: "ups.test.body" },
    "ups.replaceBattery": { title: "ups.replaceBattery.title", body: "ups.replaceBattery.body" }
} as const satisfies Record<upsReading.UpsEvent, { title: string; body: string }>;

async function announce(row: UpsRow, event: upsReading.UpsEvent, reading: upsReading.UpsReading): Promise<void> {
    const outcome = upsReading.testOutcome(reading.testResult);
    await notifyOperators({
        permission: UPS_PERMISSION,
        event,
        ...inWords((t) => ({
            title: t(EVENT_WORDS[event].title, { name: row.name }),
            body: t(EVENT_WORDS[event].body, {
                charge: reading.charge === null ? "?" : Math.round(reading.charge),
                minutes: reading.runtimeS === null ? "?" : Math.round(reading.runtimeS / 60),
                result: reading.testResult ?? ""
            })
        })),
        ...(event === "ups.test" && outcome === "failed" ? { level: "danger" as const } : {}),
        href: `/apps/servers/ups/${row.id}`,
        metadata: { upsId: row.id }
    }).catch((error: unknown) => console.error("polaris: could not report a UPS event:", error));
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
        href: `/apps/servers/ups/${row.id}`,
        metadata: { upsId: row.id, machineId }
    }).catch((error: unknown) => console.error("polaris: could not report a failed UPS shutdown:", error));
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

/** One UPS's pass: sample, alert on a change, shut down when due. */
async function watchOne(row: UpsRow, now: number, listUsb: UsbListing): Promise<void> {
    const result = await readUps(row, listUsb);
    if (!result.ok) return;
    const reading = result.reading;
    if (now - (lastSample.get(row.id) ?? 0) >= SAMPLE_EVERY_MS) {
        lastSample.set(row.id, now);
        await prisma.upsSample
            .create({
                data: {
                    upsId: row.id,
                    ts: new Date(now),
                    charge: reading.charge,
                    runtimeS: reading.runtimeS,
                    load: reading.load,
                    inputV: reading.inputV
                }
            })
            .catch(() => undefined);
    }
    const memory = upsReading.memoryOf(reading);
    const events = upsReading.upsTransitions(upsReading.decodeMemory(row.lastStatus, row.lastTestResult), memory);
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
        rearm ||
        send
    ) {
        await prisma.ups.update({
            where: { id: row.id },
            data: {
                ...encoded,
                ...(rearm ? { shutdownSentAt: null } : {}),
                ...(send ? { shutdownSentAt: new Date(now) } : {})
            }
        });
    }
    if (reading.status.online) powerOffPending.delete(row.id);
    for (const event of events) await announce(row, event, reading);
    if (send) {
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
    const rows = await prisma.ups.findMany({ take: 200 });
    const listUsb = usbListing();
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
    await prisma.upsSample
        .deleteMany({ where: { ts: { lt: new Date(now - KEEP_MS) } } })
        .catch(() => undefined);
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
