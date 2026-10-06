/**
 * The one subscription held open on a broker, and Nuki's use of it.
 *
 * Against a fake client: what the broker was holding when the subscription
 * started is skipped (a read already has it), what is published afterwards is
 * handed on, the subscription ends when the broker closes or it is let go, and
 * a refused subscription is a refusal. Nuki's topics are read for the device id
 * in them.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeClient extends EventEmitter {
    subscribed: string[] = [];
    ended = false;
    refuse = false;
    subscribe(filters: string[], _options: unknown, done: (error: Error | null) => void) {
        this.subscribed.push(...filters);
        queueMicrotask(() => done(this.refuse ? new Error("not authorised") : null));
    }
    end() {
        this.ended = true;
    }
}

let client = new FakeClient();

vi.mock("mqtt", () => ({
    default: {
        connect: () => {
            queueMicrotask(() => client.emit("connect"));
            return client;
        }
    }
}));

const broker = await import("@polaris-app/places/src/lib/integrations/mqtt-broker");
const nuki = await import("@polaris-app/places/src/lib/integrations/nuki-mqtt");

const ADDRESS = { host: "10.0.1.20", port: 1883, username: "", password: "" };

beforeEach(() => {
    client = new FakeClient();
});

describe("watching a broker", () => {
    it("hands on what is published from now on, not what the broker was holding", async () => {
        const heard: string[] = [];
        const watching = broker.watchTopics(
            ADDRESS,
            ["zigbee2mqtt/Kettle"],
            (topic) => heard.push(topic),
            new AbortController().signal
        );
        await vi.waitFor(() => expect(client.subscribed).toEqual(["zigbee2mqtt/Kettle"]));
        client.emit("message", "zigbee2mqtt/Kettle", Buffer.from("{}"), { retain: true });
        client.emit("message", "zigbee2mqtt/Kettle", Buffer.from("{}"), { retain: false });
        client.emit("close");
        await watching;
        expect(heard).toEqual(["zigbee2mqtt/Kettle"]);
        expect(client.ended).toBe(true);
    });

    it("ends when it is let go", async () => {
        const controller = new AbortController();
        const watching = broker.watchTopics(ADDRESS, ["a"], () => undefined, controller.signal);
        await vi.waitFor(() => expect(client.subscribed).toEqual(["a"]));
        controller.abort();
        await expect(watching).resolves.toBeUndefined();
        expect(client.ended).toBe(true);
    });

    it("refuses when the broker will not let it subscribe", async () => {
        client.refuse = true;
        await expect(
            broker.watchTopics(ADDRESS, ["a"], () => undefined, new AbortController().signal)
        ).rejects.toMatchObject({ kind: "refused" });
    });
});

describe("watching the Nuki locks", () => {
    it("subscribes under the prefix and names the device of each topic", async () => {
        const changed: string[] = [];
        const watching = nuki.watchBroker(
            { ...ADDRESS, prefix: "nuki" },
            (id) => changed.push(id),
            new AbortController().signal
        );
        await vi.waitFor(() => expect(client.subscribed).toEqual(["nuki/+/#"]));
        client.emit("message", "nuki/2BB28570/state", Buffer.from("1"), { retain: false });
        client.emit("message", "nuki/2BB28570/doorsensorState", Buffer.from("2"), {});
        client.emit("close");
        await watching;
        expect(changed).toEqual(["2BB28570", "2BB28570"]);
    });
});
