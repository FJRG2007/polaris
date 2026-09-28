import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar
import versioning.BuildConfig

plugins {
    id("com.gradleup.shadow")
}

tasks.named<ShadowJar>("shadowJar") {
    minimize {
        // adventure's DataComponentValueConverter gson provider is only referenced via
        // ServiceLoader, so minimize() strips it and adventure's static init then throws
        // (ServiceConfigurationError) on enable. Keep the gson serializer's classes.
        exclude(dependency("net.kyori:adventure-text-serializer-gson:.*"))
        // slf4j-jdk14's provider is reached only through ServiceLoader, so minimize()
        // drops it and the shaded slf4j goes back to printing that it found no providers.
        exclude(dependency("org.slf4j:slf4j-jdk14:.*"))
    }
    archiveFileName = "${rootProject.name}-${project.name}-${rootProject.version}.jar"
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE

    if (BuildConfig.relocate) {
        if (BuildConfig.shadePE) {
            relocate("io.github.retrooper.packetevents", "polaris.anticheat.shaded.io.github.retrooper.packetevents")
            relocate("com.github.retrooper.packetevents", "polaris.anticheat.shaded.com.github.retrooper.packetevents")
            relocate("net.kyori", "polaris.anticheat.shaded.kyori") // use PE's built-in adventure instead when not shading PE
        }
        relocate("club.minnced", "polaris.anticheat.shaded.discord-webhooks")
        relocate("org.slf4j", "polaris.anticheat.shaded.slf4j") // Required by HikariCP; slf4j-jdk14 ships beside it as the provider
        relocate("github.scarsz.configuralize", "polaris.anticheat.shaded.configuralize")
        relocate("com.github.puregero", "polaris.anticheat.shaded.com.github.puregero")
        relocate("com.google.code.gson", "polaris.anticheat.shaded.gson")
        relocate("alexh", "polaris.anticheat.shaded.maps")
        relocate("it.unimi.dsi.fastutil", "polaris.anticheat.shaded.fastutil")
        relocate("okhttp3", "polaris.anticheat.shaded.okhttp3")
        relocate("okio", "polaris.anticheat.shaded.okio")
        relocate("org.yaml.snakeyaml", "polaris.anticheat.shaded.snakeyaml")
        relocate("org.json", "polaris.anticheat.shaded.json")
        relocate("org.intellij", "polaris.anticheat.shaded.intellij")
        relocate("org.jetbrains", "polaris.anticheat.shaded.jetbrains")
        relocate("org.incendo", "polaris.anticheat.shaded.incendo")
        relocate("io.leangen.geantyref", "polaris.anticheat.shaded.geantyref") // Required by cloud
        relocate("com.zaxxer", "polaris.anticheat.shaded.zaxxer") // Database history
    }
    mergeServiceFiles()
}

tasks.named("assemble") {
    dependsOn(tasks.named("shadowJar"))
}
