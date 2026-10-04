/**
 * The CLI's profiles: one per Polaris (or per account on one), and which is in use.
 *
 * Holds no secret. The token of each profile lives in the OS keychain, or in a
 * separate 0600 file where there is none (see `secrets.ts`), so this file can be
 * read, backed up or pasted into a bug report without handing anything over.
 *
 * Read through a schema: it is a file on disk somebody may have edited, and a
 * profile that no longer parses is reported as such rather than half-used.
 */

import { z } from "zod";
import { CliError } from "./errors.js";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

/** A profile name: what `--profile` and `plr profile use` take. */
export const profileNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/, "Use letters, digits, dots, dashes, underscores and colons.");

export const profileSchema = z.object({
    /** The Polaris address, without a trailing slash. */
    url: z.string().url(),
    /** Who it is signed in as, as the server reported it at login. */
    account: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    /** The API key behind the token, as listed on the API keys screen. */
    keyId: z.string(),
    scopes: z.array(z.string()),
    /** Where the token is: the OS keychain, or the fallback file. */
    storage: z.enum(["keychain", "file"]),
    signedInAt: z.string()
});

export type Profile = z.infer<typeof profileSchema>;

const configSchema = z.object({
    current: z.string().nullable().default(null),
    profiles: z.record(profileSchema).default({})
});

export type Config = z.infer<typeof configSchema>;

/** The config file inside a config directory. */
export function configFile(dir: string): string {
    return join(dir, "config.json");
}

/** Read the config, or the empty one when there is none yet. */
export async function loadConfig(dir: string): Promise<Config> {
    let raw: string;
    try {
        raw = await readFile(configFile(dir), "utf8");
    } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT")
            return { current: null, profiles: {} };
        throw caught;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new CliError(
            `${configFile(dir)} is not valid JSON. Fix it or delete it, then run plr login.`
        );
    }
    const config = configSchema.safeParse(parsed);
    if (!config.success) {
        throw new CliError(
            `${configFile(dir)} is not a config this CLI understands. Delete it and run plr login.`
        );
    }
    return config.data;
}

/**
 * Write the config in one step: to a temporary file beside it, then renamed over
 * it, so an interrupted write leaves the old config rather than an empty one.
 * The directory is 0700 and the file 0600 - it holds no secret, but it does say
 * which accounts this machine is signed in to.
 */
export async function saveConfig(dir: string, config: Config): Promise<void> {
    const file = configFile(dir);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => undefined);
}

/** A profile name for an address that has none yet: its host, with the port. */
export function profileNameFor(url: string): string {
    const host = new URL(url).host.replace(/[^A-Za-z0-9._:-]/g, "-");
    return profileNameSchema.safeParse(host).success ? host : "default";
}
