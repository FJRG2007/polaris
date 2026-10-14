/**
 * What an extension's device name declares about its browser and system, and
 * that only names the extension can send are taken over the user agent.
 */

import { describe, expect, it } from "vitest";
import { declaredClient, extensionClient } from "@/lib/extension/declared-client";

const AGENT = { browser: "Chrome", os: "Windows" };

describe("declaredClient", () => {
    it("reads a browser and a system", () => {
        expect(declaredClient("Brave on Windows")).toEqual({ browser: "Brave", os: "Windows" });
        expect(declaredClient("Firefox on macOS")).toEqual({ browser: "Firefox", os: "macOS" });
    });

    it("reads a browser on its own", () => {
        expect(declaredClient("Brave")).toEqual({ browser: "Brave", os: null });
    });

    it("takes every browser the extension can send, in its own spelling", () => {
        for (const name of ["Chrome", "Brave", "Edge", "Opera", "Vivaldi", "Firefox", "Safari"]) {
            expect(declaredClient(`${name.toLowerCase()} on windows`)).toEqual({
                browser: name,
                os: "Windows"
            });
        }
    });

    it("keeps the browser and drops a system it does not know", () => {
        expect(declaredClient("Brave on Plan 9")).toEqual({ browser: "Brave", os: null });
    });

    it("declares nothing for a name it cannot read", () => {
        for (const junk of [
            "",
            null,
            undefined,
            "Something else entirely",
            "Netscape on Windows",
            "Brave on Windows on Linux",
            "<b>Brave</b>",
            "on Windows"
        ]) {
            expect(declaredClient(junk)).toEqual({ browser: null, os: null });
        }
    });
});

describe("extensionClient", () => {
    it("prefers the declaration over the user agent's guess", () => {
        expect(extensionClient("Brave on Windows", AGENT)).toEqual({
            browser: "Brave",
            os: "Windows"
        });
        expect(extensionClient("Brave on Linux", AGENT)).toEqual({ browser: "Brave", os: "Linux" });
    });

    it("keeps the user agent's system when only the browser was declared", () => {
        expect(extensionClient("Brave", AGENT)).toEqual({ browser: "Brave", os: "Windows" });
    });

    it("falls back to the user agent for anything else", () => {
        expect(extensionClient("Something else entirely", AGENT)).toEqual(AGENT);
        expect(extensionClient(null, AGENT)).toEqual(AGENT);
    });
});
