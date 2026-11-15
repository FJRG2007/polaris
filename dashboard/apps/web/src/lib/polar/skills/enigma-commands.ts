/**
 * The Enigma "/" commands one person is offered: none while Enigma is off for
 * them, Code's only when they can start a Code session, and Chat's only those
 * that need no shell or checkout. Read from the same stored catalogue as the
 * skills, so nothing here fetches more than once per version.
 */

import { ownEnigma } from "@/lib/agents/agent-defaults-service";
import { enigmaCatalogue, type EnigmaSkill } from "@/lib/polar/skills/enigma-catalogue";
import { enigmaSlashFor, NO_ENIGMA_COMMANDS, type EnigmaSlashLists } from "@/lib/polar/enigma-slash";

/** `canCode` is whether the person can start a Code session (`agents.manage`). */
export async function enigmaSlashLists(userId: string, canCode: boolean): Promise<EnigmaSlashLists> {
    const { resolved } = await ownEnigma(userId);
    if (!resolved.enabled) return NO_ENIGMA_COMMANDS;
    const { commands } = await enigmaCatalogue();
    return { code: canCode ? enigmaSlashFor(commands, "code") : [], chat: enigmaSlashFor(commands, "chat") };
}

/**
 * The commands a chat can run, as skills its model loads by name: the words
 * after the "/" stand where the instructions say `$ARGUMENTS`.
 */
export function chatCommandSkills(
    commands: Awaited<ReturnType<typeof enigmaCatalogue>>["commands"]
): EnigmaSkill[] {
    return commands
        .filter((command) => command.chat)
        .map((command) => ({
            name: command.name,
            description: `/${command.name}: ${command.description}`,
            instructions: command.instructions.replaceAll(
                "$ARGUMENTS",
                `(the words the person typed after /${command.name})`
            )
        }));
}
