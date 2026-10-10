/** In a call with the soundboard open: Polaris's own sounds and the space's. */

import { inCall } from "./in-call";
import { defineScene } from "../runtime/scene";
import { label, press } from "../runtime/interact";

/** The board is answered for every call screen (`callSoundboard` in fixtures/chat.ts). */
export const soundboard = defineScene({
    id: "soundboard",
    path: inCall.path,
    params: inCall.params,
    actions: inCall.actions,
    render: inCall.render,
    prepare: (ctx) => press(label(ctx.locale, "chat.soundboard.button"))
});
