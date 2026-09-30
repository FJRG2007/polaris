import net.minecrell.pluginyml.bukkit.BukkitPluginDescription.Permission
import versioning.BuildConfig
import java.util.zip.ZipFile

plugins {
    `maven-publish`
    polarisac.`base-conventions`
    polarisac.`shadow-conventions`
    id("de.eldoria.plugin-yml.bukkit") version "0.8.0"
    id("xyz.jpenilla.run-paper") version "3.0.0-beta.1"
}

repositories {
    // Exclusive Repositories (One HTTP request per dep)
    exclusive("https://repo.papermc.io/repository/maven-public/", { name = "papermc" }) {
        includeGroup("io.papermc.paper")
        includeGroup("net.md-5")
    }

    exclusive("https://libraries.minecraft.net", { mavenContent { releasesOnly() } }) {
        includeModule("com.mojang", "brigadier")
    }

    exclusive("https://repo.extendedclip.com/content/repositories/placeholderapi/") {
        includeGroup("me.clip")
    }

    // PacketEvents, from its own repository.
    exclusive("https://repo.codemc.io/repository/maven-releases/", { mavenContent { releasesOnly() } }) {
        includeGroup("com.github.retrooper")
    }

    exclusive("https://nexus.scarsz.me/content/repositories/releases", { mavenContent { releasesOnly() } }) {
        includeGroup("github.scarsz")
    }

    mavenCentral()
}

val configuredLiteSharedProviderJar = providers.gradleProperty("polarisac.liteSharedProviderJar")
    .orElse(providers.gradleProperty("liteSharedProviderJar"))

// PE's published Spigot artifact is thin. Its runtime jar bundles these modules,
// with text serializers relocated into PE's own namespace.
val liteSharedLibraries by configurations.creating {
    isCanBeConsumed = false
    isTransitive = false
}
val liteCatalog = extensions.getByType<VersionCatalogsExtension>().named("libs")
if (!BuildConfig.shadePE) {
    val adventureVersion = liteCatalog.findVersion("adventure").get().requiredVersion
    val examinationVersion = liteCatalog.findVersion("examination").get().requiredVersion
    for (module in listOf("adventure-api", "adventure-key", "adventure-nbt")) {
        dependencies.add(liteSharedLibraries.name, "net.kyori:$module:$adventureVersion")
    }
    for (module in listOf("examination-api", "examination-string")) {
        dependencies.add(liteSharedLibraries.name, "net.kyori:$module:$examinationVersion")
    }
}

val liteSharedPrefixes = listOf(
    "net/kyori/adventure/",
    "net/kyori/examination/",
    "net/kyori/option/",
)

var cachedLiteSharedProviderClassEntries: Set<String>? = null
var cachedLiteSharedProviderFiles: List<File>? = null

fun liteSharedProviderFiles(): List<File> {
    cachedLiteSharedProviderFiles?.let { return it }

    val configured = configuredLiteSharedProviderJar.orNull
        ?.split(File.pathSeparator)
        ?.filter { it.isNotBlank() }
        ?.map { file(it) }
        ?.takeIf { it.isNotEmpty() }

    val files = configured ?: liteSharedLibraries.resolve().toList()

    cachedLiteSharedProviderFiles = files
    return files
}

fun liteSharedProviderClassEntries(): Set<String> {
    cachedLiteSharedProviderClassEntries?.let { return it }

    val entries = liteSharedProviderFiles().flatMap { jar ->
        ZipFile(jar).use { zip ->
            zip.entries().asSequence()
                .map { it.name }
                .filter { name ->
                    name.endsWith(".class") && liteSharedPrefixes.any(name::startsWith) &&
                        !name.startsWith("net/kyori/adventure/text/serializer/")
                }
                .toList()
        }
    }.toSet()

    cachedLiteSharedProviderClassEntries = entries
    return entries
}


// Chat moderation: the same engine as the Polaris mod's, from its shared sources.
sourceSets {
    main {
        java {
            srcDir("../../polaris-common/src/chat/java")
        }
    }
}

// Formatting is checked on this module's own sources: the shared ones above sit
// outside it, which the formatter refuses to touch.
spotless {
    java {
        target("src/**/*.java")
    }
}

dependencies {
    compileOnly(libs.paper.api)
    compileOnly(libs.placeholderapi)
    compileOnly(libs.luckperms)

    if (BuildConfig.shadePE) {
        implementation(libs.packetevents.spigot)
    } else {
        compileOnly(libs.packetevents.spigot)
    }
    implementation(libs.cloud.paper)
    implementation(libs.adventure.platform.bukkit)
    implementation(project(":bukkit-internal"))

    implementation(project(":common"))
    shadow(project(":common"))
}

