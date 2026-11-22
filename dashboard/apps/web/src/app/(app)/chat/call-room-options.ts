/**
 * The options every call room is opened with.
 *
 * Split out of the call hook so the one that has already cost a dropped call -
 * `disconnectOnPageLeave` - can be asserted without a call server, a microphone
 * or a room behind it. The hook is thousands of lines of effects; this is a
 * plain object, and a type is all it takes from the client library, so the
 * library itself still loads only when a call starts.
 */

import type { RoomOptions } from "livekit-client";

/** What `new Room()` is handed for every call, group or one-to-one. */
export const CALL_ROOM_OPTIONS: Partial<RoomOptions> = {
    /**
     * Ask for the resolution the tile is actually drawn at, and stop
     * the flow entirely while it is off screen. On a wall of eight
     * faces this is most of the bandwidth.
     *
     * `pixelDensity: "screen"` is the half that was missing, and it
     * is why a shared screen looked sharp in this product while the
     * faces beside it did not. Left unset, the client asks for the
     * tile's size in CSS pixels and assumes one device pixel each -
     * so on a laptop that paints two, a 320-wide tile was fed a
     * 320-wide picture and then doubled to fill 640 real pixels.
     * That is upscaling, and it looks exactly like a soft camera. A
     * shared screen escaped it by being the biggest element on the
     * page: even halved it cleared the top layer.
     *
     * It costs bandwidth on a high-density display, which is the
     * documented trade and the one being asked for here: the picture
     * is the product.
     */
    adaptiveStream: { pixelDensity: "screen" },
    // Stop sending the quality layers nobody is subscribed to.
    dynacast: true,
    publishDefaults: {
        // Roughly half the bits for the same picture, which on a
        // domestic upstream is the difference between a sharp call
        // and a soft one. It also replaces simulcast with layers cut
        // from a single encode, so the three sizes below cost one
        // encoder instead of three.
        //
        // Safe to ask for unconditionally. A browser that cannot
        // encode it is given the old codec by the client itself, and
        // a subscriber that cannot decode it makes the publisher
        // fall back for the room - so the worst case is exactly what
        // this did before, never a call with no picture.
        videoCodec: "vp9",
        // Three sizes of the same camera, so the server has something
        // to give a small tile and a slow connection without asking
        // the publisher to change anything. Read only on the fallback
        // path: the codec above carries its own layers.
        simulcast: true,
        // Cheap on the wire and free of charge: silence costs nothing
        // to send, and a lost audio packet is covered by the next.
        dtx: true,
        red: true
    },
    // The devices are opened by the call hook, filtered, and handed over -
    // so nothing here should go looking for one of its own.
    stopLocalTrackOnUnpublish: false,
    /**
     * Off, because the client's own page-leave hook hangs up on
     * `beforeunload`, and that event says nothing about the page leaving.
     *
     * Chromium fires it in the page the moment a link with no target is
     * followed, before anything has decided whether the navigation happens.
     * In the desktop app a link to another site is then cancelled and handed
     * to the system browser (`contain()` in the desktop's `windows.ts`), so
     * the page never goes anywhere - but the call had already been dropped,
     * mid-sentence, by clicking a link somebody pasted into the chat. A plain
     * browser does the same for a `mailto:` link, and for a download.
     *
     * The client also listens for `freeze`, which a browser does not send a
     * page with a live connection and sound playing: those are left out of
     * freezing. What is left is `pagehide`, the page actually going away, and
     * the call hook hangs up on that itself.
     */
    disconnectOnPageLeave: false
};
