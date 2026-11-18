// Three requests through the rotating proxy, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then (.NET 8 or newer): dotnet run

using System.Net;

const string Proxy = "http://127.0.0.1:8080"; // where hproxy connect listens

using var client = new HttpClient(new HttpClientHandler { Proxy = new WebProxy(Proxy), UseProxy = true })
{
    Timeout = TimeSpan.FromSeconds(30),
};

for (var i = 1; i <= 3; i++)
{
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://hproxy.com/cdn-cgi/trace");
    // HttpClient keeps its connection, and with it one proxy. Closed after each answer, the next
    // request opens a new connection: the next proxy. Leave this out to stay on the same address.
    request.Headers.ConnectionClose = true;
    using var response = await client.SendAsync(request);
    var seen = (await response.Content.ReadAsStringAsync())
        .Split('\n')
        .Select(line => line.Split('=', 2))
        .Where(pair => pair.Length == 2)
        .ToDictionary(pair => pair[0], pair => pair[1]);
    Console.WriteLine($"{i}: ip={seen["ip"]} loc={seen["loc"]}");
}
