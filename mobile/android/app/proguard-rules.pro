# Shrink, but keep names: crash reports from a sideloaded app arrive as screenshots.
-dontobfuscate
# The page calls these by name through the JavaScript bridge.
-keepclassmembers class app.polaris.mobile.PageBridge {
    @android.webkit.JavascriptInterface <methods>;
}
# The WireGuard tunnel library: its Go half calls back into these classes by name over JNI.
-keep class com.wireguard.android.backend.** { *; }
