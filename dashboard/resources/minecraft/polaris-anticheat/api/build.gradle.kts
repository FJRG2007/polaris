// The anti-cheat's public API: checks, events, storage contracts. MIT (LICENSE).
plugins {
    polarisac.`base-conventions`
}

repositories {
    mavenCentral()
}

dependencies {
    compileOnly(project(":internal-shims"))
    compileOnly(libs.jetbrains.annotations)

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}
