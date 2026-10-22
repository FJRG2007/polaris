/**
 * The newest Tapo sign-in (TPAP: SPAKE2+ over P-256, then AES-128-CCM), with
 * no network.
 *
 * The fixture (`fixtures/tapo-tpap.json`) was produced by running pytapo's own
 * `transport/tpap/spake2p.py` with fixed randoms, and sealing the `/ds` bodies
 * with the Python `cryptography` package's AES-CCM - apart from the code under
 * test, so a wrong byte order, point encoding or key schedule is a mismatch
 * here instead of a camera that refuses every sign-in.
 */

import { describe, expect, it } from "vitest";
import fixture from "./fixtures/tapo-tpap.json";
import { createCipheriv, createDecipheriv } from "node:crypto";
import * as tpap from "@polaris-app/places/src/lib/integrations/tapo-tpap-crypto";
import { lensMask, type TapoTransport } from "@polaris-app/places/src/lib/integrations/tapo-camera";

const key = Buffer.from(fixture.key, "hex");
const baseNonce = Buffer.from(fixture.nonce, "hex");

function nonceFor(seq: number): Buffer {
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(seq);
    return Buffer.concat([baseNonce.subarray(0, 8), tail]);
}

/** The camera's side of the channel, from the Python-derived key only. */
function cameraOpen(raw: Buffer): { seq: number; text: string } {
    const seq = raw.readUInt32BE(0);
    const decipher = createDecipheriv("aes-128-ccm", key, nonceFor(seq), { authTagLength: 16 });
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([
        decipher.update(raw.subarray(4, raw.length - 16)),
        decipher.final()
    ]).toString();
    return { seq, text };
}

function cameraSeal(seq: number, text: string): Buffer {
    const cipher = createCipheriv("aes-128-ccm", key, nonceFor(seq), { authTagLength: 16 });
    const sealed = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq);
    return Buffer.concat([head, sealed, cipher.getAuthTag()]);
}

describe("the TPAP arithmetic", () => {
    it("hashes the user and the passcodes the app's way", () => {
        expect(tpap.md5Hex("admin")).toBe(fixture.usernameMd5);
        expect(tpap.sha256HexUpper("admin")).toBe(fixture.usernameSha256);
        expect(tpap.md5Hex(fixture.password)).toBe(fixture.passcodeMd5);
        expect(tpap.sha256HexUpper(fixture.password)).toBe(fixture.passcodeSha256);
    });

    it("shadows the passcode with SHA-256-crypt and SHA-1 as the camera asks", () => {
        for (const vector of fixture.cryptVectors)
            expect(tpap.sha256Crypt(vector.key, vector.prefix)).toBe(vector.hash);
        const shadow = (id: number, prefix?: string) => ({
            type: "password_shadow",
            params: { passwd_id: id, passwd_prefix: prefix }
        });
        expect(tpap.applyExtraCrypt(fixture.passcodeMd5, shadow(5, fixture.shadowPrefix))).toBe(
            fixture.credential
        );
        expect(tpap.applyExtraCrypt(fixture.passcodeMd5, shadow(2))).toBe(fixture.sha1Credential);
        expect(tpap.applyExtraCrypt(fixture.passcodeMd5, null)).toBe(fixture.passcodeMd5);
        expect(tpap.applyExtraCrypt(fixture.passcodeMd5, shadow(9))).toBeNull();
        expect(tpap.applyExtraCrypt(fixture.passcodeMd5, { type: "other" })).toBeNull();
    });

    it("derives the share, both confirmations and the session key", async () => {
        const client = await tpap.pakeClient(
            fixture.register,
            Buffer.from(fixture.userRandom, "base64"),
            fixture.credential,
            Buffer.from(fixture.scalar, "hex")
        );
        expect(client.userShare.toString("base64")).toBe(fixture.userShare);
        expect(client.userConfirm.toString("base64")).toBe(fixture.userConfirm);
        expect(client.deviceConfirms(Buffer.from(fixture.devConfirm, "base64"))).toBe(true);
        expect(client.deviceConfirms(Buffer.alloc(32))).toBe(false);
        expect(client.key.toString("hex")).toBe(fixture.key);
        expect(client.nonce.toString("hex")).toBe(fixture.nonce);
    });

    it("seals and opens /ds bodies exactly as AES-CCM does", () => {
        const channel = { key, nonce: baseNonce };
        expect(tpap.sealRequest(channel, fixture.seq, fixture.request).toString("hex")).toBe(
            fixture.requestSealed
        );
        expect(tpap.openReply(channel, Buffer.from(fixture.replySealed, "hex"))).toBe(
            fixture.reply
        );
        const tampered = Buffer.from(fixture.replySealed, "hex");
        tampered[10] = (tampered[10] ?? 0) ^ 1;
        expect(() => tpap.openReply(channel, tampered)).toThrow();
    });

    it("refuses more work than any camera asks of a sign-in", async () => {
        expect(() =>
            tpap.sha256Crypt("key", `$5$rounds=${tpap.MAX_CRYPT_ROUNDS + 1}$salt$`)
        ).toThrow();
        await expect(
            tpap.pakeClient(
                { ...fixture.register, iterations: tpap.MAX_PAKE_ITERATIONS + 1 },
                Buffer.from(fixture.userRandom, "base64"),
                fixture.credential,
                Buffer.from(fixture.scalar, "hex")
            )
        ).rejects.toThrow();
    });

    it("refuses a share that is not a point of the curve", () => {
        expect(() => tpap.decodePoint(Buffer.from([0x04, ...Array(64).fill(1)]))).toThrow();
    });
});

