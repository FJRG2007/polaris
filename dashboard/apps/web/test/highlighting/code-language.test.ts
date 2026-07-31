/**
 * Which grammar a file or a Markdown fence gets. Polaris only highlights what
 * this table resolves, so what matters is that the names people keep code under
 * resolve at all - including the ones with no extension to go on - that a fence
 * tag and an extension reach the same grammar, and that no two grammars quietly
 * claim the same token, which would make the winner depend on table order.
 */

import { describe, expect, it } from "vitest";
import {
    CODE_LANGUAGES,
    languageForFile,
    languageForToken
} from "../../src/lib/code-language";

describe("languageForFile", () => {
    it("resolves the everyday configuration and source extensions", () => {
        const expected: Record<string, string> = {
            "package.json": "json",
            "docker-compose.yml": "yaml",
            "tsconfig.jsonc": "json",
            "theme.css": "css",
            "theme.scss": "scss",
            "main.rs": "rust",
            "server.ts": "typescript",
            "page.tsx": "typescript",
            "script.mjs": "javascript",
            "setup.py": "python",
            "Cargo.toml": "ini",
            "deploy.sh": "bash",
            "schema.sql": "sql",
            "index.html": "xml"
        };
        for (const [name, id] of Object.entries(expected)) {
            expect(languageForFile(name)?.id, name).toBe(id);
        }
    });

    it("recognizes the files whose whole name is the only clue", () => {
        expect(languageForFile("Dockerfile")?.id).toBe("dockerfile");
        expect(languageForFile("makefile")?.id).toBe("makefile");
        expect(languageForFile("CMakeLists.txt")?.id).toBe("cmake");
        expect(languageForFile("Jenkinsfile")?.id).toBe("groovy");
        expect(languageForFile(".zshrc")?.id).toBe("bash");
    });

    it("treats every .env flavor as configuration", () => {
        expect(languageForFile(".env")?.id).toBe("ini");
        expect(languageForFile(".env.production")?.id).toBe("ini");
    });

    it("leaves anything it has no grammar for alone", () => {
        expect(languageForFile("notes.txt")).toBeUndefined();
        expect(languageForFile("photo.raw")).toBeUndefined();
        expect(languageForFile("LICENSE")).toBeUndefined();
    });
});

describe("languageForToken", () => {
    it("accepts the fence tags a document is likely to carry", () => {
        expect(languageForToken("ts")?.id).toBe("typescript");
        expect(languageForToken("JSON")?.id).toBe("json");
        expect(languageForToken("console")?.id).toBe("bash");
        expect(languageForToken("gql")?.id).toBe("graphql");
        expect(languageForToken("c++")?.id).toBe("cpp");
    });

    it("resolves a fence tag and an extension to the same grammar", () => {
        expect(languageForToken("yml")).toBe(languageForFile("compose.yaml"));
    });

    it("has nothing for an unknown tag", () => {
        expect(languageForToken("brainfuck")).toBeUndefined();
        expect(languageForToken("")).toBeUndefined();
    });
});

describe("the language table", () => {
    it("never lets two grammars claim the same token", () => {
        const claimed = new Map<string, string>();
        for (const language of CODE_LANGUAGES) {
            for (const token of [language.id, ...language.tokens]) {
                const owner = claimed.get(token);
                expect(owner ?? language.id, `"${token}" is claimed twice`).toBe(language.id);
                claimed.set(token, language.id);
            }
        }
    });
});
