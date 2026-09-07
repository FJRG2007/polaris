/**
 * Reading and writing an MQTT broker, without holding a subscription open.
 *
 * Everything a device publishes about itself is retained: the broker keeps the
 * last message on each topic and hands the set to any client that subscribes. So
 * a client that connects, subscribes, waits for the flood to stop and disconnects
 * has exactly what a permanent subscriber would have had, without a long-lived
 * socket inside a web server that is not built to hold one.
 *
 * What that costs is the stream. Nobody is listening between reads, so an event
 * that is published and not retained - a button press, a lock's own record of who
 * opened it - is not seen. Every state is, which is what a screen showing what
 * things are doing actually needs.
 *
 * Shared by every make reached this way: Nuki's own MQTT support and the
 * discovery convention that Zigbee2MQTT, Tasmota, ESPHome and the rest publish
 * under are the same two operations against the same broker.
 *
 * Server-only.
 */

import mqtt from "mqtt";

/** Where a broker is, and what it takes to be let in. */
export interface BrokerAddress {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
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
const READ_MS = 5000;

export class BrokerError extends Error {
    readonly kind: "unauthorized" | "unreachable" | "refused";

    constructor(message: string, kind: BrokerError["kind"]) {
        super(message);
        this.name = "BrokerError";
        this.kind = kind;
    }
}

/**
 * Their refusal, as one worth showing.
 *
 * The three that matter are told apart: a broker that refused the credentials has
 * to stop the connection and ask for new ones, and a broker that is not there
 * must leave everything exactly where it was. Their client reports the first as a
 * connack return code and the second as a socket error, and reading one as the
 * other is how a network blip disconnects somebody's front door.
 */
function refusal(error: Error & { code?: number | string }): BrokerError {
    const code = error.code;
    // 4 is bad username or password, 5 is not authorised. Both mean the broker
    // heard us and said no.
    if (code === 4 || code === 5) {
        return new BrokerError("The broker refused those credentials.", "unauthorized");
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        return new BrokerError("That address could not be found on this network.", "unreachable");
    }
    if (code === "ECONNREFUSED") {
        return new BrokerError("Nothing answered on that address and port.", "unreachable");
    }
    return new BrokerError("The broker could not be reached.", "unreachable");
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
 * Everything the broker is holding under one or more filters, as topic to
 * payload.
 *
 * Flat rather than shaped: what a topic means is the caller's business, and two
 * makes reached this way carve it up completely differently.
 */
export async function readRetained(
    broker: BrokerAddress,
    filters: readonly string[]
): Promise<Map<string, string>> {
    const client = await connect(broker);
    const held = new Map<string, string>();

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
                held.set(topic, payload.toString("utf8"));
                if (quiet) clearTimeout(quiet);
                quiet = setTimeout(() => finish(), QUIET_MS);
            });

            client.subscribe([...filters], { qos: 0 }, (error) => {
                if (!error) return;
                clearTimeout(ceiling);
                reject(new BrokerError("The broker would not let Polaris read that.", "refused"));
            });
        });
    } finally {
        client.end(true);
    }

    return held;
}

/**
 * Say one thing on one topic.
 *
 * `expiry` is what stops a command being delivered long after it was meant. A
 * command that could not reach a lock while it was asleep must not open a door
 * ten minutes later, when whoever pressed it has gone.
 */
export async function publish(
    broker: BrokerAddress,
    topic: string,
    payload: string,
    options: { qos?: 0 | 1 | 2; retain?: boolean; expirySeconds?: number } = {}
): Promise<void> {
    const client = await connect(broker);
    try {
        await new Promise<void>((resolve, reject) => {
            client.publish(
                topic,
                payload,
                {
                    qos: options.qos ?? 1,
                    retain: options.retain === true,
                    ...(options.expirySeconds
                        ? { properties: { messageExpiryInterval: options.expirySeconds } }
                        : {})
                },
                (error) => {
                    if (error) {
                        reject(new BrokerError("The broker would not take that command.", "refused"));
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
