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

import { loadEnv } from "@polaris/config";
import { execCommand } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { nutCommand, nutRead } from "./nut-client";
import { notify } from "@/lib/notifications/dispatch";
import { getHostConnection } from "@/lib/host-service";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { wordsFor } from "@/lib/notifications/notice-words";
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
    return row.id;
}

export async function updateUpsConnection(id: string, input: upsReading.UpsConnectionInput): Promise<boolean> {
    const row = await getUps(id);
    if (!row) return false;
    await prisma.ups.update({
        where: { id },
        data: columnsFor(input, row.connection === input.connection ? open(row) : {})
    });
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
    return (await prisma.ups.deleteMany({ where: { id } })).count > 0;
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

/** What the local daemon sees on its USB bus; null without one. */
export async function discoverUsb(): Promise<HostdUpsList | "updateNeeded" | null> {
    try {
        const list = await new HostdClient().ups();
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

export async function readUps(row: UpsRow): Promise<UpsReadResult> {
    try {
        if (row.connection === "nut") {
            if (!row.host || !row.upsName) return { ok: false, reason: "notFound" };
            const answer = await nutRead({ host: row.host, port: row.port ?? 3493, upsName: row.upsName });
            return { ok: true, reading: upsReading.readingFromVars(answer.vars, answer.commands) };
        }
        const daemon = daemonFor(row.machineId);
        if (!daemon) return { ok: false, reason: "machineUnreachable" };
        if (row.connection === "usb") {
            const list = await daemon.ups();
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
export async function upsSnapshot(): Promise<UpsSnapshotEntry[]> {
    const rows = await prisma.ups.findMany({ orderBy: { createdAt: "asc" }, take: 200 });
    return Promise.all(rows.map(async (row) => ({ ups: toView(row), result: await readUps(row) })));
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
export async function usbOffers(known: readonly UpsView[]): Promise<UsbDiscovery> {
    const list = await discoverUsb();
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
const lastSample = new Map<string, number>();

async function admins(): Promise<string[]> {
    return (
        await prisma.user
            .findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } })
            .catch(() => [])
    ).map((user) => user.id);
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
    for (const userId of await admins()) {
        const t = await wordsFor(userId, "notices");
        await notify({
            userId,
            event,
            title: t(EVENT_WORDS[event].title, { name: row.name }),
            body: t(EVENT_WORDS[event].body, {
                charge: reading.charge === null ? "?" : Math.round(reading.charge),
                minutes: reading.runtimeS === null ? "?" : Math.round(reading.runtimeS / 60),
                result: reading.testResult ?? ""
            }),
            ...(event === "ups.test" && outcome === "failed" ? { level: "danger" as const } : {}),
            audience: "admins",
            href: `/apps/servers/ups/${row.id}`,
            metadata: { upsId: row.id }
        }).catch((error: unknown) => console.error("polaris: could not report a UPS event:", error));
    }
    const { raiseAutomationEventEverywhere } = await import("@/lib/deploy/automations");
    await raiseAutomationEventEverywhere(event);
}

/** One pass over every UPS: sample, alert on a change, shut down when due. */
export async function watchUpsOnce(now = Date.now()): Promise<void> {
    const rows = await prisma.ups.findMany({ take: 200 });
    for (const row of rows) {
        const result = await readUps(row);
        if (!result.ok) continue;
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
        for (const event of events) await announce(row, event, reading);
        if (send) {
            // The machine Polaris runs on goes last, so the others are told first.
            const order = [...row.protectedMachineIds].sort(
                (a, b) => Number(a === LOCAL_HOST_SUBJECT) - Number(b === LOCAL_HOST_SUBJECT)
            );
            for (const machineId of order) await powerOffMachine(machineId);
        }
    }
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
