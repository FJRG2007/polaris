/**
 * Translation requests from anywhere in the shell, gathered into as few calls
 * as the route allows: asked for within a short pause they leave together, cut
 * by `planBatches`, and every answer is kept in a bounded cache. Each batch goes
 * through the engines in the order the app's administrator set (GET on the
 * endpoint): the ones on the reader's device - the browser's translator, the
 * local one - answer in place where this browser runs them, and the first
 * server engine in that order stands for the server, which picks its own. A
 * text already in the target language - by the browser's own detector when it
 * has one, or because the engine handed it back unchanged - is answered `same`.
 *
 * No React here; the provider owns one queue per shell.
 */

import type { TextTranslationOffer } from "@/lib/app-extensions/types";
import { planBatches, sameLanguage, TranslationCache, unchanged } from "./logic";

export type TranslationOutcome =
    | { readonly kind: "translated"; readonly text: string; readonly detected: string | null }
    | { readonly kind: "same" }
    | { readonly kind: "failed"; readonly message: string | null };

/** How long a request waits for others to leave with it. */
export const GATHER_MS = 150;

/** Shorter than this, a detector's guess is not worth acting on. */
const DETECT_MIN = 24;

interface Waiting {
    readonly text: string;
    readonly to: string;
    readonly settle: Array<(outcome: TranslationOutcome) => void>;
}

interface Status {
    readonly charLimit: number | null;
    /** Engine ids in the administrator's order; empty when the app did not say. */
    readonly order: readonly string[];
    /** Whether the administrator allows each device engine. */
    readonly browser: boolean;
    readonly local: boolean;
}

const NO_STATUS: Status = { charLimit: null, order: [], browser: false, local: false };

/** An engine that runs on the reader's device; `from` null means "detect it". */
export interface DeviceEngine {
    translate(
        texts: readonly string[],
        from: string | null,
        to: string
    ): Promise<{ texts: readonly string[]; detected: string | null }>;
}

/** The device engines this browser can run, each null where it cannot. */
export interface DeviceEngines {
    readonly browser: DeviceEngine | null;
    readonly local: DeviceEngine | null;
}

export type LoadDevices = () => Promise<DeviceEngines | null>;

const DEVICE_IDS = ["browser", "local"] as const;

type DeviceId = (typeof DEVICE_IDS)[number];

function isDevice(id: string): id is DeviceId {
    return (DEVICE_IDS as readonly string[]).includes(id);
}

type Answer =
    | { readonly ok: true; readonly texts: readonly unknown[]; readonly detected: string | null }
    | { readonly ok: false; readonly message: string | null };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

type Detect = (text: string) => Promise<string | null>;

interface DetectorApi {
    create(): Promise<{
        detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
    }>;
}

/** The browser's own language detector, where it has one; null otherwise. */
export function browserDetector(): Detect {
    let made: ReturnType<DetectorApi["create"]> | null = null;
    return async (text) => {
        const api = (globalThis as { LanguageDetector?: DetectorApi }).LanguageDetector;
        if (!api || text.length < DETECT_MIN) return null;
        try {
            made ??= api.create();
            const [top] = await (await made).detect(text);
            return top && top.confidence >= 0.85 ? top.detectedLanguage : null;
        } catch {
            return null;
        }
    };
}

async function messageOf(response: Response): Promise<string | null> {
    try {
        const body = (await response.json()) as { message?: unknown };
        return typeof body.message === "string" ? body.message : null;
    } catch {
        return null;
    }
}

export class TranslationQueue {
    private readonly cache = new TranslationCache<TranslationOutcome>();
    private readonly waiting = new Map<string, Waiting>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private status: Promise<Status> | null = null;
    private devices: Promise<DeviceEngines | null> | null = null;

    constructor(
        private readonly offer: TextTranslationOffer,
        private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
        private readonly detect: Detect = browserDetector(),
        private readonly gatherMs = GATHER_MS,
        private readonly loadDevices: LoadDevices = () => Promise.resolve(null)
    ) {}

    /** One text into `to`, answered from the cache or with the next batch. */
    translate(text: string, to: string): Promise<TranslationOutcome> {
        const words = text.trim();
        if (!words) return Promise.resolve({ kind: "same" });
        const kept = this.cache.get(to, words);
        if (kept) return Promise.resolve(kept);
        return new Promise((settle) => {
            const key = `${to}\u0000${words}`;
            const already = this.waiting.get(key);
            if (already) {
                already.settle.push(settle);
                return;
            }
            this.waiting.set(key, { text: words, to, settle: [settle] });
            this.timer ??= setTimeout(() => void this.flush(), this.gatherMs);
        });
    }

