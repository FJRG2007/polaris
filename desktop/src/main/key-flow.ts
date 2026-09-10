/**
 * Getting the API key a push needs: the one kept for this Polaris, or one pasted
 * into the key window, checked against the instance, and then kept.
 *
 * Asked for once. The key is checked with `GET /api/v1/me` before it is kept, so
 * a mistyped or revoked key is refused in the form it was pasted into rather
 * than halfway through a push. Where the system cannot keep it encrypted, it is
 * held in memory for as long as the app runs and never written.
 */

import { openLocalWindow } from "./windows";
import type { BrowserWindow } from "electron";
import type { Outcome } from "@/shared/bridge";
import { apiKeySchema } from "@/shared/api-key";
import { ApiFailure, callJson, meSchema } from "./polaris-api";
import { canKeepApiKey, forgetApiKey, keepApiKey, readApiKey } from "./api-key-store";

const REFUSED = "Polaris refused that key - it may have been revoked or have expired.";

let remembered: { server: string; key: string } | null = null;

/** The open key form, and every push waiting on it. */
let asking: {
    server: string;
    window: BrowserWindow;
    waiting: Array<(key: string | null) => void>;
} | null = null;

function settle(key: string | null): void {
    const current = asking;
    asking = null;
    for (const resolve of current?.waiting ?? []) resolve(key);
}

/** The key for this Polaris, asking for it when there is none. Null when the
 *  person closed the form, or when `signal` aborted while it was open - the
 *  form then closes unless another push is still waiting on it. */
export function apiKeyFor(
    server: string,
    parent?: BrowserWindow,
    signal?: AbortSignal
): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (remembered?.server === server) return Promise.resolve(remembered.key);
    const kept = readApiKey(server);
    if (kept) return Promise.resolve(kept);
    return new Promise((resolve) => {
        const give = (key: string | null) => {
            signal?.removeEventListener("abort", abandon);
            resolve(key);
        };
        const abandon = () => {
            const current = asking;
            const at = current ? current.waiting.indexOf(give) : -1;
            if (!current || at < 0) return;
            current.waiting.splice(at, 1);
            resolve(null);
            if (current.waiting.length === 0) current.window.close();
        };
        signal?.addEventListener("abort", abandon, { once: true });
        if (asking?.server === server) {
            asking.waiting.push(give);
            asking.window.focus();
            return;
        }
        const replaced = asking;
        settle(null);
        replaced?.window.close();
        const window = openLocalWindow("api-key", {
            title: "API key - Polaris",
            width: 520,
            height: 470,
            parent
        });
        asking = { server, window, waiting: [give] };
        window.on("closed", () => {
            if (asking?.window === window) settle(null);
        });
    });
}

/** Forget the key everywhere, after the instance refused it. */
export function dropApiKey(): void {
    remembered = null;
    forgetApiKey();
}

export function keyFormState(): { server: string; canKeep: boolean } {
    return { server: asking?.server ?? "", canKeep: canKeepApiKey() };
}

/** A key pasted into the form: checked, kept, and handed to the pushes waiting. */
export async function submitApiKey(raw: unknown): Promise<Outcome> {
    const current = asking;
    if (!current) return { ok: false, error: "Nothing is waiting for a key. Close this window." };
    const parsed = apiKeySchema.safeParse(raw);
    if (!parsed.success)
        return { ok: false, error: parsed.error.issues[0]?.message ?? "That is not an API key." };
    try {
        await callJson({ server: current.server, key: parsed.data }, "/api/v1/me", meSchema);
    } catch (caught) {
        if (caught instanceof ApiFailure)
            return { ok: false, error: caught.status === 401 ? REFUSED : caught.message };
        return { ok: false, error: "Could not check the key with Polaris. Try again." };
    }
    if (asking !== current)
        return { ok: false, error: "This form was replaced. Close this window." };
    remembered = { server: current.server, key: parsed.data };
    keepApiKey(current.server, parsed.data);
    settle(parsed.data);
    current.window.close();
    return { ok: true };
}

export function cancelApiKey(): void {
    asking?.window.close();
}
