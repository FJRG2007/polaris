/**
 * The variable routes, written once for both places variables live.
 *
 * A service's own variables and the ones an environment shares are the same
 * three operations on a different scope, and two copies of them would drift in
 * exactly the way that matters here - one of them masking secrets and the other
 * forgetting to.
 */

import { textTable } from "./text";
import { deployRoute, readBody, respond } from "./http";
import { importVariablesSchema, setVariableSchema } from "./schemas";
import {
    importVariables,
    listVariables,
    setVariable,
    type VariableScope
} from "./surface";

type ScopeOf = (params: Readonly<Record<string, string>>) => VariableScope;

/** GET lists the scope's variables, secrets withheld; POST sets one. */
export function variableRoutes(scopeOf: ScopeOf) {
    return {
        GET: deployRoute("list the variables", false, async ({ caller, url, params }) => {
            const variables = await listVariables(caller, scopeOf(params));
            return respond(url, { variables }, () =>
                textTable(variables, [
                    ["KEY", (row) => row.key],
                    ["VALUE", (row) => (row.isSecret ? "(secret)" : row.value)],
                    ["ID", (row) => row.id]
                ])
            );
        }),
        POST: deployRoute("save the variable", true, async ({ caller, request, url, params }) => {
            const input = setVariableSchema.parse(await readBody(request));
            await setVariable(caller, scopeOf(params), input);
            return respond(url, { saved: input.key }, () => `saved ${input.key}\n`);
        })
    };
}

/** POST imports a `.env` file's contents into the scope. */
export function importRoute(scopeOf: ScopeOf) {
    return deployRoute("import the variables", true, async ({ caller, request, url, params }) => {
        const input = importVariablesSchema.parse(await readBody(request));
        const { count } = await importVariables(caller, scopeOf(params), input);
        return respond(url, { count }, () => `imported ${count}\n`);
    });
}
