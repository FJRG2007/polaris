/**
 * The catalogue as Companion's actions, feedbacks, variables and presets.
 */

import { readFileSync } from "node:fs";
import { VERSION } from "../src/version";
import * as mapping from "../src/mapping";
import { describe, expect, it } from "vitest";
import { phaseStatus, phaseText } from "../src/status";
import type { DeckAction } from "../../streamdeck/src/polaris";

const UNREAD: DeckAction = {
    id: "chat.unread",
    kind: "state",
    area: "chat",
    label: "Unread messages",
    icon: "message-circle",
    options: [],
    live: true
};
const PRESENCE: DeckAction = {
    id: "status.presence",
    kind: "toggle",
    area: "status",
    label: "Set yourself busy",
    icon: "moon",
    live: true,
    options: [
        {
            name: "choice",
            type: "choice",
            label: "Status",
            required: true,
            choices: [
                { value: "busy", label: "Busy" },
                { value: "away", label: "Away" }
            ]
        }
    ]
};
const SEND: DeckAction = {
    id: "chat.send",
    kind: "run",
    area: "chat",
    label: "Send a message",
    icon: "send",
    live: false,
    options: [
        { name: "conversationId", type: "choice", label: "Chat", required: true, choices: [] },
        { name: "body", type: "text", label: "Message", required: true }
    ]
};
const LIGHT: DeckAction = {
    id: "places.light",
    kind: "dial",
    area: "places",
    label: "Light brightness",
    icon: "sun",
    live: true,
    options: [{ name: "deviceId", type: "text", label: "Light", required: true }]
};
const OPEN: DeckAction = {
    id: "polaris.open",
    kind: "open",
    area: "polaris",
    label: "Open Polaris",
    icon: "external-link",
    options: [],
    live: false,
    path: "/"
};
const CATALOGUE = [UNREAD, PRESENCE, SEND, LIGHT, OPEN];

describe("the catalogue as Companion's lists", () => {
    it("names things the way Companion accepts", () => {
        expect(mapping.companionId("chat.unread")).toBe("chat_unread");
        expect(mapping.companionId("a-b.c d")).toBe("a_b_c_d");
    });

    it("makes actions of what runs, and leaves out pages to open and plain states", () => {
        expect(mapping.runnable(CATALOGUE).map((entry) => entry.id)).toEqual([
            "status.presence",
            "chat.send",
            "places.light"
        ]);
        expect(mapping.watchable(CATALOGUE).map((entry) => entry.id)).toEqual([
            "chat.unread",
            "status.presence",
            "places.light"
        ]);
    });

    it("turns each field into the input Companion draws for it", () => {
        expect(mapping.actionOptions(PRESENCE)).toEqual([
            {
                type: "dropdown",
                id: "choice",
                label: "Status",
                default: "busy",
                choices: [
                    { id: "busy", label: "Busy" },
                    { id: "away", label: "Away" }
                ]
            }
        ]);
        expect(mapping.optionField(SEND.options[1]!)).toEqual({
            type: "textinput",
            id: "body",
            label: "Message",
            default: "",
            useVariables: true
        });
        expect(
            mapping.optionField({
                name: "n",
                type: "number",
                label: "N",
                required: false,
                min: 5,
                max: 9
            })
        ).toMatchObject({ type: "number", default: 5, min: 5, max: 9 });
    });

    it("gives a dial a level to set, which its feedback does not watch", () => {
        expect(mapping.actionOptions(LIGHT).map((field) => field.id)).toEqual([
            "deviceId",
            "level"
        ]);
        expect(mapping.feedbackOptions(LIGHT).map((field) => field.id)).toEqual(["deviceId"]);
        const values = { deviceId: "lamp", level: "70", _text: true };
        expect(mapping.deckOptions(LIGHT, values)).toEqual({ deviceId: "lamp", level: 70 });
        expect(mapping.deckOptions(LIGHT, values, false)).toEqual({ deviceId: "lamp" });
    });

    it("gives a dial with a range Polaris sent that range instead of a level", () => {
        const climate: DeckAction = {
            ...LIGHT,
            id: "places.climate",
            dial: { min: 16, max: 30, step: 0.5 }
        };
        expect(mapping.actionOptions(climate).at(-1)).toMatchObject({
            id: "level",
            label: "Value",
            default: 23,
            min: 16,
            max: 30
        });
    });

    it("leaves out what cannot be undone: a button has no second press to ask", () => {
        const wipe: DeckAction = { ...SEND, id: "tool.games_backup_restore", confirm: true };
        expect(mapping.runnable([SEND, wipe]).map((entry) => entry.id)).toEqual([SEND.id]);
    });

    it("sends Polaris only the entry's own fields, and leaves empty text out", () => {
        expect(mapping.deckOptions(SEND, { conversationId: "c1", body: "", stray: "x" })).toEqual({
            conversationId: "c1"
        });
    });
});

