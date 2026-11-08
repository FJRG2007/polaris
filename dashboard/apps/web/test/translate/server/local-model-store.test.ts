import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ensureModelFile,
    modelPath,
    ModelDownloadError
} from "@polaris-app/translate/src/lib/local-models";

const bytes = new TextEncoder().encode("a model, byte for byte");
const file = {
    role: "model" as const,
    name: "model.enes.intgemm.alphas.bin",
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
};

/** A response that streams `body` in two chunks, landing on `url`. */
function served(body: Uint8Array, url = "https://cdn-lfs.huggingface.co/x"): Response {
    const half = Math.floor(body.byteLength / 2);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(body.slice(0, half));
            controller.enqueue(body.slice(half));
            controller.close();
        }
    });
    const response = new Response(stream, { status: 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
}

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "translate-models-"));
    vi.stubEnv("POLARIS_TRANSLATE_MODELS_DIR", dir);
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
});

describe("server model store", () => {
    it("clears what a download stopped mid-way left behind", async () => {
        const left = path.join(dir, `.${file.sha256}.stopped.part`);
        const other = path.join(dir, ".another-file.part");
        await writeFile(left, "half");
        await writeFile(other, "half");
        await ensureModelFile("en-es", file, vi.fn(async () => served(bytes)));
        expect((await readdir(dir)).sort()).toEqual([".another-file.part", file.sha256].sort());
    });

    it("keeps a file that matches its size and sha256 under its hash", async () => {
        const fetcher = vi.fn(async () => served(bytes));
        const at = await ensureModelFile("en-es", file, fetcher);
        expect(at).toBe(path.join(dir, file.sha256));
        expect(new Uint8Array(await readFile(at))).toEqual(bytes);
        const [url] = fetcher.mock.calls[0] as unknown as [string];
        expect(url).toMatch(
            /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/en-es\/model\.enes/
        );
        // Already here: never fetched again.
        await ensureModelFile("en-es", file, fetcher);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it("shares one download between readers asking at once", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const fetcher = vi.fn(async () => {
            await gate;
            return served(bytes);
        });
        const readers = Promise.all([1, 2, 3].map(() => ensureModelFile("en-es", file, fetcher)));
        release();
        expect(new Set(await readers).size).toBe(1);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it("refuses bytes that do not hash to the registry's, and leaves nothing behind", async () => {
        const wrong = new TextEncoder().encode("a model, byte for bytE");
        await expect(ensureModelFile("en-es", file, async () => served(wrong))).rejects.toThrow(
            ModelDownloadError
        );
        expect(await readdir(dir)).toEqual([]);
    });

    it("refuses a file that is longer than the registry says, mid-stream", async () => {
        const longer = new Uint8Array([...bytes, 1, 2, 3]);
        await expect(ensureModelFile("en-es", file, async () => served(longer))).rejects.toThrow(
            "too large"
        );
        expect(await readdir(dir)).toEqual([]);
    });

    it("refuses a short file, a failed status and a hop off https", async () => {
        await expect(
            ensureModelFile("en-es", file, async () => served(bytes.slice(1)))
        ).rejects.toThrow("checksum");
        await expect(
            ensureModelFile("en-es", file, async () => new Response("no", { status: 404 }))
        ).rejects.toThrow("status 404");
        await expect(
            ensureModelFile("en-es", file, async () => served(bytes, "http://cdn.example.test/x"))
        ).rejects.toThrow(ModelDownloadError);
        expect(await readdir(dir)).toEqual([]);
    });

    it("writes to a temporary name and renames it into place", async () => {
        const seen: string[][] = [];
        const fetcher = async () => {
            let pulls = 0;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    pulls += 1;
                    if (pulls === 1) return controller.enqueue(bytes.slice(0, 4));
                    // Wait for the first chunk to reach the disk.
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    seen.push(await readdir(dir));
                    controller.enqueue(bytes.slice(4));
                    controller.close();
                }
            });
            const response = new Response(body);
            Object.defineProperty(response, "url", { value: "https://cdn-lfs.huggingface.co/x" });
            return response;
        };
        await ensureModelFile("en-es", file, fetcher);
        expect(seen.flat().some((name) => name.endsWith(".part"))).toBe(true);
        expect(seen.flat()).not.toContain(file.sha256);
        expect(await readdir(dir)).toEqual([file.sha256]);
        expect(modelPath(file)).toBe(path.join(dir, file.sha256));
    });

    it("downloads again after a failed attempt", async () => {
        await expect(
            ensureModelFile("en-es", file, async () => new Response("", { status: 503 }))
        ).rejects.toThrow();
        await ensureModelFile("en-es", file, async () => served(bytes));
        expect(await readdir(dir)).toEqual([file.sha256]);
    });
});
