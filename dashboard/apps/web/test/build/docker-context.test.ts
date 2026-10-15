import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The image's build context keeps every source file.
 *
 * `dashboard/.dockerignore` drops anything named `secrets` so a key directory
 * never reaches an image. The runner secrets screen lives in a folder of that
 * name, so it was dropped too: `next build` from a checkout served it, and every
 * deployed dashboard answered `/apps/runners/secrets` with its 404 page. Nothing
 * else notices, because the image build succeeds without the route.
 *
 * The rules are matched the way Docker matches them: a pattern is anchored at the
 * context root, `**` spans directories, a pattern that matches a directory takes
 * everything under it, and the last pattern that matches decides.
 */

const CONTEXT = join(__dirname, "..", "..", "..", "..");

/** Directories that are build output or dependencies, never source. */
const SKIP = new Set(["node_modules", ".next", "dist", ".turbo", ".gradle", "generated", "build", "coverage"]);

type Rule = { negate: boolean; pattern: RegExp };

function toRegExp(glob: string): RegExp {
    let source = "";
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === "*" && glob[index + 1] === "*") {
            const slash = glob[index + 2] === "/";
            source += slash ? "(?:.*/)?" : ".*";
            index += slash ? 2 : 1;
        } else if (char === "*") source += "[^/]*";
        else if (char === "?") source += "[^/]";
        else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`);
}

function rules(): Rule[] {
    return readFileSync(join(CONTEXT, ".dockerignore"), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const negate = line.startsWith("!");
            const glob = (negate ? line.slice(1) : line).replace(/^\/+|\/+$/g, "");
            return { negate, pattern: toRegExp(glob) };
        });
}

/** Whether Docker leaves a context-relative path out of the build context. */
function excluded(path: string, list: Rule[]): boolean {
    const parts = path.split("/");
    const candidates = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
    let out = false;
    for (const rule of list) {
        if (candidates.some((candidate) => rule.pattern.test(candidate))) out = !rule.negate;
    }
    return out;
}

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (SKIP.has(entry.name)) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.(tsx?|css)$/.test(entry.name) ? [relative(CONTEXT, path).split("\\").join("/")] : [];
    });
}

describe("the dashboard image's build context", () => {
    const list = rules();

    it("matches the way Docker does", () => {
        expect(excluded("secrets/ssh/id_ed25519", list)).toBe(true);
        expect(excluded("apps/web/secrets", list)).toBe(true);
        expect(excluded("apps/web/.env", list)).toBe(true);
        expect(excluded("apps/web/.env.example", list)).toBe(false);
        expect(excluded("apps/web/src/app/page.tsx", list)).toBe(false);
    });

    it("keeps every source file of every workspace", () => {
        const roots = ["apps", "packages", "services"].flatMap((base) =>
            readdirSync(join(CONTEXT, base), { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(CONTEXT, base, entry.name, "src"))
        );
        const files = roots.flatMap((root) => {
            try {
                return sources(root);
            } catch {
                return [];
            }
        });
        expect(files).toContain("apps/web/src/app/(app)/apps/runners/secrets/page.tsx");
        expect(files.filter((file) => excluded(file, list))).toEqual([]);
    });
});
