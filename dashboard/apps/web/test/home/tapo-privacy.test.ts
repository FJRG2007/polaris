/**
 * Tapo privacy over the camera's own local API, with no network.
 *
 * The fixture (`fixtures/tapo-privacy.json`) was computed in Python with the
 * formulas of pytapo's transport (`pytapo/transport/pytapo/pytapo.py`), apart
 * from the code under test, so a wrong concatenation order or hash shows up as
 * a mismatch instead of a camera that silently stops answering.
 */

import { describe, expect, it } from "vitest";
import fixture from "./fixtures/tapo-privacy.json";
import * as crypto from "@polaris-app/places/src/lib/integrations/tapo-camera-crypto";
import {
    lensMask,
    lockoutSeconds,
    TapoError,
    type TapoTransport
} from "@polaris-app/places/src/lib/integrations/tapo-camera";

const { cnonce, nonce, password } = fixture;

describe("the encrypt_type 3 arithmetic", () => {
    it("hashes the password the camera's way", () => {
        expect(crypto.hashedPassword(password, "md5")).toBe(fixture.md5);
        expect(crypto.hashedPassword(password, "sha256")).toBe(fixture.sha256);
    });

    it("tells which hash the camera used, and refuses a wrong password", () => {
        expect(crypto.confirmedHash(password, cnonce, nonce, fixture.deviceConfirmSha256)).toBe(
            "sha256"
        );
        expect(crypto.confirmedHash(password, cnonce, nonce, fixture.deviceConfirmMd5)).toBe("md5");
        expect(
            crypto.confirmedHash("wrong", cnonce, nonce, fixture.deviceConfirmSha256)
        ).toBeNull();
    });

    it("builds the digest, the session key and IV, the cipher and the tag", () => {
        expect(crypto.digestPassword(fixture.sha256, cnonce, nonce)).toBe(fixture.digest);
        const session = crypto.secureSession(fixture.sha256, cnonce, nonce);
        expect(session.key.toString("hex")).toBe(fixture.lsk);
        expect(session.iv.toString("hex")).toBe(fixture.ivb);
        expect(crypto.encryptRequest(session, fixture.inner)).toBe(fixture.encrypted);
        expect(crypto.decryptResponse(session, fixture.answerEncrypted)).toBe(fixture.answer);
        expect(crypto.requestTag(fixture.sha256, cnonce, fixture.body, fixture.seq)).toBe(
            fixture.tag
        );
    });
});

type Sent = {
    url: string;
    body: { method: string; params: Record<string, unknown> };
    seq?: string;
};

/** A camera on secure firmware, answering from the fixture's session. */
function secureCamera(options: { userGroup?: string; mask?: "on" | "off" } = {}) {
    const sent: Sent[] = [];
    const session = crypto.secureSession(fixture.sha256, cnonce, nonce);
    let mask = options.mask ?? "off";
    const send: TapoTransport = async ({ url, body, headers }) => {
        const json = JSON.parse(body) as Sent["body"];
        sent.push({ url, body: json, seq: headers.Seq });
        if (json.method === "login" && !json.params.digest_passwd)
            return {
                status: 200,
                fingerprint: "AA:BB",
                json: {
                    error_code: -40413,
                    result: {
                        data: {
                            code: -40401,
                            encrypt_type: ["3"],
                            nonce,
                            device_confirm: fixture.deviceConfirmSha256
                        }
                    }
                }
            };
        if (json.method === "login") {
            expect(json.params.digest_passwd).toBe(fixture.digest);
            return {
                status: 200,
                fingerprint: "AA:BB",
                json: {
                    error_code: 0,
                    result: { stok: "STOK", start_seq: 7, user_group: options.userGroup ?? "root" }
                }
            };
        }
        expect(json.method).toBe("securePassthrough");
        expect(url).toBe("https://192.168.1.20:443/stok=STOK/ds");
        expect(headers.Tapo_tag).toBe(
            crypto.requestTag(fixture.sha256, cnonce, body, Number(headers.Seq))
        );
        const inner = JSON.parse(crypto.decryptResponse(session, String(json.params.request))) as {
            params: {
                requests: {
                    method: string;
                    params: { lens_mask: { lens_mask_info?: { enabled: "on" | "off" } } };
                }[];
            };
        };
        const request = inner.params.requests[0]!;
        if (request.method === "setLensMaskConfig")
            mask = request.params.lens_mask.lens_mask_info!.enabled;
        const answer = {
            error_code: 0,
            result: {
                responses: [
                    {
                        method: request.method,
                        error_code: 0,
                        result:
                            request.method === "getLensMaskConfig"
                                ? { lens_mask: { lens_mask_info: { enabled: mask } } }
                                : {}
                    }
                ]
            }
        };
        return {
            status: 200,
            fingerprint: "AA:BB",
            json: {
                error_code: 0,
                result: { response: crypto.encryptRequest(session, JSON.stringify(answer)) }
            }
        };
    };
    return { send, sent };
}

