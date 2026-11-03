// @vitest-environment jsdom

/**
 * The answer cards as drawn: a translation names both languages in the
 * reader's locale, copies the translation and reads it aloud only where the
 * browser can; the weather shows now and the days ahead with labelled
 * conditions; the time card shows each place against the first and keeps
 * ticking when it shows "now"; a conversion shows its result, input and how.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { withMessages } = await import("../setup/i18n");
const { PolarVisualView } = await import("@/components/polar/visuals/visual-view");
const { localVoiceFor } = await import("@/components/polar/visuals/visual-cards");
const visuals = await import("@/lib/polar/visuals");

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
});

function draw(input: unknown, locale: "en-US" | "es-ES" = "en-US") {
    const visual = visuals.visualOf(input);
    expect(visual).not.toBeNull();
    return render(withMessages(<PolarVisualView visual={visual!} />, locale));
}

const translation = {
    view: {
        kind: "translation",
        from: "en",
        to: "es",
        source: "Good morning",
        translation: "Buenos días",
        alternatives: ["Buen día"],
        notes: "Buen día is more common in Latin America."
    }
};

describe("the translation card", () => {
    it("names both languages in the reader's locale", () => {
        draw(translation);
        expect(screen.getByRole("heading", { name: "English" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Spanish" })).toBeTruthy();
        expect(screen.getByText("Buenos días").getAttribute("lang")).toBe("es");
        expect(screen.getByText("Buen día")).toBeTruthy();
        cleanup();
        draw(translation, "es-ES");
        expect(screen.getByRole("heading", { name: "inglés" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "español" })).toBeTruthy();
    });

    it("says the source language was detected when it was not given", () => {
        draw({ view: { ...translation.view, from: "detected" } });
        expect(screen.getByRole("heading", { name: "Detected language" })).toBeTruthy();
    });

    it("copies the translation alone", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        draw(translation);
        fireEvent.click(screen.getByRole("button", { name: "Copy translation" }));
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Buenos días"));
    });

    it("offers Listen only where the browser can speak", () => {
        draw(translation);
        expect(screen.queryByRole("button", { name: "Listen" })).toBeNull();
    });

    it("reads the translation aloud in its language, on a voice of this device", () => {
        const spoken: { text: string; lang: string; voice: unknown; onend?: () => void }[] = [];
        class Utterance {
            lang = "";
            voice: unknown = null;
            onend?: () => void;
            onerror?: () => void;
            constructor(public text: string) {}
        }
        const voices = [
            { lang: "es-ES", localService: false, name: "remote" },
            { lang: "es-ES", localService: true, name: "local" }
        ];
        Object.assign(window, {
            SpeechSynthesisUtterance: Utterance,
            speechSynthesis: {
                cancel: vi.fn(),
                getVoices: () => voices,
                speak: (utterance: Utterance) => spoken.push(utterance as never)
            }
        });
        draw(translation);
        fireEvent.click(screen.getByRole("button", { name: "Listen" }));
        expect(spoken).toHaveLength(1);
        expect(spoken[0]).toMatchObject({ text: "Buenos días", lang: "es" });
        expect((spoken[0]!.voice as { name: string }).name).toBe("local");
        const stop = screen.getByRole("button", { name: "Stop" });
        expect(stop.getAttribute("aria-pressed")).toBe("true");
        act(() => spoken[0]!.onend?.());
        expect(screen.getByRole("button", { name: "Listen" })).toBeTruthy();
    });

    it("picks a voice by exact tag, then by language, never a remote one", () => {
        const voice = (lang: string, localService: boolean) =>
            ({ lang, localService, name: lang }) as SpeechSynthesisVoice;
        expect(localVoiceFor([voice("es-MX", true), voice("es-ES", true)], "es-ES")?.lang).toBe(
            "es-ES"
        );
        expect(localVoiceFor([voice("es-MX", true)], "es")?.lang).toBe("es-MX");
        expect(localVoiceFor([voice("es-ES", false)], "es")).toBeNull();
    });
});

describe("the weather card", () => {
    const weather = {
        view: {
            kind: "weather",
            place: "Madrid, Spain",
            asOf: "2026-11-03T10:45",
            units: "imperial",
            current: { temperature: 50.1, apparent: 42, code: 0, wind: 9.3, humidity: 46 },
            days: [
                { date: "2026-11-03", min: 43.3, max: 57.8, code: 3, precipitation: 0 },
                { date: "2026-11-08", min: 48.8, max: 58.1, code: 61, precipitation: 87 }
            ]
        }
    };

    it("shows now and the days ahead with the condition named", () => {
        draw(weather);
        expect(screen.getByText("Madrid, Spain")).toBeTruthy();
        expect(screen.getByText("50°F")).toBeTruthy();
        expect(screen.getByText("Clear sky")).toBeTruthy();
        expect(screen.getByText("Feels like 42°F")).toBeTruthy();
        expect(screen.getByText("Wind 9 mph")).toBeTruthy();
        expect(screen.getByText("Humidity 46%")).toBeTruthy();
        expect(screen.getByText(/^As of Tue/)).toBeTruthy();
        const days = screen.getByRole("list", { name: "Coming days" });
        expect(days.children).toHaveLength(2);
        expect(days.children[0]!.textContent).toContain("Overcast");
        // A day with rain likely shows the chance next to its condition.
        expect(days.children[1]!.textContent).toContain("Light rain");
        expect(days.children[1]!.textContent).toContain("Rain 87%");
        expect(days.children[0]!.textContent).not.toContain("Rain");
        expect(days.children[1]!.textContent).toContain("Sun");
    });

    it("names the conditions in Spanish too", () => {
        draw(weather, "es-ES");
        expect(screen.getByText("Despejado")).toBeTruthy();
        expect(screen.getByText("Sensación 42°F")).toBeTruthy();
    });

    it("keeps a long place name on one line with the whole of it in its title", () => {
        const place = "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch, Wales";
        draw({ view: { ...weather.view, place } });
        const name = screen.getByText(place);
        expect(name.className).toContain("truncate");
        expect(name.getAttribute("title")).toBe(place);
    });
});

describe("the time card", () => {
    const time = {
        view: {
            kind: "time",
            at: "2026-11-03T15:00",
            places: [
                { label: "Madrid", zone: "Europe/Madrid" },
                { label: "New York", zone: "America/New_York" },
                { label: "Mumbai", zone: "Asia/Kolkata" }
            ]
        }
    };

    it("shows each place's time and how far it is from the first", () => {
        draw(time);
        const rows = screen.getAllByRole("listitem");
        expect(rows).toHaveLength(3);
        expect(rows[0]!.textContent).toMatch(/Madrid.*3:00\sPM/);
        expect(rows[1]!.textContent).toMatch(/New York6 h behind9:00\sAM/);
        expect(rows[2]!.textContent).toMatch(/Mumbai4 h 30 min ahead7:30\sPM/);
    });

    it("keeps the time now moving", () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.UTC(2026, 10, 3, 9, 0));
        draw({ view: { kind: "time", places: [{ label: "London", zone: "Europe/London" }] } });
        expect(screen.getByText("Now")).toBeTruthy();
        expect(screen.getByText(/^9:00\sAM$/)).toBeTruthy();
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText(/^9:01\sAM$/)).toBeTruthy();
    });
});

describe("the conversion card", () => {
    it("shows the result, the input and the formula", () => {
        draw({
            view: {
                kind: "conversion",
                type: "unit",
                from: { value: 100, unit: "°C" },
                to: { value: 212, unit: "°F" },
                formula: "°F = °C × 9/5 + 32"
            }
        });
        expect(screen.getByText("100 °C =")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe("212 °F");
        expect(screen.getByText("°F = °C × 9/5 + 32")).toBeTruthy();
    });

    it("shows a currency in its format, with its rate, source and date", () => {
        draw({
            view: {
                kind: "conversion",
                type: "currency",
                from: { value: 100, unit: "EUR" },
                to: { value: 108, unit: "USD" },
                rate: 1.08,
                source: "ECB reference rate",
                asOf: "2026-11-02"
            }
        });
        expect(screen.getByText("€100.00 =")).toBeTruthy();
        expect(screen.getByRole("status").textContent).toBe("$108.00");
        expect(screen.getByText("1 EUR = 1.08 USD")).toBeTruthy();
        expect(screen.getByText("Source: ECB reference rate, as of Nov 2, 2026")).toBeTruthy();
    });
});
