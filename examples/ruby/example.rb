# Three requests through the rotating proxy, each going out through the next proxy.
#
# Start the proxy first:  hproxy connect --file proxies.txt --background
# Then:                   ruby example.rb
require "net/http"

PROXY_HOST = "127.0.0.1" # where hproxy connect listens
PROXY_PORT = 8080

def trace
  uri = URI("https://hproxy.com/cdn-cgi/trace")
  # Net::HTTP.start opens a connection and closes it at the end of the block, so every call
  # goes out through the next proxy. Do several requests inside one block to stay on one address.
  text = Net::HTTP.start(uri.host, uri.port, PROXY_HOST, PROXY_PORT,
                         use_ssl: true, open_timeout: 30, read_timeout: 30) do |http|
    http.get(uri.path).body
  end
  seen = text.lines.map(&:chomp).select { |line| line.include?("=") }.to_h { |line| line.split("=", 2) }
  "ip=#{seen["ip"]} loc=#{seen["loc"]}"
end

(1..3).each { |i| puts "#{i}: #{trace}" }
