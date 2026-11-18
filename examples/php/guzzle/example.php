<?php
// Three requests through the rotating proxy with Guzzle, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   composer install
//                         php example.php

require __DIR__ . '/vendor/autoload.php';

use GuzzleHttp\Client;

const PROXY = 'http://127.0.0.1:8080'; // where hproxy connect listens

$client = new Client([
    'proxy' => PROXY,
    'timeout' => 30,
    // Guzzle keeps the connection for the next request, and with it one proxy. Forbidding reuse,
    // every request opens a new connection: the next proxy. Leave this out to stay on the same
    // address.
    'curl' => [CURLOPT_FORBID_REUSE => true, CURLOPT_FRESH_CONNECT => true],
]);

for ($i = 1; $i <= 3; $i++) {
    $text = (string) $client->get('https://hproxy.com/cdn-cgi/trace')->getBody();
    $seen = [];
    foreach (explode("\n", trim($text)) as $line) {
        [$key, $value] = array_pad(explode('=', $line, 2), 2, '');
        $seen[$key] = $value;
    }
    echo "$i: ip={$seen['ip']} loc={$seen['loc']}\n";
}
