/**
 * Translation requests from anywhere in the shell, gathered into as few calls
 * as the route allows: asked for within a short pause they leave together, cut
 * by `planBatches`, and every answer is kept in a bounded cache. A text already
 * in the target language - by the browser's own detector when it has one, or
 * because the engine handed it back unchanged - is answered `same`.
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
}

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

    constructor(
        private readonly offer: TextTranslationOffer,
        private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
        private readonly detect: Detect = browserDetector(),
        private readonly gatherMs = GATHER_MS
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
        this.status ??= this.fetcher(this.offer.endpoint, { headers: { accept: "application/json" } })
            .then(async (response) => {
                if (!response.ok) return { charLimit: null };
                const body = (await response.json()) as { charLimit?: unknown };
                return { charLimit: typeof body.charLimit === "number" ? body.charLimit : null };
            })
            .catch(() => ({ charLimit: null }));
        return this.status;
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
        const { charLimit } = await this.readStatus();
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
                charLimit
            );
            for (const at of tooLong) this.finish(group[at]!, { kind: "failed", message: null });
            for (const batch of batches) await this.send(to, batch.map((at) => group[at]!));
        }
    }

    private async send(to: string, batch: readonly Waiting[]): Promise<void> {
        let response: Response;
        try {
            response = await this.fetcher(this.offer.endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ texts: batch.map((item) => item.text), from: "auto", to })
            });
        } catch {
            for (const item of batch) this.finish(item, { kind: "failed", message: null });
            return;
        }
        if (!response.ok) {
            const message = await messageOf(response);
            for (const item of batch) this.finish(item, { kind: "failed", message });
            return;
        }
        let answer: { texts?: unknown; detected?: unknown };
        try {
            answer = (await response.json()) as typeof answer;
        } catch {
            answer = {};
        }
        const texts = Array.isArray(answer.texts) ? answer.texts : [];
        // One detected language answers for the whole request, so it only
        // speaks for a text that went alone.
        const detected =
            batch.length === 1 && typeof answer.detected === "string" ? answer.detected : null;
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
