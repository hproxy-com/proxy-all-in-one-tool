# Three requests through the rotating proxy with httr, each going out through the next proxy.
#
# Start the proxy first:  hproxy connect --file proxies.txt --background
# Then:                   Rscript example.R   (needs the httr package)
library(httr)

proxy <- use_proxy("127.0.0.1", 8080) # where hproxy connect listens

for (i in 1:3) {
  # forbid_reuse: the connection closes after the answer, so the next request opens a new one:
  # the next proxy. Leave it out to stay on the same address.
  response <- GET("https://hproxy.com/cdn-cgi/trace", proxy, config(forbid_reuse = 1L), timeout(30))
  stop_for_status(response)
  lines <- strsplit(content(response, as = "text", encoding = "UTF-8"), "\n")[[1]]
  pairs <- strsplit(lines[grepl("=", lines)], "=", fixed = TRUE)
  seen <- setNames(vapply(pairs, `[`, "", 2), vapply(pairs, `[`, "", 1))
  cat(sprintf("%d: ip=%s loc=%s\n", i, seen[["ip"]], seen[["loc"]]))
}
