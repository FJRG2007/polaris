/**
 * The accounts, hubs and boxes a place's devices are reached through.
 *
 * One row is one way in to one make. Which fields it holds is the connection's
 * own business - a token, or an address and a password - and this file never
 * looks inside them: it stores what the registry asked for, hands it to the
 * driver by name, and is the only place that decrypts anything.
 *
 * Everything about the credential is deliberately one-way. It is proved before it
 * is stored, so a token that is refused never becomes the connection. It is
 * encrypted at rest. And there is no screen, action or route anywhere that reads
 * one back: what a connection is pointed at can be shown, what it is opened with
 * cannot.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { HomeError } from "@/lib/home/home-error";
import * as registry from "@/lib/home/device-connections";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { NUKI_WEB, nukiWebDriver } from "@/lib/home/drivers/nuki-web";
import { TUYA_CLOUD, tuyaCloudDriver } from "@/lib/home/drivers/tuya-cloud";
import { DriverError, type Credentials, type DeviceDriver } from "@/lib/home/drivers/contract";

/**
 * Every driver Polaris has, by the connection it implements.
 *
 * Adding a make is an entry here and an entry in the registry. Nothing else in
 * the app names one, which is the whole point of the shape.
 */
const DRIVERS: Readonly<Record<string, DeviceDriver>> = {
    [NUKI_WEB]: nukiWebDriver,
    [TUYA_CLOUD]: tuyaCloudDriver
};

export function driverFor(connection: string): DeviceDriver {
    const driver = DRIVERS[connection];
    if (!driver) {
        throw new HomeError("That connection was made by a version of Polaris that is no longer here");
    }
    return driver;
}

/** Whether Polaris can actually use a connection. The picker only offers what is
 *  built, and this is that rule where a request arrives rather than a click. */
export function isConnectable(connection: string): boolean {
    return connection in DRIVERS && registry.deviceConnection(connection) !== null;
}

// ---------------------------------------------------------------------------
// What a screen sees
// ---------------------------------------------------------------------------

/** An account as a screen sees it. No credential, and no fragment of one. */
export interface DeviceAccountView {
    readonly id: string;
    readonly brand: string;
    readonly connection: string;
    /** What this way in is called, from the registry - so a screen never has to
     *  turn a stored id into words of its own. */
    readonly connectionLabel: string;
    readonly label: string;
    /** ok | unauthorized | unreachable. */
    readonly status: string;
    readonly statusNote: string;
    readonly lastSyncedAt: string | null;
    /** The fields the registry does not mark as secret, as they were set. An
     *  address is not a credential, and "which bridge is this pointed at" has to
     *  be answerable without disconnecting it. */
    readonly settings: Readonly<Record<string, string>>;
    readonly deviceCount: number;
}

type AccountRow = {
    id: string;
    brand: string;
    connection: string;
    label: string;
    secret: string;
    status: string;
    statusNote: string | null;
    lastSyncedAt: Date | null;
    _count?: { devices: number };
};

function toView(row: AccountRow): DeviceAccountView {
    const connection = registry.deviceConnection(row.connection);
    let settings: Record<string, string> = {};
    if (connection) {
        // A credential that cannot be read is not a reason for the row to vanish
        // off the screen: it is exactly the case somebody has to be told about,
        // and the status line is where they are told.
        const fields = readCredentials(row.secret);
        for (const field of registry.shownFields(connection)) {
            const value = fields?.[field.key];
            if (value !== undefined) settings[field.key] = value;
        }
    } else {
        settings = {};
    }
    return {
        id: row.id,
        brand: row.brand,
        connection: row.connection,
        connectionLabel: connection?.label ?? row.connection,
        label: row.label,
        status: row.status,
        statusNote: row.statusNote ?? "",
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
        settings,
        deviceCount: row._count?.devices ?? 0
    };
}

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

