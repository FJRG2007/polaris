/**
 * A `/api/e2ee/key-log` stand-in built on the real tree code: leaves and
 * complete subtrees kept as the server keeps them, heads signed with a real
 * Ed25519 key, answers in the route's JSON. `fork()` makes a log of its own
 * with the same key - what a server showing different browsers different
 * histories would do. `rotate()` changes the signing key as the server does:
 * signed over by the old key, or a reset when the old key is gone.
 */

import * as log from "@polaris/chat-crypto/key-log";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export interface FakeEntry extends log.KeyLogEntry {
    readonly index: number;
}

type Head = Pick<log.TreeHead, "treeSize" | "timestamp" | "rootHash">;

async function generatePair(): Promise<{ pair: CryptoKeyPair; publicKey: Uint8Array }> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return { pair, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

const sign = async (pair: CryptoKeyPair, message: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message as Uint8Array<ArrayBuffer>));

export class FakeKeyLog {
    readonly entries: FakeEntry[] = [];
    readonly handovers: log.KeyHandover[] = [];
    private readonly nodes = new Map<string, Uint8Array>();
    private readonly read: log.NodeReader = (level, index) => this.nodes.get(`${level}:${index}`)!;

    private constructor(private pair: CryptoKeyPair, private publicKey: Uint8Array) {}

    static async create(): Promise<FakeKeyLog> {
        const { pair, publicKey } = await generatePair();
        return new FakeKeyLog(pair, publicKey);
    }

    /** A second log under the same key, starting from this one's leaves. */
    async fork(): Promise<FakeKeyLog> {
        const other = new FakeKeyLog(this.pair, this.publicKey);
        for (const entry of this.entries) await other.append(entry);
        other.handovers.push(...this.handovers);
        return other;
    }

    async append(entry: log.KeyLogEntry): Promise<void> {
        const index = this.entries.length;
        for (const node of await log.appendedNodes(index, await log.entryLeafHash(entry), this.read)) this.nodes.set(`${node.level}:${node.index}`, node.hash);
        this.entries.push({ ...entry, index });
    }

    /** The current head, unsigned. */
    async head(): Promise<Head> {
        const size = this.entries.length;
        return { treeSize: size, timestamp: 1_790_000_000_000 + size, rootHash: await log.rootOf(size, this.read) };
    }

    /**
     * A new signing key: the old one signs the hand-over over `over` (this
     * log's head unless given), or nothing does when `signed` is false - a reset.
     */
    async rotate(signed = true, over?: Head): Promise<void> {
        const next = await generatePair();
        const handover = { fromKey: this.publicKey, toKey: next.publicKey, head: over ?? (await this.head()) };
        this.handovers.push({ ...handover, signature: signed ? await sign(this.pair, log.handoverMessage(handover)) : null });
        this.pair = next.pair;
        this.publicKey = next.publicKey;
    }

    /** The route's answer for `body`, as `userId`. */
    async answer(userId: string, body: { op: string; userIds?: string[]; since?: number }): Promise<unknown> {
        const unsigned = await this.head();
        const size = unsigned.treeSize;
        const signature = await sign(this.pair, log.headMessage(unsigned));
        const named = body.op === "own" ? [userId] : (body.userIds ?? []);
        const picked =
            body.op === "own"
                ? this.entries.filter((e) => e.userId === userId)
                : named.flatMap((id) => {
                      const mine = this.entries.filter((e) => e.userId === id);
                      return mine.length ? [mine.reduce((a, b) => (b.akVersion > a.akVersion ? b : a))] : [];
                  });
        const since = body.since !== undefined && body.since <= size ? body.since : undefined;
        return {
            logKey: text(this.publicKey),
            head: { treeSize: size, timestamp: unsigned.timestamp, rootHash: text(unsigned.rootHash), signature: text(signature) },
            consistency: since === undefined ? null : (await log.consistencyProof(since, size, this.read)).map(text),
            entries: await Promise.all(
                picked.map(async (e) => ({
                    index: e.index,
                    userId: e.userId,
                    akVersion: e.akVersion,
                    signPublicKey: text(e.signPublicKey),
                    hpkePublicKey: text(e.hpkePublicKey),
                    proof: (await log.inclusionProof(e.index, size, this.read)).map(text)
                }))
            ),
            // Every hand-over, as a server answering from the start of the chain would; the browser skips to its pinned key.
            handovers: await Promise.all(
                this.handovers
                    .filter((h) => h.head.treeSize <= size)
                    .map(async (h) => ({
                        fromKey: text(h.fromKey),
                        toKey: text(h.toKey),
                        head: { treeSize: h.head.treeSize, timestamp: h.head.timestamp, rootHash: text(h.head.rootHash) },
                        signature: h.signature ? text(h.signature) : null,
                        consistency: (await log.consistencyProof(h.head.treeSize, size, this.read)).map(text)
                    }))
            )
        };
    }
}
