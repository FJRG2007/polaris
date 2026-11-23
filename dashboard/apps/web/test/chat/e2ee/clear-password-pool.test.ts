/**
 * The pool that checks a password handed over in the clear against an OPAQUE
 * record (`lib/chat/e2ee/clear-password-pool.ts`): on real worker threads, with
 * the real OPAQUE module, so the Argon2id never runs on the event loop.
 */

import { describe, expect, it } from "vitest";
import * as server from "@polaris/chat-crypto/opaque-server";
import * as client from "@polaris/chat-crypto/password-lock";
import { checkFloorMs, passwordOpensRecordOffThread } from "@/lib/chat/e2ee/clear-password-pool";

const ALICE = "0190a1b2-0000-7000-8000-00000000000a";
const BOB = "0190a1b2-0000-7000-8000-00000000000b";
const PASSWORD = "checked off the loop";

async function recordFor(setup: string, userId: string, password: string): Promise<string> {
    const started = await client.startPasswordRegistration(password);
    const response = await server.registrationResponse(setup, userId, started.registrationRequest);
    const finished = await client.finishPasswordRegistration({
        state: started.state,
        registrationResponse: response,
        password,
        userId,
        accountKey: new Uint8Array(32).fill(4),
        akVersion: 1
    });
    return finished.registrationRecord;
}

describe("a password checked in the clear", { timeout: 120_000 }, () => {
    it("opens its own record only, and never holds the event loop while it runs", async () => {
        const setup = await server.createServerSetup();
        const record = await recordFor(setup, ALICE, PASSWORD);
        const check = (userId: string, password: string, version: client.PasswordKsfVersion = 2) =>
            passwordOpensRecordOffThread({
                serverSetup: setup,
                userId,
                record,
                password,
                keyStretching: client.passwordKsf(version)
            });

        // The loop keeps ticking while a check runs: a timer set at 5 ms fires
        // long before the Argon2id on the other thread is done.
        let ticks = 0;
        const ticker = setInterval(() => ticks++, 5);
        const right = check(ALICE, PASSWORD);
        expect(await right).toBe(true);
        clearInterval(ticker);
        expect(ticks).toBeGreaterThan(2);

        expect(await check(ALICE, "checked off the loo")).toBe(false);
        expect(await check(BOB, PASSWORD)).toBe(false);
        expect(await check(ALICE, PASSWORD, 1)).toBe(false);
        expect(await check(ALICE, "")).toBe(false);
        expect(
            await passwordOpensRecordOffThread({
                serverSetup: await server.createServerSetup(),
                userId: ALICE,
                record,
                password: PASSWORD,
                keyStretching: client.passwordKsf(2)
            })
        ).toBe(false);
        // A broken job is a no, never a throw.
        expect(
            await passwordOpensRecordOffThread({ serverSetup: "", userId: "", record: "", password: PASSWORD, keyStretching: null })
        ).toBe(false);
    });

    it("refuses what it cannot queue instead of waiting without end", async () => {
        const setup = await server.createServerSetup();
        const record = await recordFor(setup, ALICE, PASSWORD);
        const job = { serverSetup: setup, userId: ALICE, record, password: "wrong", keyStretching: client.passwordKsf(2) };
        const answers = await Promise.all(Array.from({ length: 80 }, () => passwordOpensRecordOffThread(job)));
        expect(answers.every((opens) => opens === false)).toBe(true);
    });

    it("pads failures to well above what the recent checks cost, within bounds", () => {
        const floor = checkFloorMs();
        expect(floor).toBeGreaterThanOrEqual(250);
        expect(floor).toBeLessThanOrEqual(3_000);
    });
});
