/**
 * The makes Polaris can talk to, and the ways in that each of them has.
 *
 * A make is not enough to connect anything, for the same reason a make is not
 * enough to add a camera. "Nuki" is a web account reachable from another country,
 * a box on the same network that answers in a few milliseconds, and a lock that
 * speaks to a broker on its own LAN - three different credentials, three
 * different failure modes, and a choice their owner is the only one who can make.
 * Anything that picked one for them would be right for some houses and silently
 * wrong for the rest.
 *
 * So a connection is what is chosen, not a brand: what it is called, what it
 * reaches, what it costs, and exactly which fields it needs. The screen draws the
 * fields from here, the schema validates them from here, and the driver is handed
 * them by name - so a fourth way in is an entry and a driver, and no form.
 *
 * Each brand marks one as `recommended`: the one that is quickest to set up and
 * keeps working with the least looking after. It is listed first, the picker
 * starts on it and labels it, and the rest follow in the order they are worth
 * trying.
 *
 * Ordered best first within a brand, and "best" is stated rather than implied:
 * what reaches the device from anywhere, what keeps working when somebody else's
 * server is down, and what does not cost battery are not the same thing, and the
 * note on each says which of those it is trading away. More than one at once is
 * the normal case rather than the exception - a lock on the web account and on
 * its own bridge is a lock that still answers when either is out.
 *
 * Some ways in are not typed but done: a code scanned with the maker's app, a
 * button pressed on a bridge. Such a connection declares `pairing`, and its
 * `fields` become what has to be known before the attempt starts (a user code, a
 * bridge's address) rather than the credential itself. The rest is generic and
 * no make needs a screen of its own for it:
 *
 * - The registry says what the reader is shown (`kind`: a code to scan, a
 *   button to press, or a box for a code sent by email), how often to ask
 *   whether it has happened (`pollMs`) and how long one attempt is given
 *   before a new one is offered (`lifetimeMs`).
 *   Its words are `connections.<id>.pairing.prompt` in the catalogs: the one
 *   line under the code or beside the wait.
 * - The driver implements `pair` (`drivers/contract.ts`): `start` takes the
 *   fields and answers a state and, for a code, what the code says; `poll`
 *   takes them back and answers the credentials once the other side agrees.
 *   The state is shown to the browser, so it never holds a secret.
 * - `startDevicePairingAction` and `pollDevicePairingAction` run those two for
 *   the connect dialog, which draws the step, polls on its own and stores the
 *   account the moment the answer arrives - through the same `verify` as a
 *   typed credential, so nothing that does not work is ever stored.
 *
 * A credential that ages is the driver's `renew`, stored by the account layer on
 * every use; nothing here has to know about it.
 *
 * Pure and client-safe: the picker and the server read the same list. That is a
 * rule with teeth rather than a note - every import here has to be pure too. This
 * file reached a provider's region list through its API client once, and the
 * client imports node's crypto to sign with: the browser bundle pulled that in
 * and the build failed with a webpack error naming neither file.
 */

import { emailField } from "@polaris/core";
import type { PlacesTranslator } from "./i18n";
import type { DeviceKind } from "./device-kinds";
import { macIssue, parseMac } from "@polaris/core";
import { TUYA_REGIONS } from "./integrations/tuya-regions";
import { englishPlaces as en, type PlacesKey } from "../../messages";

/** One thing a connection has to be told. */
export interface ConnectionField {
    /** Stored under this name and handed to the driver under it. */
    readonly key: string;
    readonly label: string;
    /** What it is and where it comes from, in one line under the field. */
    readonly hint?: string;
    readonly placeholder?: string;
    /**
     * Whether it is a credential.
     *
     * A secret field is typed into a password box, is never read back to any
     * screen, and is the reason the whole set is encrypted at rest. An address is
     * not a secret and is shown, because "which bridge is this pointed at" is a
     * question somebody has to be able to answer without disconnecting it.
     */
    readonly secret?: boolean;
    readonly optional?: boolean;
    /** A shape the value has to have, checked as it is typed. */
    readonly format?: "email";
    /**
     * Where the device is: an IP address or a name - or its hardware (MAC)
     * address instead, for a device whose app shows only that.
     *
     * A MAC is stored as the MAC, never as the IP it resolved to, and is turned
     * into the device's current IP every time the connection is used
     * (`integrations/mac-locate.ts`), so a device the router lends a new address
     * to is followed rather than lost. Declared here, on the field, so every make
     * with an address gets it and no driver has to know.
     */
    readonly address?: true;
    readonly minLength?: number;
    readonly maxLength?: number;
    /** A fixed set to pick from, where there is one. */
    readonly choices?: readonly { readonly value: string; readonly label: string }[];
    readonly defaultValue?: string;
}

