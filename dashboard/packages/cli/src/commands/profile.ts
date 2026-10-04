/**
 * Profiles: one sign-in per Polaris (or per account on one), and which is in use.
 *
 * `plr login --url` adds one, named after the address unless `--profile` names
 * it; `plr profile use` switches; `--profile` or `POLARIS_PROFILE` picks one for
 * a single command without switching.
 */

import { logout } from "./auth.js";
import { usage } from "../errors.js";
import type { Flags } from "../args.js";
import type { Context } from "../context.js";
import { line, printJson, table } from "../output.js";
import { loadConfig, profileNameSchema, saveConfig } from "../config.js";

export async function profile(
    context: Context,
    flags: Flags,
    args: readonly string[]
): Promise<void> {
    const [action = "list", target] = args;
    const config = await loadConfig(context.configDir);

    if (action === "list") {
        const names = Object.keys(config.profiles).sort();
        if (flags.json) {
            printJson(
                context.io,
                names.map((name) => {
                    const entry = config.profiles[name]!;
                    return {
                        name,
                        current: name === config.current,
                        url: entry.url,
                        account: entry.account,
                        scopes: entry.scopes
                    };
                })
            );
            return;
        }
        if (names.length === 0) {
            line(context.io, "No profiles yet. Run plr login --url https://your-polaris-address");
            return;
        }
        context.io.out(
            table(
                ["", "PROFILE", "POLARIS", "ACCOUNT"],
                names.map((name) => {
                    const entry = config.profiles[name]!;
                    return [
                        name === config.current ? "*" : "",
                        name,
                        entry.url,
                        entry.account.email
                    ];
                })
            )
        );
        return;
    }

    if (action === "use") {
        const parsed = profileNameSchema.safeParse(target ?? "");
        if (!parsed.success) throw usage("Name the profile to use: plr profile use <name>");
        if (!config.profiles[parsed.data])
            throw usage(
                `There is no profile named "${parsed.data}". plr profile list shows yours.`
            );
        await saveConfig(context.configDir, { ...config, current: parsed.data });
        line(context.io, `Now using ${parsed.data} (${config.profiles[parsed.data]!.url}).`);
        return;
    }

    if (action === "remove") {
        const parsed = profileNameSchema.safeParse(target ?? "");
        if (!parsed.success) throw usage("Name the profile to remove: plr profile remove <name>");
        // Removing a profile is signing it out: its key is revoked on the server
        // rather than left working with nothing on this machine using it.
        await logout(context, { ...flags, profile: parsed.data });
        return;
    }

    throw usage(`"${action}" is not something plr profile does. Use list, use or remove.`);
}
