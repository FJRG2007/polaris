/**
 * Philips air purifiers over the LAN, as Home Assistant's Philips integration
 * reaches them.
 *
 * The cipher is pinned to values produced by philips-airctrl 1.2.0's own
 * `EncryptionContext` (`coap/encryption.py`, the library the integration pins,
 * run under Python with pycryptodomex): two control messages sealed in turn from
 * counter 0000000A, the counter wrapping at FFFFFFFF, and a status sealed under
 * 12AB34CD. `desired` and `statusPlain` are `json.dumps` of the data, exactly.
 * The CoAP bytes are aiocoap 0.4.17's own `Message.encode()` for the messages
 * the libraries send (`Client._sync`, `get_status`, `set_control_values`,
 * `get_device_info`) and for answers shaped like a unit's.
 *
 * No network. The UDP transport is replaced by a unit that opens what it is
 * sent with the same cipher and answers the way a unit does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoapMessage } from "@polaris-app/places/src/lib/integrations/coap";
import type { AirCommand } from "@polaris-app/places/src/lib/device-kinds";
import * as ac4221 from "./fixtures/philips-ac4221";
/** What the reference code produced (see the header). */
const CRYPTO = {
    desired:
        '{"state": {"desired": {"CommandType": "app", "DeviceId": "", "EnduserId": "", "pwr": "1", "mode": "AG"}}}',
    enc1: "0000000B7078A65A25AF201D107BC1B2CA6EAE28512CC50A226372C0EA7594FB446F05980B58CB0E673A800A7ADB0D08513D66DCC2F6AE6D95711331D6BBB3DA8EFF9E7330FC84710B6CFAC34C4816C750D76E0E721E41263D4B7911B19AA4176FAA9A4E6AEC2258991CC43FADEFBB3EC6ED6E2118043D96F237A959FFA09BAF720CB599B5BB9C1BA3D42B93F7FE2CDC813CA54A",
    enc2: "0000000C0DE43C29397B861FAC673FF454910A3B91F064746E0033B22611D47A33C6D9B03E09D0C38AAB3B15520AC104C5F30AF95E2276A16097EDE20356E8D62EDCC27582DD8A3EF44091611C2A6DCE26303A101C19F6978FDD33A8E0068857B01BC32A6C8860BD9AC88AC54870028F4B9B33E79E6B1D5E3D88BA41FCE856B17B54CF7EAC2FF776292D95C899960E18B236DF4C",
    wrapFrom: "FFFFFFFF",
    wrapPlain: "{}",
    wrapEnc:
        "00000000D23CAFC597050F31852D2EC950FA6CD576542560ECDBFF7A2F82D954656FBDD76F47660F51AC9D40AC25699418DE99E9",
    statusPlain:
        '{"state": {"reported": {"pwr": "1", "pm25": 12, "iaql": 2, "rh": 45, "temp": 21, "om": "s", "mode": "S", "cl": false, "uil": "1", "fltsts0": 300, "fltsts1": 540, "flttotal1": 4800, "modelid": "AC3829/10", "name": "Bedroom", "DeviceId": "abc123", "WifiVersion": "AWS_Philips_AIR@71.1"}}}',
    statusEnc:
        "12AB34CEAB95995A6F8343D12814ABB06D45728CABC01D04EFAD5DCDA57DD17DAE2C1EAB8AA481BF6AC5BF2E9ACD5E183692C97A2D5BB5B532062C18E49311A4AE34568DD2917F8828DF6710160982D33C1C1FD4A322619E42BDC0F7A6A41609EE0386E57B4C0C4AB82AE10CC9F827BEC257D9AA74F7B8AA3843CF5CE7DFF92B7564F9FB1278703D6DFCBE1A8E7001AB98A2C5868A360DF585DE64716B887273672A0120A6BBEE2E7635D19F6DFA0B72E267A55B15B188B5001D89D741A20EDC0D0821B1A41CA315EB33FF2B90AA5EC2D798FF22EC26AD8E93E4D9B1D983340C4E2CC97D03955576923CA07B13B51E1319DBC3E7BB37F508C363F215270522DAB2DE5B4728DDE823A20CA06ECC8D977C050808CCD4BFCE80DEC64718CC715E06ABDE304CB42AE2C10820439083B5118193D23DD5468201B1C2D06B4437C1F65F876A91C4"
};

