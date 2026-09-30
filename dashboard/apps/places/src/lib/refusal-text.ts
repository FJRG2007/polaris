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
import type { PlacesKey } from "../../messages";
import { DEVICE_ACTION_VERBS, DEVICE_KIND_LABELS } from "./device-kinds";

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
    ["That connection was made by a version of Polaris that is no longer here", "refusals.oldConnection"],
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
    ["The camera accepted the connection and sent no video. The commonest cause by far is the password: on a Tapo it is the one for your TP-Link account, not one set on the camera. After that, Third-Party Compatibility being off in the Tapo app under Me > Third-Party Services - and on a battery model, the camera going back to sleep.", "refusals.relayNoVideo"],
    ["The camera refused the password. It is the one for your TP-Link account - the one you sign into the Tapo app with - and not one set on the camera. If that is what you typed, check Third-Party Compatibility is on in the Tapo app, under Me > Third-Party Services.", "refusals.relayPassword"],
    ["The camera refused the connection outright. Its account may not be allowed to stream, or another app is holding the one connection it gives.", "refusals.relayRefusedOutright"],
    ["The camera has no stream at that address. If it is a make with a stream path, the path is wrong; if it is one that picks by quality, it may publish only its full-size stream.", "refusals.relayNoStream"],
    ["The camera stopped answering partway through. On a battery model that is it going back to sleep; otherwise it is the network between here and it.", "refusals.relayStopped"],
    ["The camera is sending something the relay cannot read. That is usually a codec this relay does not carry yet.", "refusals.relayCodec"],
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
    ["Tuya refused the keys. They may have been revoked, or the project may not cover these devices.", "refusals.tuyaKeys"],
    ["Tuya refused the request.", "refusals.tuyaRefused"],
]);

/** The words `devices.actOnDevice` builds its refusal from, back to their ids. */
const KIND_BY_WORD = new Map(Object.entries(DEVICE_KIND_LABELS).map(([kind, label]) => [label.toLowerCase(), kind]));
const ACTION_BY_VERB = new Map(Object.entries(DEVICE_ACTION_VERBS).map(([action, verb]) => [verb, action]));

/** Sentences that carry values, by the shape of their English. */
const SHAPED: readonly { readonly pattern: RegExp; readonly key: PlacesKey; readonly params: readonly string[] }[] = [
    { pattern: /^(.+) has to be connected again$/s, key: "refusals.reconnect", params: ["name"] },
    { pattern: /^(.+) is set to be watched, not operated$/s, key: "refusals.watchOnly", params: ["name"] },
    { pattern: /^(.+) is not connected to anything$/s, key: "refusals.notConnected", params: ["name"] },
    {
        pattern: /^(.+) was not answering when it was last checked$/s,
        key: "refusals.notAnswering",
        params: ["name"]
    },
    {
        pattern: /^Nothing on that broker is announcing itself under "(.*)"\. Check that discovery is switched on in whatever publishes your devices, and that it uses this prefix\.$/s,
        key: "refusals.nothingUnderPrefix",
        params: ["prefix"]
    },
    {
        pattern: /^Nothing on that broker is publishing as a Nuki device under "(.*)"\. Check that MQTT is switched on in the Nuki app and pointed at this broker\.$/s,
        key: "refusals.noNukiUnderPrefix",
        params: ["prefix"]
    },
    { pattern: /^Nuki refused the request \(HTTP (\d+)\)\.$/, key: "refusals.nukiHttp", params: ["status"] },
    { pattern: /^Tuya refused the keys: (.+)\.$/s, key: "refusals.tuyaKeysBecause", params: ["detail"] },
    { pattern: /^Tuya refused the request: (.+)\.$/s, key: "refusals.tuyaRefusedBecause", params: ["detail"] },
    { pattern: /^(.+) could not be reached$/s, key: "refusals.accountUnreachable", params: ["name"] },
    { pattern: /^The relay refused it \((\d+)\)\.$/, key: "refusals.relayStatus", params: ["status"] }
];

/** The outage headlines `reachability` writes into an event's label. */
const OUTAGES: readonly { readonly pattern: RegExp; readonly key: PlacesKey; readonly params: readonly string[] }[] = [
    { pattern: /^Every camera(?: at (.+))? stopped answering$/s, key: "outage.every", params: ["place"] },
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
    if (kind && action) return t("refusals.kindCannot", { kind, action: action.replace("-on", "On") });
    for (const { pattern, key: shaped, params } of OUTAGES) {
        const found = pattern.exec(message);
        if (!found) continue;
        const values: Record<string, string | number> = {};
        params.forEach((name, index) => {
            const value = found[index + 1];
            values[name] = name === "place" ? (value ?? "") : /^\d+$/.test(value ?? "") ? Number(value) : (value ?? "");
        });
        values.hasPlace = values.place ? "yes" : "no";
        return t(shaped, values);
    }
    for (const { pattern, key: shaped, params } of SHAPED) {
        const found = pattern.exec(message);
        if (!found) continue;
        return t(shaped, Object.fromEntries(params.map((name, index) => [name, found[index + 1] ?? ""])));
    }
    return message;
}

/** Every sentence the table knows, for the test that holds each thrown one to it. */
export const KNOWN_PLACES_REFUSALS: readonly string[] = [...EXACT.keys()];
