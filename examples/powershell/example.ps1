# Three requests through the rotating proxy, each going out through the next proxy.
#
# Start the proxy first:  hproxy connect --file proxies.txt --background
# Then:                   pwsh example.ps1   (PowerShell 7; Windows PowerShell 5.1 works too)

$Proxy = 'http://127.0.0.1:8080' # where hproxy connect listens

foreach ($i in 1..3) {
    # -DisableKeepAlive closes the connection after the answer, so the next request opens a new
    # one: the next proxy. Leave it out to stay on the same address.
    $text = Invoke-RestMethod -Uri 'https://hproxy.com/cdn-cgi/trace' -Proxy $Proxy -DisableKeepAlive -TimeoutSec 30
    $seen = @{}
    foreach ($line in $text -split "`n") {
        $key, $value = $line -split '=', 2
        if ($value) { $seen[$key] = $value }
    }
    "${i}: ip=$($seen.ip) loc=$($seen.loc)"
}