/** aiocoap 0.4.17's bytes for the same messages, token 0a0b0c0d. */
const COAP = {
    sync: "540212340a0b0c0db3737973036465760473796e63ff3141324233433444",
    status: "540112350a0b0c0d60537379730364657606737461747573",
    control:
        "540212360a0b0c0db37379730364657607636f6e74726f6cff3030303030303042373037384136354132354146323031443130374243314232434136454145323835313243433530413232363337324330454137353934464234343646303539383042353843423045363733413830304137414442304430383531334436364443433246364145364439353731313333314436424242334441384546463945373333304643383437313042364346414333344334383136433735304437364530453732314534313236334434423739313142313941413431373646414139413445364145433232353839393143433433464144454642423345433645443645323131383034334439364632333741393539464641303942414637323043423539394235424239433142413344343242393346374645324344433831334341353441",
    info: "540112370a0b0c0db37379730364657604696e666f",
    notification:
        "544501010a0b0c0d6107813cff313241423334434541423935393935413646383334334431323831344142423036443435373238434142433031443034454641443544434441353744443137444145324331454142384141343831424636414335424632453941434435453138333639324339374132443542423542353332303632433138453439333131413441453334353638444432393137463838323844463637313031363039383244333343314331464434413332323631394534324244433046374136413431363039454530333836453537423443304334414238324145313043433946383237424543323537443941413734463742384141333834334346354345374446463932423735363446394642313237383730334436444643424531413845373030314142393841324335383638413336304446353835444536343731364238383732373336373241303132304136424245453245373633354431394636444641304237324532363741353542313542313838423530303144383944373431413230454443304430383231423141343143413331354542333346463242393041413545433244373938464632324543323641443845393345344439423144393833333430433445324343393744303339353535373639323343413037423133423531453133313944424333453742423337463530384333363346323135323730353232444142324445354234373238444445383233413230434130364543433844393737433035303830384343443442464345383044454336343731384343373135453036414244453330344342343241453243313038323034333930383342353131383139334432334444353436383230314231433244303642343433374331463635463837364139314334",
    conResponse: "444501020a0b0c0dff3132414233344344",
    ack: "60000102",
    changed: "544401030a0b0c0dff7b22737461747573223a2273756363657373227d"
};
// --- a unit made of fixtures ------------------------------------------------------

interface FakeUnit {
    status: Record<string, unknown>;
    info: Record<string, unknown> | null;
    /** How many syncs to leave unanswered first: a wedged CoAP stack. */
    deafSyncs: number;
    /** Whether the port answers "unreachable": local control switched off. */
    refused: boolean;
    /** Answers who it is and nothing else. */
    infoOnly: boolean;
    /** Never answers a status read; pushes after a write instead. */
    pushOnly: boolean;
    /** Every set of values it was told, decrypted. */
    told: Record<string, unknown>[];
    links: number;
}

const units = new Map<string, FakeUnit>();
/** Every address a link was opened to, in order. */
const opened: string[] = [];

function unit(address: string, overrides: Partial<FakeUnit> = {}): FakeUnit {
    const made: FakeUnit = {
        status: {},
        info: null,
        deafSyncs: 0,
        refused: false,
        infoOnly: false,
        pushOnly: false,
        told: [],
        links: 0,
        ...overrides
    };
    units.set(address, made);
    return made;
}

const crypto = await import("@polaris-app/places/src/lib/integrations/philips-crypto");
const coap = await import("@polaris-app/places/src/lib/integrations/coap");

function path(message: CoapMessage): string {
    return (message.path ?? []).join("/");
}

function reply(
    request: CoapMessage,
    payload: string | Buffer,
    extra: Partial<CoapMessage> = {}
): CoapMessage {
    return {
        type: coap.CoapType.NON,
        code: coap.CoapCode.CONTENT,
        messageId: 1,
        token: request.token,
        payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
        ...extra
    };
}

function sealedStatus(fake: FakeUnit): string {
    return crypto.sealPhilips("12AB34CE", crypto.pythonJson({ state: { reported: fake.status } }));
}

/** What the fake unit says to one message, if anything. */
function answer(fake: FakeUnit, message: CoapMessage, observers: Buffer[]): CoapMessage[] {
    if (fake.refused) return [];
    const at = path(message);
    if (at === "sys/dev/info") return fake.info ? [reply(message, JSON.stringify(fake.info))] : [];
    if (fake.infoOnly) return [];
    if (at === "sys/dev/sync") {
        if (fake.deafSyncs > 0) {
            fake.deafSyncs -= 1;
            return [];
        }
        return [reply(message, "12AB34CD", { type: coap.CoapType.CON })];
    }
    if (at === "sys/dev/status") {
        observers.push(message.token);
        return fake.pushOnly ? [] : [reply(message, sealedStatus(fake), { observe: 1 })];
    }
    if (at === "sys/dev/control") {
        const opened = JSON.parse(crypto.openPhilips(message.payload!.toString("ascii")));
        const values = { ...opened.state.desired };
        delete values.CommandType;
        delete values.DeviceId;
        delete values.EnduserId;
        fake.told.push(values);
        const changed = Object.entries(values).some(([key, value]) => fake.status[key] !== value);
        Object.assign(fake.status, values);
        const answers = [
            reply(message, JSON.stringify({ status: "success" }), { code: coap.CoapCode.CHANGED })
        ];
        // A push to every observer, on a real change.
        if (changed)
            for (const token of observers)
                answers.push(reply({ ...message, token }, sealedStatus(fake), { observe: 2 }));
        return answers;
    }
    return [];
}

