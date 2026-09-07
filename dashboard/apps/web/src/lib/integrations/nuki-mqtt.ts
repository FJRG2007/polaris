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
 * Read the way everything else here is read, rather than by holding a
 * subscription open. Every state topic is published retained, so a client that
 * connects, subscribes and waits a moment is handed the current value of all of
 * them - which is the same answer a permanent connection would have, without a
 * long-lived socket in a web server. What that costs is the event stream: a lock
 * announces each action as it happens, and nobody is listening between reads. The
 * history of what Polaris itself did is written down where the driver has no log
 * to read, and what happened at the door in between is what the web account is
 * for.
 *
 * Server-only, and unencrypted by design: the locks have no room for TLS and will
 * only ever talk to a broker on their own LAN. That is Nuki's constraint, said
 * out loud on the screen that asks for the address rather than hidden here.
 */

import mqtt from "mqtt";

/** Where a broker is, and what it takes to be let in. */
export interface BrokerAddress {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
    /** What the locks publish under. Nuki's own default is "nuki", and anybody
     *  who changed it knows they did. */
    readonly prefix: string;
}

/** How long to wait for a connection before giving up on it. A broker on the
 *  same network answers in milliseconds; anything that has not by now is not
 *  there, and a screen waiting on it should be told so rather than left. */
const CONNECT_MS = 6000;

/** How long to keep listening once the retained messages start arriving, and the
 *  ceiling on the whole read. A broker hands over everything it has held for a
 *  new subscriber at once, so the first quiet moment is the end of it - the
 *  ceiling is only there for a broker that never goes quiet. */
const QUIET_MS = 400;
const READ_MS = 4000;

export class NukiMqttError extends Error {
    readonly kind: "unauthorized" | "unreachable" | "refused";

    constructor(message: string, kind: NukiMqttError["kind"]) {
        super(message);
        this.name = "NukiMqttError";
        this.kind = kind;
    }
}

/** Everything one device published, by topic - the last segment only, which is
 *  the name Nuki's own documentation uses. */
export type DeviceTopics = Readonly<Record<string, string>>;

/** What a broker was holding, by the device id Nuki prints on the device. */
export type BrokerContents = ReadonlyMap<string, DeviceTopics>;

/**
 * Their refusal, as one worth showing.
 *
 * The three that matter are told apart: a broker that refused the credentials has
 * to stop the connection and ask for new ones, and a broker that is not there
 * must leave everything exactly where it was. Their client reports the first as a
 * connack return code and the second as a socket error, and reading one as the
 * other is how a network blip disconnects somebody's front door.
 */
function refusal(error: Error & { code?: number | string }): NukiMqttError {
    const code = error.code;
    // 4 is bad username or password, 5 is not authorised. Both mean the broker
    // heard us and said no.
    if (code === 4 || code === 5) {
        return new NukiMqttError("The broker refused those credentials.", "unauthorized");
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        return new NukiMqttError("That address could not be found on this network.", "unreachable");
    }
    if (code === "ECONNREFUSED") {
        return new NukiMqttError("Nothing answered on that address and port.", "unreachable");
    }
    return new NukiMqttError("The broker could not be reached.", "unreachable");
}

async function connect(broker: BrokerAddress): Promise<mqtt.MqttClient> {
    const client = mqtt.connect({
        host: broker.host,
        port: broker.port,
        protocol: "mqtt",
        username: broker.username || undefined,
        password: broker.password || undefined,
        // A client id of our own, so two Polaris reads never take each other's
        // session off the broker - which is what a shared id does, silently.
        clientId: `polaris-${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: CONNECT_MS,
        // Nothing here holds a subscription, so nothing here needs the broker to
        // remember it.
        resubscribe: false
    });

    return new Promise((resolve, reject) => {
        const settle = (run: () => void) => {
            client.removeAllListeners("connect");
            client.removeAllListeners("error");
            run();
        };
        client.once("connect", () => settle(() => resolve(client)));
        client.once("error", (error: Error) =>
            settle(() => {
                client.end(true);
                reject(refusal(error));
            })
        );
    });
}

/**
 * Everything the broker is holding about every Nuki on it.
 *
 * One subscription to the whole prefix rather than one per device: what is here
 * is what the broker has, and asking it device by device would need a list of
 * devices this has no other way of getting.
 */
export async function readBroker(broker: BrokerAddress): Promise<BrokerContents> {
    const client = await connect(broker);
    const devices = new Map<string, Record<string, string>>();

    try {
        await new Promise<void>((resolve, reject) => {
            let quiet: NodeJS.Timeout | null = null;
            const ceiling = setTimeout(() => finish(), READ_MS);

            function finish(): void {
                if (quiet) clearTimeout(quiet);
                clearTimeout(ceiling);
                resolve();
            }

            client.on("message", (topic: string, payload: Buffer) => {
                const parts = topic.split("/");
                // <prefix>/<device id>/<topic>, and nothing shorter is one of
                // theirs. Deeper ones are joined back up: their own topics are
                // one segment, and anything else is somebody else's device on
                // the same prefix rather than a message to misread.
                if (parts.length < 3) return;
                const [, id, ...rest] = parts;
                if (!id) return;
                const held = devices.get(id) ?? {};
                held[rest.join("/")] = payload.toString("utf8");
                devices.set(id, held);

                if (quiet) clearTimeout(quiet);
                quiet = setTimeout(() => finish(), QUIET_MS);
            });

            client.subscribe(`${broker.prefix}/+/#`, { qos: 0 }, (error) => {
                if (!error) return;
                clearTimeout(ceiling);
                reject(new NukiMqttError("The broker would not let Polaris read that.", "refused"));
            });
        });
    } finally {
        client.end(true);
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
export async function sendAction(broker: BrokerAddress, deviceId: string, action: number): Promise<void> {
    const client = await connect(broker);
    try {
        await new Promise<void>((resolve, reject) => {
            client.publish(
                `${broker.prefix}/${deviceId}/lockAction`,
                String(action),
                { qos: 2, retain: false, properties: { messageExpiryInterval: 10 } },
                (error) => {
                    if (error) {
                        reject(new NukiMqttError("The broker would not take that command.", "refused"));
                        return;
                    }
                    resolve();
                }
            );
        });
    } finally {
        client.end(true);
    }
}
