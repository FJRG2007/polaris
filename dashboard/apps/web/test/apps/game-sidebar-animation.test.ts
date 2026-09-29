/**
 * The side panel moving: lines that take turns between texts, and effects.
 *
 * What is pinned: a panel saved before any of this reads as the same panel;
 * lines with the same period turn together, so a heading and its list stay
 * matched; every effect keeps the line's own words and styles; no line is ever
 * written longer than one command carries; and the preview and the server draw
 * the same thing from the same clock.
 */

import { describe, expect, it } from "vitest";
import * as side from "@polaris-app/game-servers/src/lib/minecraft/sidebar";
import { stripMotd } from "@polaris-app/game-servers/src/lib/minecraft/motd";
import { javaComponent } from "@polaris-app/game-servers/src/lib/minecraft/announcement";
import { applyEffect } from "@polaris-app/game-servers/src/lib/minecraft/sidebar-effects";
import { renderSidebar } from "@polaris-app/game-servers/src/lib/minecraft/sidebar-render";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import {
    SIDEBAR_BLOCKS,
    withRotatingBlocks
} from "@polaris-app/game-servers/src/lib/minecraft/sidebar-blocks";
import { english } from "../setup/game-english";

const effect = (
    kind: side.SidebarEffectKind,
    extra: Partial<side.SidebarEffect> = {}
): side.SidebarEffect => ({
    ...side.NO_EFFECT,
    kind,
    ...extra
});

const plain = (text: string) => stripMotd(text);

describe("a panel saved before lines could move", () => {
    it("reads as the same panel, every line a plain one", () => {
        const stored = { enabled: true, title: "&6Hi", lines: ["one", "two"] };
        expect(side.readSidebar({ sidebar: stored })).toEqual({
            enabled: true,
            title: side.plainLine("&6Hi"),
            lines: [side.plainLine("one"), side.plainLine("two")]
        });
    });
});

describe("taking turns", () => {
    const line = { ...side.plainLine("a"), frames: ["a", "b", "c"], every: 5 };

    it("shows each text for its seconds, round and round", () => {
        expect([0, 4_999, 5_000, 10_000, 15_000].map((now) => side.frameAt(line, now))).toEqual([
            "a",
            "a",
            "b",
            "c",
            "a"
        ]);
    });

    it("turns a heading and the list under it together", () => {
        const lines = withRotatingBlocks(
            [],
            SIDEBAR_BLOCKS.slice(0, 3),
            8,
            side.SIDEBAR_LINES_MAX
        )!;
        expect(lines).toHaveLength(2);
        for (const now of [0, 8_000, 16_000]) {
            const heading = side.frameAt(lines[0]!, now);
            const list = side.frameAt(lines[1]!, now);
            const block = SIDEBAR_BLOCKS.find((one) => one.lines[0] === heading)!;
            expect(block.lines[1]).toBe(list);
        }
    });

    it("says how often the panel has to be drawn again, or that it never does", () => {
        expect(side.animationPeriod(side.DEFAULT_SIDEBAR)).toBeNull();
        expect(side.animationPeriod({ ...side.DEFAULT_SIDEBAR, lines: [line] })).toBe(5_000);
        expect(
            side.animationPeriod({
                ...side.DEFAULT_SIDEBAR,
                title: { ...side.plainLine("t"), effect: effect("shine", { speed: 500 }) }
            })
        ).toBe(500);
    });

    it("checks every text a line takes turns between", () => {
        const problems = side.sidebarProblems({
            ...side.DEFAULT_SIDEBAR,
            lines: [{ ...line, frames: ["ok", "x".repeat(41)] }]
        });
        expect(problems.lines[0]?.map((problem) => english(problem))).toEqual([
            null,
            "At most 40 characters"
        ]);
    });

    it("lets a scrolling line be longer than the panel is wide", () => {
        const long = {
            ...side.plainLine("x".repeat(100)),
            effect: effect("scroll", { width: 20 })
        };
        expect(side.sidebarProblems({ ...side.DEFAULT_SIDEBAR, lines: [long] }).lines[0]).toEqual([
            null
        ]);
    });
});