    private readStatus(): Promise<Status> {
        this.status ??= this.fetcher(this.offer.endpoint, {
            headers: { accept: "application/json" }
        })
            .then(async (response): Promise<Status> => {
                if (!response.ok) return NO_STATUS;
                const body = (await response.json()) as Record<string, unknown>;
                return {
                    charLimit: typeof body.charLimit === "number" ? body.charLimit : null,
                    order: Array.isArray(body.order)
                        ? body.order.filter((id): id is string => typeof id === "string")
                        : [],
                    browser: body.browser === true,
                    local: body.local === true
                };
            })
            .catch(() => NO_STATUS);
        return this.status;
    }

    private readDevices(): Promise<DeviceEngines | null> {
        this.devices ??= this.loadDevices().catch(() => null);
        return this.devices;
    }

    private finish(item: Waiting, outcome: TranslationOutcome): void {
        if (outcome.kind !== "failed") this.cache.set(item.to, item.text, outcome);
        for (const settle of item.settle) settle(outcome);
    }

    /** Everything waiting, by target language, in as few requests as allowed. */
    async flush(): Promise<void> {
        this.timer = null;
        const items = [...this.waiting.values()];
        this.waiting.clear();
        const status = await this.readStatus();
        const byTarget = new Map<string, Waiting[]>();
        for (const item of items) {
            // Already in the reader's language, by the browser's own reckoning:
            // nothing to ask an engine.
            if (sameLanguage(await this.detect(item.text), item.to)) {
                this.finish(item, { kind: "same" });
                continue;
            }
            byTarget.set(item.to, [...(byTarget.get(item.to) ?? []), item]);
        }
        for (const [to, group] of byTarget) {
            const { batches, tooLong } = planBatches(
                group.map((item) => item.text),
                status.charLimit
            );
            for (const at of tooLong) this.finish(group[at]!, { kind: "failed", message: null });
            for (const batch of batches)
                await this.send(
                    status,
                    to,
                    batch.map((at) => group[at]!)
                );
        }
    }

    /**
     * One batch through the engines in order. A device engine that fails, or
     * that this browser does not run, hands the batch on; the server is asked
     * once, where its first engine sits in the order (last when the order names
     * none), and its failure is the one shown when nothing after it answers.
     */
    private async send(status: Status, to: string, batch: readonly Waiting[]): Promise<void> {
        const texts = batch.map((item) => item.text);
        const order = status.order.some((id) => !isDevice(id))
            ? status.order
            : [...status.order, "server"];
        let asked = false;
        let message: string | null = null;
        for (const id of order) {
            let answer: Answer | null = null;
            if (isDevice(id)) {
                if (status[id]) answer = await this.askDevice(id, texts, to);
            } else if (!asked) {
                asked = true;
                answer = await this.askServer(texts, to);
                if (!answer.ok) message = answer.message;
            }
            if (answer?.ok) return this.settle(batch, to, answer.texts, answer.detected);
        }
        for (const item of batch) this.finish(item, { kind: "failed", message });
    }

    private async askDevice(id: DeviceId, texts: string[], to: string): Promise<Answer | null> {
        const engine = (await this.readDevices())?.[id];
        if (!engine) return null;
        try {
            const answer = await engine.translate(texts, null, to);
            if (answer.texts.length !== texts.length) return null;
            return { ok: true, texts: answer.texts, detected: answer.detected };
        } catch {
            return null;
        }
    }

    private async askServer(texts: string[], to: string): Promise<Answer> {
        let response: Response;
        try {
            response = await this.fetcher(this.offer.endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ texts, from: "auto", to })
            });
        } catch {
            return { ok: false, message: null };
        }
        if (!response.ok) return { ok: false, message: await messageOf(response) };
        let answer: { texts?: unknown; detected?: unknown };
        try {
            answer = (await response.json()) as typeof answer;
        } catch {
            answer = {};
        }
        return {
            ok: true,
            texts: Array.isArray(answer.texts) ? answer.texts : [],
            detected: typeof answer.detected === "string" ? answer.detected : null
        };
    }

    private settle(
        batch: readonly Waiting[],
        to: string,
        texts: readonly unknown[],
        said: string | null
    ): void {
        // One detected language answers for the whole request, so it only
        // speaks for a text that went alone.
        const detected = batch.length === 1 ? said : null;
        batch.forEach((item, at) => {
            const text = texts[at];
            if (typeof text !== "string") {
                this.finish(item, { kind: "failed", message: null });
            } else if (unchanged(item.text, text) || sameLanguage(detected, to)) {
                this.finish(item, { kind: "same" });
            } else {
                this.finish(item, { kind: "translated", text, detected });
            }
        });
    }
}