/** Where a connection reaches from, which is the first thing anybody wants to
 *  know and the thing that decides whether it is any use to them. */
export type ConnectionReach = "anywhere" | "same-network";

export const REACH_LABELS: Readonly<Record<ConnectionReach, string>> = {
    anywhere: en("connections.reach.anywhere"),
    "same-network": en("connections.reach.same-network")
};

/**
 * How a connection that is done rather than typed is drawn and waited on. See the
 * file header for the whole of it.
 */
export interface ConnectionPairing {
    /**
     * What the reader is shown: a code to scan, a wait for a button, or a box
     * for a code the maker sent them. A `code` pairing is not polled: the code
     * typed rides in the state of the one `poll` that answers it.
     */
    readonly kind: "qr" | "press" | "code";
    /** How often the dialog asks whether it has happened. */
    readonly pollMs: number;
    /** How long one attempt is waited on before the dialog stops asking and
     *  offers a new one. Polaris' own bound where the maker publishes none. */
    readonly lifetimeMs: number;
    /**
     * A file the attempt may ask for after its first step, when the driver
     * answers a `file` step (`PairingNext`): what the picker accepts, the most
     * it takes, and where people get one. Its words are
     * `connections.<id>.pairing.file.*`.
     */
    readonly file?: {
        readonly accept: string;
        readonly maxBytes: number;
        readonly href: string;
    };
}

/** One way of reaching one make's devices. */
export interface DeviceConnection {
    /** Stored on the account row. Never shown. */
    readonly id: string;
    /** Who makes the devices, as their owner would say it. */
    readonly brand: string;
    /**
     * The make's logo, as an integration slug.
     *
     * A slug rather than a component, because this file is read by the server as
     * well and a picture has no business in it. What draws it is `IntegrationLogo`,
     * which is where every other mark in Polaris already lives - so a make with
     * one gets its own, and a make without gets the same honest neutral block an
     * unknown integration gets rather than something drawn to look like a logo.
     */
    readonly logo: string;
    /** What this way in is called, in the maker's own words where they have one -
     *  somebody looking for it in their documentation has to find the same name. */
    readonly label: string;
    readonly reach: ConnectionReach;
    /** The one of its brand the picker starts on and labels, and lists first:
     *  quickest to set up and the least to look after. One per brand. */
    readonly recommended?: boolean;
    /** One sentence in the picker: what it is and what it costs. */
    readonly summary: string;
    /** What its owner has to know before choosing it, where that is more than a
     *  sentence. */
    readonly note?: string;
    /** How to get what it asks for, where that part is genuinely not Polaris' to
     *  do - a token made in somebody else's console. */
    readonly steps?: readonly string[];
    readonly link?: { readonly label: string; readonly href: string };
    readonly fields: readonly ConnectionField[];
    /** Present when the connection is made by scanning or pressing something
     *  once the fields are in, rather than by the fields alone. */
    readonly pairing?: ConnectionPairing;
    /** What it can bring in, so a screen can say so before anything is typed. */
    readonly kinds: readonly DeviceKind[];
    /** Its driver can list the units it finds on the network (`discover`), so
     *  the dialog offers them to pick from before anything is typed. */
    readonly discovery?: true;
    /** Other words somebody might search for - the product it is part of, the
     *  name on the box, the way it is written in a forum. */
    readonly search?: readonly string[];
}

const NUKI_TOKEN_PAGE = "https://web.nuki.io/#/admin/web-api";
const TUYA_CONSOLE = "https://iot.tuya.com/";
const SWITCHBOT_API_DOCS = "https://github.com/OpenWonderLabs/SwitchBotAPI";

/**
 * Every way in, best first within each brand.
 *
 * A method is listed here when Polaris can actually use it. A picker that offered
 * something unbuilt would be a screen sending somebody to fetch a credential for
 * a connection that cannot be made.
 */
