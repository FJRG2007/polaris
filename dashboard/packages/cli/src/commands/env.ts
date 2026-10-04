/**
 * A service's environment variables, managed without ever showing a value:
 * `plr env ls`, `plr env set`, `plr env rm`.
 *
 * `ls` prints names, whether each is secret and when it changed - never a value,
 * plain or secret, and nothing derived from one. `set` reads the value from a
 * prompt that does not echo, from stdin, or from `--from-file`, and never from
 * the command line, where it would land in the shell's history. Nothing this
 * module prints, on success or failure, contains the value it was handed.
 */

import { call } from "../api.js";
import type { Flags } from "../args.js";
import { readFile } from "node:fs/promises";
import { CliError, usage } from "../errors.js";
import { refOf, resolveService } from "./deploy.js";
import { line, printJson, table } from "../output.js";
import { withoutFinalNewline } from "../secret-input.js";
import { requireSession, type Context } from "../context.js";
import { envNamesSchema, envRemovedSchema, envSavedSchema } from "../schemas.js";

/** The rule the server applies to a name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

/** The most the server stores in one value. */
const MAX_VALUE = 64 * 1024;

/** A container's environment cannot hold these, so the server refuses them. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkedName(name: string | undefined): string {
    if (!name) throw usage("Name the variable, e.g. plr env set shop/web DATABASE_URL.");
    if (!NAME.test(name)) {
        throw usage(
            `"${name}" is not a variable name: letters, digits and underscores, not starting with a digit.`
        );
    }
    return name;
}

/** The value to store, from wherever it was offered. Refusals name the
 *  variable, never the value. */
async function valueFor(context: Context, flags: Flags, name: string): Promise<string> {
    let value: string | null;
    if (flags.fromFile) {
        try {
            value = await readFile(flags.fromFile, "utf8");
        } catch {
            throw new CliError(`Could not read ${flags.fromFile}. Nothing was changed.`);
        }
    } else {
        value = await context.readSecret(`Value for ${name} (not shown): `);
        if (value === null)
            throw new CliError(`No value was given for ${name}. Nothing was changed.`);
    }
    value = withoutFinalNewline(value);
    if (value === "") throw new CliError(`The value for ${name} is empty. Nothing was changed.`);
    if (CONTROL.test(value)) {
        throw new CliError(
            `The value for ${name} contains a line break, tab or other control character, which a container's environment cannot hold. Nothing was changed.`
        );
    }
    if (Buffer.byteLength(value) > MAX_VALUE)
        throw new CliError(`The value for ${name} is longer than 64 KB. Nothing was changed.`);
    return value;
}

export async function env(context: Context, flags: Flags, args: readonly string[]): Promise<void> {
    const [action, ref, name] = args;
    // Something after the name is most likely the value, typed where it lands
    // in the shell's history. Refused without being repeated.
    if (args.length > 3) {
        throw usage(
            "plr env takes no value on the command line. Run plr env set SERVICE NAME and type it at the prompt, or pipe it in."
        );
    }
    switch (action) {
        case "ls":
        case "list":
            return list(context, flags, ref);
        case "set":
            return set(context, flags, ref, name);
        case "rm":
        case "remove":
            return remove(context, flags, ref, name);
        default:
            throw usage(
                action ? `"plr env ${action}" is not a command.` : "plr env needs ls, set or rm."
            );
    }
}

async function list(context: Context, flags: Flags, ref: string | undefined): Promise<void> {
    const session = await requireSession(context, flags);
    const found = await resolveService(context, session, ref);
    const { variables } = await call(
        session.connection,
        "GET",
        `/api/v1/deploy/services/${found.id}/env`,
        envNamesSchema,
        { fetch: context.fetch }
    );
    if (flags.json) return printJson(context.io, variables);
    if (variables.length === 0) {
        line(context.io, `${refOf(found)} has no variables of its own. Add one with plr env set.`);
        return;
    }
    context.io.out(
        table(
            ["NAME", "SECRET", "UPDATED"],
            variables.map((row) => [row.key, row.isSecret ? "yes" : "no", row.updatedAt])
        )
    );
}

async function set(
    context: Context,
    flags: Flags,
    ref: string | undefined,
    typed: string | undefined
): Promise<void> {
    const name = checkedName(typed);
    const session = await requireSession(context, flags);
    const found = await resolveService(context, session, ref);
    const value = await valueFor(context, flags, name);
    const saved = await call(
        session.connection,
        "PUT",
        `/api/v1/deploy/services/${found.id}/env/${name}`,
        envSavedSchema,
        {
            fetch: context.fetch,
            body: { value, secret: !flags.plain, redeploy: flags.restart }
        }
    );
    if (flags.json) {
        return printJson(context.io, {
            name,
            service: found.id,
            created: saved.created,
            redeployed: saved.redeployed
        });
    }
    const note = saved.redeployed
        ? " The service redeploys to pick it up."
        : " The service picks it up on its next deploy (or run again with --restart).";
    line(
        context.io,
        `${saved.created ? "Created" : "Replaced"} ${name} on ${refOf(found)}.${note}`
    );
}

async function remove(
    context: Context,
    flags: Flags,
    ref: string | undefined,
    typed: string | undefined
): Promise<void> {
    const name = checkedName(typed);
    const session = await requireSession(context, flags);
    const found = await resolveService(context, session, ref);
    if (!flags.yes) {
        const answer = await context.prompt(`Remove ${name} from ${refOf(found)}? [y/N] `);
        if (answer === null)
            throw usage(
                `Run plr env rm ${refOf(found)} ${name} --yes to remove it without being asked.`
            );
        if (!/^y(es)?$/i.test(answer)) {
            line(context.io, "Nothing was removed.");
            return;
        }
    }
    const removed = await call(
        session.connection,
        "DELETE",
        `/api/v1/deploy/services/${found.id}/env/${name}${flags.restart ? "?redeploy=1" : ""}`,
        envRemovedSchema,
        { fetch: context.fetch }
    );
    if (flags.json) {
        return printJson(context.io, {
            name,
            service: found.id,
            removed: true,
            redeployed: removed.redeployed
        });
    }
    const note = removed.redeployed
        ? " The service redeploys without it."
        : " The service drops it on its next deploy (or run again with --restart).";
    line(context.io, `Removed ${name} from ${refOf(found)}.${note}`);
}
