/**
 * `plr open [page]`: the dashboard of the Polaris in use, in the browser.
 *
 * The address is printed as well, so it can be opened by hand where there is no
 * browser - which is also why this never needs a token.
 */

import { line } from "../output.js";
import { usage } from "../errors.js";
import type { Flags } from "../args.js";
import { loadConfig } from "../config.js";
import { normalizeUrl } from "../args.js";
import { chosenProfileName, type Context } from "../context.js";

/** The pages `plr open` knows by name. */
export const PAGES: Readonly<Record<string, string>> = {
    home: "/",
    deploy: "/apps/deploy",
    keys: "/account/api-keys",
    downloads: "/account/downloads"
};

export async function open(
    context: Context,
    flags: Flags,
    page: string | undefined
): Promise<void> {
    const path = PAGES[page ?? "home"];
    if (path === undefined) throw usage(`plr open knows ${Object.keys(PAGES).join(", ")}.`);

    let url = flags.url
        ? normalizeUrl(flags.url)
        : context.host.env.POLARIS_URL
          ? normalizeUrl(context.host.env.POLARIS_URL)
          : null;
    if (!url) {
        const config = await loadConfig(context.configDir);
        const name = chosenProfileName(context, flags, config.current);
        url = name ? (config.profiles[name]?.url ?? null) : null;
    }
    if (!url) throw usage("Which Polaris? Run plr login first, or pass --url.");

    const address = `${url}${path}`;
    const opened = context.canOpenBrowser() && (await context.openBrowser(address));
    line(context.io, opened ? `Opened ${address}` : address);
}
