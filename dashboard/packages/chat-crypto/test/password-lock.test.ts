/**
 * The password lock end to end, client and server halves together, at the real
 * Argon2id profile (128 MiB): a registration and a login open the account key;
 * a wrong password, another account's record, a replayed login state and a
 * swapped envelope all fail closed.
 */

import { LockOpenError } from "../src/locks";
import { describe, expect, it } from "vitest";
import * as client from "../src/password-lock";
import * as server from "../src/opaque-server";

const AK = new Uint8Array(32).fill(4);
const ALICE = "0190a1b2-0000-7000-8000-00000000000a";
const BOB = "0190a1b2-0000-7000-8000-00000000000b";

async function register(setup: string, userId: string, password: string, akVersion = 1) {
    const started = await client.startPasswordRegistration(password);
    const response = await server.registrationResponse(setup, userId, started.registrationRequest);
    return client.finishPasswordRegistration({
        state: started.state,
        registrationResponse: response,
        password,
        userId,
        accountKey: AK,
        akVersion
    });
}

async function login(setup: string, userId: string, record: string | null, password: string) {
    const started = await client.startPasswordLogin(password);
    const step = await server.startLogin(setup, userId, record, started.startLoginRequest);
    const finished = await client.finishPasswordLogin({
        state: started.state,
        loginResponse: step.loginResponse,
        password,
        userId
    });
    const accepted = await server.finishLogin(userId, step.serverLoginState, finished.finishLoginRequest);
    return { ...finished, accepted, serverLoginState: step.serverLoginState };
}

describe("password lock over OPAQUE", { timeout: 120_000 }, () => {
    it("registers, logs in, and opens the account key", async () => {
        const setup = await server.createServerSetup();
        const { registrationRecord, envelope } = await register(setup, ALICE, "correct horse");
        const done = await login(setup, ALICE, registrationRecord, "correct horse");
        expect(done.accepted).toBe(true);
        const opened = await client.openWithPassword(envelope, done.lockKey, ALICE, 1);
        expect(Array.from(opened)).toEqual(Array.from(AK));
        expect(done.lockKey.extractable).toBe(false);
    });

    it("rejects a wrong password on the client, before anything is sent", async () => {
        const setup = await server.createServerSetup();
        const { registrationRecord } = await register(setup, ALICE, "correct horse");
        await expect(login(setup, ALICE, registrationRecord, "wrong horse")).rejects.toBeInstanceOf(
            client.PasswordRejectedError
        );
    });

    it("rejects a record presented under another account and an account with no record", async () => {
        const setup = await server.createServerSetup();
        const { registrationRecord } = await register(setup, ALICE, "correct horse");
        await expect(login(setup, BOB, registrationRecord, "correct horse")).rejects.toBeInstanceOf(
            client.PasswordRejectedError
        );
        await expect(login(setup, BOB, null, "correct horse")).rejects.toBeInstanceOf(
            client.PasswordRejectedError
        );
    });

    it("rejects a login against another server setup", async () => {
        const setup = await server.createServerSetup();
        const { registrationRecord } = await register(setup, ALICE, "correct horse");
        const other = await server.createServerSetup();
        await expect(login(other, ALICE, registrationRecord, "correct horse")).rejects.toBeInstanceOf(
            client.PasswordRejectedError
        );
    });

    it("refuses a finish replayed against another login's state", async () => {
        const setup = await server.createServerSetup();
        const { registrationRecord } = await register(setup, ALICE, "correct horse");
        const first = await login(setup, ALICE, registrationRecord, "correct horse");
        const second = await login(setup, ALICE, registrationRecord, "correct horse");
        expect(await server.finishLogin(ALICE, second.serverLoginState, first.finishLoginRequest)).toBe(
            false
        );
    });

    it("does not open an envelope swapped from another account or version", async () => {
        const setup = await server.createServerSetup();
        const alice = await register(setup, ALICE, "same password");
        const bob = await register(setup, BOB, "same password", 2);
        const done = await login(setup, ALICE, alice.registrationRecord, "same password");
        await expect(client.openWithPassword(bob.envelope, done.lockKey, ALICE, 1)).rejects.toBeInstanceOf(
            LockOpenError
        );
        await expect(client.openWithPassword(alice.envelope, done.lockKey, ALICE, 2)).rejects.toBeInstanceOf(
            LockOpenError
        );
    });

    it("stretches with Argon2id at 128 MiB, fixed in code", () => {
        expect(client.PASSWORD_KSF_V1["argon2id-custom"].memory).toBe(128 * 1024);
    });
});
