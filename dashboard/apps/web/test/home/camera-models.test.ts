/**
 * Choosing the camera by name, and saying how it is powered.
 *
 * Two things this has to get right, and both of them were wrong before there was
 * a model to pick.
 *
 * The first is the search. A list of fifty is only usable if typing what is on
 * the box finds the thing on the box - and what is on the box is TP-Link, which
 * is a word that appears in none of these names.
 *
 * The second is the one that costs somebody a camera. What Polaris may do with a
 * camera - dial it every minute, hold a detector on it, poll the wall against it
 * - is decided by whether it is running off its own charge, and that is its
 * owner's answer rather than anything about the model. The same C425 is a camera
 * to watch all day on a cable and one to leave asleep on a pole, so nothing may
 * read the model alone and conclude either.
 */

import { describe, expect, it } from "vitest";
import { parseCameraInput } from "@/lib/home/schemas";
import { DEFAULT_DETECTION } from "@/lib/home/detection";
import {
    CAMERA_MODELS,
    askPowerFor,
    cameraBrands,
    connectionsFor,
    searchBrands,
    modelsOfBrand,
    cameraModel,
    drawsFromBattery,
    modelCanPan,
    searchModels,
    vendorForModel
} from "@/lib/home/camera-models";

describe("finding a camera by what is written on it", () => {
    it("finds the model by its own name", () => {
        expect(searchModels("C410")[0]?.id).toBe("tapo-c410");
        expect(searchModels("c410")[0]?.id).toBe("tapo-c410");
    });

    it("finds it by the make AND the model together, which is how anybody types it", () => {
        // The way somebody names the camera they own, and it found nothing: the
        // words were joined into "tapoc410", which is not a camera.
        for (const typed of ["tapo c410", "tp-link c410", "C410 tapo", "tplink  c410"]) {
            expect(searchModels(typed)[0]?.id).toBe("tapo-c410");
        }
    });

    it("narrows on a second word rather than widening", () => {
        const one = searchModels("tapo");
        const two = searchModels("tapo c4");
        expect(two.length).toBeLessThan(one.length);
        expect(two.every((model) => model.name.toLowerCase().startsWith("c4"))).toBe(true);
    });

    it("finds it by the maker's name, which is not in any of these names", () => {
        // The whole reason the search exists. Nobody thinks of these as Tapo
        // cameras when they are looking for the box they bought.
        for (const typed of ["tplink", "tp-link", "TP Link"]) {
            const found = searchModels(typed);
            expect(found.length).toBeGreaterThan(0);
            expect(found.every((model) => ["Tapo", "VIGI"].includes(model.brand))).toBe(true);
        }
    });

    it("puts an exact match first rather than fourteenth", () => {
        // "C420" also appears inside no other name, but "C4" does - a search
        // that ranks alphabetically buries the thing that was typed.
        expect(searchModels("C420")[0]?.name).toBe("C420");
        expect(searchModels("C4")[0]?.name.startsWith("C4")).toBe(true);
    });

    it("lists everything when nothing has been typed", () => {
        expect(searchModels("")).toHaveLength(CAMERA_MODELS.length);
        expect(searchModels("   ")).toHaveLength(CAMERA_MODELS.length);
    });

    it("answers nothing for a make nobody sells", () => {
        expect(searchModels("zxqw")).toHaveLength(0);
    });

    it("leaves a way through for a camera nobody listed", () => {
        // A picker that can only name known models is a picker somebody with an
        // unknown camera cannot get past.
        expect(searchModels("something else").map((model) => model.id)).toContain("generic-other");
        expect(searchModels("onvif").map((model) => model.id)).toContain("onvif-other");
    });
});

