/**
 * Folding a set of servers into the rows on screen.
 *
 * Two things are worth pinning down here. What one row is doing has to be decided
 * in exactly one place, because the badge and the sort both read it - and a table
 * sorted by status that puts a green row above a red one is worse than one that
 * cannot be sorted at all. And a favourite is a promise about where a row sits:
 * whatever the sort, whatever the filter, it is at the top.
 */

import { describe, expect, it } from "vitest";
import type { GameServerFacts, GameServerLive } from "@/lib/apps/games-service";
import {
    canBrowseFiles,
    filterServers,
    nextSort,
    releaseLabel,
    sortServers,
    statusOf,
    uptimeLine,
    type ServerView
} from "@/app/(app)/apps/games/list";

function facts(over: Partial<GameServerFacts> = {}): GameServerFacts {
    return {
        id: "s",
        name: "Server",
        catalogId: "minecraft",
        catalogName: "Minecraft",
        game: "minecraft",
        applicationId: "app",
        serverName: "lirio-0",
        running: true,
        address: "survival.mc.example.com",
        slots: 20,
        release: "1.21.4",
        software: "Paper",
        edition: "java",
        crossplay: false,
        lastOnlineAt: null,
        onlineSince: null,
        message: null,
        ...over
    };
}

function live(over: Partial<GameServerLive> = {}): GameServerLive {
    return {
        id: "s",
        answering: true,
        containerRunning: true,
        online: 0,
        max: 20,
        players: [],
        message: null,
        crashLoop: null,
        ...over
    };
}

function server(name: string, over: Partial<ServerView> = {}): ServerView {
    return {
        id: name,
        name,
        catalogId: "minecraft",
        catalogName: "Minecraft",
        game: "minecraft",
        applicationId: "app",
        status: "running",
        canManage: true,
        canRemove: true,
        favorite: false,
        archived: false,
        facts: facts(),
        live: live(),
        ...over
    };
}

describe("what one row is doing", () => {
    it("keeps a failed install failed however the container reads", () => {
        expect(statusOf(server("a", { status: "failed", facts: facts({ running: false }) }))).toBe("failed");
    });

    it("tells a server nobody has stopped and that is not running from one that is stopped", () => {
        expect(statusOf(server("a", { live: live({ containerRunning: false, answering: false }) }))).toBe("down");
        expect(statusOf(server("b", { facts: facts({ running: false }) }))).toBe("stopped");
    });

    it("will not call a server online before the server itself has said so", () => {
        expect(statusOf(server("a", { live: null }))).toBe("starting");
        expect(statusOf(server("b", { live: live({ answering: false }) }))).toBe("starting");
        expect(statusOf(server("c"))).toBe("online");
    });

    it("says nothing about a server whose first read has not landed", () => {
        expect(statusOf(server("a", { facts: null, live: null }))).toBe("unknown");
    });
});

describe("searching and filtering", () => {
    const servers = [
        server("Survival", { facts: facts({ address: "survival.mc.example.com", release: "1.21.4" }) }),
        server("Island", {
            game: "ark",
            catalogName: "ARK",
            facts: facts({ address: "island.ark.example.com", serverName: "lirio-2", release: null }),
            live: live({ answering: false, containerRunning: false })
        }),
        server("Creative", {
            facts: facts({ running: false, address: "creative.mc.example.com" }),
            live: live({ answering: false })
        })
    ];

    it("matches the address and the machine, not only the name", () => {
        expect(filterServers(servers, "ark.example", "", "").map((row) => row.name)).toEqual(["Island"]);
        expect(filterServers(servers, "lirio-2", "", "").map((row) => row.name)).toEqual(["Island"]);
        expect(filterServers(servers, "1.21.4", "", "").map((row) => row.name)).toEqual(["Survival", "Creative"]);
    });

    it("ignores case and surrounding space", () => {
        expect(filterServers(servers, "  SURVIVAL ", "", "").map((row) => row.name)).toEqual(["Survival"]);
    });

    it("narrows by game and by what is wrong", () => {
        expect(filterServers(servers, "", "ark", "").map((row) => row.name)).toEqual(["Island"]);
        expect(filterServers(servers, "", "", "problem").map((row) => row.name)).toEqual(["Island"]);
        expect(filterServers(servers, "", "", "stopped").map((row) => row.name)).toEqual(["Creative"]);
    });

    it("leaves the list alone when nothing has been asked", () => {
        expect(filterServers(servers, "", "", "").length).toBe(3);
    });
});

