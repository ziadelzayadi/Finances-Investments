plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Each GitHub build gets a higher version number so a new APK installs as an update.
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "com.ziad.myspending"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ziad.myspending"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // A fixed signing key, so every new build installs over the old one
    // and your data is kept. Do not install this app from anywhere except
    // your own GitHub "Releases" page.
    signingConfigs {
        create("fixed") {
            storeFile = file("signing.keystore")
            storePassword = "myspending"
            keyAlias = "myspending"
            keyPassword = "myspending"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("fixed")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("fixed")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
