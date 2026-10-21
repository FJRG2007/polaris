/**
 * Polaris on a Stream Deck: the plugin's entry point.
 *
 * Registers the actions, connects to the Stream Deck app, and then reads the
 * stored connection to Polaris, if there is one.
 */

import { hub } from "./hub";
import streamDeck from "@elgato/streamdeck";
import { tellInspector } from "./inspector";
import { DIAL_UUID, PolarisDial, PolarisKey, TIMER_UUID, TimerAction } from "./actions";

// Never "trace": the log would carry every message, the deck's key among them.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new PolarisKey());
streamDeck.actions.registerAction(new PolarisDial());
streamDeck.actions.registerAction(new TimerAction());

// Whatever changes - connected, offline, a code to show - the open settings
// screen hears about it.
hub.onChange = () => {
    const open = streamDeck.ui.action;
    if (!open || open.manifestId === TIMER_UUID) return;
    void tellInspector(open.manifestId === DIAL_UUID ? "dial" : "key");
};

await streamDeck.connect();
await hub.start();
