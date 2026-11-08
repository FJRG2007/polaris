/**
 * The local engine over a stand-in for the Bergamot worker: it starts the
 * worker once, loads each pair's model once (both legs of a pivot), reports
 * the first download's progress, keeps blank texts and spacing as they are,
 * and gives way when it cannot do a pair.
 */

import { describe, expect, it, vi } from "vitest";
import { pairFiles } from "@polaris-app/translate/src/model/local-models";
import {
    LocalEngineUnavailable,
    canRunLocally,
    createLocalEngine,
    type WorkerLike
} from "@polaris-app/translate/src/screens/local-engine";

interface Message {
    id: number;
    name: string;
    args: unknown[];
}

type Listener = (event: { data: unknown }) => void;

function fakeWorker(fail: Partial<Record<string, string>>) {
    const calls: Message[] = [];
    const listeners: Listener[] = [];
    const answer = ({ id, name, args }: Message): unknown => {
        if (fail[name]) return { id, error: { message: fail[name] } };
        if (name !== "translate") return { id, result: undefined };
        const { texts } = args[0] as { texts: { text: string }[] };
        return { id, result: texts.map(({ text }) => ({ target: { text: `<${text.trim()}>` } })) };
    };
    const worker = {
        postMessage(message: unknown) {
            const sent = message as Message;
            calls.push(sent);
            queueMicrotask(() => listeners.forEach((listener) => listener({ data: answer(sent) })));
        },
        addEventListener(type: string, listener: Listener) {
            if (type === "message") listeners.push(listener);
        },
        terminate: vi.fn()
    } as unknown as WorkerLike;
    return { worker, calls };
}

function engine(
    options: { fail?: Partial<Record<string, string>>; detected?: string | null } = {}
) {
    const { worker, calls } = fakeWorker(options.fail ?? {});
    const makeWorker = vi.fn(() => worker);
    const loadFile = vi.fn(
        async (_pair: string, file: { size: number }, onBytes: (bytes: number) => void) => {
            onBytes(file.size);
            return new ArrayBuffer(8);
        }
    );
    const progress: number[] = [];
    const made = createLocalEngine({
        makeWorker,
        loadFile,
        detect: async () => options.detected ?? null,
        onProgress: (loaded) => progress.push(loaded)
    });
    return { made, calls, makeWorker, loadFile, progress };
}

describe("createLocalEngine", () => {
    it("loads a pair once and translates through the worker", async () => {
        const { made, calls, makeWorker, loadFile, progress } = engine();
        expect(await made.translate(["Hello", "  world  ", "  "], "en", "es")).toEqual({
            texts: ["<Hello>", "  <world>  ", "  "],
            detected: null
        });
        await made.translate(["Again"], "en", "es");
        expect(makeWorker).toHaveBeenCalledTimes(1);
        expect(loadFile).toHaveBeenCalledTimes(pairFiles("en-es").length);
        expect(calls.map((call) => call.name)).toEqual([
            "initialize",
            "loadTranslationModel",
            "translate",
            "translate"
        ]);
        expect(progress[0]).toBe(0);
        expect(progress.at(-1)).toBe(1);
        const sent = calls[2]!.args[0] as { models: unknown; texts: unknown[] };
        expect(sent.models).toEqual([{ from: "en", to: "es" }]);
        expect(sent.texts).toHaveLength(2);
    });

    it("pivots through English with both models loaded", async () => {
        const { made, calls } = engine();
        await made.translate(["Hallo"], "de", "es");
        const loads = calls.filter((call) => call.name === "loadTranslationModel");
        expect(loads.map((call) => call.args[0])).toEqual([
            { from: "de", to: "en" },
            { from: "en", to: "es" }
        ]);
        const buffers = loads[0]!.args[1] as { vocabs: unknown[]; model: unknown };
        expect(buffers.vocabs).toHaveLength(1);
        expect(buffers.model).toBeInstanceOf(ArrayBuffer);
        const sent = calls.find((call) => call.name === "translate")!.args[0] as {
            models: unknown[];
        };
        expect(sent.models).toHaveLength(2);
    });

    it("hands Japanese its separate vocabularies", async () => {
        const { made, calls } = engine();
        await made.translate(["Hello"], "en", "ja");
        const load = calls.find((call) => call.name === "loadTranslationModel")!;
        expect((load.args[1] as { vocabs: unknown[] }).vocabs).toHaveLength(2);
    });

    it("detects the language when asked to, and hands back text already in the target", async () => {
        const { made, calls } = engine({ detected: "es" });
        expect(await made.translate(["Hola"], null, "es")).toEqual({
            texts: ["Hola"],
            detected: "es"
        });
        expect(calls).toHaveLength(0);
        expect(await made.translate(["Hola"], null, "en")).toEqual({
            texts: ["<Hola>"],
            detected: "es"
        });
    });

    it("gives way on a pair it has no model for, or a language it cannot read", async () => {
        await expect(engine().made.translate(["x"], "en", "xx")).rejects.toBeInstanceOf(
            LocalEngineUnavailable
        );
        await expect(
            engine({ detected: null }).made.translate(["x"], null, "es")
        ).rejects.toBeInstanceOf(LocalEngineUnavailable);
    });

    it("lets a failed model load be tried again", async () => {
        const { made, calls } = engine({ fail: { loadTranslationModel: "bad model" } });
        await expect(made.translate(["Hi"], "en", "es")).rejects.toThrow("bad model");
        await expect(made.translate(["Hi"], "en", "es")).rejects.toThrow("bad model");
        expect(calls.filter((call) => call.name === "loadTranslationModel")).toHaveLength(2);
    });
});

