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
import { publicAppUrl } from "@/lib/domain-service";
import { readInstallConfig } from "@/lib/apps/install-config";
import { PROJECTS_KEY, SOFTWARE_KEY, VERSION_KEY } from "@/lib/apps/minecraft/join-guard";
import { packTokenMatches, packUrl, resolvePack } from "@/lib/apps/minecraft/client-pack";
import { packTable, powershellInstaller, shellInstaller } from "@/lib/apps/minecraft/pack-scripts";

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

    const env = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: install.applicationId,
            key: { in: [PROJECTS_KEY, SOFTWARE_KEY, VERSION_KEY] }
        },
        select: { key: true, value: true }
    });
    const value = (key: string): string => env.find((row) => row.key === key)?.value ?? "";

    const pack = await resolvePack({
        name: install.name,
        software: value(SOFTWARE_KEY),
        version: value(VERSION_KEY),
        projects: value(PROJECTS_KEY),
        config: readInstallConfig(install.config)
    });

    // Where this Polaris is reachable from outside, since the script runs on
    // somebody else's machine; the address the request arrived on is the
    // fallback, which is right for a player on the same network.
    const base = (await publicAppUrl().catch(() => null)) ?? new URL(request.url).origin;
    const manifest = packUrl(base, id, "pack.tsv");

    if (file === "pack.tsv") return text(packTable(pack.mods), "text/plain; charset=utf-8");
    if (file === "manifest.json") {
        return Response.json(pack, { headers: { "cache-control": "no-store" } });
    }
    const script =
        file === "install.ps1"
            ? powershellInstaller(manifest, pack.server)
            : shellInstaller(manifest, pack.server);
    return text(script, "text/plain; charset=utf-8");
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
