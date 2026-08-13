/**
 * What a saved server carries, and - far more importantly - what it must not.
 *
 * A template is the difference between a built server and a fresh one built the
 * same way. Storing the whole environment instead would freeze the defaults of the
 * day it was saved into every server made from it, so a template written before an
 * image update would quietly undo the update on everything built after it.
 *
 * The exclusions are the part with teeth. A port copied forward is two servers
 * fighting over it; a level name copied is a second server pointed at the first
 * one's world; a password copied is a secret sitting in a list.
 */

import { describe, expect, it } from "vitest";
import { copyable, isTemplateName, readTemplateSettings, templateSettings } from "@/lib/apps/game-templates";

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("what travels", () => {
    it("keeps only what differs from a fresh server of the same kind", () => {
        const built = map({ VIEW_DISTANCE: "16", DIFFICULTY: "hard", MODE: "survival" });
        const fresh = map({ VIEW_DISTANCE: "10", DIFFICULTY: "hard", MODE: "survival" });
        expect(templateSettings(built, fresh)).toEqual({ VIEW_DISTANCE: "16" });
    });

    it("treats a setting the fresh one has never heard of as a difference", () => {
        expect(templateSettings(map({ SPAWN_PROTECTION: "0" }), map({}))).toEqual({ SPAWN_PROTECTION: "0" });
    });

    it("does not carry a blank, which is the absence of a choice", () => {
        // Carried, it would write emptiness over the new server's own default.
        expect(templateSettings(map({ MOTD_EXTRA: "   " }), map({}))).toEqual({});
    });
});

describe("what must never travel", () => {
    it("refuses the things that identify one particular server", () => {
        for (const key of ["SERVER_PORT", "RCON_PORT", "RCON_PASSWORD", "LEVEL", "WORLD", "SEED", "MOTD"]) {
            expect(copyable(key), key).toBe(false);
        }
    });

    it("refuses the lists of who may join, and the secrets", () => {
        for (const key of ["OPS", "WHITELIST", "ALLOW_LIST", "SERVER_PASSWORD", "ADMIN_PASSWORD"]) {
            expect(copyable(key), key).toBe(false);
        }
    });

    it("keeps them out even when they arrive through the stored column", () => {
        // The row is written by Polaris, but a template made before a rule was
        // added would still hold what that rule now refuses.
        expect(readTemplateSettings('{"VIEW_DISTANCE":"16","RCON_PASSWORD":"hunter2"}')).toEqual({
            VIEW_DISTANCE: "16"
        });
    });

    it("keeps the ordinary settings", () => {
        for (const key of ["VIEW_DISTANCE", "DIFFICULTY", "MODRINTH_PROJECTS", "MEMORY"]) {
            expect(copyable(key), key).toBe(true);
        }
    });
});

describe("reading one back", () => {
    it("survives a column that is not what it should be", () => {
        expect(readTemplateSettings("nonsense")).toEqual({});
        expect(readTemplateSettings("[]")).toEqual({});
        expect(readTemplateSettings('{"VIEW_DISTANCE":16}')).toEqual({});
    });

    it("wants a name somebody can pick out of a list later", () => {
        expect(isTemplateName("My survival setup")).toBe(true);
        expect(isTemplateName("   ")).toBe(false);
        expect(isTemplateName("x".repeat(61))).toBe(false);
    });
});
