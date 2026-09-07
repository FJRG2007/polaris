/**
 * Nuki over a broker on the same network.
 *
 * The second way into the same locks, and the one their newer hardware actually
 * has. A Smart Lock Pro or Ultra has wifi of its own and no local HTTP API at
 * all: what it will do is publish itself to an MQTT broker on its own LAN and
 * take commands back the same way. That is what the Nuki app calls the MQTT
 * integration, and it is the transport every other smart-home system reaches
 * these locks through.
 *
 * It is worth having beside the web account rather than instead of it. It does
 * not leave the building, it answers in milliseconds rather than in a round trip
 * to Graz, it costs the lock no radio to be read - every state is retained on the
 * broker, so reading is free and current at once - and it keeps working when
 * somebody else's servers do not. What it cannot do is reach a lock from another
 * country, which is exactly what the web account is for.
 *
 * What this file holds is their topic vocabulary and nothing else; connecting,
 * reading what is retained and publishing are `mqtt-broker`, shared with every
 * other make reached the same way.
 *
 * Server-only, and unencrypted by design: the locks have no room for TLS and will
 * only ever talk to a broker on their own LAN. That is Nuki's constraint, said
 * out loud on the screen that asks for the address rather than hidden here.
 */

import { publish, readRetained, type BrokerAddress } from "@/lib/integrations/mqtt-broker";

export { BrokerError as NukiMqttError } from "@/lib/integrations/mqtt-broker";

/** Where the locks publish, and what it takes to be let in. */
export interface NukiBroker extends BrokerAddress {
    /** What the locks publish under. Nuki's own default is "nuki", and anybody
     *  who changed it knows they did. */
    readonly prefix: string;
}

/** Everything one device published, by topic - the last segment only, which is
 *  the name Nuki's own documentation uses. */
export type DeviceTopics = Readonly<Record<string, string>>;

/** What a broker was holding, by the device id Nuki prints on the device. */
export type BrokerContents = ReadonlyMap<string, DeviceTopics>;

/**
 * Everything the broker is holding about every Nuki on it.
 *
 * One subscription to the whole prefix rather than one per device: what is here
 * is what the broker has, and asking it device by device would need a list of
 * devices this has no other way of getting.
 */
export async function readBroker(broker: NukiBroker): Promise<BrokerContents> {
    const held = await readRetained(broker, [`${broker.prefix}/+/#`]);
    const devices = new Map<string, Record<string, string>>();
    for (const [topic, payload] of held) {
        const parts = topic.split("/");
        // <prefix>/<device id>/<topic>, and nothing shorter is one of theirs.
        // Deeper ones are joined back up: their own topics are one segment, and
        // anything else is somebody else's device on the same prefix rather than
        // a message to misread.
        if (parts.length < 3) continue;
        const [, id, ...rest] = parts;
        if (!id) continue;
        const device = devices.get(id) ?? {};
        device[rest.join("/")] = payload;
        devices.set(id, device);
    }
    return devices;
}

/**
 * Tell one lock to do one thing.
 *
 * At the quality of service Nuki's own documentation asks for, and with an expiry
 * on it: a command that could not be delivered while the lock was asleep is a
 * command that must not open a door ten minutes later, when whoever sent it has
 * gone. Their firmware asks publishers for ten seconds, and that is what this
 * sets.
 */
export async function sendAction(broker: NukiBroker, deviceId: string, action: number): Promise<void> {
    await publish(broker, `${broker.prefix}/${deviceId}/lockAction`, String(action), {
        qos: 2,
        expirySeconds: 10
    });
}
