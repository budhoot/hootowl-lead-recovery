const { PLANS, planFor } = require('../src/plans');

const WATCH = '35700e0f-3c66-4ded-9505-032132e2cf67';
const PRO = 'db1024e0-f106-4c82-84c8-9fa6f96d06fa';
const ENTERPRISE = '7a97db13-3c00-4e46-827b-ac5b18324344';

test('the three live plans carry their live names and unchanged allowances, keyed by plan ID', () => {
  expect(planFor(WATCH)).toEqual({ name: 'Voicemail WATCH', aiMinutes: 15 });
  expect(planFor(PRO)).toEqual({ name: 'Receptionist Pro', aiMinutes: 75 });
  expect(planFor(ENTERPRISE)).toEqual({ name: 'Enterprise OWL', aiMinutes: 200 });
});

test('archived plans keep their allowances and an unknown id or a name finds nothing', () => {
  expect(planFor('90ccd95f-9f7b-42d0-9bb9-6ae78d4681f8').aiMinutes).toBe(15);
  expect(planFor('9cac965d-f74f-418e-92d8-2b6622f84770').aiMinutes).toBe(150);
  expect(planFor('Voicemail WATCH')).toBeNull();
  expect(Object.keys(PLANS)).toHaveLength(5);
});
