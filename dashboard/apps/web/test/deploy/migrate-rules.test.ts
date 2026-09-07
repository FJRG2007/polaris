/**
 * What travels when a service moves between a Polaris server and a provider.
 *
 * Three decisions, each with a wrong answer nobody notices for a fortnight: a
 * Polaris variable sent to Vercel, a provider's secret written into a database in
 * the clear, or a repository read out of a shape that never had one. So they are
 * pure and they are pinned here.
 */

import { describe, expect, it } from "vitest";
import { carriable, isPublicKey, repoFromSourceConfig } from "@/lib/deploy/migrate-rules";

describe("what is worth carrying", () => {
    it("takes the service's own variables", () => {
        expect(carriable({ DATABASE_URL: "postgres://x", PORT: "3000" })).toEqual({
            DATABASE_URL: "postgres://x",
            PORT: "3000"
        });
    });

    it("leaves behind what Polaris sets for its own containers", () => {
        // A value naming a Polaris server, port or collector is noise on
        // somebody else's build at best, and a wrong answer that takes an
        // afternoon to find at worst.
        expect(
            carriable({
                POLARIS_INSTANCE: "lirio-0",
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
                API_KEY: "keep me"
            })
        ).toEqual({ API_KEY: "keep me" });
    });

    it("keeps an empty value, which is a value somebody set", () => {
        // Not the same as a variable that is missing: "" is how a flag gets
        // turned off, and dropping it would silently change behaviour.
        expect(carriable({ FEATURE_X: "" })).toEqual({ FEATURE_X: "" });
    });

    it("drops a nameless one rather than sending it", () => {
        expect(carriable({ "  ": "orphan" })).toEqual({});
    });
});

describe("which of them anybody was meant to see", () => {
    it("treats everything from a provider as a secret", () => {
        // Nothing here can tell an API key from a feature flag by looking, and
        // the safe answer is the one that keeps a key out of a plain column.
        expect(isPublicKey("DATABASE_URL")).toBe(false);
        expect(isPublicKey("STRIPE_SECRET_KEY")).toBe(false);
        expect(isPublicKey("PUBLISHABLE_KEY")).toBe(false);
    });

    it("except what a framework compiles into the browser", () => {
        // Masking one of these would be theatre: it is already in the page
        // source of the site that was just deployed.
        for (const key of [
            "NEXT_PUBLIC_API_URL",
            "VITE_API_URL",
            "PUBLIC_SITE_NAME",
            "REACT_APP_TITLE",
            "NUXT_PUBLIC_BASE",
            "EXPO_PUBLIC_KEY"
        ]) {
            expect(isPublicKey(key)).toBe(true);
        }
    });
});

describe("the repository a service here is built from", () => {
    it("reads the address and the branch", () => {
        expect(
            repoFromSourceConfig(JSON.stringify({ repoUrl: "https://github.com/o/r.git", branch: "main" }))
        ).toEqual({ repoUrl: "https://github.com/o/r.git", branch: "main" });
    });

    it("says nothing for a service built from an image", () => {
        // The screen then says there is nothing for a provider to build, rather
        // than offering a move that would leave an empty project at the far end.
        expect(repoFromSourceConfig(JSON.stringify({ imageRef: "nginx:latest" }))).toEqual({
            repoUrl: "",
            branch: ""
        });
    });

    it("survives a row that is not what it claims to be", () => {
        expect(repoFromSourceConfig("{oh dear")).toEqual({ repoUrl: "", branch: "" });
        expect(repoFromSourceConfig("null")).toEqual({ repoUrl: "", branch: "" });
        expect(repoFromSourceConfig(JSON.stringify({ repoUrl: 42 }))).toEqual({ repoUrl: "", branch: "" });
    });
});
