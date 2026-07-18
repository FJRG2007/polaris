import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITED_CAPABILITIES, type Capabilities } from "@polaris/config";
import { decryptCredentials, encryptCredentials } from "../src/crypto.js";
import { createDriver } from "../src/registry.js";
import { LocalDriver } from "../src/drivers/local.js";

/** A 32-byte key, base64-encoded, for the crypto tests. */
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

/** Build a web ReadableStream from a string, as the write API expects. */
function webStreamOf(data: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from(Buffer.from(data))) as ReadableStream<Uint8Array>;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

describe("credential crypto", () => {
    it("round-trips credentials and rejects tampering", () => {
        const blob = encryptCredentials({ kind: "s3", secretAccessKey: "shhh" }, MASTER_KEY);
        expect(decryptCredentials(blob, MASTER_KEY)).toEqual({ kind: "s3", secretAccessKey: "shhh" });
        blob.ciphertext[0] = blob.ciphertext[0]! ^ 0xff;
        expect(() => decryptCredentials(blob, MASTER_KEY)).toThrow();
    });
});

describe("local driver", () => {
    let root: string;
    let driver: LocalDriver;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "polaris-local-"));
        driver = new LocalDriver({ id: "test", root });
        await driver.connect();
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("writes, stats, reads, lists, moves, and deletes", async () => {
        await driver.mkdir("docs");
        await driver.writeStream("docs/a.txt", webStreamOf("hello polaris"));
        const stat = await driver.stat("docs/a.txt");
        expect(stat.kind).toBe("file");
        expect(stat.size).toBe(13n);

        expect(await drain(await driver.readStream("docs/a.txt"))).toBe("hello polaris");
        expect(await drain(await driver.readStream("docs/a.txt", { start: 0, end: 4 }))).toBe("hello");

        const listing = await driver.list("docs");
        expect(listing.entries.map((entry) => entry.name)).toContain("a.txt");

        await driver.move("docs/a.txt", "docs/b.txt");
        await expect(driver.stat("docs/a.txt")).rejects.toThrow();
        expect((await driver.stat("docs/b.txt")).size).toBe(13n);

        await driver.delete("docs", { recursive: true });
        await expect(driver.stat("docs")).rejects.toThrow();
    });
});

describe("registry routing", () => {
    const full: Capabilities = { ...LIMITED_CAPABILITIES, edition: "full", nativeMounts: true };

    it("requires the daemon for NFS in the limited edition", () => {
        expect(() =>
            createDriver(
                { id: "n", kind: "nfs", config: { kind: "nfs", host: "h", exportPath: "/x" }, credentials: { kind: "nfs" } },
                { capabilities: LIMITED_CAPABILITIES }
            )
        ).toThrow(/host daemon/);
    });

    it("routes NFS to the injected hostd factory in the full edition", () => {
        const marker = { id: "n" } as never;
        const driver = createDriver(
            { id: "n", kind: "nfs", config: { kind: "nfs", host: "h", exportPath: "/x" }, credentials: { kind: "nfs" } },
            { capabilities: full, hostdFactory: () => marker }
        );
        expect(driver).toBe(marker);
    });

    it("builds a local driver in-process", () => {
        const driver = createDriver(
            { id: "l", kind: "local", config: { kind: "local", root: "/tmp/x" }, credentials: { kind: "local" } },
            { capabilities: LIMITED_CAPABILITIES }
        );
        expect(driver).toBeInstanceOf(LocalDriver);
    });
});
