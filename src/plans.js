// What each Wix Pricing Plan includes. Plan IDs come from the hootowl.net Pricing Plans app.
const PLANS = {
  '35700e0f-3c66-4ded-9505-032132e2cf67': { name: 'The AI Owl Voicemail WATCH', aiMinutes: 50 },
  'db1024e0-f106-4c82-84c8-9fa6f96d06fa': { name: 'THE AI OWL Receptionist Pro', aiMinutes: 300 },
  '7a97db13-3c00-4e46-827b-ac5b18324344': { name: 'Enterprise OWL', aiMinutes: 500 },
  // Archived plans, kept so existing subscribers keep their benefits while they renew.
  '90ccd95f-9f7b-42d0-9bb9-6ae78d4681f8': { name: 'AI Receptionist Plus', aiMinutes: 50 },
  '9cac965d-f74f-418e-92d8-2b6622f84770': { name: 'Agent OWL', aiMinutes: 600 },
};

function planFor(planId) {
  return PLANS[planId] || null;
}

module.exports = { PLANS, planFor };
