// What each Wix Pricing Plan includes. Plan IDs come from the hootowl.net Pricing Plans app.
const PLANS = {
  '35700e0f-3c66-4ded-9505-032132e2cf67': { name: 'The AI Owl Voicemail WATCH', aiMinutes: 15 },
  'db1024e0-f106-4c82-84c8-9fa6f96d06fa': { name: 'THE AI OWL Receptionist Pro', aiMinutes: 75 },
  '7a97db13-3c00-4e46-827b-ac5b18324344': { name: 'Enterprise OWL', aiMinutes: 200 },
};

function planFor(planId) {
  return PLANS[planId] || null;
}

module.exports = { PLANS, planFor };
