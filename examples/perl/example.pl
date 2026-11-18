#!/usr/bin/env perl
# Three requests through the rotating proxy with LWP, each going out through the next proxy.
#
# Start the proxy first:  hproxy connect --file proxies.txt --background
# Then:                   perl example.pl   (needs LWP::UserAgent and LWP::Protocol::https)
use strict;
use warnings;
use LWP::UserAgent;

my $proxy = 'http://127.0.0.1:8080';    # where hproxy connect listens

# keep_alive => 0: every request opens its own connection, so every request goes out through the
# next proxy. Set it to 1 to stay on the same address.
my $ua = LWP::UserAgent->new(keep_alive => 0, timeout => 30);
$ua->proxy([ 'http', 'https' ], $proxy);

for my $i (1 .. 3) {
    my $response = $ua->get('https://hproxy.com/cdn-cgi/trace');
    die "$i: " . $response->status_line . "\n" unless $response->is_success;
    my %seen = map { split /=/, $_, 2 } grep { /=/ } split /\n/, $response->decoded_content;
    print "$i: ip=$seen{ip} loc=$seen{loc}\n";
}
