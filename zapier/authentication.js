const { BASE } = require('./lib/api');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      required: true,
      type: 'password',
      helpText:
        'Create a key in your [HProxy dashboard](https://hproxy.com/dashboard/settings) under Settings > API keys. It starts with `hpx_`. A key that may read plans covers every step of this integration.',
    },
  ],
  test: {
    url: `${BASE}/api/v1/me`,
    method: 'GET',
  },
  connectionLabel: '{{email}}',
};
