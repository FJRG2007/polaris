/**
 * The SuperGrok device login, step by step, against answers shaped like
 * xAI's (fixtures: field names from OpenCode's `xai.ts` schemas, values made
 * up - no live login was recorded).
 */

import { describe, expect, it } from "vitest";
import type { DirectPost } from "@/lib/agents/signin-direct";
import {
    XAI_DEVICE_CODE_URL,
    XAI_TOKEN_URL,
    pollXaiDevice,
    refreshXaiTokens,
    requestXaiDevice,
    xaiNeedsRefresh
} from "@/lib/agents/signin-xai";

const NOW = 1_000_000;

function answering(status: number, json: unknown, seen: unknown[] = []): DirectPost {
    return async (url, body) => {
        seen.push({ url, body });
        return { status, json };
    };
}

const DEVICE_ANSWER = {
    device_code: "fixture-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://accounts.x.ai/device",
    verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
    expires_in: 600,
    interval: 5
};

describe("xAI device login", () => {
    it("asks for a code with the client, scope and form body OpenCode sends", async () => {
        const seen: unknown[] = [];
        const device = await requestXaiDevice(answering(200, DEVICE_ANSWER, seen), NOW);
        expect(seen).toEqual([
            {
                url: XAI_DEVICE_CODE_URL,
                body: {
                    form: {
                        client_id: "b1a00492-073a-47ea-816f-4c329264a828",
                        scope: "openid profile email offline_access grok-cli:access api:access",
                        referrer: "opencode"
                    }
                }
            }
        ]);
        expect(device).toEqual({
            deviceCode: "fixture-device-code",
            userCode: "ABCD-EFGH",
            verificationUrl: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
            intervalMs: 5000,
            expiresAt: NOW + 600_000
        });
    });

    it("refuses a code answer that does not parse", async () => {
        await expect(requestXaiDevice(answering(200, { user_code: 1 }), NOW)).rejects.toThrow(
            "unexpected answer"
        );
        await expect(requestXaiDevice(answering(500, {}), NOW)).rejects.toThrow("HTTP 500");
    });

    it("reads every waiting state of a poll", async () => {
        const device = await requestXaiDevice(answering(200, DEVICE_ANSWER), NOW);
        const poll = (json: unknown) => pollXaiDevice(answering(400, json), device, NOW);
        expect(await poll({ error: "authorization_pending" })).toEqual({ state: "pending" });
        expect(await poll({ error: "slow_down" })).toEqual({ state: "slower" });
        expect(await poll({ error: "access_denied" })).toEqual({ state: "denied" });
        expect(await poll({ error: "expired_token" })).toEqual({ state: "expired" });
        await expect(poll({ error: "server_error" })).rejects.toThrow("HTTP 400");
        expect(await pollXaiDevice(answering(200, {}), device, device.expiresAt)).toEqual({
            state: "expired"
        });
    });

    it("ends with tokens once approved", async () => {
        const device = await requestXaiDevice(answering(200, DEVICE_ANSWER), NOW);
        const seen: unknown[] = [];
        const result = await pollXaiDevice(
            answering(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }, seen),
            device,
            NOW
        );
        expect(result).toEqual({
            state: "done",
            tokens: { access: "at", refresh: "rt", expires: NOW + 3_600_000 }
        });
        expect(seen[0]).toMatchObject({ url: XAI_TOKEN_URL });
    });

    it("refuses a login with no refresh token", async () => {
        const device = await requestXaiDevice(answering(200, DEVICE_ANSWER), NOW);
        await expect(pollXaiDevice(answering(200, { access_token: "at" }), device, NOW)).rejects.toThrow(
            "no refresh token"
        );
    });

    it("refreshes, keeping the refresh token xAI did not rotate", async () => {
        const tokens = { access: "old", refresh: "rt", expires: NOW };
        const refreshed = await refreshXaiTokens(
            answering(200, { access_token: "new", expires_in: 60 }),
            tokens,
            NOW
        );
        expect(refreshed).toEqual({ access: "new", refresh: "rt", expires: NOW + 60_000 });
        expect(xaiNeedsRefresh(tokens, NOW)).toBe(true);
        expect(xaiNeedsRefresh({ ...tokens, expires: NOW + 3_600_000 }, NOW)).toBe(false);
    });
});
