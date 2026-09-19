/**
 * One server's mod pack, for the people who play on it.
 *
 * Reached with a token rather than a session, because the people who need it are
 * the operator's friends: they have no account here and should not need one to
 * install the mods for a server they were invited to. The token is derived from
 * this instance's own secret over the server's id, so it cannot be guessed from
 * the id and there is nothing stored to leak or migrate.
 *
 * What it gives away is exactly the list of mods that server runs, which is what
 * anybody who joins learns anyway - and the files themselves come from Modrinth,
 * not from here.
 *
 * Node runtime: it reads the install and asks Modrinth.
 */

import { prisma } from "@polaris/db";
import {
    PROJECTS_KEY,
    SOFTWARE_KEY,
    VERSION_KEY
} from "../../../../../../../lib/minecraft/join-guard";
import {
    isJarName,
    packTokenMatches,
    packUrl,
    resolvePack,
    setAside,
    type ClientPack,
    type ForeignJar
} from "../../../../../../../lib/minecraft/client-pack";
import {
    asideTable,
    packTable,
    powershellInstaller,
    shellInstaller
} from "../../../../../../../lib/minecraft/pack-scripts";
import { bounded } from "../../../../../../../lib/minecraft/mod-items-service";
import { host } from "@polaris/app-host";

const { readInstallConfig } = host.appsInstallConfig;
const { appBaseUrl, requestOrigin } = host.domainService;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The four things this answers, and nothing else. */
const FILES = new Set(["pack.tsv", "manifest.json", "install.sh", "install.ps1"]);

type Params = { params: Promise<{ id: string; token: string; file: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const { id, token, file } = await params;
    if (!FILES.has(file)) return new Response("Not found", { status: 404 });
    if (!packTokenMatches(id, token)) return new Response("Not found", { status: 404 });

    const install = await prisma.installedApp.findFirst({
        where: { id, status: { not: "removed" } },
        select: { name: true, config: true, applicationId: true }
    });
    if (!install?.applicationId) return new Response("Not found", { status: 404 });

    // The two scripts carry the server's name and the address of the list, and
    // nothing out of the list itself - so neither is worth resolving a pack for,
    // and a player fetching one does not spend a walk of Modrinth requests.
    if (file === "install.sh" || file === "install.ps1") {
        const manifest = packUrl(await packBase(request), id, "pack.tsv");
        const script =
            file === "install.ps1"
                ? powershellInstaller(manifest, install.name)
                : shellInstaller(manifest, install.name);
        return text(script, "text/plain; charset=utf-8");
    }

    const pack = await packOf(install as Install);

    if (file === "manifest.json") {
        return Response.json(pack, { headers: { "cache-control": "no-store" } });
    }
    return text(packTable(pack.mods, pack.missing), "text/plain; charset=utf-8");
}

type Install = { name: string; config: string | null; applicationId: string };

/** The pack as the server's lists stand right now. */
async function packOf(install: Install): Promise<ClientPack> {
    const env = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: install.applicationId,
            key: { in: [PROJECTS_KEY, SOFTWARE_KEY, VERSION_KEY] }
        },
        select: { key: true, value: true }
    });
    const value = (key: string): string => env.find((row) => row.key === key)?.value ?? "";
    return resolvePack({
        name: install.name,
        software: value(SOFTWARE_KEY),
        version: value(VERSION_KEY),
        projects: value(PROJECTS_KEY),
        config: readInstallConfig(install.config)
    });
}

/** How much of a player's folder one question may carry. */
const FOREIGN_BYTES = 64 * 1024;
const FOREIGN_JARS = 500;
const SHA1 = /^[0-9a-f]{40}$/;

/**
 * The installer asking about the jars it did not put there.
 *
 * It sends one line per jar - its sha1 and its name - and is answered with the
 * ones it should move out of the folder, and why: another copy of a mod in the
 * pack, or one a mod in the pack cannot run beside. See `setAsidePlan`.
 *
 * The same token as the list, for the same reason, and it hands back nothing the
 * installer did not send: names only, and only names it asked about. A line that
 * is not a sha1 and a jar name is dropped rather than answered.
 */
export async function POST(request: Request, { params }: Params): Promise<Response> {
    const { id, token, file } = await params;
    if (file !== "foreign.tsv") return new Response("Not found", { status: 404 });
    if (!packTokenMatches(id, token)) return new Response("Not found", { status: 404 });
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > FOREIGN_BYTES) return new Response("Too much", { status: 413 });

    const install = await prisma.installedApp.findFirst({
        where: { id, status: { not: "removed" } },
        select: { name: true, config: true, applicationId: true }
    });
    if (!install?.applicationId) return new Response("Not found", { status: 404 });

    const bytes = request.body ? await bounded(request.body, FOREIGN_BYTES) : new Uint8Array(0);
    if (!bytes) return new Response("Too much", { status: 413 });
    const body = new TextDecoder().decode(bytes);
    const jars: ForeignJar[] = [];
    for (const line of body.split("\n")) {
        const [sha1 = "", ...rest] = line.replace(/\r$/, "").split("\t");
        const name = rest.join("\t");
        const sum = sha1.trim().toLowerCase();
        if (!SHA1.test(sum) || !isJarName(name)) continue;
        jars.push({ name, sha1: sum });
        if (jars.length >= FOREIGN_JARS) break;
    }
    if (jars.length === 0) return text("", "text/plain; charset=utf-8");

    const pack = await packOf(install as Install);
    return text(asideTable(await setAside(pack.mods, jars)), "text/plain; charset=utf-8");
}

/**
 * The address the script fetches the list from.
 *
 * The one the player just reached, rather than one Polaris picks for itself: on a
 * LAN-only install the operator's own address is a name only this network knows,
 * and anything else baked into the script is a player whose install dies on a URL
 * that never resolves. `request.url` is not that address - it is the socket the
 * proxy forwards to - so it is the forwarded host or nothing, and nothing falls
 * back to the address Polaris publishes.
 */
async function packBase(request: Request): Promise<string> {
    const forwarded = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    return forwarded ? await requestOrigin(request) : await appBaseUrl();
}

function text(body: string, type: string): Response {
    return new Response(body, {
        headers: {
            "content-type": type,
            // A player runs this the moment the operator sends it, and again when
            // the list changes; a cached answer is the wrong mod list.
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
        }
    });
}
