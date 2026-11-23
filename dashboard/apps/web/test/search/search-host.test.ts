import { describe, expect, it } from "vitest";
import { isInstancePath, readHostRows } from "@/lib/search/search-host";

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

    it("opens only paths of this instance", () => {
        expect(isInstancePath("/tasks/1")).toBe(true);
        expect(isInstancePath("//evil.test")).toBe(false);
        expect(isInstancePath("https://evil.test")).toBe(false);
        expect(isInstancePath("/\\evil.test")).toBe(false);
    });
});
