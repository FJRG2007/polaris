// The engine as a NeoForge mod, for Minecraft 1.21.4.
//
// NeoForge runs Minecraft under Mojang's own names, so the platform code here is
// written against them directly and needs no remapping. PacketEvents has no NeoForge
// platform of its own: the one in `polaris.anticheat.platform.neoforge.packetevents` is
// its Fabric platform carried over to NeoForge (same two injection points).
//
// The jar is self-contained: the engine, PacketEvents and every library they need are
// shaded and relocated under `polaris.anticheat.shaded`, so nothing in it can clash with
// a package another mod or Minecraft itself already brings. It is nested inside the
// Polaris mod (see `polaris-neoforge/build.gradle`), which is how a server gets it.

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar

plugins {
    polarisac.`base-conventions`
    id("net.neoforged.moddev") version "2.0.147"
    id("com.gradleup.shadow")
}

val minecraftVersion = "1.21.4"
val neoVersion = "21.4.157"

repositories {
    exclusive("https://repo.codemc.io/repository/maven-releases/", { mavenContent { releasesOnly() } }) {
        includeGroup("com.github.retrooper")
    }
    exclusive("https://nexus.scarsz.me/content/repositories/releases", { mavenContent { releasesOnly() } }) {
        includeGroup("github.scarsz")
    }
    mavenCentral()
}

neoForge {
    version = neoVersion
}

// What goes into the jar. Minecraft, NeoForge and the libraries they bring are on the
// compile classpath through the plugin above and never here.
val shade: Configuration by configurations.creating {
    isCanBeConsumed = false
    isCanBeResolved = true
    // Minecraft brings its own Netty, Gson, fastutil (the same 8.5 line) and logging
    // (SLF4J included, which the database pool then logs through).
    exclude(group = "io.netty")
    exclude(group = "it.unimi.dsi")
    exclude(group = "com.google.code.gson")
    exclude(group = "org.slf4j")
}

dependencies {
    implementation(project(":common")) {
        exclude(group = "org.slf4j")
    }
    implementation(libs.packetevents.api)
    implementation("com.github.retrooper:packetevents-netty-common:${libs.versions.packetevents.get()}") {
        isTransitive = false
    }
    compileOnly(project(":internal-shims"))
    // PacketEvents' registry types carry these annotations; the registry bridge uses them.
    compileOnly("org.jspecify:jspecify:1.0.0")
    // PacketEvents' API jar leaves out the Adventure NBT module it reads registries with;
    // its Spigot build carries it in its own jar.
    implementation("net.kyori:adventure-nbt:${libs.versions.adventure.asProvider().get()}")

    shade(project(":common"))
    shade(libs.packetevents.api)
    shade("net.kyori:adventure-nbt:${libs.versions.adventure.asProvider().get()}")
    shade("com.github.retrooper:packetevents-netty-common:${libs.versions.packetevents.get()}") {
        isTransitive = false
    }
}

java.toolchain.languageVersion = JavaLanguageVersion.of(21)

tasks.withType<JavaCompile>().configureEach {
    // Minecraft 1.21.4 is compiled for Java 21.
    options.release.set(21)
}

tasks.processResources {
    val properties = mapOf(
        "version" to project.version.toString(),
        "minecraft_version" to minecraftVersion,
    )
    inputs.properties(properties)
    filesMatching("META-INF/neoforge.mods.toml") {
        expand(properties)
    }
}

tasks.named<ShadowJar>("shadowJar") {
    configurations = listOf(shade)
    archiveFileName = "polaris-anticheat-neoforge-$minecraftVersion.jar"
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

tasks.named("assemble") {
    dependsOn(tasks.named("shadowJar"))
}
