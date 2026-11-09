/**
 * The summary strip above an event: runtime, system (by distribution, not by
 * kernel), browser and device, read from what Sentry SDKs and Polaris' own
 * reporter send, case-insensitively.
 */

import { describe, expect, it } from "vitest";
import type { ContextGroup } from "@polaris/core";
import { environmentOf, platformMark, readOsRelease } from "@/lib/telemetry/environment";

const group = (name: string, fields: Record<string, string>): ContextGroup => ({
    name,
    fields: Object.entries(fields).map(([key, value]) => ({ key, value }))
});

const first = (groups: ContextGroup[]) => environmentOf(groups)[0];

describe("environmentOf", () => {
    it("reads a Sentry Node event: the distribution, its version and the kernel", () => {
        const facts = environmentOf([
            group("runtime", { name: "node", version: "v22.11.0" }),
            group("os", { name: "Ubuntu", version: "22.04", kernel_version: "5.15.0-91-generic" }),
            group("device", { arch: "x64", processor_count: "8" })
        ]);
        expect(facts).toEqual([
            {
                kind: "runtime",
                name: "Node.js",
                version: "22.11.0",
                detail: null,
                mark: "node",
                mobile: false
            },
            {
                kind: "os",
                name: "Ubuntu",
                version: "22.04",
                detail: "5.15.0-91-generic",
                mark: "ubuntu",
                mobile: false
            },
            { kind: "device", name: "x64", version: null, detail: null, mark: null, mobile: false }
        ]);
    });

    it("names the distribution over a bare Linux when the description says it", () => {
        expect(
            first([
                group("OS", { Name: "Linux", Raw_Description: "Debian GNU/Linux 12 (bookworm)" })
            ])
        ).toMatchObject({ name: "Debian GNU/Linux 12 (bookworm)", mark: "debian" });
    });

    it("falls back to the penguin only for a Linux it cannot name", () => {
        expect(first([group("os", { name: "Linux", kernel_version: "6.5.0" })])).toMatchObject({
            mark: "linux",
            detail: "6.5.0"
        });
        expect(first([group("os", { name: "Amazon Linux", version: "2023" })])?.mark).toBe("linux");
        expect(first([group("os", { name: "Alpine Linux", version: "3.20.3" })])?.mark).toBe(
            "alpine"
        );
        expect(first([group("os", { name: "Linux Mint" })])?.mark).toBe("mint");
        expect(first([group("os", { name: "Red Hat Enterprise Linux" })])?.mark).toBe("redhat");
        expect(first([group("os", { name: "Fedora Linux" })])?.mark).toBe("fedora");
    });

    it("reads a browser event's client_os and browser, and a phone as a phone", () => {
        const facts = environmentOf([
            group("browser", { name: "Mobile Safari", version: "17.4" }),
            group("client_os", { name: "iOS", version: "17.4.1" }),
            group("device", { family: "iPhone", model: "iPhone15,2" })
        ]);
        expect(facts.map((fact) => [fact.kind, fact.name, fact.mark, fact.mobile])).toEqual([
            ["os", "iOS", "apple", true],
            ["browser", "Mobile Safari", "safari", true],
            ["device", "iPhone15,2", null, true]
        ]);
    });

    it("tells Edge and Opera from the Chrome they also claim to be", () => {
        const mark = (name: string) => first([group("browser", { name })])?.mark;
        expect(mark("Edge")).toBe("edge");
        expect(mark("Opera")).toBe("opera");
        expect(mark("Chrome Mobile")).toBe("chrome");
        expect(mark("Firefox")).toBe("firefox");
    });

    it("reads tags when there are no contexts, case-insensitively", () => {
        const facts = environmentOf([], {
            "OS.Name": "Windows",
            "os.version": "10.0.22631",
            browser: "Chrome 120.0.6099"
        });
        expect(facts).toMatchObject([
            { kind: "os", name: "Windows", version: "10.0.22631", mark: "windows" },
            { kind: "browser", name: "Chrome", version: "120.0.6099", mark: "chrome" }
        ]);
    });

    it("names the runtimes Sentry's SDKs send", () => {
        const mark = (name: string) => first([group("runtime", { name })])?.mark;
        expect(mark("CPython")).toBe("python");
        expect(mark("Bun")).toBe("bun");
        expect(mark("deno")).toBe("deno");
        expect(mark("go")).toBe("go");
        expect(mark("OpenJDK 64-Bit Server VM")).toBe("java");
        expect(mark(".NET Core")).toBe("dotnet");
        expect(mark("php")).toBe("php");
        expect(mark("ruby")).toBe("ruby");
        expect(mark("rustc")).toBe("rust");
        expect(mark("Zig")).toBeNull();
    });

    it("leaves out what was never sent, and macOS is not called Darwin", () => {
        expect(environmentOf([])).toEqual([]);
        expect(first([group("os", { name: "Darwin", version: "23.4.0" })])).toMatchObject({
            name: "macOS",
            mark: "apple"
        });
    });
});

describe("platformMark", () => {
    it("draws a project's platform as its runtime", () => {
        expect(platformMark("node")).toBe("node");
        expect(platformMark("python")).toBe("python");
        expect(platformMark("csharp")).toBe("dotnet");
        expect(platformMark("javascript")).toBeNull();
        expect(platformMark(null)).toBeNull();
    });
});

describe("readOsRelease", () => {
    it("reads quoted and bare values", () => {
        expect(
            readOsRelease(
                'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\n'
            )
        ).toEqual({ name: "Ubuntu", version: "22.04", pretty: "Ubuntu 22.04.4 LTS" });
        expect(readOsRelease('NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\r\n')).toEqual({
            name: "Alpine Linux",
            version: "3.20.3",
            pretty: null
        });
        expect(readOsRelease("ID=arch\n")).toEqual({ name: "arch", version: null, pretty: null });
        expect(readOsRelease("")).toBeNull();
    });
});
