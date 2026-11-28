import { EventEmitter } from "node:events";
import type { Room } from "livekit-client";
import { describe, expect, it } from "vitest";
import * as e2ee from "@/lib/chat/call-e2ee";
import * as session from "@/app/(app)/chat/call-e2ee-session";

/** The room events the key exchange listens to, by the names the client uses. */
const RoomEvent = {
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    ParticipantAttributesChanged: "participantAttributesChanged",
    DataReceived: "dataReceived"
};
const lk = { RoomEvent } as unknown as typeof import("livekit-client");

interface Seat {
    readonly identity: string;
    readonly attributes: Record<string, string>;
    readonly room: EventEmitter & { localParticipant: unknown; remoteParticipants: Map<string, Seat> };
    /** Every key handed to this seat's cryptor, by slot. */
    readonly keys: Map<number, string>;
    /** Every key handed to the cryptor, in order: the last is the one it encrypts with. */
    readonly puts: string[];
    locks: session.CallLock[];
    stop?: () => void;
}

/** A media server in miniature: attributes and data messages between seats, nothing else. */
function network() {
    const seats = new Map<string, Seat>();
    /** Every key message the server relayed, so a test can play one again. */
    const relayed: { payload: Uint8Array; from: Seat; to: string; topic: string }[] = [];
    const settle = () => new Promise((done) => setTimeout(done, 30));

    async function join(identity: string, epoch: string | null = null): Promise<Seat> {
        const room = Object.assign(new EventEmitter(), { remoteParticipants: new Map<string, Seat>(), localParticipant: {} });
        const seat: Seat = { identity, attributes: {}, room, keys: new Map(), puts: [], locks: [] };
        room.localParticipant = {
            identity,
            async setAttributes(next: Record<string, string>) {
                Object.assign(seat.attributes, next);
                for (const other of seats.values()) if (other !== seat) other.room.emit(RoomEvent.ParticipantAttributesChanged, next, seat);
            },
            async publishData(payload: Uint8Array, options: { destinationIdentities: string[]; topic: string }) {
                for (const to of options.destinationIdentities) relayed.push({ payload, from: seat, to, topic: options.topic });
                for (const to of options.destinationIdentities) seats.get(to)?.room.emit(RoomEvent.DataReceived, payload, seat, undefined, options.topic);
            }
        };
        for (const other of seats.values()) {
            room.remoteParticipants.set(other.identity, other);
            other.room.remoteParticipants.set(identity, seat);
            other.room.emit(RoomEvent.ParticipantConnected, seat);
        }
        seats.set(identity, seat);
        const binding = { epoch: epoch ?? "", secret: new Uint8Array(32).fill(5) };
        const keys = await session.startCallKeys({
            room: room as unknown as Room,
            lk,
            provider: {
                async put(key, slot) {
                    seat.keys.set(slot, Buffer.from(key).toString("hex"));
                    seat.puts.push(Buffer.from(key).toString("hex"));
                }
            },
            roomName: "room-1",
            binding: async () => (epoch === null ? null : binding),
            onLock: (lock) => seat.locks.push(lock)
        });
        seat.stop = () => keys.stop();
        await settle();
        return seat;
    }

    async function leave(identity: string) {
        const seat = seats.get(identity);
        if (!seat) return;
        seat.stop?.();
        seats.delete(identity);
        for (const other of seats.values()) {
            other.room.remoteParticipants.delete(identity);
            other.room.emit(RoomEvent.ParticipantDisconnected, seat);
        }
        await settle();
    }

    /** The server sending a message it relayed before to its recipient again, as is or altered. */
    async function replay(entry: (typeof relayed)[number], payload: Uint8Array = entry.payload) {
        seats.get(entry.to)?.room.emit(RoomEvent.DataReceived, payload, entry.from, undefined, entry.topic);
        await settle();
    }

    return { join, leave, settle, relayed, replay };
}

/** The key each seat would encrypt with: the highest slot it was handed last. */
const current = (seat: Seat) => [...seat.keys.values()].at(-1);

