import { z } from "zod";
import { NextResponse } from "next/server";
import {
    isCategoryFor,
    newestBuilds,
    pinnedBuild,
    readConflicts,
    readInstalledProjects,
    readRequirements,
    searchModrinth
} from "../../../../../../../lib/minecraft/modrinth";
import { host } from "@polaris/app-host";
import { notForPlayers, packEntries } from "../../../../../../../lib/minecraft/client-pack";

const { requireGameServer } = host.appsInstallAccess;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the mods screen asks for.
 *
 * Two questions, and they are one route because they are one screen and both are
 * answered by the same index: what is worth installing on this server, and what
 * is already on it. Everything about the server - its software, the release it
 * runs, the list it is carrying - is supplied by the caller and re-checked here
 * before any of it reaches somebody else's API.
 */
const searchSchema = z.object({
    query: z.string().trim().max(80).default(""),
    /** The loaders a server can be running; anything else is not a search we can
     *  make sense of, and is refused rather than passed on to Modrinth. */
    loader: z.enum(["paper", "spigot", "fabric", "forge", "neoforge"]),
    /** The release the server is on, so nothing without a build for it is
     *  offered. Blank for a server on LATEST, whose release nobody here knows. */
    version: z
        .string()
        .trim()
        .max(16)
        .regex(/^[0-9][0-9.]*$/)
        .optional()
        .or(z.literal("")),
    category: z.string().trim().max(32).default(""),
    /** Whose mods are being looked for: the ones this server can run, or the ones
     *  its players install. The second set is the mods with no server side, which
     *  the first one deliberately hides. */
    side: z.enum(["server", "player"]).default("server")
});

/** The list as the container holds it: comma separated, each entry possibly
 *  carrying the image's own "?" or ":version" syntax. */
const installedSchema = searchSchema.extend({
    installed: z.string().max(4000)
});

/** Both lists a player's install is made of, as the screen holds them. */
const packSchema = searchSchema.extend({
    server: z.string().max(4000).default(""),
    player: z.string().max(4000).default("")
});

/** A list as the container holds it, as its entries. */
function entriesOf(list: string): string[] {
    return list
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .slice(0, 100);
}

/**
 * Browse Modrinth for what fits this server, or resolve what is already on it.
 *
 * Proxied so the browser never calls a third party directly, and gated on the
 * same permission as the rest of the app - the results end up in an install.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    // Against the server the search is for, not against the instance: the results
    // end up in one install's mod list, so the grant that matters is the one on it.
    const { id } = await params;
    await requireGameServer("games.manage", id);
    const url = new URL(request.url);
    const asked = {
        query: url.searchParams.get("query") ?? "",
        loader: url.searchParams.get("loader") ?? "",
        version: url.searchParams.get("version") ?? "",
        category: url.searchParams.get("category") ?? "",
        side: url.searchParams.get("side") ?? "server"
    };

    if (url.searchParams.get("pack") !== null) {
        const parsed = packSchema.safeParse({
            ...asked,
            server: url.searchParams.get("server") ?? "",
            player: url.searchParams.get("player") ?? ""
        });
        if (!parsed.success)
            return NextResponse.json(
                { error: "Could not read this server's lists" },
                { status: 400 }
            );
        const server = entriesOf(parsed.data.server);
        const version = parsed.data.version ?? "";
        const pack = await packEntries({
            server,
            player: entriesOf(parsed.data.player),
            loader: parsed.data.loader,
            version
        });
        return NextResponse.json({
            pack,
            serverOnly: await notForPlayers({ server, pack, loader: parsed.data.loader, version })
        });
    }

    const installed = url.searchParams.get("installed");
    if (installed !== null) {
        const parsed = installedSchema.safeParse({ ...asked, installed });
        if (!parsed.success)
            return NextResponse.json(
                { error: "Could not read this server's list" },
                { status: 400 }
            );
        const entries = entriesOf(parsed.data.installed);
        // Both at once: what each project is, and what any two of them say about
        // each other. A conflict is only worth reporting between things that are
        // both actually on the list.
        // Three at once: what each project is, what any two of them say about each
        // other, and whether an entry nailed to one build has been left behind by a
        // newer one. The last costs nothing on a list where nothing is pinned,
        // which is most lists.
        const [projects, conflicts, newest, requires] = await Promise.all([
            readInstalledProjects(entries, parsed.data.loader, parsed.data.version || null),
            readConflicts(entries, parsed.data.loader, parsed.data.version || null).catch(() => []),
            newestBuilds(entries, parsed.data.loader, parsed.data.version || null).catch(
                () => new Map()
            ),
            // And what each of them cannot run without. A required dependency with
            // no build for this server is not a mod that gets skipped - it is a
            // boot that ends, and a server that restarts until it is stopped.
            readRequirements(entries, parsed.data.loader, parsed.data.version || null).catch(
                () => []
            )
        ]);
        return NextResponse.json({
            projects: projects.map((project) => ({
                ...project,
                pinned: pinnedBuild(project.entry),
                newest: newest.get(project.entry) ?? null
            })),
            conflicts,
            requires
        });
    }

    const parsed = searchSchema.safeParse(asked);
    if (!parsed.success || !isCategoryFor(parsed.data.loader, parsed.data.category)) {
        return NextResponse.json({ error: "Search for a mod or plugin by name" }, { status: 400 });
    }
    return NextResponse.json({
        projects: await searchModrinth(parsed.data.query, parsed.data.loader, {
            version: parsed.data.version || null,
            category: parsed.data.category,
            side: parsed.data.side
        })
    });
}