vi.mock("@polaris-app/places/src/lib/integrations/philips-udp", () => ({
    async openCoapLink(address: string) {
        const fake = units.get(address);
        const queue: CoapMessage[] = [];
        const observers: Buffer[] = [];
        let unclaimed: ((message: CoapMessage) => void) | null = null;
        if (fake) fake.links += 1;
        opened.push(address);
        return {
            send(message: CoapMessage) {
                // Every message goes through the real encoder and decoder.
                const sent = coap.decodeCoap(coap.encodeCoap(message))!;
                for (const out of fake ? answer(fake, sent, observers) : []) {
                    const back = coap.decodeCoap(coap.encodeCoap(out))!;
                    if (
                        unclaimed &&
                        observers.some((token) => token.equals(back.token)) &&
                        back.observe === 2
                    )
                        unclaimed(back);
                    else queue.push(back);
                }
            },
            async next(match: (message: CoapMessage) => boolean) {
                const index = queue.findIndex(match);
                return index >= 0 ? queue.splice(index, 1)[0]! : null;
            },
            get refused() {
                return fake?.refused ?? false;
            },
            onUnclaimed(listener: ((message: CoapMessage) => void) | null) {
                unclaimed = listener;
                // As the real link does: whatever arrived unclaimed is handed over.
                if (listener) for (const message of queue.splice(0)) listener(message);
            },
            close() {}
        };
    },
    async coapScan(targets: readonly string[], message: CoapMessage) {
        return targets.flatMap((address) => {
            const fake = units.get(address);
            if (!fake?.info || fake.refused) return [];
            return [{ address, message: reply(message, JSON.stringify(fake.info)) }];
        });
    }
}));

const subnet = vi.hoisted(() => ({
    addresses: [] as string[],
    /** Polaris's own network, or null where it is not known. */
    own: null as string | null
}));
vi.mock("@polaris-app/places/src/lib/integrations/lan-unit", () => {
    const networkOf = (address: string) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(address)
            ? `${address.split(".").slice(0, 3).join(".")}.0/24`
            : null;
    return {
        async unitAddressOf(typed: string) {
            return typed;
        },
        async subnetTargets() {
            return subnet.addresses;
        },
        networkOf,
        async ownNetwork() {
            return subnet.own;
        },
        subnetAround(address: string) {
            const base = address.split(".").slice(0, 3).join(".");
            return Array.from({ length: 254 }, (_, index) => `${base}.${index + 1}`).filter(
                (entry) => entry !== address
            );
        }
    };
});

const api = await import("@polaris-app/places/src/lib/integrations/philips-api");
const driver = await import("@polaris-app/places/src/lib/drivers/philips-coap");
const kinds = await import("@polaris-app/places/src/lib/device-kinds");

/** An AC3829 (a first-generation purifier and humidifier) as it reports. */
function ac3829(): Record<string, unknown> {
    return JSON.parse(CRYPTO.statusPlain).state.reported;
}

beforeEach(() => {
    units.clear();
    opened.length = 0;
    subnet.addresses = [];
    subnet.own = null;
    driver.resetPhilipsState();
});

// --- the cipher -------------------------------------------------------------------

describe("the cipher", () => {
    it("seals as philips-airctrl does, moving the counter on per message", () => {
        const cipher = new crypto.PhilipsCipher("0000000A");
        expect(cipher.seal(CRYPTO.desired)).toBe(CRYPTO.enc1);
        expect(cipher.seal(CRYPTO.desired)).toBe(CRYPTO.enc2);
    });

    it("wraps the counter at 32 bits", () => {
        expect(crypto.nextCounter(CRYPTO.wrapFrom)).toBe("00000000");
        expect(new crypto.PhilipsCipher(CRYPTO.wrapFrom).seal(CRYPTO.wrapPlain)).toBe(
            CRYPTO.wrapEnc
        );
    });

    it("opens what a unit sealed, under the counter it carries", () => {
        expect(crypto.openPhilips(CRYPTO.statusEnc)).toBe(CRYPTO.statusPlain);
        expect(crypto.openPhilips(CRYPTO.enc1)).toBe(CRYPTO.desired);
    });

    it("refuses an answer whose checksum does not match", () => {
        const tampered = `${CRYPTO.statusEnc.slice(0, 20)}0${CRYPTO.statusEnc.slice(21)}`;
        expect(() => crypto.openPhilips(tampered)).toThrow(crypto.PhilipsDigestError);
        expect(() => crypto.openPhilips("not a sealed message")).toThrow(crypto.PhilipsDigestError);
    });

    it("writes a control message exactly as json.dumps does", () => {
        expect(api.controlPayload({ pwr: "1", mode: "AG" })).toBe(CRYPTO.desired);
    });
});

// --- the wire ---------------------------------------------------------------------

