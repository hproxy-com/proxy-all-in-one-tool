const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');

const authentication = require('./authentication');
const { addApiKey, explainErrors } = require('./lib/api');
const newPlan = require('./triggers/new_plan');
const findPlan = require('./searches/find_plan');
const findPlanTraffic = require('./searches/find_plan_traffic');
const findIpAddress = require('./searches/find_ip_address');
const findFreeProxies = require('./searches/find_free_proxies');
const generateProxyLines = require('./creates/generate_proxy_lines');
const checkProxies = require('./creates/check_proxies');

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [explainErrors],
  triggers: {
    [newPlan.key]: newPlan,
  },
  searches: {
    [findPlan.key]: findPlan,
    [findPlanTraffic.key]: findPlanTraffic,
    [findIpAddress.key]: findIpAddress,
    [findFreeProxies.key]: findFreeProxies,
  },
  creates: {
    [generateProxyLines.key]: generateProxyLines,
    [checkProxies.key]: checkProxies,
  },
};
