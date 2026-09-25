import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toSqliteSchema } from "../../../scripts/gen-sqlite-schema.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dbDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function prismaBin() {
    const manifestPath = createRequire(join(dbDir, "package.json")).resolve("prisma/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return join(dirname(manifestPath), manifest.bin.prisma);
}

describe("toSqliteSchema", () => {
    it("stores a list of scalars as Json and leaves relation lists alone", () => {
        const out = toSqliteSchema(
            [
                "model Message {",
                "    reasons  String[]",
                "    tags     String[] @default([])",
                "    replies  Reply[]",
                "}"
            ].join("\n")
        );
        expect(out).toContain("    reasons  Json\n");
        expect(out).toContain(`    tags     Json @default(dbgenerated("'[]'"))\n`);
        expect(out).toContain("    replies  Reply[]\n");
    });

    it("gives a Json default as a quoted SQL literal", () => {
        const out = toSqliteSchema(['    counted  Json  @default("{}")', '    note     Json? @default("it\'s")'].join("\n"));
        expect(out).toContain(`    counted  Json  @default(dbgenerated("'{}'"))`);
        expect(out).toContain(`    note     Json? @default(dbgenerated("'it''s'"))`);
    });

    // What `npm run dev:up` does with the generated file: push it into a fresh
    // SQLite database. Validation alone passes schemas SQLite then refuses.
    it("turns the real schema into one a SQLite database accepts", () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-sqlite-schema-"));
        try {
            const schema = join(dir, "schema.sqlite.prisma");
            writeFileSync(schema, toSqliteSchema(readFileSync(join(dbDir, "prisma", "schema.prisma"), "utf8")));
            execFileSync(
                process.execPath,
                [prismaBin(), "db", "push", `--schema=${schema}`, "--skip-generate", "--accept-data-loss"],
                {
                    env: { ...process.env, POLARIS_DATABASE_URL: `file:${join(dir, "dev.db").replaceAll("\\", "/")}` },
                    stdio: "pipe"
                }
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