export const DEVICE_CONNECTIONS: readonly DeviceConnection[] = [
    {
        id: "nuki-web",
        brand: "Nuki",
        logo: "nuki",
        label: en("connections.nuki-web.label"),
        reach: "anywhere",
        // One token pasted from Nuki Web, for every lock on the account, from
        // anywhere, with the account's record of who opened what. The local way
        // in answers faster but needs a broker and only the newer locks have it.
        recommended: true,
        summary: en("connections.nuki-web.summary"),
        note: en("connections.nuki-web.note"),
        steps: [
            en("connections.nuki-web.steps.s0"),
            en("connections.nuki-web.steps.s1"),
            en("connections.nuki-web.steps.s2")
        ],
        link: { label: en("connections.nuki-web.link"), href: NUKI_TOKEN_PAGE },
        fields: [
            {
                key: "token",
                label: en("connections.nuki-web.fields.token.label"),
                placeholder: en("connections.nuki-web.fields.token.placeholder"),
                secret: true,
                minLength: 20,
                maxLength: 500
            }
        ],
        kinds: ["lock", "opener"],
        search: ["smart lock", "opener", "smart door", "web api"]
    },
    {
        id: "nuki-local",
        brand: "Nuki",
        logo: "nuki",
        label: en("connections.nuki-local.label"),
        reach: "same-network",
        summary: en("connections.nuki-local.summary"),
        note: en("connections.nuki-local.note"),
        steps: [
            en("connections.nuki-local.steps.s0"),
            en("connections.nuki-local.steps.s1"),
            en("connections.nuki-local.steps.s2")
        ],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.nuki-local.fields.host.label"),
                hint: en("connections.nuki-local.fields.host.hint"),
                placeholder: en("connections.nuki-local.fields.host.placeholder"),
                maxLength: 200
            },
            {
                key: "port",
                label: en("connections.nuki-local.fields.port.label"),
                defaultValue: "1883",
                optional: true,
                maxLength: 5
            },
            {
                key: "username",
                label: en("connections.nuki-local.fields.username.label"),
                optional: true,
                maxLength: 32
            },
            {
                key: "password",
                label: en("connections.nuki-local.fields.password.label"),
                secret: true,
                optional: true,
                maxLength: 32
            },
            {
                key: "prefix",
                label: en("connections.nuki-local.fields.prefix.label"),
                hint: en("connections.nuki-local.fields.prefix.hint"),
                defaultValue: "nuki",
                optional: true,
                maxLength: 60
            }
        ],
        kinds: ["lock", "opener"],
        search: ["mqtt", "local", "broker", "smart lock pro", "ultra", "go", "offline", "lan"]
    },
    {
        id: "mqtt-discovery",
        brand: en("connections.brandMqtt"),
        logo: "mqtt",
        label: en("connections.mqtt-discovery.label"),
        reach: "same-network",
        recommended: true,
        summary: en("connections.mqtt-discovery.summary"),
        note: en("connections.mqtt-discovery.note"),
        steps: [
            en("connections.mqtt-discovery.steps.s0"),
            en("connections.mqtt-discovery.steps.s1"),
            en("connections.mqtt-discovery.steps.s2")
        ],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.mqtt-discovery.fields.host.label"),
                hint: en("connections.mqtt-discovery.fields.host.hint"),
                placeholder: en("connections.mqtt-discovery.fields.host.placeholder"),
                maxLength: 200
            },
            {
                key: "port",
                label: en("connections.mqtt-discovery.fields.port.label"),
                defaultValue: "1883",
                optional: true,
                maxLength: 5
            },
            {
                key: "username",
                label: en("connections.mqtt-discovery.fields.username.label"),
                optional: true,
                maxLength: 120
            },
            {
                key: "password",
                label: en("connections.mqtt-discovery.fields.password.label"),
                secret: true,
                optional: true,
                maxLength: 200
            },
            {
                key: "prefix",
                label: en("connections.mqtt-discovery.fields.prefix.label"),
                hint: en("connections.mqtt-discovery.fields.prefix.hint"),
                defaultValue: "homeassistant",
                optional: true,
                maxLength: 60
            }
        ],
        kinds: ["switch", "light", "lock"],
        search: [
            "mqtt",
            "zigbee",
            "zigbee2mqtt",
            "tasmota",
            "esphome",
            "shelly",
            "sonoff",
            "home assistant",
            "broker",
            "discovery",
            "local"
        ]
    },
    {
        id: "tuya-app",
        brand: "Tuya",
        logo: "tuya",
        label: en("connections.tuya-app.label"),
        reach: "anywhere",
        // A user code and a scan with the app the devices are already in,
        // against a developer project linked to the account by hand.
        recommended: true,
        summary: en("connections.tuya-app.summary"),
        note: en("connections.tuya-app.note"),
        steps: [
            en("connections.tuya-app.steps.s0"),
            en("connections.tuya-app.steps.s1"),
            en("connections.tuya-app.steps.s2")
        ],
        fields: [
            {
                key: "userCode",
                label: en("connections.tuya-app.fields.userCode.label"),
                hint: en("connections.tuya-app.fields.userCode.hint"),
                placeholder: en("connections.tuya-app.fields.userCode.placeholder"),
                maxLength: 64
            }
        ],
        // Tuya's SDK says nothing about how long a code lasts, and a scan that
        // is not confirmed answers the same as one that lapsed. Two minutes is
        // Polaris' own bound: long enough to find the phone, short enough that
        // a code left on a screen is not waited on for ever.
        pairing: { kind: "qr", pollMs: 3_000, lifetimeMs: 120_000 },
        kinds: ["switch", "outlet", "light", "climate"],
        search: [
            "smart life",
            "tuya smart",
            "qr",
            "scan",
            "app",
            "switch",
            "socket",
            "plug",
            "light",
            "bulb",
            "led",
            "smart plug",
            "wall switch"
        ]
    },
    {
        id: "tuya-cloud",
        brand: "Tuya",
        logo: "tuya",
        label: en("connections.tuya-cloud.label"),
        reach: "anywhere",
        summary: en("connections.tuya-cloud.summary"),
        note: en("connections.tuya-cloud.note"),
        steps: [
            en("connections.tuya-cloud.steps.s0"),
            en("connections.tuya-cloud.steps.s1"),
            en("connections.tuya-cloud.steps.s2")
        ],
        link: { label: en("connections.tuya-cloud.link"), href: TUYA_CONSOLE },
        fields: [
            {
                key: "accessId",
                label: en("connections.tuya-cloud.fields.accessId.label"),
                placeholder: en("connections.tuya-cloud.fields.accessId.placeholder"),
                minLength: 8,
                maxLength: 128
            },
            {
                key: "accessSecret",
                label: en("connections.tuya-cloud.fields.accessSecret.label"),
                placeholder: en("connections.tuya-cloud.fields.accessSecret.placeholder"),
                secret: true,
                minLength: 8,
                maxLength: 256
            },
            {
                key: "region",
                label: en("connections.tuya-cloud.fields.region.label"),
                hint: en("connections.tuya-cloud.fields.region.hint"),
                defaultValue: "eu",
                choices: TUYA_REGIONS.map((region) => ({
                    value: region.value,
                    label: region.label
                }))
            }
        ],
        kinds: ["switch", "outlet", "light", "climate"],
        search: [
            "smart life",
            "switch",
            "socket",
            "plug",
            "light",
            "bulb",
            "led",
            "smart plug",
            "wall switch"
        ]
    },
    // TP-Link: Tapo first. Every Tapo and every Kasa on current firmware answers
    // it, so it is the one that works for the most houses; the Kasa entry is for
    // the older plugs that need no account at all.
    {
        id: "tapo-local",
        brand: "TP-Link",
        recommended: true,
        logo: "tplink",
        label: en("connections.tapo-local.label"),
        reach: "same-network",
        summary: en("connections.tapo-local.summary"),
        note: en("connections.tapo-local.note"),
        steps: [
            en("connections.tapo-local.steps.s0"),
            en("connections.tapo-local.steps.s1"),
            en("connections.tapo-local.steps.s2")
        ],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.tapo-local.fields.host.label"),
                hint: en("connections.tapo-local.fields.host.hint"),
                placeholder: en("connections.tapo-local.fields.host.placeholder"),
                maxLength: 200
            },
            {
                key: "email",
                label: en("connections.tapo-local.fields.email.label"),
                placeholder: en("connections.tapo-local.fields.email.placeholder"),
                maxLength: 200
            },
            {
                key: "password",
                label: en("connections.tapo-local.fields.password.label"),
                secret: true,
                maxLength: 200
            }
        ],
        kinds: ["outlet", "switch", "light"],
        search: [
            "tapo",
            "kasa",
            "tplink",
            "smart plug",
            "power strip",
            "bulb",
            "p100",
            "p110",
            "p300",
            "l530",
            "local"
        ]
    },
    {
        id: "kasa-local",
        brand: "TP-Link",
        logo: "tplink",
        label: en("connections.kasa-local.label"),
        reach: "same-network",
        summary: en("connections.kasa-local.summary"),
        note: en("connections.kasa-local.note"),
        steps: [en("connections.kasa-local.steps.s0"), en("connections.kasa-local.steps.s1")],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.kasa-local.fields.host.label"),
                hint: en("connections.kasa-local.fields.host.hint"),
                placeholder: en("connections.kasa-local.fields.host.placeholder"),
                maxLength: 200
            },
            {
                key: "email",
                label: en("connections.kasa-local.fields.email.label"),
                hint: en("connections.kasa-local.fields.email.hint"),
                optional: true,
                maxLength: 200
            },
            {
                key: "password",
                label: en("connections.kasa-local.fields.password.label"),
                secret: true,
                optional: true,
                maxLength: 200
            }
        ],
        kinds: ["outlet", "switch", "light"],
        search: [
            "kasa",
            "tplink",
            "hs100",
            "hs110",
            "hs300",
            "kp115",
            "kl130",
            "smart plug",
            "power strip",
            "local"
        ]
    },
    // Shelly: its own local API is the one way in, and the best one - no account,
    // no cloud, and every generation answers it.
    {
        id: "shelly-local",
        brand: "Shelly",
        recommended: true,
        logo: "shelly",
        label: en("connections.shelly-local.label"),
        reach: "same-network",
        summary: en("connections.shelly-local.summary"),
        note: en("connections.shelly-local.note"),
        steps: [en("connections.shelly-local.steps.s0"), en("connections.shelly-local.steps.s1")],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.shelly-local.fields.host.label"),
                hint: en("connections.shelly-local.fields.host.hint"),
                placeholder: en("connections.shelly-local.fields.host.placeholder"),
                maxLength: 200
            },
            {
                key: "password",
                label: en("connections.shelly-local.fields.password.label"),
                hint: en("connections.shelly-local.fields.password.hint"),
                secret: true,
                optional: true,
                maxLength: 200
            },
            {
                key: "username",
                label: en("connections.shelly-local.fields.username.label"),
                hint: en("connections.shelly-local.fields.username.hint"),
                defaultValue: "admin",
                optional: true,
                maxLength: 50
            }
        ],
        kinds: ["switch", "outlet", "light"],
        search: [
            "shelly",
            "relay",
            "plug",
            "dimmer",
            "bulb",
            "plus",
            "pro",
            "gen3",
            "gen4",
            "local"
        ]
    },
    // Philips Hue: the bridge's local API is the most convenient and the most
    // stable way in - one button press, every light on the bridge, no cloud.
    // Pairing is inside the driver's verify, so it can later move to a pairing
    // screen without a second implementation.
    // Gree: local, like Home Assistant's own integration - no account and no
    // cloud. The units are found on the network, or at an address, and each one
    // is paired on the spot; its key is the credential.
    {
        id: "gree-local",
        brand: "Gree",
        recommended: true,
        logo: "gree",
        label: en("connections.gree-local.label"),
        reach: "same-network",
        summary: en("connections.gree-local.summary"),
        note: en("connections.gree-local.note"),
        steps: [en("connections.gree-local.steps.s0"), en("connections.gree-local.steps.s1")],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.gree-local.fields.host.label"),
                hint: en("connections.gree-local.fields.host.hint"),
                placeholder: en("connections.gree-local.fields.host.placeholder"),
                optional: true,
                maxLength: 200
            }
        ],
        kinds: ["climate"],
        discovery: true,
        search: [
            "gree",
            "gree+",
            "air conditioner",
            "aircon",
            "ac",
            "climate",
            "heat pump",
            "local"
        ]
    },
    // Philips air purifiers and humidifiers. Local stays the recommended way in:
    // it covers every model Home Assistant's Philips integration lists, needs no
    // account, and keeps working when Philips' servers do not. Units are found
    // on the network, or at an address; nothing is paired and no key is kept.
    {
        id: "philips-coap",
        brand: "Philips",
        recommended: true,
        logo: "philips",
        label: en("connections.philips-coap.label"),
        reach: "same-network",
        summary: en("connections.philips-coap.summary"),
        note: en("connections.philips-coap.note"),
        steps: [en("connections.philips-coap.steps.s0"), en("connections.philips-coap.steps.s1")],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.philips-coap.fields.host.label"),
                hint: en("connections.philips-coap.fields.host.hint"),
                placeholder: en("connections.philips-coap.fields.host.placeholder"),
                optional: true,
                maxLength: 200
            }
        ],
        kinds: ["air"],
        discovery: true,
        search: [
            "philips",
            "air+",
            "air plus",
            "clean home+",
            "air purifier",
            "purifier",
            "humidifier",
            "air quality",
            "local"
        ]
    },
    // The Philips account, the way the Air+ app reaches its purifiers: for a unit
    // on another network, and for the models whose firmware has no local
    // control. Second, not recommended: Philips publishes no API for it, so it
    // is the less reliable of the two over time, and it covers only the units
    // the community integrations have mapped (AC0650, AC0651, AC1715, AC3221).
    {
        id: "philips-cloud",
        brand: "Philips",
        logo: "philips",
        label: en("connections.philips-cloud.label"),
        reach: "anywhere",
        summary: en("connections.philips-cloud.summary"),
        note: en("connections.philips-cloud.note"),
        steps: [
            en("connections.philips-cloud.steps.s0"),
            en("connections.philips-cloud.steps.s1"),
            en("connections.philips-cloud.steps.s2")
        ],
        fields: [
            {
                key: "email",
                label: en("connections.philips-cloud.fields.email.label"),
                hint: en("connections.philips-cloud.fields.email.hint"),
                placeholder: en("connections.philips-cloud.fields.email.placeholder"),
                format: "email",
                maxLength: 254
            }
        ],
        // Philips says nothing about how long its emailed code lasts. Ten
        // minutes is Polaris' own bound: time to find the email, not a box left
        // waiting for ever. Nothing is polled; the code is sent once typed.
        //
        // The file is the Philips Air+ app itself, for the fan and heater cloud:
        // Polaris reads a signing value out of it and keeps nothing of the file
        // (`integrations/apk-secret.ts`). A whole app bundle is a few hundred
        // megabytes at most. The link is where the Air+ fan integration points
        // people for it (Yooork/HA_Philips_Air_Plus, README).
        pairing: {
            kind: "code",
            pollMs: 3_000,
            lifetimeMs: 600_000,
            file: {
                accept: ".apk,.apkm,.xapk",
                maxBytes: 600 * 1024 * 1024,
                href: "https://www.apkmirror.com/apk/versuni-netherlands-b-v/philips-air/"
            }
        },
        kinds: ["air", "appliance"],
        search: [
            "philips",
            "air+",
            "air plus",
            "versuni",
            "air purifier",
            "purifier",
            "air quality",
            "fan",
            "heater",
            "cx3550",
            "airfryer",
            "homeid",
            "nutriu",
            "espresso",
            "cloud",
            "account"
        ]
    },
    {
        id: "hue-bridge",
        brand: "Philips Hue",
        recommended: true,
        logo: "philipshue",
        label: en("connections.hue-bridge.label"),
        reach: "same-network",
        summary: en("connections.hue-bridge.summary"),
        note: en("connections.hue-bridge.note"),
        steps: [
            en("connections.hue-bridge.steps.s0"),
            en("connections.hue-bridge.steps.s1"),
            en("connections.hue-bridge.steps.s2")
        ],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.hue-bridge.fields.host.label"),
                hint: en("connections.hue-bridge.fields.host.hint"),
                placeholder: en("connections.hue-bridge.fields.host.placeholder"),
                maxLength: 200
            },
            {
                key: "appKey",
                label: en("connections.hue-bridge.fields.appKey.label"),
                hint: en("connections.hue-bridge.fields.appKey.hint"),
                secret: true,
                optional: true,
                maxLength: 100
            }
        ],
        kinds: ["light", "outlet"],
        search: [
            "hue",
            "philips",
            "signify",
            "bridge",
            "bulb",
            "light",
            "smart plug",
            "zigbee",
            "local"
        ]
    },
    // IKEA: the DIRIGERA hub's local API is the only way in with no cloud at all,
    // and the most convenient - one button press brings the whole hub. Pairing
    // is inside the driver's verify, ready for a shared pairing screen.
    {
        id: "dirigera-hub",
        brand: "IKEA",
        recommended: true,
        logo: "ikea",
        label: en("connections.dirigera-hub.label"),
        reach: "same-network",
        summary: en("connections.dirigera-hub.summary"),
        note: en("connections.dirigera-hub.note"),
        steps: [
            en("connections.dirigera-hub.steps.s0"),
            en("connections.dirigera-hub.steps.s1"),
            en("connections.dirigera-hub.steps.s2")
        ],
        fields: [
            {
                key: "host",
                address: true,
                label: en("connections.dirigera-hub.fields.host.label"),
                hint: en("connections.dirigera-hub.fields.host.hint"),
                placeholder: en("connections.dirigera-hub.fields.host.placeholder"),
                maxLength: 200
            }
        ],
        kinds: ["light", "outlet", "sensor"],
        search: [
            "ikea",
            "dirigera",
            "tradfri",
            "home smart",
            "hub",
            "bulb",
            "outlet",
            "zigbee",
            "local"
        ]
    },
    // Home Assistant: its REST API with a long-lived token is the one way in,
    // and the fastest to set up - one connection brings the whole house.
    {
        id: "home-assistant",
        brand: "Home Assistant",
        recommended: true,
        logo: "homeassistant",
        label: en("connections.home-assistant.label"),
        reach: "same-network",
        summary: en("connections.home-assistant.summary"),
        note: en("connections.home-assistant.note"),
        steps: [
            en("connections.home-assistant.steps.s0"),
            en("connections.home-assistant.steps.s1"),
            en("connections.home-assistant.steps.s2")
        ],
        fields: [
            {
                key: "url",
                address: true,
                label: en("connections.home-assistant.fields.url.label"),
                hint: en("connections.home-assistant.fields.url.hint"),
                placeholder: en("connections.home-assistant.fields.url.placeholder"),
                maxLength: 300
            },
            {
                key: "token",
                label: en("connections.home-assistant.fields.token.label"),
                placeholder: en("connections.home-assistant.fields.token.placeholder"),
                secret: true,
                minLength: 20,
                maxLength: 1000
            }
        ],
        kinds: ["switch", "outlet", "light", "lock", "sensor", "climate", "air"],
        search: [
            "home assistant",
            "hass",
            "homeassistant",
            "zigbee",
            "z-wave",
            "zwave",
            "local",
            "whole house"
        ]
    },
    // SwitchBot: their cloud API is the one documented way in, and the most
    // convenient - a token and a secret from the app, and every device on the
    // account arrives, including the Bluetooth ones behind a hub.
    {
        id: "switchbot-cloud",
        brand: "SwitchBot",
        recommended: true,
        logo: "switchbot",
        label: en("connections.switchbot-cloud.label"),
        reach: "anywhere",
        summary: en("connections.switchbot-cloud.summary"),
        note: en("connections.switchbot-cloud.note"),
        steps: [
            en("connections.switchbot-cloud.steps.s0"),
            en("connections.switchbot-cloud.steps.s1"),
            en("connections.switchbot-cloud.steps.s2")
        ],
        link: { label: en("connections.switchbot-cloud.link"), href: SWITCHBOT_API_DOCS },
        fields: [
            {
                key: "token",
                label: en("connections.switchbot-cloud.fields.token.label"),
                placeholder: en("connections.switchbot-cloud.fields.token.placeholder"),
                secret: true,
                minLength: 16,
                maxLength: 500
            },
            {
                key: "secret",
                label: en("connections.switchbot-cloud.fields.secret.label"),
                placeholder: en("connections.switchbot-cloud.fields.secret.placeholder"),
                secret: true,
                minLength: 8,
                maxLength: 500
            }
        ],
        kinds: ["outlet", "switch", "lock", "light", "sensor"],
        search: [
            "switchbot",
            "switch bot",
            "bot",
            "smart lock",
            "plug mini",
            "meter",
            "contact sensor",
            "curtain"
        ]
    }
];

