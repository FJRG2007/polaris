/**
 * Polaris on a Stream Deck: the plugin's entry point.
 *
 * Registers the actions, connects to the Stream Deck app, and then reads the
 * stored connection to Polaris, if there is one.
 */

import { hub } from "./hub";
import streamDeck from "@elgato/streamdeck";
import { tellInspector } from "./inspector";
import { PolarisDial, PolarisKey, TimerAction } from "./actions";
import { CALL_UUID, PLACES_DIAL_UUID, PLACES_UUID, SOUND_UUID, surfaceOf } from "./surfaces";

// Never "trace": the log would carry every message, the deck's key among them.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new PolarisKey());
streamDeck.actions.registerAction(new PolarisDial());
streamDeck.actions.registerAction(new PolarisKey(CALL_UUID));
streamDeck.actions.registerAction(new PolarisKey(SOUND_UUID));
streamDeck.actions.registerAction(new PolarisKey(PLACES_UUID));
streamDeck.actions.registerAction(new PolarisDial(PLACES_DIAL_UUID));
streamDeck.actions.registerAction(new TimerAction());

// Whatever changes - connected, offline, a code to show - the open settings
// screen hears about it.
hub.onChange = () => {
    const surface = surfaceOf(streamDeck.ui.action?.manifestId ?? "");
    if (surface) void tellInspector(surface);
};

await streamDeck.connect();
await hub.start();
