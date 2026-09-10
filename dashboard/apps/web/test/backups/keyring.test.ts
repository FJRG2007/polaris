/**
 * The backup keyring and the engine's side of sealing: a key round-trips through
 * its recovery form, a copy sealed under one key still opens after rotation, and a
 * copy whose key this instance lacks says to add the recovery key rather than
 * producing bytes.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";

vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

type Row = {
    id: string;
    ownerId: string;
    encryptedKey: Buffer;
    keyNonce: Buffer;
    keyKeyId: string;
    retiredAt: Date | null;
    createdAt: Date;
};

const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@polaris/db", () => {
    let n = 0;
    const matches = (row: Row, where: Record<string, unknown>) =>
        Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
    const backupKey = {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
            [...rows].reverse().find((row) => matches(row, where)) ?? null,
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
        findMany: async ({ where }: { where: { ownerId: string } }) => rows.filter((row) => row.ownerId === where.ownerId),
        create: async ({ data }: { data: Partial<Row> }) => {
            n += 1;
            const row = {
                id: data.id ?? `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
                retiredAt: null,
                createdAt: new Date(Date.now() + n),
                ...data
            } as Row;
            rows.push(row);
            return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
            const row = rows.find((one) => one.id === where.id);
            if (row) Object.assign(row, data);
            return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
            for (const row of rows) if (matches(row, where)) Object.assign(row, data);
            return { count: 0 };
        }
    };
    return {
        prisma: {
            backupKey,
            $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ backupKey })
        }
    };
});

const keyring = await import("@/lib/backups/keyring");
const { sealArtifact, openSealed, plainName } = await import("@/lib/backups/sealed-copies");

const OWNER = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";

async function staged(bytes: Buffer) {
    const dir = await mkdtemp(join(tmpdir(), "polaris-keyring-test-"));
    const path = join(dir, "db.sql.gz");
    await writeFile(path, bytes);
    return { path, fileName: "db.sql.gz", sizeBytes: bytes.length, metadata: {}, cleanup: async () => undefined };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of Readable.fromWeb(stream as import("node:stream/web").ReadableStream)) parts.push(part as Buffer);
    return Buffer.concat(parts);
}

beforeEach(() => {
    rows.length = 0;
});

describe("the backup keyring", () => {
    it("makes one sealing key and keeps using it", async () => {
        const first = await keyring.sealingKey(OWNER);
        const again = await keyring.sealingKey(OWNER);
        expect(again.id).toBe(first.id);
        expect(again.key.equals(first.key)).toBe(true);
        // Wrapped, never stored as the raw key.
        expect(rows[0]?.encryptedKey.includes(first.key)).toBe(false);
    });

    it("round-trips a key through its recovery form", async () => {
        const { id, key } = await keyring.sealingKey(OWNER);
        const line = await keyring.recoveryKey(OWNER, id);
        const parsed = keyring.parseRecoveryKey(line);
        expect(parsed).toEqual({ id, key });
        expect(keyring.parseRecoveryKey(`${line}x`)).toHaveProperty("error");
        expect(keyring.parseRecoveryKey("hello")).toHaveProperty("error");
    });

    it("refuses a mistyped recovery key for a key it already holds, and keeps the real one", async () => {
        const { id, key } = await keyring.sealingKey(OWNER);
        const line = await keyring.recoveryKey(OWNER, id);
        const encoded = line.slice(line.lastIndexOf(":") + 1);
        const swapped = encoded[5] === "A" ? "B" : "A";
        const typo = `${line.slice(0, line.lastIndexOf(":") + 1)}${encoded.slice(0, 5)}${swapped}${encoded.slice(6)}`;
        expect(keyring.parseRecoveryKey(typo)).not.toHaveProperty("error");

        await expect(keyring.addRecoveryKey(OWNER, typo)).rejects.toThrow(/does not match/);
        expect((await keyring.keyById(OWNER, id)).equals(key)).toBe(true);
        expect(await keyring.addRecoveryKey(OWNER, line)).toEqual({ added: false });
        expect((await keyring.keyById(OWNER, id)).equals(key)).toBe(true);
    });

    it("stores a held key again when the one on the ring no longer unwraps here", async () => {
        const { encryptSecret } = await import("@polaris/storage");
        const key = randomBytes(32);
        const other = encryptSecret(key.toString("base64"), Buffer.alloc(32, 9).toString("base64"));
        const id = "00000000-0000-7000-8000-00000000abcd";
        rows.push({
            id,
            ownerId: OWNER,
            encryptedKey: other.ciphertext,
            keyNonce: other.nonce,
            keyKeyId: other.keyId,
            retiredAt: new Date(),
            createdAt: new Date()
        });
        await expect(keyring.keyById(OWNER, id)).rejects.toThrow(/different master key/);
        const line = `polaris-backup-key:${id}:${key.toString("base64url")}`;
        expect(await keyring.addRecoveryKey(OWNER, line)).toEqual({ added: false });
        expect((await keyring.keyById(OWNER, id)).equals(key)).toBe(true);
    });
});

describe("a sealed copy", () => {
    it("is not the source's bytes, and opens back into them", async () => {
        const plain = randomBytes(200_000);
        const { artifact, keyId } = await sealArtifact(await staged(plain), OWNER);
        const onDisk = await readFile(artifact.path);
        expect(onDisk.includes(plain.subarray(0, 64))).toBe(false);
        expect(artifact.fileName).toBe("db.sql.gz.sealed");
        expect(plainName(artifact.fileName)).toBe("db.sql.gz");
        expect(keyId).toBe(rows[0]?.id);
        const opened = await readAll(openSealed(OWNER, Readable.toWeb(Readable.from([onDisk])) as ReadableStream<Uint8Array>));
        expect(opened.equals(plain)).toBe(true);
    });

    it("still opens after the key is rotated", async () => {
        const plain = randomBytes(5_000);
        const { artifact } = await sealArtifact(await staged(plain), OWNER);
        await keyring.rotateKey(OWNER);
        const next = await keyring.sealingKey(OWNER);
        expect(next.id).not.toBe(rows[0]?.id);
        const opened = await readAll(
            openSealed(OWNER, Readable.toWeb(Readable.from([await readFile(artifact.path)])) as ReadableStream<Uint8Array>)
        );
        expect(opened.equals(plain)).toBe(true);
    });

    it("opens on another instance once its recovery key is added there", async () => {
        const plain = randomBytes(5_000);
        const { artifact, keyId } = await sealArtifact(await staged(plain), OWNER);
        const line = await keyring.recoveryKey(OWNER, keyId);
        const bytes = await readFile(artifact.path);
        rows.length = 0;
        await expect(
            readAll(openSealed(OWNER, Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>))
        ).rejects.toThrow(/recovery key/);
        expect(await keyring.addRecoveryKey(OWNER, line)).toEqual({ added: true });
        expect(rows[0]?.retiredAt).not.toBeNull();
        const opened = await readAll(openSealed(OWNER, Readable.toWeb(Readable.from([bytes])) as ReadableStream<Uint8Array>));
        expect(opened.equals(plain)).toBe(true);
    });
});
