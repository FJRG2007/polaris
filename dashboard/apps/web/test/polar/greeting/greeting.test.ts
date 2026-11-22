/**
 * Polar's greeting and suggested prompts: built from templates for the
 * reader's hour, day and what they can reach, never asked of a model, and the
 * same words for the same inputs.
 */

import { describe, expect, it } from "vitest";
import * as greeting from "@/lib/polar/greeting";
import en from "../../../messages/en-US/polar.json";
import es from "../../../messages/es-ES/polar.json";

const at = (iso: string) => new Date(iso);

function lookup(messages: unknown, path: string): unknown {
    return path
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
}

const NOTHING: greeting.PromptReach = { categories: new Set(), weather: false, page: false };

describe("Polar's greeting", () => {
    it("follows the local hour", () => {
        expect(greeting.momentOf(3)).toBe("night");
        expect(greeting.momentOf(9)).toBe("morning");
        expect(greeting.momentOf(14)).toBe("afternoon");
        expect(greeting.momentOf(21)).toBe("evening");
    });

    it("offers a morning greeting in the morning and never an evening one", () => {
        const keys = greeting.greetingCandidates(at("2026-11-24T09:00:00"), null);
        expect(keys).toContain("morning.plain1");
        expect(keys.some((key) => key.startsWith("evening."))).toBe(false);
    });

    it("says only holiday words on a holiday", () => {
        const keys = greeting.greetingCandidates(at("2026-12-25T10:00:00"), "Ana");
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((key) => key.startsWith("christmas."))).toBe(true);
        expect(greeting.occasionOf(at("2027-01-01T10:00:00"))).toBe("newYear");
        expect(greeting.occasionOf(at("2026-12-31T10:00:00"))).toBe("newYearsEve");
        expect(greeting.occasionOf(at("2026-07-14T10:00:00"))).toBeNull();
    });

    it("adds the day of the week's own words", () => {
        expect(greeting.greetingCandidates(at("2026-11-23T10:00:00"), null)).toContain("monday.plain1");
        expect(greeting.greetingCandidates(at("2026-11-27T10:00:00"), null)).toContain("friday.plain1");
        expect(greeting.greetingCandidates(at("2026-11-28T10:00:00"), null)).toContain("weekend.plain1");
    });

    it("never uses a template with a name when there is none", () => {
        for (let seed = 0; seed < 60; seed++) {
            for (const name of [null, "", "   "]) {
                const phrase = greeting.pickGreeting({ now: at("2026-11-23T09:00:00"), name, seed });
                expect(phrase.key).not.toContain(".named");
                expect(phrase.values).toEqual({});
            }
        }
    });

    it("fills the name with the first one given", () => {
        const now = at("2026-11-23T09:00:00");
        const seed = greeting.greetingCandidates(now, "Ana Ruiz").findIndex((key) => key.includes(".named"));
        expect(greeting.pickGreeting({ now, name: "  Ana Ruiz ", seed })).toEqual({
            key: expect.stringContaining(".named"),
            values: { name: "Ana" }
        });
    });

    it("gives the same words for the same inputs", () => {
        const context = { now: at("2026-11-27T19:00:00"), name: "Ana", seed: 7 };
        expect(greeting.pickGreeting(context)).toEqual(greeting.pickGreeting(context));
    });

    it("has every template written in every language, the named ones with the name", () => {
        const keys = Object.entries(greeting.GREETINGS).flatMap(([group, counts]) => [
            ...Array.from({ length: counts.plain }, (_, index) => `greetings.${group}.plain${index + 1}`),
            ...Array.from({ length: counts.named }, (_, index) => `greetings.${group}.named${index + 1}`)
        ]);
        const prompts = [...new Set([...Object.values(greeting.CHAT_PROMPTS).flat(), "page"])].map(
            (key) => `suggestions.${key}`
        );
        const code = greeting.CODE_PROMPTS.map((key) => `code.prompts.${key}`);
        for (const messages of [en, es]) {
            for (const key of [...keys, ...prompts, ...code]) expect(typeof lookup(messages, key), key).toBe("string");
            for (const key of keys) {
                const text = lookup(messages, key) as string;
                expect(text.includes("{name}"), key).toBe(key.includes(".named"));
            }
        }
    });
});

describe("Polar's suggested prompts", () => {
    it("offers only what needs nothing more than a model to someone who reaches no app", () => {
        for (let seed = 0; seed < 40; seed++) {
            const picked = greeting.pickChatPrompts({ now: at("2026-11-24T15:00:00"), seed, reach: NOTHING });
            const free = new Set<string>([...greeting.CHAT_PROMPTS.any, ...greeting.CHAT_PROMPTS.afternoon]);
            expect(picked.every((key) => free.has(key)), picked.join()).toBe(true);
            expect(picked).toHaveLength(3);
            expect(new Set(picked).size).toBe(3);
        }
    });

    it("offers an app's prompt only to someone with that app's tools", () => {
        const reach = greeting.reachOf({ mail_list: { category: "mail" }, other: {} }, false);
        expect([...reach.categories]).toEqual(["mail"]);
        const picked = greeting.pickChatPrompts({ now: at("2026-11-24T15:00:00"), seed: 0, reach });
        expect(picked[0]).toBe("unreadMail");
        expect(picked).not.toContain("calendarToday");
    });

    it("offers the weather only with the weather tool", () => {
        const withWeather = greeting.reachOf({ [greeting.WEATHER_TOOL_NAME]: {} }, false);
        expect(greeting.pickChatPrompts({ now: at("2026-11-24T15:00:00"), seed: 3, reach: withWeather })[0]).toBe("weather");
        for (let seed = 0; seed < 20; seed++)
            expect(greeting.pickChatPrompts({ now: at("2026-11-24T15:00:00"), seed, reach: NOTHING })).not.toContain("weather");
    });

    it("leads with the page when it can be read, then something for the moment", () => {
        const picked = greeting.pickChatPrompts({
            now: at("2026-11-23T09:00:00"),
            seed: 0,
            reach: { ...NOTHING, page: true }
        });
        expect(picked[0]).toBe("page");
        expect(["planWeek", "planDay"]).toContain(picked[1]);
        expect(picked).toHaveLength(3);
    });

    it("has prompts for every hour of every day of a whole year", () => {
        for (let day = 0; day < 366; day++)
            for (const hour of [2, 9, 15, 21]) {
                const now = new Date(2026, 0, 1 + day, hour);
                const picked = greeting.pickChatPrompts({ now, seed: day, reach: NOTHING });
                expect(picked).toHaveLength(3);
                expect(greeting.pickGreeting({ now, name: "Ana", seed: day }).key).toMatch(/\.(plain|named)\d$/);
            }
    });

    it("offers the weekend its own prompt", () => {
        const picked = greeting.pickChatPrompts({ now: at("2026-11-22T11:00:00"), seed: 0, reach: NOTHING });
        expect(picked).toContain("weekendPlan");
    });

    it("offers the holiday's prompt on the holiday", () => {
        const picked = greeting.pickChatPrompts({ now: at("2026-12-25T10:00:00"), seed: 0, reach: NOTHING });
        expect(picked).toContain("holidayMessage");
    });

    it("gives the same prompts for the same inputs, and three distinct code prompts", () => {
        const context = { now: at("2026-11-27T19:00:00"), seed: 11, reach: NOTHING };
        expect(greeting.pickChatPrompts(context)).toEqual(greeting.pickChatPrompts(context));
        const code = greeting.pickCodePrompts({ seed: 4 });
        expect(code).toHaveLength(3);
        expect(new Set(code).size).toBe(3);
    });
});
