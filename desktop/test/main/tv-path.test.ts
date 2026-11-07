/**
 * The install path per TV, read from the "Does it work on my TV?" data: every
 * listed model gets the route, Home rule and after-install steps its entry
 * implies, and an unlisted TV is placed by what it says about itself.
 */

import models from "@tv-compat/models.json";
import { describe, expect, it } from "vitest";
import type { TvModel } from "@tv-compat/schema";
import { TCL_APPOPS, choosePath, matchModel, type TvSighting } from "@/main/tv-path";

const TV_MODELS = models as readonly TvModel[];
const SWEPT: TvSighting = { services: [], adbOpen: true };
const CLOSED: TvSighting = { services: [] };

const maker = (model: TvModel) => model.brand.toLowerCase().split(/\s+/)[0];
/** Makers with any set the Home switch left unable to start: every set of theirs is refused. */
const REFUSED = new Set(TV_MODELS.filter((model) => model.quirks.includes("huawei-refusal")).map(maker));
const TCL = new Set(TV_MODELS.filter((model) => model.quirks.includes("tcl-autostart")).map(maker));

/** What the data says this model's install should be. */
function expected(model: TvModel) {
    const route = model.install === "none" ? "network-only" : model.install === "desktop-pairing" ? "pairing" : "network";
    const home =
        model.install === "none" || model.quirks.includes("fire-home-amazon")
            ? "app-only"
            : REFUSED.has(maker(model))
              ? "refused-by-maker"
              : "offered";
    return { route, home, tcl: model.quirks.includes("tcl-autostart") || (TCL.has(maker(model)) && model.platform !== "fire-os") };
}

describe("choosePath from the checker data", () => {
    it.each(TV_MODELS.map((model) => [model.id, model] as const))("%s", (_id, model) => {
        const want = expected(model);
        // Found by its Cast name, before connecting, with the debugging port still closed.
        const path = choosePath({ services: ["googlecast"], castModel: model.model }, null);
        expect(path.model?.id).toBe(model.id);
        expect(path.route).toBe(want.route);
        if (want.route !== "network-only") {
            expect(path.home).toBe(want.home);
            expect(path.afterInstall).toEqual(want.tcl ? TCL_APPOPS : []);
            expect(path.instruction.platforms).toContain(model.platform);
        }
    });
});

describe("choosePath from discovery", () => {
    it("takes the debugging port when it answers, even on a set that usually needs pairing", () => {
        const pairing = TV_MODELS.find((model) => model.install === "desktop-pairing")!;
        expect(choosePath({ ...SWEPT, castModel: pairing.model }).route).toBe("network");
        expect(choosePath({ services: ["adb"], castModel: pairing.model }).route).toBe("network");
    });

    it("needs pairing when only the Wireless debugging services answer", () => {
        for (const service of ["adb-tls-connect", "adb-tls-pairing"] as const) {
            const path = choosePath({ services: [service] });
            expect(path.route).toBe("pairing");
            expect(path.reason).toBe("google-pairing");
        }
    });

    it("waits on a typed address with the plain Android TV instruction", () => {
        const path = choosePath(CLOSED);
        expect(path.route).toBe("network");
        expect(path.home).toBe("offered");
        expect(path.instruction.switches.length).toBeGreaterThan(0);
    });

    it("does not guess a model from a name too short or unknown", () => {
        expect(matchModel("TV")).toBeNull();
        expect(matchModel("Nothing Like It 9000")).toBeNull();
    });
});

describe("choosePath from what the TV says", () => {
    const tv = (manufacturer: string, model = "Unlisted 1", sdk: number | null = 30) => choosePath(SWEPT, { manufacturer, model, sdk });

    it("refuses the Home switch on Huawei and Kalley by maker", () => {
        expect(tv("HUAWEI").home).toBe("refused-by-maker");
        expect(tv("Kalley").home).toBe("refused-by-maker");
        expect(tv("HUAWEI").reason).toBe("huawei-refusal");
    });

    it("keeps Fire TV an app with Home left to Amazon", () => {
        const path = tv("Amazon");
        expect(path.platform).toBe("fire-os");
        expect(path.home).toBe("app-only");
        expect(path.instruction.switches).toEqual(["ADB debugging"]);
    });

    it("allows TCL's autostart app-ops after the install", () => {
        const path = tv("TCL");
        expect(path.afterInstall).toEqual(TCL_APPOPS);
        expect(path.home).toBe("offered");
        expect(path.reason).toBe("tcl-autostart");
    });

    it("leaves any other Android TV the Home switch and nothing extra", () => {
        const path = tv("Sony");
        expect(path).toMatchObject({ route: "network", home: "offered", afterInstall: [], reason: null });
    });

    it("sends a TV older than Android 8 to the Network filter", () => {
        const path = tv("Sony", "Unlisted 1", 25);
        expect(path.route).toBe("network-only");
        expect(path.reason).toBe("android-too-old");
    });

    it("never needs pairing once the TV has answered", () => {
        expect(choosePath({ services: ["adb-tls-pairing"] }, { manufacturer: "Google", model: "x", sdk: 34 }).route).toBe("network");
    });
});