function sealCredentials(fields: Readonly<Record<string, string>>): string {
    const blob = encryptSecret(JSON.stringify(fields), loadEnv().POLARIS_MASTER_KEY);
    return JSON.stringify({
        c: blob.ciphertext.toString("base64"),
        n: blob.nonce.toString("base64"),
        k: blob.keyId
    });
}

/** The fields back, or null when the master key has changed under them. Nothing
 *  here can recover that, and a connection that cannot be read is a connection
 *  that has to be made again - which is a sentence for a screen, not a throw from
 *  the middle of a list. */
function readCredentials(sealed: string): Record<string, string> | null {
    try {
        const { c, n, k } = JSON.parse(sealed) as { c: string; n: string; k: string };
        const plain = decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
        const parsed = JSON.parse(plain) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "string") fields[key] = value;
        }
        return fields;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const ACCOUNT_FIELDS = {
    id: true,
    brand: true,
    connection: true,
    label: true,
    secret: true,
    status: true,
    statusNote: true,
    lastSyncedAt: true
} as const;

export async function listAccounts(installedAppId: string): Promise<DeviceAccountView[]> {
    await adoptLegacyAccount(installedAppId);
    const rows = await prisma.placeDeviceAccount.findMany({
        where: { installedAppId },
        orderBy: [{ createdAt: "asc" }],
        select: { ...ACCOUNT_FIELDS, _count: { select: { devices: true } } }
    });
    return rows.map(toView);
}

/** One account with what it is opened with, for the service that is about to use
 *  it. The only function here that returns a credential, and it is never called
 *  by anything a request reaches directly. */
export async function accountWithCredentials(
    installedAppId: string,
    id: string
): Promise<{ view: DeviceAccountView; credentials: Credentials }> {
    const row = await prisma.placeDeviceAccount.findFirst({
        where: { id, installedAppId },
        select: ACCOUNT_FIELDS
    });
    if (!row) throw new HomeError("That connection is not here");
    const credentials = readCredentials(row.secret);
    if (!credentials) throw new HomeError(`${row.label} has to be connected again`);
    return { view: toView(row), credentials };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ConnectInput {
    readonly connection: string;
    readonly label: string;
    readonly fields: Readonly<Record<string, string>>;
}

/**
 * Connect an account, having proved the credentials work first.
 *
 * Verified before it is stored rather than after: a token that is refused must
 * never become the connection, or the next screen shows a house with no doors and
 * no reason given.
 */
export async function connectAccount(
    installedAppId: string,
    input: ConnectInput
): Promise<DeviceAccountView> {
    const connection = registry.deviceConnection(input.connection);
    if (!connection || !isConnectable(input.connection)) {
        throw new HomeError("Polaris cannot connect that yet");
    }
    await speaking(() => driverFor(connection.id).verify(input.fields));
    const row = await prisma.placeDeviceAccount.create({
        data: {
            installedAppId,
            brand: connection.brand,
            connection: connection.id,
            label: input.label.trim() || connection.brand,
            secret: sealCredentials(input.fields),
            status: "ok"
        },
        select: ACCOUNT_FIELDS
    });
    return toView(row);
}

/**
 * Put a new credential on an account that already exists.
 *
 * A replacement rather than an addition: a token that was revoked is a token
 * nothing should still be trying. The devices stay where they are, with their
 * names, their places and their history, because it is the same house.
 */
export async function reconnectAccount(
    installedAppId: string,
    id: string,
    input: { readonly label: string; readonly fields: Readonly<Record<string, string>> }
): Promise<DeviceAccountView> {
    const existing = await prisma.placeDeviceAccount.findFirst({
        where: { id, installedAppId },
        select: { id: true, connection: true, label: true }
    });
    if (!existing) throw new HomeError("That connection is not here");
    const connection = registry.deviceConnection(existing.connection);
    if (!connection) throw new HomeError("Polaris cannot connect that yet");
    await speaking(() => driverFor(connection.id).verify(input.fields));
    const row = await prisma.placeDeviceAccount.update({
        where: { id: existing.id },
        data: {
            label: input.label.trim() || existing.label,
            secret: sealCredentials(input.fields),
            status: "ok",
            statusNote: null
        },
        select: ACCOUNT_FIELDS
    });
    return toView(row);
}

/**
 * Take an account away.
 *
 * Its devices go with it, and their history with them. That is the honest
 * behaviour rather than the convenient one: a row nothing can reach is a lock
 * somebody would still press, and keeping months of who-opened-what for an
 * account that has been disconnected is keeping a record of a building Polaris
 * has just been told it has no business with.
 */
export async function disconnectAccount(installedAppId: string, id: string): Promise<void> {
    const { count } = await prisma.placeDeviceAccount.deleteMany({ where: { id, installedAppId } });
    if (count === 0) throw new HomeError("That connection is not here");
}

/** How the last call went, remembered rather than acted on. A refused credential
 *  stays stored so the screen can say so and offer the one button that fixes it,
 *  instead of a house quietly losing its doors to one bad answer. */
export async function markAccount(
    id: string,
    status: string,
    note: string | null = null
): Promise<void> {
    await prisma.placeDeviceAccount.updateMany({
        where: { id },
        data: { status, statusNote: note }
    });
}

export async function markSynced(id: string): Promise<void> {
    await prisma.placeDeviceAccount.updateMany({
        where: { id },
        data: { status: "ok", statusNote: null, lastSyncedAt: new Date() }
    });
}

/** A driver's refusal, as one this app is willing to show. `DriverError` is
 *  already written for a person and names no host, path or credential, so the
 *  sentence passes through; anything else is a fault and is left alone to be
 *  logged as one. */
async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof DriverError) throw new HomeError(caught.message);
        throw caught;
    }
}