describe("a CoAP message", () => {
    const token = Buffer.from("0a0b0c0d", "hex");
    const NON = coap.CoapType.NON;

    it("is written as aiocoap writes the sync, status, control and info requests", () => {
        expect(
            coap
                .encodeCoap({
                    type: NON,
                    code: coap.CoapCode.POST,
                    messageId: 0x1234,
                    token,
                    path: ["sys", "dev", "sync"],
                    payload: Buffer.from("1A2B3C4D")
                })
                .toString("hex")
        ).toBe(COAP.sync);
        expect(
            coap
                .encodeCoap({
                    type: NON,
                    code: coap.CoapCode.GET,
                    messageId: 0x1235,
                    token,
                    path: ["sys", "dev", "status"],
                    observe: 0
                })
                .toString("hex")
        ).toBe(COAP.status);
        expect(
            coap
                .encodeCoap({
                    type: NON,
                    code: coap.CoapCode.POST,
                    messageId: 0x1236,
                    token,
                    path: ["sys", "dev", "control"],
                    payload: Buffer.from(CRYPTO.enc1)
                })
                .toString("hex")
        ).toBe(COAP.control);
        expect(
            coap
                .encodeCoap({
                    type: NON,
                    code: coap.CoapCode.GET,
                    messageId: 0x1237,
                    token,
                    path: ["sys", "dev", "info"]
                })
                .toString("hex")
        ).toBe(COAP.info);
        expect(
            coap
                .encodeCoap({
                    type: coap.CoapType.ACK,
                    code: coap.CoapCode.EMPTY,
                    messageId: 0x0102,
                    token: Buffer.alloc(0)
                })
                .toString("hex")
        ).toBe(COAP.ack);
    });

    it("is read back from a unit's notification, with its sequence and lifetime", () => {
        const message = coap.decodeCoap(Buffer.from(COAP.notification, "hex"))!;
        expect(message).toMatchObject({
            type: NON,
            code: coap.CoapCode.CONTENT,
            messageId: 0x0101,
            observe: 7,
            maxAge: 60
        });
        expect(message.token.toString("hex")).toBe("0a0b0c0d");
        expect(api.reportedOf(message.payload)).toEqual(ac3829());
    });

    it("is read back confirmable, and plain", () => {
        expect(coap.decodeCoap(Buffer.from(COAP.conResponse, "hex"))).toMatchObject({
            type: coap.CoapType.CON,
            messageId: 0x0102
        });
        expect(coap.decodeCoap(Buffer.from(COAP.changed, "hex"))?.payload?.toString()).toBe(
            '{"status":"success"}'
        );
    });

    it("is nothing when it is not CoAP", () => {
        expect(coap.decodeCoap(Buffer.from("hello"))).toBeNull();
        expect(coap.decodeCoap(Buffer.from([0x40]))).toBeNull();
        // A payload marker with nothing after it is malformed.
        expect(coap.decodeCoap(Buffer.from([0x50, 0x45, 0, 1, 0xff]))).toBeNull();
    });
});

// --- what a status means ---------------------------------------------------------

describe("a status, as Places reads it", () => {
    it("reads an AC3829's preset, speed, switches, measures and filters", () => {
        const model = driver.philipsModelOf("AC3829/10");
        expect(model).not.toBeNull();
        const air = driver.philipsAir(ac3829(), model);
        expect(air).toMatchObject({
            mode: "sleep",
            modes: ["auto", "allergen", "sleep", "speed_1", "speed_2", "speed_3", "turbo"],
            speed: "sleep",
            speeds: ["sleep", "speed_1", "speed_2", "speed_3", "turbo"],
            options: { childLock: false, light: true },
            readings: { pm25: 12, allergen: 2, humidity: 45, temperature: 21 },
            humidity: { target: null, min: 40, max: 70, step: 10 }
        });
        expect(air.filters).toEqual([
            { kind: "pre", percent: null, hours: 300, state: "ok" },
            { kind: "hepa", percent: 11, hours: 540, state: "soon" }
        ]);
        expect(kinds.airSettings(air)).not.toBeNull();
    });

    it("looks a model up by its name, its Wi-Fi generation, then its family", () => {
        expect(driver.philipsModelOf("AC0850/11", "AWS_Philips_AIR_Combo@64.3")?.generation).toBe(
            "gen3"
        );
        expect(driver.philipsModelOf("AC0850/11", "AWS_Philips_AIR@62")?.generation).toBe("gen2");
        expect(driver.philipsModelOf("AC2729/50")).toBe(driver.philipsModelOf("AC2729"));
        expect(driver.philipsModelOf("XX9999")).toBeNull();
    });

    it("reads a third-generation humidifier's target and tenths of a degree", () => {
        const model = driver.philipsModelOf("HU5710/10");
        const air = driver.philipsAir(
            {
                D03102: 1,
                D0310C: 19,
                D03128: 55,
                D03125: 48,
                D03224: 215,
                D03103: 1,
                D03105: 0,
                wicksts: 30,
                wicktotal: 4800
            },
            model
        );
        expect(air).toMatchObject({
            mode: "medium",
            humidity: { target: 55, min: 30, max: 70, step: 5 },
            options: { childLock: true, light: false },
            readings: { humidity: 48, temperature: 21.5 }
        });
        expect(air.filters).toEqual([{ kind: "wick", percent: 1, hours: 30, state: "now" }]);
    });

    it("writes each command as the integration's entities do", () => {
        const model = driver.philipsModelOf("AC3829");
        expect(driver.philipsValues(model, "gen1", "turn-on", undefined)).toEqual({ pwr: "1" });
        expect(
            driver.philipsValues(model, "gen1", "set-mode", {
                action: "set-mode",
                mode: "allergen"
            })
        ).toEqual({ pwr: "1", mode: "A" });
        expect(
            driver.philipsValues(model, "gen1", "set-fan", { action: "set-fan", speed: "turbo" })
        ).toEqual({ pwr: "1", mode: "M", om: "t" });
        expect(
            driver.philipsValues(model, "gen1", "set-option", {
                action: "set-option",
                option: "childLock",
                on: true
            })
        ).toEqual({ cl: true });
        expect(
            driver.philipsValues(model, "gen1", "set-option", {
                action: "set-option",
                option: "light",
                on: false
            })
        ).toEqual({ uil: "0" });
        expect(
            driver.philipsValues(model, "gen1", "set-option", {
                action: "set-option",
                option: "humidify",
                on: true
            })
        ).toEqual({ pwr: "1", func: "PH" });
        expect(
            driver.philipsValues(model, "gen1", "set-humidity", {
                action: "set-humidity",
                target: 62
            })
        ).toEqual({ rhset: 60 });
        const hu = driver.philipsModelOf("HU5710");
        expect(driver.philipsValues(hu, "gen3", "turn-off", undefined)).toEqual({ D03102: 0 });
        expect(
            driver.philipsValues(hu, "gen3", "set-option", {
                action: "set-option",
                option: "light",
                on: true
            })
        ).toEqual({ D03105: 123 });
        expect(() =>
            driver.philipsValues(hu, "gen3", "set-mode", { action: "set-mode", mode: "turbo" })
        ).toThrow("That mode is not one this device has");
        // An air conditioner's setting is never read as a purifier's.
        expect(() =>
            driver.philipsValues(model, "gen1", "set-fan", { action: "set-fan", fan: "high" })
        ).toThrow("Say what to set it to");
    });

    it("nudges through a transient value and ends where the owner left the light", () => {
        const nudge = driver.philipsModelOf("HU1509")!.nudge;
        expect(driver.nudgeFor(nudge, null)).toEqual([
            ["D03105", 0],
            ["D03105", 115]
        ]);
        expect(driver.nudgeFor(nudge, { D03105: 123 })).toEqual([
            ["D03105", 0],
            ["D03105", 123]
        ]);
        // Left off, the transient is the other value, so the unit still sees a change.
        expect(driver.nudgeFor(nudge, { D03105: 0 })).toEqual([
            ["D03105", 115],
            ["D03105", 0]
        ]);
    });
});

