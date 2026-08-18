"use client";

/**
 * A call, in the browser.
 *
 * One way of carrying one, through the call server the stack runs. There used to
 * be a second - browser to browser, for an instance with no server - and it is
 * gone, because "no server" is no longer a state Polaris can be in: the media
 * server starts with the stack. Keeping the fallback meant every call chose
 * between two implementations at join time, and the one it chose when the server
 * was merely slow to answer was the one that cannot leave a network.
 *
 * The screens above never knew which, so nothing above this line changes.
 */

export { useSfuCall as useCall } from "./use-sfu-call";
export type { CallDevice, CallState, PeerState } from "./call-state";
