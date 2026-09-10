/**
 * The object store's rules: bucket names, expiry ages, the engine shell's
 * lines, replication, presign addresses, the references a service reads, and
 * the Cloudflare purge path.
 *
 * Every value here ends up on a line of the engine's shell inside the store's
 * container, so the tests that matter most are the refusals: a name, a key or a
 * prefix that could add a second command to a line is rejected before a line
 * is built from it.
 */

import * as core from "../src/index.js";
import { describe, expect, it } from "vitest";

const ID = "00000000-0000-4000-8000-000000000000";

describe("bucket names", () => {
    it("takes what every S3 client can address path-style", () => {
        expect(core.isBucketName("user-uploads")).toBe(true);
        expect(core.isBucketName("a1b")).toBe(true);
    });

    it("refuses the rest", () => {
        for (const name of ["ab", "Uploads", "my.bucket", "-lead", "trail-", "two--dashes", "a b", "x".repeat(64)]) {
            expect(core.isBucketName(name)).toBe(false);
        }
        expect(() => core.bucketCreateLine("a; rm")).toThrow();
    });
});

describe("expiry", () => {
    it("writes every offered age as a TTL the engine accepts", () => {
        for (const days of core.LIFECYCLE_DAYS) expect(core.lifecycleTtl(days)).toMatch(/^([1-9]\d?|1\d\d|2[0-4]\d|25[0-5])[dwy]$/);
        expect(core.lifecycleTtl(30)).toBe("30d");
        expect(core.lifecycleTtl(365)).toBe("1y");
    });

    it("sets the rule on the bucket's folder, and refuses a prefix that leaves it", () => {
        expect(core.lifecycleRuleLine("logs", "tmp", 7)).toBe("fs.configure -locationPrefix=/buckets/logs/tmp/ -ttl=7d -apply");
        expect(core.lifecycleRuleLine("logs", "", 1)).toBe("fs.configure -locationPrefix=/buckets/logs/ -ttl=1d -apply");
        expect(() => core.lifecycleRuleLine("logs", "../other", 7)).toThrow();
        expect(() => core.lifecycleRuleLine("logs", "a b", 7)).toThrow();
    });

    it("reads stored rules back, dropping anything that is not one", () => {
        expect(core.parseLifecycleRules('[{"prefix":"tmp/","days":7},{"prefix":"../x","days":1},{"days":3}]')).toEqual([
            { prefix: "tmp/", days: 7 }
        ]);
        expect(core.parseLifecycleRules("not json")).toEqual([]);
    });
});

describe("the engine's shell", () => {
    it("prints each line into the shell as a positional argument", () => {
        const command = core.weedShellCommand(["s3.bucket.list"], "Listing");
        expect(command.argv.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(command.argv.slice(3)).toEqual(["polaris", "s3.bucket.list"]);
    });

    it("refuses a line that would carry a second command", () => {
        expect(() => core.weedShellCommand(["s3.bucket.list\ns3.bucket.delete -name x"], "x")).toThrow();
    });

    it("reads a failure from the output, since the exit status does not always say", () => {
        expect(core.weedShellFailure("error: bucket not found\n")).toBe("bucket not found");
        // stderr merged after a prompt the shell printed on stdout.
        expect(core.weedShellFailure("> error: bucket not found\n")).toBe("bucket not found");
        expect(core.weedShellFailure("created bucket files\nno error: here\n")).toBeNull();
    });

    it("scopes a key to its bucket and refuses characters that would split the line", () => {
        expect(
            core.storeIdentityLine({ user: "key-AK", accessKey: "AK", secretKey: "s-3_cr", actions: core.bucketActions("readonly"), bucket: "files" })
        ).toBe("s3.configure -user=key-AK -access_key=AK -secret_key=s-3_cr -actions=Read,List -buckets=files -apply");
        expect(() => core.storeIdentityLine({ user: "u", accessKey: "AK", secretKey: "a b", actions: "Admin" })).toThrow();
    });

    it("lists the bucket names from the shell's output", () => {
        expect(core.parseBucketList("> files\tsize:12\tchunk:3\n  logs\tsize:0\n> \n")).toEqual(["files", "logs"]);
    });
});

describe("replication", () => {
    it("passes both stores and both buckets as arguments to a process it starts once", () => {
        const command = core.replicationEnsureCommand({
            id: ID,
            sourceFiler: "polaris-files-a",
            targetFiler: "polaris-files-b",
            sourceBucket: "media",
            targetBucket: "media-copy"
        });
        expect(command.argv.slice(3)).toEqual([
            "polaris",
            `/data/.polaris-sync-${ID}.pid`,
            `/data/.polaris-sync-${ID}.log`,
            "polaris-files-a:8888",
            "polaris-files-b:8888",
            "/buckets/media",
            "/buckets/media-copy"
        ]);
        expect(command.argv[2]).toContain("-isActivePassive");
        expect(command.argv[2]).toContain('grep -q filer.sync "/proc/$pid/cmdline"');
    });
});

describe("presigned URLs", () => {
    it("signs for an address with a protocol and host only", () => {
        expect(core.parseStoreBaseUrl("https://files.example.com")).toEqual({ protocol: "https", host: "files.example.com" });
        expect(core.parseStoreBaseUrl("http://10.0.0.5:9000/")).toEqual({ protocol: "http", host: "10.0.0.5:9000" });
        expect(core.parseStoreBaseUrl("https://files.example.com/prefix")).toBeNull();
        expect(core.parseStoreBaseUrl("https://user:pw@files.example.com")).toBeNull();
        expect(core.parseStoreBaseUrl("ftp://files.example.com")).toBeNull();
    });

    it("refuses a key that climbs out of the bucket, and a lifetime SigV4 does not allow", () => {
        const base = { bucketId: ID, key: "a/b.png", method: "GET", expiresIn: 3600 } as const;
        expect(core.presignSchema.safeParse(base).success).toBe(true);
        expect(core.presignSchema.safeParse({ ...base, key: "../x" }).success).toBe(false);
        expect(core.presignSchema.safeParse({ ...base, expiresIn: 700_000 }).success).toBe(false);
        expect(core.presignSchema.safeParse({ ...base, baseUrl: "https://x.example.com/y" }).success).toBe(false);
    });
});

describe("references", () => {
    it("answers for an object store with the names S3 clients read", () => {
        const keys = core.databaseReferenceKeys({
            engine: "seaweedfs",
            host: "polaris-files",
            port: 8333,
            database: "",
            username: "PLRSAAAA",
            password: "secret",
            uri: "http://polaris-files:8333"
        });
        expect(keys).toMatchObject({
            S3_ENDPOINT: "http://polaris-files:8333",
            AWS_ENDPOINT_URL_S3: "http://polaris-files:8333",
            AWS_ACCESS_KEY_ID: "PLRSAAAA",
            AWS_SECRET_ACCESS_KEY: "secret",
            S3_FORCE_PATH_STYLE: "true",
            URL: "http://polaris-files:8333"
        });
    });
});

describe("cache purge", () => {
    it("takes a path under the hostname and drops a leading slash", () => {
        expect(core.cachePurgeSchema.parse({ domainId: ID, prefix: "/assets/" }).prefix).toBe("assets/");
        expect(core.cachePurgeSchema.safeParse({ domainId: ID, prefix: "../x" }).success).toBe(false);
        expect(core.cachePurgeSchema.safeParse({ domainId: ID, prefix: "a?b=1" }).success).toBe(false);
        expect(core.cachePurgeSchema.safeParse({ domainId: ID }).success).toBe(true);
    });
});
