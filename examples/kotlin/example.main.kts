// Three requests through the rotating proxy with OkHttp, each going out through the next proxy.
// The same code works from Java, and on Android.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   kotlin example.main.kts

@file:DependsOn("com.squareup.okhttp3:okhttp:4.12.0")

import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request

val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", 8080)) // where hproxy connect listens

val client = OkHttpClient.Builder()
    .proxy(proxy)
    // OkHttp keeps idle connections for the next request, each on its proxy. With none kept, every
    // request opens its own connection: the next proxy. Leave the pool as it is to stay on the same
    // address.
    .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
    .callTimeout(30, TimeUnit.SECONDS)
    .build()

for (i in 1..3) {
    val request = Request.Builder().url("https://hproxy.com/cdn-cgi/trace").build()
    val text = client.newCall(request).execute().use { it.body!!.string() }
    val seen = text.lines().filter { "=" in it }.associate { it.substringBefore("=") to it.substringAfter("=") }
    println("$i: ip=${seen["ip"]} loc=${seen["loc"]}")
}

client.dispatcher.executorService.shutdown()
