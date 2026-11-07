/**
 * "Does it work on my TV?": the data files hold their schema, the generator
 * still writes what is checked in, the search forgives the ways people type a
 * model number, and an unlisted TV gets the tier its platform earns.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import models from "../../src/tv-compat/models.json" with { type: "json" };
import quirks from "../../src/tv-compat/quirks.json" with { type: "json" };
import privacy from "../../src/tv-compat/privacy.json" with { type: "json" };
import debugging from "../../src/tv-compat/debugging.json" with { type: "json" };
import enWords from "../../../../apps/web/messages/en-US/tvCompat.json" with { type: "json" };
import esWords from "../../../../apps/web/messages/es-ES/tvCompat.json" with { type: "json" };
import * as tv from "../../src/tv-compat/index";

const script = join(__dirname, "..", "..", "..", "..", "scripts", "tv-compat-import.mjs");

describe("tv-compat data", () => {
    it("validates every model against the schema", () => {
        const parsed = tv.tvModelsSchema.safeParse(models);
        expect(parsed.success ? [] : parsed.error.issues.slice(0, 3)).toEqual([]);
        expect(tv.TV_MODELS.length).toBeGreaterThan(400);
    });

    it("labels every list by who really tested it", () => {
        for (const model of tv.TV_MODELS) {
            if (model.tested.by === "upstream-community")
                expect(model.source).toMatch(/\/tv\/examples\/[a-z0-9-]+$/);
            else expect(model.tested.by).toBe("community");
        }
        expect(tv.TV_MODELS.some((model) => model.tested.by === "polaris")).toBe(false);
    });

    it("keeps the tier and the launcher in step", () => {
        const wrong = { ...tv.TV_MODELS[0]!, tier: "network" as const };
        expect(tv.tvModelSchema.safeParse(wrong).success).toBe(false);
    });

    it("documents every quirk once, with a link", () => {
        const ids = quirks.map((quirk) => tv.tvQuirkSchema.parse(quirk).id);
        expect([...ids].sort()).toEqual([...tv.TV_QUIRKS].sort());
    });

    it("validates the privacy switches and finds them by brand", () => {
        expect(tv.tvPrivacySchema.safeParse(privacy).success).toBe(true);
        const roku = tv.privacyFor({ brand: "Roku", platform: "roku" });
        expect(roku.map((entry) => entry.id)).toEqual(["roku"]);
        const tcl = tv.privacyFor({ brand: "TCL", platform: "google-tv" });
        expect(tcl.map((entry) => entry.id)).toEqual(["tcl", "google-tv"]);
        const fire = tv.privacyFor({ brand: "Amazon Fire TV", platform: "fire-os" });
        expect(fire.map((entry) => entry.id)).toEqual(["fire-tv"]);
    });

    it("says how to turn on debugging on every platform the installer reaches", () => {
        expect(tv.tvDebuggingSchema.safeParse(debugging).success).toBe(true);
        const platforms = tv.TV_DEBUGGING.platforms.flatMap((entry) => entry.platforms);
        expect(new Set(platforms).size).toBe(platforms.length);
        for (const model of tv.TV_MODELS.filter((one) => one.install !== "none"))
            expect(tv.debuggingFor(model.platform)?.id, model.id).toBeDefined();
        expect(tv.debuggingFor("fire-os")?.switches).toEqual(["ADB debugging"]);
        expect(tv.debuggingFor("webos")).toBeUndefined();
    });

    it("words every privacy step in both languages", () => {
        const ids = tv.TV_PRIVACY.brands.flatMap((entry) => entry.steps.map((step) => step.id));
        expect(new Set(ids).size).toBe(ids.length);
        for (const words of [enWords, esWords])
            expect(Object.keys(words.privacy.steps).sort()).toEqual([...ids].sort());
    });

    it("is what the generator writes from tv/examples", () => {
        expect(() =>
            execFileSync(process.execPath, [script, "--check"], {
                stdio: "pipe",
                windowsHide: true
            })
        ).not.toThrow();
    });
});

describe("tv.searchTvModels", () => {
    const ids = (query: string, brand?: string) =>
        tv.searchTvModels(tv.TV_MODELS, query, { brand }).map((model) => model.id);

    it("matches a model number with or without its dashes and spaces", () => {
        expect(tv.compactModel("55-C71K")).toBe("55c71k");
        const dashed = ids("KD-75XE8596");
        expect(dashed.length).toBeGreaterThan(0);
        expect(ids("kd75xe8596")).toEqual(dashed);
        expect(ids("kd 75xe8596")[0]).toBe(dashed[0]);
    });

    it("forgives a typo in a brand", () => {
        const found = tv.searchTvModels(tv.TV_MODELS, "philps");
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((model) => model.brand === "Philips")).toBe(true);
    });

    it("ranks the brand typed above models that only mention it", () => {
        const found = tv.searchTvModels(tv.TV_MODELS, "sony");
        expect(found[0]!.brand).toBe("Sony");
    });

    it("finds by platform, and narrows by brand chip", () => {
        const fire = tv.searchTvModels(tv.TV_MODELS, "fire os");
        expect(fire.length).toBeGreaterThan(0);
        expect(fire.every((model) => model.platform === "fire-os")).toBe(true);
        const tcl = tv.searchTvModels(tv.TV_MODELS, "google tv", { brand: "tcl" });
        expect(tcl.every((model) => model.brand === "TCL")).toBe(true);
    });

    it("answers nothing for a model no list names", () => {
        expect(ids("zzqx9000")).toEqual([]);
    });

    it("counts brands most first", () => {
        const counts = tv.tvBrandCounts(tv.TV_MODELS);
        expect(counts[0]!.count).toBeGreaterThanOrEqual(counts[1]!.count);
        expect(counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(tv.TV_MODELS.length);
    });
});

describe("tv.tierFor, for a TV that is not listed", () => {
    it("makes any Android TV or Google TV from 8 on a Home screen", () => {
        expect(tv.tierFor("android-tv", "8.0").tier).toBe("full");
        expect(tv.tierFor("google-tv", "14").tier).toBe("full");
        expect(tv.tierFor("google-tv", null).tier).toBe("full");
        expect(tv.tierFor("android-tv", "7.1")).toEqual({
            tier: "network",
            quirks: ["android-too-old"]
        });
    });

    it("opens as an app on Fire TV, except Fire OS 5", () => {
        expect(tv.tierFor("fire-os", "7.7.1.7").tier).toBe("app");
        expect(tv.tierFor("fire-os", "5.2").tier).toBe("network");
    });

    it("does not claim LG or Samsung before their apps ship", () => {
        expect(tv.tierFor("webos", "6")).toEqual({ tier: "network", quirks: ["app-coming"] });
        expect(tv.tierFor("tizen", "7").tier).toBe("network");
        for (const platform of ["roku", "vizio", "vidaa", "other"] as const)
            expect(tv.tierFor(platform).tier).toBe("network");
    });

    it("agrees with the tier every listed model was given", () => {
        for (const model of tv.TV_MODELS.filter((one) => !one.quirks.includes("huawei-refusal")))
            expect(tv.tierFor(model.platform, model.osVersion).tier).toBe(model.tier);
    });

    it("says every listed model's platform quirks, and calls an old plain Android too old", () => {
        for (const model of tv.TV_MODELS.filter((one) => one.tested.by === "upstream-community"))
            expect(model.quirks).toEqual(
                expect.arrayContaining([...tv.tierFor(model.platform, model.osVersion).quirks])
            );
        expect(tv.tierFor("android", "7.0").quirks).toEqual(["android-too-old"]);
        expect(tv.tierFor("android", "11").quirks).toEqual(["android-check"]);
    });
});
