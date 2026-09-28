// The API's Bukkit-side pieces. MIT (../api/LICENSE).
plugins {
    polarisac.`base-conventions`
}

repositories {
    maven("https://repo.papermc.io/repository/maven-public/")
    mavenCentral()
}

dependencies {
    api(project(":api"))
    api(project(":internal"))

    compileOnly(libs.paper.api)
    compileOnly(libs.jetbrains.annotations)
}
