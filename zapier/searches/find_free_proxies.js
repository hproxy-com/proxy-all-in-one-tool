const { BASE, bodyOf, list } = require('../lib/api');

// One result holding the whole list, so later steps can use every proxy (a search only passes its first result on).
const perform = async (z, bundle) => {
  const input = bundle.inputData;
  const params = { format: 'json', limit: Math.min(10000, Math.max(1, parseInt(input.limit, 10) || 20)) };
  if (input.country) {
    const country = String(input.country).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new z.errors.Error('Enter a two-letter country code, such as US or DE.', 'InvalidData', 400);
    params.country = country;
  }
  const protocols = list(input.protocols);
  if (protocols.length) params.protocol = protocols.join(',');
  if (input.anonymity) params.anonymity = input.anonymity;
  if (input.max_latency_ms) params.max_latency_ms = parseInt(input.max_latency_ms, 10);
  if (input.min_uptime_pct) params.min_uptime_pct = Number(input.min_uptime_pct);
  if (input.sort === 'uptime') params.sort = 'uptime';
  const response = await z.request({ url: `${BASE}/api/proxy-list`, params });
  const proxies = Array.isArray(bodyOf(response)) ? bodyOf(response) : [];
  return [
    {
      id: `free-proxies-${Date.now()}`,
      count: proxies.length,
      proxy_list: proxies.map((p) => `${p.ip}:${p.port}`).join('\n'),
      proxies,
    },
  ];
};

module.exports = {
  key: 'find_free_proxies',
  noun: 'Free Proxy',
  display: {
    label: 'Find Free Proxies',
    description: "Finds working public proxies on HProxy's free proxy list, checked around the clock, filtered by country, protocol, anonymity, speed and uptime. No HProxy plan is needed.",
  },
  operation: {
    perform,
    inputFields: [
      { key: 'limit', label: 'Limit', type: 'integer', default: '20', helpText: 'The most proxies to return, from 1 to 10,000.' },
      { key: 'country', label: 'Country', helpText: 'Only proxies in this country, as a two-letter code such as US.' },
      {
        key: 'protocols',
        label: 'Protocols',
        list: true,
        choices: { http: 'HTTP', https: 'HTTPS', socks4: 'SOCKS4', socks5: 'SOCKS5' },
        helpText: 'Only proxies that support at least one of these protocols.',
      },
      {
        key: 'anonymity',
        label: 'Anonymity',
        choices: { elite: 'Elite', anonymous: 'Anonymous', transparent: 'Transparent' },
        helpText: 'Elite hides your IP and that a proxy is in use; anonymous hides your IP; transparent passes it on.',
      },
      { key: 'max_latency_ms', label: 'Max Latency (ms)', type: 'integer', helpText: 'Only proxies that answered within this many milliseconds.' },
      { key: 'min_uptime_pct', label: 'Min Uptime (%)', type: 'number', helpText: 'Only proxies whose lifetime uptime is at least this percentage.' },
      {
        key: 'sort',
        label: 'Sort By',
        choices: { statusAndSpeed: 'Status and speed (answering now, fastest first)', uptime: 'Uptime (most reliable first)' },
        default: 'statusAndSpeed',
        helpText: 'The order of the whole list, before the limit applies.',
      },
    ],
    sample: {
      id: 'free-proxies-1794400000000',
      count: 2,
      proxy_list: '203.0.113.7:8080\n198.51.100.23:1080',
      proxies: [
        { ip: '203.0.113.7', port: 8080, protocols: ['http'], anonymity: 'elite', country_code: 'US', latency_ms: 120, uptime_pct: 98.5 },
        { ip: '198.51.100.23', port: 1080, protocols: ['socks5'], anonymity: 'elite', country_code: 'DE', latency_ms: 210, uptime_pct: 91 },
      ],
    },
    outputFields: [
      { key: 'count', label: 'Proxies Found', type: 'integer' },
      { key: 'proxy_list', label: 'Proxy List (ip:port per line)' },
    ],
  },
};
