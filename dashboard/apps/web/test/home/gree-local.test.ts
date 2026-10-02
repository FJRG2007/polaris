/**
 * Gree air conditioners over the LAN, as Home Assistant's `gree` integration
 * reaches them.
 *
 * The ciphers are pinned to values produced by greeclimate's own `CipherV1` and
 * `CipherV2` (greeclimate 2.1.x, `greeclimate/cipher.py`, run under Python with
 * pycryptodome): the generic keys, the bind and dev packets of its test fixtures
 * (`tests/common.py`), and its `ThisIsASecretKey` test key. The message shapes
 * are the ones `tests/test_network.py` asserts, and the temperature cases are
 * those of `tests/test_device.py`.
 *
 * No network. The UDP transport is replaced by a unit made of those shapes:
 * it opens what it is sent and answers the way a unit does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    GREE_GENERIC_KEYS,
    openGree,
    sealGree,
    sealGreeText,
    type GreeCipher
} from "@polaris-app/places/src/lib/integrations/gree-crypto";

/** What greeclimate produced. `plain` is `json.dumps` of the data, exactly. */
const VECTORS: {
    name: string;
    cipher: GreeCipher;
    key: string;
    plain: string;
    pack: string;
    tag?: string;
}[] = [
    {
        name: "a bind, under the V1 generic key",
        cipher: "v1",
        key: "a3K8Bx%2r8Y7#xDh",
        plain: '{"t": "bind", "mac": "aabbcc112233", "uid": 0}',
        pack: "UH1xnvFY7toQqZpWdQqnjyvfs79YlW4p+2Qfq91WFMHJp4P8qh+t80a3xUDri4Rh"
    },
    {
        name: "the library's own V1 test key",
        cipher: "v1",
        key: "ThisIsASecretKey",
        plain: '{"message": "Hello, World!"}',
        pack: "RMV60sLW3IHgCPyml3Y1QVLlA9Od9ffjBzzsJEJz1+k="
    },
    {
        name: "a bindok, under the V1 generic key",
        cipher: "v1",
        key: "a3K8Bx%2r8Y7#xDh",
        plain: '{"t": "bindok", "mac": "aabbcc112233", "key": "FixtureKey000001", "r": 200}',
        pack: "XtrVnaw7YUWzw9ndR5UxWnbHur51awmdNbEMMZ2EA4rxEwmdTFOAlke434fDu80K6GjupXAM6WisFDYjrP7Mo2Czi9NZFytJT+vnDquG7GU="
    },
    {
        name: "the fixture unit's scan answer",
        cipher: "v1",
        key: "a3K8Bx%2r8Y7#xDh",
        plain: '{"t": "dev", "cid": "aabbcc112233", "bc": "gree", "brand": "gree", "catalog": "gree", "mac": "aabbcc112233", "mid": "10001", "model": "gree", "name": "fake unit", "series": "gree", "vender": "1", "ver": "V1.1.13", "lock": 0}',
        pack: "gSoGwqIM2nQgxTqjg6mOsH+qtjDLzbqP1u1kerpG1R4E2sNO+CeyFG/y0OPMNO9v047j2v4fDKtZTQ2mEIDD/t8ZgkQZwjnLmDZbSA1+3uuXuuszKvoXKISGcpJqNmvmcxPlIzq8+q6JoXcsUKZXMbPdrG7obL8weXnGvRhFh7ds8+PNZS2+h12w+RUnd+2ZepyXTKH87IzBfJNyk454j4evm0gA+uyRsKJ1HedbapPhCfIJWegRBNLFpLbEI9s4EVD8hnACUNi6i44IwYA1MF3CjmggN3yXqosp8qpgxz1DsKxqUny00WOzqiYzxnfY"
    },
    {
        name: "a status answer, under a unit's own key",
        cipher: "v1",
        key: "FixtureKey000001",
        plain: '{"t": "dat", "mac": "aabbcc112233", "r": 200, "cols": ["Pow", "Mod", "SetTem", "TemSen"], "dat": [1, 1, 24, 66]}',
        pack: "gBYIl6bXvDtPrr1G/hpBS1WoZ11lxUodJsLipWmPhwHYtMGnulbdWkCtCgNFzSEFyOex1DvlLRjXDsgiLSC7HFBxzW+NFtwk5B9yNOFoFY7zbV8MO3SLQqT6HooDethzcTNCfdl1+PzsEWmERz9GXBzHwzagThiHYAsE3FZpn1M="
    },
    {
        name: "a bind, under the V2 (GCM) generic key",
        cipher: "v2",
        key: "{yxAHAY_Lm6pbC/<",
        plain: '{"t": "bind", "mac": "aabbcc112233", "uid": 0}',
        pack: "JtoKliwv65K66JiVdmlXWs4iqtkCwEanYgY3XuvalPrCJS9DzUMrI4y37ayUFw==",
        tag: "OIjyr2eD+cOcjF/swt6SYQ=="
    },
    {
        name: "the library's own V2 test key",
        cipher: "v2",
        key: "ThisIsASecretKey",
        plain: '{"message": "Hello, World!"}',
        pack: "ZBxn3pN5bmXypljM0ROYb7ozGvqhRalbrDesxQ==",
        tag: "d2cynMG26Hpm95tJ1Yy28A=="
    }
];

