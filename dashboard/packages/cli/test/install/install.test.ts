/**
 * The installed copy looking after itself, and where it keeps things: never in
 * the places a Polaris server keeps its own.
 */

import { describe, expect, it } from "vitest";
import type { Host } from "../../src/paths.js";
import { scriptedFetch, testContext } from "../helpers/context.js";
import { configDir, installDir, binDir } from "../../src/paths.js";
import { fetchBundle, sha256, withoutMarkedLines } from "../../src/commands/install.js";

const BUNDLE = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('plr');\n");

function serving(body: Uint8Array, digest: string | null) {
    return scriptedFetch({
        "GET /cli/polaris.mjs": () =>
            new Response(body, { headers: digest ? { "x-content-sha256": digest } : {} })
    }).fetch;
}

describe("plr update's download", () => {
    it("is taken when it matches the digest the server sent", async () => {
        const { context } = await testContext({ fetch: serving(BUNDLE, sha256(BUNDLE)) });
        expect(await fetchBundle(context, "https://polaris.example.com")).toEqual(BUNDLE);
    });

    it("is refused when it does not, or when there is no digest", async () => {
        const { context } = await testContext({ fetch: serving(BUNDLE, "0".repeat(64)) });
        await expect(fetchBundle(context, "https://polaris.example.com")).rejects.toThrow(
            /checksum/
        );
        const bare = await testContext({ fetch: serving(BUNDLE, null) });
        await expect(fetchBundle(bare.context, "https://polaris.example.com")).rejects.toThrow(
            /checksum/
        );
    });

    it("is refused when it is not a CLI at all, whatever its digest", async () => {
        const page = new TextEncoder().encode("<html>not found</html>");
        const { context } = await testContext({ fetch: serving(page, sha256(page)) });
        await expect(fetchBundle(context, "https://polaris.example.com")).rejects.toThrow(
            /not a CLI/
        );
    });
});

it("uninstall takes out only the PATH lines the installer added", () => {
    const rc =
        'alias ll="ls -l"\nexport PATH="$HOME/.local/bin:$PATH" # polaris-developer-cli\nexport EDITOR=vim';
    expect(withoutMarkedLines(rc)).toBe('alias ll="ls -l"\nexport EDITOR=vim');
});

describe("where the CLI keeps things", () => {
    const linux: Host = { platform: "linux", env: {}, home: "/home/dev" };
    const mac: Host = { platform: "darwin", env: {}, home: "/Users/dev" };
    const windows: Host = {
        platform: "win32",
        env: {
            APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
            LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local"
        },
        home: "C:\\Users\\dev"
    };

    it("follows each system's convention", () => {
        expect(configDir(linux)).toBe("/home/dev/.config/polaris-cli");
        expect(configDir({ ...linux, env: { XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/polaris-cli");
        expect(configDir(mac)).toBe("/Users/dev/Library/Application Support/polaris-cli");
        expect(configDir(windows)).toBe("C:\\Users\\dev\\AppData\\Roaming\\polaris-cli");
        expect(installDir(windows)).toBe("C:\\Users\\dev\\AppData\\Local\\Programs\\polaris-cli");
        expect(binDir(linux)).toBe("/home/dev/.local/bin");
    });

    it("never shares a folder with the server's own script", () => {
        // The server's script keeps its sign-in in ~/.config/polaris and lives
        // in /usr/local/bin or %LOCALAPPDATA%\Polaris\bin.
        expect(configDir(linux)).not.toBe("/home/dev/.config/polaris");
        expect(binDir(linux)).not.toBe("/usr/local/bin");
        expect(installDir(windows)).not.toBe("C:\\Users\\dev\\AppData\\Local\\Polaris\\bin");
    });
});