export function deviceConnection(id: string): DeviceConnection | null {
    return DEVICE_CONNECTIONS.find((connection) => connection.id === id) ?? null;
}

/** One make, as the picker draws it: its name, its mark, and how many ways in it
 *  has - a make with two is worth saying so before it is opened. */
export interface DeviceBrand {
    readonly brand: string;
    readonly logo: string;
    readonly count: number;
    /** What it can bring in, across all its ways in, so a row can say "switches
     *  and sockets" before anything is typed. */
    readonly kinds: readonly DeviceKind[];
}

/** The brands, in the order their first connection appears. */
export function deviceBrands(): readonly DeviceBrand[] {
    const brands = new Map<
        string,
        { brand: string; logo: string; count: number; kinds: DeviceKind[] }
    >();
    for (const connection of DEVICE_CONNECTIONS) {
        const held = brands.get(connection.brand);
        if (held) {
            held.count += 1;
            for (const kind of connection.kinds)
                if (!held.kinds.includes(kind)) held.kinds.push(kind);
            continue;
        }
        brands.set(connection.brand, {
            brand: connection.brand,
            logo: connection.logo,
            count: 1,
            kinds: [...connection.kinds]
        });
    }
    return [...brands.values()];
}

export function connectionsOfBrand(brand: string): readonly DeviceConnection[] {
    return DEVICE_CONNECTIONS.filter((connection) => connection.brand === brand);
}