describe("Gree's ciphers", () => {
    it("has the library's generic keys", () => {
        expect(GREE_GENERIC_KEYS).toEqual({ v1: "a3K8Bx%2r8Y7#xDh", v2: "{yxAHAY_Lm6pbC/<" });
    });

    for (const vector of VECTORS) {
        it(`seals ${vector.name} byte for byte`, () => {
            const sealed = sealGreeText(vector.plain, vector.key, vector.cipher);
            expect(sealed.pack).toBe(vector.pack);
            expect(sealed.tag).toBe(vector.tag);
        });

        it(`opens ${vector.name}`, () => {
            expect(openGree(vector.pack, vector.key, vector.cipher)).toEqual(
                JSON.parse(vector.plain)
            );
        });
    }

    it("round-trips anything, in both generations", () => {
        const value = { t: "cmd", opt: ["Pow", "SetTem"], p: [1, 24], mac: "aabbcc112233" };
        for (const cipher of ["v1", "v2"] as const) {
            const sealed = sealGree(value, "FixtureKey000001", cipher);
            expect(openGree(sealed.pack, "FixtureKey000001", cipher)).toEqual(value);
        }
    });

    it("opens nothing under the wrong key", () => {
        const [first] = VECTORS;
        expect(openGree(first!.pack, "ThisIsASecretKey", "v1")).toBeNull();
        expect(openGree("not base64 at all", "ThisIsASecretKey", "v1")).toBeNull();
    });
});

// --- a unit on a fake network ------------------------------------------------

interface FakeUnit {
    address: string;
    mac: string;
    name: string;
    key: string;
    cipher: GreeCipher;
    status: Record<string, number | string>;
    answers: boolean;
}

let units: FakeUnit[] = [];
const sent: { targets: readonly string[]; message: Record<string, unknown> }[] = [];

function reply(unit: FakeUnit, inner: unknown, key: string) {
    const sealed = sealGree(inner, key, unit.cipher);
    return {
        address: unit.address,
        data: Buffer.from(
            JSON.stringify({
                t: "pack",
                i: inner && (inner as { t: string }).t === "bindok" ? 1 : 0,
                uid: 0,
                cid: unit.mac,
                tcid: "",
                pack: sealed.pack,
                ...(sealed.tag ? { tag: sealed.tag } : {})
            })
        )
    };
}

/** What one unit says to one datagram, or nothing. */
function answer(unit: FakeUnit, message: Record<string, unknown>) {
    if (!unit.answers) return null;
    if (message.t === "scan") {
        // A scan is always answered in V1 by the generic key (`discovery.py`).
        const sealed = sealGree(
            {
                t: "dev",
                cid: unit.mac,
                mac: unit.mac,
                name: unit.name,
                brand: "gree",
                model: "gree",
                ver: "V1.1.13"
            },
            GREE_GENERIC_KEYS.v1,
            "v1"
        );
        return {
            address: unit.address,
            data: Buffer.from(
                JSON.stringify({ t: "pack", i: 1, uid: 0, cid: unit.mac, pack: sealed.pack })
            )
        };
    }
    if (typeof message.pack !== "string") return null;
    if (message.i === 1) {
        const inner = openGree(message.pack, GREE_GENERIC_KEYS[unit.cipher], unit.cipher) as {
            t?: string;
        } | null;
        if (inner?.t !== "bind") return null;
        return reply(
            unit,
            { t: "bindok", mac: unit.mac, key: unit.key, r: 200 },
            GREE_GENERIC_KEYS[unit.cipher]
        );
    }
    const inner = openGree(message.pack, unit.key, unit.cipher) as {
        t?: string;
        cols?: string[];
        opt?: string[];
        p?: number[];
    } | null;
    if (inner?.t === "status") {
        const cols = inner.cols ?? [];
        return reply(
            unit,
            {
                t: "dat",
                mac: unit.mac,
                r: 200,
                cols,
                dat: cols.map((col) => unit.status[col] ?? 0)
            },
            unit.key
        );
    }
    if (inner?.t === "cmd") {
        (inner.opt ?? []).forEach((col, index) => {
            unit.status[col] = inner.p?.[index] ?? 0;
        });
        return reply(
            unit,
            { t: "res", mac: unit.mac, r: 200, opt: inner.opt, val: inner.p },
            unit.key
        );
    }
    return null;
}

