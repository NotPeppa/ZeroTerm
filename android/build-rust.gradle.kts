/**
 * cargo-ndk integration for zeroterm-ffi.
 *
 * Invoked from app/build.gradle.kts. Builds libzeroterm_ffi.so for each
 * ABI, copies into jniLibs, regenerates Kotlin bindings into the app
 * source set (build-time only; committed bindings live under core/).
 *
 * 16KB page-size alignment is required for Android 15+ Play uploads.
 * cargo-ndk 3.x / NDK r28+ handle this via RUSTFLAGS when set below.
 */

import org.gradle.api.tasks.Exec
import java.io.File
import java.util.Properties

val coreDir = rootProject.projectDir.resolve("../core").canonicalFile
val ffiCrate = "zeroterm-ffi"
val libName = "zeroterm_ffi"
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs")
val generatedFfiDir = layout.projectDirectory.dir("src/main/java/com/zeroterm/ffi")

// ABI → rustc target triple
val abiTargets = mapOf(
    "arm64-v8a" to "aarch64-linux-android",
    "armeabi-v7a" to "armv7-linux-androideabi",
    "x86_64" to "x86_64-linux-android",
)

val ndkVersionProp: String = (project.findProperty("android.ndkVersion") as String?)
    ?: "28.2.13676358"

fun resolveNdkHome(): File? {
    System.getenv("ANDROID_NDK_HOME")?.let { return File(it) }
    System.getenv("NDK_HOME")?.let { return File(it) }
    val localSdk = rootProject.file("local.properties")
        .takeIf { it.isFile }
        ?.inputStream()
        ?.use { stream ->
            Properties().apply { load(stream) }.getProperty("sdk.dir")
        }
    val sdk = System.getenv("ANDROID_HOME")
        ?: System.getenv("ANDROID_SDK_ROOT")
        ?: (System.getenv("LOCALAPPDATA")?.let { "$it/Android/Sdk" })
        ?: localSdk
        ?: return null
    val ndkRoot = File(sdk, "ndk")
    val preferred = File(ndkRoot, ndkVersionProp)
    if (preferred.isDirectory) return preferred
    return ndkRoot.listFiles()?.filter { it.isDirectory }?.maxByOrNull { it.name }
}

fun cargoBin(): String {
    val home = System.getenv("CARGO_HOME")
        ?: System.getenv("USERPROFILE")?.let { "$it/.cargo" }
        ?: System.getenv("HOME")?.let { "$it/.cargo" }
    val candidates = listOfNotNull(
        home?.let { File(it, "bin/cargo-ndk.exe") },
        home?.let { File(it, "bin/cargo-ndk") },
        home?.let { File(it, "bin/cargo.exe") },
        home?.let { File(it, "bin/cargo") },
    )
    candidates.firstOrNull { it.exists() }?.let {
        return if (it.name.startsWith("cargo-ndk")) it.absolutePath else "cargo"
    }
    return "cargo"
}

val rustAbis: List<String> = (project.findProperty("zeroterm.abis") as String?)
    ?.split(",")
    ?.map { it.trim() }
    ?.filter { it.isNotEmpty() }
    ?: listOf("arm64-v8a", "x86_64") // debug default: device + emulator

val isReleaseBuild = gradle.startParameter.taskNames.any {
    it.contains("Release", ignoreCase = true)
}

val buildProfile = if (isReleaseBuild) "release" else "debug"
val buildAbis = if (isReleaseBuild) abiTargets.keys.toList() else rustAbis

