import { describe, expect, it } from "vitest";
import { asDirectory, parentDirectory } from "@/app/(app)/apps/deploy/files-path";

describe("asDirectory", () => {
    it("keeps the container root as-is", () => {
        expect(asDirectory("/")).toBe("/");
        expect(asDirectory("")).toBe("/");
    });

    it("trailing-slashes a mount path so entries append to it", () => {
        expect(asDirectory("/app/secrets")).toBe("/app/secrets/");
        expect(asDirectory("/app/secrets/")).toBe("/app/secrets/");
        expect(asDirectory("/app/secrets//")).toBe("/app/secrets/");
    });

    it("absolutizes a mount path stored without its leading slash", () => {
        expect(asDirectory("data/uploads")).toBe("/data/uploads/");
    });
});

describe("parentDirectory", () => {
    it("climbs one level while inside the root", () => {
        expect(parentDirectory("/app/secrets/keys/", "/app/secrets/")).toBe("/app/secrets/");
        expect(parentDirectory("/etc/nginx/", "/")).toBe("/etc/");
    });

    it("stops at the root a volume is confined to", () => {
        expect(parentDirectory("/app/secrets/", "/app/secrets/")).toBe("/app/secrets/");
        expect(parentDirectory("/", "/")).toBe("/");
    });
});