vi.mock("@polaris-app/places/src/lib/integrations/gree-udp", async (original) => {
    const actual =
        await original<typeof import("@polaris-app/places/src/lib/integrations/gree-udp")>();
    return {
        ...actual,
        greeExchange: async (exchange: {
            targets: readonly string[];
            payload: Buffer;
            until?: (reply: { address: string; data: Buffer }) => boolean;
        }) => {
            const message = JSON.parse(exchange.payload.toString("utf8")) as Record<
                string,
                unknown
            >;
            sent.push({ targets: exchange.targets, message });
            const broadcast = exchange.targets.includes(actual.GREE_BROADCAST);
            const replies = [];
            for (const unit of units) {
                if (!broadcast && !exchange.targets.includes(unit.address)) continue;
                const said = answer(unit, message);
                if (!said) continue;
                replies.push(said);
                if (exchange.until?.(said)) break;
            }
            return replies;
        }
    };
});

const gree = await import("@polaris-app/places/src/lib/drivers/gree-local");
const api = await import("@polaris-app/places/src/lib/integrations/gree-api");

function fakeUnit(overrides: Partial<FakeUnit> = {}): FakeUnit {
    return {
        address: "10.0.1.40",
        mac: "aabbcc112233",
        name: "Bedroom",
        key: "FixtureKey000001",
        cipher: "v1",
        status: {
            Pow: 1,
            Mod: 1,
            SetTem: 24,
            TemSen: 66,
            TemUn: 0,
            TemRec: 0,
            WdSpd: 0,
            SwUpDn: 0,
            Tur: 0,
            Quiet: 0,
            SvSt: 0,
            hid: "362001000762+U-CS532AE(LT)V3.31.bin"
        },
        answers: true,
        ...overrides
    };
}

beforeEach(() => {
    units = [];
    sent.length = 0;
});

describe("the messages", () => {
    it("wraps a bind as `create_bind_message` does", () => {
        const message = api.greeMessage(
            "aabbcc112233",
            { t: "bind", mac: "aabbcc112233", uid: 0 },
            GREE_GENERIC_KEYS.v1,
            "v1",
            true
        );
        expect(message).toEqual({
            cid: "app",
            i: 1,
            t: "pack",
            uid: 0,
            tcid: "aabbcc112233",
            pack: expect.any(String)
        });
        expect(openGree(message.pack as string, GREE_GENERIC_KEYS.v1, "v1")).toEqual({
            t: "bind",
            mac: "aabbcc112233",
            uid: 0
        });
    });

    it("carries the GCM tag beside a V2 pack, and i 0 under a unit's key", () => {
        const message = api.greeMessage(
            "aabbcc112233",
            { t: "status" },
            "FixtureKey000001",
            "v2",
            false
        );
        expect(message.i).toBe(0);
        expect(typeof message.tag).toBe("string");
    });

    it("reads a scan answer, MAC from cid where there is no mac", () => {
        const sealed = sealGree(
            { t: "dev", cid: "AABBCC112233", name: "fake unit", ver: "V1.1.13" },
            GREE_GENERIC_KEYS.v1,
            "v1"
        );
        const found = api.readScanReply({
            address: "10.0.1.40",
            data: Buffer.from(JSON.stringify({ t: "pack", i: 1, pack: sealed.pack }))
        });
        expect(found).toMatchObject({
            address: "10.0.1.40",
            mac: "aabbcc112233",
            name: "fake unit"
        });
    });
});

