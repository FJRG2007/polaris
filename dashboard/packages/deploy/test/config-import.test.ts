/**
 * What another platform's config file hands a new service: its commands, health
 * path, copies and variables - from the documented fields only, the first file
 * that states a setting deciding it, and nothing read from a file that is not
 * what it claims to be.
 */

import { describe, expect, it } from "vitest";
import { importDeployConfig, importedAnything } from "../src/config-import.js";

/** The value picked up for one setting, and the file it came from. */
function picked(config: ReturnType<typeof importDeployConfig>, setting: string) {
    const found = config.settings.find((entry) => entry.setting === setting);
    return found ? `${found.value} <- ${found.from}` : null;
}

describe("railway", () => {
    it("reads build, start, health and a Dockerfile builder from railway.json", () => {
        const config = importDeployConfig({
            "railway.json": JSON.stringify({
                $schema: "https://railway.com/railway.schema.json",
                build: {
                    builder: "DOCKERFILE",
                    dockerfilePath: "deploy/Dockerfile",
                    buildCommand: "yarn build"
                },
                deploy: {
                    startCommand: "node dist/server.js",
                    healthcheckPath: "/health",
                    restartPolicyType: "ON_FAILURE"
                }
            })
        });
        expect(picked(config, "buildCommand")).toBe("yarn build <- railway.json");
        expect(picked(config, "startCommand")).toBe("node dist/server.js <- railway.json");
        expect(picked(config, "healthPath")).toBe("/health <- railway.json");
        expect(picked(config, "dockerfilePath")).toBe("deploy/Dockerfile <- railway.json");
    });

    it("reads the same fields from railway.toml, quoted or not, and skips multi-line bodies", () => {
        const config = importDeployConfig({
            "railway.toml": [
                "[build]",
                'builder = "RAILPACK"',
                'buildCommand = "pnpm build" # the build',
                "",
                "[deploy]",
                "startCommand = 'pnpm start'",
                'healthcheckPath = "/up"',
                'cronSchedule = """',
                'startCommand = "not this"',
                '"""'
            ].join("\n")
        });
        expect(picked(config, "buildCommand")).toBe("pnpm build <- railway.toml");
        expect(picked(config, "startCommand")).toBe("pnpm start <- railway.toml");
        expect(picked(config, "healthPath")).toBe("/up <- railway.toml");
        expect(picked(config, "dockerfilePath")).toBeNull();
    });

    it("leaves a build that changes into another directory alone, and says so", () => {
        const config = importDeployConfig({
            "railway.json": JSON.stringify({ build: { buildCommand: "cd web && npm run build" } })
        });
        expect(picked(config, "buildCommand")).toBeNull();
        expect(config.skipped[0]).toContain("another directory");
    });
});

describe("render", () => {
    const blueprint = [
        "services:",
        "  - type: worker",
        "    name: jobs",
        "    startCommand: node worker.js",
        "  - type: web",
        "    name: web",
        "    runtime: node",
        "    rootDir: apps/web",
        "    buildCommand: npm install",
        '    startCommand: "npm start"',
        "    healthCheckPath: /healthz",
        "    numInstances: 3",
        "    envVars:",
        "      - key: API_URL",
        "        value: https://api.example.com",
        "      - key: SESSION_SECRET",
        "        generateValue: true",
        "      - key: STRIPE_KEY",
        "        sync: false",
        "      - key: DATABASE_URL",
        "        fromDatabase:",
        "          name: db",
        "          property: connectionString",
        "databases:",
        "  - name: db"
    ].join("\n");

    it("reads the web service rather than the first one", () => {
        const config = importDeployConfig({ "render.yaml": blueprint });
        expect(picked(config, "startCommand")).toBe("npm start <- render.yaml");
        expect(picked(config, "rootDirectory")).toBe("apps/web <- render.yaml");
        expect(picked(config, "healthPath")).toBe("/healthz <- render.yaml");
        expect(picked(config, "replicas")).toBe("3 <- render.yaml");
        // A bare install is not a build.
        expect(picked(config, "buildCommand")).toBeNull();
    });

    it("sorts its variables into set, generated and still needed", () => {
        const config = importDeployConfig({ "render.yaml": blueprint });
        expect(config.variables).toEqual({ API_URL: "https://api.example.com" });
        expect(config.generate).toEqual(["SESSION_SECRET"]);
        expect(config.needs).toEqual(["STRIPE_KEY"]);
        expect(config.skipped.join(" ")).toContain("DATABASE_URL");
    });
});