describe("canRunLocally", () => {
    it("needs WebAssembly and workers", () => {
        const Worker = function Worker() {};
        expect(canRunLocally({ WebAssembly: {}, Worker })).toBe(true);
        expect(canRunLocally({ Worker })).toBe(false);
        expect(canRunLocally({ WebAssembly: {} })).toBe(false);
        expect(canRunLocally(undefined)).toBe(false);
    });
});

/** A local engine as a selection gets it, its downloads held until `arrive()`. */
function selectionEngine(cached: boolean) {
    const { worker, calls } = fakeWorker({});
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const loadFile = vi.fn(
        async (_pair: string, file: { size: number }, onBytes: (bytes: number) => void) => {
            if (!cached) await arrived;
            onBytes(file.size);
            return new ArrayBuffer(8);
        }
    );
    const isCached = vi.fn(async () => cached);
    const made = createLocalEngine({
        makeWorker: () => worker,
        loadFile,
        detect: async () => null,
        isCached
    });
    return { made, calls, loadFile, isCached, arrive };
}

/** Lets the background download's promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLocalEngine on a selection", () => {
    it("gives way at once when the model is not on the device, and fetches it for next time", async () => {
        const { made, calls, loadFile, arrive } = selectionEngine(false);
        await expect(made.translate(["Hello"], "en", "es")).rejects.toBeInstanceOf(
            LocalEngineUnavailable
        );
        await settle();
        expect(loadFile).toHaveBeenCalledTimes(pairFiles("en-es").length);
        // Still arriving: the next selection does not wait on it, nor fetch it twice.
        await expect(made.translate(["Hello"], "en", "es")).rejects.toBeInstanceOf(
            LocalEngineUnavailable
        );
        expect(loadFile).toHaveBeenCalledTimes(pairFiles("en-es").length);
        arrive();
        await settle();
        await settle();
        expect(await made.translate(["Hello"], "en", "es")).toEqual({
            texts: ["<Hello>"],
            detected: null
        });
        expect(loadFile).toHaveBeenCalledTimes(pairFiles("en-es").length);
        expect(calls.map((call) => call.name)).toEqual([
            "initialize",
            "loadTranslationModel",
            "translate"
        ]);
    });

    it("answers locally when the model is already kept on the device", async () => {
        const { made, isCached, loadFile } = selectionEngine(true);
        expect(await made.translate(["Hello"], "en", "es")).toEqual({
            texts: ["<Hello>"],
            detected: null
        });
        expect(isCached).toHaveBeenCalledWith("en-es");
        expect(loadFile).toHaveBeenCalledTimes(pairFiles("en-es").length);
    });

    it("needs both legs of a pivot on the device", async () => {
        const { worker } = fakeWorker({});
        const loadFile = vi.fn(
            async (_pair: string, file: { size: number }, onBytes: (bytes: number) => void) => {
                onBytes(file.size);
                return new ArrayBuffer(8);
            }
        );
        const made = createLocalEngine({
            makeWorker: () => worker,
            loadFile,
            detect: async () => null,
            isCached: async (pair) => pair === "es-en"
        });
        await expect(made.translate(["Hola"], "es", "de")).rejects.toBeInstanceOf(
            LocalEngineUnavailable
        );
    });
});
