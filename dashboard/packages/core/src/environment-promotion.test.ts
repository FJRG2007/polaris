import { describe, expect, it } from "vitest";
import {
    effectiveStage,
    environmentPromotionSchema,
    nextStage,
    parseHexRows,
    parseWordpressPrefixes,
    rowsContainingCommand,
    runScriptCommand,
    updateRowsScript,
    wordpressValueTables,
    pinnedImageRef,
    planPromotion,
    wordpressAddressCommand
} from "./environment-promotion.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";
const CLIENT = { engine: "mariadb", username: "app", password: "fixture-pass", database: "app" } as const;

describe("environment stages", () => {
    it("reads an unmarked default environment as production and others as unset", () => {
        expect(effectiveStage({ stage: null, isDefault: true })).toBe("production");
        expect(effectiveStage({ stage: null, isDefault: false })).toBeNull();
        expect(effectiveStage({ stage: "staging", isDefault: true })).toBe("staging");
        expect(effectiveStage({ stage: "nonsense", isDefault: false })).toBeNull();
    });

    it("moves work development -> staging -> production", () => {
        expect(nextStage("development")).toBe("staging");
        expect(nextStage("staging")).toBe("production");
        expect(nextStage("production")).toBeNull();
        expect(nextStage(null)).toBeNull();
    });
});

describe("environmentPromotionSchema", () => {
    it("refuses promoting an environment into itself", () => {
        const result = environmentPromotionSchema.safeParse({
            sourceEnvironmentId: SOURCE_ID,
            targetEnvironmentId: SOURCE_ID
        });
        expect(result.success).toBe(false);
    });

    it("leaves the data alone unless asked", () => {
        const result = environmentPromotionSchema.parse({
            sourceEnvironmentId: SOURCE_ID,
            targetEnvironmentId: TARGET_ID
        });
        expect(result.includeData).toBe(false);
    });
});

describe("planPromotion", () => {
    it("pairs by slug, names what the target lacks, and never touches the target's extras", () => {
        const plan = planPromotion(
            {
                services: [
                    { id: "s-web", slug: "web", name: "Web" },
                    { id: "s-worker", slug: "worker", name: "Worker" }
                ],
                databases: [
                    { id: "s-db", slug: "db", name: "DB", engine: "mariadb" },
                    { id: "s-cache", slug: "cache", name: "Cache", engine: "redis" }
                ]
            },
            {
                services: [
                    { id: "t-web", slug: "web", name: "Web" },
                    { id: "t-extra", slug: "extra", name: "Extra" }
                ],
                databases: [
                    { id: "t-db", slug: "db", name: "DB", engine: "mysql" },
                    { id: "t-cache", slug: "cache", name: "Cache", engine: "postgres" }
                ]
            }
        );
        expect(plan.services).toEqual([{ name: "Web", sourceId: "s-web", targetId: "t-web" }]);
        expect(plan.databases).toEqual([{ name: "DB", sourceId: "s-db", targetId: "t-db" }]);
        expect(plan.skipped).toEqual([
            { kind: "service", name: "Worker", reason: "missing" },
            { kind: "database", name: "Cache", reason: "engine" }
        ]);
    });
});

describe("WordPress address rewrite", () => {
    it("keeps only real prefixes from the listing", () => {
        expect(parseWordpressPrefixes("wp_\nblog_\n\nbad prefix_\nwp_\n")).toEqual(["wp_", "blog_"]);
    });

    it("rewrites home, siteurl and post links for every install", () => {
        const command = wordpressAddressCommand(CLIENT, {
            prefixes: ["wp_"],
            from: "staging.example.test",
            to: "www.example.test"
        });
        expect(command?.argv.slice(0, 6)).toEqual(["mariadb", "-uapp", "-pfixture-pass", "-N", "-B", "app"]);
        const sql = command?.argv.at(-1) ?? "";
        expect(sql).toContain("UPDATE `wp_options`");
        expect(sql).toContain("'//staging.example.test', '//www.example.test'");
        expect(sql).toContain("UPDATE `wp_posts`");
    });

    it("refuses an address that is not a host name instead of quoting it", () => {
        expect(
            wordpressAddressCommand(CLIENT, { prefixes: ["wp_"], from: "a.test'; DROP TABLE x; --", to: "b.test" })
        ).toBeNull();
        expect(wordpressAddressCommand(CLIENT, { prefixes: ["wp_"], from: "a.test", to: "a.test" })).toBeNull();
        expect(wordpressAddressCommand(CLIENT, { prefixes: ["x`y_"], from: "a.test", to: "b.test" })).toBeNull();
    });
});

