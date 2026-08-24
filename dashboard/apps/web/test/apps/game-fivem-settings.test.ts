/**
 * The rules a FiveM server is run under, and the one that is spelled backwards.
 *
 * Most of these are ordinary: a switch writes true or false, a number writes a
 * number. Two are not, and both would be silently wrong if the screen drew them
 * as it stores them.
 *
 * `sv_scriptHookAllowed` takes 1 and 0 rather than true and false, and a server
 * given the word "false" reads it as nothing and falls back to its own default -
 * which for that setting is the permissive one.
 *
 * `sv_master1` has no value that means "listed": listing is the absence of the
 * line, and setting it to an empty string is what takes the server off the public
 * browser. So its switch writes null to turn on, which is the opposite shape of
 * every other row.
 */

import { describe, expect, it } from "vitest";
import * as settings from "@/lib/apps/fivem/settings";

const setting = (key: string): settings.FivemSetting => {
    const found = settings.findSetting(key);
    if (!found) throw new Error(`no setting ${key}`);
    return found;
};

describe("the catalogue", () => {
    it("puts every setting in a group the screen draws", () => {
        for (const entry of settings.FIVEM_SETTINGS) {
            expect(settings.FIVEM_SETTING_GROUPS, entry.key).toContain(entry.group);
        }
    });

    it("gives every choice setting something to choose from", () => {
        for (const entry of settings.FIVEM_SETTINGS) {
            if (entry.type === "choice") expect(entry.choices?.length ?? 0, entry.key).toBeGreaterThan(0);
        }
    });

    it("finds a setting however it was cased", () => {
        expect(settings.findSetting("SV_HOSTNAME")?.key).toBe("sv_hostname");
        expect(settings.findSetting("nothing")).toBeUndefined();
    });
});

describe("an ordinary switch", () => {
    it("writes the words the server reads", () => {
        const privacy = setting("sv_endpointprivacy");
        expect(settings.switchValue(privacy, true)).toBe("true");
        expect(settings.switchValue(privacy, false)).toBe("false");
        expect(settings.switchIsOn(privacy, "true")).toBe(true);
        expect(settings.switchIsOn(privacy, "false")).toBe(false);
    });

    it("reads as the game's own default when the config does not set it", () => {
        expect(settings.switchIsOn(setting("sv_endpointprivacy"), null)).toBe(false);
        expect(settings.switchIsOn(setting("onesync_population"), null)).toBe(true);
    });

    it("takes any spelling of true a file written by hand might carry", () => {
        const privacy = setting("sv_endpointprivacy");
        expect(settings.switchIsOn(privacy, "1")).toBe(true);
        expect(settings.switchIsOn(privacy, "yes")).toBe(true);
        expect(settings.switchIsOn(privacy, "nonsense")).toBe(false);
    });
});

describe("the switch that takes a number", () => {
    it("writes 1 and 0, not true and false", () => {
        const hook = setting("sv_scriptHookAllowed");
        expect(settings.switchValue(hook, true)).toBe("1");
        expect(settings.switchValue(hook, false)).toBe("0");
        expect(settings.switchIsOn(hook, "0")).toBe(false);
        expect(settings.switchIsOn(hook, "1")).toBe(true);
    });
});

describe("the switch whose on state is the absence of a line", () => {
    it("turns on by taking the line out and off by writing an empty value", () => {
        const listed = setting("sv_master1");
        expect(settings.switchValue(listed, true)).toBe(null);
        expect(settings.switchValue(listed, false)).toBe("");
        // Nothing set is listed, which is the game's own default.
        expect(settings.switchIsOn(listed, null)).toBe(true);
        expect(settings.switchIsOn(listed, "")).toBe(false);
    });
});

describe("checking a value", () => {
    it("refuses what the config format cannot carry", () => {
        expect(settings.settingError(setting("sv_hostname"), 'a "quoted" name')).not.toBe(null);
        expect(settings.settingError(setting("sv_hostname"), "two\nlines")).not.toBe(null);
        expect(settings.settingError(setting("sv_hostname"), "Los Santos")).toBe(null);
    });

    it("holds a number inside the range the game accepts", () => {
        const slots = setting("sv_maxclients");
        expect(settings.settingError(slots, "32")).toBe(null);
        expect(settings.settingError(slots, "0")).not.toBe(null);
        expect(settings.settingError(slots, "9999")).not.toBe(null);
        expect(settings.settingError(slots, "thirty")).not.toBe(null);
        // Blank is not a value; it is the row being unset, which is allowed.
        expect(settings.settingError(slots, "")).toBe(null);
    });

    it("holds a choice to what is on offer", () => {
        const onesync = setting("onesync");
        expect(settings.settingError(onesync, "legacy")).toBe(null);
        expect(settings.settingError(onesync, "maybe")).not.toBe(null);
    });

    it("holds text to what the server will read as one line", () => {
        const tags = setting("tags");
        expect(settings.settingError(tags, "x".repeat(500))).not.toBe(null);
    });
});
