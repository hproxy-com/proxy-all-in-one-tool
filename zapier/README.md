# HProxy for Zapier

The Zapier integration of [HProxy](https://hproxy.com/residential-proxies), which sells
[residential proxies](https://hproxy.com/residential-proxies) by the GB: rotating and sticky IPs from 30M+ real devices
in 200+ countries, with country, state, city and ISP targeting and no subscription.

## What it does

| Step | Kind | What it does |
| --- | --- | --- |
| New Plan | Trigger | Starts a Zap when a new proxy plan appears on your HProxy account. |
| Find Plan | Search | A plan with the traffic it has left, read live from the network. |
| Find Plan Traffic | Search | The traffic one plan used over the last 1 to 30 days. |
| Generate Proxy Lines | Action | Ready-to-use lines (`host:port:username:password`), rotating or sticky, with targeting. |
| Find IP Address | Search | Country, region, network and ISP of an IP address. No plan needed. |
| Find Free Proxies | Search | Working public proxies from the [free proxy list](https://hproxy.com/free-proxy-list). No plan needed. |
| Check Proxies | Action | Tests up to 1,000 proxies live. No plan needed. |

Connect it with an API key from your HProxy dashboard (Settings > API keys). The API is documented at
[hproxy.com/docs](https://hproxy.com/docs).

## Development

Built on `zapier-platform-core`. The GitHub workflow validates the integration with Zapier's checks and runs the steps
against hproxy.com on every push; a manual run with "push" uploads the version to Zapier.

MIT licence.
