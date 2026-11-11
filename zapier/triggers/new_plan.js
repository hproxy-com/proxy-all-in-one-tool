const { BASE, bodyOf, planName } = require('../lib/api');

// Every plan on the account, newest first, each with a readable name (also feeds the Plan dropdowns of other steps).
const perform = async (z, bundle) => {
  const response = await z.request({ url: `${BASE}/api/v1/plans`, params: { status: 'all' } });
  const body = bodyOf(response) || {};
  const plans = Array.isArray(body.plans) ? body.plans : [];
  return plans
    .filter((plan) => plan && plan.id)
    .map((plan) => ({ ...plan, name: planName(plan) }))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
};

module.exports = {
  key: 'new_plan',
  noun: 'Plan',
  display: {
    label: 'New Plan',
    description: 'Triggers when a new proxy plan appears on your HProxy account.',
  },
  operation: {
    perform,
    sample: {
      id: 'cm0example0000000plan001',
      name: 'Residential Premium, 9.5 of 10 GB left (shop-1)',
      productId: 'residential-premium',
      status: 'active',
      label: 'shop-1',
      dataGbTotal: 10,
      dataGbRemaining: 9.5,
      createdAt: '2026-11-11T10:00:00.000Z',
    },
    outputFields: [
      { key: 'id', label: 'Plan ID' },
      { key: 'name', label: 'Plan' },
      { key: 'productId', label: 'Product' },
      { key: 'status', label: 'Status' },
      { key: 'label', label: 'Label' },
      { key: 'dataGbTotal', label: 'Traffic Total (GB)', type: 'number' },
      { key: 'dataGbRemaining', label: 'Traffic Left (GB)', type: 'number' },
      { key: 'createdAt', label: 'Created At', type: 'datetime' },
    ],
  },
};