/** The way in a brand's picker starts on: its recommended one, or its first
 *  where none is marked. */
export function recommendedConnection(brand: string): DeviceConnection | null {
    const ofBrand = connectionsOfBrand(brand);
    return ofBrand.find((connection) => connection.recommended === true) ?? ofBrand[0] ?? null;
}

/**
 * What somebody typed, against everything worth matching.
 *
 * The brand, the name of the method, and the words its owner would use for it -
 * "smart lock" has to find Nuki, because nobody thinks of what they bought by the
 * name of its API.
 */
export function searchConnections(query: string): readonly DeviceConnection[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return DEVICE_CONNECTIONS;
    return DEVICE_CONNECTIONS.filter((connection) =>
        [connection.brand, connection.label, ...(connection.search ?? [])]
            .join(" ")
            .toLowerCase()
            .includes(needle)
    );
}

/** The fields of a connection that may be shown again once it is stored. What is
 *  left is the credential, and there is no screen anywhere that reads one back. */
export function shownFields(connection: DeviceConnection): readonly ConnectionField[] {
    return connection.fields.filter((field) => field.secret !== true);
}

/**
 * What is wrong with one field, or nothing.
 *
 * An empty required field is not "invalid" - it is unfinished, and saying "that
 * does not look like a token" over a box nobody has typed in yet is telling
 * somebody off for not having finished. So emptiness is left to the submit button
 * being unavailable, and this only ever complains about something actually typed.
 */
