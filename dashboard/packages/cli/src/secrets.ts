/**
 * Where a profile's token is kept: the OS keychain, or a 0600 file where there
 * is none.
 *
 * **The keychain through the tools each system ships**, not through a native
 * addon. The vetted option for Node (`@napi-rs/keyring`) is a compiled binary per
 * platform and architecture, and this CLI is one JavaScript file each Polaris
 * serves at `/cli/polaris.mjs` - a native addon cannot travel inside it, and
 * serving a dozen prebuilt binaries beside it would be a second distribution to
 * keep in step. The systems' own tools do the same job with no dependency:
 *
 * - macOS: `security`, the Keychain's own command. The secret is written through
 *   its interactive mode on stdin, so it never appears in the process list the
 *   way an argument would.
 * - Linux: `secret-tool` (libsecret: GNOME Keyring, KWallet), which reads the
 *   secret from stdin.
 * - Windows: the Credential Locker (`PasswordVault`), driven from Windows
 *   PowerShell with a fixed script; the secret goes in on stdin.
 *
 * Every tool is spawned with an argument array and no shell. When the tool is
 * missing or refuses (a server with no D-Bus session, a locked keychain), the
 * token goes to `credentials.json` in the config directory instead, created
 * 0600 - which is what `gh`, `railway` and the AWS CLI do everywhere.
 */

import { join } from "node:path";
import { CliError } from "./errors.js";
import type { Host } from "./paths.js";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

/** The keychain entry's service name. Its own, never the server's. */
export const KEYCHAIN_SERVICE = "polaris-cli";

/** What a Polaris token looks like (`plk_<prefix>.<secret>`). Anything else is
 *  refused before it reaches a keychain command or a file. */
const TOKEN_SHAPE = /^[A-Za-z0-9._-]{16,512}$/;

/** A finished child process. */
export interface RunResult {
    readonly code: number | null;
    readonly stdout: string;
    /** False when the program could not be started at all (not installed). */
    readonly started: boolean;
}

/** How the stores start programs, so a test can stand in for the keychain. */
export type Runner = (
    command: string,
    args: readonly string[],
    options?: { readonly input?: string; readonly env?: Record<string, string> }
) => Promise<RunResult>;

/** Starts a program with an argument array, no shell, a bounded wait, and
 *  stdin closed after `input`. */
export const spawnRunner: Runner = (command, args, options = {}) =>
    new Promise((resolve) => {
        let stdout = "";
        let child;
        try {
            child = spawn(command, [...args], {
                shell: false,
                windowsHide: true,
                timeout: 20_000,
                env: { ...process.env, ...options.env },
                stdio: ["pipe", "pipe", "ignore"]
            });
        } catch {
            resolve({ code: null, stdout: "", started: false });
            return;
        }
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => (stdout += chunk));
        child.on("error", () => resolve({ code: null, stdout: "", started: false }));
        child.on("close", (code) => resolve({ code, stdout, started: true }));
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(options.input ?? "");
    });

export interface SecretStore {
    readonly kind: "keychain" | "file";
    get(account: string): Promise<string | null>;
    /** False when this store cannot hold it here, so the caller falls back. */
    set(account: string, secret: string): Promise<boolean>;
    delete(account: string): Promise<void>;
}

/**
 * The Windows script. Fixed text passed as `-EncodedCommand`, so nothing in it is
 * interpolated; what it acts on arrives in the environment, and the secret on
 * stdin. Exit 3 means "no such entry".
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
$service = $env:POLARIS_CLI_SERVICE
$account = $env:POLARIS_CLI_ACCOUNT
switch ($env:POLARIS_CLI_OP) {
    'get' {
        try { $entry = $vault.Retrieve($service, $account) } catch { exit 3 }
        $entry.RetrievePassword()
        [Console]::Out.Write($entry.Password)
    }
    'set' {
        $secret = [Console]::In.ReadToEnd()
        try { $vault.Remove($vault.Retrieve($service, $account)) } catch { }
        $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($service, $account, $secret)))
    }
    'delete' {
        try { $vault.Remove($vault.Retrieve($service, $account)) } catch { exit 3 }
    }
}
`;

/** The script as PowerShell's -EncodedCommand wants it: UTF-16LE, base64. */
function encodedWindowsScript(): string {
    return Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
}