describe("state on a button", () => {
    it("colours by tone and draws the value under the name when asked", () => {
        expect(mapping.stateStyle("Unread", { tone: "bad", value: "3" }, true)).toEqual({
            bgcolor: mapping.COLORS.bad,
            color: mapping.COLORS.white,
            text: "Unread\n3"
        });
        expect(mapping.stateStyle("Unread", { tone: "ok" }, false)).toEqual({
            bgcolor: mapping.COLORS.ok,
            color: mapping.COLORS.white
        });
        expect(mapping.stateStyle("Busy", { tone: "ok", on: false }, true).bgcolor).toBe(
            mapping.COLORS.off
        );
        expect(mapping.stateStyle("Unread", undefined, true).bgcolor).toBe(mapping.COLORS.idle);
    });

    it("reads as a variable: the value, on or off, the status line, else the tone", () => {
        expect(mapping.stateValue({ tone: "bad", value: "3" })).toBe("3");
        expect(mapping.stateValue({ tone: "ok", on: true })).toBe("on");
        expect(mapping.stateValue({ tone: "warn", detail: "Building" })).toBe("Building");
        expect(mapping.stateValue({ tone: "idle" })).toBe("idle");
        expect(mapping.stateValue(undefined)).toBe("");
    });
});

describe("what the stream watches", () => {
    it("is every state that needs nothing picked, then every feedback on a button", () => {
        const feedbacks = new Map([
            ["fb1", { key: "fb1", action: "places.light", options: { deviceId: "lamp" } }]
        ]);
        expect(mapping.watchList(CATALOGUE, feedbacks)).toEqual([
            { key: "var:chat_unread", action: "chat.unread", options: {} },
            { key: "var:status_presence", action: "status.presence", options: { choice: "busy" } },
            { key: "fb1", action: "places.light", options: { deviceId: "lamp" } }
        ]);
        expect(mapping.catalogueVariables(CATALOGUE).map((variable) => variable.id)).toEqual([
            "chat_unread",
            "status_presence"
        ]);
    });

    it("stops at what Polaris watches on one stream", () => {
        const many = new Map(
            Array.from({ length: 80 }, (_, index) => [
                `fb${index}`,
                { key: `fb${index}`, action: "chat.unread", options: {} }
            ])
        );
        expect(mapping.watchList([], many)).toHaveLength(mapping.MAX_WATCHED);
    });
});

describe("presets", () => {
    it("are made for what works as dropped, grouped by area", () => {
        expect(mapping.presetSpecs(CATALOGUE)).toEqual([
            {
                id: "chat_unread",
                area: "chat",
                name: "Unread messages",
                actionId: null,
                options: {},
                feedbackId: "chat_unread"
            },
            {
                id: "status_presence",
                area: "status",
                name: "Set yourself busy",
                actionId: "status_presence",
                options: { choice: "busy" },
                feedbackId: "status_presence"
            }
        ]);
    });
});