export function fieldIssue(
    field: ConnectionField,
    value: string,
    t: PlacesTranslator = en,
    label: string = field.label,
    /** The field is being given a MAC rather than an IP or a name. */
    asMac = false
): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (field.address === true && asMac) {
        const issue = macIssue(trimmed);
        if (issue === "short") return t("connections.macShort");
        if (issue === "reserved") return t("connections.macReserved");
        return null;
    }
    if (field.minLength !== undefined && trimmed.length < field.minLength) {
        return t("connections.tooShort", { field: label.toLowerCase() });
    }
    if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
        return t("connections.tooLong", { field: label.toLowerCase() });
    }
    if (field.choices && !field.choices.some((choice) => choice.value === trimmed)) {
        return t("connections.pickListed");
    }
    // The same check every other email box in Polaris uses: a stray comma or a
    // space left over from a paste is a different address to a sign-in service.
    if (field.format === "email" && !emailField.safeParse(trimmed).success) {
        return t("connections.notEmail");
    }
    return null;
}

/** Whether everything a connection needs has been given, and given validly. The
 *  same answer on the client, where it decides whether the button is available,
 *  and on the server, where it decides whether anything is stored. */
export function fieldsComplete(
    connection: DeviceConnection,
    fields: Readonly<Record<string, string>>,
    /** The address fields being given a MAC, which only the form knows while
     *  one is half typed. A whole MAC is recognised without it. */
    macKeys: readonly string[] = []
): boolean {
    return connection.fields.every((field) => {
        const value = (fields[field.key] ?? field.defaultValue ?? "").trim();
        if (!value) return field.optional === true;
        return fieldIssue(field, value, en, field.label, macKeys.includes(field.key)) === null;
    });
}

