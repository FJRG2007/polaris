/**
 * Home Assistant's changes, heard over its WebSocket API.
 *
 * Against a real WebSocket server speaking the documented handshake
 * (developers.home-assistant.io/docs/api/websocket): the token is sent only
 * once asked for, `state_changed` is subscribed to, each changed entity is
 * handed on - except a sensor whose state did not move - and a refused token
 * is the same refusal the REST calls give.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

// The server listens on loopback, which a device connection never dials; only
// that literal is let through here.
vi.mock("@polaris-app/places/src/lib/integrations/lan-address", async (original) => {
    const actual =
        await original<typeof import("@polaris-app/places/src/lib/integrations/lan-address")>();
    return {
        ...actual,
        forbiddenAddress: (value: string) => value !== "127.0.0.1" && actual.forbiddenAddress(value)
    };
});

const ha = await import("@polaris-app/places/src/lib/integrations/home-assistant-api");

let server: WebSocketServer | null = null;

afterEach(async () => {
    server?.close();
    server = null;
});

/** A Home Assistant that runs `script` once a client has signed in. */
async function homeAssistant(
    script: (socket: WebSocket, said: unknown[]) => void,
    token = "good-token"
) {
    const said: unknown[] = [];
    server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/api/websocket" });
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.0" }));
        socket.on("message", (data) => {
            const message = JSON.parse(String(data)) as Record<string, unknown>;
            said.push(message);
            if (message.type === "auth") {
                socket.send(
                    JSON.stringify(
                        message.access_token === token
                            ? { type: "auth_ok" }
                            : { type: "auth_invalid", message: "Invalid access token" }
                    )
                );
            } else if (message.type === "subscribe_events") {
                socket.send(JSON.stringify({ id: message.id, type: "result", success: true }));
                script(socket, said);
            }
        });
    });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    return { home: { origin: `http://127.0.0.1:${port}`, token: "good-token" }, said };
}

function stateChanged(entityId: string, before: string | null, after: string | null) {
    return JSON.stringify({
        id: 1,
        type: "event",
        event: {
            event_type: "state_changed",
            data: {
                entity_id: entityId,
                old_state: before === null ? null : { entity_id: entityId, state: before },
                new_state: after === null ? null : { entity_id: entityId, state: after }
            }
        }
    });
}

describe("listening to Home Assistant", () => {
    it("signs in when asked, subscribes, and hands on each change until it closes", async () => {
        const { home, said } = await homeAssistant((socket) => {
            socket.send(stateChanged("lock.front_door", "locked", "unlocked"));
            socket.send(stateChanged("climate.living_room", "cool", "cool"));
            socket.send(stateChanged("sensor.power", "120", "120"));
            socket.send(stateChanged("binary_sensor.door", "off", "on"));
            setTimeout(() => socket.close(), 50);
        });
        const changed: string[] = [];
        await ha.listenHomeAssistant(home, (id) => changed.push(id), new AbortController().signal);
        expect(said[0]).toEqual({ type: "auth", access_token: "good-token" });
        expect(said[1]).toEqual({ id: 1, type: "subscribe_events", event_type: "state_changed" });
        // A climate's settings are its attributes, so any change to it is news;
        // a sensor that reports the same value again is not.
        expect(changed).toEqual(["lock.front_door", "climate.living_room", "binary_sensor.door"]);
    });

    it("refuses a token Home Assistant does not take, as the REST calls do", async () => {
        const { home } = await homeAssistant(() => undefined, "another-token");
        await expect(
            ha.listenHomeAssistant(home, () => undefined, new AbortController().signal)
        ).rejects.toMatchObject({ kind: "unauthorized" });
    });

    it("stops when it is let go", async () => {
        const { home } = await homeAssistant(() => undefined);
        const controller = new AbortController();
        const listening = ha.listenHomeAssistant(home, () => undefined, controller.signal);
        await vi.waitFor(() => expect(server?.clients.size).toBe(1));
        controller.abort();
        await expect(listening).resolves.toBeUndefined();
    });

    it("never dials an address no device is at", async () => {
        await expect(
            ha.listenHomeAssistant(
                { origin: "http://169.254.169.254:8123", token: "good-token" },
                () => undefined,
                new AbortController().signal
            )
        ).rejects.toMatchObject({ kind: "refused" });
    });
});
