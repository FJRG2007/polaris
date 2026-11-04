/**
 * A picture or a recording sent to be translated is read in memory and never
 * kept: no Translate table has a column for bytes or a file, and none of the
 * routes that receive one writes to a disk, a storage or the database.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";

const dashboard = join(__dirname, "..", "..", "..", "..", "..");
const schema = readFileSync(join(dashboard, "packages", "db", "prisma", "schema.prisma"), "utf8");

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

describe("translating a picture keeps no picture", () => {
    it("gives no Translate table a place for bytes or a file", () => {
        const models = [...schema.matchAll(/^model (Translate\w*) \{([\s\S]*?)^\}/gm)];
        expect(models.length).toBeGreaterThan(0);
        for (const [, name, body] of models) {
            expect(body, name).not.toMatch(/\bBytes\b/);
            expect(body, name).not.toMatch(/^\s*(image|picture|file|thumbnail|upload|blob)\w*\s/im);
        }
    });

    it("writes nothing where a picture or a recording is received", () => {
        const sources = [
            ...files(
                join(dashboard, "apps", "translate", "src", "routes", "api", "translate", "image")
            ),
            ...files(
                join(
                    dashboard,
                    "apps",
                    "translate",
                    "src",
                    "routes",
                    "api",
                    "translate",
                    "transcribe"
                )
            ),
            join(dashboard, "apps", "translate", "src", "lib", "media.ts"),
            join(dashboard, "apps", "web", "src", "lib", "translate", "server-media.ts"),
            join(dashboard, "apps", "web", "src", "app", "api", "attachments", "fetch", "route.ts")
        ];
        for (const path of sources) {
            const text = readFileSync(path, "utf8");
            expect(text, path).not.toMatch(/\b(writeFile|createWriteStream|mkdtemp|putObject)\b/);
            expect(text, path).not.toMatch(/prisma\.\w+\.(create|update|upsert)/);
        }
    });
});
