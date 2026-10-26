// Builds the per-plan marketing files from one set of plan details:
//   marketing/starter-kit-<plan>.html  (print to PDF with Edge, see marketing/README)
//   marketing/plan-<plan>.html         (served at /landing/<plan>)
// Run: node scripts/build-marketing.js
const fs = require('node:fs');
const path = require('node:path');
const { PLANS } = require('../src/plans');

const dir = path.join(__dirname, '..', 'marketing');
const CHECKOUT = 'https://www.hootowl.net/pricing-plans/plan-customization/';
const ALL_PLANS = 'https://www.hootowl.net/#the-owl-assistant';

const plans = [
  {
    key: 'watch', id: '35700e0f-3c66-4ded-9505-032132e2cf67', name: 'Voicemail WATCH', short: 'WATCH', price: 20,
    calls: 'about 5 to 7',
    who: 'For owner-operators who want every missed call covered.',
    headline: 'Never miss another call, for $20 a month.',
    lead: 'Your own AI receptionist picks up when you can\'t, greets callers by your business name, and saves their details so you can call back and win the job.',
    upgrade: '<strong>Need more minutes?</strong> Receptionist Pro includes 75 AI minutes a month, and Enterprise OWL includes 200. Upgrade any time on hootowl.net.',
  },
  {
    key: 'pro', id: 'db1024e0-f106-4c82-84c8-9fa6f96d06fa', name: 'Receptionist Pro', short: 'Receptionist Pro', price: 50,
    calls: 'about 25 to 37',
    who: 'For busy shops that are on the job all day.',
    headline: 'A receptionist for your busiest days.',
    lead: 'When the phone rings while you\'re on a job, your AI receptionist answers, takes down the caller\'s name, address and problem, and saves it as a lead for you.',
    upgrade: '<strong>Need more minutes?</strong> Enterprise OWL includes 200 AI minutes a month. Upgrade any time on hootowl.net.',
  },
  {
    key: 'enterprise', id: '7a97db13-3c00-4e46-827b-ac5b18324344', name: 'Enterprise OWL', short: 'Enterprise OWL', price: 100,
    calls: 'about 66 to 100',
    who: 'For growing teams with a steady stream of calls.',
    headline: 'Big call volume? Every call answered.',
    lead: 'Our largest plan gives your business 200 AI minutes a month, so your receptionist can answer a steady stream of calls and save every lead for your team.',
    upgrade: '<strong>Our largest plan.</strong> If you regularly need more than 200 AI minutes a month, email info@hootowl.net.',
  },
];

for (const p of plans) {
  const minutes = PLANS[p.id]?.aiMinutes;
  if (!minutes) throw new Error(`Plan ${p.name} (${p.id}) is not in src/plans.js`);
  p.minutes = minutes;
}

const logo = 'data:image/webp;base64,' + fs.readFileSync(path.join(dir, 'hootowl-logo.webp')).toString('base64');
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Starter kits ----
const kitTemplate = fs.readFileSync(path.join(dir, 'starter-kit-template.html'), 'utf8');
for (const p of plans) {
  const html = kitTemplate
    .split('{{NAME}}').join(esc(p.name))
    .split('{{SHORT}}').join(esc(p.short))
    .split('{{PRICE}}').join(String(p.price))
    .split('{{MINUTES}}').join(String(p.minutes))
    .split('{{CALLS}}').join(esc(p.calls))
    .split('{{UPGRADE}}').join(p.upgrade)
    .split('__LOGO__').join(logo);
  if (/\{\{[A-Z]+\}\}/.test(html)) throw new Error('Unfilled placeholder in starter kit for ' + p.key);
  fs.writeFileSync(path.join(dir, `starter-kit-${p.key}.html`), html);
}

// ---- Plan landing pages (same look as the main landing page) ----
const mainPage = fs.readFileSync(path.join(dir, 'hootowl-landing-embed.html'), 'utf8');
const style = mainPage.match(/<style>[\s\S]*?<\/style>/)[0];
const extraStyle = `<style>
  .price-card { background: var(--paper); color: var(--ink); border-radius: 22px; padding: 30px 28px; box-shadow: 0 24px 50px -24px rgba(0,0,0,.6); }
  .price-card h3 { font-size: 20px; }
  .price-card .who { color: var(--muted); font-size: 14px; margin: 6px 0 16px; }
  .price-card ul { list-style: none; padding: 0; margin: 0 0 22px; }
  .price-card li { padding: 8px 0 8px 26px; position: relative; font-size: 15px; border-top: 1px solid var(--line); }
  .price-card li:first-child { border-top: 0; }
  .price-card li::before { content: "✓"; position: absolute; left: 0; color: var(--forest); font-weight: 900; }
  .price-card .btn { width: 100%; justify-content: center; }
  .secure { text-align: center; color: var(--muted); font-size: 12px; margin-top: 10px; }
  .minutes-box { background: var(--paper); border: 1px solid var(--line); border-radius: 18px; padding: 26px; }
  .minutes-box ul { margin: 0; padding-left: 20px; } .minutes-box li { margin-bottom: 8px; color: var(--muted); }
  .compare { margin-top: 18px; font-size: 14px; color: rgba(255,255,255,.75); }
  .compare a { color: var(--gold); }
  /* Plan pages have less content than the main page, so they use roomier spacing within the same 2150px height. */
  .hero { padding: 64px 0 66px; }
  .mark { margin-bottom: 22px; }
  section.block { padding: 56px 0; }
  .section-head { margin-bottom: 26px; }
  .closing { padding: 56px 0; }
  .closing .wrap { grid-template-columns: 1fr; text-align: center; row-gap: 12px; }
  .closing .logo-badge.large, .closing h2, .closing p, .closing .cta-row { grid-column: 1; grid-row: auto; margin-left: auto; margin-right: auto; justify-content: center; }
  .closing .logo-badge.large { width: 96px; height: 96px; }
  .closing .logo-badge.large .logo-art { width: 80px; height: 79px; }
</style>`;