/** One field's value in its stored form: trimmed, and an address lowercased so
 *  it has one form whatever case it was typed in. The dialog and the server
 *  both run a value through this. */
export function normalizeField(field: ConnectionField, raw: unknown): string {
    const typed = (typeof raw === "string" ? raw : "").trim();
    return field.format === "email" ? typed.toLowerCase() : typed;
}

/** The MAC an address field holds, as `AA:BB:CC:DD:EE:FF`, or null when it holds
 *  an IP address or a name (or is not an address field at all). */
export function fieldMac(field: ConnectionField, value: string | undefined): string | null {
    return field.address === true ? parseMac(value) : null;
}

/**
 * The fields as they should be stored: trimmed, defaults filled in, and nothing
 * the connection did not ask for.
 *
 * The last part is the one that matters. What arrives is somebody else's object,
 * and a driver reads what it is handed by name - so anything not on the
 * connection's own list is dropped here rather than encrypted and kept forever.
 */
export function normalizeFields(
    connection: DeviceConnection,
    fields: Readonly<Record<string, unknown>>
): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const field of connection.fields) {
        const value = normalizeField(field, fields[field.key]) || field.defaultValue || "";
        // A MAC is kept in one spelling, whichever one it was typed in.
        if (value) clean[field.key] = fieldMac(field, value) ?? value;
    }
    return clean;
}