describe("netlify, vercel, Procfile and app.json", () => {
    it("reads netlify's base, publish, command and build environment", () => {
        const config = importDeployConfig({
            "netlify.toml": [
                "[build]",
                '  base = "site/"',
                '  publish = "site/dist"',
                '  command = "npm run build"',
                "",
                "[build.environment]",
                '  NODE_VERSION = "20"'
            ].join("\n")
        });
        expect(picked(config, "rootDirectory")).toBe("site <- netlify.toml");
        expect(picked(config, "outputDirectory")).toBe("dist <- netlify.toml");
        expect(picked(config, "buildCommand")).toBe("npm run build <- netlify.toml");
        expect(config.variables).toEqual({ NODE_VERSION: "20" });
    });

    it("reads vercel's install, build and output directory", () => {
        const config = importDeployConfig({
            "vercel.json": JSON.stringify({
                installCommand: "pnpm install",
                buildCommand: "pnpm build",
                outputDirectory: "./out/",
                framework: "nextjs"
            })
        });
        expect(picked(config, "installCommand")).toBe("pnpm install <- vercel.json");
        expect(picked(config, "outputDirectory")).toBe("out <- vercel.json");
    });

    it("takes the Procfile's web process, and app.json's variables and web quantity", () => {
        const config = importDeployConfig({
            Procfile: "web: bundle exec puma -C config/puma.rb\nworker: bundle exec sidekiq\n",
            "app.json": JSON.stringify({
                env: {
                    RAILS_ENV: "production",
                    SECRET_KEY_BASE: { description: "Signs cookies", generator: "secret" },
                    SMTP_PASSWORD: { description: "Mail" },
                    OPTIONAL_FLAG: { required: false }
                },
                formation: { web: { quantity: 2, size: "standard-1x" } }
            })
        });
        expect(picked(config, "startCommand")).toBe(
            "bundle exec puma -C config/puma.rb <- Procfile"
        );
        expect(picked(config, "replicas")).toBe("2 <- app.json");
        expect(config.variables).toEqual({ RAILS_ENV: "production" });
        expect(config.generate).toEqual(["SECRET_KEY_BASE"]);
        expect(config.needs).toEqual(["SMTP_PASSWORD"]);
    });
});

describe("folding several files", () => {
    it("lets the first file that states a setting decide it", () => {
        const config = importDeployConfig({
            "railway.json": JSON.stringify({ deploy: { startCommand: "node a.js" } }),
            Procfile: "web: node b.js"
        });
        expect(picked(config, "startCommand")).toBe("node a.js <- railway.json");
    });

    it("skips a file that is not what it says and reports nothing picked up from it", () => {
        const config = importDeployConfig({ "vercel.json": "{ not json", "app.json": "null" });
        expect(importedAnything(config)).toBe(false);
        expect(config.skipped).toEqual([
            "vercel.json could not be read",
            "app.json could not be read"
        ]);
    });

    it("does not ask for a variable another file already gives a value", () => {
        const config = importDeployConfig({
            "app.json": JSON.stringify({ env: { API_URL: {} } }),
            "netlify.toml": '[build.environment]\nAPI_URL = "https://x.example"'
        });
        expect(config.needs).toEqual([]);
        expect(config.variables).toEqual({ API_URL: "https://x.example" });
    });
});
