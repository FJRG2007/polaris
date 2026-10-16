/**
 * The broker Polaris runs on this network for devices that publish their own
 * changes, and linking a Nuki account to it.
 *
 * This is what makes a Nuki Smart Lock instant. Their newer locks (3.0 Pro, 4th
 * generation, Pro, Ultra) can publish every change to an MQTT broker on their own
 * LAN, on port 1883 only and unencrypted; the account's cloud only hears about a
 * change when it is asked. So Polaris runs the broker (an internal app, installed
 * on this machine the first time somebody asks for it - never by default), hands
 * the person what to type into the Nuki app, and links the existing Nuki Web
 * account to it. The same devices are then read and moved over the broker
 * (`drivers/nuki-web.ts`), matched by the Nuki ID inside their Web id, so
 * nothing is added twice and the cloud keeps working from anywhere else.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { HomeError } from "./home-error";
import { findService } from "./side-service";
import * as accounts from "./device-accounts";
import { readBroker } from "./integrations/nuki-mqtt";
import { NUKI_WEB, localBrokerOf, nukiIdOf } from "./drivers/nuki-web";

const { installApp } = host.appsInstallService;
const { installEnvSecret, installEnvValue } = host.appsInstallSecret;
const { getHostLanIp } = host.hostAddress;

export const BROKER_APP = "mqtt-broker";
/** The only port a Nuki lock dials; its app has no field for another. */
export const BROKER_PORT = 1883;
const LOCAL_SERVER = "local";

/** What somebody types into the Nuki app, and what Polaris connects with. */
export interface LocalBroker {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
}

/** The broker on this machine, or null while there is none (or it has no
 *  address on the LAN yet). */
export async function localBroker(): Promise<LocalBroker | null> {
    const service = await findService(BROKER_APP, LOCAL_SERVER);
    if (!service) return null;
    const [username, password, lan] = await Promise.all([
        installEnvValue(service.applicationId, service.ownerId, "BROKER_USERNAME", "polaris"),
        installEnvSecret(service.applicationId, service.ownerId, "BROKER_PASSWORD"),
        getHostLanIp().catch(() => null)
    ]);
    if (!password || !lan) return null;
    return { host: lan, port: BROKER_PORT, username, password };
}

/** The broker, installed on this machine if this is the first time. A deploy,
 *  so slow once and instant after. Only ever called from somebody's press. */
export async function ensureLocalBroker(ownerId: string, actorId: string): Promise<LocalBroker> {
    const existing = await localBroker();
    if (existing) return existing;
    await installApp(ownerId, actorId, {
        catalogId: BROKER_APP,
        name: "Local device broker",
        serverId: LOCAL_SERVER,
        storage: [],
        env: []
    });
    const broker = await localBroker();
    if (!broker)
        throw new HomeError(
            "The local broker was installed but has no address on this network yet"
        );
    return broker;
}

/** Link a Nuki Web account to the broker, so its locks are heard on it. */
export async function linkNukiAccount(
    installedAppId: string,
    accountId: string,
    broker: LocalBroker
): Promise<void> {
    const { view } = await accounts.accountWithCredentials(installedAppId, accountId);
    if (view.connection !== NUKI_WEB)
        throw new HomeError("Only a Nuki account can be linked locally");
    await accounts.linkLocal(installedAppId, accountId, {
        localHost: broker.host,
        localPort: String(broker.port),
        localUsername: broker.username,
        localPassword: broker.password
    });
}

/** Where an account's local link stands: not linked, or linked with which of
 *  its devices are on the broker right now. */
export interface LocalLinkState {
    readonly linked: boolean;
    readonly broker: LocalBroker | null;
    /** The account's devices, by Polaris id, and whether each is on the broker. */
    readonly devices: readonly {
        readonly id: string;
        readonly name: string;
        readonly nukiId: string;
        readonly connected: boolean;
    }[];
    /** False when the broker could not be read just now. */
    readonly reachable: boolean;
}

export async function localLinkState(
    installedAppId: string,
    accountId: string
): Promise<LocalLinkState> {
    const { credentials } = await accounts.accountWithCredentials(installedAppId, accountId);
    const linked = localBrokerOf(credentials);
    const rows = await prisma.placeDevice.findMany({
        where: { installedAppId, accountId },
        select: { id: true, name: true, externalId: true },
        orderBy: { name: "asc" },
        take: 200
    });
    const broker = linked
        ? {
              host: linked.host,
              port: linked.port,
              username: linked.username,
              password: linked.password
          }
        : null;
    let held = new Map<string, Readonly<Record<string, string>>>();
    let reachable = true;
    if (linked) {
        try {
            held = new Map(
                [...(await readBroker(linked))].map(([id, topics]) => [id.toUpperCase(), topics])
            );
        } catch {
            reachable = false;
        }
    }
    return {
        linked: Boolean(linked),
        broker,
        reachable,
        devices: rows.flatMap((row) => {
            if (!/^\d+$/.test(row.externalId)) return [];
            const nukiId = nukiIdOf(row.externalId);
            const topics = held.get(nukiId);
            // Their last will sets `connected` to false when the lock drops off.
            const connected = Boolean(topics) && topics?.connected !== "false";
            return [{ id: row.id, name: row.name, nukiId, connected }];
        })
    };
}
