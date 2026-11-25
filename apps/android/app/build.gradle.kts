// The Hotsauce Android app: a Chrome shell (Trusted Web Activity) around the member's Hotsauce
// server, plus native home-screen widgets. docs/PLAN-android.md.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The release number (HOTSAUCE_VERSION at the repo root) gives versionName, and
// major*1_000_000 + minor*1_000 + patch the versionCode, so every release is higher (R2).
val hotsauceVersion: String = rootProject.file("../../HOTSAUCE_VERSION").readText().trim()
fun versionCodeOf(v: String): Int {
    val (major, minor, patch) = v.split(".").map { it.toInt() }
    return major * 1_000_000 + minor * 1_000 + patch
}

android {
    namespace = "work.hotsauce.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "work.hotsauce.app"
        minSdk = 26
        targetSdk = 35
        versionName = hotsauceVersion
        versionCode = versionCodeOf(hotsauceVersion)
    }

    // Release signing comes from the environment on GitHub (secrets ANDROID_UPLOAD_KEYSTORE,
    // ANDROID_UPLOAD_PASSWORD); without them the release build is left unsigned.
    val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
    signingConfigs {
        if (keystorePath != null) {
            create("upload") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = "upload"
                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystorePath != null) signingConfig = signingConfigs.getByName("upload")
        }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.glance:glance-appwidget:1.1.1")
    implementation("androidx.glance:glance-material3:1.1.1")
    testImplementation("junit:junit:4.13.2")
}
