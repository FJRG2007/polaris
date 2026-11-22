import { describe, expect, it, vi } from "vitest";
import manifest from "@/app/manifest";

vi.mock("@/lib/seasonal-service", () => ({ serverSeason: async () => "winter" }));

describe("install manifest in a season", () => {
    it("lists the dressed icons at addresses that name the season", async () => {
        const icons = (await manifest()).icons?.map((icon) => icon.src);
        expect(icons).toEqual([
            "/season-icon/winter.svg",
            "/season-icon/winter-128.png",
            "/season-icon/winter-192.png",
            "/season-icon/winter-512.png"
        ]);
    });
});