const included = (p) => [
  'Your own HootOwl business number',
  `AI receptionist with ${p.minutes} AI minutes a month`,
  'Your greeting, closing line and choice of six voices',
  'Call forwarding to your phone',
  'Missed calls and leads saved to your workspace',
  'Call yourself to preview before going live',
];

function planPage(p) {
  const buy = CHECKOUT + p.id;
  const cta = (label, cls = 'btn-primary') => `<a class="btn ${cls}" href="${buy}" target="_top">${label}</a>`;
  const others = plans.filter((o) => o.key !== p.key)
    .map((o) => `<a href="${CHECKOUT + o.id}" target="_top">${esc(o.name)} ($${o.price}/month, ${o.minutes} AI minutes)</a>`).join(' or ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HootOwl ${esc(p.name)}</title>
${style}
${extraStyle}
</head>
<body>

<header class="hero">
  <div class="wrap">
    <div>
      <div class="mark"><span class="logo-badge"><span class="logo-art" role="img" aria-label="HootOwl logo"></span></span> HOOTOWL</div>
      <p class="eyebrow">${esc(p.name)} plan · $${p.price} per month</p>
      <h1>${esc(p.headline)}</h1>
      <p class="lead">${esc(p.lead)}</p>
      <div class="cta-row">
        ${cta(`Get ${esc(p.short)} for $${p.price}/month →`)}
        <a class="btn btn-ghost" href="#included" target="_self">See what's included</a>
      </div>
      <p class="compare">Comparing plans? Also see ${others}.</p>
    </div>
    <div class="price-card">
      <h3>${esc(p.name)}</h3>
      <p class="who">${esc(p.who)}</p>
      <div class="price">$${p.price}<span> / month</span></div>
      <div class="minutes">${p.minutes} AI minutes / month</div>
      <ul>${included(p).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      ${cta(`Choose ${esc(p.short)}`, 'btn-dark')}
      <p class="secure">You'll finish payment securely on hootowl.net.</p>
    </div>
  </div>
</header>

<section class="block" id="included">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">How it works</p>
      <h2>Live in three steps.</h2>
    </div>
    <div class="steps">
      <div class="step"><h3>Subscribe</h3><p>Choose ${esc(p.short)} and check out on hootowl.net. You'll get an email with your personal sign-up link.</p></div>
      <div class="step"><h3>Make it yours</h3><p>Get your HootOwl number, name your receptionist, write your greeting, pick a voice, then call yourself to hear it.</p></div>
      <div class="step"><h3>Get every lead</h3><p>Your receptionist answers, collects the caller's details, and saves them to your workspace so you can call back fast.</p></div>
    </div>
  </div>
</section>

<section class="block features">
  <div class="wrap">
    <div class="section-head">
      <p class="eyebrow">Your minutes</p>
      <h2>How your ${p.minutes} AI minutes work.</h2>
    </div>
    <div class="minutes-box">
      <ul>
        <li>Your receptionist answers calls to your HootOwl number while you have minutes left this month.</li>
        <li>A typical call takes 2 to 3 minutes, so ${p.minutes} minutes covers ${esc(p.calls)} calls.</li>
        <li>Once they're used, calls ring your phone like normal call forwarding. Nobody hits a dead line.</li>
        <li>Minutes reset on the 1st of every month, and calls you make to preview your receptionist are free.</li>
      </ul>
    </div>
  </div>
</section>

<section class="block" style="padding-top:64px">
  <div class="wrap faq">
    <div class="section-head"><p class="eyebrow">Questions</p><h2>Good to know.</h2></div>
    <details><summary>Will callers know they're talking to AI?</summary><p>Yes. Your receptionist is friendly and natural, but it never claims to be a person. If someone asks, it says it's your virtual assistant.</p></details>
    <details><summary>Does it text my customers?</summary><p>No. HootOwl handles phone calls only and never sends text messages to your callers.</p></details>
    <details><summary>Can it schedule appointments?</summary><p>It collects each caller's name, address, service and problem and saves it as a lead, so you or your team can call back and set the time.</p></details>
    <details><summary>Can I hear it before customers do?</summary><p>Yes. From your workspace, press "Call me to preview" and your receptionist calls your phone so you can talk to it like a customer would.</p></details>
  </div>
</section>

<section class="closing">
  <div class="wrap">
    <div class="logo-badge large"><span class="logo-art" aria-hidden="true"></span></div>
    <h2>${esc(p.name)}: $${p.price} a month, ${p.minutes} AI minutes.</h2>
    <p>Stop sending customers to voicemail.</p>
    <div class="cta-row">${cta(`Get ${esc(p.short)} →`)}</div>
  </div>
</section>

</body>
</html>
`;
}

for (const p of plans) fs.writeFileSync(path.join(dir, `plan-${p.key}.html`), planPage(p));
console.log('Built:', plans.map((p) => `starter-kit-${p.key}.html, plan-${p.key}.html (${p.minutes} min, $${p.price})`).join(' | '));
