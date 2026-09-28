// The anti-cheat's storage engine and event plumbing behind the API. MIT (../api/LICENSE).
plugins {
    polarisac.`base-conventions`
}

repositories {
    mavenCentral()
}

dependencies {
    api(project(":api"))

    compileOnly(libs.jetbrains.annotations)
    compileOnly(libs.sqlite.jdbc)
    compileOnly(libs.mysql.jdbc)
    compileOnly(libs.postgres.jdbc)
    compileOnly(libs.mongoDriverSync)
    compileOnly(libs.jedis)
    compileOnly(libs.hikaricp)

    api(libs.disruptor)

    testImplementation(libs.jetbrains.annotations)
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation(libs.sqlite.jdbc)
    testImplementation(libs.mysql.jdbc)
    testImplementation(libs.postgres.jdbc)
    testImplementation(libs.mongoDriverSync)
    testImplementation(libs.jedis)
    testImplementation(libs.hikaricp)
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}
