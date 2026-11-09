/** Windows lists Polaris as a mail app only through a registered-application entry. */

import { describe, expect, it } from "vitest";
import { mailHandlerCommands, mailHandlerRemovals } from "../../src/main/mail-handler";

const EXE = "C:\\Users\\someone\\AppData\\Local\\polaris\\app-0.1.20\\polaris.exe";

/** The value a command writes at a key and name ("" for the key's default). */
function written(key: string, name: string): string | undefined {
    for (const args of mailHandlerCommands(EXE)) {
        if (args[0] !== "add" || args[1] !== key) continue;
        const named = args[2] === "/ve" ? "" : args[3];
        if (named === name) return args[args.indexOf("/d") + 1];
    }
    return undefined;
}

describe("the mail handler registration", () => {
    it("registers the application Default apps lists", () => {
        expect(written("HKCU\\Software\\RegisteredApplications", "Polaris")).toBe("Software\\Polaris\\Capabilities");
        expect(written("HKCU\\Software\\Polaris\\Capabilities", "ApplicationName")).toBe("Polaris");
        expect(written("HKCU\\Software\\Polaris\\Capabilities\\URLAssociations", "mailto")).toBe("Polaris.Url.mailto");
    });

    it("runs this executable with the link as its argument", () => {
        expect(written("HKCU\\Software\\Classes\\Polaris.Url.mailto\\shell\\open\\command", "")).toBe(`"${EXE}" "%1"`);
    });

    it("only ever writes under the current user, and overwrites rather than asks", () => {
        for (const args of mailHandlerCommands(EXE)) {
            expect(args[1]?.startsWith("HKCU\\")).toBe(true);
            expect(args.at(-1)).toBe("/f");
        }
    });

    it("never claims mailto for itself", () => {
        expect(mailHandlerCommands(EXE).some((args) => /Classes\\mailto/i.test(args[1] ?? ""))).toBe(false);
    });

    it("takes back exactly what it added", () => {
        const keys = mailHandlerRemovals().map((args) => args[1]);
        expect(keys).toEqual([
            "HKCU\\Software\\RegisteredApplications",
            "HKCU\\Software\\Polaris",
            "HKCU\\Software\\Classes\\Polaris.Url.mailto"
        ]);
    });
});
