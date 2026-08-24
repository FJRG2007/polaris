/**
 * What a FiveM server is made of: its port, its footprint, and the environment
 * the image is started with.
 *
 * Pure, and separate from anything that allocates, for the same reason ARK's is:
 * the create dialog says what a server will cost before one exists, and a module
 * that reaches for the database cannot be rendered in a browser.
 *
 * The port is the part worth explaining. A FiveM client speaks TCP and UDP to the
 * same port number, and the image's own config binds 30120 inside the container -
 * written on the first start, before Polaris has anything it can write to. So the
 * container's port is left where the image put it and only the host side moves:
 * the first server on a machine takes 30120, the next takes whatever is free, and
 * both are published onto 30120 inside. Anything that talks to the server does so
 * from inside its own container, so it always dials 30120 and never has to work
 * out which server it is looking at.
 */

/** The catalog id a FiveM server install is made from. */
export const FIVEM_CATALOG_ID = "fivem";

/** What the server listens on inside its container. Fixed by the image's own
 *  config, which is written before Polaris can reach the container at all. */
export const FIVEM_CONTAINER_PORT = 30120;

/** The port a FiveM client assumes when the address it was given carries none,
 *  and what Polaris starts looking from. */
export const PREFERRED_HOST_PORT = 30120;

/** Where the image keeps everything a server owns: its config, its resources,
 *  its cache. The volume is mounted here. */
export const CONFIG_ROOT = "/config";

/** The one file the whole server is configured by. */
export const SERVER_CFG = `${CONFIG_ROOT}/server.cfg`;

/** Where resources live. Each is a folder with a manifest in it. */
export const RESOURCES_ROOT = `${CONFIG_ROOT}/resources`;

/**
 * A Cfx server key, as far as its shape can be checked.
 *
 * Deliberately loose. Keymaster has issued keys in more than one format over the
 * years and will issue another, so this refuses what is obviously not a key - a
 * sentence, a pasted URL, an empty box - and lets the server itself be the judge
 * of the rest. Refusing a valid key would leave somebody unable to create a
 * server at all, which is far worse than a create that fails at the first start
 * with the server's own message.
 */
export function isLicenseKey(value: string): boolean {
    return /^[A-Za-z0-9_.-]{10,128}$/.test(value.trim());
}

/** What to say when a key is refused, in the terms it was refused on. */
export const LICENSE_KEY_HINT = "That is not a server key. Copy it from keymaster.fivem.net.";

/** Where an operator gets one. Named here so every screen that asks for a key
 *  sends them to the same place. */
export const KEYMASTER_URL = "https://keymaster.fivem.net/";

/**
 * What a FiveM server is likely to use, from how many people are on it.
 *
 * An estimate, and presented as one: nothing enforces it, and what the process
 * actually grows to depends far more on the resources somebody installs than on
 * the slot count. It exists so the machine picker can say whether the next server
 * fits.
 */
export function expectedFivemMemoryMb(concurrentPlayers: number): number {
    const raw = 1536 + Math.max(0, concurrentPlayers) * 40;
    return Math.min(Math.ceil(raw / 512) * 512, 16384);
}

/**
 * The environment the image is started with.
 *
 * Three values and no more. The key is the one thing Polaris cannot mint and the
 * server will not start without; the console password is minted per server, and
 * the image writes it into the config it generates on the first start, which is
 * the only moment anything can. OneSync is switched off here because the image
 * would otherwise force it on the command line - it is set in the config instead,
 * where the rules screen can change it and where what the screen shows is what
 * the server is actually running.
 */
export function fivemServerEnv(licenseKey: string, rconPassword: string): Record<string, string> {
    return {
        LICENSE_KEY: licenseKey.trim(),
        RCON_PASSWORD: rconPassword,
        NO_ONESYNC: "1"
    };
}
