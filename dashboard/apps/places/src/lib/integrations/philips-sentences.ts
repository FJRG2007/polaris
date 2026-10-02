/**
 * What a Philips air purifier's driver says when something goes wrong, in
 * English, kept apart from the protocol so the pure refusal table can name them
 * without pulling sockets into a screen's bundle.
 */

export const PHILIPS_QUIET = "The air purifier did not answer.";
export const PHILIPS_LOCAL_OFF =
    "This model's firmware does not allow local control. It answers on your network but not to the local protocol Polaris uses. Try connecting it with a Philips Air+ account instead.";
export const PHILIPS_GARBLED = "The air purifier answered in a way Polaris could not read.";
export const PHILIPS_REFUSED = "The air purifier refused that.";
export const PHILIPS_HOMEID_BROKEN =
    "Philips' HomeID service failed on this account; if the device is in the HomeID app, remove it there and add it again.";
