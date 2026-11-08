/**
 * The local engine: Mozilla's Bergamot translator (the Marian engine inside
 * Firefox Translations) compiled to WebAssembly and run in a Web Worker, so
 * it works in any current browser, offline once a pair's model is here, with
 * no account, key or limit. Nothing typed leaves the device.
 *
 * The worker is the runtime's own `translator-worker.js`
 * (@browsermt/bergamot-translator, staged at /bergamot/ at build time). It
 * answers `{ id, name, args }` messages with `{ id, result }` or
 * `{ id, error }`; the methods used are `initialize(options)`,
 * `loadTranslationModel({ from, to }, { model, shortlist, vocabs, config })`
 * and `translate({ models, texts: [{ text, html, qualityScores }] })`, which
 * resolves to `[{ target: { text } }]` and pivots itself when given two models.
 *
 * Model files come from Polaris (`/api/translate/models/...`), never from a
 * third party, and are kept in Cache Storage so a pair downloads once per
 * browser. The language is detected by the browser's own detector when it has
 * one, otherwise by Polaris.
 */

import { ServerEngineError } from "./server-engine";
import { LOCAL_MODEL_REVISION } from "../model/local-registry";
import type { EngineResult, TranslateEngine } from "../model/engines";
import {
    LOCAL_RUNTIME_WORKER,
    mirrorCode,
    modelsFor,
    pairFiles,
    servedUrl,
    type LocalModelFile
} from "../model/local-models";

/** What the engine needs of a worker; a real `Worker` or a test's stand-in. */
export interface WorkerLike {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
    addEventListener(type: "error", listener: (event: unknown) => void): void;
    terminate(): void;
}

/** Fetches one model file, reporting each chunk of bytes as it arrives. */
export type LoadModelFile = (
    pair: string,
    file: LocalModelFile,
    onBytes: (bytes: number) => void,
    signal?: AbortSignal
) => Promise<ArrayBuffer>;

export interface LocalEngineOptions {
    makeWorker: () => WorkerLike;
    loadFile: LoadModelFile;
    detect: (text: string, signal?: AbortSignal) => Promise<string | null>;
    /** Hears a first download's progress, 0 to 1. */
    onProgress?: (loaded: number) => void;
}

/** Thrown when the local engine cannot do what was asked; the screen moves on. */
export class LocalEngineUnavailable extends Error {
    public constructor(reason: string) {
        super(reason);
        this.name = "LocalEngineUnavailable";
    }
}

/** Whether this browser can run the local engine at all. */
export function canRunLocally(scope: Record<string, unknown> | undefined): boolean {
    return (
        scope !== undefined &&
        typeof scope.WebAssembly === "object" &&
        scope.WebAssembly !== null &&
        typeof scope.Worker === "function"
    );
}

