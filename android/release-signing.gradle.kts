import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import java.util.Properties

val signingNames = listOf(
    "ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD",
)
val suppliedSigning = signingNames.associateWith { System.getenv(it).orEmpty() }
val needsReleaseSigning = gradle.startParameter.taskNames.any {
    it.contains("release", ignoreCase = true) ||
        it.substringAfterLast(':') in listOf("build", "buildNeeded", "buildDependents", "assemble", "bundle", "install")
}
val signingRoot = (findProperty("zeroterm.signingDir") as String?)?.let(::file)
    ?: java.io.File(System.getProperty("user.home"), ".zeroterm/android-signing/com.zeroterm.android")

fun privatePermissions(path: java.nio.file.Path, permissions: String) {
    if (Files.getFileStore(path).supportsFileAttributeView("posix")) {
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions))
    }
}

fun localSigning(): Map<String, String> {
    val root = signingRoot.toPath()
    Files.createDirectories(root)
    privatePermissions(root, "rwx------")
    val lockPath = root.resolve("signing.lock")
    FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
        privatePermissions(lockPath, "rw-------")
        channel.lock().use {
            val identity = root.resolve("identity")
            if (!Files.exists(identity)) {
                val staging = Files.createTempDirectory(root, ".creating-")
                try {
                    val passwordBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
                    val password = Base64.getUrlEncoder().withoutPadding().encodeToString(passwordBytes)
                    val keytool = java.io.File(System.getProperty("java.home"), "bin/keytool" +
                        if (System.getProperty("os.name").startsWith("Windows")) ".exe" else "")
                    val process = ProcessBuilder(
                        keytool.absolutePath, "-genkeypair", "-noprompt", "-storetype", "JKS",
                        "-keystore", staging.resolve("release.jks").toString(),
                        "-alias", "zeroterm", "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
                        "-dname", "CN=ZeroTerm, O=ZeroTerm",
                        "-storepass:env", "ZEROTERM_SIGNING_PASSWORD", "-keypass:env", "ZEROTERM_SIGNING_PASSWORD",
                    ).redirectErrorStream(true)
                    process.environment()["ZEROTERM_SIGNING_PASSWORD"] = password
                    val child = process.start()
                    child.inputStream.use { it.readBytes() }
                    check(child.waitFor() == 0) { "Could not generate the Android signing key with keytool." }
                    val credentials = Properties().apply {
                        setProperty("storePassword", password)
                        setProperty("keyAlias", "zeroterm")
                        setProperty("keyPassword", password)
                    }
                    Files.newOutputStream(staging.resolve("credentials.properties")).use {
                        credentials.store(it, "ZeroTerm Android release signing. Keep this directory backed up.")
                    }
                    privatePermissions(staging.resolve("release.jks"), "rw-------")
                    privatePermissions(staging.resolve("credentials.properties"), "rw-------")
                    // Publish the key and credentials together while holding the lock.
                    Files.move(staging, identity)
                    logger.lifecycle("Created a persistent Android release signing key at $identity")
                } finally {
                    staging.toFile().deleteRecursively()
                }
            }
            val store = identity.resolve("release.jks")
            val credentialsFile = identity.resolve("credentials.properties")
            check(Files.isRegularFile(store) && Files.isRegularFile(credentialsFile)) {
                "Android signing files are incomplete at $identity. Restore the backup; do not generate a replacement key."
            }
            privatePermissions(identity, "rwx------")
            privatePermissions(store, "rw-------")
            privatePermissions(credentialsFile, "rw-------")
            val credentials = Properties().apply { Files.newInputStream(credentialsFile).use { load(it) } }
            val values = listOf("storePassword", "keyAlias", "keyPassword").associateWith {
                credentials.getProperty(it).orEmpty().also { value ->
                    check(value.isNotBlank()) { "Android signing credentials are incomplete at $identity." }
                }
            }
            // Corrupt or mismatched credentials must fail instead of changing the signing identity.
            val keystore = KeyStore.getInstance("JKS")
            Files.newInputStream(store).use { keystore.load(it, values.getValue("storePassword").toCharArray()) }
            check(keystore.getKey(values.getValue("keyAlias"), values.getValue("keyPassword").toCharArray()) != null) {
                "Android signing key is missing from $store."
            }
            return mapOf(
                "ANDROID_KEYSTORE_PATH" to store.toString(),
                "ANDROID_KEYSTORE_PASSWORD" to values.getValue("storePassword"),
                "ANDROID_KEY_ALIAS" to values.getValue("keyAlias"),
                "ANDROID_KEY_PASSWORD" to values.getValue("keyPassword"),
            )
        }
    }
}

val resolvedSigning = when {
    suppliedSigning.values.all { it.isNotBlank() } -> suppliedSigning
    !needsReleaseSigning -> emptyMap()
    suppliedSigning.values.any { it.isNotBlank() } -> throw GradleException(
        "Android signing environment is incomplete. Supply all four ANDROID_KEYSTORE/KEY variables or unset all of them for automatic local signing.",
    )
    System.getenv("CI") == "true" || System.getenv("GITHUB_ACTIONS") == "true" -> throw GradleException(
        "CI must restore the persistent Android signing key. Run scripts/setup-android-signing.py once on your computer to configure the repository automatically.",
    )
    else -> localSigning()
}
// Gradle's properties report must not print signing passwords.
extra["zeroterm.releaseSigning"] = object : Map<String, String> by resolvedSigning {
    override fun toString() = "Android release signing (private)"
}

tasks.register("prepareReleaseSigning") {
    group = "zeroterm"
    description = "Create or reuse the persistent local Android release signing key"
    doLast {
        check(resolvedSigning.isNotEmpty()) { "Android release signing is unavailable." }
        logger.lifecycle("Android release signing ready: ${resolvedSigning.getValue("ANDROID_KEYSTORE_PATH")}")
    }
}
