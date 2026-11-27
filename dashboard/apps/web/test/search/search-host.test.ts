import { describe, expect, it } from "vitest";
import { isInstancePath, readHostRows, readHostVersion } from "@/lib/search/search-host";

describe("rows a search host hands the palette", () => {
    it("keeps well-formed rows and drops the rest", () => {
        const rows = readHostRows({
            rows: [
                { id: "0", kind: "app", title: "Notepad", subtitle: "Application", icon: "data:image/png;base64,AAAA" },
                { id: "1", kind: "web", title: "x", subtitle: "y" },
                { id: "2", kind: "polaris", title: "not a host kind", subtitle: "" },
                { id: "3", kind: "app", title: "Bad icon", subtitle: "", icon: "https://example.test/i.png" },
                "garbage"
            ]
        });
        expect(rows.map((row) => row.id)).toEqual(["0", "1"]);
        expect(readHostRows(null)).toEqual([]);
        expect(readHostRows({ rows: "no" })).toEqual([]);
    });

    it("keeps a system command only by an id the palette can name", () => {
        const rows = readHostRows({
            rows: [
                { id: "0", kind: "system", title: "Restart", subtitle: "System", command: "restart" },
                { id: "1", kind: "system", title: "Format disk", subtitle: "System", command: "format" }
            ]
        });
        expect(rows).toEqual([{ id: "0", kind: "system", title: "Restart", subtitle: "System", command: "restart" }]);
    });

    it("keeps a row's actions the palette can name, and the row when a newer host adds one it cannot", () => {
        const rows = readHostRows({
            rows: [
                { id: "0", kind: "app", title: "Dolphin", subtitle: "Application", actions: ["treat-as-game", "pin-to-dock"] },
                { id: "1", kind: "app", title: "Notepad", subtitle: "Application" }
            ]
        });
        expect(rows.map((row) => row.actions)).toEqual([["treat-as-game"], undefined]);
    });

    it("reads the answer's number, and none from a host too old to give one", () => {
        expect(readHostVersion({ rows: [], version: 7 })).toBe(7);
        expect(readHostVersion({ rows: [] })).toBeNull();
        expect(readHostVersion({ rows: [], version: "7" })).toBeNull();
    });

    it("opens only paths of this instance", () => {
        expect(isInstancePath("/tasks/1")).toBe(true);
        expect(isInstancePath("//evil.test")).toBe(false);
        expect(isInstancePath("https://evil.test")).toBe(false);
        expect(isInstancePath("/\\evil.test")).toBe(false);
    });
});