/** The translation with the spacing around the source put back. */
function keepSpacing(source: string, translated: string): string {
    const lead = /^\s*/.exec(source)![0];
    const trail = /\s*$/.exec(source)![0];
    return `${lead}${translated.trim()}${trail}`;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

export function createLocalEngine(options: LocalEngineOptions): TranslateEngine {
    let worker: WorkerLike | null = null;
    let ready: Promise<unknown> | null = null;
    let next = 1;
    const pending = new Map<number, Pending>();
    const models = new Map<string, Promise<void>>();

    /** Drops the worker and everything loaded in it; the next call starts over. */
    const reset = (error: Error) => {
        worker?.terminate();
        worker = null;
        ready = null;
        models.clear();
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };

    const call = (name: string, args: unknown[], transfer: Transferable[] = []) =>
        new Promise<unknown>((resolve, reject) => {
            const id = next++;
            pending.set(id, { resolve, reject });
            worker!.postMessage({ id, name, args }, transfer);
        });

    const start = (): Promise<unknown> => {
        if (ready) return ready;
        const made = options.makeWorker();
        worker = made;
        made.addEventListener("message", (event) => {
            const data = event.data as {
                id?: number;
                result?: unknown;
                error?: { message?: string };
            };
            const entry = data?.id === undefined ? undefined : pending.get(data.id);
            if (!entry) return;
            pending.delete(data.id!);
            if (data.error) entry.reject(new LocalEngineUnavailable(data.error.message ?? "worker"));
            else entry.resolve(data.result);
        });
        made.addEventListener("error", () => reset(new LocalEngineUnavailable("worker")));
        ready = call("initialize", [{ cacheSize: 0, useNativeIntGemm: true }]);
        ready.catch(() => undefined);
        return ready;
    };

    const loadPairs = async (steps: { from: string; to: string }[], signal?: AbortSignal) => {
        const missing = steps.filter((step) => !models.has(`${step.from}-${step.to}`));
        const files = missing.flatMap((step) => pairFiles(`${step.from}-${step.to}`));
        const total = files.reduce((sum, file) => sum + file.size, 0);
        let loaded = 0;
        const onBytes = (bytes: number) => {
            loaded += bytes;
            options.onProgress?.(Math.min(loaded / total, 0.99));
        };
        if (missing.length > 0) options.onProgress?.(0);
        for (const step of missing) {
            const pair = `${step.from}-${step.to}`;
            const loading = (async () => {
                const buffers = new Map<string, ArrayBuffer>();
                await Promise.all(
                    pairFiles(pair).map(async (file) => {
                        buffers.set(file.role, await options.loadFile(pair, file, onBytes, signal));
                    })
                );
                const vocab = buffers.get("vocab");
                const vocabs = vocab ? [vocab] : [buffers.get("srcvocab")!, buffers.get("trgvocab")!];
                await call(
                    "loadTranslationModel",
                    [
                        step,
                        {
                            model: buffers.get("model"),
                            shortlist: buffers.get("lex"),
                            vocabs,
                            qualityModel: null,
                            config: {}
                        }
                    ],
                    [...buffers.values()]
                );
            })();
            models.set(pair, loading);
            loading.catch(() => models.delete(pair));
        }
        try {
            await Promise.all(steps.map((step) => models.get(`${step.from}-${step.to}`)));
        } finally {
            if (missing.length > 0) options.onProgress?.(1);
        }
    };

    return {
        id: "local",
        detect: (text, signal) => options.detect(text, signal),
        async translate(texts, from, to, signal): Promise<EngineResult> {
            const source = from ?? (await options.detect(texts.join("\n").slice(0, 1000), signal));
            if (!source) throw new LocalEngineUnavailable("undetected");
            const detected = from ? null : source;
            if (mirrorCode(source) === mirrorCode(to)) return { texts: [...texts], detected };
            const steps = modelsFor(source, to);
            if (!steps) throw new LocalEngineUnavailable("pair");
            await start();
            await loadPairs(steps, signal);
            signal?.throwIfAborted();
            const asked = texts.filter((text) => text.trim());
            const answer =
                asked.length === 0
                    ? []
                    : ((await call("translate", [
                          {
                              models: steps,
                              texts: asked.map((text) => ({ text, html: false, qualityScores: false }))
                          }
                      ])) as { target: { text: string } }[]);
            signal?.throwIfAborted();
            if (answer.length !== asked.length) throw new LocalEngineUnavailable("answer count");
            let at = 0;
            const out = texts.map((text) =>
                text.trim() ? keepSpacing(text, answer[at++]!.target.text) : text
            );
            return { texts: out, detected };
        }
    };
}

/** The Cache Storage bucket model files are kept in. */
export const MODEL_CACHE = "polaris-translate-models";

/** Drops cached files of any other revision: a pinned update leaves no dead weight behind. */
async function pruneCache(cache: Cache): Promise<void> {
    const keep = `rev=${LOCAL_MODEL_REVISION.slice(0, 12)}`;
    for (const request of await cache.keys()) {
        if (!request.url.includes(keep)) await cache.delete(request);
    }
}

/**
 * Model files as a page fetches them: from Cache Storage when this browser
 * already has them, otherwise from Polaris, kept for next time. Cache Storage
 * exists only on a secure origin; elsewhere the year-long cache header keeps
 * the files in the HTTP cache instead. `failed` is said when Polaris cannot be
 * reached and has not said why.
 */
export function cachedModelFiles(failed: string): LoadModelFile {
    let opened: Promise<Cache | null> | null = null;
    const bucket = () =>
        (opened ??=
            typeof caches === "undefined"
                ? Promise.resolve(null)
                : caches
                      .open(MODEL_CACHE)
                      .then(async (cache) => {
                          await pruneCache(cache).catch(() => undefined);
                          return cache;
                      })
                      .catch(() => null));
    return async (pair, file, onBytes, signal) => {
        const url = servedUrl(pair, file);
        const cache = await bucket();
        const hit = await cache?.match(url).catch(() => undefined);
        if (hit) {
            onBytes(file.size);
            return hit.arrayBuffer();
        }
        let response: Response;
        try {
            response = await fetch(url, { signal, credentials: "same-origin" });
        } catch (caught) {
            if (signal?.aborted) throw caught;
            throw new ServerEngineError("offline", failed);
        }
        if (!response.ok || !response.body) {
            const said = (await response.json().catch(() => ({}))) as { message?: string };
            throw new ServerEngineError("model", said.message ?? failed);
        }
        const bytes = new Uint8Array(file.size);
        let at = 0;
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (at + value.byteLength > bytes.byteLength) throw new ServerEngineError("model", failed);
            bytes.set(value, at);
            at += value.byteLength;
            onBytes(value.byteLength);
        }
        if (at !== file.size) throw new ServerEngineError("model", failed);
        await cache
            ?.put(url, new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream" } }))
            .catch(() => undefined);
        return bytes.buffer;
    };
}

/** The real worker, the runtime staged beside the dashboard. */
export function bergamotWorker(): WorkerLike {
    return new Worker(LOCAL_RUNTIME_WORKER, { name: "Translate" });
}
