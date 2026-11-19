const { BASE, bodyOf } = require('../lib/api');

const perform = async (z, bundle) => {
  const id = String(bundle.inputData.plan_id || '').trim();
  const days = Math.min(30, Math.max(1, parseInt(bundle.inputData.days, 10) || 7));
  const params = { days };
  if (bundle.inputData.granularity && bundle.inputData.granularity !== 'auto') params.granularity = bundle.inputData.granularity;
  const response = await z.request({ url: `${BASE}/api/v1/plans/${encodeURIComponent(id)}/stats`, params });
  const stats = bodyOf(response) || {};
  return [{ id, days, ...stats }];
};

module.exports = {
  key: 'find_plan_traffic',
  noun: 'Plan Traffic',
  display: {
    label: 'Find Plan Traffic',
    description: 'Finds the traffic one proxy plan used over the last 1 to 30 days, hour by hour or day by day.',
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
      {
        key: 'days',
        label: 'Days',
        type: 'integer',
        default: '7',
        helpText: 'The window ending now, from 1 to 30 days.',
      },
      {
        key: 'granularity',
        label: 'Granularity',
        choices: { auto: 'Automatic (hourly up to 2 days, daily beyond)', day: 'Day', hour: 'Hour' },
        default: 'auto',
        helpText: 'The size of each point in the answer.',
      },
    ],
    sample: {
      id: 'cm0example0000000plan001',
      days: 7,
      granularity: 'day',
      points: [
        { at: '2026-11-10', gbUsed: 0.42 },
        { at: '2026-11-11', gbUsed: 0.08 },
      ],
    },
    outputFields: [
      { key: 'id', label: 'Plan ID' },
      { key: 'days', label: 'Days', type: 'integer' },
    ],
  },
};