bukkit {
    name = "PolarisAC"
    author = "PolarisAC"
    main = "polaris.anticheat.platform.bukkit.PolarisACBukkitLoaderPlugin"
    apiVersion = "1.13"
    foliaSupported = true

    if (!BuildConfig.shadePE) {
        depend = listOf("packetevents")
    }

    softDepend = listOf(
        "ProtocolLib",
        "ProtocolSupport",
        "Essentials",
        "ViaVersion",
        "ViaBackwards",
        "ViaRewind",
        "Geyser-Spigot",
        "floodgate",
        "FastLogin",
        "PlaceholderAPI",
        "LuckPerms",
        // Driver holder mods — softdepend so each backend's driver class
        // resolves through the linked classloader.
        "sqlite-jdbc",
        "mysql-jdbc",
        "postgresql-jdbc",
        "mongodb-driver",
        "jedis",
    )

    permissions {
        register("polarisac.alerts") {
            description = "Receive alerts for violations"
            default = Permission.Default.OP
        }

        register("polarisac.alerts.enable-on-join") {
            description = "Enable alerts on join"
            default = Permission.Default.OP
        }

        register("polarisac.performance") {
            description = "Check performance metrics"
            default = Permission.Default.OP
        }

        register("polarisac.profile") {
            description = "Check user profile"
            default = Permission.Default.OP
        }

        register("polarisac.brand") {
            description = "Show client brands on join"
            default = Permission.Default.OP
        }

        register("polarisac.brand.enable-on-join") {
            description = "Enable showing client brands on join"
            default = Permission.Default.OP
        }

        register("polarisac.sendalert") {
            description = "Send cheater alert"
            default = Permission.Default.OP
        }

        register("polarisac.nosetback") {
            description = "Disable setback"
            default = Permission.Default.FALSE
        }

        register("polarisac.nomodifypacket") {
            description = "Disable modifying packets"
            default = Permission.Default.FALSE
        }

        register("polarisac.disabled") {
            description = "Disable Polaris checks while keeping player state tracked"
            default = Permission.Default.FALSE
        }

        register("polarisac.exempt") {
            description = "Exempt from all checks"
            default = Permission.Default.FALSE
        }

        register("polarisac.verbose") {
            description = "Receive verbose alerts for violations"
            default = Permission.Default.OP
        }

        register("polarisac.verbose.enable-on-join") {
            description =
                "Enable verbose alerts on join"
            default = Permission.Default.FALSE
        }

        register("polarisac.list") {
            description =
                "Shows lists of specific data"
            default = Permission.Default.FALSE
        }

    }
}

publishing.publications.create<MavenPublication>("maven") {
    artifact(tasks["shadowJar"])
}

tasks {
    // 1.8.8 - 1.16.5   = Java 8
    // 1.17             = Java 16
    // 1.18 - 1.20.4    = Java 17
    // 1.20.5 - 1.21.11 = Java 21
    // 26.1+            = Java 25
    val version = "26.2"
    val javaVersion = JavaLanguageVersion.of(25)

    val jvmArgsExternal = listOf(
        "-Dcom.mojang.eula.agree=true",
        "-Dpaper.explicit-flush=true",
        "-DPaper.IgnoreJavaVersion=true"
    )

    runServer {
        minecraftVersion(version)
        runDirectory = projectDir.resolve("run/$version")

        val javaToolchains = project.extensions.getByType<JavaToolchainService>()
        javaLauncher = javaToolchains.launcherFor {
            vendor = JvmVendorSpec.JETBRAINS
            languageVersion = javaVersion
        }

        jvmArgs = jvmArgsExternal
    }

    shadowJar {
        exclude("META-INF/services/javax.annotation.processing.Processor")

        if (!BuildConfig.shadePE) {
            inputs.files(provider { liteSharedProviderFiles() }).withPropertyName("liteSharedProviders")
            exclude {
                val path = it.path
                path.endsWith(".class") && path in liteSharedProviderClassEntries()
            }

            doFirst {
                logger.lifecycle(
                    "Excluding ${liteSharedProviderClassEntries().size} shared class entries supplied by PacketEvents: " +
                        liteSharedProviderFiles().joinToString { it.name }
                )
            }
        }

        manifest {
            attributes["paperweight-mappings-namespace"] = "mojang"
        }
    }
}
