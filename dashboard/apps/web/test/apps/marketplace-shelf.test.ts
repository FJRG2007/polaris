/**
 * What the marketplace says about where an app comes from.
 *
 * A store that does not name the publisher is a store nobody should install
 * from, and this one did not: every card was a name, a sentence and an Install
 * button. What is asserted here is that the answer is *derived* rather than
 * typed - it is read off the image the app will actually pull onto somebody's
 * server, so it cannot go stale, and a manifest added later cannot ship without
 * one because there is nowhere to forget to fill in.
 *
 * The case worth naming: an app Polaris builds and an app that runs somebody
 * else's container must not read the same. Getting that backwards is a claim
 * about a third party made on Polaris's behalf.
 */

import { describe, expect, it } from "vitest";
import { appProvenance } from "@/lib/apps/provenance";
import { POLARIS_APP_CATALOG, findApp, isOffered, type AppManifest } from "@/lib/apps/catalog";

/** A manifest with just enough on it to be asked about. */
function app(over: Partial<AppManifest>): AppManifest {
    return {
        id: "test",
        name: "Test",
        category: "Tools",
        icon: (() => null) as unknown as AppManifest["icon"],
        summary: "",
        description: "",
        installMethod: "compose-template",
        capabilities: ["tool"],
        dashboard: "builtin",
        ...over
    } as AppManifest;
}

describe("who is behind an app", () => {
    it("names Polaris for one it builds itself", () => {
        const from = appProvenance(
            app({ template: { image: "ghcr.io/fjrg2007/polaris-camera-relay:latest" } })
        );
        expect(from).toMatchObject({ developer: "Polaris", distributor: "Polaris", firstParty: true });
    });

    it("names Polaris for an app that runs no container at all", () => {
        // A screen Polaris draws. There is no image to attribute to anybody else.
        const from = appProvenance(app({ installMethod: "builtin" }));
        expect(from.firstParty).toBe(true);
    });

    it("names the account that publishes somebody else's image", () => {
        const from = appProvenance(app({ template: { image: "itzg/minecraft-server:latest" } }));
        expect(from.distributor).toBe("itzg");
        expect(from.firstParty).toBe(false);
    });

    it("prefers the site the manifest documents to the registry account", () => {
        // Whoever wrapped a thing in a container is often not whoever makes it,
        // and the docs link is the other thing actually known.
        const from = appProvenance(
            app({
                template: { image: "spritsail/fivem:latest" },
                docsUrl: "https://docs.fivem.net/docs/server-manual/setting-up-a-server/"
            })
        );
        expect(from.developer).toBe("docs.fivem.net");
        expect(from.distributor).toBe("spritsail");
    });

    it("reads an account out of a registry-qualified image", () => {
        const from = appProvenance(app({ template: { image: "ghcr.io/someone/thing:1.2" } }));
        expect(from.distributor).toBe("someone");
    });

    it("says so when an image has no account at all", () => {
        // `redis:7` is one of the registry's own, and "Third party" would be a
        // worse answer than naming what it actually is.
        const from = appProvenance(app({ template: { image: "redis:7" } }));
        expect(from.distributor).toBe("Docker Official Images");
    });

    it("never leaves a card with nothing to say", () => {
        for (const manifest of POLARIS_APP_CATALOG) {
            const from = appProvenance(manifest);
            expect(from.developer.length, manifest.id).toBeGreaterThan(0);
            expect(from.distributor.length, manifest.id).toBeGreaterThan(0);
        }
    });
});

describe("what the shelf offers", () => {
    it("keeps an app's own parts off it", () => {
        // A camera relay and a Minecraft server are what two apps run, not two
        // apps somebody installed. Each names the app that creates it.
        for (const id of ["camera-hub", "face-recognizer", "vision-worker", "minecraft", "ark"]) {
            const manifest = findApp(id);
            expect(manifest, id).toBeDefined();
            expect(manifest?.internal, id).toBe(true);
            expect(manifest?.ownedBy, id).toBeTruthy();
            expect(isOffered(manifest as AppManifest), id).toBe(false);
        }
    });

    it("offers the apps that own them", () => {
        for (const id of ["home", "game-servers"]) {
            const manifest = findApp(id);
            expect(isOffered(manifest as AppManifest), id).toBe(true);
        }
    });

    it("points every internal app at an app that exists", () => {
        // An `ownedBy` naming nothing would leave its installs unattributable,
        // which is how they end up drawn as independent apps again.
        for (const manifest of POLARIS_APP_CATALOG) {
            if (!manifest.ownedBy) continue;
            expect(findApp(manifest.ownedBy), manifest.id).toBeDefined();
        }
    });
});