// --- the driver -----------------------------------------------------------------

describe("connecting", () => {
    it("reads a unit at a typed address and keeps where and what it is", async () => {
        unit("10.0.1.40", {
            status: ac3829(),
            info: { modelid: "AC3829/10", name: "Bedroom", device_id: "info-1" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "10.0.1.40" });
        expect(JSON.parse(stored!.units!)).toEqual([
            {
                address: "10.0.1.40",
                deviceId: "abc123",
                infoId: "info-1",
                model: "AC3829/10",
                wifi: "AWS_Philips_AIR@71.1",
                name: "Bedroom"
            }
        ]);
    });

    it("looks through the subnet when no address is typed", async () => {
        subnet.addresses = ["10.0.1.10", "10.0.1.40", "10.0.1.41"];
        unit("10.0.1.40", {
            status: ac3829(),
            info: { modelid: "AC3829/10", name: "Bedroom", device_id: "info-1" }
        });
        unit("10.0.1.41", {
            status: { ...ac3829(), DeviceId: "def456", name: "Hall" },
            info: { modelid: "AC3829/10", name: "Hall", device_id: "info-2" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "" });
        expect(
            JSON.parse(stored!.units!).map((entry: { deviceId: string }) => entry.deviceId)
        ).toEqual(["abc123", "def456"]);
    });

    it("reads the units it finds at the same time", async () => {
        subnet.addresses = ["10.0.1.40", "10.0.1.41"];
        unit("10.0.1.40", {
            status: ac3829(),
            deafSyncs: 1,
            info: { modelid: "AC3829/10", name: "Bedroom", device_id: "info-1" }
        });
        unit("10.0.1.41", {
            status: { ...ac3829(), DeviceId: "def456" },
            deafSyncs: 1,
            info: { modelid: "AC3829/10", name: "Hall", device_id: "info-2" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "" });
        expect(JSON.parse(stored!.units!)).toHaveLength(2);
        expect(opened.slice(0, 2).sort()).toEqual(["10.0.1.40", "10.0.1.41"]);
    });

    it("says so when nothing on the network is a Philips", async () => {
        subnet.addresses = ["10.0.1.10"];
        await expect(driver.philipsCoapDriver.verify({ host: "" })).rejects.toThrow(
            "No Philips air purifier answered on this network"
        );
        await expect(driver.philipsCoapDriver.verify({ host: "10.0.1.99" })).rejects.toThrow(
            "No Philips air purifier answered at that address"
        );
    });

    it("says the firmware does not allow local control when the port is closed", async () => {
        unit("10.0.1.40", { refused: true });
        await expect(driver.philipsCoapDriver.verify({ host: "10.0.1.40" })).rejects.toThrow(
            api.PHILIPS_LOCAL_OFF
        );
    });

    it("says the same of a unit that says who it is and will not be read", async () => {
        unit("10.0.1.40", {
            infoOnly: true,
            info: { modelid: "AC3829/10", name: "Bedroom", device_id: "info-1" }
        });
        await expect(driver.philipsCoapDriver.verify({ host: "10.0.1.40" })).rejects.toThrow(
            "This model's firmware does not allow local control"
        );
        subnet.addresses = ["10.0.1.40"];
        await expect(driver.philipsCoapDriver.verify({ host: "" })).rejects.toThrow(
            "This model's firmware does not allow local control"
        );
    });
});

const STORED = (deviceId = "abc123", model = "AC3829/10") => ({
    units: JSON.stringify([
        {
            address: "10.0.1.40",
            deviceId,
            infoId: "info-1",
            model,
            wifi: "AWS_Philips_AIR@71.1",
            name: "Bedroom"
        }
    ])
});

describe("reading", () => {
    it("draws a unit as an air purifier with its dust as the row's reading", async () => {
        unit("10.0.1.40", { status: ac3829() });
        const [row] = await driver.philipsCoapDriver.list(STORED());
        expect(row).toMatchObject({
            externalId: "abc123",
            kind: "air",
            name: "Bedroom",
            model: "AC3829/10",
            state: "on",
            online: true,
            value: "12",
            unit: "µg/m³"
        });
        expect(row!.air?.mode).toBe("sleep");
    });

    it("wakes a wedged unit with a fresh sync on a new link", async () => {
        const fake = unit("10.0.1.40", { status: ac3829(), deafSyncs: 1 });
        const [row] = await driver.philipsCoapDriver.list(STORED());
        expect(row!.online).toBe(true);
        expect(fake.links).toBe(2);
    });

    it("leaves a unit that will not answer alone for a while rather than asking every time", async () => {
        const fake = unit("10.0.1.40", { status: ac3829(), deafSyncs: 10 });
        const [first] = await driver.philipsCoapDriver.list(STORED());
        expect(first).toMatchObject({ online: false, state: "unknown", kind: "air" });
        const opened = fake.links;
        const [second] = await driver.philipsCoapDriver.list(STORED());
        expect(second!.online).toBe(false);
        expect(fake.links).toBe(opened);
    });

    it("finds a unit again by its id after it moves, and keeps the new address", async () => {
        subnet.addresses = ["10.0.1.40", "10.0.1.77"];
        unit("10.0.1.40", { deafSyncs: 10 });
        unit("10.0.1.77", {
            status: ac3829(),
            info: { modelid: "AC3829/10", name: "Bedroom", device_id: "info-1" }
        });
        const [row] = await driver.philipsCoapDriver.list(STORED());
        expect(row!.online).toBe(true);
        const renewed = await driver.philipsCoapDriver.renew!(STORED());
        expect(JSON.parse(renewed!.units!)[0].address).toBe("10.0.1.77");
    });

    it("refuses a stored connection it cannot read", async () => {
        await expect(driver.philipsCoapDriver.list({ units: "[]" })).rejects.toThrow(
            "Polaris has lost track of these air purifiers"
        );
    });
});

describe("operating", () => {
    it("sends the preset's values, sealed, and the unit lands on them", async () => {
        const fake = unit("10.0.1.40", { status: ac3829() });
        await driver.philipsCoapDriver.act(
            STORED(),
            { externalId: "abc123", kind: "air" },
            "set-mode",
            { action: "set-mode", mode: "auto" }
        );
        expect(fake.told).toEqual([{ pwr: "1", mode: "P" }]);
        const [row] = await driver.philipsCoapDriver.list(STORED());
        expect(row!.air?.mode).toBe("auto");
    });

    it("switches a model the table does not list with the key scheme its status uses", async () => {
        const fake = unit("10.0.1.40", {
            status: { "D03-02": "ON", DeviceId: "abc123", modelid: "AC9999/10" }
        });
        await driver.philipsCoapDriver.act(
            STORED("abc123", "AC9999/10"),
            { externalId: "abc123", kind: "air" },
            "turn-off",
            undefined
        );
        expect(fake.told).toEqual([{ "D03-02": "OFF" }]);
        const [row] = await driver.philipsCoapDriver.list(STORED("abc123", "AC9999/10"));
        expect(row!.state).toBe("off");
        await driver.philipsCoapDriver.act(
            STORED("abc123", "AC9999/10"),
            { externalId: "abc123", kind: "air" },
            "turn-on",
            undefined
        );
        expect(fake.told.at(-1)).toEqual({ "D03-02": "ON" });
    });

    it("says the unit refused when it never says success", async () => {
        unit("10.0.1.40", { status: ac3829(), infoOnly: true });
        await expect(
            driver.philipsCoapDriver.act(
                STORED(),
                { externalId: "abc123", kind: "air" },
                "turn-off",
                undefined
            )
        ).rejects.toThrow(api.PHILIPS_QUIET);
    });
});

describe("a unit whose firmware only pushes", () => {
    const HU1509 = () => ({
        D01S05: "HU1509/00",
        DeviceId: "hu-1",
        D03102: 1,
        D0310C: 17,
        D03105: 123,
        D03125: 41,
        D03128: 50
    });

    it("is read by nudging its light and ends with the light where the owner left it", async () => {
        const fake = unit("10.0.1.40", {
            status: HU1509(),
            pushOnly: true,
            info: { modelid: "HU1509/00", name: "Nursery", device_id: "info-9" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "10.0.1.40" });
        expect(JSON.parse(stored!.units!)[0]).toMatchObject({
            deviceId: "hu-1",
            model: "HU1509/00"
        });
        // First contact knows nothing yet: through 0 and resting on the table's 115.
        expect(fake.told).toEqual([{ D03105: 0 }, { D03105: 115 }]);
        driver.resetPhilipsState();
        fake.told.length = 0;

        const [row] = await driver.philipsCoapDriver.list(stored!);
        expect(row).toMatchObject({ online: true, kind: "air", state: "on" });
        expect(row!.air).toMatchObject({
            mode: "sleep",
            humidity: { target: 50, min: 30, max: 70, step: 5 }
        });
        // Read again from scratch, it goes through 0 and back to where it was left.
        expect(fake.told).toEqual([{ D03105: 0 }, { D03105: 115 }]);
        expect(fake.status.D03105).toBe(115);
    });

    it("keeps one link open and takes its pushes, with commands on that same link", async () => {
        const fake = unit("10.0.1.40", { status: HU1509(), pushOnly: true });
        const stored = STORED("hu-1", "HU1509/00");
        await driver.philipsCoapDriver.list(stored);
        expect(fake.links).toBe(1);
        await driver.philipsCoapDriver.act(
            stored,
            { externalId: "hu-1", kind: "air" },
            "set-humidity",
            { action: "set-humidity", target: 65 }
        );
        expect(fake.links).toBe(1);
        const [row] = await driver.philipsCoapDriver.list(stored);
        expect(row!.air?.humidity?.target).toBe(65);
        expect(fake.links).toBe(1);
    });

    it("lets go of the link when the connection is removed", async () => {
        const fake = unit("10.0.1.40", { status: HU1509(), pushOnly: true });
        const stored = STORED("hu-1", "HU1509/00");
        await driver.philipsCoapDriver.list(stored);
        await driver.philipsCoapDriver.forget!(stored);
        await driver.philipsCoapDriver.list(stored);
        expect(fake.links).toBe(2);
    });
});

// --- the 4200 series --------------------------------------------------------------

describe("the PureProtect Pro 4200 (AC4220, AC4221)", () => {
    const model = () => driver.philipsModelOf("AC4221/11", "AWS_Philips_AIR_Combo@3.0");

    it("is found under both model codes, as the AC22xx family", () => {
        expect(model()?.generation).toBe("gen3");
        expect(driver.philipsModelOf("AC4220/12")).toBe(model());
        expect(driver.philipsModelOf("AC4220/10")).toBe(model());
    });

    it("reads every preset, speed, switch, measure and filter a recorded status holds", () => {
        const air = driver.philipsAir(ac4221.AC4221_AUTO_PLUS, model());
        expect(air).toEqual({
            mode: "auto",
            modes: ["auto", "medium", "turbo", "sleep"],
            speed: null,
            speeds: ["speed_1", "speed_2", "speed_3", "speed_4", "speed_5"],
            humidity: null,
            options: { childLock: false, beep: true, autoPlus: true, light: true },
            readings: { pm25: 1, allergen: 1, gas: 1, humidity: 49, temperature: 20.7 },
            filters: [
                { kind: "nanoprotect", percent: 100, hours: 9600, state: "ok" },
                { kind: "pre", percent: 100, hours: 720, state: "ok" }
            ]
        });
        expect(kinds.airSettings(air)).toEqual(air);
        expect(kinds.airQuality(air)).toEqual({ level: "good", measure: "pm25" });
    });

    it("tells each recorded preset and speed apart", () => {
        expect(driver.philipsAir(ac4221.AC4221_MEDIUM, model()).mode).toBe("medium");
        expect(driver.philipsAir(ac4221.AC4221_TURBO, model()).mode).toBe("turbo");
        expect(driver.philipsAir(ac4221.AC4221_SPEED_3, model())).toMatchObject({
            mode: null,
            speed: "speed_3"
        });
        expect(driver.philipsAir(ac4221.AC4221_MEDIUM, model()).options.autoPlus).toBe(false);
    });

    it("reads the display light off at 0 and on at every brightness, auto included", () => {
        expect(driver.philipsAir(ac4221.AC4221_LIGHT_OFF, model()).options.light).toBe(false);
        // 101 is the app's Auto brightness (issue #160).
        expect(driver.philipsAir(ac4221.AC4221_AUTO_PLUS, model()).options.light).toBe(true);
    });

    it("draws a unit that is off, with its filters' wear", () => {
        const row = driver.philipsSnapshot(
            {
                address: "10.0.1.40",
                deviceId: "fixture0000000000000000000004221",
                infoId: "",
                model: "AC4221/11",
                wifi: "AWS_Philips_AIR_Combo@86",
                name: "Wohnzimmer"
            },
            ac4221.AC4221_OFF
        );
        expect(row).toMatchObject({
            state: "off",
            online: true,
            firmware: "0.2.1",
            value: "3",
            unit: "µg/m³"
        });
        expect(row.air?.filters).toEqual([
            { kind: "nanoprotect", percent: 98, hours: 9421, state: "ok" },
            { kind: "pre", percent: 75, hours: 541, state: "ok" }
        ]);
        expect(row.air?.readings).toMatchObject({ gas: 1, temperature: 29.2, humidity: 23 });
    });

    it("writes each control in the unit's own keys", () => {
        const values = (command: AirCommand) =>
            driver.philipsValues(model(), "gen3", command.action, command);
        expect(driver.philipsValues(model(), "gen3", "turn-on", undefined)).toEqual({
            D03102: 1
        });
        expect(values({ action: "set-mode", mode: "sleep" })).toEqual({ D03102: 1, D0310C: 17 });
        expect(values({ action: "set-fan", speed: "speed_3" })).toEqual({ D03102: 1, D0310C: 3 });
        expect(values({ action: "set-option", option: "childLock", on: true })).toEqual({
            D03103: 1
        });
        expect(values({ action: "set-option", option: "light", on: true })).toEqual({
            D03105: 123
        });
        expect(values({ action: "set-option", option: "beep", on: false })).toEqual({
            D03130: 0
        });
        expect(values({ action: "set-option", option: "autoPlus", on: true })).toEqual({
            D03180: 1
        });
        expect(() => values({ action: "set-option", option: "oscillate", on: true })).toThrow(
            "That setting is not one this device has"
        );
    });

    it("is connected by its address and read with its gas level", async () => {
        unit("10.0.1.40", {
            status: { ...ac4221.AC4221_AUTO_PLUS },
            info: { modelid: "AC4221/11", name: "Living room", device_id: "info-4221" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "10.0.1.40" });
        const [row] = await driver.philipsCoapDriver.list({ units: stored!.units! });
        expect(row).toMatchObject({ kind: "air", state: "on", online: true, model: "AC4221/11" });
        expect(row!.air?.readings.gas).toBe(1);
    });

    it("switches Auto+ off on the unit, which lands on it", async () => {
        const fake = unit("10.0.1.40", {
            status: { ...ac4221.AC4221_AUTO_PLUS },
            info: { modelid: "AC4221/11", name: "Living room", device_id: "info-4221" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "10.0.1.40" });
        await driver.philipsCoapDriver.act(
            { units: stored!.units! },
            { externalId: "fixture0000000000000000000004221" } as never,
            "set-option",
            { action: "set-option", option: "autoPlus", on: false }
        );
        expect(fake.told.at(-1)).toEqual({ D03180: 0 });
        expect(fake.status.D03180).toBe(0);
    });
});

// --- a unit on another network --------------------------------------------------

describe("a unit on another network than Polaris", () => {
    /** One AC4221 stored at an address on 10.0.2.0/24. */
    const elsewhere = () => ({
        units: STORED("abc123", "AC4221/11").units.replace("10.0.1.40", "10.0.2.40")
    });

    beforeEach(() => {
        subnet.own = "10.0.1.0/24";
    });

    it("is connected by its address when the router passes traffic to it", async () => {
        unit("10.0.2.40", {
            status: { ...ac4221.AC4221_AUTO_PLUS },
            info: { modelid: "AC4221/11", name: "Living room", device_id: "info-4221" }
        });
        const stored = await driver.philipsCoapDriver.verify({ host: "10.0.2.40" });
        expect(JSON.parse(stored!.units!)[0].address).toBe("10.0.2.40");
    });

    it("says it is on a network Polaris cannot reach when nothing answers there", async () => {
        await expect(driver.philipsCoapDriver.verify({ host: "10.0.2.40" })).rejects.toThrow(
            driver.otherNetworkSentence("10.0.2.40", "10.0.1.0/24")
        );
        // On Polaris's own network, silence is just silence.
        await expect(driver.philipsCoapDriver.verify({ host: "10.0.1.99" })).rejects.toThrow(
            "No Philips air purifier answered at that address"
        );
    });

    it("says the same when a command cannot reach it", async () => {
        unit("10.0.2.40", { status: { ...ac4221.AC4221_AUTO_PLUS }, deafSyncs: 99 });
        await expect(
            driver.philipsCoapDriver.act(
                elsewhere(),
                { externalId: "abc123" } as never,
                "turn-off",
                undefined
            )
        ).rejects.toThrow(driver.otherNetworkSentence("10.0.2.40", "10.0.1.0/24"));
    });

    it("is looked for on its own network after it moves there, not only on Polaris's", async () => {
        subnet.addresses = ["10.0.1.40"];
        unit("10.0.2.40", { deafSyncs: 99 });
        unit("10.0.2.77", {
            status: { ...ac4221.AC4221_AUTO_PLUS, DeviceId: "abc123" },
            info: { modelid: "AC4221/11", name: "Bedroom", device_id: "info-1" }
        });
        const [row] = await driver.philipsCoapDriver.list(elsewhere());
        expect(row!.online).toBe(true);
        const renewed = await driver.philipsCoapDriver.renew!(elsewhere());
        expect(JSON.parse(renewed!.units!)[0].address).toBe("10.0.2.77");
    });
});
