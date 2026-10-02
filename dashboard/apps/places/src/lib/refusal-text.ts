/**
 * A refusal from Places, in the reader's language.
 *
 * The services under `lib` refuse in English - a `HomeError`, a driver's or an
 * integration's own error - because the same sentences land in the log, in a
 * device's history and on an account that stopped answering, where nobody is
 * reading in a language. The screen is where somebody is, so the action that
 * catches one, and the screen that shows one stored earlier, hand it through
 * here: the sentences Places writes itself come back from the catalog, and
 * anything else - a camera's, a hub's or a cloud's own words - passes through as
 * it came.
 *
 * Pure and catalog-only, so an action and a screen use it alike.
 * `test/home/places-refusal-text.test.ts` holds every sentence thrown under
 * `lib` to having an entry.
 */

import type { PlacesTranslator } from "./i18n";
import { englishPlaces, type PlacesKey } from "../../messages";
import { philipsWhereInWords } from "./integrations/philips-regions";
import { DEVICE_ACTION_VERBS, DEVICE_KIND_LABELS } from "./device-kinds";
import {
    PHILIPS_GARBLED,
    PHILIPS_LOCAL_OFF,
    PHILIPS_QUIET,
    PHILIPS_REFUSED
} from "./integrations/philips-sentences";

/** Sentences with nothing to fill in, by their English. */
const EXACT: ReadonlyMap<string, PlacesKey> = new Map<string, PlacesKey>([
    ["Home is not set up yet", "refusals.notSetUp"],
    ["You do not have access to that", "refusals.noAccess"],
    ["Give it a name", "refusals.giveName"],
    ["Choose what it should tell you about", "refusals.chooseKinds"],
    ["Choose who to tell", "refusals.chooseWho"],
    ["Alert not found", "refusals.alertGone"],
    ["Camera not found", "refusals.cameraGone"],
    ["An area on this camera is already called that.", "refusals.areaTaken"],
    ["Area not found", "refusals.areaGone"],
    [
        "That connection was made by a version of Polaris that is no longer here",
        "refusals.oldConnection"
    ],
    ["That connection is not here", "refusals.connectionGone"],
    ["Polaris cannot connect that yet", "refusals.cannotConnect"],
    ["That device is not here", "refusals.deviceGone"],
    ["That connection is missing the broker's address", "refusals.noBroker"],
    ["That device cannot be told to do that", "refusals.deviceCannot"],
    ["A Nuki device cannot be told to do that", "refusals.nukiCannot"],
    ["That connection is missing its token", "refusals.noToken"],
    ["That connection is missing its keys", "refusals.noKeys"],
    ["A Tuya device cannot be told to do that", "refusals.tuyaCannot"],
    ["The relay did not answer.", "refusals.relayQuiet2"],
    [
        "The camera accepted the connection and sent no video. The commonest cause by far is the password: on a Tapo it is the one for your TP-Link account, not one set on the camera. After that, Third-Party Compatibility being off in the Tapo app under Me > Third-Party Services - and on a battery model, the camera going back to sleep.",
        "refusals.relayNoVideo"
    ],
    [
        "The camera refused the password. It is the one for your TP-Link account - the one you sign into the Tapo app with - and not one set on the camera. If that is what you typed, check Third-Party Compatibility is on in the Tapo app, under Me > Third-Party Services.",
        "refusals.relayPassword"
    ],
    [
        "The camera refused the connection outright. Its account may not be allowed to stream, or another app is holding the one connection it gives.",
        "refusals.relayRefusedOutright"
    ],
    [
        "The camera has no stream at that address. If it is a make with a stream path, the path is wrong; if it is one that picks by quality, it may publish only its full-size stream.",
        "refusals.relayNoStream"
    ],
    [
        "The camera stopped answering partway through. On a battery model that is it going back to sleep; otherwise it is the network between here and it.",
        "refusals.relayStopped"
    ],
    [
        "The camera is sending something the relay cannot read. That is usually a codec this relay does not carry yet.",
        "refusals.relayCodec"
    ],
    ["Where is the camera?", "refusals.schemaWhere"],
    ["Just the address: no slashes, spaces or credentials", "refusals.schemaAddress"],
    ["Choose where this camera is reached from", "refusals.schemaReach"],
    ["Choose where detection should run", "refusals.schemaRunsOn"],
    ["Give the area a name", "refusals.schemaAreaName"],
    ["An area needs at least three corners", "refusals.schemaCorners"],
    ["That is more corners than an area needs", "refusals.schemaTooManyCorners"],
    ["Unknown place", "refusals.schemaPlace"],
    ["Unknown camera", "refusals.schemaCamera"],
    ["Unknown person", "refusals.schemaPerson"],
    ["Write it as 192.168.1.0/24", "refusals.schemaSubnet"],
    ["Pick how to connect it", "refusals.schemaConnect"],
    ["Event not found", "refusals.eventGone"],
    ["Give them a name", "refusals.giveThemName"],
    ["Not found", "refusals.notFound"],
    ["Face recognition is not set up yet", "refusals.noFaces"],
    ["The recognizer would not take that photograph", "refusals.photoRefused"],
    ["The recognizer would not forget them, so nothing was removed", "refusals.forgetRefused"],
    ["Place not found", "refusals.placeGone"],
    ["That automation is not here", "refusals.automationGone"],
    ["That automation was saved by a newer Polaris", "refusals.automationNewer"],
    ["That automation names something that is not here", "refusals.automationNames"],
    ["Move or remove its cameras first", "refusals.moveCameras"],
    ["There has to be somewhere for cameras to be", "refusals.lastPlace"],
    ["This camera does not move", "refusals.noPtz"],
    ["Home is not installed", "refusals.notInstalled"],
    ["The recognizer was installed but cannot be found", "refusals.recognizerMissing"],
    ["Write the address as http://192.168.1.20:8000", "refusals.recognizerAddress"],
    ["Clip not found", "refusals.clipGone"],
    ["The camera relay was installed but is not answering yet", "refusals.relayQuiet"],
    ["The relay would not accept that camera", "refusals.relayRefused"],
    ["That camera is not shared with you", "refusals.cameraNotShared"],
    ["You cannot operate that from here", "refusals.cannotOperate"],
    ["That device is not shared with you", "refusals.deviceNotShared"],
    ["That server is not connected", "refusals.serverNotConnected"],
    ["That did not work. Nothing was changed.", "refusals.failed"],
    ["That device is no longer announcing itself on the broker", "refusals.deviceSilent"],
    ["That device published no way to work it", "refusals.noCommand"],
    ["The broker refused those credentials.", "refusals.brokerCredentials"],
    ["That address could not be found on this network.", "refusals.addressUnknown"],
    ["Nothing answered on that address and port.", "refusals.nothingAnswered"],
    ["The broker could not be reached.", "refusals.brokerUnreachable"],
    ["The broker would not let Polaris read that.", "refusals.brokerRead"],
    ["The broker would not take that command.", "refusals.brokerCommand"],
    ["Nuki could not be reached. Try again in a moment.", "refusals.nukiUnreachable"],
    ["Nuki refused the token. It may have been revoked.", "refusals.nukiToken"],
    ["Nuki is answering too many requests at once. Try again in a minute.", "refusals.nukiRate"],
    ["Nuki answered with something unexpected.", "refusals.nukiOdd"],
    ["Tuya could not be reached. Try again in a moment.", "refusals.tuyaUnreachable"],
    ["Tuya answered with something unexpected.", "refusals.tuyaOdd"],
    [
        "Tuya refused the keys. They may have been revoked, or the project may not cover these devices.",
        "refusals.tuyaKeys"
    ],
    ["Tuya refused the request.", "refusals.tuyaRefused"],
    ["That connection is missing its sign-in", "refusals.noSignIn"],
    [
        "Tuya no longer accepts this sign-in. Scan a new code from the app.",
        "refusals.tuyaSignedOut"
    ],
    [
        "Tuya refused the User Code. Check it in the app under Me, Settings, Account and Security.",
        "refusals.tuyaUserCode"
    ],
    ["The device did not answer in time.", "refusals.deviceSlow"],
    [
        "The device's certificate is not one Polaris can trust, so nothing was sent to it.",
        "refusals.deviceCertificate"
    ],
    [
        "The device at that address is not the one Polaris was connected to. Connect it again.",
        "refusals.deviceSwapped"
    ],
    ["The device answered with far more than Polaris reads from one.", "refusals.deviceTooMuch"],
    ["The device could not be reached.", "refusals.deviceUnreachable"],
    ["That connection is missing the device's address", "refusals.noDeviceAddress"],
    ["The device answered with something unexpected.", "refusals.deviceOdd"],
    ["The device refused the request.", "refusals.deviceRefused"],
    [
        "The device would not accept that TP-Link account. Use the email and password you sign into the Tapo or Kasa app with.",
        "refusals.tplinkAccount"
    ],
    [
        "That TP-Link device is not a plug, a switch or a bulb, so there is nothing here to control.",
        "refusals.tplinkNothing"
    ],
    ["A TP-Link device cannot be told to do that", "refusals.tplinkCannot"],
    ["Write the address as 192.168.1.30, with no path", "refusals.addressNoPath"],
    [
        "Polaris does not connect to that address. Use the device's address on your network, such as 192.168.1.30.",
        "refusals.addressForbidden"
    ],
    ["That address answered, but not as a Shelly.", "refusals.shellyNot"],
    [
        "The Shelly refused the password. It is the one set in the Shelly app under the device's authentication settings.",
        "refusals.shellyPassword"
    ],
    ["This Shelly has a password. Add it to the connection.", "refusals.shellyNeedsPassword"],
    [
        "The Shelly is refusing requests for a while after too many wrong passwords.",
        "refusals.shellyThrottled"
    ],
    [
        "That Shelly has no relay or light to control. Blinds and meters are not something Polaris can operate yet.",
        "refusals.shellyNothing"
    ],
    ["A Shelly cannot be told to do that", "refusals.shellyCannot"],
    ["That device is no longer on this Shelly.", "refusals.shellyChannelGone"],
    [
        "The Hue bridge no longer accepts Polaris. Connect it again, pressing the button on the bridge first.",
        "refusals.hueKey"
    ],
    [
        "That address did not answer with a Hue bridge certificate. Check the address, and update the bridge in the Hue app if it is an old one.",
        "refusals.hueNotBridge"
    ],
    [
        "Press the link button on the Hue bridge, then select Connect within 30 seconds.",
        "refusals.huePress"
    ],
    ["The Hue bridge would not pair with Polaris.", "refusals.hueNoPair"],
    ["The Hue bridge is busy. Try again in a moment.", "refusals.hueBusy"],
    ["The Hue bridge refused the request.", "refusals.hueRefused"],
    ["A Hue light cannot be told to do that", "refusals.hueCannot"],
    ["That address did not answer as a DIRIGERA hub.", "refusals.dirigeraNot"],
    ["The DIRIGERA hub would not pair with Polaris.", "refusals.dirigeraNoPair"],
    [
        "The hub's action button was not pressed in time. Select Connect, then press the action button on the hub within a minute.",
        "refusals.dirigeraPress"
    ],
    [
        "The DIRIGERA hub no longer accepts Polaris. Connect it again and press the hub's button.",
        "refusals.dirigeraToken"
    ],
    ["The DIRIGERA hub refused the request.", "refusals.dirigeraRefused"],
    ["An IKEA device cannot be told to do that", "refusals.ikeaCannot"],
    ["Write the address as http://homeassistant.local:8123, with no path", "refusals.haAddress"],
    [
        "Home Assistant refused the token. Make a new long-lived access token on your Home Assistant profile page.",
        "refusals.haToken"
    ],
    ["That address answered, but not as Home Assistant.", "refusals.haNot"],
    ["Home Assistant is restarting. Try again in a moment.", "refusals.haRestarting"],
    ["Home Assistant would not do that. The device may not support it.", "refusals.haUnsupported"],
    ["Home Assistant refused the request.", "refusals.haRefused"],
    [
        "Home Assistant has no switches, lights, locks or sensors for Polaris to show.",
        "refusals.haNothing"
    ],
    [
        "SwitchBot refused the token and secret. They may have been reset in the app, or today's allowance of requests is used up.",
        "refusals.switchbotKeys"
    ],
    ["SwitchBot could not be reached. Try again in a moment.", "refusals.switchbotUnreachable"],
    [
        "SwitchBot is answering too many requests at once. Try again in a minute.",
        "refusals.switchbotRate"
    ],
    ["SwitchBot answered with something unexpected.", "refusals.switchbotOdd"],
    ["The device is not answering SwitchBot right now.", "refusals.switchbotOffline"],
    ["SwitchBot refused the request.", "refusals.switchbotRefused"],
    ["A SwitchBot device cannot be told to do that", "refusals.switchbotCannot"],
    ["Say what to set it to", "refusals.climateNoSetting"],
    ["That device has not said what it can be set to yet", "refusals.climateUnknown"],
    ["That mode is not one this device has", "refusals.climateMode"],
    ["That temperature is not one this device accepts", "refusals.climateTemperature"],
    ["That fan speed is not one this device has", "refusals.climateFan"],
    ["That setting is not one this device has", "refusals.climateOption"],
    ["This device takes a range rather than one temperature", "refusals.climateRange"],
    ["That device does not humidify", "refusals.airNoHumidity"],
    ["That humidity is not one this device accepts", "refusals.airHumidity"],
    ["The air conditioner did not answer.", "refusals.greeQuiet"],
    ["The air conditioner refused that.", "refusals.greeRefused"],
    [
        "Polaris is not paired with these air conditioners any more. Connect them again.",
        "refusals.greeUnpaired"
    ],
    [
        "No Gree air conditioner answered at that address. Check it is switched on at the wall and on the same network as Polaris.",
        "refusals.greeNoneThere"
    ],
    [
        "No Gree air conditioner answered on this network. Type the unit's IP or MAC address instead: the Gree+ app shows its MAC.",
        "refusals.greeNoneFound"
    ],
    [
        "The air conditioner answered but would not pair. Switch it off at the wall for a minute and try again.",
        "refusals.greeNoPair"
    ],
    [PHILIPS_QUIET, "refusals.philipsQuiet"],
    [PHILIPS_LOCAL_OFF, "refusals.philipsLocalOff"],
    [PHILIPS_GARBLED, "refusals.philipsGarbled"],
    [PHILIPS_REFUSED, "refusals.philipsRefused"],
    ["Polaris has lost track of these air purifiers. Connect them again.", "refusals.philipsLost"],
    [
        "No Philips air purifier answered at that address. Check it is switched on and on the same network as Polaris.",
        "refusals.philipsNoneThere"
    ],
    [
        "No Philips air purifier answered on this network. Type the unit's IP or MAC address instead: your router lists both among its connected devices.",
        "refusals.philipsNoneFound"
    ],
    [
        "The air purifiers on this network said who they are but would not answer a read. Switch them off and on again and try once more.",
        "refusals.philipsNoRead"
    ],
    ["Philips' cloud could not be reached.", "refusals.philipsCloudUnreachable"],
    ["Philips' cloud answered in a way Polaris could not read.", "refusals.philipsCloudGarbled"],
    [
        "Philips no longer accepts this sign-in. Connect the account again.",
        "refusals.philipsCloudSignedOut"
    ],
    [
        "Philips did not send a code to that address. Check it is the one you sign in to the Air+ app with.",
        "refusals.philipsCloudNoCode"
    ],
    [
        "That address is not a finished Philips account yet. Sign in once in the Philips Air+ app, then try again.",
        "refusals.philipsCloudUnfinished"
    ],
    ["That code is not right or has expired. Ask for a new one.", "refusals.philipsCloudBadCode"],
    [
        "Philips did not accept the code. Check it, or ask for a new one.",
        "refusals.philipsCloudBadCode"
    ],
    ["The device did not answer through Philips' cloud.", "refusals.philipsCloudQuiet"],
    ["The device is busy. Try again in a moment.", "refusals.philipsCloudBusy"],
    [
        "Philips' cloud would not let Polaris reach this device. Connect the account again.",
        "refusals.philipsCloudLinkRefused"
    ],
    ["That device is not on this Philips account.", "refusals.philipsCloudNotOnAccount"],
    ["Enter the code from the email", "refusals.philipsCloudEnterCode"],
    [
        "Philips' fan and heater cloud refused the sign-in. Upload the Philips Air+ app again.",
        "refusals.airMattersRefused"
    ],
    [
        "That file is not an app file. Upload the Philips Air+ app as an .apk, .apkm or .xapk file.",
        "refusals.apkNotAnApp"
    ],
    [
        "Polaris could not find what it needs in that file. Upload the whole Philips Air+ app, not a split or language part of it.",
        "refusals.apkNoSecret"
    ],
    [
        "That file holds more than one candidate, so Polaris cannot tell which one Philips uses. Upload the Philips Air+ app itself.",
        "refusals.apkAmbiguous"
    ],
    ["That step took too long and has run out. Start connecting again.", "refusals.pairingRanOut"],
    ["Upload the Philips Air+ app file to go on", "refusals.uploadToGoOn"]
]);

