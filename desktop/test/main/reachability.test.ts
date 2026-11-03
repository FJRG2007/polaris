import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeNetError, finishedLoad, isCertificateError, isOfflinePage } from "../../src/main/reachability";

const OFFLINE_PAGE = join(__dirname, "../../../dashboard/apps/web/public/offline.html");

describe("the page a gone Polaris's worker answers with", () => {
    it("is recognized in both of its languages", () => {
        expect(isOfflinePage("Polaris is not reachable")).toBe(true);
        expect(isOfflinePage(" No se puede acceder a Polaris ")).toBe(true);
    });

    it("is not confused with a page of the Polaris", () => {
        expect(isOfflinePage("Polaris")).toBe(false);
        expect(isOfflinePage("")).toBe(false);
    });

    it("tells a recovery from any other finished load", () => {
        expect(finishedLoad("Polaris is not reachable", false)).toBe("offline");
        expect(finishedLoad("Polaris is not reachable", true)).toBe("offline");
        expect(finishedLoad("Polaris", true)).toBe("recovered");
        expect(finishedLoad("Polaris", false)).toBe("online");
    });

    it("keeps the titles the desktop app looks for", () => {
        const page = readFileSync(OFFLINE_PAGE, "utf8");
        expect(page).toContain("<title>Polaris is not reachable</title>");
        expect(page).toContain('title: "No se puede acceder a Polaris"');
    });
});

describe("isCertificateError", () => {
    it("tells a certificate this computer does not trust from the network", () => {
        expect(isCertificateError("ERR_CERT_AUTHORITY_INVALID")).toBe(true);
        expect(isCertificateError("ERR_SSL_PROTOCOL_ERROR")).toBe(true);
        expect(isCertificateError("ERR_CONNECTION_REFUSED")).toBe(false);
        expect(isCertificateError(null)).toBe(false);
        expect(describeNetError("ERR_CERT_AUTHORITY_INVALID", "polaris.local")).toContain("certificate of polaris.local");
    });
});
