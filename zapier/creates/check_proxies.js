const { BASE, bodyOf, list } = require('../lib/api');

const perform = async (z, bundle) => {
  const proxies = list(bundle.inputData.proxies);
  if (!proxies.length) throw new z.errors.Error('Enter at least one proxy, such as 203.0.113.7:1080.', 'InvalidData', 400);
  if (proxies.length > 1000) throw new z.errors.Error(`One check takes up to 1,000 proxies; this list holds ${proxies.length}.`, 'InvalidData', 400);
  const response = await z.request({ url: `${BASE}/api/proxy-check`, method: 'POST', body: { proxies } });
  const answer = bodyOf(response) || {};
  const results = Array.isArray(answer.results) ? answer.results : [];
  const alive = results.filter((r) => r && r.alive === true);
  return {
    checked: results.length,
    alive: alive.length,
    alive_list: alive.map((r) => r.input).filter(Boolean).join('\n'),
    complete: answer.complete !== false,
    results,
  };
};

module.exports = {
  key: 'check_proxies',
  noun: 'Proxy Check',
  display: {
    label: 'Check Proxies',
    description: 'Tests up to 1,000 proxies live and returns which answer, with their protocols, anonymity, speed and location. No HProxy plan is needed.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'proxies',
        label: 'Proxies',
        required: true,
        list: true,
        helpText: 'Up to 1,000 proxies written as ip:port, host:port:user:pass or user:pass@host:port.',
      },
    ],
    sample: {
      checked: 2,
      alive: 1,
      alive_list: '203.0.113.7:8080',
      complete: true,
      results: [
        { input: '203.0.113.7:8080', alive: true, protocols: ['http'], anonymity: 'elite', latency_ms: 140, country_code: 'US' },
        { input: '198.51.100.23:1080', alive: false },
      ],
    },
    outputFields: [
      { key: 'checked', label: 'Proxies Checked', type: 'integer' },
      { key: 'alive', label: 'Proxies Alive', type: 'integer' },
      { key: 'alive_list', label: 'Alive Proxies (one per line)' },
      { key: 'complete', label: 'Check Complete', type: 'boolean' },
    ],
  },
};