describe("what the model decides", () => {
    it("sends a battery model to the protocol that is its only way in", () => {
        for (const name of ["c400", "c410", "c420", "c425", "d230"]) {
            expect(vendorForModel(`tapo-${name}`)).toBe("tapo-battery");
        }
    });

    it("sends one the maker lists as answering RTSP to the profile that speaks it", () => {
        // RTSP by default on these, because it is the better transport for
        // video. The maker's own protocol stays available beside it.
        expect(vendorForModel("tapo-c210")).toBe("tapo");
        expect(vendorForModel("tapo-c310")).toBe("tapo");
    });

    it("falls back rather than guessing for a model this build never heard of", () => {
        expect(cameraModel("tapo-c999")).toBeNull();
        expect(vendorForModel("tapo-c999")).toBe("generic");
        expect(vendorForModel("")).toBe("generic");
        expect(vendorForModel(null)).toBe("generic");
    });

    it("keeps the movement arrows off a camera with a fixed lens", () => {
        expect(modelCanPan("tapo-c410")).toBe(false);
        expect(modelCanPan("tapo-c210")).toBe(true);
    });

    it("asks how it is powered only where the answer can be either", () => {
        expect(askPowerFor("tapo-c410")).toBe(true);
        expect(askPowerFor("tapo-d235")).toBe(true);
        expect(askPowerFor("tapo-c210")).toBe(false);
        expect(askPowerFor("reolink-other")).toBe(false);
    });

    it("names the condition on the three that answer RTSP only once wired", () => {
        // The maker's own wording, and the thing that makes these three
        // different from every other entry in the list.
        for (const id of ["tapo-d225", "tapo-d235", "tapo-td25"]) {
            expect(cameraModel(id)?.note).toContain("wired for power");
        }
        expect(cameraModel("tapo-c410")?.note).toBeUndefined();
    });
});

describe("whether a camera is spending its own charge", () => {
    it("is the owner's answer and not the model", () => {
        expect(drawsFromBattery("battery")).toBe(true);
        expect(drawsFromBattery("battery-solar")).toBe(true);
        expect(drawsFromBattery("mains")).toBe(false);
    });

    it("treats a camera nothing has been said about as plugged in", () => {
        // Which is what every camera added before this column existed is.
        expect(drawsFromBattery(null)).toBe(false);
        expect(drawsFromBattery(undefined)).toBe(false);
        expect(drawsFromBattery("")).toBe(false);
    });
});

describe("what is stored", () => {
    const camera = (over: Record<string, unknown>) =>
        parseCameraInput({
            name: "Garden",
            vendor: "generic",
            address: "192.168.1.64",
            detection: DEFAULT_DETECTION,
            ...over
        });

    it("takes the make from the model rather than from whatever was sent", () => {
        // The two used to be asked separately, which is two chances to disagree.
        expect(camera({ modelId: "tapo-c410", vendor: "reolink" }).vendor).toBe("tapo-battery");
    });

    it("keeps the make a camera from before the list was set up with", () => {
        expect(camera({ modelId: "", vendor: "reolink" }).vendor).toBe("reolink");
        expect(camera({ modelId: "tapo-c999", vendor: "reolink" }).vendor).toBe("reolink");
    });

    it("drops a power answer left over from a model that was changed", () => {
        // Pick a C410, say battery, change your mind to a C210: the C210 has no
        // battery, and a row saying it has one is a row the outage pass skips.
        expect(camera({ modelId: "tapo-c210", power: "battery" }).power).toBe("mains");
    });

    it("keeps it on a model that really can be either", () => {
        expect(camera({ modelId: "tapo-c410", power: "battery" }).power).toBe("battery");
        expect(camera({ modelId: "tapo-c410", power: "mains" }).power).toBe("mains");
    });

    it("treats a camera with nothing said about it as plugged in", () => {
        expect(camera({}).power).toBe("mains");
        expect(camera({}).modelId).toBe("");
    });
});

describe("the makes, and what each can be reached by", () => {
    it("offers every make in the list once, with what it covers", () => {
        const brands = cameraBrands();
        expect(brands.map((entry) => entry.brand)).toContain("Tapo");
        expect(new Set(brands.map((entry) => entry.brand)).size).toBe(brands.length);
        for (const entry of brands) {
            expect(modelsOfBrand(entry.brand)).toHaveLength(entry.count);
        }
    });

    it("gives a wired Tapo both ways in, RTSP first", () => {
        // RTSP is the better transport for video and it is what most of these
        // are already set up on. The maker's protocol is the one that needs no
        // camera account, which is why it stays on the list.
        expect(connectionsFor("tapo-c200")).toEqual(["tapo", "tapo-cloud"]);
    });

    it("gives a battery one the only way in it has", () => {
        expect(connectionsFor("tapo-c410")).toEqual(["tapo-battery"]);
    });

    it("puts the protocol first on the doorbells that need wiring for RTSP", () => {
        // Offering RTSP as the default would be defaulting to a setup most of
        // them are not in.
        expect(connectionsFor("tapo-d235")[0]).toBe("tapo-battery");
        expect(connectionsFor("tapo-d235")).toContain("tapo");
    });
});

