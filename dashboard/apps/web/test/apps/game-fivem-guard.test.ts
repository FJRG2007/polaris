/**
 * The resource Polaris writes into every FiveM server it creates.
 *
 * It is a piece of Lua that nothing here can run, which is exactly why it is worth
 * checking. It carries the whole of the server's access control - FiveM has no
 * whitelist and no ban list of its own - so a mistake in it does not fail loudly:
 * the resource refuses to load, the door is not there, and a server the screen
 * says is closed lets the whole internet in.
 *
 * Two of the ways it could fail that way are checkable from here. A Lua 5.4-only
 * spelling is a syntax error in a resource whose manifest does not ask for 5.4,
 * and there is no reason to be near that line. And the manifest has to name the
 * script, or the resource loads and does nothing at all - which reads exactly like
 * a server that is simply not enforcing anything.
 *
 * The last one is the rule it exists for: the door opens rather than shuts when
 * it cannot read what Polaris wrote. A server that refused the world because a
 * write was interrupted is a far worse failure than one that is briefly open, and
 * the first person it would refuse is the owner trying to fix it.
 */

import { describe, expect, it } from "vitest";
import * as guard from "@/lib/apps/fivem/guard";

describe("the manifest", () => {
    it("names the script, the manifest version and the game", () => {
        expect(guard.GUARD_MANIFEST).toContain('server_script "server.lua"');
        expect(guard.GUARD_MANIFEST).toContain("fx_version");
        expect(guard.GUARD_MANIFEST).toContain('game "gta5"');
    });

    it("does not ask for Lua 5.4, so the script must not use it", () => {
        expect(guard.GUARD_MANIFEST).not.toContain("lua54");
        // `<const>` and `<close>` are the 5.4-only spellings; either one is a
        // syntax error in a 5.3 resource.
        expect(guard.GUARD_SCRIPT).not.toMatch(/<\s*(const|close)\s*>/);
        // Integer division and the bitwise operators are the other 5.3+ additions
        // that a CfxLua build has refused in the past. Nothing here needs them.
        expect(guard.GUARD_SCRIPT).not.toContain("//");
    });
});

describe("the script", () => {
    it("refuses a connection rather than kicking after it", () => {
        // A kick after the fact is thirty seconds inside the server, which is
        // thirty seconds of whatever they were banned for.
        expect(guard.GUARD_SCRIPT).toContain('AddEventHandler("playerConnecting"');
        expect(guard.GUARD_SCRIPT).toContain("deferrals.defer()");
    });

    it("reads the file on every connection, so there is no reload to go wrong", () => {
        expect(guard.GUARD_SCRIPT).toContain('LoadResourceFile(RESOURCE, "access.json")');
    });

    it("opens rather than shuts when it cannot read what Polaris wrote", () => {
        const openWhenUnreadable = /if access == nil then[\s\S]{0,200}?deferrals\.done\(\)/;
        expect(guard.GUARD_SCRIPT).toMatch(openWhenUnreadable);
    });

    it("matches an identifier however either side cased it", () => {
        expect(guard.GUARD_SCRIPT).toContain("string.lower(GetPlayerIdentifier(player, index))");
        expect(guard.GUARD_SCRIPT).toContain('string.lower(row.identifier or "")');
    });

    it("keeps the message-one-player command to the console and administrators", () => {
        // The third argument to RegisterCommand is `restricted`. Without it any
        // player could put words in the server's mouth.
        expect(guard.GUARD_SCRIPT).toContain(`RegisterCommand("${guard.DM_COMMAND}"`);
        expect(guard.GUARD_SCRIPT).toMatch(/end, true\)/);
    });
});

describe("where it goes", () => {
    it("is a resource folder the server will discover, and a line that starts it", () => {
        expect(guard.GUARD_ROOT.endsWith(`/resources/${guard.GUARD_RESOURCE}`)).toBe(true);
        expect(guard.GUARD_ACCESS_FILE).toBe(`${guard.GUARD_ROOT}/access.json`);
        expect(guard.guardCfgLines()).toEqual([`ensure ${guard.GUARD_RESOURCE}`]);
    });
});
