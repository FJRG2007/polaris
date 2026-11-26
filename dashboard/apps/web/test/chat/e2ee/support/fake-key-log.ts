/**
 * A `/api/e2ee/key-log` stand-in built on the real tree code: leaves and
 * complete subtrees kept as the server keeps them, heads signed with a real
 * Ed25519 key, answers in the route's JSON. `fork()` makes a log of its own
 * with the same key - what a server showing different browsers different
 * histories would do.
 */

import * as log from "@polaris/chat-crypto/key-log";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export interface FakeEntry extends log.KeyLogEntry {
    readonly index: number;
}

export class FakeKeyLog {
    readonly entries: FakeEntry[] = [];
    private readonly nodes = new Map<string, Uint8Array>();
    private readonly read: log.NodeReader = (level, index) => this.nodes.get(`${level}:${index}`)!;

    private constructor(private readonly pair: CryptoKeyPair, private readonly publicKey: Uint8Array) {}

    static async create(): Promise<FakeKeyLog> {
        const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
        return new FakeKeyLog(pair, new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    }

    /** A second log under the same key, starting from this one's leaves. */
    async fork(): Promise<FakeKeyLog> {
        const other = new FakeKeyLog(this.pair, this.publicKey);
        for (const entry of this.entries) await other.append(entry);
        return other;
    }

    async append(entry: log.KeyLogEntry): Promise<void> {
        const index = this.entries.length;
        for (const node of await log.appendedNodes(index, await log.entryLeafHash(entry), this.read)) this.nodes.set(`${node.level}:${node.index}`, node.hash);
        this.entries.push({ ...entry, index });
    }

    /** The route's answer for `body`, as `userId`. */
    async answer(userId: string, body: { op: string; userIds?: string[]; since?: number }): Promise<unknown> {
        const size = this.entries.length;
        const rootHash = await log.rootOf(size, this.read);
        const unsigned = { treeSize: size, timestamp: 1_790_000_000_000 + size, rootHash };
        const signature = new Uint8Array(
            await crypto.subtle.sign({ name: "Ed25519" }, this.pair.privateKey, log.headMessage(unsigned) as Uint8Array<ArrayBuffer>)
        );
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
            head: { treeSize: size, timestamp: unsigned.timestamp, rootHash: text(rootHash), signature: text(signature) },
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
            )
        };
    }
}
