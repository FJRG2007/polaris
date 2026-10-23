/**
 * Builds the Polaris profiles the plugin ships, one `.streamDeckProfile` per
 * kind of deck, into `io.github.fjrg2007.polaris.sdPlugin/profiles/`. The
 * Polaris key opens the one for its deck (`src/folder.ts`), which is how a
 * plugin gets a folder with the Polaris mark: it cannot add a folder to the
 * person's own profile, only switch to profiles it ships
 * (docs.elgato.com/streamdeck/sdk/guides/profiles).
 *
 * Elgato documents the manifest side but not the file, which the Stream Deck
 * app writes when a profile is exported. The shape below is that of an export
 * from Stream Deck 7.4 (a ZIP of `package.json` and a `Profiles/<id>.sdProfile`
 * folder with a manifest per page), kept to the fields such an export has.
 *
 * Pure apart from `main`, and deterministic: the same manifest gives the same
 * bytes, so a test can hold it.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PLUGIN_UUID = "io.github.fjrg2007.polaris";
const SD_PLUGIN = `${PLUGIN_UUID}.sdPlugin`;

/** A key on a bundled page: the action, and the settings it starts with. */
const key = (action, name, settings, showTitle = false) => ({ action, name, settings, showTitle });
const run = (id, options = {}) => ({ action: id, options });

const BACK = key("folder", "Folder", { back: true }, true);
const MIC = key("call", "Call", run("call.mic"));
const DEAFEN = key("call", "Call", run("call.deafen"));
const CAMERA = key("call", "Call", run("call.camera"));
const RECORD = key("call", "Call", run("call.record"));
const HANGUP = key("call", "Call", run("call.hangup"));
const UNREAD = key("key", "Action", run("chat.unread"));
const CHAT = key("key", "Action", run("chat.open"));
const NOTIFICATIONS = key("key", "Action", run("polaris.notifications"));
const ALARMS = key("key", "Action", run("watch.alarms"));
const BUSY = key("key", "Action", run("status.presence", { choice: "busy" }));
const HOME = key("key", "Action", run("polaris.open", { path: "/home" }));
/** Left unset: it asks which device on the deck itself. */
const PLACE = key("places", "Places device", {});
const TIMER = key("timer", "Timer", { source: "deck" });
const PLACES_DIAL = key("places-dial", "Places dial", {});

/**
 * Each kind of deck: its `DeviceType` in the manifest, the model an export
 * from it names, and its keys row by row (`null` is an empty key), with its
 * dials left to right.
 */
export const DECKS = [
    {
        profile: "profiles/polaris",
        deviceType: 0,
        model: "20GBA9901",
        keys: [
            [BACK, MIC, DEAFEN, CAMERA, HANGUP],
            [UNREAD, NOTIFICATIONS, ALARMS, BUSY, RECORD],
            [PLACE, PLACE, PLACE, TIMER, HOME]
        ]
    },
    {
        profile: "profiles/polaris-mini",
        deviceType: 1,
        model: "20GAI9901",
        keys: [
            [BACK, MIC, DEAFEN],
            [CAMERA, HANGUP, UNREAD]
        ]
    },
    {
        profile: "profiles/polaris-xl",
        deviceType: 2,
        model: "20GAT9901",
        keys: [
            [BACK, MIC, DEAFEN, CAMERA, RECORD, HANGUP, null, null],
            [UNREAD, CHAT, NOTIFICATIONS, ALARMS, BUSY, null, null, null],
            [PLACE, PLACE, PLACE, PLACE, null, null, null, null],
            [TIMER, HOME, null, null, null, null, null, null]
        ]
    },
    {
        profile: "profiles/polaris-plus",
        deviceType: 7,
        model: "20GBD9901",
        keys: [
            [BACK, MIC, DEAFEN, HANGUP],
            [UNREAD, NOTIFICATIONS, CAMERA, PLACE]
        ],
        dials: [PLACES_DIAL, PLACES_DIAL, TIMER, null]
    },
    {
        profile: "profiles/polaris-neo",
        deviceType: 9,
        model: "20GBJ9901",
        keys: [
            [BACK, MIC, DEAFEN, HANGUP],
            [UNREAD, NOTIFICATIONS, CAMERA, PLACE]
        ]
    },
    {
        profile: "profiles/polaris-plus-xl",
        deviceType: 13,
        model: "20GBX9901",
        keys: [
            [BACK, MIC, DEAFEN, CAMERA, RECORD, HANGUP, null, null, null],
            [UNREAD, CHAT, NOTIFICATIONS, ALARMS, BUSY, null, null, null, null],
            [PLACE, PLACE, PLACE, PLACE, null, null, null, null, null],
            [TIMER, HOME, null, null, null, null, null, null, null]
        ],
        dials: [PLACES_DIAL, PLACES_DIAL, PLACES_DIAL, TIMER, null, null]
    }
];

