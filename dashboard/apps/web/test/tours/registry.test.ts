// @vitest-environment jsdom

/**
 * The guided tours' registry: every step points at an element that exists in the
 * source, every word is in both locales, and a step whose target is hidden,
 * missing or disabled is dropped rather than drawn pointing at nothing.
 */

import enUS from "../../messages/en-US";
import esES from "../../messages/es-ES";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as registry from "@/lib/tours/registry";
import { isUsable, usableTarget } from "@/lib/tours/target";
import { readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");
const SOURCES = [
    join(DASHBOARD, "apps/web/src"),
    join(DASHBOARD, "apps/game-servers/src"),
    join(DASHBOARD, "packages/ui/src")
];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.tsx?$/.test(name) ? [path] : [];
    });
}

const declared = new Set(
    SOURCES.flatMap(sourceFiles).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/data-tour="([^"]+)"/g)].map((match) => match[1])
    )
);

function lookup(catalog: unknown, key: string): unknown {
    return key.split(".").reduce<unknown>((node, part) => {
        return node && typeof node === "object"
            ? (node as Record<string, unknown>)[part]
            : undefined;
    }, catalog);
}

/** Every key a tour reads, for one tour. */
function tourKeys(tour: registry.Tour): string[] {
    return [
        `${tour.id}.name`,
        `${tour.id}.summary`,
        ...tour.steps.flatMap((step) => [
            `${tour.id}.steps.${step.key}.title`,
            `${tour.id}.steps.${step.key}.body`
        ])
    ];
}

const SHARED_KEYS = [
    "menu",
    "controls.next",
    "controls.previous",
    "controls.done",
    "controls.skip",
    "controls.progress",
    "offer.title",
    "offer.body",
    "offer.start",
    "empty.title",
    "empty.body",
    "list.title",
    "list.description",
    "search.take"
];

describe("tour registry", () => {
    it("has one tour per id, each with steps", () => {
        expect(registry.TOURS.map((tour) => tour.id).sort()).toEqual([...registry.TOUR_IDS].sort());
        for (const tour of registry.TOURS) expect(tour.steps.length).toBeGreaterThan(0);
    });

    it("gives every step a target that some element in the source carries", () => {
        for (const tour of registry.TOURS) {
            const keys = tour.steps.map((step) => step.key);
            expect(new Set(keys).size, tour.id).toBe(keys.length);
            for (const step of tour.steps) {
                expect(step.target, `${tour.id}.${step.key}`).toMatch(/^[a-z]+\.[a-z]+$/);
                expect(declared.has(step.target), `${tour.id}.${step.key} -> ${step.target}`).toBe(
                    true
                );
            }
        }
    });

    it("has every word in en-US and es-ES", () => {
        const keys = [...SHARED_KEYS, ...registry.TOURS.flatMap(tourKeys)];
        for (const [locale, catalog] of [
            ["en-US", enUS.tours],
            ["es-ES", esES.tours]
        ] as const) {
            for (const key of keys) {
                const value = lookup(catalog, key);
                expect(typeof value, `${locale} tours.${key}`).toBe("string");
                expect((value as string).trim(), `${locale} tours.${key}`).not.toBe("");
            }
        }
    });

    it("offers a tour only when its screen is reachable", () => {
        const ids = (reachable: string[]) =>
            registry.availableTours(new Set(reachable)).map((tour) => tour.id);
        expect(ids([])).toEqual(["overview"]);
        expect(ids(["/chat", "/account"])).toEqual(["overview", "chat", "settings"]);
        expect(ids(["/apps/deploy", "/apps/games", "/drive"])).toEqual([
            "overview",
            "drive",
            "deploy",
            "games"
        ]);
    });

    it("builds the address that starts a tour, and knows its screen", () => {
        const chat = registry.findTour("chat");
        const overview = registry.findTour("overview");
        expect(registry.tourHref(chat, "/drive")).toBe("/chat?tour=chat");
        expect(registry.tourHref(overview, "/drive/recent")).toBe("/drive/recent?tour=overview");
        expect(registry.onTourScreen(chat, "/chat/c/123")).toBe(true);
        expect(registry.onTourScreen(chat, "/chatter")).toBe(false);
        expect(registry.onTourScreen(overview, "/anything")).toBe(true);
        expect(registry.isTourId("chat")).toBe(true);
        expect(registry.isTourId("admin")).toBe(false);
        expect(registry.isTourId(undefined)).toBe(false);
    });

    it("skips the steps whose target is not usable", () => {
        const tour = registry.findTour("overview");
        const shown = registry.presentSteps(tour.steps, (target) => target !== "shell.sidebar");
        expect(shown.map((step) => step.target)).not.toContain("shell.sidebar");
        expect(shown).toHaveLength(tour.steps.length - 1);
        expect(registry.presentSteps(tour.steps, () => false)).toEqual([]);
    });
});

describe("tour targets on the page", () => {
    function place(html: string): HTMLElement {
        document.body.innerHTML = html;
        for (const element of document.querySelectorAll<HTMLElement>("[data-tour]")) {
            const size = element.dataset.size === "0" ? 0 : 40;
            element.getBoundingClientRect = () =>
                ({
                    width: size,
                    height: size,
                    top: 0,
                    left: 0,
                    right: size,
                    bottom: size
                }) as DOMRect;
        }
        return document.body;
    }

    it("finds a drawn, enabled target", () => {
        place(`<button data-tour="shell.account">Me</button>`);
        expect(usableTarget("shell.account")).not.toBeNull();
    });

    it("treats a missing, collapsed, hidden or disabled target as absent", () => {
        place(`
            <div data-tour="shell.sidebar" data-size="0"></div>
            <button data-tour="drive.upload" disabled>Upload</button>
            <div data-tour="deploy.create" aria-disabled="true"></div>
            <div aria-hidden="true"><div data-tour="chat.spaces"></div></div>
            <div data-tour="games.new" style="visibility: hidden"></div>
        `);
        for (const target of [
            "shell.sidebar",
            "drive.upload",
            "deploy.create",
            "chat.spaces",
            "games.new",
            "shell.search"
        ]) {
            expect(usableTarget(target), target).toBeNull();
        }
    });

    it("uses the visible one when several elements share a target", () => {
        place(`
            <div data-tour="games.list" data-size="0" id="empty"></div>
            <div data-tour="games.list" id="table"></div>
        `);
        expect(usableTarget("games.list")?.id).toBe("table");
        expect(isUsable(document.getElementById("empty")!)).toBe(false);
    });
});
