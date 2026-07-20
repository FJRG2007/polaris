/**
 * Managed databases: one-click Postgres/MySQL/MariaDB/Mongo/Redis. A database is
 * a container plus a schema row and an auto-named volume; its container name is
 * its DNS hostname on the proxy network, so other services reach it by name.
 * Credentials are generated at create time and stored envelope-encrypted. Deploys
 * reuse the exact same runner and per-target queue as applications.
 */

import { randomBytes } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { serviceName, shortHash, slugify, type DbDeployPlan } from "@polaris/deploy";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { deployLogPath, enqueueOnTarget, executeDeployment } from "./deploy-service";

export type DbEngine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";

interface DbCredentials {
    username: string;
    password: string;
    database: string;
}

interface EngineSpec {
    readonly defaultVersion: string;
    readonly dataPath: string;
    readonly port: number;
    image(version: string): string;
    env(creds: DbCredentials): Record<string, string>;
}

const ENGINES: Record<DbEngine, EngineSpec> = {
    postgres: {
        defaultVersion: "16",
        dataPath: "/var/lib/postgresql/data",
        port: 5432,
        image: (version) => `postgres:${version}-alpine`,
        env: (creds) => ({
            POSTGRES_USER: creds.username,
            POSTGRES_PASSWORD: creds.password,
            POSTGRES_DB: creds.database
        })
    },
    mysql: {
        defaultVersion: "8",
        dataPath: "/var/lib/mysql",
        port: 3306,
        image: (version) => `mysql:${version}`,
        env: (creds) => ({
            MYSQL_ROOT_PASSWORD: creds.password,
            MYSQL_DATABASE: creds.database,
            MYSQL_USER: creds.username,
            MYSQL_PASSWORD: creds.password
        })
    },
    mariadb: {
        defaultVersion: "11",
        dataPath: "/var/lib/mysql",
        port: 3306,
        image: (version) => `mariadb:${version}`,
        env: (creds) => ({
            MARIADB_ROOT_PASSWORD: creds.password,
            MARIADB_DATABASE: creds.database,
            MARIADB_USER: creds.username,
            MARIADB_PASSWORD: creds.password
        })
    },
    mongo: {
        defaultVersion: "7",
        dataPath: "/data/db",
        port: 27017,
        image: (version) => `mongo:${version}`,
        env: (creds) => ({
            MONGO_INITDB_ROOT_USERNAME: creds.username,
            MONGO_INITDB_ROOT_PASSWORD: creds.password,
            MONGO_INITDB_DATABASE: creds.database
        })
    },
    redis: {
        defaultVersion: "7",
        dataPath: "/data",
        port: 6379,
        image: (version) => `redis:${version}-alpine`,
        env: (creds) => ({ REDIS_PASSWORD: creds.password })
    }
};

/** A URL-safe generated secret for database credentials. */
function generatePassword(): string {
    return randomBytes(24).toString("base64url");
}

export interface CreateDatabaseInput {
    environmentId: string;
    targetId: string;
    engine: DbEngine;
    name: string;
    version?: string;
}

export async function createDatabase(ownerId: string, input: CreateDatabaseInput) {
    const environment = await prisma.environment.findFirst({
        where: { id: input.environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    const target = await prisma.deployTarget.findFirst({ where: { id: input.targetId, ownerId } });
    if (!target) throw new Error("Deploy target not found");

    const spec = ENGINES[input.engine];
    const slug = slugify(input.name);
    if (!slug) throw new Error("Database name must contain letters or digits");
    const version = input.version?.trim() || spec.defaultVersion;

    const creds: DbCredentials = { username: "polaris", password: generatePassword(), database: slug };
    const blob = encryptCredentials(creds, loadEnv().POLARIS_MASTER_KEY);

    return prisma.managedDatabase.create({
        data: {
            environmentId: input.environmentId,
            targetId: input.targetId,
            name: input.name,
            slug,
            engine: input.engine,
            image: spec.image(version),
            version,
            volumeName: "",
            containerName: "",
            encryptedCredential: blob.ciphertext,
            credentialNonce: blob.nonce,
            credentialKeyId: blob.keyId
        }
    });
}

/** Decrypt a database's stored credentials (for a connection string display). */
export async function databaseCredentials(databaseId: string, ownerId: string): Promise<DbCredentials> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } }
    });
    if (!row || !row.encryptedCredential || !row.credentialNonce) throw new Error("Database not found");
    return decryptCredentials<DbCredentials>(
        {
            ciphertext: Buffer.from(row.encryptedCredential),
            nonce: Buffer.from(row.credentialNonce),
            keyId: row.credentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** Provision (or re-provision) a managed database as a container. */
export async function deployDatabase(databaseId: string, ownerId: string, userId: string): Promise<string> {
    const db = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!db) throw new Error("Database not found");

    const spec = ENGINES[db.engine as DbEngine];
    const creds = await databaseCredentials(databaseId, ownerId);
    const name = serviceName(db.environment.project.slug, db.slug, db.id);
    const volumeName = `${db.engine}-data-${shortHash(db.id, 8)}`;
    const project = `polaris-db-${shortHash(db.id, 8)}`;

    // Persist the resolved container name and volume so later reads/connections
    // use the same identifiers the deploy created.
    await prisma.managedDatabase.update({
        where: { id: db.id },
        data: { containerName: name, volumeName, status: "provisioning" }
    });

    const plan: DbDeployPlan = {
        ref: { name, project },
        image: db.image,
        env: spec.env(creds),
        volumeName,
        dataPath: spec.dataPath,
        exposePort: db.exposePort ?? undefined
    };

    const deployment = await prisma.deployment.create({
        data: {
            targetId: db.targetId,
            deployableType: "database",
            deployableId: db.id,
            status: "queued",
            triggeredById: userId
        }
    });

    enqueueOnTarget(db.targetId, async () => {
        await executeDeployment(deployment.id, db.target, ownerId, (ctx, driver) => driver.deployDatabase(plan, ctx));
        const final = await prisma.deployment.findUnique({ where: { id: deployment.id }, select: { status: true } });
        await prisma.managedDatabase.update({
            where: { id: db.id },
            data: { status: final?.status === "running" ? "running" : "failed" }
        });
    });
    // Reference kept for symmetry with app deploys (log path is by deployment id).
    void deployLogPath(deployment.id);
    return deployment.id;
}
