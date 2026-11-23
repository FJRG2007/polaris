/**
 * The source of the thread that checks a password handed over in the clear
 * against an OPAQUE record, by running both halves of a login there
 * (`clear-password-pool.ts`). The one Argon2id it costs never runs on the
 * server's event loop.
 *
 * It is a string rather than a file for the reason `code-sandbox-worker.ts`
 * gives: a worker file is a path the server bundle cannot follow. The OPAQUE
 * package is resolved by the host and handed in as an absolute path, and the
 * key-stretching profile arrives with each job, so this thread holds no
 * setting of its own.
 *
 * Each job answers `{ id, opens }` and nothing else: never the password, the
 * record or an error's text.
 */

export const CLEAR_PASSWORD_WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const opaque = require(workerData.opaque);

async function opens(job) {
    await opaque.ready;
    if (!job.userId) return false;
    const identifiers = { client: job.userId };
    const started = opaque.client.startLogin({ password: job.password });
    const step = opaque.server.startLogin({
        serverSetup: job.serverSetup,
        userIdentifier: job.userId,
        registrationRecord: job.record,
        startLoginRequest: started.startLoginRequest,
        identifiers
    });
    const finished = opaque.client.finishLogin({
        clientLoginState: started.clientLoginState,
        loginResponse: step.loginResponse,
        password: job.password,
        identifiers,
        keyStretching: job.keyStretching
    });
    if (!finished) return false;
    opaque.server.finishLogin({
        serverLoginState: step.serverLoginState,
        finishLoginRequest: finished.finishLoginRequest,
        identifiers
    });
    return true;
}

parentPort.on("message", (job) => {
    opens(job).then(
        (result) => parentPort.postMessage({ id: job.id, opens: result === true }),
        () => parentPort.postMessage({ id: job.id, opens: false })
    );
});
`;
