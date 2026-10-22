# The engine (libhproxy_mobile.so) calls into these by name (proxy-engine/hproxy-mobile,
# jni_glue.rs), so they keep their names and members.
-keep class com.hproxy.app.engine.Native { *; }
-keep class com.hproxy.app.vpn.OwnerLookup {
    public int uid(boolean, byte[], int, byte[], int);
}
-keepclasseswithmembernames class * {
    native <methods>;
}

# Google's QR scanner (ML Kit) finds its parts by name and makes each with its empty constructor
# (com.google.firebase.components.ComponentDiscovery). The library's own rule keeps the classes
# only, and AGP 9's R8 no longer keeps a constructor with its class (strict full mode): without
# this, "Scan a QR" finds no scanner (NoSuchMethodException ...Registrar.<init> in the log).
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    <init>();
}