// ---------------------------------------------------------------------------
// The one that was here before
// ---------------------------------------------------------------------------

/** Where the single Nuki connection used to live. */
const LEGACY_KEYS = {
    token: "places.nuki.token",
    label: "places.nuki.label",
    syncedAt: "places.nuki.syncedAt",
    status: "places.nuki.status"
} as const;

/**
 * Move the connection that predates this table into it.
 *
 * An installed Polaris is updated from a button, not from a terminal, so nothing
 * can be asked of whoever runs it - and a house that had its locks working before
 * the update has to have them working after it, with the same token, the same
 * names and the same history. So the first read adopts what is there: the
 * credential is re-sealed in the new shape, the devices are pointed at the new
 * row, and the old settings are cleared so this never runs twice.
 *
 * Idempotent and silent. A deployment that never connected anything has nothing
 * to adopt and pays one indexed lookup for the privilege.
 */
async function adoptLegacyAccount(installedAppId: string): Promise<void> {
    const legacy = await prisma.setting.findUnique({
        where: { key: LEGACY_KEYS.token },
        select: { value: true }
    });
    if (!legacy?.value) return;

    const token = readLegacyToken(legacy.value);
    const [label, status] = await Promise.all([
        prisma.setting.findUnique({ where: { key: LEGACY_KEYS.label }, select: { value: true } }),
        prisma.setting.findUnique({ where: { key: LEGACY_KEYS.status }, select: { value: true } })
    ]);

    if (token) {
        const account = await prisma.placeDeviceAccount.create({
            data: {
                installedAppId,
                brand: "Nuki",
                connection: NUKI_WEB,
                label: label?.value?.trim() || "Nuki",
                secret: sealCredentials({ token }),
                status: status?.value === "unauthorized" ? "unauthorized" : "ok"
            },
            select: { id: true }
        });
        await prisma.placeDevice.updateMany({
            where: { installedAppId, accountId: null, vendor: "nuki" },
            data: { accountId: account.id }
        });
    }

    // Cleared whether or not the token could be read. One that cannot be
    // decrypted is one the master key has changed under, and leaving it in place
    // would mean trying to adopt it again on every single read.
    await prisma.setting.deleteMany({ where: { key: { in: Object.values(LEGACY_KEYS) } } });
}

function readLegacyToken(raw: string): string | null {
    try {
        const { c, n, k } = JSON.parse(raw) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}
