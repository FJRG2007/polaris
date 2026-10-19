/**
 * A new Polar thread is named by its model once, after the first answer: the
 * answer is cleaned into a title, a renamed thread is never touched, and a
 * failed or refused call keeps the placeholder without a word to the person.
 */

import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const THREAD = "22222222-2222-4222-8222-222222222222";
const PLACEHOLDER = "como despliego mi app en polaris";

type Row = { id: string; userId: string; title: string; titleSource: string };

const state = { rows: [] as Row[] };

function matches(row: Row, where: Partial<Row>): boolean {
    return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        polarThread: {
            updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
                const hit = state.rows.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            },
            findFirst: async ({ where }: { where: Partial<Row> }) =>
                state.rows.find((row) => matches(row, where)) ?? null
        }
    }
}));

const { sanitizeTitle, titlePolarThread, startPolarTitle, settledPolarTitle } =
    await import("@/lib/polar/titles");

const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
};

const generated = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: USAGE,
    warnings: []
});

function answering(text: string | Error) {
    const calls: unknown[] = [];
    const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
            calls.push(options);
            if (text instanceof Error) throw text;
            return generated(text);
        }
    });
    return { model, calls };
}

const exchange: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: PLACEHOLDER }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Abre Deploy y elige..." }] }
];

beforeEach(() => {
    state.rows = [{ id: THREAD, userId: OWNER, title: PLACEHOLDER, titleSource: "placeholder" }];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("sanitizeTitle", () => {
    it.each([
        ['"Desplegar una app en Polaris."', "Desplegar una app en Polaris"],
        ["Title: Fixing the  login   bug!", "Fixing the login bug"],
        ["“Planning a trip to Japan”", "Planning a trip to Japan"],
        ["\u{1F680} Launch checklist \u{1F389}", "Launch checklist"],
        ["**Weekly report summary**", "Weekly report summary"],
        ["\n\nBudget review\nSecond line", "Budget review"],
        ["¿Qué es Polaris?", "¿Qué es Polaris"]
    ])("cleans %j", (raw, title) => {
        expect(sanitizeTitle(raw)).toBe(title);
    });

    it.each([[""], ["   "], ['""'], ["\u{1F680}"], ["..."]])("gives nothing for %j", (raw) => {
        expect(sanitizeTitle(raw)).toBeNull();
    });

    it("reads a sentence, most often a refusal, as no title", () => {
        expect(
            sanitizeTitle(
                "I am sorry but I cannot help with naming this particular conversation for you"
            )
        ).toBeNull();
    });

    it("never goes past what a rename may be", () => {
        expect(sanitizeTitle("x".repeat(400))).toHaveLength(120);
    });
});

describe("titlePolarThread", () => {
    it("replaces the placeholder with the model's title, asking with a small cap", async () => {
        const { model, calls } = answering("Desplegar una app en Polaris");
        await titlePolarThread(OWNER, THREAD, model, exchange);
        expect(state.rows[0]).toMatchObject({
            title: "Desplegar una app en Polaris",
            titleSource: "model"
        });
        expect(calls).toHaveLength(1);
        const options = calls[0] as { maxOutputTokens?: number };
        expect(options.maxOutputTokens).toBeLessThanOrEqual(256);
        expect(JSON.stringify(calls[0])).toContain(PLACEHOLDER);
    });

    it("asks only once per thread", async () => {
        const first = answering("First title");
        const second = answering("Second title");
        await titlePolarThread(OWNER, THREAD, first.model, exchange);
        await titlePolarThread(OWNER, THREAD, second.model, exchange);
        expect(first.calls).toHaveLength(1);
        expect(second.calls).toHaveLength(0);
        expect(state.rows[0]?.title).toBe("First title");
    });

    it("never touches a thread somebody renamed", async () => {
        state.rows[0] = { ...state.rows[0]!, title: "Mine", titleSource: "user" };
        const { model, calls } = answering("Model title");
        await titlePolarThread(OWNER, THREAD, model, exchange);
        expect(calls).toHaveLength(0);
        expect(state.rows[0]).toMatchObject({ title: "Mine", titleSource: "user" });
    });

    it("lets a rename made while the model thinks win", async () => {
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                Object.assign(state.rows[0]!, { title: "Renamed meanwhile", titleSource: "user" });
                return generated("Model title");
            }
        });
        await titlePolarThread(OWNER, THREAD, model, exchange);
        expect(state.rows[0]).toMatchObject({ title: "Renamed meanwhile", titleSource: "user" });
    });

    it("never names another person's thread", async () => {
        const { model, calls } = answering("Model title");
        await titlePolarThread(STRANGER, THREAD, model, exchange);
        expect(calls).toHaveLength(0);
        expect(state.rows[0]?.titleSource).toBe("placeholder");
    });

    it.each([
        ["the call fails", new Error("provider down")],
        ["the model refuses", "I'm sorry, but I can't help with naming this conversation right now."],
        ["the answer is empty", ""]
    ])("keeps the placeholder silently when %s", async (_name, answer) => {
        await expect(
            titlePolarThread(OWNER, THREAD, answering(answer).model, exchange)
        ).resolves.toBeUndefined();
        expect(state.rows[0]?.title).toBe(PLACEHOLDER);
        expect(state.rows[0]?.titleSource).not.toBe("model");
    });
});

describe("startPolarTitle and settledPolarTitle", () => {
    it("runs behind the caller, and the title waits for it", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                await gate;
                return generated("Ready title");
            }
        });
        startPolarTitle(OWNER, THREAD, model, exchange);
        expect(state.rows[0]?.title).toBe(PLACEHOLDER);
        const settled = settledPolarTitle(OWNER, THREAD);
        release();
        await expect(settled).resolves.toBe("Ready title");
    });

    it("answers the stored title when nothing runs, and null for a stranger", async () => {
        await expect(settledPolarTitle(OWNER, THREAD)).resolves.toBe(PLACEHOLDER);
        await expect(settledPolarTitle(STRANGER, THREAD)).resolves.toBeNull();
    });
});