describe("connecting", () => {
    it("asks the typed address, binds, and keeps the key and not the address alone", async () => {
        units = [fakeUnit()];
        const stored = await gree.greeLocalDriver.verify({ host: "10.0.1.40" });
        expect(sent[0]).toEqual({ targets: ["10.0.1.40"], message: { t: "scan" } });
        expect(stored).toBeTruthy();
        const saved = JSON.parse((stored as Record<string, string>).units!);
        expect(saved).toEqual([
            {
                mac: "aabbcc112233",
                address: "10.0.1.40",
                key: "FixtureKey000001",
                cipher: "v1",
                name: "Bedroom",
                model: "gree"
            }
        ]);
    });

    it("binds in V2 when the unit does not answer V1", async () => {
        units = [fakeUnit({ cipher: "v2" })];
        const stored = await gree.greeLocalDriver.verify({ host: "10.0.1.40" });
        const saved = JSON.parse((stored as Record<string, string>).units!);
        expect(saved[0].cipher).toBe("v2");
        // Asked in V1 first, as the library does.
        const binds = sent.filter((entry) => entry.message.i === 1);
        expect(binds).toHaveLength(2);
        expect(binds[1]!.message.tag).toEqual(expect.any(String));
    });

    it("looks on the network when no address is typed, broadcast included", async () => {
        units = [
            fakeUnit(),
            fakeUnit({ address: "10.0.1.41", mac: "aabbcc445566", name: "Lounge" })
        ];
        const stored = await gree.greeLocalDriver.verify({});
        expect(sent[0]!.targets).toContain("255.255.255.255");
        expect(JSON.parse((stored as Record<string, string>).units!)).toHaveLength(2);
    });

    it("says so when nothing answers", async () => {
        await expect(gree.greeLocalDriver.verify({ host: "10.0.1.40" })).rejects.toThrow(
            "No Gree air conditioner answered at that address."
        );
    });

    it("refuses an address no unit is ever at", async () => {
        await expect(gree.greeLocalDriver.verify({ host: "127.0.0.1" })).rejects.toThrow(
            "Polaris does not connect to that address"
        );
    });
});

async function connected(unit = fakeUnit()) {
    units = [unit];
    const stored = (await gree.greeLocalDriver.verify({ host: unit.address })) as Record<
        string,
        string
    >;
    sent.length = 0;
    return stored;
}

describe("reading a unit", () => {
    it("is an air conditioner, cooling at 24 in a room at 26", async () => {
        const credentials = await connected();
        const [row] = await gree.greeLocalDriver.list(credentials);
        expect(row).toMatchObject({
            externalId: "aabbcc112233",
            kind: "climate",
            name: "Bedroom",
            state: "on",
            online: true,
            firmware: "3.31",
            value: "26",
            unit: "°C"
        });
        expect(row!.climate).toMatchObject({
            mode: "cool",
            target: 24,
            min: 8,
            max: 30,
            step: 1,
            unit: "C",
            fan: "auto",
            options: { swing: false, turbo: false, quiet: false, eco: false }
        });
    });

    it("draws a unit that does not answer as not answering, not as gone", async () => {
        const unit = fakeUnit();
        const credentials = await connected(unit);
        unit.answers = false;
        const [row] = await gree.greeLocalDriver.list(credentials);
        expect(row).toMatchObject({ externalId: "aabbcc112233", online: false, state: "unknown" });
    });
});

describe("telling a unit what to do", () => {
    it("switches it, with the column the library uses", async () => {
        const unit = fakeUnit({ status: { ...fakeUnit().status, Pow: 0 } });
        const credentials = await connected(unit);
        await gree.greeLocalDriver.act(
            credentials,
            { externalId: unit.mac, kind: "climate" },
            "turn-on"
        );
        expect(unit.status.Pow).toBe(1);
    });

    it("sets a mode, a fan and the extras by their numbers", async () => {
        const unit = fakeUnit();
        const credentials = await connected(unit);
        const device = { externalId: unit.mac, kind: "climate" };
        await gree.greeLocalDriver.act(credentials, device, "set-mode", {
            action: "set-mode",
            mode: "heat"
        });
        await gree.greeLocalDriver.act(credentials, device, "set-fan", {
            action: "set-fan",
            fan: "high"
        });
        await gree.greeLocalDriver.act(credentials, device, "set-option", {
            action: "set-option",
            option: "quiet",
            on: true
        });
        await gree.greeLocalDriver.act(credentials, device, "set-option", {
            action: "set-option",
            option: "swing",
            on: true
        });
        expect(unit.status).toMatchObject({ Mod: 4, WdSpd: 5, Quiet: 2, SwUpDn: 1 });
    });

    it("sends a Celsius target with its unit and record bit", async () => {
        const unit = fakeUnit();
        const credentials = await connected(unit);
        await gree.greeLocalDriver.act(
            credentials,
            { externalId: unit.mac, kind: "climate" },
            "set-temperature",
            {
                action: "set-temperature",
                target: 21
            }
        );
        const command = sent.find((entry) => {
            const opened = openGree(entry.message.pack as string, unit.key, "v1") as { t?: string };
            return opened?.t === "cmd";
        });
        expect(openGree(command!.message.pack as string, unit.key, "v1")).toMatchObject({
            t: "cmd",
            mac: unit.mac,
            opt: ["SetTem", "TemUn", "TemRec"],
            p: [21, 0, 0]
        });
    });

    it("refuses a target outside the library's range before sending it", () => {
        expect(() =>
            gree.greeValues("set-temperature", { action: "set-temperature", target: 31 }, "C")
        ).toThrow("That temperature is not one this device accepts");
    });
});