/** The words `devices.actOnDevice` builds its refusal from, back to their ids. */
const KIND_BY_WORD = new Map(
    Object.entries(DEVICE_KIND_LABELS).map(([kind, label]) => [label.toLowerCase(), kind])
);
const ACTION_BY_VERB = new Map(
    Object.entries(DEVICE_ACTION_VERBS).map(([action, verb]) => [verb, action])
);

/** Sentences that carry values, by the shape of their English. `words` puts a
 *  value written in English - a country, a part of the world - back into the
 *  reader's language. */
const SHAPED: readonly {
    readonly pattern: RegExp;
    readonly key: PlacesKey;
    readonly params: readonly string[];
    readonly words?: (
        t: PlacesTranslator,
        values: Record<string, string>
    ) => Record<string, string>;
}[] = [
    { pattern: /^(.+) has to be connected again$/s, key: "refusals.reconnect", params: ["name"] },
    {
        // `macNotFound` in driver-addresses.ts.
        pattern:
            /^Nothing on this network answers as ([0-9A-F:]{17})\. Check the device is switched on and on the same network as Polaris, or type its IP address instead\.$/,
        key: "refusals.macNotFound",
        params: ["mac"]
    },
    {
        pattern:
            /^Polaris found no device on this Philips account\. It asked Philips' servers for (.+) \((.+)\) and every other region it knows\. What it saw: (.+)\. Check that the device is in a Philips app under this same email\.( Philips' HomeID service failed on this account; if the device is in the HomeID app, remove it there and add it again\.)?$/s,
        key: "refusals.philipsCloudNothing",
        params: ["country", "area", "summary", "homeid"],
        words: (t, values) => ({
            ...values,
            ...philipsWhereInWords(t, englishPlaces, values.country ?? "", values.area ?? ""),
            homeid: values.homeid ? "yes" : "no"
        })
    },
    {
        pattern:
            /^Philips did not send a code to that address\. Check it is the one you sign in to the Air\+ app with\. Philips said: (.+)\.$/s,
        key: "refusals.philipsCloudNoCodeSaid",
        params: ["said"]
    },
    {
        pattern:
            /^Philips did not accept the code\. Check it, or ask for a new one\. Philips said: (.+)\.$/s,
        key: "refusals.philipsCloudBadCodeSaid",
        params: ["said"]
    },
    {
        pattern: /^(.+) is set to be watched, not operated$/s,
        key: "refusals.watchOnly",
        params: ["name"]
    },
    {
        pattern: /^(.+) is not connected to anything$/s,
        key: "refusals.notConnected",
        params: ["name"]
    },
    {
        pattern: /^(.+) was not answering when it was last checked$/s,
        key: "refusals.notAnswering",
        params: ["name"]
    },
    {
        pattern:
            /^Nothing on that broker is announcing itself under "(.*)"\. Check that discovery is switched on in whatever publishes your devices, and that it uses this prefix\.$/s,
        key: "refusals.nothingUnderPrefix",
        params: ["prefix"]
    },
    {
        pattern:
            /^Nothing on that broker is publishing as a Nuki device under "(.*)"\. Check that MQTT is switched on in the Nuki app and pointed at this broker\.$/s,
        key: "refusals.noNukiUnderPrefix",
        params: ["prefix"]
    },
    {
        pattern: /^Nuki refused the request \(HTTP (\d+)\)\.$/,
        key: "refusals.nukiHttp",
        params: ["status"]
    },
    {
        pattern: /^Tuya refused the keys: (.+)\.$/s,
        key: "refusals.tuyaKeysBecause",
        params: ["detail"]
    },
    {
        pattern: /^Tuya refused the request: (.+)\.$/s,
        key: "refusals.tuyaRefusedBecause",
        params: ["detail"]
    },
    {
        pattern: /^Tuya refused the User Code: (.+)\.$/s,
        key: "refusals.tuyaUserCodeBecause",
        params: ["detail"]
    },
    {
        pattern: /^(.+) could not be reached$/s,
        key: "refusals.accountUnreachable",
        params: ["name"]
    },
    {
        pattern: /^The relay refused it \((\d+)\)\.$/,
        key: "refusals.relayStatus",
        params: ["status"]
    }
];

