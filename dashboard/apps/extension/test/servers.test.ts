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
    readServers,
    renameServer,
    serverNameProblem,
    settleServers,
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
        expect(
            serverNameProblem(normalizeServerName(` ${"x".repeat(SERVER_NAME_MAX)} `))
        ).toBeNull();
        expect(serverNameProblem(null)).toBeNull();
    });
});

describe("the stored list, read back", () => {
    it("keeps well-formed rows as they are", () => {
        const saved = [
            { origin: HOME, name: "Home" },
            { origin: WORK, name: null }
        ];
        expect(readServers(saved)).toEqual(saved);
    });

    it("is empty for anything that is not a list", () => {
        for (const raw of [undefined, null, "x", 3, { origin: HOME }]) {
            expect(readServers(raw)).toEqual([]);
        }
    });

    it("drops rows with no usable address, and a second row for one address", () => {
        expect(
            readServers([
                null,
                "https://home.example.com",
                { origin: "ftp://files.example.com", name: "Files" },
                { origin: "https://home.example.com/path", name: "Path" },
                { origin: HOME, name: "Home" },
                { origin: HOME, name: "Again" }
            ])
        ).toEqual([{ origin: HOME, name: "Home" }]);
    });

    it("gives a row its host back when its name would not pass, rather than dropping it", () => {
        expect(
            readServers([
                { origin: HOME, name: "x".repeat(SERVER_NAME_MAX + 1) },
                { origin: WORK, name: 42 }
            ])
        ).toEqual([
            { origin: HOME, name: null },
            { origin: WORK, name: null }
        ]);
        expect(readServers([{ origin: HOME, name: "  Home   lab " }])).toEqual([
            { origin: HOME, name: "Home lab" }
        ]);
    });
});

describe("bringing an install up to date", () => {
    it("adds the address in front to an install that never had a list", () => {
        expect(settleServers(undefined, HOME)).toEqual([{ origin: HOME, name: null }]);
    });

    it("keeps names and order, and adds nothing already there", () => {
        const saved = [
            { origin: WORK, name: "Office" },
            { origin: HOME, name: "Home" }
        ];
        expect(settleServers(saved, HOME)).toEqual(saved);
        expect(settleServers(settleServers(saved, HOME), HOME)).toEqual(saved);
    });

    it("leaves the list alone with no address in front, or one that will not parse", () => {
        expect(settleServers([], null)).toEqual([]);
        expect(settleServers([], "not an address")).toEqual([]);
    });
});
