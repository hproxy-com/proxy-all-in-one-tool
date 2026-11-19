// Runs the integration's steps against hproxy.com through Zapier's own app tester. The keyed ones need HPROXY_API_KEY
// (a read-only key of HProxy's test account, a GitHub secret); the free tools run without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const zapier = require('zapier-platform-core');
const App = require('../index');

const appTester = zapier.createAppTester(App);
const authData = { api_key: process.env.HPROXY_API_KEY || '' };

test('authentication: the key is accepted and names the account', { skip: !authData.api_key }, async () => {
  const me = await appTester(App.authentication.test, { authData });
  assert.ok(me.email || me.userId, 'no account in the answer');
});

test('new plan: answers with a list (empty for an account without plans)', { skip: !authData.api_key }, async () => {
  const plans = await appTester(App.triggers.new_plan.operation.perform, { authData, inputData: {} });
  assert.ok(Array.isArray(plans));
});

test('find IP address: 8.8.8.8 is in the US', async () => {
  const [result] = await appTester(App.searches.find_ip_address.operation.perform, { authData, inputData: { ip: '8.8.8.8' } });
  assert.equal(result.country, 'US');
  assert.equal(result.id, '8.8.8.8');
});

test('find IP address: refuses a word', async () => {
  await assert.rejects(appTester(App.searches.find_ip_address.operation.perform, { authData, inputData: { ip: 'localhost' } }));
});

test('find free proxies: 3 US proxies in one result with a ready list', async () => {
  const [result] = await appTester(App.searches.find_free_proxies.operation.perform, { authData, inputData: { limit: '3', country: 'us' } });
  assert.ok(result.count > 0 && result.count <= 3, `count ${result.count}`);
  assert.ok(result.proxies.every((p) => p.country_code === 'US'));
  assert.equal(result.proxy_list.split('\n').length, result.count);
});

test('check proxies: two from the free list', async () => {
  const [found] = await appTester(App.searches.find_free_proxies.operation.perform, { authData, inputData: { limit: '2' } });
  const checked = await appTester(App.creates.check_proxies.operation.perform, { authData, inputData: { proxies: found.proxies.map((p) => `${p.ip}:${p.port}`) } });
  assert.equal(checked.checked, found.proxies.length);
});
