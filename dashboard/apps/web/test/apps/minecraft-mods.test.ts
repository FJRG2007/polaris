/**
 * Browsing Modrinth on behalf of one particular server.
 *
 * Everything here exists because a mod that does not fit fails quietly: the
 * server boots without it, or refuses to boot, hours later, with the reason in a
 * log nobody opens. So what is asserted is that the server's own constraints
 * actually reach the query - its loader, its release, and that a project has a
 * server side at all - and that what comes back is read strictly enough that
 * somebody else's database cannot put a URL of their choosing into a page an
 * operator is logged into.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    categoriesForLoader,
    isCategoryFor,
    isModrinthIcon,
    loaderForType,
    parseProjectList,
    projectSlug,
    readConflicts,
    readInstalledProjects,
    searchModrinth
} from "@/lib/apps/minecraft/modrinth";

/** Every URL Modrinth was asked for, and what it was answered with. */
let asked: string[] = [];
let answers: Map<string, unknown>;

beforeEach(() => {
    asked = [];
    answers = new Map();
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        // Matched on the path so a test does not have to reproduce the exact query
        // string it is asserting about.
        for (const [fragment, body] of answers) {
            if (url.includes(fragment)) {
                return { ok: true, json: async () => body } as unknown as Response;
            }
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
});

/** The facets of the one search that was made, decoded. */
function facetsOf(url: string): string[][] {
    const value = new URL(url).searchParams.get("facets") ?? "[]";
    return JSON.parse(value) as string[][];
}

describe("what a server is offered", () => {
    it("asks only for what its own software can load", async () => {
        answers.set("/search", { hits: [] });
        await searchModrinth("worldedit", "paper");
        const facets = facetsOf(asked[0]!);
        expect(facets).toContainEqual(["project_type:plugin"]);
        expect(facets).toContainEqual(["categories:paper"]);
    });

    it("asks only for what has a build for the release it runs", async () => {
        answers.set("/search", { hits: [] });
        await searchModrinth("", "fabric", { version: "1.21.4" });
        expect(facetsOf(asked[0]!)).toContainEqual(["versions:1.21.4"]);
    });

    it("does not filter by a version that is not one", async () => {
        // A server on LATEST is on no particular release, and inventing one would
        // hide everything that does not happen to support it.
        answers.set("/search", { hits: [] });
        await searchModrinth("", "fabric", { version: "LATEST" });
        expect(JSON.stringify(facetsOf(asked[0]!))).not.toContain("versions:");
    });

    it("leaves out the mods that do nothing on a server", async () => {
        // A client-only mod installs cleanly, changes nothing, and leaves somebody
        // convinced their server is broken.
        answers.set("/search", { hits: [] });
        await searchModrinth("sodium", "fabric");
        expect(facetsOf(asked[0]!)).toContainEqual(["server_side:required", "server_side:optional"]);
    });

    it("does not ask a plugin server about server_side", async () => {
        // A plugin is server-side by definition and Modrinth does not always tag
        // one, so the facet would filter out most of what exists.
        answers.set("/search", { hits: [] });
        await searchModrinth("", "paper");
        expect(JSON.stringify(facetsOf(asked[0]!))).not.toContain("server_side");
    });

    it("opens on what is popular rather than on nothing", async () => {
        answers.set("/search", { hits: [] });
        await searchModrinth("", "paper");
        expect(asked[0]).toContain("index=downloads");
        expect(asked[0]).not.toContain("query=");
    });

    it("comes back empty when Modrinth cannot be reached", async () => {
        // A browser that cannot reach the index is a browser with no results, not
        // a broken page.
        expect(await searchModrinth("anything", "paper")).toEqual([]);
    });

    it("drops an icon that is not Modrinth's own", async () => {
        answers.set("/search", {
            hits: [
                { slug: "good", title: "Good", icon_url: "https://cdn.modrinth.com/data/x/icon.png" },
                { slug: "bad", title: "Bad", icon_url: "https://someone-else.example/track.png" }
            ]
        });
        const projects = await searchModrinth("", "paper");
        expect(projects[0]!.iconUrl).toBe("https://cdn.modrinth.com/data/x/icon.png");
        expect(projects[1]!.iconUrl).toBeNull();
    });
});

describe("an icon url", () => {
    it("has to be Modrinth over https", () => {
        expect(isModrinthIcon("https://cdn.modrinth.com/data/x/icon.png")).toBe(true);
        expect(isModrinthIcon("http://cdn.modrinth.com/data/x/icon.png")).toBe(false);
        expect(isModrinthIcon("https://cdn.modrinth.com.evil.example/x.png")).toBe(false);
        expect(isModrinthIcon("javascript:alert(1)")).toBe(false);
        expect(isModrinthIcon(null)).toBe(false);
    });
});

describe("what is already on the list", () => {
    it("reads back as the projects they are, not as slugs", async () => {
        answers.set("/projects?ids=", [
            {
                id: "AAAA",
                slug: "coreprotect",
                title: "CoreProtect",
                description: "Block history",
                game_versions: ["1.21.4"],
                loaders: ["paper"]
            }
        ]);
        const [entry] = await readInstalledProjects(["coreprotect?"], "paper", "1.21.4");
        expect(entry).toMatchObject({ title: "CoreProtect", known: true, fitsVersion: true, fitsLoader: true });
        // The entry is kept exactly as the container holds it, so taking it off
        // does not have to guess at the image's own syntax.
        expect(entry!.entry).toBe("coreprotect?");
    });

    it("keeps an entry Modrinth has never heard of, and says so", async () => {
        // Dropping it would show a shorter list than the server is going to try to
        // install, which is the one thing this screen must not do.
        answers.set("/projects?ids=", []);
        const [entry] = await readInstalledProjects(["nonesuch"], "paper", "1.21.4");
        expect(entry).toMatchObject({ slug: "nonesuch", known: false });
    });

    it("names a project with no build for the release the server is on", async () => {
        answers.set("/projects?ids=", [
            { id: "AAAA", slug: "grimac", title: "GrimAC", game_versions: ["1.20.1"], loaders: ["paper"] }
        ]);
        const [entry] = await readInstalledProjects(["grimac"], "paper", "1.21.4");
        expect(entry!.fitsVersion).toBe(false);
    });

    it("claims nothing about the version when the server is on LATEST", async () => {
        // "No build for an unknown version" is not a claim anybody can make.
        answers.set("/projects?ids=", [
            { id: "AAAA", slug: "grimac", title: "GrimAC", game_versions: ["1.20.1"], loaders: ["paper"] }
        ]);
        const [entry] = await readInstalledProjects(["grimac"], "paper", null);
        expect(entry!.fitsVersion).toBeNull();
    });

    it("does not hold a missing loader list against a project", async () => {
        answers.set("/projects?ids=", [
            { id: "AAAA", slug: "grimac", title: "GrimAC", game_versions: ["1.21.4"], loaders: [] }
        ]);
        const [entry] = await readInstalledProjects(["grimac"], "paper", "1.21.4");
        expect(entry!.fitsLoader).toBe(true);
    });
});

describe("conflicts between them", () => {
    /** Two projects, one of which declares it cannot run beside the other. */
    function twoProjects(dependencyType: string, targetId: string) {
        answers = new Map<string, unknown>([
            [
                "/projects?ids=",
                [
                    { id: "AAAA", slug: "one", title: "One", game_versions: [], loaders: ["paper"] },
                    { id: "BBBB", slug: "two", title: "Two", game_versions: [], loaders: ["paper"] }
                ]
            ],
            [
                "/project/one/version",
                [{ dependencies: [{ project_id: targetId, dependency_type: dependencyType }] }]
            ],
            ["/project/two/version", [{ dependencies: [] }]]
        ]);
    }

    it("reports what a publisher says cannot run beside what is here", async () => {
        twoProjects("incompatible", "BBBB");
        expect(await readConflicts(["one", "two"], "paper")).toEqual([{ slug: "one", withSlug: "two" }]);
    });

    it("says nothing about a required dependency", async () => {
        // Needing something is not clashing with it, and the image installs
        // required dependencies by itself.
        twoProjects("required", "BBBB");
        expect(await readConflicts(["one", "two"], "paper")).toEqual([]);
    });

    it("says nothing about something that is not on the list", async () => {
        // An incompatibility with a project nobody installed is not a problem this
        // server has.
        twoProjects("incompatible", "CCCC");
        expect(await readConflicts(["one", "two"], "paper")).toEqual([]);
    });

    it("does not go looking when there is only one thing installed", async () => {
        expect(await readConflicts(["one"], "paper")).toEqual([]);
        expect(asked).toEqual([]);
    });
});

describe("the shelves", () => {
    it("differ between a plugin server and a modded one", () => {
        // The same idea is filed under different tags, so one list with holes in
        // it would offer a shelf that is always empty.
        expect(categoriesForLoader("paper").some((entry) => entry.value === "economy")).toBe(true);
        expect(categoriesForLoader("fabric").some((entry) => entry.value === "economy")).toBe(false);
        expect(categoriesForLoader("fabric").some((entry) => entry.value === "technology")).toBe(true);
    });

    it("are the only ones a query may name", () => {
        // It goes into a request to somebody else's API, so it is checked rather
        // than passed through.
        expect(isCategoryFor("paper", "economy")).toBe(true);
        expect(isCategoryFor("paper", "")).toBe(true);
        expect(isCategoryFor("paper", "technology")).toBe(false);
        expect(isCategoryFor("paper", "anything at all")).toBe(false);
    });
});

describe("the list the container is given", () => {
    it("is read back the way the image writes it", () => {
        expect(parseProjectList("grimac?,coreprotect?,luckperms?")).toEqual([
            "grimac?",
            "coreprotect?",
            "luckperms?"
        ]);
        expect(projectSlug("grimac?")).toBe("grimac");
        expect(projectSlug("coreprotect:1.2.3")).toBe("coreprotect");
        // A file rather than a project, which nothing can be asked about.
        expect(projectSlug("@/mods/thing.jar")).toBeNull();
    });

    it("knows which software can load anything at all", () => {
        expect(loaderForType("PAPER")).toBe("paper");
        expect(loaderForType("purpur")).toBe("paper");
        expect(loaderForType("VANILLA")).toBeNull();
    });
});
