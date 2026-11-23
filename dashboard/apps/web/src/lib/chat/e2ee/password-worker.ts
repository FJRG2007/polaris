/**
 * The password lock's Argon2id, off the page's thread (docs/chat-e2ee-phase1.md,
 * "Sign-in speed"): every OPAQUE client step runs here, so the key stretching
 * never freezes the sign-in form, and the OPAQUE WebAssembly is never loaded on
 * the page at all.
 *
 * One request at a time per message; the lock key goes back as a
 * non-extractable CryptoKey, so its bytes never reach the page either.
 */

import * as passwordLock from "@polaris/chat-crypto/password-lock";
import type { PasswordRequest } from "@/lib/chat/e2ee/password-worker-client";

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<{ id: number; request: PasswordRequest }>) => void) | null;
    postMessage(message: unknown): void;
};

async function run(request: PasswordRequest): Promise<unknown> {
    switch (request.op) {
        case "start-registration":
            return passwordLock.startPasswordRegistration(request.password);
        case "finish-registration": {
            const finished = await passwordLock.finishPasswordRegistration(request.input);
            return {
                registrationRecord: finished.registrationRecord,
                lockKey: finished.lockKey,
                ksfVersion: finished.ksfVersion
            };
        }
        case "start-login":
            return passwordLock.startPasswordLogin(request.password);
        case "finish-login":
            return passwordLock.finishPasswordLogin(request.input);
    }
}

scope.onmessage = (event) => {
    const { id, request } = event.data;
    run(request).then(
        (value) => scope.postMessage({ id, ok: true, value }),
        () => scope.postMessage({ id, ok: false })
    );
};
