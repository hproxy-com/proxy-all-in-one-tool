# A new IP when your script decides, from PowerShell (hproxy 0.4.9 and newer).
#
# Start the proxy so it stays on one proxy until asked:
#   hproxy connect --file proxies.txt --rotate on-failure --background
# Then:
#   pwsh new_ip.ps1

$Control = 'http://127.0.0.1:8080/hproxy' # the proxy's own address, then /hproxy

$now = Invoke-RestMethod "$Control/status"
"now:   proxy $($now.member) of $($now.members), $($now.upstream)"
# The open connections end with the switch, so the next request goes out the new way.
$after = Invoke-RestMethod -Method Post "$Control/new-ip"
"after: proxy $($after.member) of $($after.members), $($after.upstream)"