describe("temperatures, as greeclimate's own tests have them", () => {
    it.each([
        [69, "362001000762+U-CS532AE(LT)V3.31.bin", 29],
        [61, "362001061060+U-W04HV3.29.bin", 21],
        [62, "362001061147+U-ZX6045RV1.01.bin", 22],
        [69, "362001060297+U-CS532AF(MTK).bin", 29]
    ])("takes 40 off TemSen %i on earlier firmware (%s)", (temsen, hid, expected) => {
        expect(gree.greeCurrent({ TemSen: temsen, hid }, "C")).toBe(expected);
    });

    it.each([
        [21, "362001060297+U-CS532AF(MTK)V4.bin"],
        [21, "362001060297+U-CS532AF(MTK)V2.bin"],
        [22, "362001061383+U-BL3332_JDV1.bin"],
        [23, "362001061217+U-W04NV7.bin"],
        [0, "362001000762+U-CS532AE(LT)V4.bin"]
    ])("reads TemSen %i as it is on firmware 4 (%s)", (temsen, hid) => {
        expect(gree.greeCurrent({ TemSen: temsen, hid }, "C")).toBe(temsen);
    });

    it("has no reading at 0 on earlier firmware, rather than borrowing the target", () => {
        expect(
            gree.greeCurrent({ TemSen: 0, hid: "362001000762+U-CS532AE(LT)V3.31.bin" }, "C")
        ).toBeNull();
    });

    it.each([60, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 86])(
        "sets and reads %i F through the record bit",
        (f) => {
            const values = gree.greeValues(
                "set-temperature",
                { action: "set-temperature", target: f },
                "F"
            );
            const { temSet, temRec } = gree.fahrenheitRecord(f);
            expect(values).toEqual({ SetTem: temSet, TemUn: 1, TemRec: temRec });
            expect(gree.greeCurrent({ TemSen: temSet + 40, TemRec: temRec }, "F")).toBe(f);
            expect(gree.greeSettings({ SetTem: temSet, TemRec: temRec, TemUn: 1 }).target).toBe(f);
        }
    );
});

describe("finding units on the network", () => {
    it("lists each unit with its name, its MAC in the usual spelling, and where it is", async () => {
        units = [
            fakeUnit(),
            fakeUnit({ address: "10.0.1.41", mac: "aabbcc445566", name: "Lounge" })
        ];
        const found = await gree.greeLocalDriver.discover!();
        expect(sent[0]).toMatchObject({ message: { t: "scan" } });
        expect(sent[0]!.targets).toContain("255.255.255.255");
        expect(found).toEqual([
            { name: "Bedroom", model: "", mac: "AA:BB:CC:11:22:33", address: "10.0.1.40" },
            { name: "Lounge", model: "", mac: "AA:BB:CC:44:55:66", address: "10.0.1.41" }
        ]);
        // A look, not a pairing: nothing was bound.
        expect(sent.some((entry) => entry.message.i === 1)).toBe(false);
    });

    it("names a unit that gave no name by the end of its MAC, as the library does", async () => {
        units = [fakeUnit({ name: "" })];
        const [unit] = await gree.greeLocalDriver.discover!();
        expect(unit!.name).toBe("Gree 2233");
    });

    it("finds a unit by its MAC, however the MAC is spelled", async () => {
        units = [fakeUnit({ address: "10.0.1.77" })];
        await expect(gree.greeLocalDriver.locate!("AA:BB:CC:11:22:33")).resolves.toBe(
            "10.0.1.77"
        );
        await expect(gree.greeLocalDriver.locate!("aabbcc999999")).resolves.toBeNull();
    });
});