describe("effects", () => {
    it("keep the words, at every step, for the ones that only colour them", () => {
        for (const kind of ["rainbow", "wave", "shine", "blink"] as const) {
            for (const step of [0, 1, 7, 30]) {
                expect(plain(applyEffect("&6&lTop players", effect(kind), step))).toBe(
                    "Top players"
                );
            }
        }
    });

    it("keep the line's own styles: bold stays bold under a rainbow", () => {
        const out = applyEffect("&lBold", effect("rainbow"), 3);
        expect(out.match(/&l/g)?.length).toBeGreaterThan(0);
        expect(javaComponent(out, false)).toContain('"bold":true');
    });

    it("move: a rainbow is different one step later", () => {
        expect(applyEffect("Rainbow", effect("rainbow"), 1)).not.toBe(
            applyEffect("Rainbow", effect("rainbow"), 0)
        );
    });

    it("sweep a shine across, leaving the rest in its own colour", () => {
        const out = applyEffect("&6abcdefgh", effect("shine", { colors: ["#ffffff"] }), 4);
        expect(out).toContain("&f");
        expect(out).toContain("&6");
    });

    it("type a line out and hold it before starting over", () => {
        const typed = [0, 1, 2, 5, 8, 11].map((step) =>
            plain(applyEffect("Hello", effect("typewriter"), step))
        );
        // Five letters, then six steps held, then round again.
        expect(typed).toEqual(["", "H", "He", "Hello", "Hello", ""]);
    });

    it("slide a long text through a window of its width", () => {
        const text = "Welcome to Offgrid - be nice";
        const frames = [0, 1, 2].map((step) =>
            plain(applyEffect(text, effect("scroll", { width: 10 }), step))
        );
        expect(frames.map((one) => one.length)).toEqual([10, 10, 10]);
        expect(frames[0]).toBe("Welcome to");
        expect(frames[1]).toBe("elcome to ");
    });

    it("never write a line longer than one command carries", () => {
        const long = `&l&n${"W".repeat(40)}`;
        for (const kind of ["rainbow", "wave"] as const) {
            const out = applyEffect(
                long,
                effect(kind),
                2,
                (text) =>
                    commandBytes(
                        `scoreboard players display name polaris.line.00 polaris_side ${javaComponent(text, false)}`
                    ) <= COMMAND_BYTES_MAX
            );
            expect(plain(out)).toBe("W".repeat(40));
            expect(
                commandBytes(
                    `scoreboard players display name polaris.line.00 polaris_side ${javaComponent(out, false)}`
                )
            ).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        }
    });

    it("leave a line with no effect exactly as written", () => {
        expect(applyEffect("&6Hi {x}", side.NO_EFFECT, 9)).toBe("&6Hi {x}");
    });
});

describe("the panel at one moment", () => {
    const sidebar: side.SidebarConfig = {
        enabled: true,
        title: { ...side.plainLine("&6Polaris"), effect: effect("shine") },
        lines: [
            {
                ...side.plainLine("Most deaths"),
                frames: ["Most deaths", "Most time played"],
                every: 10
            },
            {
                ...side.plainLine("{rank.deaths}"),
                frames: ["{rank.deaths}", "{rank.playtime}"],
                every: 10
            }
        ]
    };
    const lists = {
        "rank.deaths": ["1. Steve 42", "2. Alex 30"],
        "rank.playtime": ["1. Alex 120h"]
    };
    const fill = (text: string) => text;

    it("shows the list of the text that is up, spread over its rows", () => {
        expect(renderSidebar(sidebar, 0, fill, lists).lines).toEqual([
            "Most deaths",
            "1. Steve 42",
            "2. Alex 30"
        ]);
        expect(renderSidebar(sidebar, 10_000, fill, lists).lines).toEqual([
            "Most time played",
            "1. Alex 120h"
        ]);
    });

    it("draws the title's effect at its step", () => {
        expect(renderSidebar(sidebar, 0, fill, lists).title).not.toBe(
            renderSidebar(sidebar, 4_000, fill, lists).title
        );
        expect(plain(renderSidebar(sidebar, 4_000, fill, lists).title)).toBe("Polaris");
    });
});
