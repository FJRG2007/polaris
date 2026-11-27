"use client";

/**
 * The browser half of call encryption: holds this browser's per-call key pair,
 * hands out a new call key whenever the call's membership changes (when this
 * browser is the leader), and opens the ones handed to it. The rule and the
 * cryptography are in `lib/chat/call-e2ee`; the frames are encrypted by the call
 * client's own worker once a key is set here.
 */

import * as e2ee from "@/lib/chat/call-e2ee";
import type { Participant, Room } from "livekit-client";

type LiveKit = typeof import("livekit-client");

/** What the call shows about its encryption. */
export type CallLock =
    /** Not end-to-end encrypted: a stage. */
    | "off"
    /** Encrypted, waiting for this browser's key. */
    | "pending"
    /** Encrypted with a key exchanged between the participants. */
    | "on"
    /** Encrypted, and the exchange is bound to the conversation's own MLS keys. */
    | "bound";

export type CallBinding = { readonly epoch: string; readonly secret: Uint8Array } | null;

/** The frame cryptor's key provider: one shared key per generation, set into its slot. */
export interface CallKeyProvider {
    put(key: Uint8Array<ArrayBuffer>, slot: number): Promise<void>;
}

/**
 * A shared-key provider that is handed raw keys by slot. LiveKit's own
 * `ExternalE2EEKeyProvider` only ever sets slot 0, and a key changing in place
 * leaves a frame encrypted a moment earlier undecryptable; a slot per generation
 * lets the cryptor open either while the change goes round.
 */
export function makeKeyProvider(lk: LiveKit): InstanceType<LiveKit["BaseKeyProvider"]> & CallKeyProvider {
    class SlotKeyProvider extends lk.BaseKeyProvider {
        constructor() {
            // A wrong key is never "invalid": it is a frame from a generation
            // this browser has not been handed yet, and the next one opens.
            super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: e2ee.CALL_KEYRING_SIZE });
        }
        async put(key: Uint8Array<ArrayBuffer>, slot: number): Promise<void> {
            const material = await lk.createKeyMaterialFromBuffer(key.buffer);
            this.onSetEncryptionKey(material, undefined, slot);
        }
    }
    return new SlotKeyProvider();
}

export interface CallKeysOptions {
    readonly room: Room;
    readonly lk: LiveKit;
    readonly provider: CallKeyProvider;
    /** The room's name, which every wrap is bound to. */
    readonly roomName: string;
    /** The conversation's MLS exporter secret for this room, or null without a group. */
    readonly binding: () => Promise<CallBinding>;
    readonly onLock: (lock: CallLock) => void;
}

export interface CallKeys {
    stop(): void;
}

/** Start exchanging keys in a connected room. */
export async function startCallKeys(options: CallKeysOptions): Promise<CallKeys> {
    const { room, lk, provider, roomName } = options;
    const self = room.localParticipant.identity;
    const { pair, pub } = await e2ee.makeCallKeyPair();
    let stopped = false;
    let generation = 0;
    let keyed = false;
    let members: Set<string> | null = null;
    let bind: CallBinding = await options.binding().catch(() => null);
    let busy: Promise<void> = Promise.resolve();
    options.onLock("pending");

    const announce = () =>
        room.localParticipant
            .setAttributes({ [e2ee.CALL_KEY_ATTRIBUTE]: JSON.stringify({ v: 1, pub, epoch: bind?.epoch ?? null }) })
            .catch(() => undefined);

    function peers(): Map<string, e2ee.CallKeyAnnounce> {
        const found = new Map<string, e2ee.CallKeyAnnounce>();
        for (const participant of room.remoteParticipants.values()) {
            const said = e2ee.readAnnounce(participant.attributes[e2ee.CALL_KEY_ATTRIBUTE]);
            if (said) found.set(participant.identity, said);
        }
        return found;
    }

    /** Draw and hand out a new key, when this browser leads and who holds one changed. */
    async function rekey(): Promise<void> {
        const known = peers();
        if (e2ee.keyLeader([self, ...known.keys()]) !== self) return;
        const current = new Set([...known].map(([identity, said]) => `${identity}|${said.pub}|${said.epoch ?? ""}`));
        if (keyed && !e2ee.membershipChanged(members, current)) return;
        generation += 1;
        const gen = generation;
        const key = e2ee.makeCallKey();
        await provider.put(key, e2ee.keySlot(gen));
        members = current;
        keyed = true;
        let allBound = bind !== null;
        const encoder = new TextEncoder();
        await Promise.all(
            [...known].map(async ([identity, said]) => {
                const shared = bind && said.epoch === bind.epoch ? bind : null;
                if (!shared) allBound = false;
                const message = await e2ee.wrapCallKey(key, pair, pub, said.pub, { room: roomName, gen, leader: self, to: identity, bind: shared });
                await room.localParticipant
                    .publishData(encoder.encode(JSON.stringify(message)), {
                        reliable: true,
                        destinationIdentities: [identity],
                        topic: e2ee.CALL_KEY_TOPIC
                    })
                    .catch(() => undefined);
            })
        );
        if (!stopped && generation === gen) options.onLock(allBound ? "bound" : "on");
    }

    async function opened(payload: Uint8Array, from: Participant | undefined, topic: string | undefined): Promise<void> {
        if (topic !== e2ee.CALL_KEY_TOPIC || !from) return;
        const message = e2ee.readKeyMessage(payload);
        if (!message || message.to !== self) return;
        const leader = e2ee.keyLeader([self, ...peers().keys()]);
        // From whoever leads now, or newer than anything held: two browsers that
        // briefly both think they lead settle on the later generation.
        if (from.identity !== leader && message.gen <= generation) return;
        if (message.epoch !== null && message.epoch !== bind?.epoch) {
            // The leader is at another epoch of the conversation's group: read
            // ours again and say it, and the leader wraps again for it.
            bind = await options.binding().catch(() => null);
            await announce();
        }
        const key = await e2ee.unwrapCallKey(message, pair, {
            room: roomName,
            leader: from.identity,
            self,
            bind: message.epoch !== null && bind?.epoch === message.epoch ? bind : null
        });
        if (!key || stopped) return;
        generation = Math.max(generation, message.gen);
        await provider.put(key, e2ee.keySlot(message.gen));
        keyed = true;
        members = null;
        options.onLock(message.epoch !== null ? "bound" : "on");
    }

    // One at a time, so two membership changes never draw two keys at once.
    const queue = (work: () => Promise<void>) => {
        busy = busy.then(() => (stopped ? undefined : work())).catch(() => undefined);
    };
    const onMembers = () => queue(rekey);
    const onData = (payload: Uint8Array, from?: Participant, _kind?: unknown, topic?: string) =>
        queue(() => opened(payload, from, topic));

    room.on(lk.RoomEvent.ParticipantConnected, onMembers)
        .on(lk.RoomEvent.ParticipantDisconnected, onMembers)
        .on(lk.RoomEvent.ParticipantAttributesChanged, onMembers)
        .on(lk.RoomEvent.DataReceived, onData);
    await announce();
    queue(rekey);

    return {
        stop() {
            stopped = true;
            room.off(lk.RoomEvent.ParticipantConnected, onMembers)
                .off(lk.RoomEvent.ParticipantDisconnected, onMembers)
                .off(lk.RoomEvent.ParticipantAttributesChanged, onMembers)
                .off(lk.RoomEvent.DataReceived, onData);
        }
    };
}
