/**
 * Every key the game servers app can carry is read back in the reader's words.
 *
 * A carried key the reader does not recognize is shown as it is, and a key
 * with a hyphen in it (`lib.blueprints.shrinking-world.name`) was exactly that:
 * the blueprint list read `games:lib.blueprints.shrinking-world.name`. So every
 * key in every namespace is carried and read back here, in every locale.
 */

import { describe, expect, it } from "vitest";
import enUS from "@polaris-app/game-servers/messages/en-US";
import { flattenCatalog, type Catalog } from "@polaris/core";
import {
    gameMessage,
    gameMessageIn,
    readGameMessage
} from "@polaris-app/game-servers/src/lib/game-message";

describe("a carried game message", () => {
    it("is read back for every key of every namespace", () => {
        const unread: string[] = [];
        for (const [namespace, catalog] of Object.entries(enUS)) {
            for (const key of flattenCatalog(catalog as Catalog).keys()) {
                const carried = gameMessage(namespace as never, key as never);
                if (!readGameMessage(carried)) unread.push(carried);
            }
        }
        expect(unread).toEqual([]);
    });

    it("writes a hyphenated key in the reader's language", () => {
        const carried = gameMessage("games", "lib.blueprints.shrinking-world.name");
        expect(gameMessageIn("en-US", carried)).toBe("Shrinking world");
        expect(gameMessageIn("es-ES", carried)).not.toBe(carried);
    });
});
