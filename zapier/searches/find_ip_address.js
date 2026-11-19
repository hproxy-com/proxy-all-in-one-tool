const { BASE, bodyOf } = require('../lib/api');

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;

const perform = async (z, bundle) => {
  const ip = String(bundle.inputData.ip || '').trim();
  if (!IPV4.test(ip) && !(ip.includes(':') && IPV6.test(ip))) {
    throw new z.errors.Error('Enter one public IPv4 or IPv6 address, such as 8.8.8.8.', 'InvalidData', 400);
  }
  const response = await z.request({ url: `${BASE}/api/ip/${ip}` });
  const data = bodyOf(response) || {};
  return [{ id: ip, ...data }];
};

module.exports = {
  key: 'find_ip_address',
  noun: 'IP Address',
  display: {
    label: 'Find IP Address',
    description: 'Finds the country, region, network and ISP of an IP address, and whether it belongs to a data center. No HProxy plan is needed.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'ip',
        label: 'IP Address',
        required: true,
        helpText: 'One public IPv4 or IPv6 address, such as 8.8.8.8.',
      },
    ],
    sample: {
      id: '8.8.8.8',
      ip: '8.8.8.8',
      country: 'US',
      country_name: 'United States',
      timezone: 'America/Chicago',
      asn: 15169,
      asn_org: 'Google LLC',
      isp: 'Google LLC',
      is_datacenter: true,
    },
    outputFields: [
      { key: 'ip', label: 'IP Address' },
      { key: 'country', label: 'Country Code' },
      { key: 'country_name', label: 'Country' },
      { key: 'region', label: 'Region' },
      { key: 'city', label: 'City' },
      { key: 'timezone', label: 'Time Zone' },
      { key: 'asn', label: 'Network (ASN)', type: 'integer' },
      { key: 'asn_org', label: 'Network Owner' },
      { key: 'isp', label: 'ISP' },
      { key: 'is_datacenter', label: 'Data Center', type: 'boolean' },
    ],
  },
};