/** The OS keychain, through the system's own tool. */
export function keychainStore(host: Host, run: Runner): SecretStore {
    if (host.platform === "win32") {
        const call = (op: string, account: string, input?: string) =>
            run(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedWindowsScript()],
                {
                    input,
                    env: {
                        POLARIS_CLI_OP: op,
                        POLARIS_CLI_SERVICE: KEYCHAIN_SERVICE,
                        POLARIS_CLI_ACCOUNT: account
                    }
                }
            );
        return {
            kind: "keychain",
            async get(account) {
                const result = await call("get", account);
                return result.code === 0 && result.stdout ? result.stdout : null;
            },
            async set(account, secret) {
                const result = await call("set", account, secret);
                return result.code === 0;
            },
            async delete(account) {
                await call("delete", account);
            }
        };
    }
    if (host.platform === "darwin") {
        return {
            kind: "keychain",
            async get(account) {
                const result = await run("security", [
                    "find-generic-password",
                    "-s",
                    KEYCHAIN_SERVICE,
                    "-a",
                    account,
                    "-w"
                ]);
                return result.code === 0 ? result.stdout.trim() || null : null;
            },
            async set(account, secret) {
                // Through the interactive mode on stdin, so the secret is never an
                // argument. Both values are checked against plain shapes first,
                // because that mode splits its line on whitespace.
                const result = await run("security", ["-i"], {
                    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${secret}\n`
                });
                if (result.code !== 0) return false;
                return (await this.get(account)) === secret;
            },
            async delete(account) {
                await run("security", [
                    "delete-generic-password",
                    "-s",
                    KEYCHAIN_SERVICE,
                    "-a",
                    account
                ]);
            }
        };
    }
    return {
        kind: "keychain",
        async get(account) {
            const result = await run("secret-tool", [
                "lookup",
                "service",
                KEYCHAIN_SERVICE,
                "account",
                account
            ]);
            return result.code === 0 ? result.stdout.trim() || null : null;
        },
        async set(account, secret) {
            const result = await run(
                "secret-tool",
                [
                    "store",
                    `--label=Polaris CLI (${account})`,
                    "service",
                    KEYCHAIN_SERVICE,
                    "account",
                    account
                ],
                { input: secret }
            );
            return result.code === 0;
        },
        async delete(account) {
            await run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account]);
        }
    };
}

/** The fallback: `credentials.json` in the config directory, 0600. */
export function fileStore(dir: string): SecretStore {
    const file = join(dir, "credentials.json");
    const readAll = async (): Promise<Record<string, string>> => {
        try {
            const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            return Object.fromEntries(
                Object.entries(parsed).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string"
                )
            );
        } catch {
            return {};
        }
    };
    const writeAll = async (all: Record<string, string>): Promise<void> => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        // Created 0600 rather than chmodded after, so there is no moment when
        // another account on the machine could read it.
        await writeFile(temporary, `${JSON.stringify(all, null, 4)}\n`, { mode: 0o600 });
        await rename(temporary, file);
        await chmod(file, 0o600).catch(() => undefined);
    };
    return {
        kind: "file",
        async get(account) {
            return (await readAll())[account] ?? null;
        },
        async set(account, secret) {
            await writeAll({ ...(await readAll()), [account]: secret });
            return true;
        },
        async delete(account) {
            const all = await readAll();
            if (!(account in all)) return;
            delete all[account];
            await writeAll(all);
        }
    };
}

export interface Secrets {
    /** Keep a token; answers where it went. */
    save(account: string, token: string): Promise<"keychain" | "file">;
    read(account: string, where: "keychain" | "file"): Promise<string | null>;
    /** Remove it from wherever it is. Best-effort on the keychain. */
    forget(account: string): Promise<void>;
}

/**
 * The keychain first, the file when the keychain cannot take it.
 * `POLARIS_CLI_NO_KEYCHAIN=1` skips the keychain, for a machine where its prompt
 * gets in the way (a CI runner, a container).
 */
export function secrets(host: Host, dir: string, run: Runner = spawnRunner): Secrets {
    const file = fileStore(dir);
    const keychain = host.env.POLARIS_CLI_NO_KEYCHAIN === "1" ? null : keychainStore(host, run);
    return {
        async save(account, token) {
            if (!TOKEN_SHAPE.test(token)) {
                throw new CliError(
                    "Polaris answered with a credential this CLI does not recognise. Run plr update, then plr login."
                );
            }
            if (keychain && (await keychain.set(account, token).catch(() => false))) {
                // A copy left in the file from an earlier sign-in would outlive
                // this one, so it goes.
                await file.delete(account);
                return "keychain";
            }
            await file.set(account, token);
            return "file";
        },
        async read(account, where) {
            if (where === "keychain")
                return keychain ? keychain.get(account).catch(() => null) : null;
            return file.get(account);
        },
        async forget(account) {
            await keychain?.delete(account).catch(() => undefined);
            await file.delete(account);
        }
    };
}