/**
 * A connection's words in the reader's language. The data above carries the
 * English, for the server and for search; a screen draws these.
 */
export function connectionWords(t: PlacesTranslator, connection: DeviceConnection) {
    const base = `connections.${connection.id}`;
    const say = (key: string) => (t.has(key) ? t(key as PlacesKey) : undefined);
    return {
        brand:
            connection.brand === en("connections.brandMqtt")
                ? t("connections.brandMqtt")
                : connection.brand,
        label: say(`${base}.label`) ?? connection.label,
        summary: say(`${base}.summary`) ?? connection.summary,
        note: say(`${base}.note`) ?? connection.note,
        steps: (connection.steps ?? []).map(
            (step, index) => say(`${base}.steps.s${index}`) ?? step
        ),
        link: connection.link
            ? { ...connection.link, label: say(`${base}.link`) ?? connection.link.label }
            : undefined,
        reach: t(`connections.reach.${connection.reach}`),
        pairingPrompt: connection.pairing ? say(`${base}.pairing.prompt`) : undefined,
        pairingFile: connection.pairing?.file
            ? {
                  title: say(`${base}.pairing.file.title`) ?? "",
                  why: (summary: string) =>
                      t.has(`${base}.pairing.file.why`)
                          ? t(`${base}.pairing.file.why` as PlacesKey, { summary })
                          : "",
                  where: say(`${base}.pairing.file.where`) ?? "",
                  link: say(`${base}.pairing.file.link`) ?? "",
                  field: say(`${base}.pairing.file.field`) ?? "",
                  skip: say(`${base}.pairing.file.skip`) ?? ""
              }
            : undefined
    };
}

/** One field's words in the reader's language. */
export function fieldWords(
    t: PlacesTranslator,
    connection: DeviceConnection,
    field: ConnectionField
) {
    const base = `connections.${connection.id}.fields.${field.key}`;
    const say = (key: string) => (t.has(key) ? t(key as PlacesKey) : undefined);
    return {
        label: say(`${base}.label`) ?? field.label,
        hint: field.hint ? (say(`${base}.hint`) ?? field.hint) : undefined,
        placeholder: field.placeholder
            ? (say(`${base}.placeholder`) ?? field.placeholder)
            : undefined,
        choices: field.choices?.map((choice) => ({
            value: choice.value,
            label: say(`connections.regions.${choice.value}`) ?? choice.label
        }))
    };
}
