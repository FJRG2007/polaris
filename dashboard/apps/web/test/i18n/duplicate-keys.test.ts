/**
 * No catalog says the same key twice in one object.
 *
 * `JSON.parse` keeps the last of two equal keys without a word, so a second
 * `errors.locationDenied` written for another screen silently replaced the
 * first one's text everywhere it was shown. That only shows up by reading the
 * file itself, which is what this does - for the dashboard's catalogs and every
 * installable app's.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");

/** Every `.json` under each app's `messages` folder. */
function catalogFiles(): string[] {
    const files: string[] = [];
    const walk = (folder: string): void => {
        for (const entry of readdirSync(folder)) {
            const path = join(folder, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.endsWith(".json")) files.push(path);
        }
    };
    for (const app of readdirSync(APPS)) {
        const root = join(APPS, app, "messages");
        if (existsSync(root) && statSync(root).isDirectory()) walk(root);
    }
    return files.sort();
}

/** Reads one JSON string starting at the opening quote; returns it and the index after it. */
function readString(text: string, start: number): [string, number] {
    let end = start + 1;
    while (text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
    return [JSON.parse(text.slice(start, end + 1)) as string, end + 1];
}

/**
 * The dotted path of every key that appears twice in the same object. The text
 * is assumed to be valid JSON (the catalogs test parses it), so only strings,
 * braces, brackets, colons and commas need telling apart.
 */
function duplicateKeys(text: string): string[] {
    const found: string[] = [];
    // One frame per open container: the keys seen so far, or null for an array.
    const frames: { keys: Set<string> | null; path: string }[] = [];
    let pendingKey: string | null = null;
    let expectKey = false;
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === "\"") {
            const [value, next] = readString(text, index);
            index = next;
            const frame = frames.at(-1);
            if (expectKey && frame?.keys) {
                const path = frame.path ? `${frame.path}.${value}` : value;
                if (frame.keys.has(value)) found.push(path);
                frame.keys.add(value);
                pendingKey = path;
                expectKey = false;
            }
            continue;
        }
        if (char === "{" || char === "[") {
            const parent = frames.at(-1);
            const path = pendingKey ?? (parent ? `${parent.path}[]` : "");
            frames.push({ keys: char === "{" ? new Set() : null, path });
            expectKey = char === "{";
            pendingKey = null;
        } else if (char === "}" || char === "]") {
            frames.pop();
        } else if (char === ",") {
            expectKey = Boolean(frames.at(-1)?.keys);
        }
        index += 1;
    }
    return found;
}

describe("duplicateKeys", () => {
    it("finds a key repeated in one object, by its path", () => {
        expect(duplicateKeys("{\"errors\": {\"a\": \"x\", \"b\": {\"a\": 1}, \"a\": \"y\"}}")).toEqual(["errors.a"]);
    });

    it("lets the same key appear in different objects", () => {
        expect(duplicateKeys("{\"a\": {\"x\": 1}, \"b\": {\"x\": 2}, \"c\": [{\"x\": 1}, {\"x\": 2}]}")).toEqual([]);
    });

    it("is not fooled by braces, quotes or keys inside values", () => {
        expect(duplicateKeys("{\"a\": \"{\\\"a\\\": 1}\", \"b\": \"a\"}")).toEqual([]);
    });
});

describe("the catalogs", () => {
    const files = catalogFiles();

    it("include the dashboard's, so this cannot pass by reading nothing", () => {
        expect(files.some((file) => file.replace(/\\/g, "/").includes("/web/messages/en-US/"))).toBe(true);
    });

    it.each(files.map((file) => [file.slice(APPS.length + 1).replace(/\\/g, "/"), file]))(
        "%s repeats no key in one object",
        (_name, file) => {
            expect(duplicateKeys(readFileSync(file, "utf8"))).toEqual([]);
        }
    );
});
