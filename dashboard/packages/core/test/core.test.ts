import { describe, expect, it } from "vitest";
import { ipAllowed, ipInCidr } from "../src/cidr.js";
import { normalizeRelPath, UnsafePathError, extName, joinUnderRoot } from "../src/paths.js";
import { generateToken, hashToken, tokenMatchesHash } from "../src/tokens.js";
import { hasPermission, mergeRolePermissions, DEFAULT_ROLES } from "../src/permissions.js";
import { checkUploadCandidate } from "../src/schemas/file-request.js";
import {
    evaluateStatements,
    matchesGlob,
    driveResourcePatterns,
    type PolicyStatement
} from "../src/authz.js";

describe("cidr", () => {
    it("matches addresses inside a v4 range and rejects those outside", () => {
        expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
        expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    });

    it("folds IPv4-mapped IPv6 to IPv4 before matching", () => {
        expect(ipInCidr("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true);
    });

    it("matches inside a v6 range", () => {
        expect(ipInCidr("fe80::1", "fe80::/10")).toBe(true);
        expect(ipInCidr("2001:db8::1", "fe80::/10")).toBe(false);
    });

    it("treats an empty rule list as unrestricted and a malformed rule as no-match", () => {
        expect(ipAllowed("1.2.3.4", [])).toBe(true);
        expect(ipAllowed("1.2.3.4", ["not-a-cidr"])).toBe(false);
        expect(ipAllowed("1.2.3.4", ["1.2.3.4"])).toBe(true);
    });
});

describe("paths", () => {
    it("normalizes and strips redundant segments", () => {
        expect(normalizeRelPath("/a//b/./c")).toBe("a/b/c");
        expect(normalizeRelPath("a/b/../c")).toBe("a/c");
        expect(normalizeRelPath("")).toBe("");
    });

    it("rejects traversal above the root", () => {
        expect(() => normalizeRelPath("../etc/passwd")).toThrow(UnsafePathError);
        expect(() => normalizeRelPath("a/../../b")).toThrow(UnsafePathError);
    });

    it("extracts extensions and joins under a root", () => {
        expect(extName("Photo.JPG")).toBe("jpg");
        expect(extName("noext")).toBe("");
        expect(joinUnderRoot("/data/", "a/b.txt")).toBe("/data/a/b.txt");
    });
});

describe("tokens", () => {
    it("round-trips a token through its hash and rejects a wrong token", () => {
        const token = generateToken();
        const stored = hashToken(token);
        expect(tokenMatchesHash(token, stored)).toBe(true);
        expect(tokenMatchesHash(generateToken(), stored)).toBe(false);
    });
});

describe("permissions", () => {
    it("grants everything to a wildcard (admin) and scopes a viewer", () => {
        const admin = mergeRolePermissions([DEFAULT_ROLES.admin as never]);
        const viewer = mergeRolePermissions([DEFAULT_ROLES.viewer as never]);
        expect(hasPermission(admin, "users.manage")).toBe(true);
        expect(hasPermission(viewer, "users.manage")).toBe(false);
        expect(hasPermission(viewer, "drive.read")).toBe(true);
    });
});

describe("authz engine", () => {
    it("globs across resource separators and anchors literals", () => {
        expect(matchesGlob("*", "anything")).toBe(true);
        expect(matchesGlob("drive:cxx:*", "drive:cxx:reports/q1.pdf")).toBe(true);
        expect(matchesGlob("drive:cxx:*", "drive:cyy:reports/q1.pdf")).toBe(false);
        expect(matchesGlob("drive.read", "drive.write")).toBe(false);
    });

    it("denies by default, allows on match, and lets an explicit deny win", () => {
        const allowRead: PolicyStatement = { effect: "allow", actions: ["drive.read"], resources: ["drive:cxx:*"] };
        const denyOne: PolicyStatement = {
            effect: "deny",
            actions: ["drive.read"],
            resources: ["drive:cxx:secret/*"]
        };
        expect(evaluateStatements([], "drive.read", "drive:cxx:a")).toBe("implicit-deny");
        expect(evaluateStatements([allowRead], "drive.read", "drive:cxx:a")).toBe("allow");
        expect(evaluateStatements([allowRead], "drive.write", "drive:cxx:a")).toBe("implicit-deny");
        // Deny overrides the broad allow regardless of statement order.
        expect(evaluateStatements([allowRead, denyOne], "drive.read", "drive:cxx:secret/x")).toBe("deny");
        expect(evaluateStatements([denyOne, allowRead], "drive.read", "drive:cxx:secret/x")).toBe("deny");
    });

    it("builds subtree resource patterns covering the item and its descendants", () => {
        expect(driveResourcePatterns("cxx", "")).toEqual(["drive:cxx:*"]);
        expect(driveResourcePatterns("cxx", "docs")).toEqual(["drive:cxx:docs", "drive:cxx:docs/*"]);
    });
});

describe("upload constraints", () => {
    const constraints = { allowedExtensions: ["png", "jpg"], allowedMimeTypes: ["image/png"], maxSizeBytes: 100 };

    it("passes an allowed file and rejects by size, extension, and mime", () => {
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 50 }, constraints).ok).toBe(true);
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 200 }, constraints).reason).toBe("size");
        expect(checkUploadCandidate({ extension: "exe", mimeType: "image/png", size: 10 }, constraints).reason).toBe("extension");
        expect(checkUploadCandidate({ extension: "jpg", mimeType: "image/gif", size: 10 }, constraints).reason).toBe("mime");
    });
});
