/**
 * A database's Users and Processes tabs: the accounts inside the instance and
 * what each may reach, and the connections open on it.
 *
 * Only a dedicated, single-node PostgreSQL, MySQL or MariaDB: a database that
 * lives inside another instance shares that instance's accounts, and a cluster's
 * members would each need the same change. Every statement comes from the pure
 * builders in `@polaris/core` (`database-accounts`) and runs inside the
 * instance's container as its administrative account. A password is generated
 * here, handed back once, and never stored or logged.
 */

import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { DatabaseOperationError, instanceContext, lastLine, runWithin, withPorts, type InstanceContext } from "./ops";

/** One statement is a quick thing; a container that does not answer in this long is not going to. */
const STATEMENT_LIMIT_MS = 30_000;

export interface AccountScope {
    readonly context: InstanceContext;
    readonly target: core.AccountTarget;
}

/** The instance, refused unless these tabs can act on it. */
export async function accountScope(databaseId: string, ownerId: string): Promise<AccountScope> {
    const context = await instanceContext(databaseId, ownerId);
    if (!core.isAccountEngine(context.engine)) {
        throw new DatabaseOperationError("Users and connections are managed for PostgreSQL, MySQL and MariaDB.");
    }
    if (context.hosted) {
        throw new DatabaseOperationError("This database lives inside another instance. Manage its users from that instance.");
    }
    if (context.topology.kind !== "single") {
        throw new DatabaseOperationError("Users and connections are managed on a single instance, not on a cluster.");
    }
    return {
        context,
        target: { engine: context.engine, adminUser: context.admin.username, adminPassword: context.admin.password }
    };
}

/** Run commands in order inside the instance; a failure names the step and the engine's last line. */
export async function runCommands(
    scope: AccountScope,
    commands: readonly core.AccountCommand[],
    secrets: readonly string[] = []
): Promise<string[]> {
    const masked = [scope.target.adminPassword, ...secrets];
    return withPorts(scope.context, async (ports) => {
        const outputs: string[] = [];
        for (const command of commands) {
            const result = await runWithin(ports, scope.context.container, command.argv, STATEMENT_LIMIT_MS);
            if (result.code !== 0) {
                const said = lastLine(result.output, masked);
                throw new DatabaseOperationError(`${command.describe} failed${said ? `: ${said}` : ""}`);
            }
            outputs.push(result.output);
        }
        return outputs;
    });
}

export interface AccountListing {
    readonly accounts: core.DbAccount[];
    /** The databases an account can be given, the engine's own left out. */
    readonly databases: string[];
}

export async function listAccounts(databaseId: string, ownerId: string): Promise<AccountListing> {
    const scope = await accountScope(databaseId, ownerId);
    const [accounts, databases] = await runCommands(scope, [
        core.listAccountsCommand(scope.target),
        core.listDatabasesCommand(scope.target.engine, scope.target.adminUser, scope.target.adminPassword)
    ]);
    const own = scope.context.own.username;
    return {
        accounts: core
            .parseAccounts(scope.target.engine, accounts, scope.target.adminUser)
            .map((account) => (account.username === own ? { ...account, protected: true } : account)),
        databases: core.unknownNames(scope.target.engine, databases, [])
    };
}

/** Accounts Polaris and the services depend on: never dropped or regranted from here. */
function refuseProtected(scope: AccountScope, username: string): void {
    if (username === scope.context.own.username || username === scope.target.adminUser) {
        throw new DatabaseOperationError("Polaris and your services sign in with this account, so it cannot be changed here.");
    }
}

/** Create an account with a generated password, returned once. */
export async function createAccount(
    databaseId: string,
    ownerId: string,
    username: string
): Promise<{ username: string; password: string }> {
    const scope = await accountScope(databaseId, ownerId);
    refuseProtected(scope, username);
    const password = randomBytes(24).toString("base64url");
    await runCommands(scope, [core.createAccountCommand(scope.target, username, password)], [password]);
    return { username, password };
}

export async function dropAccount(databaseId: string, ownerId: string, username: string): Promise<void> {
    const scope = await accountScope(databaseId, ownerId);
    refuseProtected(scope, username);
    await runCommands(scope, [core.dropAccountCommand(scope.target, username)]);
}

export async function grantAccount(
    databaseId: string,
    ownerId: string,
    grant: { username: string; database: string; privileges: core.DbPrivilege }
): Promise<void> {
    const scope = await accountScope(databaseId, ownerId);
    refuseProtected(scope, grant.username);
    await runCommands(scope, core.grantAccountCommands(scope.target, grant));
}

export async function revokeAccount(
    databaseId: string,
    ownerId: string,
    revoke: { username: string; database: string }
): Promise<void> {
    const scope = await accountScope(databaseId, ownerId);
    refuseProtected(scope, revoke.username);
    await runCommands(scope, core.revokeAccountCommands(scope.target, revoke));
}

export async function listProcesses(databaseId: string, ownerId: string): Promise<core.DbProcess[]> {
    const scope = await accountScope(databaseId, ownerId);
    const [output] = await runCommands(scope, [core.processListCommand(scope.target)]);
    return core.parseProcessList(scope.target.engine, output);
}

export async function killProcess(databaseId: string, ownerId: string, processId: number): Promise<void> {
    const scope = await accountScope(databaseId, ownerId);
    await runCommands(scope, [core.killProcessCommand(scope.target, processId)]);
}
