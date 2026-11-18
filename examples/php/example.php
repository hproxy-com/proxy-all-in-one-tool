<?php
// Three requests through the rotating proxy, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   php example.php   (with the curl extension)

const PROXY = 'http://127.0.0.1:8080'; // where hproxy connect listens

function trace(): string
{
    // A new curl handle opens a new connection, and every new connection goes out through the
    // next proxy. Reuse one handle when you want to stay on the same address.
    $ch = curl_init('https://hproxy.com/cdn-cgi/trace');
    curl_setopt_array($ch, [
        CURLOPT_PROXY => PROXY,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    $text = curl_exec($ch);
    if ($text === false) {
        throw new RuntimeException(curl_error($ch));
    }
    $seen = [];
    foreach (explode("\n", trim($text)) as $line) {
        [$key, $value] = array_pad(explode('=', $line, 2), 2, '');
        $seen[$key] = $value;
    }
    return "ip={$seen['ip']} loc={$seen['loc']}";
}

for ($i = 1; $i <= 3; $i++) {
    echo "$i: " . trace() . "\n";
}