describe("a camera that is already connected", () => {
    const camera = (over: Record<string, unknown>) =>
        parseCameraInput({
            name: "Studio",
            vendor: "generic",
            address: "192.168.1.143",
            detection: DEFAULT_DETECTION,
            ...over
        });

    it("keeps the transport it is working on when the model allows it", () => {
        // The regression this rule exists for: a C200 streaming over RTSP, whose
        // owner opened the form to change its name, was moved onto the other
        // protocol and lost its picture.
        expect(camera({ modelId: "tapo-c200", vendor: "tapo" }).vendor).toBe("tapo");
        expect(camera({ modelId: "tapo-c200", vendor: "tapo-cloud" }).vendor).toBe("tapo-cloud");
    });

    it("moves it only when the model cannot be reached that way at all", () => {
        expect(camera({ modelId: "tapo-c410", vendor: "tapo" }).vendor).toBe("tapo-battery");
    });

    it("takes the model's own first choice for a camera with nothing set yet", () => {
        expect(camera({ modelId: "tapo-c200", vendor: "" }).vendor).toBe("tapo");
    });
});

describe("finding the make", () => {
    it("finds it by its own name, however it is typed", () => {
        expect(searchBrands("tapo").map((entry) => entry.brand)).toContain("Tapo");
        expect(searchBrands("REOLINK").map((entry) => entry.brand)).toEqual(["Reolink"]);
    });

    it("finds it by the parent company, which is the name on the box", () => {
        const found = searchBrands("tp-link").map((entry) => entry.brand);
        expect(found).toContain("Tapo");
        expect(found).toContain("VIGI");
        expect(found).not.toContain("Reolink");
    });

    it("finds it by a camera it sells, for somebody who knows the model and not the brand", () => {
        // The reason this searches models too: knowing you own a C410 is common,
        // knowing TP-Link calls its camera line Tapo is not.
        expect(searchBrands("c410").map((entry) => entry.brand)).toEqual(["Tapo"]);
    });

    it("lists every make when nothing has been typed", () => {
        expect(searchBrands("")).toHaveLength(cameraBrands().length);
    });

    it("answers nothing for a make nobody sells", () => {
        expect(searchBrands("zxqw")).toHaveLength(0);
    });
});

describe("a camera on its own charge, with nothing said about it", () => {
    const camera = (over: Record<string, unknown>) =>
        parseCameraInput({
            name: "Garden",
            vendor: "generic",
            address: "192.168.1.64",
            detection: DEFAULT_DETECTION,
            ...over
        });

    it("watches nothing and keeps nothing", () => {
        // The defaults are written for a camera on a wire, where holding a
        // stream open costs nothing. On a battery the same defaults are a camera
        // that runs flat and switches itself off.
        const settled = camera({ modelId: "tapo-c410", power: "battery" });
        expect(settled.detector).toBe("none");
        expect(settled.recording).toBe("off");
    });

    it("does the same on a battery and a panel", () => {
        const settled = camera({ modelId: "tapo-c410", power: "battery-solar" });
        expect(settled.detector).toBe("none");
        expect(settled.recording).toBe("off");
    });

    it("keeps an answer its owner actually gave", () => {
        // They are warned what it costs at the place they give it, and it is
        // their camera.
        const settled = camera({
            modelId: "tapo-c410",
            power: "battery",
            detector: "objects",
            recording: "motion"
        });
        expect(settled.detector).toBe("objects");
        expect(settled.recording).toBe("motion");
    });

    it("leaves a camera on a wire with the defaults it always had", () => {
        const settled = camera({ modelId: "tapo-c200", power: "mains" });
        expect(settled.detector).toBe("camera");
        expect(settled.recording).toBe("motion");
    });

    it("keeps recording on for a battery model that is plugged in", () => {
        // Its detector still drops, but for the other reason entirely: this
        // model reports no movement of its own on any protocol. Nothing about
        // being plugged in should touch what is kept.
        const settled = camera({ modelId: "tapo-c410", power: "mains" });
        expect(settled.detector).toBe("none");
        expect(settled.recording).toBe("motion");
    });
});
