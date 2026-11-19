const { BASE, bodyOf, planName } = require('../lib/api');

const perform = async (z, bundle) => {
  const id = String(bundle.inputData.plan_id || '').trim();
  const response = await z.request({ url: `${BASE}/api/v1/plans/${encodeURIComponent(id)}` });
  const plan = bodyOf(response) || {};
  return plan && plan.id ? [{ ...plan, name: planName(plan) }] : [];
};

module.exports = {
  key: 'find_plan',
  noun: 'Plan',
  display: {
    label: 'Find Plan',
    description: 'Finds one of your proxy plans with the traffic it has left, read live from the network.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'plan_id',
        label: 'Plan',
        required: true,
        dynamic: 'new_plan.id.name',
        helpText: 'Pick a plan from the list, or map a plan ID from an earlier step.',
      },
    ],
    sample: {
      id: 'cm0example0000000plan001',
      name: 'Residential Premium, 9.5 of 10 GB left (shop-1)',
      productId: 'residential-premium',
      status: 'active',
      label: 'shop-1',
      dataGbTotal: 10,
      dataGbRemaining: 9.5,
    },
    outputFields: [
      { key: 'id', label: 'Plan ID' },
      { key: 'name', label: 'Plan' },
      { key: 'productId', label: 'Product' },
      { key: 'status', label: 'Status' },
      { key: 'dataGbTotal', label: 'Traffic Total (GB)', type: 'number' },
      { key: 'dataGbRemaining', label: 'Traffic Left (GB)', type: 'number' },
    ],
  },
};