tasks.register("cargoNdkBuild") {
    group = "zeroterm"
    description = "Cross-compile zeroterm-ffi for Android ABIs and copy into jniLibs"

    // The FFI library statically links the shared crates, so changes anywhere
    // under core/crates (including sync/TLS code) must invalidate this task.
    inputs.dir(coreDir.resolve("crates"))
    inputs.file(coreDir.resolve("Cargo.toml"))
    inputs.file(coreDir.resolve("Cargo.lock"))
    outputs.dir(jniLibsDir)

    doLast {
        val ndkHome = resolveNdkHome()
            ?: error(
                "Android NDK not found. Install NDK $ndkVersionProp or set ANDROID_NDK_HOME."
            )
        logger.lifecycle("Using NDK: ${ndkHome.absolutePath}")
        logger.lifecycle("Building ABIs: $buildAbis ($buildProfile)")

        // 16KB page size for Android 15+ / Play
        val pageSizeFlags = "-C link-arg=-Wl,-z,max-page-size=16384"

        for (abi in buildAbis) {
            val triple = abiTargets[abi]
                ?: error("Unknown ABI: $abi (known: ${abiTargets.keys})")
            val outDir = File(jniLibsDir.asFile, abi)
            outDir.mkdirs()

            val cargo = cargoBin()
            val useCargoNdk = cargo.contains("cargo-ndk") ||
                File(
                    System.getenv("CARGO_HOME")
                        ?: "${System.getenv("USERPROFILE") ?: System.getenv("HOME")}/.cargo",
                    if (System.getProperty("os.name").lowercase().contains("win"))
                        "bin/cargo-ndk.exe"
                    else
                        "bin/cargo-ndk",
                ).exists()

            val cmd = if (useCargoNdk) {
                mutableListOf(
                    "cargo", "ndk",
                    "-t", triple,
                    "-o", jniLibsDir.asFile.absolutePath,
                    "--platform", "26",
                    "build",
                    "-p", ffiCrate,
                ).also {
                    if (buildProfile == "release") it.add("--release")
                }
            } else {
                // Fallback: plain cargo with NDK clang as linker (requires
                // ~/.cargo/config.toml or env CC_*/CARGO_TARGET_*_LINKER).
                logger.warn(
                    "cargo-ndk not found; using plain cargo. Install with: cargo install cargo-ndk"
                )
                mutableListOf(
                    "cargo", "build",
                    "-p", ffiCrate,
                    "--target", triple,
                ).also {
                    if (buildProfile == "release") it.add("--release")
                }
            }

            project.exec {
                workingDir = coreDir
                environment("ANDROID_NDK_HOME", ndkHome.absolutePath)
                environment("ANDROID_NDK_ROOT", ndkHome.absolutePath)
                // Append page-size flags without clobbering existing RUSTFLAGS
                val existing = System.getenv("RUSTFLAGS") ?: ""
                environment(
                    "RUSTFLAGS",
                    listOf(existing, pageSizeFlags).filter { it.isNotBlank() }.joinToString(" "),
                )
                commandLine(cmd)
            }

            if (!useCargoNdk) {
                val profileDir = if (buildProfile == "release") "release" else "debug"
                val soName = "lib$libName.so"
                val built = coreDir.resolve("target/$triple/$profileDir/$soName")
                if (!built.exists()) {
                    error("Expected $built after cargo build, but file missing")
                }
                built.copyTo(File(outDir, soName), overwrite = true)
            }
        }
    }
}

tasks.register("generateKotlinBindings") {
    group = "zeroterm"
    description = "Copy committed uniffi Kotlin bindings into the app source tree"
    dependsOn("cargoNdkBuild")

    doLast {
        val src = coreDir.resolve("crates/zeroterm-ffi/bindings/kotlin/com/zeroterm/ffi")
        val dest = generatedFfiDir.asFile
        if (!src.isDirectory) {
            logger.warn("Kotlin bindings not found at $src — run uniffi-bindgen first")
            return@doLast
        }
        dest.mkdirs()
        src.walkTopDown().filter { it.isFile }.forEach { file ->
            val rel = file.relativeTo(src)
            val target = File(dest, rel.path)
            target.parentFile.mkdirs()
            file.copyTo(target, overwrite = true)
        }
        logger.lifecycle("Copied Kotlin bindings → ${dest.absolutePath}")
    }
}

tasks.register("cleanRust") {
    group = "zeroterm"
    doLast {
        jniLibsDir.asFile.deleteRecursively()
    }
}
