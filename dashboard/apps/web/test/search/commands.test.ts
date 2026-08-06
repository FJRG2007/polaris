/**
 * What the search field decides a command is.
 *
 * The rules being protected: a word only takes over the search once it is
 * unambiguous, so an ordinary search for "apps" still finds the Apps page; a
 * slash or an @ is already unambiguous, so those take effect as soon as they
 * can; and a command nobody typed is never guessed at, because the whole reason
 * the commands exist is that a bare word must not start a database search.
 */

import { describe, expect, it } from "vitest";
import { SEARCH_SCOPES, isRemoteSearchScope } from "@polaris/core";
import { SEARCH_SCOPE_LIST, searchScope } from "@/lib/search/scopes";
import { commandSuggestions, detectCommand } from "@/lib/search/parse";

describe("detectCommand", () => {
    it("takes a slashed command as soon as the word is complete", () => {
        expect(detectCommand("/services")).toMatchObject({ scope: { id: "services" }, term: "" });
        expect(detectCommand("/services orphion")).toMatchObject({ scope: { id: "services" }, term: "orphion" });
        expect(detectCommand("/servers lirio-0")).toMatchObject({ scope: { id: "servers" }, term: "lirio-0" });
    });

    it("waits for a word another command continues, so the next letter is not eaten", () => {
        // "/task" is one keystroke short of "/tasks": taking it here would put
        // the "s" of "tasks" into the query and search for "s orphion".
        expect(detectCommand("/task")).toBeNull();
        expect(detectCommand("/tasks")).toMatchObject({ scope: { id: "tasks" }, term: "" });
        expect(detectCommand("/service")).toBeNull();
        expect(detectCommand("/server")).toBeNull();
        // A space commits it whether or not anything continues the word.
        expect(detectCommand("/task ")).toMatchObject({ scope: { id: "tasks" }, term: "" });
        expect(detectCommand("/task orphion")).toMatchObject({ scope: { id: "tasks" }, term: "orphion" });
    });

    it("takes a word nothing continues at once", () => {
        expect(detectCommand("/svc")).toMatchObject({ scope: { id: "services" } });
        expect(detectCommand("/db")).toMatchObject({ scope: { id: "databases" } });
        expect(detectCommand("/people")).toMatchObject({ scope: { id: "users" } });
    });

    it("takes a bare word only once something follows it", () => {
        // Still an ordinary search: this is what finds the Services page.
        expect(detectCommand("services")).toBeNull();
        expect(detectCommand("apps")).toBeNull();
        expect(detectCommand("services orphion")).toMatchObject({ scope: { id: "services" }, term: "orphion" });
        // A trailing space is the same commitment as a word after it.
        expect(detectCommand("servers ")).toMatchObject({ scope: { id: "servers" }, term: "" });
    });

    it("reads @ as people, with or without a name after it", () => {
        expect(detectCommand("@")).toMatchObject({ scope: { id: "users" }, term: "" });
        expect(detectCommand("@ana")).toMatchObject({ scope: { id: "users" }, term: "ana" });
        expect(detectCommand("@ ana ruiz")).toMatchObject({ scope: { id: "users" }, term: "ana ruiz" });
    });

    it("leaves an ordinary search alone", () => {
        expect(detectCommand("orphion")).toBeNull();
        expect(detectCommand("orphion checkout")).toBeNull();
        expect(detectCommand("/nonsense something")).toBeNull();
        expect(detectCommand("")).toBeNull();
        expect(detectCommand("   ")).toBeNull();
    });

    it("accepts the singular and the shorthand, whatever the casing", () => {
        expect(detectCommand("/service orphion")).toMatchObject({ scope: { id: "services" } });
        expect(detectCommand("/svc orphion")).toMatchObject({ scope: { id: "services" } });
        expect(detectCommand("/DB main")).toMatchObject({ scope: { id: "databases" } });
        expect(detectCommand("/Tasks release")).toMatchObject({ scope: { id: "tasks" }, term: "release" });
        expect(detectCommand("/SVC")).toMatchObject({ scope: { id: "services" } });
    });

    it("keeps the rest of the query intact", () => {
        expect(detectCommand("/tasks release 2.1 / rollout")).toMatchObject({ term: "release 2.1 / rollout" });
    });
});

describe("commandSuggestions", () => {
    it("offers everything behind a lone slash", () => {
        expect(commandSuggestions("/").map((scope) => scope.id)).toEqual(SEARCH_SCOPE_LIST.map((scope) => scope.id));
    });

    it("narrows to what is being spelled, across both spellings of a word", () => {
        const ids = commandSuggestions("serv").map((scope) => scope.id);
        expect(ids).toContain("services");
        expect(ids).toContain("servers");
    });

    it("offers a bare word so a command can be found by typing", () => {
        expect(commandSuggestions("tasks").map((scope) => scope.id)).toEqual(["tasks"]);
    });

    it("keeps offering a word that is complete but still waiting for its space", () => {
        // "/task" is not taken by detectCommand, so Enter or Tab has to be able
        // to take it - which means it has to still be on screen.
        expect(commandSuggestions("/task").map((scope) => scope.id)).toEqual(["tasks"]);
    });

    it("says nothing for a word that is no command, or once the search is under way", () => {
        expect(commandSuggestions("orphion")).toEqual([]);
        expect(commandSuggestions("services orphion")).toEqual([]);
        expect(commandSuggestions("")).toEqual([]);
    });
});

describe("the scope registry", () => {
    it("describes every scope the shared contract declares", () => {
        for (const id of SEARCH_SCOPES) expect(searchScope(id).id).toBe(id);
    });

    it("gives a local scope the resource kind it narrows to, and a remote one none", () => {
        for (const scope of SEARCH_SCOPE_LIST) {
            expect(scope.resourceKind === undefined).toBe(isRemoteSearchScope(scope.id));
        }
    });

    it("answers to each keyword exactly once", () => {
        const keywords = SEARCH_SCOPE_LIST.flatMap((scope) => scope.keywords);
        expect(keywords.length).toBe(new Set(keywords).size);
    });
});
