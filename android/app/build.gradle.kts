plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

apply(from = rootProject.file("build-rust.gradle.kts"))

// AND-4: release signing must come from a real keystore supplied via env
// (typically CI). Presence of all four vars gates whether the release build
// can be signed at all — see the signingConfigs block and the guard below.
val releaseKeystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias: String? = System.getenv("ANDROID_KEY_ALIAS")
val releaseKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD")
val releaseSigningConfigured: Boolean =
    !releaseKeystorePath.isNullOrBlank() &&
        !releaseKeystorePassword.isNullOrBlank() &&
        !releaseKeyAlias.isNullOrBlank() &&
        !releaseKeyPassword.isNullOrBlank()

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
            // Overridden by build-rust; keep all three for packaging when present
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }

        externalNativeBuild {
            // none — we ship prebuilt .so from cargo-ndk
        }
    }

    signingConfigs {
        // AND-4: real release keystore, supplied via env (CI). When the env vars
        // are absent this config is left empty and the release build is failed by
        // the guard below — never signed with the shared public debug key.
        create("release") {
            if (releaseSigningConfigured) {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
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
            // AND-4: sign with the real release keystore when configured;
            // otherwise leave the build unsigned so the guard below fails it
            // with a clear message. Never fall back to the public debug key.
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
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

// AND-4: fail fast (with a clear message) if a release artifact is assembled
// without the release keystore configured, instead of falling back to the
// public debug signing key. Debug builds and config-only tasks are unaffected.
if (!releaseSigningConfigured) {
    tasks.configureEach {
        val lower = name.lowercase()
        val touchesReleaseArtifact = lower.contains("release") &&
            (lower.startsWith("assemble") || lower.startsWith("bundle") || lower.startsWith("package"))
        if (touchesReleaseArtifact) {
            doFirst {
                throw GradleException(
                    "Release signing is not configured. Set ANDROID_KEYSTORE_PATH, " +
                        "ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD " +
                        "before building a release artifact; refusing to fall back to the debug key.",
                )
            }
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

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
