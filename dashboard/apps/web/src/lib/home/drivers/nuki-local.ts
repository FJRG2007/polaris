/**
 * Nuki over a broker on the same network, as devices.
 *
 * The translation half of the local transport: what the broker is holding turned
 * into rows, and an action turned into the number their firmware expects. Their
 * numbering is in `nuki-vocabulary`, shared with the web driver, because it is
 * the same firmware answering either way.
 *
 * A lock that is not connected to the broker right now says so. Its retained
 * state is still there - the broker keeps the last thing it heard forever - and
 * showing that as live is exactly the mistake this whole app is careful about
 * elsewhere: what a door was doing an hour ago is not what it is doing.
 *
 * Server-only.
 */

import { HomeError } from "@/lib/home/home-error";
import * as mqtt from "@/lib/integrations/nuki-mqtt";
import * as nuki from "@/lib/home/drivers/nuki-vocabulary";
import {
    DriverError,
    type Credentials,
    type DeviceDriver,
    type DeviceSnapshot
} from "@/lib/home/drivers/contract";

export const NUKI_LOCAL = "nuki-local";

/** Nuki's own default port, which is the only one their firmware will use. Kept
 *  as a field anyway: a broker behind a forwarder is somebody's real setup. */
export const DEFAULT_BROKER_PORT = 1883;

function brokerOf(credentials: Credentials): mqtt.NukiBroker {
    const host = credentials.host?.trim();
    if (!host) throw new HomeError("That connection is missing the broker's address");
    const port = Number(credentials.port || DEFAULT_BROKER_PORT);
    return {
        host,
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_BROKER_PORT,
        username: credentials.username ?? "",
        password: credentials.password ?? "",
        prefix: credentials.prefix?.trim() || "nuki"
    };
}

async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof mqtt.NukiMqttError) throw new DriverError(caught.message, caught.kind);
        throw caught;
    }
}

function whole(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Their booleans arrive as the words rather than as numbers. */
function flag(value: string | undefined): boolean {
    return value === "true" || value === "1";
}

/** One device's topics, as a row. Null for anything on the prefix that is not a
 *  Nuki device with a type - a broker is shared, and something else publishing
 *  under the same prefix is not ours to draw. */
function toSnapshot(id: string, topics: mqtt.DeviceTopics): DeviceSnapshot | null {
    const type = whole(topics.deviceType);
    if (type === undefined) return null;
    const kind = nuki.nukiKind(type);
    if (!kind) return null;

    const state = whole(topics.state);
    const battery = whole(topics.batteryChargeState);
    // Their last will message: the broker sets this to false itself when a device
    // stops talking to it, which is what makes a flat lock visible rather than
    // frozen at whatever it last said.
    const connected = topics.connected === undefined ? true : flag(topics.connected);

    return {
        externalId: id,
        kind,
        name: topics.name?.trim() || "Nuki device",
        model: nuki.nukiModel(type),
        firmware: topics.firmware?.trim() || null,
        state: connected
            ? kind === "opener"
                ? nuki.nukiOpenerState(state)
                : nuki.nukiLockState(state)
            : "unknown",
        doorState: nuki.nukiDoorState(whole(topics.doorsensorState)),
        batteryPercent: battery ?? null,
        batteryCritical: flag(topics.batteryCritical),
        online: connected
    };
}

export const nukiLocalDriver: DeviceDriver = {
    connection: NUKI_LOCAL,

    /**
     * Whether the broker is there, lets Polaris in, and has a Nuki on it.
     *
     * All three, because they are three different mistakes with one symptom. A
     * broker that is not there and one that refuses the password are told apart
     * by the client; a broker that answers perfectly and holds nothing is the
     * common one - the address is right and the lock was never pointed at it, or
     * was pointed at it under a different prefix - and connecting to that would
     * leave somebody with an empty screen and no reason given.
     */
    async verify(credentials) {
        const broker = brokerOf(credentials);
        const contents = await speaking(() => mqtt.readBroker(broker));
        const found = [...contents].some(([id, topics]) => toSnapshot(id, topics) !== null);
        if (!found) {
            throw new DriverError(
                `Nothing on that broker is publishing as a Nuki device under "${broker.prefix}". Check that MQTT is switched on in the Nuki app and pointed at this broker.`,
                "refused"
            );
        }
    },

    async list(credentials) {
        const contents = await speaking(() => mqtt.readBroker(brokerOf(credentials)));
        const snapshots: DeviceSnapshot[] = [];
        for (const [id, topics] of contents) {
            const snapshot = toSnapshot(id, topics);
            if (snapshot) snapshots.push(snapshot);
        }
        return snapshots;
    },

    async act(credentials, device, action) {
        const code =
            action === "lock"
                ? nuki.NUKI_ACTION_CODES.lock
                : action === "unlock"
                  ? nuki.NUKI_ACTION_CODES.unlock
                  : action === "unlatch"
                    ? nuki.NUKI_ACTION_CODES.unlatch
                    : null;
        if (code === null) throw new HomeError("A Nuki device cannot be told to do that");
        await speaking(() => mqtt.sendAction(brokerOf(credentials), device.externalId, code));
    }
};
