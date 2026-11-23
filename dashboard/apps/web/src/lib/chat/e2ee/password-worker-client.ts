/**
 * The page's side of the password worker: the same four OPAQUE client steps as
 * `@polaris/chat-crypto/password-lock`, each run in a Web Worker so its
 * Argon2id never blocks the page (docs/chat-e2ee-phase1.md, "Sign-in speed").
 *
 * There is deliberately no fallback onto the page's thread: a worker that cannot
 * start (a chunk that failed to load offline, a browser that refuses it) or that
 * dies under memory pressure rejects, and every caller treats a rejection as
 * "sign in the old way, try again next time".
 */

import type { PasswordKsfVersion } from "@polaris/chat-crypto/password-lock";

/** Long enough for the slowest phone, short enough that a stuck worker never holds a sign-in. */
const STEP_TIMEOUT_MS = 20_000;
/** Kept for a little while after the last step, so a sign-in and its adoption share one worker. */
const IDLE_MS = 30_000;

export type PasswordRequest =
    | { readonly op: "start-registration"; readonly password: string }
    | {
          readonly op: "finish-registration";
          readonly input: { state: string; registrationResponse: string; password: string; userId: string };
      }
    | { readonly op: "start-login"; readonly password: string }
    | {
          readonly op: "finish-login";
          readonly input: {
              state: string;
              loginResponse: string;
              password: string;
              userId: string;
              ksfVersion?: PasswordKsfVersion;
          };
      };

interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

/** The worker's `PasswordRejectedError`, by name: importing the class would pull
 *  the OPAQUE module onto the page's thread. */
function rejectedPassword(): Error {
    const error = new Error("The password did not match");
    error.name = "PasswordRejectedError";
    return error;
}

let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

function stop(reason: string): void {
    worker?.terminate();
    worker = null;
    for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
        pending.delete(id);
    }
}

function started(): Worker {
    if (worker) return worker;
    const made = new Worker(new URL("./password-worker.ts", import.meta.url), {
        type: "module",
        name: "Password lock"
    });
    made.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value?: unknown; rejected?: boolean }>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        clearTimeout(entry.timer);
        if (event.data.ok) entry.resolve(event.data.value);
        else entry.reject(event.data.rejected ? rejectedPassword() : new Error("The password step failed"));
        if (pending.size === 0) idleSoon();
    };
    made.onerror = () => stop("The password worker stopped");
    worker = made;
    return made;
}

function idleSoon(): void {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
        if (pending.size === 0) stop("idle");
    }, IDLE_MS);
}

function call<T>(request: PasswordRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (idle) clearTimeout(idle);
        const id = ++nextId;
        const timer = setTimeout(() => stop("The password step took too long"), STEP_TIMEOUT_MS);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        try {
            started().postMessage({ id, request });
        } catch (caught) {
            stop(caught instanceof Error ? caught.message : "The password worker did not start");
        }
    });
}

export function startPasswordRegistration(password: string): Promise<{ state: string; registrationRequest: string }> {
    return call({ op: "start-registration", password });
}

export function finishPasswordRegistration(input: {
    state: string;
    registrationResponse: string;
    password: string;
    userId: string;
}): Promise<{ registrationRecord: string; lockKey: CryptoKey; ksfVersion: PasswordKsfVersion }> {
    return call({ op: "finish-registration", input });
}

export function startPasswordLogin(password: string): Promise<{ state: string; startLoginRequest: string }> {
    return call({ op: "start-login", password });
}

export function finishPasswordLogin(input: {
    state: string;
    loginResponse: string;
    password: string;
    userId: string;
    ksfVersion?: PasswordKsfVersion;
}): Promise<{ finishLoginRequest: string; lockKey: CryptoKey }> {
    return call({ op: "finish-login", input });
}
