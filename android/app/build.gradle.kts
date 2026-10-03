plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

apply(from = rootProject.file("build-rust.gradle.kts"))
apply(from = rootProject.file("release-signing.gradle.kts"))

@Suppress("UNCHECKED_CAST")
val releaseSigning = project.extra["zeroterm.releaseSigning"] as Map<String, String>

android {
    namespace = "com.zeroterm.android"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.zeroterm.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 111
        versionName = "0.1.11"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // Package only libraries rebuilt for this invocation; stale libraries
            // for other ABIs may have incompatible UniFFI checksums.
            @Suppress("UNCHECKED_CAST")
            val builtAbis = project.extra["zeroterm.buildAbis"] as List<String>
            abiFilters += builtAbis
        }

        externalNativeBuild {
            // none — we ship prebuilt .so from cargo-ndk
        }
    }

    signingConfigs {
        create("release") {
            if (releaseSigning.isNotEmpty()) {
                storeFile = file(releaseSigning.getValue("ANDROID_KEYSTORE_PATH"))
                storePassword = releaseSigning.getValue("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = releaseSigning.getValue("ANDROID_KEY_ALIAS")
                keyPassword = releaseSigning.getValue("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        jniLibs {
            useLegacyPackaging = false
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs")
            // uniffi bindings live under com.zeroterm.ffi (copied / committed)
            java.srcDirs("src/main/java")
        }
    }
}

// Hook cargo-ndk before Java compile so .so + bindings are ready
tasks.named("preBuild").configure {
    dependsOn("generateKotlinBindings")
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.5")

    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // uniffi Kotlin runtime uses JNA
    implementation("net.java.dev.jna:jna:5.15.0@aar")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
