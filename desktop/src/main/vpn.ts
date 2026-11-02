/**
 * This computer's VPN. The tunnel and its private key belong to a system service
 * (`desktop/vpn-helper`), so the app can be closed, crash or update without
 * touching either. The first connect installs the service under the system's own
 * prompt; a later version of the app replaces it the same way.
 *
 * A refusal is a word the page turns into a sentence in the reader's language:
 * `denied` for a prompt turned down, the rest from the service.
 */

import { app } from "electron";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { Outcome } from "@/shared/bridge";
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import {
    askHelper,
    deviceNameFrom,
    elevatedInstall,
    HELPER_VERSION,
    joinSchema,
    tailscalePath,
    type HelperReply
} from "./vpn-helper-client";

const INSTALL_WAIT_MS = 15_000;
const JOIN_WAIT_MS = 60_000;

const secretFile = (): string => join(app.getPath("userData"), "vpn-secret");

async function readSecret(): Promise<string> {
    const held = await readFile(secretFile(), "utf8").catch(() => "");
    if (/^[0-9a-f]{64}\s*$/.test(held)) return held.trim();
    const made = randomBytes(32).toString("hex");
    await writeFile(secretFile(), made, { mode: 0o600 });
    return made;
}

function bundledHelper(): string {
    const name = process.platform === "win32" ? "polaris-vpn-helper.exe" : "polaris-vpn-helper";
    return join(process.resourcesPath, "vpn-helper", name);
}

/**
 * The helper as root can read it. An AppImage is a mount only its own user can
 * enter, so on Linux it goes through a copy in the app's own folder.
 */
async function reachableHelper(): Promise<string> {
    const bundled = bundledHelper();
    if (process.platform !== "linux") return bundled;
    const folder = join(app.getPath("userData"), "vpn-helper");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const copy = join(folder, "polaris-vpn-helper");
    await copyFile(bundled, copy);
    await chmod(copy, 0o700);
    return copy;
}

async function install(): Promise<boolean> {
    const helper = await reachableHelper();
    const launch = elevatedInstall(process.platform, helper, secretFile());
    return new Promise((resolve) => {
        const child = spawn(launch.file, [...launch.args], {
            windowsHide: true,
            stdio: "ignore",
            env: { ...process.env, ...launch.env }
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });
}

function isCurrent(reply: HelperReply | null): boolean {
    return reply?.ok === true && (reply.version ?? 0) >= HELPER_VERSION;
}

/** A service that answers the orders of this app, installing it if there is none. */
async function service(): Promise<string | null> {
    const secret = await readSecret();
    if (isCurrent(await askHelper({ order: "status" }, secret))) return secret;
    if (!(await install())) return null;
    const deadline = Date.now() + INSTALL_WAIT_MS;
    while (Date.now() < deadline) {
        if (isCurrent(await askHelper({ order: "status" }, secret))) return secret;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
}

export function vpnDeviceName(): string {
    return deviceNameFrom(hostname());
}

export async function vpnKey(): Promise<string | null> {
    const secret = await service();
    if (!secret) return null;
    return (await askHelper({ order: "key" }, secret))?.publicKey ?? null;
}

function outcomeOf(reply: HelperReply | null): Outcome {
    if (reply?.ok) return { ok: true };
    return { ok: false, error: reply?.code ?? "failed" };
}

export async function vpnUp(connection: Record<string, unknown>): Promise<Outcome> {
    const secret = await service();
    if (!secret) return { ok: false, error: "denied" };
    return outcomeOf(await askHelper({ ...connection, order: "up" }, secret));
}

export async function vpnDown(): Promise<Outcome> {
    return outcomeOf(await askHelper({ order: "down" }, await readSecret()));
}

/** Never installs anything: opening the screen raises no prompt. */
export async function vpnStatus(): Promise<{ nodeId: string | null; }> {
    const reply = await askHelper({ order: "status" }, await readSecret());
    return { nodeId: reply?.nodeId ?? null };
}

/** Signs this computer into a private network, with a key that works once. */
export async function vpnJoinNetwork(raw: unknown): Promise<Outcome> {
    const input = joinSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: "failed" };
    const { server, key } = input.data;
    return new Promise((resolve) => {
        execFile(
            tailscalePath(process.platform),
            ["up", `--login-server=${server}`, `--auth-key=${key}`],
            { timeout: JOIN_WAIT_MS, windowsHide: true },
            (error) => {
                if (!error) return resolve({ ok: true });
                const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
                return resolve({ ok: false, error: missing ? "noClient" : "failed" });
            }
        );
    });
}