/** The outage headlines `reachability` writes into an event's label. */
const OUTAGES: readonly {
    readonly pattern: RegExp;
    readonly key: PlacesKey;
    readonly params: readonly string[];
}[] = [
    {
        pattern: /^Every camera(?: at (.+))? stopped answering$/s,
        key: "outage.every",
        params: ["place"]
    },
    {
        pattern: /^(.+) stopped answering - the only one of (\d+)(?: at (.+))?$/s,
        key: "outage.only",
        params: ["camera", "total", "place"]
    },
    {
        pattern: /^(.+) stopped answering - (\d+) of (\d+)(?: at (.+))? have$/s,
        key: "outage.some",
        params: ["camera", "down", "total", "place"]
    },
    { pattern: /^(.+) stopped answering$/s, key: "outage.one", params: ["camera"] }
];

export function placesRefusalText(t: PlacesTranslator, message: string): string {
    const key = EXACT.get(message);
    if (key) return t(key);
    const cannot = /^A (.+) cannot be told to (.+)$/.exec(message);
    const kind = cannot ? KIND_BY_WORD.get(cannot[1] ?? "") : undefined;
    const action = cannot ? ACTION_BY_VERB.get(cannot[2] ?? "") : undefined;
    // An ICU selector cannot hold a hyphen, so "turn-on" is asked as "turnOn".
    if (kind && action)
        return t("refusals.kindCannot", {
            kind,
            action: action.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
        });
    for (const { pattern, key: shaped, params } of OUTAGES) {
        const found = pattern.exec(message);
        if (!found) continue;
        const values: Record<string, string | number> = {};
        params.forEach((name, index) => {
            const value = found[index + 1];
            values[name] =
                name === "place"
                    ? (value ?? "")
                    : /^\d+$/.test(value ?? "")
                      ? Number(value)
                      : (value ?? "");
        });
        values.hasPlace = values.place ? "yes" : "no";
        return t(shaped, values);
    }
    for (const { pattern, key: shaped, params, words } of SHAPED) {
        const found = pattern.exec(message);
        if (!found) continue;
        const values: Record<string, string> = Object.fromEntries(
            params.map((name, index) => [name, found[index + 1] ?? ""])
        );
        return t(shaped, words ? words(t, values) : values);
    }
    return message;
}

/** Every sentence the table knows, for the test that holds each thrown one to it. */
export const KNOWN_PLACES_REFUSALS: readonly string[] = [...EXACT.keys()];
