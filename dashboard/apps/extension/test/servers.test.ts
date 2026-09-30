/**
 * The list of Polaris servers, and which account a switch brings back.
 *
 * What would be silently wrong here: a server listed twice, an install from
 * before the list showing none at all, a switch that lands on the account left
 * longest ago instead of the last one, and a name that is only whitespace
 * hiding the host.
 */

import { describe, expect, it } from "vitest";
import {
    SERVER_NAME_MAX,
    accountOn,
    describeServer,
    listServers,
    normalizeServerName,
    renameServer,
    serverNameProblem,
    withServer,
    withoutServer
} from "../src/lib/servers";

const HOME = "https://home.example.com";
const WORK = "https://work.example.com";

describe("the saved list", () => {
    it("adds a server once, however often it is remembered", () => {
        const once = withServer([], HOME);
        expect(withServer(once, HOME)).toEqual([{ origin: HOME, name: null }]);
        expect(withServer(once, WORK).map((one) => one.origin)).toEqual([HOME, WORK]);
    });

    it("renames one server and leaves the rest alone", () => {
        const saved = withServer(withServer([], HOME), WORK);
        expect(renameServer(saved, WORK, "Office")).toEqual([
            { origin: HOME, name: null },
            { origin: WORK, name: "Office" }
        ]);
        expect(renameServer(saved, "https://nowhere.example.com", "x")).toEqual(saved);
    });

    it("removes one server", () => {
        const saved = withServer(withServer([], HOME), WORK);
        expect(withoutServer(saved, HOME)).toEqual([{ origin: WORK, name: null }]);
    });
});

describe("what the popup lists", () => {
    it("marks the server in front and counts the accounts on each", () => {
        const listed = listServers(
            [
                { origin: HOME, name: "Home" },
                { origin: WORK, name: null }
            ],
            WORK,
            [HOME, WORK, WORK]
        );
        expect(listed).toEqual([
            { origin: HOME, name: "Home", host: "home.example.com", active: false, accounts: 1 },
            { origin: WORK, name: null, host: "work.example.com", active: true, accounts: 2 }
        ]);
    });

    it("shows the servers an install from before the list already has", () => {
        // Nothing saved at all: the address in front and a parked account on
        // another server are still two servers to switch between.
        const listed = listServers([], HOME, [WORK, HOME]);
        expect(listed.map((one) => [one.origin, one.active])).toEqual([
            [WORK, false],
            [HOME, true]
        ]);
    });

    it("lists nothing before any address has been given", () => {
        expect(listServers([], null, [])).toEqual([]);
    });
});

describe("the account a switch brings back", () => {
    const parked = [
        { id: "a", origin: HOME },
        { id: "b", origin: WORK },
        { id: "c", origin: HOME }
    ];

    it("is the one on that server set aside most recently", () => {
        expect(accountOn(parked, HOME)?.id).toBe("c");
        expect(accountOn(parked, WORK)?.id).toBe("b");
    });

    it("is none on a server nobody is signed in to", () => {
        expect(accountOn(parked, "https://new.example.com")).toBeNull();
    });
});

describe("a server name", () => {
    it("is trimmed and its inner spaces collapsed before it is stored", () => {
        expect(normalizeServerName("  Home   lab ")).toBe("Home lab");
    });

    it("gives the row its host back when emptied", () => {
        expect(normalizeServerName("   ")).toBeNull();
        expect(describeServer({ name: null, host: "home.example.com" })).toBe("home.example.com");
        expect(describeServer({ name: "Home", host: "home.example.com" })).toBe("Home");
    });

    it("is refused past the length a row has room for, counted after normalizing", () => {
        expect(serverNameProblem("x".repeat(SERVER_NAME_MAX))).toBeNull();
        expect(serverNameProblem("x".repeat(SERVER_NAME_MAX + 1))).toBe("tooLong");
        expect(serverNameProblem(normalizeServerName(` ${"x".repeat(SERVER_NAME_MAX)} `))).toBeNull();
        expect(serverNameProblem(null)).toBeNull();
    });
});
