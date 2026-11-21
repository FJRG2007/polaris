// The engine as a Forge mod. One jar per Forge era, picked with `-Pforge_era=`:
// `1.20.1` (the default) is Minecraft 1.20.1 on Forge 47.
//
// Forge on these releases runs Minecraft under its SRG names, so the platform code is
// written against Mojang's names and the jar is reobfuscated to SRG after it is shaded
// (the mixin's refmap carries the same mapping). PacketEvents has no Forge platform of
// its own: `polaris.anticheat.platform.forge.packetevents` is its Fabric platform
// carried over, as the NeoForge module does it, hooked where these releases build a
// connection.
//
// The jar is self-contained, like the NeoForge one: the engine, PacketEvents and their
// libraries are shaded and relocated under `polaris.anticheat.shaded`. It is not nested
// in another mod: Polaris puts it on a Forge server's mod list on its own.

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar

plugins {
    polarisac.`base-conventions`
    id("net.neoforged.moddev.legacyforge") version "2.0.148"
    id("com.gradleup.shadow")
}

/** The Minecraft release built against, the Forge build, and the releases the jar loads on. */
data class ForgeEra(val minecraft: String, val forge: String, val minecraftRange: String, val forgeRange: String)

val eras = mapOf(
    "1.20.1" to ForgeEra("1.20.1", "1.20.1-47.4.29", "[1.20.1]", "[47,48)"),
)
val era = eras.getValue(providers.gradleProperty("forge_era").getOrElse("1.20.1"))

repositories {
    exclusive("https://repo.codemc.io/repository/maven-releases/", { mavenContent { releasesOnly() } }) {
        includeGroup("com.github.retrooper")
    }
    exclusive("https://nexus.scarsz.me/content/repositories/releases", { mavenContent { releasesOnly() } }) {
        includeGroup("github.scarsz")
    }
    mavenCentral()
}

legacyForge {
    version = era.forge
}

mixin {
    add(sourceSets.main.get(), "polarisac.refmap.json")
    config("polarisac.mixins.json")
}

// What goes into the jar. Minecraft, Forge and the libraries they bring are on the
// compile classpath through the plugin above and never here.
val shade: Configuration by configurations.creating {
    isCanBeConsumed = false
    isCanBeResolved = true
    // Minecraft brings its own Netty, Gson, fastutil and logging (SLF4J included).
    exclude(group = "io.netty")
    exclude(group = "it.unimi.dsi")
    exclude(group = "com.google.code.gson")
    exclude(group = "org.slf4j")
}

dependencies {
    annotationProcessor("org.spongepowered:mixin:0.8.5:processor")
    implementation(project(":common")) {
        exclude(group = "org.slf4j")
    }
    implementation(libs.packetevents.api)
    implementation("com.github.retrooper:packetevents-netty-common:${libs.versions.packetevents.get()}") {
        isTransitive = false
    }
    compileOnly(project(":internal-shims"))
    compileOnly("org.jspecify:jspecify:1.0.0")
    implementation("net.kyori:adventure-nbt:${libs.versions.adventure.asProvider().get()}")

    shade(project(":common"))
    shade(libs.packetevents.api)
    shade("net.kyori:adventure-nbt:${libs.versions.adventure.asProvider().get()}")
    shade("com.github.retrooper:packetevents-netty-common:${libs.versions.packetevents.get()}") {
        isTransitive = false
    }
}

// Built on the image's Java 21 and compiled for 17, so no second JDK is fetched.
java.toolchain.languageVersion = JavaLanguageVersion.of(21)

tasks.withType<JavaCompile>().configureEach {
    // Forge 47 runs on Java 17, the engine's own target.
    options.release.set(17)
}

tasks.processResources {
    val properties = mapOf(
        "version" to project.version.toString(),
        "minecraft_range" to era.minecraftRange,
        "forge_range" to era.forgeRange,
    )
    inputs.properties(properties)
    filesMatching("META-INF/mods.toml") {
        expand(properties)
    }
}

val shadowJar = tasks.named<ShadowJar>("shadowJar") {
    configurations = listOf(shade)
    archiveFileName = "polaris-anticheat-forge-${era.minecraft}-dev.jar"
    manifest.attributes("MixinConfigs" to "polarisac.mixins.json")
    // The mixin's refmap (Mojang names to SRG) is generated beside the classes and
    // only the plain jar picks it up by itself.
    from(tasks.named<Jar>("jar").map { zipTree(it.archiveFile) }) {
        include("polarisac.refmap.json")
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    exclude("META-INF/services/javax.annotation.processing.Processor")
    exclude("META-INF/versions/*/module-info.class", "module-info.class")
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA")

    // Everything that is not Polaris's own goes under one prefix: a mod jar shares
    // one module layer with every other mod, where two jars holding the same package
    // stop the server from starting.
    val prefix = "polaris.anticheat.shaded"
    relocate("io.github.retrooper.packetevents", "$prefix.io.github.retrooper.packetevents")
    relocate("com.github.retrooper.packetevents", "$prefix.com.github.retrooper.packetevents")
    relocate("net.kyori", "$prefix.kyori")
    relocate("club.minnced", "$prefix.discord-webhooks")
    relocate("github.scarsz.configuralize", "$prefix.configuralize")
    relocate("com.github.puregero", "$prefix.com.github.puregero")
    relocate("alexh", "$prefix.maps")
    relocate("okhttp3", "$prefix.okhttp3")
    relocate("okio", "$prefix.okio")
    relocate("org.yaml.snakeyaml", "$prefix.snakeyaml")
    relocate("org.json", "$prefix.json")
    relocate("org.intellij", "$prefix.intellij")
    relocate("org.jetbrains.annotations", "$prefix.jetbrains.annotations")
    relocate("org.incendo", "$prefix.incendo")
    relocate("io.leangen.geantyref", "$prefix.geantyref")
    relocate("com.zaxxer", "$prefix.zaxxer")
    relocate("com.lmax", "$prefix.lmax")
    relocate("org.jspecify", "$prefix.jspecify")
    mergeServiceFiles()
}

// Shaded first, then renamed to the SRG names Forge runs these releases under. The
// engine and the shaded libraries name nothing of Minecraft's, so only the platform
// code changes.
val reobfShadowJar = obfuscation.reobfuscate(shadowJar, sourceSets.main.get()) {
    archiveFileName = "polaris-anticheat-forge-${era.minecraft}.jar"
}

tasks.named("assemble") {
    dependsOn(reobfShadowJar)
}
