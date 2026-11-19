const { BASE, bodyOf, list } = require('../lib/api');

const perform = async (z, bundle) => {
  const input = bundle.inputData;
  const id = String(input.plan_id || '').trim();
  const body = {
    count: Math.min(5000, Math.max(1, parseInt(input.count, 10) || 1)),
    protocol: input.protocol === 'socks5' ? 'socks5' : 'http',
  };
  for (const field of ['country', 'state', 'city', 'isp']) {
    if (input[field] && String(input[field]).trim()) body[field] = String(input[field]).trim();
  }
  if (input.sticky_minutes) body.stickyMinutes = parseInt(input.sticky_minutes, 10);
  if (input.asn) body.asn = parseInt(input.asn, 10);
  if (input.os) body.os = input.os;
  if (typeof input.strict === 'boolean') body.strict = input.strict;
  if (typeof input.udp === 'boolean') body.udp = input.udp;
  const exclusions = { excludeCountries: input.exclude_countries, excludeStates: input.exclude_states, excludeCities: input.exclude_cities };
  for (const [key, value] of Object.entries(exclusions)) {
    const values = list(value);
    if (values.length > 20) throw new z.errors.Error(`HProxy takes up to 20 entries in ${key}.`, 'InvalidData', 400);
    if (values.length) body[key] = values;
  }
  const networks = list(input.exclude_asn);
  if (networks.length) {
    if (networks.some((n) => !/^\d+$/.test(n))) throw new z.errors.Error('Exclude Networks takes whole AS numbers, such as 7922.', 'InvalidData', 400);
    if (networks.length > 20) throw new z.errors.Error('HProxy takes up to 20 AS numbers to exclude.', 'InvalidData', 400);
    body.excludeAsn = networks.map(Number);
  }

  const response = await z.request({ url: `${BASE}/api/v1/plans/${encodeURIComponent(id)}/generate`, method: 'POST', body });
  const answer = bodyOf(response) || {};
  const lines = Array.isArray(answer.lines) ? answer.lines.filter((l) => typeof l === 'string') : [];
  return { plan_id: id, product_id: answer.productId || null, count: lines.length, lines, lines_text: lines.join('\n') };
};

module.exports = {
  key: 'generate_proxy_lines',
  noun: 'Proxy Line',
  display: {
    label: 'Generate Proxy Lines',
    description: 'Creates ready-to-use residential proxy lines (host:port:username:password) from one of your plans, rotating or sticky, with country, state, city, ISP or network targeting.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'plan_id',
        label: 'Plan',
        required: true,
        dynamic: 'new_plan.id.name',
        helpText: 'The plan to generate lines from. Only active plans with traffic left can generate.',
      },
      { key: 'count', label: 'Count', type: 'integer', default: '1', helpText: 'How many lines to return, from 1 to 5,000.' },
      {
        key: 'protocol',
        label: 'Protocol',
        choices: { http: 'HTTP', socks5: 'SOCKS5' },
        default: 'http',
        helpText: 'HTTP works in every client; SOCKS5 carries any TCP traffic.',
      },
      {
        key: 'sticky_minutes',
        label: 'Sticky Session (Minutes)',
        type: 'integer',
        helpText: 'Leave empty for rotating lines (a new IP per request). Set minutes for sticky lines that keep one IP: Residential Premium takes 3 to 1,440.',
      },
      { key: 'country', label: 'Country', helpText: 'Two-letter code or English name of the exit country, such as US. Leave empty for any country.' },
      { key: 'state', label: 'State', helpText: 'State or region of the exit IP, such as California, where the plan takes it.' },
      { key: 'city', label: 'City', helpText: 'City of the exit IP, such as New York, where the plan takes it.' },
      { key: 'isp', label: 'ISP', helpText: 'Internet provider of the exit IP by name, such as Comcast. Residential Plus plans.' },
      { key: 'asn', label: 'Network (ASN)', type: 'integer', helpText: 'Network of the exit IP by AS number, such as 7922, together with a country. Residential Premium plans.' },
      {
        key: 'os',
        label: 'Operating System',
        choices: { android: 'Android', ios: 'iOS', mac: 'macOS', windows: 'Windows' },
        helpText: 'Device type the exit IP belongs to. Residential Premium plans.',
      },
      { key: 'strict', label: 'Strict Targeting', type: 'boolean', helpText: 'Yes: a request fails when no IP matches the exact target. No: it falls back to the same country.' },
      { key: 'udp', label: 'UDP', type: 'boolean', helpText: 'Whether SOCKS5 lines may relay UDP traffic. Residential Premium plans.' },
      { key: 'exclude_countries', label: 'Exclude Countries', list: true, helpText: 'Up to 20 two-letter codes to avoid when no country is set. Residential Premium plans.' },
      { key: 'exclude_states', label: 'Exclude States', list: true, helpText: 'Up to 20 states or regions to avoid inside the country. Residential Premium plans.' },
      { key: 'exclude_cities', label: 'Exclude Cities', list: true, helpText: 'Up to 20 cities to avoid inside the country. Residential Premium plans.' },
      { key: 'exclude_asn', label: 'Exclude Networks (ASN)', list: true, helpText: 'Up to 20 AS numbers to avoid, such as 7018. Residential Premium plans.' },
    ],
    sample: {
      plan_id: 'cm0example0000000plan001',
      product_id: 'residential-premium',
      count: 2,
      lines: ['example.hproxy.com:8000:user-1a2b3c:pass-4d5e6f', 'example.hproxy.com:8000:user-7g8h9i:pass-0j1k2l'],
      lines_text: 'example.hproxy.com:8000:user-1a2b3c:pass-4d5e6f\nexample.hproxy.com:8000:user-7g8h9i:pass-0j1k2l',
    },
    outputFields: [
      { key: 'plan_id', label: 'Plan ID' },
      { key: 'product_id', label: 'Product' },
      { key: 'count', label: 'Lines Generated', type: 'integer' },
      { key: 'lines_text', label: 'Proxy Lines (one per line)' },
    ],
  },
};
