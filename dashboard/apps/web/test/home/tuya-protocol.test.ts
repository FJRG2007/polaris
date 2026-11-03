/**
 * Tuya's local protocol, checked byte for byte against frames tinytuya 1.17.4
 * produced (its `pack_message`, `AESCipher` and `udp_helper`) for the same key,
 * nonces, IV and JSON - so a frame this module writes is one a device reading
 * tinytuya's protocol accepts, and one it reads is one tinytuya would.
 *
 * Fixture values: local key "0123456789abcdef", our nonce "abcdefghijklmnop",
 * the device's "ponmlkjihgfedcba", GCM IV 01..0c.
 */

import { describe, expect, it } from "vitest";
import {
    controlMessage,
    decodePayload,
    dpsOf,
    encodeMessage,
    negotiationFinish,
    negotiationStart,
    newSession,
    parseAnnouncement,
    parseFrame,
    parseOptionsFor,
    queryMessage,
    sessionKeyOf,
    TUYA_UDP_KEY,
    type TuyaVersion
} from "@polaris-app/places/src/lib/integrations/tuya-protocol";

const VECTORS = {
    v33_control:
        "000055aa000000010000000700000077332e33000000000000000000000000cf86245f80a43fd581e9f874f8" +
        "bade17f5a6c29e7d2e67261b300789f2779133ddabaa66ded5463195ff5d708d161f7ae15135b063629f655b" +
        "8e969d70a003c614289c9042f2aa08005786aab66fcc6d5c91b94d45d4e66e522e93cf8c4ab1fea8448d8100" +
        "00aa55",
    v33_status_reply:
        "000055aa000000020000000a0000003c00000000f24799fe0fff17cc9f964a40989b0d28e56c7f89eb776481" +
        "dbd75e39d22ba3d04ba85a2ae02daeef7ea199d8ab0ad8d6989346490000aa55",
    v33_push:
        "000055aa00000000000000080000004b00000000332e33000000000000000000000000f24799fe0fff17cc9f" +
        "964a40989b0d28e56c7f89eb776481dbd75e39d22ba3d04ba85a2ae02daeef7ea199d8ab0ad8d6bdc178db00" +
        "00aa55",
    session34:
        "9ffa085e8b5849b3ab12b3096d8b0e9a",
    session35:
        "f4df71bc5aa854a4583db933ff33d218",
    v34_neg_start:
        "000055aa00000001000000030000004485627df0451e7740eb260b1df1f4fc64377222e061a924c591cd9c27" +
        "ea163ed49ed8549dde300f86b824d4da84d5c282792626ecbc22ac3729d819beab9997540000aa55",
    v34_neg_resp:
        "000055aa00000001000000040000006800000000a118ba3a27c06fe8e7460a59605b782b69ed70381a5fdc1f" +
        "0208a319d1a63489d242a0b9a9af284bd9e93b2a15e0ec26377222e061a924c591cd9c27ea163ed461c7b372" +
        "f5a0296dd5a0e84983e826ad2897c66fecf7181bdafdb851f0f5173f0000aa55",
    v34_neg_finish:
        "000055aa000000020000000500000054058823e182038cbc26dea9a9e5a06696512c41ad81ec397b2c14673d" +
        "90d40e65377222e061a924c591cd9c27ea163ed412fa1481be220f3138c848f2ccdcf26f00b1d8af7aabc666" +
        "17c8aa6820a3e2d80000aa55",
    v34_control:
        "000055aa000000030000000d000000746b98f640309aa91e299fc6984ee9c4ecebddf8079d400ae94f617a3e" +
        "9c8258acd1cb21a3d0d6883e9b12cb7c83f2930f97fea41d6b797a4351d0016032a8149e932e2401a98eafc7" +
        "bd673ccab3d86a31897aa715959b87a75cdef5a80aaad7a63d1c573d059abdfb5c0f70d8a1fca9300000aa55",
    v34_status_reply:
        "000055aa00000004000000100000005800000000a94ebf47015bcbb41185672dd66b25c6f344539288a6f579" +
        "dc9c62abd5c14977691bd2698855e818068111b80b19f29d8c33d5a424b5eb3d7cabd0d85bbe79b1a938113b" +
        "fd8c4df7b2e4f1a9acd3fc220000aa55",
    v35_neg_resp:
        "0000669900000000000100000004000000500102030405060708090a0b0cc09026cf5066b883fda2dd1491fd" +
        "9860d2a110c73e67feb5b70ab8ebcd5ba541471d01b9723ee4a7d75a60d2aa2f35353efefe4b8afd934ae194" +
        "c0911fdff845a190da1b00009966",
    v35_control:
        "000066990000000000030000000d000000630102030405060708090a0b0ccd78f5424afc4997a9414e8e8f15" +
        "79b5ef16767d14ea08b8b7d5c1f46552c3f4d5914d414c4cedbf1293a0dfa7b1c09fed9e84510abd5ac25436" +
        "02b403949eb88f39baec8c7c2e22e43553228ecdffa54de33c52b5e08800009966",
    v35_status_reply:
        "00006699000000000004000000100000004b0102030405060708090a0b0cfe56c04231de2de7da6374f5ad24" +
        "5bf4ab07686105a949e5f9cd8fb33c15cafacdd4584b4d4bedbf1293a0c3b5e4dcbd42d39e035551838dd8ef" +
        "98b292bcb000009966",
    udp33:
        "000055aa00000000000000130000009c00000000d09766676f3369eb10b5e9f132fd802ae63f1a5361c43f62" +
        "d8161e034c9a221e482611d8caa5248ac6cea65bdad007dfa41f010dca2abb30c50459a9f88024ffcb5924bb" +
        "8792fe5eae7c9040e5921a98017f2170860421e6fc66f0a1ade138915fde850cd157270c5f3d1ab5ae90b300" +
        "5ade4fdaaa79bad2b48194c150e26daebcc651832dd9b60158654b01a12a9a5202cdf5860000aa55",
    udp35:
        "0000669900000000000000000013000000a80102030405060708090a0b0c0202ece734a3541f7ea708285f22" +
        "1e17ff30e5c8fde536059980b427064cebcf7882981c433ca6ed941e6350502a342e34e3fb69a76851aaab18" +
        "27040c9a898fd7dfc2b15b622067d6cee5b76d574b0b4e71af1b46cda8e93021fc01beb4803cdcd318faf048" +
        "4aed0a5fd057148bb17b140291c081ec17d0524f74732e4c4e557186e1707bae863e458faaa328baa077fe19" +
        "8368630a3119cd0b8ac100009966",
    udpkey:
        "6c1ec8e2bb9bb59ab50b0daf649b410a"
} as const;