type Sent = { url: string; params?: Record<string, unknown>; ds?: string };

/** A camera on TPAP firmware, answering from the fixture's exchange. */
function tpapCamera(options: { refuseMd5?: boolean; lockout?: number } = {}) {
    const sent: Sent[] = [];
    let mask = "off";
    const send: TapoTransport = async ({ url, body }) => {
        if (Buffer.isBuffer(body)) {
            const { seq, text } = cameraOpen(body);
            sent.push({ url, ds: text });
            const request = JSON.parse(text) as {
                params: {
                    requests: {
                        method: string;
                        params: { lens_mask: { lens_mask_info?: { enabled: string } } };
                    }[];
                };
            };
            const inner = request.params.requests[0]!;
            if (inner.method === "setLensMaskConfig")
                mask = inner.params.lens_mask.lens_mask_info!.enabled;
            const result =
                inner.method === "getLensMaskConfig"
                    ? { lens_mask: { lens_mask_info: { enabled: mask } } }
                    : {};
            const reply = {
                error_code: 0,
                result: { responses: [{ method: inner.method, result, error_code: 0 }] }
            };
            return {
                status: 200,
                fingerprint: "AA:BB",
                json: null,
                raw: cameraSeal(seq, JSON.stringify(reply))
            };
        }
        const json = JSON.parse(body) as { params: Record<string, unknown> };
        sent.push({ url, params: json.params });
        const reply = (value: unknown) => ({ status: 200, fingerprint: "AA:BB", json: value });
        if (json.params.encrypt_type === "3") return reply({ error_code: -40211 });
        if (json.params.sub_method === "discover")
            return reply({ error_code: 0, result: { tpap: { pake: [2], user_hash_type: 0 } } });
        if (json.params.sub_method === "pake_register") {
            expect(json.params.username).toBe(fixture.usernameMd5);
            return reply({ error_code: 0, result: fixture.register });
        }
        if (json.params.sub_method === "pake_share") {
            if (options.lockout)
                return reply({ error_code: -40404, data: { sec_left: options.lockout } });
            const registers = sent.filter(
                (row) => row.params?.sub_method === "pake_register"
            ).length;
            if (options.refuseMd5 && registers === 1) return reply({ error_code: -40401 });
            if (
                json.params.user_share !== fixture.userShare ||
                json.params.user_confirm !== fixture.userConfirm
            )
                return reply({ error_code: -40401 });
            return reply({
                error_code: 0,
                result: {
                    dev_confirm: fixture.devConfirm,
                    stok: "tpapstok",
                    start_seq: fixture.seq,
                    expired: 3600
                }
            });
        }
        return reply({ error_code: -1 });
    };
    return { send, sent };
}

/** The same random bytes the fixture used, for every attempt. */
function fixedBytes(size: number): Buffer {
    return size === 32 && fixedBytes.next++ % 2 === 0
        ? Buffer.from(fixture.userRandom, "base64")
        : Buffer.from(fixture.scalar, "hex");
}
fixedBytes.next = 0;

const camera = {
    address: "192.168.1.21",
    username: "admin",
    password: fixture.password,
    pin: null
};

describe("lensMask on TPAP firmware", () => {
    it("signs in with SPAKE2+ and switches privacy over the sealed channel", async () => {
        fixedBytes.next = 0;
        const { send, sent } = tpapCamera();
        const answer = await lensMask(camera, true, send, undefined, fixedBytes);
        expect(answer).toEqual({ private: true, pin: "AA:BB" });
        const ds = sent.filter((row) => row.ds !== undefined);
        expect(ds.map((row) => row.url)).toEqual([
            "https://192.168.1.21:443/stok=tpapstok/ds",
            "https://192.168.1.21:443/stok=tpapstok/ds"
        ]);
        expect(ds[0]!.ds).toContain('"setLensMaskConfig"');
        expect(ds[1]!.ds).toBe(fixture.request);
    });

    it("tries the SHA-256 passcode only after the MD5 one is refused", async () => {
        fixedBytes.next = 0;
        const { send, sent } = tpapCamera({ refuseMd5: true });
        await expect(lensMask(camera, null, send, undefined, fixedBytes)).rejects.toMatchObject({
            failure: "password"
        });
        expect(sent.filter((row) => row.params?.sub_method === "pake_share")).toHaveLength(2);
    });

    it("never spends an attempt on the camera account", async () => {
        const { send, sent } = tpapCamera();
        await expect(
            lensMask({ ...camera, username: "rtspuser" }, true, send, undefined, fixedBytes)
        ).rejects.toMatchObject({ failure: "account" });
        expect(sent.some((row) => row.params?.sub_method === "pake_share")).toBe(false);
    });

    it("passes a lockout on with its wait", async () => {
        fixedBytes.next = 0;
        const { send } = tpapCamera({ lockout: 1200 });
        await expect(lensMask(camera, true, send, undefined, fixedBytes)).rejects.toMatchObject({
            failure: "locked",
            waitSeconds: 1200
        });
    });
});