/** A UUID derived from a seed, so a rebuild names everything the same. */
export function stableUuid(seed) {
    const hex = createHash("sha256").update(`${PLUGIN_UUID}:${seed}`).digest("hex");
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One key or dial as a page manifest holds it. */
function placed(spec, version, seed) {
    return {
        ActionID: stableUuid(seed),
        LinkedTitle: true,
        Name: spec.name,
        Plugin: { Name: "Polaris", UUID: PLUGIN_UUID, Version: version },
        Resources: null,
        Settings: spec.settings,
        State: 0,
        States: [
            {
                FontFamily: "",
                FontSize: 9,
                FontStyle: "",
                FontUnderline: false,
                OutlineThickness: 2,
                ShowTitle: spec.showTitle,
                TitleAlignment: "bottom",
                TitleColor: "#ffffff"
            }
        ],
        UUID: `${PLUGIN_UUID}.${spec.action}`
    };
}

/** The keys or dials of a controller by their "column,row" position. */
function positions(rows, version, seed) {
    const actions = {};
    rows.forEach((row, y) =>
        row.forEach((spec, x) => {
            if (spec) actions[`${x},${y}`] = placed(spec, version, `${seed}:${x},${y}`);
        })
    );
    return actions;
}

/**
 * The files of one bundled profile, path to contents; a path ending in "/" is
 * a folder. `version` is the plugin's, as its manifest gives it.
 */
export function profileFiles(deck, version) {
    const profileId = stableUuid(`${deck.profile}:profile`);
    const pageId = stableUuid(`${deck.profile}:page`);
    const defaultId = stableUuid(`${deck.profile}:default`);
    const root = `Profiles/${profileId.toUpperCase()}.sdProfile/`;
    const page = `${root}Profiles/${pageId.toUpperCase()}/`;
    const blank = `${root}Profiles/${defaultId.toUpperCase()}/`;

    const controllers = [
        { Actions: positions(deck.keys, version, `${deck.profile}:keys`), Type: "Keypad" }
    ];
    const empty = [{ Actions: null, Type: "Keypad" }];
    if (deck.dials) {
        controllers.push({
            Actions: positions([deck.dials], version, `${deck.profile}:dials`),
            Type: "Encoder"
        });
        empty.push({ Actions: null, Type: "Encoder" });
    }

    const json = (value) => JSON.stringify(value);
    return [
        [
            "package.json",
            json({
                AppVersion: "7.4.0.22712",
                DeviceModel: deck.model,
                DeviceSettings: null,
                FormatVersion: 1,
                OSType: "Windows",
                OSVersion: "10.0.26200",
                RequiredPlugins: [PLUGIN_UUID]
            })
        ],
        ["Profiles/", null],
        [root, null],
        [`${root}Images/`, null],
        [
            `${root}manifest.json`,
            json({
                Device: { Model: deck.model, UUID: stableUuid(`${deck.profile}:device`) },
                Name: "Polaris",
                Pages: {
                    Current: "00000000-0000-0000-0000-000000000000",
                    Default: defaultId,
                    Pages: [pageId]
                },
                Version: "3.0"
            })
        ],
        [`${root}Profiles/`, null],
        [blank, null],
        [`${blank}Images/`, null],
        [`${blank}manifest.json`, json({ Controllers: empty, Icon: "", Name: "" })],
        [page, null],
        [`${page}Images/`, null],
        [`${page}manifest.json`, json({ Controllers: controllers, Icon: "", Name: "" })]
    ];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP of the files, stored without compression and dated 1980-01-01, so the
 * same files always give the same bytes.
 */
export function zip(files) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const [path, contents] of files) {
        const name = Buffer.from(path, "utf8");
        const data = contents === null ? Buffer.alloc(0) : Buffer.from(contents, "utf8");
        const crc = crc32(data);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x0800, 6); // names are UTF-8
        head.writeUInt16LE(0, 8); // stored
        head.writeUInt16LE(0, 10);
        head.writeUInt16LE(0x21, 12); // 1980-01-01
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(data.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(name.length, 26);
        head.writeUInt16LE(0, 28);
        local.push(head, name, data);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x0800, 8);
        entry.writeUInt16LE(0, 10);
        entry.writeUInt16LE(0, 12);
        entry.writeUInt16LE(0x21, 14);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt16LE(0, 30);
        entry.writeUInt16LE(0, 32);
        entry.writeUInt16LE(0, 34);
        entry.writeUInt16LE(0, 36);
        entry.writeUInt32LE(contents === null ? 0x10 : 0, 38); // a folder
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += head.length + name.length + data.length;
    }
    const size = central.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

/** Writes every bundled profile next to the plugin's manifest. */
function main() {
    const sdPlugin = join(dirname(fileURLToPath(import.meta.url)), "..", SD_PLUGIN);
    const manifest = JSON.parse(readFileSync(join(sdPlugin, "manifest.json"), "utf8"));
    for (const deck of DECKS) {
        const out = join(sdPlugin, `${deck.profile}.streamDeckProfile`);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, zip(profileFiles(deck, manifest.Version)));
    }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
