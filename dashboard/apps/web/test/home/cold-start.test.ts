/**
 * A Places module reached before the dashboard has provided its services.
 *
 * Next loads a server action on its own, without the page or route that would
 * have provided them, so on a fresh process the first request can evaluate any
 * of these modules with nothing provided. Every one of them has to load anyway:
 * a module that uses a service while it is being evaluated, rather than when it
 * is called, is a form that does nothing after every restart.
 */

import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { provideAppHost } from "@polaris/app-host";
import { serverHost } from "@/lib/app-host/server";

const SRC = resolve(__dirname, "../../../places/src");
const SLOT = Symbol.for("polaris.app-host.server");

/** Every module of the app that runs on the server. */
function serverModules(): string[] {
    const found: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
            const full = join(directory, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (
                /\.tsx?$/.test(entry) &&
                !/^\s*["']use client["']/.test(readFileSync(full, "utf8"))
            )
                found.push(full);
        }
    };
    walk(SRC);
    return found;
}

const modules = serverModules();

afterAll(() => provideAppHost(serverHost));

describe("Places modules loaded before the dashboard provides its services", () => {
    it("are found at all, so this cannot pass by loading nothing", () => {
        expect(modules.some((file) => file.endsWith(join("screens", "actions.ts")))).toBe(true);
        expect(modules.length).toBeGreaterThan(40);
    });

    it.each(modules.map((file) => [file.slice(SRC.length + 1)]))("%s loads", async (file) => {
        delete (globalThis as Record<symbol, unknown>)[SLOT];
        await expect(import(join(SRC, file))).resolves.toBeTruthy();
    });
});
