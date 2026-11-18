buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.13.2")
        // Kotlin 2.2, the newest AGP 8.13's tools read: its R8 and lint can't
        // parse 2.3+ metadata. Kotlin moves on when AGP does — and AGP 9 waits
        // on Tauri's plugins (they apply the Kotlin plugin AGP 9 refuses).
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.21")
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

