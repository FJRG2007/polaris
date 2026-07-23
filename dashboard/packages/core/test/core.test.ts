import { describe, expect, it } from "vitest";
import { ipAllowed, ipInCidr } from "../src/cidr.js";
import { normalizeRelPath, UnsafePathError, extName, joinUnderRoot } from "../src/paths.js";
import { generateToken, hashToken, tokenMatchesHash } from "../src/tokens.js";
import { hasPermission, mergeRolePermissions, DEFAULT_ROLES } from "../src/permissions.js";
import {
    checkUploadCandidate,
    createFileRequestSchema,
    userAllowedForRequest,
    uploaderDeleteAllowed,
    randomDropPointName
} from "../src/schemas/file-request.js";
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
    const constraints = {
        allowedExtensions: ["png", "jpg"],
        deniedExtensions: [],
        allowedMimeTypes: ["image/png"],
        maxSizeBytes: 100
    };

    it("passes an allowed file and rejects by size, extension, and mime", () => {
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 50 }, constraints).ok).toBe(true);
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 200 }, constraints).reason).toBe("size");
        expect(checkUploadCandidate({ extension: "exe", mimeType: "image/png", size: 10 }, constraints).reason).toBe("extension");
        expect(checkUploadCandidate({ extension: "jpg", mimeType: "image/gif", size: 10 }, constraints).reason).toBe("mime");
    });

    it("rejects a file under the minimum size", () => {
        const withMin = { ...constraints, minSizeBytes: 20 };
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 10 }, withMin).reason).toBe("too_small");
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 20 }, withMin).ok).toBe(true);
    });

    it("blocks a denied extension even when it is also allowlisted", () => {
        const denied = { ...constraints, allowedExtensions: ["png", "svg"], deniedExtensions: ["svg"] };
        expect(checkUploadCandidate({ extension: "svg", mimeType: "image/png", size: 10 }, denied).reason).toBe("denied");
        expect(checkUploadCandidate({ extension: "png", mimeType: "image/png", size: 10 }, denied).ok).toBe(true);
    });
});

describe("drop-point create schema", () => {
    const base = { destinationConnectionId: "conn-1", destinationPath: "inbox" };

    it("accepts a blank title and normalizes extension lists", () => {
        const parsed = createFileRequestSchema.parse({
            ...base,
            allowedExtensions: ["PNG", "png", "Jpg"],
            deniedExtensions: ["EXE"],
            allowedUsers: ["@Alice", "alice", "bob@example.com"]
        });
        expect(parsed.title).toBeUndefined();
        expect(parsed.allowedExtensions).toEqual(["png", "jpg"]);
        expect(parsed.deniedExtensions).toEqual(["exe"]);
        expect(parsed.allowedUsers).toEqual(["alice", "bob@example.com"]);
    });

    it("rejects a minimum size larger than the maximum", () => {
        const result = createFileRequestSchema.safeParse({ ...base, minSizeBytes: 500, maxSizeBytes: 100 });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(["minSizeBytes"]);
    });

    it("rejects a start time that is not before the expiry time", () => {
        const result = createFileRequestSchema.safeParse({
            ...base,
            startsAt: "2026-02-01T00:00:00Z",
            expiresAt: "2026-01-01T00:00:00Z"
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(["startsAt"]);
    });
});

describe("per-user allowlist", () => {
    it("allows anyone when empty, and matches email or username case-insensitively", () => {
        expect(userAllowedForRequest({ email: "x@y.com" }, [])).toBe(true);
        expect(userAllowedForRequest({ email: "Alice@Example.com", username: null }, ["alice@example.com"])).toBe(true);
        expect(userAllowedForRequest({ email: null, username: "Bob" }, ["@bob"])).toBe(true);
        expect(userAllowedForRequest({ email: "eve@evil.com", username: "eve" }, ["alice", "bob"])).toBe(false);
    });
});

describe("uploader self-delete policy", () => {
    const uploadedAt = new Date("2026-01-01T00:00:00Z");

    it("blocks when deletes are disabled and honors the time window", () => {
        expect(uploaderDeleteAllowed({ allow: false, windowSeconds: null, uploadedAt })).toBe(false);
        expect(uploaderDeleteAllowed({ allow: true, windowSeconds: null, uploadedAt })).toBe(true);
        const within = new Date("2026-01-01T00:00:30Z");
        const after = new Date("2026-01-01T00:02:00Z");
        expect(uploaderDeleteAllowed({ allow: true, windowSeconds: 60, uploadedAt, now: within })).toBe(true);
        expect(uploaderDeleteAllowed({ allow: true, windowSeconds: 60, uploadedAt, now: after })).toBe(false);
    });
});

describe("random drop-point name", () => {
    it("builds a readable capitalized name with a two-digit suffix", () => {
        expect(randomDropPointName(() => 0)).toBe("Swift Harbor 10");
        expect(randomDropPointName(() => 0.999999)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ 99$/);
    });
});
