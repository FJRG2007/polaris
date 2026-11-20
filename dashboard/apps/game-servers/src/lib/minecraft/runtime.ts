/**
 * Which Java a Minecraft server's container runs, from the release it runs.
 *
 * The image offers no setting for the runtime - the Java version is the tag - and
 * neither tag runs everything:
 *
 * - Minecraft 26.1 and newer refuse to start on anything older than Java 25, on
 *   every server software. `LATEST` resolves to that line, so a server left on it
 *   exits at startup on Java 21.
 * - Java 25 removed the `jdk.crypto.ec` module, which the 1.21 line's authlib
 *   still requires by name, so NeoForge (and Forge) on 1.21.x die on it before a
 *   mod loads: `FindException: Module jdk.crypto.ec not found`.
 *
 * - 1.16.5 and older refuse anything newer than Java 16 ("Unsupported Java
 *   detected (65.0). Only up to Java 16 is supported."), and 1.12 and older
 *   mods need Java 8. A map pinned to one of those releases (Luckyblock Towers
 *   is held to 1.16.5) exited at every start on Java 21, in a restart loop.
 *
 * So the tag follows the release: Java 25 from 26.x (and for `LATEST` and
 * snapshots), Java 21 for 1.17 to 1.21, which is what the 1.21 line targets,
 * Java 11 for 1.13 to 1.16 and Java 8 for 1.12 and older. The server software
 * does not change the answer today: every software's `LATEST` resolves to 26.x.
 *
 * Applied when a server is deployed, which every create, settings save, reset and
 * restart does, so a server whose release moved is on the right runtime the next
 * time it starts. Only the tags Polaris chooses are rewritten; an image somebody
 * pinned by hand is left as it is.
 *
 * The rolling tags are kept on purpose rather than a release tag
 * (`2026.9.2-java21`). The outage that made this question come up - NeoForge's
 * repository changing its metadata format under the image's helper - is fixed
 * upstream by a newer helper, which only ever arrives through a newer image; a
 * frozen tag would have kept every server on the broken helper until a Polaris
 * release moved it. What a start must not depend on is the network, and that is
 * handled where it is decided: the loader is held at its installed version
 * (`loader-pin.ts`), so a start installs nothing.
 */

export const MINECRAFT_IMAGE = "itzg/minecraft-server";

/** The tags this module chooses between, and so the only ones it replaces. */
const MANAGED_TAGS = ["java8", "java11", "java21", "java25"] as const;

export type JavaTag = (typeof MANAGED_TAGS)[number];

/** The first Minecraft release that needs Java 25. */
const JAVA25_SINCE = 26;
/** The last 1.x minor that runs on Java 8, and the last that runs on Java 16 or older. */
const JAVA8_UNTIL = 12;
const JAVA11_UNTIL = 16;

export function javaTagFor(version: string): JavaTag {
    const value = version.trim().toUpperCase();
    // Empty is the image's default, which is LATEST.
    if (value === "" || value === "LATEST" || value === "SNAPSHOT") return "java25";
    // A release (26.1, 1.21.4) or a snapshot (26w14a) leads with the number that decides.
    const lead = /^(\d+)[.W]/.exec(value);
    if (!lead) return "java21";
    if (Number(lead[1]) >= JAVA25_SINCE) return "java25";
    // A 1.x release: its minor decides how old a Java it needs.
    const minor = /^1\.(\d+)(?:\D|$)/.exec(value);
    if (minor && Number(minor[1]) <= JAVA8_UNTIL) return "java8";
    if (minor && Number(minor[1]) <= JAVA11_UNTIL) return "java11";
    return "java21";
}

/** The image a server with this environment should run, or `imageRef` unchanged
 *  when it is not one of the Minecraft tags Polaris manages. */
export function minecraftImageFor(
    imageRef: string | undefined,
    env: Readonly<Record<string, string>>
): string | undefined {
    if (!imageRef) return imageRef;
    const managed = MANAGED_TAGS.some((tag) => imageRef === `${MINECRAFT_IMAGE}:${tag}`);
    if (!managed) return imageRef;
    return `${MINECRAFT_IMAGE}:${javaTagFor(env.VERSION ?? "")}`;
}

/**
 * Settings every Minecraft Java server runs with, whatever it was installed with.
 *
 * Polaris drives the server over RCON all the time - the sidebar every second,
 * hundreds of scoreboard commands when the challenges rotate, bossbars - and the
 * server's default, `broadcast-rcon-to-ops`, echoes each one into every op's chat
 * as a gray `[Rcon: ...]` line. That flood drops the client's frame rate.
 *
 * Returned for the deploy to lay over the stored environment, so a server
 * installed before this gets it the next time it is deployed (every restart,
 * settings save and reset is one) without anybody editing its settings. The image
 * writes the variable into an existing `server.properties` on every start, since
 * `OVERRIDE_SERVER_PROPERTIES` defaults to true.
 *
 * The Java 8 and Java 11 tags carry an older helper, frozen upstream, that reads
 * an optional Modrinth project's trailing "?" as part of its name and stops the
 * container on "Project(s) could not be located: [luckperms?]". On those the
 * optional projects are left out - optional means the server runs without them
 * - and the required ones kept.
 */
export function minecraftReleaseEnv(
    imageRef: string | undefined,
    env: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> | undefined {
    if (!imageRef) return undefined;
    const repository = imageRef.replace(/^(docker\.io\/)?(library\/)?/, "").split(/[:@]/)[0];
    if (repository !== MINECRAFT_IMAGE) return undefined;
    const tag = imageRef.split(":")[1] ?? "";
    const projects = env.MODRINTH_PROJECTS;
    if (!LEGACY_HELPER_TAGS.has(tag) || projects === undefined) return { BROADCAST_RCON_TO_OPS: "false" };
    const required = projects
        .split(/[,\n]/)
        .map((project) => project.trim())
        .filter((project) => project !== "" && !project.endsWith("?"));
    return { BROADCAST_RCON_TO_OPS: "false", MODRINTH_PROJECTS: required.join(",") };
}

/** The tags whose image helper cannot read an optional project. */
const LEGACY_HELPER_TAGS: ReadonlySet<string> = new Set(["java8", "java11"]);
