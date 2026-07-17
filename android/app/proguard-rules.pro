# JNA / uniffi
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class com.zeroterm.ffi.** { *; }
-dontwarn java.awt.**
-dontwarn javax.swing.**

# EncryptedSharedPreferences / Tink
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# Keep Parcelable/Serializable used by navigation/saved state
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}
