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
 * So the tag follows the release: Java 25 from 26.x (and for `LATEST` and
 * snapshots), Java 21 for everything before, which is what the 1.21 line targets
 * and what older plugin servers have always run on here. The server software
 * does not change the answer today: every software's `LATEST` resolves to 26.x.
 *
 * Applied when a server is deployed, which every create, settings save, reset and
 * restart does, so a server whose release moved is on the right runtime the next
 * time it starts. Only the tags Polaris chooses are rewritten; an image somebody
 * pinned by hand is left as it is.
 */

export const MINECRAFT_IMAGE = "itzg/minecraft-server";

/** The tags this module chooses between, and so the only ones it replaces. */
const MANAGED_TAGS = ["java21", "java25"] as const;

export type JavaTag = (typeof MANAGED_TAGS)[number];

/** The first Minecraft release that needs Java 25. */
const JAVA25_SINCE = 26;

export function javaTagFor(version: string): JavaTag {
    const value = version.trim().toUpperCase();
    // Empty is the image's default, which is LATEST.
    if (value === "" || value === "LATEST" || value === "SNAPSHOT") return "java25";
    // A release (26.1, 1.21.4) or a snapshot (26w14a) leads with the number that decides.
    const lead = /^(\d+)[.W]/.exec(value);
    if (!lead) return "java21";
    return Number(lead[1]) >= JAVA25_SINCE ? "java25" : "java21";
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
