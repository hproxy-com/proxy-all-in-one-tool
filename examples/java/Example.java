// Three requests through the rotating proxy, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then (Java 11 or newer): java Example.java

import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class Example {
    // Where hproxy connect listens.
    static final InetSocketAddress PROXY = new InetSocketAddress("127.0.0.1", 8080);

    public static void main(String[] args) throws Exception {
        for (int i = 1; i <= 3; i++) {
            System.out.println(i + ": " + trace());
        }
    }

    static String trace() throws Exception {
        // An HttpClient keeps its connections, and with them their proxy. A new client for each
        // request opens a new connection: the next proxy. Keep one client when you want to stay
        // on the same address.
        HttpClient client = HttpClient.newBuilder()
                .proxy(ProxySelector.of(PROXY))
                .connectTimeout(Duration.ofSeconds(30))
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://hproxy.com/cdn-cgi/trace"))
                .timeout(Duration.ofSeconds(30))
                .build();
        String text = client.send(request, HttpResponse.BodyHandlers.ofString()).body();
        String ip = "?";
        String loc = "?";
        for (String line : text.split("\n")) {
            if (line.startsWith("ip=")) ip = line.substring(3);
            if (line.startsWith("loc=")) loc = line.substring(4);
        }
        return "ip=" + ip + " loc=" + loc;
    }
}