describe("pinnedImageRef", () => {
    const digest = `sha256:${"a".repeat(64)}`;

    it("pins a Docker Hub tag however the digest spells the repository", () => {
        expect(pinnedImageRef("wordpress:7.1-apache", [`docker.io/library/wordpress@${digest}`])).toBe(
            `wordpress@${digest}`
        );
        expect(pinnedImageRef("library/nginx", [`nginx@${digest}`])).toBe(`library/nginx@${digest}`);
    });

    it("keeps a registry with a port and ignores other repositories", () => {
        expect(
            pinnedImageRef("registry.test:5000/acme/web:1.2", [`other/web@${digest}`, `registry.test:5000/acme/web@${digest}`])
        ).toBe(`registry.test:5000/acme/web@${digest}`);
        expect(pinnedImageRef("acme/web:1.2", [`other/web@${digest}`])).toBeNull();
    });

    it("returns a pinned reference as it is and refuses a malformed digest", () => {
        expect(pinnedImageRef(`acme/web@${digest}`, [])).toBe(`acme/web@${digest}`);
        expect(pinnedImageRef("acme/web:1", ["acme/web@sha256:short"])).toBeNull();
        expect(pinnedImageRef("", [`acme/web@${digest}`])).toBeNull();
    });
});
describe("serialized value rewrite statements", () => {
    const options = { table: "blog_options", id: "option_id", value: "option_value" };

    it("finds each install's option and metadata tables by name", () => {
        expect(
            wordpressValueTables("blog_options\nblog_posts\nblog_postmeta\nblog_usermeta\nshop_options\nother_posts\nbad name\n")
        ).toEqual([
            options,
            { table: "blog_postmeta", id: "meta_id", value: "meta_value" },
            { table: "blog_usermeta", id: "umeta_id", value: "meta_value" }
        ]);
    });

    it("reads pages by id with the needle as a hex literal", () => {
        const command = rowsContainingCommand(CLIENT, options, "//a.test", "41", 100);
        const sql = command.argv.at(-1) ?? "";
        expect(sql).toContain("`option_id` > 41");
        expect(sql).toContain(`X'${Buffer.from("//a.test").toString("hex")}'`);
        expect(sql).toContain("LIMIT 100");
        expect(() => rowsContainingCommand(CLIENT, options, "x", "1 OR 1=1", 10)).toThrow();
        expect(() => rowsContainingCommand(CLIENT, { ...options, table: "x`y" }, "x", "1", 10)).toThrow();
    });

    it("parses hex rows and skips anything else", () => {
        expect(parseHexRows("7\t68690A\nnot a row\n8\t\n9\tABC\n")).toEqual([
            { id: "7", value: Buffer.from("hi\n") },
            { id: "8", value: Buffer.alloc(0) }
        ]);
    });

    it("binds every value and id through one prepared statement", () => {
        const hostile = "it's'; DROP TABLE x;--";
        const script = updateRowsScript(options, [{ id: "7", value: Buffer.from(hostile) }]);
        expect(script).toContain(
            "PREPARE polaris_write FROM 'UPDATE `blog_options` SET `option_value` = ? WHERE `option_id` = ?';"
        );
        expect(script).toContain(`@polaris_value = X'${Buffer.from(hostile).toString("hex")}'`);
        expect(script).not.toContain("DROP TABLE");
        expect(() => updateRowsScript(options, [{ id: "7; DROP", value: Buffer.alloc(0) }])).toThrow();
    });

    it("runs a script with each value as its own argument", () => {
        expect(runScriptCommand(CLIENT, "/tmp/polaris-x.sql").argv).toEqual([
            "sh",
            "-c",
            '"$0" -u"$1" -p"$2" "$3" < "$4"',
            "mariadb",
            "app",
            "fixture-pass",
            "app",
            "/tmp/polaris-x.sql"
        ]);
    });
});
