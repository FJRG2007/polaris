/**
 * The input schemas: normalized first, then held to a rule that can fail.
 */

import { describe, expect, it } from "vitest";
import {
    checkInput,
    incidentUpdateInput,
    maintenanceInput,
    normalizeSlug,
    pageInput
} from "@polaris-app/status-pages/src/model/schemas";

const componentId = "0190f1a0-0000-7000-8000-000000000001";
const pageId = "0190f1a0-0000-7000-8000-000000000002";

describe("pageInput", () => {
    it("normalizes the slug and trims the title", () => {
        const parsed = pageInput.parse({ title: "  Acme status ", slug: " Acme Status " });
        expect(parsed).toEqual({
            title: "Acme status",
            slug: "acme-status",
            description: "",
            published: false
        });
        expect(normalizeSlug("My__Page  Two")).toBe("my-page-two");
    });

    it("refuses a slug that cannot be an address, and an empty title", () => {
        expect(pageInput.safeParse({ title: "A", slug: "-bad-" }).success).toBe(false);
        expect(pageInput.safeParse({ title: "A", slug: "a/b" }).success).toBe(false);
        expect(pageInput.safeParse({ title: "   ", slug: "ok" }).success).toBe(false);
    });
});

describe("checkInput", () => {
    it("takes an HTTP check and defaults its timing", () => {
        const parsed = checkInput.parse({
            componentId,
            kind: "http",
            target: " https://example.com/health "
        });
        expect(parsed).toMatchObject({
            kind: "http",
            target: "https://example.com/health",
            intervalSec: 60,
            timeoutMs: 10_000,
            expectStatus: null
        });
    });

    it("refuses other schemes, credentials in the URL, and intervals under thirty seconds", () => {
        expect(
            checkInput.safeParse({ componentId, kind: "http", target: "ftp://example.com" }).success
        ).toBe(false);
        expect(
            checkInput.safeParse({ componentId, kind: "http", target: "https://a:b@example.com" })
                .success
        ).toBe(false);
        expect(
            checkInput.safeParse({
                componentId,
                kind: "http",
                target: "https://example.com",
                intervalSec: 10
            }).success
        ).toBe(false);
        expect(
            checkInput.safeParse({
                componentId,
                kind: "http",
                target: "https://example.com",
                timeoutMs: 60_000
            }).success
        ).toBe(false);
    });

    it("needs a port for TCP and defaults one for latency", () => {
        expect(checkInput.safeParse({ componentId, kind: "tcp", target: "db.lan" }).success).toBe(
            false
        );
        expect(
            checkInput.parse({ componentId, kind: "tcp", target: " DB.lan ", port: "5432" })
        ).toMatchObject({
            target: "db.lan",
            port: 5432
        });
        expect(
            checkInput.parse({ componentId, kind: "ping", target: "example.com" })
        ).toMatchObject({ port: 443 });
    });

    it("needs a known record type for DNS and refuses a host with a path", () => {
        expect(
            checkInput.safeParse({
                componentId,
                kind: "dns",
                target: "example.com",
                dnsType: "SRV"
            }).success
        ).toBe(false);
        expect(
            checkInput.safeParse({
                componentId,
                kind: "dns",
                target: "example.com/x",
                dnsType: "A"
            }).success
        ).toBe(false);
        expect(
            checkInput.safeParse({ componentId, kind: "dns", target: "example.com", dnsType: "A" })
                .success
        ).toBe(true);
    });

    it("refuses an unknown kind", () => {
        expect(
            checkInput.safeParse({ componentId, kind: "icmp", target: "example.com" }).success
        ).toBe(false);
    });
});

describe("incident and maintenance inputs", () => {
    it("needs a message on every update", () => {
        expect(
            incidentUpdateInput.safeParse({ incidentId: pageId, state: "resolved", body: "  " })
                .success
        ).toBe(false);
        expect(
            incidentUpdateInput.safeParse({ incidentId: pageId, state: "fixed", body: "Done" })
                .success
        ).toBe(false);
    });

    it("refuses a window that ends before it starts", () => {
        const base = { pageId, title: "Upgrade", startsAt: "2026-03-10T10:00:00Z" };
        expect(
            maintenanceInput.safeParse({ ...base, endsAt: "2026-03-10T09:00:00Z" }).success
        ).toBe(false);
        expect(
            maintenanceInput.safeParse({ ...base, endsAt: "2026-03-10T11:00:00Z" }).success
        ).toBe(true);
    });
});