const KEY = Buffer.from("0123456789abcdef");
const LOCAL_NONCE = Buffer.from("abcdefghijklmnop");
const REMOTE_NONCE = Buffer.from("ponmlkjihgfedcba");
const IV = Buffer.from("0102030405060708090a0b0c", "hex");
const DEVICE = "bf0123456789abcdefgh";
const T = 1_700_000_000_000;
const hex = (name: keyof typeof VECTORS) => Buffer.from(VECTORS[name], "hex");

function agreed(version: TuyaVersion) {
    const session = newSession(version, KEY);
    session.key = Buffer.from(VECTORS[version === "3.4" ? "session34" : "session35"], "hex");
    return session;
}

describe("Tuya local protocol", () => {
    it("knows the announcement key every device uses", () => {
        expect(TUYA_UDP_KEY.toString("hex")).toBe(VECTORS.udpkey);
    });

    it("writes a 3.3 control frame exactly as tinytuya does", () => {
        const session = newSession("3.3", KEY);
        const { cmd, payload } = controlMessage(session, DEVICE, { "1": true }, T);
        expect(encodeMessage(session, cmd, payload).toString("hex")).toBe(VECTORS.v33_control);
    });

    it("reads a 3.3 status answer and a 3.3 push with its version header", () => {
        const session = newSession("3.3", KEY);
        for (const name of ["v33_status_reply", "v33_push"] as const) {
            const parsed = parseFrame(hex(name), parseOptionsFor(session));
            expect(parsed?.frame.retcode).toBe(0);
            expect(dpsOf(decodePayload(session, parsed!.frame))).toEqual({ "1": false, "2": true });
        }
    });

    it("refuses a frame whose CRC does not check", () => {
        const broken = hex("v33_status_reply");
        broken[20] = broken[20]! ^ 0xff;
        expect(() => parseFrame(broken)).toThrow();
    });

    it("waits for the rest of a frame that arrived in pieces", () => {
        const whole = hex("v33_status_reply");
        expect(parseFrame(whole.subarray(0, 30))).toBeNull();
        expect(parseFrame(Buffer.concat([whole, whole.subarray(0, 5)]))?.rest.length).toBe(5);
    });

    it("derives the 3.4 and 3.5 session keys tinytuya derives", () => {
        expect(sessionKeyOf("3.4", KEY, LOCAL_NONCE, REMOTE_NONCE).toString("hex")).toBe(
            VECTORS.session34
        );
        expect(sessionKeyOf("3.5", KEY, LOCAL_NONCE, REMOTE_NONCE).toString("hex")).toBe(
            VECTORS.session35
        );
    });

    it("runs the 3.4 key agreement frame for frame", () => {
        const session = newSession("3.4", KEY);
        expect(negotiationStart(session, LOCAL_NONCE).toString("hex")).toBe(VECTORS.v34_neg_start);
        const answer = parseFrame(hex("v34_neg_resp"), { key: KEY })!.frame;
        expect(negotiationFinish(session, LOCAL_NONCE, answer).toString("hex")).toBe(
            VECTORS.v34_neg_finish
        );
        expect(session.key.toString("hex")).toBe(VECTORS.session34);
    });

    it("refuses a 3.4 agreement from a device without this key", () => {
        const session = newSession("3.4", Buffer.from("fedcba9876543210"));
        negotiationStart(session, LOCAL_NONCE);
        const answer = parseFrame(hex("v34_neg_resp"), { key: KEY })!.frame;
        expect(() => negotiationFinish(session, LOCAL_NONCE, answer)).toThrow();
    });

    it("writes and reads 3.4 frames under the session key", () => {
        const session = agreed("3.4");
        session.seqno = 3;
        const { cmd, payload } = controlMessage(session, DEVICE, { "2": false }, T);
        expect(encodeMessage(session, cmd, payload).toString("hex")).toBe(VECTORS.v34_control);
        const reply = parseFrame(hex("v34_status_reply"), parseOptionsFor(session))!.frame;
        expect(dpsOf(decodePayload(session, reply))).toEqual({ "1": false, "2": true });
    });

    it("runs the 3.5 agreement and seals frames with GCM as tinytuya does", () => {
        const session = newSession("3.5", KEY);
        negotiationStart(session, LOCAL_NONCE, IV);
        const answer = parseFrame(hex("v35_neg_resp"), { key: KEY })!.frame;
        negotiationFinish(session, LOCAL_NONCE, answer, IV);
        expect(session.key.toString("hex")).toBe(VECTORS.session35);
        session.seqno = 3;
        const { cmd, payload } = controlMessage(session, DEVICE, { "2": false }, T);
        expect(encodeMessage(session, cmd, payload, IV).toString("hex")).toBe(VECTORS.v35_control);
        const reply = parseFrame(hex("v35_status_reply"), parseOptionsFor(session))!.frame;
        expect(reply.retcode).toBe(0);
        expect(dpsOf(decodePayload(session, reply))).toEqual({ "1": false, "2": true });
    });

    it("refuses a 3.5 frame that was tampered with", () => {
        const broken = hex("v35_status_reply");
        broken[40] = broken[40]! ^ 1;
        expect(() => parseFrame(broken, parseOptionsFor(agreed("3.5")))).toThrow();
    });

    it("asks 3.3 for its points with the ids, and 3.4 with an empty object", () => {
        expect(queryMessage(newSession("3.3", KEY), DEVICE, T).cmd).toBe(10);
        const newer = queryMessage(newSession("3.4", KEY), DEVICE, T);
        expect([newer.cmd, newer.payload.toString()]).toEqual([16, "{}"]);
    });

    it("reads 3.3 and 3.5 announcements, and ignores noise", () => {
        expect(parseAnnouncement(hex("udp33"))).toEqual({
            id: DEVICE,
            address: "192.168.1.40",
            version: "3.3",
            productKey: "keyabc"
        });
        expect(parseAnnouncement(hex("udp35"))?.version).toBe("3.5");
        expect(parseAnnouncement(Buffer.from("hello"))).toBeNull();
    });
});
