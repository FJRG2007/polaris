package versioning

import org.gradle.api.Project

/**
 * Utility for computing the version string of PolarisAC artifacts.
 *
 * Uses Gradle's providers.exec for git invocations so that
 * org.gradle.configuration-cache=true can serialize the task graph.
 * Each helper takes a Project so the git workingDir is anchored to the
 * project root (was ambient JVM cwd before; flaky when invoked from
 * the workspace composite root).
 */
object VersionUtil {

    /**
     * Polaris builds this from a copy of the source with no git history (the image
     * build copies files, not a repository), so every git question has an answer
     * that does not need one: the upstream commit this copy was taken from, and the
     * Polaris source fingerprint when the build passes it in.
     */
    private const val UPSTREAM_COMMIT = "8eb5f2809591c891deb4958bb2927844871e0600"
    private fun fromBuild(name: String): String? = System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }

    fun computeVersion(project: Project, baseVersion: String): String {
        if (BuildConfig.release) {
            return baseVersion
        }

        val commitHash = getGitCommitHash(project)
        val branch = getGitBranch(project)

        val modifiers = buildList {
            if (!BuildConfig.shadePE) add("lite")
            if (!BuildConfig.relocate) add("no_relocate")
        }.joinToString("-").takeIf { it.isNotEmpty() }

        return buildString {
            append(baseVersion)
            append("-")
            branch?.let { append("$it-") }
            append(commitHash)
            modifiers?.let { append("+$it") }
        }
    }

    fun getGitCommitHash(project: Project, full: Boolean = false): String {
        fromBuild("POLARIS_AC_COMMIT")?.let { return if (full) it else it.take(7) }
        return try {
            val args = if (full) listOf("git", "rev-parse", "HEAD")
                       else listOf("git", "rev-parse", "--short", "HEAD")
            val out = project.providers.exec {
                commandLine(args)
                workingDir(project.projectDir)
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim()
            val hash = out.ifEmpty { UPSTREAM_COMMIT }
            if (full) hash else hash.take(minOf(hash.length, 7))
        } catch (e: Exception) {
            if (full) UPSTREAM_COMMIT else UPSTREAM_COMMIT.take(7)
        }
    }

    fun getGitBranch(project: Project, raw: Boolean = false): String? {
        val rawBranch = fromBuild("POLARIS_AC_BRANCH") ?: try {
            project.providers.exec {
                commandLine("git", "rev-parse", "--abbrev-ref", "HEAD")
                workingDir(project.projectDir)
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim().ifEmpty { "polaris" }
        } catch (e: Exception) {
            "polaris"
        }

        if (raw) return rawBranch

        val branch = rawBranch
            .replace(Regex("[^a-zA-Z0-9_.-]+"), "_")
            .replace(Regex("_{2,}"), "_")
            .trim(' ', '.', '_', '-')
            .removePrefix("heads_")

        val mainBranch = System.getenv("POLARISAC_MAIN_BRANCH") ?: "2.0"

        return when (branch) {
            "main", mainBranch -> null
            else -> branch
        }
    }

    fun getGitUser(project: Project): String {
        return try {
            project.providers.exec {
                commandLine("git", "config", "user.name")
                workingDir(project.projectDir)
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim().ifEmpty { "unknown" }
        } catch (_: Exception) {
            "unknown"
        }
    }

}