const camera = { address: "192.168.1.20", username: "admin", password, pin: null };

describe("lensMask", () => {
    it("signs in, switches privacy on, reads it back and pins the certificate", async () => {
        const { send, sent } = secureCamera();
        expect(await lensMask(camera, true, send, cnonce)).toEqual({ private: true, pin: "AA:BB" });
        expect(sent.map((one) => one.body.method)).toEqual([
            "login",
            "login",
            "securePassthrough",
            "securePassthrough"
        ]);
        // One sequence number per request, counted from the camera's start_seq.
        expect(sent.slice(2).map((one) => one.seq)).toEqual(["7", "8"]);
    });

    it("reads without switching", async () => {
        const { send, sent } = secureCamera({ mask: "on" });
        expect((await lensMask(camera, null, send, cnonce)).private).toBe(true);
        expect(sent).toHaveLength(3);
    });

    it("refuses a wrong password before sending a digest", async () => {
        const { send, sent } = secureCamera();
        await expect(
            lensMask({ ...camera, password: "nope" }, true, send, cnonce)
        ).rejects.toMatchObject({ failure: "password" });
        expect(sent).toHaveLength(1);
    });

    it("says when it signed in as the camera account rather than the app's", async () => {
        const { send } = secureCamera({ userGroup: "guest" });
        await expect(lensMask(camera, true, send, cnonce)).rejects.toMatchObject({
            failure: "account"
        });
    });

    it("takes the newest firmware to its own sign-in instead of guessing a password", async () => {
        const bodies: string[] = [];
        const send: TapoTransport = async ({ body }) => {
            bodies.push(String(body));
            return { status: 200, fingerprint: null, json: { error_code: -40211 } };
        };
        await expect(lensMask(camera, true, send, cnonce)).rejects.toMatchObject({
            failure: "failed"
        });
        expect(JSON.parse(bodies[1]!)).toEqual({
            method: "login",
            params: { sub_method: "discover" }
        });
        expect(
            bodies.some((body) => body.includes("digest_passwd") || body.includes("hashed"))
        ).toBe(false);
    });

    it("passes a lockout on with its wait", async () => {
        const send: TapoTransport = async () => ({
            status: 200,
            fingerprint: null,
            json: { error_code: -40404, data: { code: -40404, sec_left: 1200 } }
        });
        const caught = await lensMask(camera, true, send, cnonce).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(TapoError);
        expect(caught).toMatchObject({ failure: "locked", waitSeconds: 1200 });
        expect(lockoutSeconds({ result: { data: { sec_left: 30 } } })).toBe(30);
    });

    it("falls back to the old hashed login on firmware without encrypt_type 3", async () => {
        const bodies: Sent["body"][] = [];
        const send: TapoTransport = async ({ url, body }) => {
            const json = JSON.parse(body) as Sent["body"];
            bodies.push(json);
            if (json.method === "login" && json.params.encrypt_type)
                return { status: 200, fingerprint: null, json: { error_code: -40210 } };
            if (json.method === "login")
                return {
                    status: 200,
                    fingerprint: null,
                    json: { error_code: 0, result: { stok: "OLD" } }
                };
            expect(url).toBe("https://192.168.1.20:443/stok=OLD/ds");
            return {
                status: 200,
                fingerprint: null,
                json: {
                    error_code: 0,
                    result: {
                        responses: [
                            {
                                error_code: 0,
                                result: { lens_mask: { lens_mask_info: { enabled: "off" } } }
                            }
                        ]
                    }
                }
            };
        };
        expect((await lensMask(camera, false, send, cnonce)).private).toBe(false);
        expect(bodies[1]!.params).toEqual({
            hashed: true,
            password: fixture.md5,
            username: "admin"
        });
    });
});
