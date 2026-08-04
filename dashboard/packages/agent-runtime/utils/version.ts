import semver from "semver";
import packageJson from "../package.json" with { type: "json" };

export function getDevDependencyVersion(name: keyof typeof packageJson.devDependencies): string {
  const version = packageJson.devDependencies[name];
  if (!semver.valid(version)) {
    throw new Error(`dev dependency "${name}" must be a pinned version, got "${version}"`);
  }
  return version;
}
