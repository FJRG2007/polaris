import { describe, expect, it } from "vitest";
import { latestUuid } from "@polaris-app/game-servers/src/lib/minecraft/usercache";

const cache = JSON.stringify([
    {
        name: "Ana",
        uuid: "00000000-0000-3000-8000-000000000001",
        expiresOn: "2026-09-01 10:00:00 +0000"
    },
    {
        name: "ana",
        uuid: "00000000-0000-4000-8000-00000000000A",
        expiresOn: "2026-10-01 10:00:00 +0000"
    },
    { name: "Ben", uuid: "00000000-0000-4000-8000-000000000002" }
]);

describe("latestUuid", () => {
    it("answers the UUID the name last joined under, whatever its case", () => {
        expect(latestUuid(cache, " ANA ")).toBe("00000000-0000-4000-8000-00000000000a");
    });

    it("answers a UUID with no readable expiry", () => {
        expect(latestUuid(cache, "Ben")).toBe("00000000-0000-4000-8000-000000000002");
    });

    it("answers null for a name never seen, or a cache it cannot read", () => {
        expect(latestUuid(cache, "Cleo")).toBeNull();
        expect(latestUuid("not json", "Ana")).toBeNull();
    });
});
