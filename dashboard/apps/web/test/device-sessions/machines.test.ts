/**
 * Which computer a row on the sessions screen runs on: read off its address and
 * system, and named by the terminal or Stream Deck on it.
 */

import { describe, expect, it } from "vitest";
import { machinesOf } from "@/lib/device-sessions/machines";
import { DEVICE_SESSION_KINDS } from "@/lib/device-sessions/kinds";

const HOME = "203.0.113.4";

describe("the machine a session runs on", () => {
    it("names the browser, its extension and its apps after the hostname a terminal reported", () => {
        const machines = machinesOf([
            { id: "browser", ip: HOME, os: "Windows 11", current: true },
            { id: "extension", ip: HOME, os: "Windows" },
            { id: "cli", ip: HOME, os: "Windows", hostname: "DRAGON" },
            { id: "deck", ip: HOME, os: "Windows", hostname: "DRAGON" }
        ]);

        for (const id of ["browser", "extension", "cli", "deck"]) {
            expect(machines.get(id)).toEqual({ name: "DRAGON", here: true });
        }
    });

    it("says which rows share the reader's computer when nothing named it", () => {
        const machines = machinesOf([
            { id: "browser", ip: HOME, os: "macOS 15", current: true },
            { id: "extension", ip: HOME, os: "macOS" }
        ]);

        expect(machines.get("extension")).toEqual({ name: null, here: true });
    });

    it("keeps another system on the same network, and another network, apart", () => {
        const machines = machinesOf([
            { id: "cli", ip: HOME, os: "Windows", hostname: "DRAGON" },
            { id: "phone", ip: HOME, os: "Android 15" },
            { id: "laptop", ip: "198.51.100.7", os: "Windows" }
        ]);

        // Alone on its machine, there is nothing to group it with.
        expect(machines.has("cli")).toBe(false);
        expect(machines.has("phone")).toBe(false);
        expect(machines.has("laptop")).toBe(false);
    });

    it("names a machine nobody is reading from", () => {
        const machines = machinesOf([
            { id: "cli", ip: HOME, os: "Linux", hostname: "build-box" },
            { id: "deck", ip: HOME, os: "Linux" }
        ]);

        expect(machines.get("deck")).toEqual({ name: "build-box", here: false });
    });

    it("places nothing it has no address for", () => {
        const machines = machinesOf([
            { id: "browser", ip: null, os: "Windows", current: true },
            { id: "cli", ip: null, os: "Windows", hostname: "DRAGON" }
        ]);

        expect(machines.size).toBe(0);
    });

    it("takes a computer's name only from the kinds that report one", () => {
        expect(DEVICE_SESSION_KINDS.cli.namesMachine).toBe(true);
        expect(DEVICE_SESSION_KINDS.streamdeck.namesMachine).toBe(true);
        // A TV's name is the set's, not the computer's beside it.
        expect(DEVICE_SESSION_KINDS.tv.namesMachine).toBe(false);
    });
});