describe("ordering", () => {
    const busy = server("Busy", { live: live({ online: 12 }) });
    const quiet = server("Quiet", { live: live({ online: 0 }) });
    const broken = server("Broken", { live: live({ answering: false, containerRunning: false }) });

    it("puts the servers that need somebody first", () => {
        expect(sortServers([quiet, busy, broken], "status", "asc").map((row) => row.name)).toEqual([
            "Broken",
            "Busy",
            "Quiet"
        ]);
    });

    it("sorts by who is playing", () => {
        expect(sortServers([quiet, busy], "players", "desc").map((row) => row.name)).toEqual(["Busy", "Quiet"]);
        expect(sortServers([busy, quiet], "players", "asc")[0]?.name).toBe("Quiet");
    });

    it("keeps a favourite at the top whatever the column says", () => {
        const kept = { ...quiet, favorite: true };
        expect(sortServers([busy, kept, broken], "players", "desc")[0]?.name).toBe("Quiet");
        expect(sortServers([busy, kept, broken], "status", "asc")[0]?.name).toBe("Quiet");
    });

    it("leaves the given order alone when nothing is sorted by", () => {
        expect(sortServers([quiet, broken, busy], null, "asc").map((row) => row.name)).toEqual([
            "Quiet",
            "Broken",
            "Busy"
        ]);
    });
});

describe("the line under the badge", () => {
    it("says how long a server that is answering has been up", () => {
        const up = server("a", { facts: facts({ onlineSince: "2026-08-13T09:00:00.000Z" }) });
        expect(uptimeLine(up)).toEqual({ prefix: "up since", at: "2026-08-13T09:00:00.000Z" });
    });

    it("says when a stopped server was last up", () => {
        const off = server("a", {
            facts: facts({ running: false, lastOnlineAt: "2026-08-10T09:00:00.000Z" }),
            live: live({ answering: false })
        });
        expect(uptimeLine(off)).toEqual({ prefix: "last up", at: "2026-08-10T09:00:00.000Z" });
    });

    it("never says a server that is answering was last up at some point", () => {
        const up = server("a", { facts: facts({ lastOnlineAt: "2026-08-10T09:00:00.000Z", onlineSince: null }) });
        expect(uptimeLine(up)).toBeNull();
    });

    it("has nothing to say about a server that has never been seen up", () => {
        expect(uptimeLine(server("a", { facts: null, live: null }))).toBeNull();
        expect(
            uptimeLine(server("b", { facts: facts({ running: false }), live: live({ answering: false }) }))
        ).toBeNull();
    });
});

describe("whether the files can be browsed", () => {
    it("refuses a stopped server, whose listing would come back empty", () => {
        expect(canBrowseFiles(server("a", { facts: facts({ running: false }), live: live({ answering: false }) }))).toBe(
            false
        );
    });

    it("refuses one Polaris means to be up and that is not", () => {
        expect(canBrowseFiles(server("a", { live: live({ containerRunning: false, answering: false }) }))).toBe(false);
    });

    it("allows a running server, and one whose live read has not landed yet", () => {
        expect(canBrowseFiles(server("a"))).toBe(true);
        expect(canBrowseFiles(server("b", { live: null }))).toBe(true);
    });
});

describe("what it says the server runs", () => {
    it("names the software with the release", () => {
        expect(releaseLabel(facts())).toBe("Paper 1.21.4");
        expect(releaseLabel(facts({ software: null }))).toBe("1.21.4");
    });

    it("says nothing for a game that has no release worth printing", () => {
        expect(releaseLabel(facts({ release: null }))).toBeNull();
        expect(releaseLabel(null)).toBeNull();
    });
});

describe("clicking a column", () => {
    it("opens on the end that column is read for, then reverses, then lets go", () => {
        const first = nextSort({ key: null, dir: "asc" }, "players");
        expect(first).toEqual({ key: "players", dir: "desc" });
        const second = nextSort(first, "players");
        expect(second).toEqual({ key: "players", dir: "asc" });
        expect(nextSort(second, "players").key).toBeNull();
    });

    it("moves to another column on its own terms", () => {
        expect(nextSort({ key: "players", dir: "asc" }, "status")).toEqual({ key: "status", dir: "asc" });
    });
});