describe("call key exchange", () => {
    it("gives everybody in the call one key, and a new one when somebody joins", async () => {
        const net = network();
        const a = await net.join("seat-a");
        const b = await net.join("seat-b");
        expect(current(b)).toBeDefined();
        expect(current(b)).toBe(current(a));
        const before = current(a);

        const c = await net.join("seat-c");
        expect(current(a)).not.toBe(before);
        expect(current(b)).toBe(current(a));
        expect(current(c)).toBe(current(a));
        // The newcomer never holds the key the call was under before it came.
        expect([...c.keys.values()]).not.toContain(before);
        expect(a.locks.at(-1)).toBe("on");
        expect(c.locks.at(-1)).toBe("on");
    });

    it("draws a new key when somebody leaves, which the one who left never gets", async () => {
        const net = network();
        const a = await net.join("seat-a");
        const b = await net.join("seat-b");
        const c = await net.join("seat-c");
        const held = new Set(c.keys.values());
        await net.leave("seat-c");
        expect(current(a)).toBe(current(b));
        expect(held.has(current(a)!)).toBe(false);
    });

    it("hands over to the next leader when the leader leaves", async () => {
        const net = network();
        await net.join("seat-a");
        const b = await net.join("seat-b");
        const c = await net.join("seat-c");
        const before = current(b);
        await net.leave("seat-a");
        expect(current(b)).not.toBe(before);
        expect(current(c)).toBe(current(b));
    });

    it("says the call is bound to the conversation's keys only when everybody shares its epoch", async () => {
        const net = network();
        const a = await net.join("seat-a", "4");
        const b = await net.join("seat-b", "4");
        expect(a.locks.at(-1)).toBe("bound");
        expect(b.locks.at(-1)).toBe("bound");
        const guest = await net.join("seat-g", null);
        expect(guest.locks.at(-1)).toBe("on");
        expect(a.locks.at(-1)).toBe("on");
        expect(current(guest)).toBe(current(a));
        expect(current(b)).toBe(current(a));
    });

    it("refuses a key message the server plays again, so nobody is put back on a key somebody who left holds", async () => {
        const net = network();
        const a = await net.join("seat-a");
        const b = await net.join("seat-b");
        const c = await net.join("seat-c");
        const departedHeld = new Set(c.keys.values());
        const old = net.relayed.filter((entry) => entry.to === "seat-b");
        expect(old.length).toBeGreaterThan(0);
        await net.leave("seat-c");
        const now = b.puts.at(-1)!;
        expect(departedHeld.has(now)).toBe(false);
        for (const entry of old) await net.replay(entry);
        // The cryptor encrypts with the last key it was handed: still the newest.
        expect(b.puts.at(-1)).toBe(now);
        expect(b.puts.at(-1)).toBe(a.puts.at(-1));
    });

    it("refuses a key wrapped with a public key the leader never announced", async () => {
        const net = network();
        await net.join("seat-a");
        const b = await net.join("seat-b");
        const entry = net.relayed.find((e) => e.to === "seat-b")!;
        // A message that opens, from a key pair swapped in by whoever relays it.
        const swapped = await e2ee.makeCallKeyPair();
        const bPub = JSON.parse(b.attributes[e2ee.CALL_KEY_ATTRIBUTE]).pub;
        const forged = await e2ee.wrapCallKey(e2ee.makeCallKey(), swapped.pair, swapped.pub, bPub, {
            room: "room-1",
            gen: 50,
            leader: "seat-a",
            to: "seat-b",
            bind: null
        });
        const before = b.puts.length;
        await net.replay(entry, new TextEncoder().encode(JSON.stringify(forged)));
        expect(b.puts.length).toBe(before);
    });

    it("takes a leader who left and came back, counting from 1 again under a new key pair", async () => {
        const net = network();
        await net.join("seat-a");
        const b = await net.join("seat-b");
        await net.leave("seat-a");
        const a = await net.join("seat-a");
        expect(b.puts.at(-1)).toBe(a.puts.at(-1));
    });

    it("reads a key message that came before its sender's announcement once the announcement arrives", async () => {
        const net = network();
        await net.join("seat-a");
        const b = await net.join("seat-b");
        const entry = net.relayed.find((e) => e.to === "seat-b")!;
        // The leader's announcement is not there yet when its next message lands.
        const said = entry.from.attributes[e2ee.CALL_KEY_ATTRIBUTE];
        delete entry.from.attributes[e2ee.CALL_KEY_ATTRIBUTE];
        const message = JSON.parse(new TextDecoder().decode(entry.payload));
        const pair = await e2ee.makeCallKeyPair();
        const bPub = JSON.parse(b.attributes[e2ee.CALL_KEY_ATTRIBUTE]).pub;
        const key = e2ee.makeCallKey();
        const next = await e2ee.wrapCallKey(key, pair.pair, pair.pub, bPub, {
            room: "room-1",
            gen: message.gen + 1,
            leader: "seat-a",
            to: "seat-b",
            bind: null
        });
        await net.replay(entry, new TextEncoder().encode(JSON.stringify(next)));
        expect(b.puts.at(-1)).not.toBe(Buffer.from(key).toString("hex"));
        // Then it arrives (here with the key pair that message was wrapped with).
        expect(said).toBeDefined();
        entry.from.attributes[e2ee.CALL_KEY_ATTRIBUTE] = JSON.stringify({ v: 1, pub: pair.pub, epoch: null });
        b.room.emit("participantAttributesChanged", {}, entry.from);
        await net.settle();
        expect(b.puts.at(-1)).toBe(Buffer.from(key).toString("hex"));
    });
});