describe("your call and your places on Companion buttons", () => {
    const entry = (
        id: string,
        kind: DeckAction["kind"],
        options: DeckAction["options"] = []
    ): DeckAction => ({
        id,
        kind,
        area: id.split(".")[0]!,
        label: id,
        icon: "power",
        options,
        live: true
    });
    const MIC = entry("call.mic", "toggle");
    const CAMERA = entry("call.camera", "toggle");
    const RECORD = entry("call.record", "toggle");
    const HANGUP = entry("call.hangup", "run");
    const SOUND = entry("call.sound", "run", [
        {
            name: "sound",
            type: "choice",
            label: "Sound",
            required: true,
            choices: [{ value: "default-applause", label: "Applause" }]
        }
    ]);
    const DEVICE = entry("places.device", "toggle", [
        {
            name: "deviceId",
            type: "choice",
            label: "Device",
            required: true,
            choices: [{ value: "d1", label: "Lamp" }]
        }
    ]);
    const CALL = [MIC, CAMERA, RECORD, HANGUP, SOUND, DEVICE];

    it("runs every call control, the soundboard and a Places device", () => {
        expect(mapping.runnable(CALL).map((action) => action.id)).toEqual([
            "call.mic",
            "call.camera",
            "call.record",
            "call.hangup",
            "call.sound",
            "places.device"
        ]);
        expect(mapping.actionOptions(SOUND)).toEqual([
            {
                type: "dropdown",
                id: "sound",
                label: "Sound",
                default: "default-applause",
                choices: [{ id: "default-applause", label: "Applause" }]
            }
        ]);
    });

    it("has the mute, camera and recording state as variables, on or off", () => {
        expect(mapping.catalogueVariables(CALL).map((variable) => variable.id)).toEqual([
            "call_mic",
            "call_camera",
            "call_record",
            "call_hangup",
            "call_sound",
            "places_device"
        ]);
        expect(mapping.stateValue({ tone: "warn", on: true, detail: "Muted" })).toBe("on");
        expect(mapping.stateValue({ tone: "idle", detail: "No call" })).toBe("No call");
    });

    it("lights muted and deafened amber, recording red, and the camera green", () => {
        expect(mapping.onStyle(MIC).bgcolor).toBe(mapping.COLORS.warn);
        expect(mapping.onStyle(entry("call.deafen", "toggle")).bgcolor).toBe(mapping.COLORS.warn);
        expect(mapping.onStyle(RECORD).bgcolor).toBe(mapping.COLORS.bad);
        expect(mapping.onStyle(CAMERA).bgcolor).toBe(mapping.COLORS.ok);
        expect(mapping.onStyle(DEVICE).bgcolor).toBe(mapping.COLORS.ok);
    });

    it("says out of a call on the button, and shows the switch as off", () => {
        expect(mapping.stateStyle("Mute", { tone: "idle", detail: "No call" }, true)).toEqual({
            bgcolor: mapping.COLORS.idle,
            color: mapping.COLORS.white,
            text: "Mute\nNo call"
        });
        expect(
            mapping.stateStyle("Camera", { tone: "idle", on: false, detail: "Camera off" }, false)
                .bgcolor
        ).toBe(mapping.COLORS.off);
    });

    it("offers a ready-made button for each, under the call and Places", () => {
        const specs = mapping.presetSpecs(CALL);
        expect(specs.map((spec) => [spec.area, spec.id])).toEqual([
            ["call", "call_mic"],
            ["call", "call_camera"],
            ["call", "call_record"],
            ["call", "call_hangup"],
            ["call", "call_sound"],
            ["places", "places_device"]
        ]);
        expect(specs.find((spec) => spec.id === "call_sound")?.options).toEqual({
            sound: "default-applause"
        });
        expect(specs.find((spec) => spec.id === "call_mic")?.feedbackId).toBe("call_mic");
    });
});

describe("the connection's status", () => {
    it("shows the code and where to approve it while signing in", () => {
        const phase = {
            phase: "signing-in",
            userCode: "ABCD-EFGH",
            url: "https://p.test/device"
        } as const;
        expect(phaseStatus(phase)).toEqual([
            "Connecting",
            "Approve code ABCD-EFGH at https://p.test/device"
        ]);
        expect(phaseText(phase, undefined)).toContain("ABCD-EFGH");
        expect(phaseStatus({ phase: "unauthorized" })[0]).toBe("AuthenticationFailure");
        expect(phaseText({ phase: "online" }, "Ada")).toBe("Signed in as Ada.");
        // It acts as one person, and says which.
        expect(phaseStatus({ phase: "online" }, "Ada (ada@example.test)")).toEqual([
            "Ok",
            "Signed in as Ada (ada@example.test)"
        ]);
    });
});

describe("the version", () => {
    it("is the package's, which is what Companion reads", () => {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8")
        ) as {
            version: string;
        };
        expect(VERSION).toBe(pkg.version);
    });
});

describe("keysShowing", () => {
    const entry = {
        id: "places.door",
        kind: "run",
        area: "places",
        label: "Door",
        icon: "lock",
        options: [],
        live: true
    } as DeckAction;

    it("finds every feedback and the variable set to the same thing a press changes", () => {
        const options = { deviceId: "d1", command: "lock" };
        expect(
            mapping.keysShowing(entry, options, [
                { key: "f1", action: "places.door", options },
                { key: "f2", action: "places.door", options: { deviceId: "d2", command: "lock" } },
                { key: "var:places_door", action: "places.door", options },
                { key: "f3", action: "places.device", options }
            ])
        ).toEqual(["f1", "var:places_door"]);
    });
});
