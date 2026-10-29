/**
 * What this app remembers between runs: the Polaris it opens, the other ones it
 * has opened (`shared/servers`), and for each service pushed from here the
 * folder and platform used last time.
 *
 * A JSON file in the app's own data folder. It holds nothing secret - the API
 * key lives in `api-key-store`, encrypted by the operating system - and it is
 * read through a schema, so a file a newer or older build wrote, or one edited
 * by hand, falls back to defaults instead of breaking the app.
 */

import { z } from "zod";
import { app } from "electron";
import { join } from "node:path";
import { readServerAddress } from "@/shared/server-address";
import { readServers, withServer, type SavedServer } from "@/shared/servers";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** A platform `docker build --platform` takes, or "" for this computer's own. */
export const PUSH_PLATFORMS = ["", "linux/amd64", "linux/arm64"] as const;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

const pushSchema = z.object({
    folder: z.string().max(4096),
    platform: z.enum(PUSH_PLATFORMS).catch("")
});

export type PushChoice = z.infer<typeof pushSchema>;

const settingsSchema = z.object({
    server: z.unknown().transform(readServerAddress).catch(null),
    servers: z.unknown().transform(readServers).catch([]),
    pushes: z.record(z.string().uuid(), pushSchema).catch({})
});

type Settings = z.infer<typeof settingsSchema>;

const EMPTY: Settings = { server: null, servers: [], pushes: {} };

function file(): string {
    return join(app.getPath("userData"), "settings.json");
}

function load(): Settings {
    try {
        const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file(), "utf8")));
        return parsed.success ? parsed.data : { ...EMPTY };
    } catch {
        return { ...EMPTY };
    }
}

/** Written beside the file and renamed over it, so a crash mid-write leaves the
 *  previous settings rather than an empty file. */
function save(settings: Settings): void {
    const temp = `${file()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(settings, null, 4), { mode: 0o600 });
    renameSync(temp, file());
}

/** The Polaris this app opens, or null before the first run has asked. */
export function serverAddress(): string | null {
    return load().server;
}

/** Open this server from now on, and keep it in the list. */
export function setServerAddress(origin: string | null): void {
    const settings = load();
    save({ ...settings, server: origin, servers: origin ? withServer(knownServers(settings), origin) : settings.servers });
}

/**
 * Every server this app has opened, the one in use included. A settings file
 * written before the list existed has only the one address, which becomes the
 * list's first entry.
 */
export function savedServers(): SavedServer[] {
    return knownServers(load());
}

function knownServers(settings: Settings): SavedServer[] {
    return settings.server ? withServer(settings.servers, settings.server) : settings.servers;
}

/** Replace the list. The server in use stays in it whatever the list says. */
export function setSavedServers(servers: readonly SavedServer[]): void {
    const settings = load();
    save({ ...settings, servers: knownServers({ ...settings, servers: [...servers] }) });
}

/** What was used the last time this service was pushed from here. */
export function pushChoice(serviceId: string): PushChoice | null {
    return load().pushes[serviceId] ?? null;
}

export function rememberPushChoice(serviceId: string, choice: PushChoice): void {
    const settings = load();
    save({ ...settings, pushes: { ...settings.pushes, [serviceId]: choice } });
}
