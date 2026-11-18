buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // A newer R8 (the release build's shrinker) than AGP 8.13 bundles: its
        // own can't read the metadata Kotlin 2.4 writes. Listed before AGP so
        // it takes precedence.
        classpath("com.android.tools:r8:9.5.29")
        classpath("com.android.tools.build:gradle:8.13.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

