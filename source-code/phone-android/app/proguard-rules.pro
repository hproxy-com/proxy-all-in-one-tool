# The engine (libhproxy_mobile.so) calls into these by name (proxy-engine/hproxy-mobile,
# jni_glue.rs), so they keep their names and members.
-keep class com.hproxy.app.engine.Native { *; }
-keep class com.hproxy.app.vpn.OwnerLookup {
    public int uid(boolean, byte[], int, byte[], int);
}
-keepclasseswithmembernames class * {
    native <methods>;
}
