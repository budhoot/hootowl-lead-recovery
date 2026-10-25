'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let workspace, leads = { calls: [], replies: [] }, view = 'home', filter = 'open', leadId, requestId = 0, installPrompt;
let invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
if (invitation) history.replaceState(null, '', location.pathname);
const titles = { home: 'A good day starts here.', inbox: 'Every conversation matters.', business: 'Make yourself at home.', receptionist: 'Your voice, on every call.', plan: 'Your plan, your number, your security.', preferences: 'A space that feels like you.', install: 'Your business. In your pocket.' };
const labels = { home: 'YOUR WORKSPACE', inbox: 'YOUR LEAD INBOX', business: 'BUSINESS SETTINGS', receptionist: 'AI RECEPTIONIST', plan: 'PLAN & SECURITY', preferences: 'APPEARANCE & ACCOUNT', install: 'TAKE HOOTOWL WITH YOU' };
let planData = null, receptionistData = null, newSecret = null, newCodes = null, challenge = null;
const statusLabel = value => ({ new: 'New', in_progress: 'Following up', resolved: 'Resolved' }[value] || value);
function date(value) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: workspace.business.timezone, hour12: workspace.user.time_format === '12' }).format(new Date(value)); }
const initials = name => name.split(/\s+/).slice(0, 2).map(v => v[0]).join('').toUpperCase();
const badge = (label, paused = false) => `<span class="badge${paused ? ' paused' : ''}">${esc(label)}</span>`;
const empty = (title, message) => `<div class="empty"><div class="empty-icon" aria-hidden="true">☷</div><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
function feedback(message, isError = false) { $('#feedback').textContent = message; $('#feedback').className = isError ? 'error' : ''; $('#feedback').hidden = false; }
function applyTheme(user) { for (const key of ['theme', 'accent', 'density']) document.documentElement.dataset[key] = user[key]; }
function showLogin() {
 requestId++; workspace = null; planData = null; receptionistData = null; newSecret = null; newCodes = null; challenge = null; leads = { calls: [], replies: [] }; $('#content').replaceChildren();
 $('#twofa-form').hidden = true;
 $('#app').hidden = true; $('#auth-screen').hidden = false; $('#signin-form').hidden = false; $('#join-form').hidden = true;
 $('#auth-title').textContent = 'Welcome back.'; $('#auth-description').textContent = 'Sign in to pick up where you left off.';
 if ($('#lead-dialog').open) $('#lead-dialog').close();
 applyTheme({ theme: 'system', accent: 'forest', density: 'comfortable' });
}
async function api(path, options = {}) {
 const response = await fetch('/portal/api' + path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-HootOwl-Request': 'customer', ...options.headers } });
 if (!response.ok) {
  let body; try { body = await response.json(); } catch {}
  if (response.status === 401 && workspace) showLogin();
  throw Error(body?.error || `Unable to complete the request (${response.status}). Please try again.`);
 }
 return response.status === 204 ? null : response.json();
}
async function submit(form, action, onSuccess) {
 const button = form.querySelector('button[type=submit]'); button.disabled = true;
 try { const result = await action(Object.fromEntries(new FormData(form))); await onSuccess(result); }
 finally { button.disabled = false; }
}
function updateIdentity() {
 $('#business-name').textContent = workspace.business.name; $('#business-monogram').textContent = initials(workspace.business.name);
 $('#user-name').textContent = workspace.user.display_name; $('#user-avatar').textContent = initials(workspace.user.display_name);
 applyTheme(workspace.user);
}
async function refresh() {
 const current = ++requestId; $('#refresh').disabled = true; $('#content').setAttribute('aria-busy', 'true');
 try {
  const [nextWorkspace, nextLeads] = await Promise.all([api('/workspace'), api('/leads')]);
  if (current !== requestId) return;
  workspace = nextWorkspace; leads = nextLeads;
  $('#auth-screen').hidden = true; $('#app').hidden = false; updateIdentity(); render();
  $('#last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
 } catch (error) {
  if (workspace) feedback(error.message, true); else $('#auth-error').textContent = error.message;
 } finally { $('#refresh').disabled = false; $('#content').setAttribute('aria-busy', 'false'); }
}
function navigate(next) {
 if (!titles[next] || !workspace) return;
 view = next; $('#feedback').hidden = true; applyTheme(workspace.user); render(); $('#main').focus(); window.scrollTo(0, 0);
}
function render() {
 $('#page-title').textContent = titles[view]; $('#page-kicker').textContent = labels[view];
 document.querySelectorAll('nav button').forEach(b => { b.classList.toggle('active', b.dataset.view === view); if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
 $('#content').innerHTML = ({ home, inbox, business, receptionist, plan, preferences, install })[view]();
 if (view === 'plan' && !planData) loadPlan();
 if (view === 'receptionist' && !receptionistData) loadReceptionist();
 bindForms();
}
async function loadPlan() {
 try { const [subscription, security] = await Promise.all([api('/subscription'), api('/2fa')]); planData = { subscription, security }; if (view === 'plan') render(); }
 catch (error) { feedback(error.message, true); }
}
const money = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
const usageLabel = { call: 'Call minutes', sms_out: 'Texts sent', sms_in: 'Texts received', auth_sms: 'Sign-in texts' };
function plan() {
 if (!planData) return '<p class="muted">Loading your plan…</p>';
 const { subscription: s, security: sec } = planData, sub = s.subscription, prov = s.provisioning;
 const subText = { active: 'Active', past_due: 'Payment needed', cancelled: 'Cancelled', refunded: 'Refunded', none: 'No plan found' }[sub.status] || sub.status;
 const usage = s.usage_30_days.filter(u => u.kind !== 'auth_sms');
 const provisionCard = prov.status === 'active' ? `<p>${badge('Phone number ready')} Manage call forwarding on the Business page.</p>`
  : sub.status !== 'active' ? '<p class="muted">An active HootOwl subscription is needed before we can set up your phone number. If you just subscribed, refresh in a minute.</p>'
  : `<form id="provision-form"><label>Preferred area code <span class="muted small">Optional</span><input name="area_code" inputmode="numeric" pattern="[2-9][0-9]{2}" maxlength="3"></label><label class="check-inline"><input type="checkbox" name="consent" required> I agree that HootOwl may create a phone number and Twilio account for my business and bill usage to my plan.</label>${prov.failed ? '<p class="error">Setup did not finish last time. You can try again.</p>' : ''}<button class="primary" type="submit">Set up my phone number</button></form>`;
 const secretBox = newSecret ? `<div class="notice"><p>Add this key to your authenticator app, then enter the 6-digit code it shows.</p><p><code>${esc(newSecret.secret)}</code></p><p class="small muted">Setup link: <code>${esc(newSecret.otpauth_uri)}</code></p><form id="totp-confirm-form"><label>6-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button class="primary" type="submit">Turn on</button></form></div>` : '';
 const codesBox = newCodes ? `<div class="notice" role="alert"><strong>Save these recovery codes now.</strong><p class="small">Each works once if you lose your phone. They will not be shown again.</p><p><code>${newCodes.map(esc).join('<br>')}</code></p><button class="secondary" id="codes-saved">I saved them</button></div>` : '';
 return `<div class="settings-stack"><section class="card"><h2>Your plan</h2><p>${badge(subText, sub.status !== 'active')}${sub.current_period_end ? ` <span class="muted small">Current period ends ${esc(new Date(sub.current_period_end).toLocaleDateString())}</span>` : ''}</p>${usage.length ? `<h3>Last 30 days</h3>${usage.map(u => `<div class="check-row"><div><h3>${esc(usageLabel[u.kind] || u.kind)}</h3><p>${money(u.quantity)}</p></div></div>`).join('')}` : '<p class="muted small">No usage in the last 30 days.</p>'}</section>
 <section class="card"><h2>Your HootOwl phone number</h2>${provisionCard}</section>
 <section class="card"><h2>Two-step verification</h2><p class="section-intro">Add a second step when you sign in.</p>${codesBox}${secretBox}
 <p>Authenticator app: ${badge(sec.totp ? 'On' : 'Off', !sec.totp)} ${sec.totp ? '' : '<button class="secondary" id="totp-setup">Set up</button>'}</p>
 <p>Text message: ${badge(sec.sms ? 'On ' + (sec.sms_phone || '') : 'Off', !sec.sms)}</p>
 <form id="sms-setup-form"><label>Mobile number<input name="phone" type="tel" placeholder="+15551234567" pattern="\\+[1-9][0-9]{6,14}" required></label><button class="secondary" type="submit">${sec.sms ? 'Change number' : 'Text me a code'}</button></form>
 <form id="sms-confirm-form" ${planData.smsPending ? '' : 'hidden'}><label>Code we texted you<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button class="primary" type="submit">Confirm</button></form>
 ${sec.totp || sec.sms ? `<p class="muted small">Recovery codes remaining: ${sec.recovery_codes_remaining}</p><form id="twofa-manage-form"><label>Your password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><button class="secondary" type="submit" data-act="recovery-codes">New recovery codes</button> <button class="secondary" type="submit" data-act="disable">Turn off two-step</button></form>` : ''}</section></div>`;
}
function bindPlan() {
 const done = async message => { planData = null; await loadPlan(); if (message) feedback(message); };
 const fail = error => feedback(error.message, true);
 const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
 if ($('#provision-form')) $('#provision-form').onsubmit = event => { event.preventDefault(); submit(event.target, d => post('/provisioning', { consent: true, ...(d.area_code ? { area_code: d.area_code } : {}) }), async () => { await refresh(); planData = null; await loadPlan(); feedback('Your phone number is ready. Add a forwarding number on the Business page to start routing calls.'); }).catch(fail); };
 if ($('#totp-setup')) $('#totp-setup').onclick = async () => { try { newSecret = await post('/2fa/totp/setup', {}); render(); } catch (error) { fail(error); } };
 if ($('#totp-confirm-form')) $('#totp-confirm-form').onsubmit = event => { event.preventDefault(); submit(event.target, d => post('/2fa/totp/confirm', d), async r => { newSecret = null; newCodes = r.recovery_codes; await done('Authenticator app is on.'); }).catch(fail); };
 if ($('#sms-setup-form')) $('#sms-setup-form').onsubmit = event => { event.preventDefault(); submit(event.target, d => post('/2fa/sms/setup', d), () => { planData.smsPending = true; render(); feedback('We sent a code to your phone.'); }).catch(fail); };
 if ($('#sms-confirm-form')) $('#sms-confirm-form').onsubmit = event => { event.preventDefault(); submit(event.target, d => post('/2fa/sms/confirm', d), async r => { newCodes = r.recovery_codes; await done('Text message verification is on.'); }).catch(fail); };
 if ($('#twofa-manage-form')) $('#twofa-manage-form').onsubmit = event => {
  event.preventDefault(); const act = event.submitter?.dataset.act;
  submit(event.target, d => post('/2fa/' + act, d), async r => { newCodes = r.recovery_codes || null; newSecret = null; await done(act === 'disable' ? 'Two-step verification is off.' : 'New recovery codes created.'); }).catch(fail);
 };
 if ($('#codes-saved')) $('#codes-saved').onclick = () => { newCodes = null; render(); };
}
function checkRow(done, title, description) { return `<div class="check-row"><span class="check" aria-hidden="true">${done ? '✓' : '○'}</span><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div></div>`; }
function home() {
 const open = leads.calls.filter(c => c.follow_up_status !== 'resolved').length;
 const ready = !!workspace.business.onboarding_completed_at;
 const active = workspace.routes.some(r => r.is_active && r.intake_enabled);
 return `<section class="hero"><div><p class="eyebrow">HELLO, ${esc(workspace.user.display_name.split(' ')[0].toUpperCase())}</p><h2>${ready ? 'Every call gets an answer.' : 'Let’s get your business settled in.'}</h2><p>${ready ? 'Your AI voice assistant answers incoming calls, records them, and can book visits. Review calls that need your attention here.' : 'Add your business details and confirm how incoming calls should be handled.'}</p><button class="primary" data-view="${ready ? 'inbox' : 'business'}">${ready ? 'Open my call inbox' : 'Finish my setup'} &nbsp; →</button></div><div class="hero-art" aria-hidden="true"><div class="orbit"><span class="owl">HO</span></div></div></section>
 <div class="stats"><section class="stat"><div class="stat-label">Needs follow-up</div><div class="stat-value">${open}</div><small>Open in recent calls</small></section><section class="stat"><div class="stat-label">Resolved calls</div><div class="stat-value">${leads.calls.length - open}</div><small>Completed in recent calls</small></section></div>
 <div class="status-strip">${badge(active ? 'AI voice answering on' : 'AI voice answering not configured', !active)}<span>${active ? 'Incoming calls are handled by the voice assistant. SMS is disabled.' : 'Ask your HootOwl operator to enable AI voice answering for your phone route. SMS is disabled.'}</span></div>
 <div class="grid"><section class="card"><div class="section-heading"><h2>Your latest activity</h2><button class="text-button" data-view="inbox">View inbox →</button></div>${leads.calls.length ? leads.calls.slice(0, 3).map(c => `<div class="check-row"><span class="check" aria-hidden="true">↙</span><div><h3>${esc(c.caller_number)}</h3><p>${esc(date(c.created_at))} · ${esc(statusLabel(c.follow_up_status))}</p></div></div>`).join('') : empty('A clear inbox. A fresh start.', 'New calls will appear here when your phone route is connected. No leads have been received yet.')}</section>
 <section class="card"><div class="section-heading"><h2>Your setup checklist</h2>${badge(ready ? 'Profile ready' : 'Getting started')}</div>${checkRow(true, 'Your account is ready', 'Your own sign-in and business workspace.')}${checkRow(ready, 'Tell us about your business', ready ? 'Business profile saved.' : 'Add your contact name and confirm your business details.')}${checkRow(workspace.routes.length > 0, 'Connect your business number', workspace.routes.length ? 'Review where incoming calls should ring.' : 'Ask your operator to assign a phone number.')}${checkRow(active, 'AI voice answering', active ? 'The voice assistant is enabled for an active route.' : 'Ask your operator to configure and test the voice assistant.')}<button class="text-button" data-view="install">Add HootOwl to your phone →</button></section></div>`;
}
function inbox() {
 const shown = leads.calls.filter(c => filter === 'all' || (filter === 'resolved' ? c.follow_up_status === 'resolved' : c.follow_up_status !== 'resolved'));
 return `<div class="tabs" aria-label="Call inbox filter">${[['open', 'Open calls'], ['all', 'All calls'], ['resolved', 'Resolved']].map(([value, label]) => `<button data-filter="${value}" class="${filter === value ? 'active' : ''}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div><p class="muted small">Showing up to the latest 200 call follow-ups. Times are shown in ${esc(workspace.business.timezone)}.</p><div class="lead-list">${shown.length ? shown.map(c => `<article class="lead-card"><div class="lead-main"><a href="tel:${esc(c.caller_number)}">${esc(c.caller_number)}</a><div class="lead-meta"><span>${esc(date(c.created_at))}</span>${badge(statusLabel(c.follow_up_status))}</div>${c.customer_notes ? `<p class="lead-note">${esc(c.customer_notes)}</p>` : ''}</div><button class="secondary" data-lead="${esc(c.call_sid)}">Follow up</button></article>`).join('') : `<section class="card">${empty(filter === 'resolved' ? 'No resolved calls yet.' : 'You’re all caught up.', 'Calls that need follow-up will appear here.')}</section>`}</div>`;
}
function business() {
 const b = workspace.business;
 const timezones = [...new Set([b.timezone, 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'])];
 return `<div class="settings-stack"><section class="card"><h2>Your business, at a glance.</h2><p class="section-intro">Keep your business name and time zone current. Appointments are scheduled through the connected calendar.</p><form id="business-form"><div class="form-grid"><label>Business name<input name="name" value="${esc(b.name)}" required maxlength="80" autocomplete="organization"></label><label>Primary contact name<input name="contact_name" value="${esc(b.contact_name || workspace.user.display_name)}" required maxlength="80" autocomplete="name"></label><label class="full">Booking page <span class="muted small">Optional · your existing HTTPS scheduling link</span><input name="booking_url" type="url" value="${esc(b.booking_url || '')}" placeholder="https://your-business.com/book" maxlength="2048"></label><label class="full">Business time zone<select name="timezone">${timezones.map(t => `<option ${t === b.timezone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></div><div class="form-footer"><p>${b.onboarding_completed_at ? 'Changes apply to your workspace.' : 'Saving completes your business profile.'}</p><button class="primary" type="submit">${b.onboarding_completed_at ? 'Save business details' : 'Save & complete profile'}</button></div></form></section>
 <section class="card"><h2>Keep your calls moving.</h2><p class="section-intro">Review how each HootOwl number handles incoming calls. Text messaging is disabled.</p>${workspace.routes.length ? workspace.routes.map(r => `<div class="route"><div class="route-head"><div><p class="eyebrow">YOUR HOOTOWL NUMBER</p><strong>${esc(r.twilio_number)}</strong></div>${badge(r.is_active ? 'Routing active' : 'Routing paused', !r.is_active)}</div><form data-route="${esc(r.id)}"><label>Forward incoming calls to<input name="destination_number" type="tel" autocomplete="tel" pattern="\+[1-9][0-9]{1,14}" ${r.intake_enabled ? '' : 'required'} value="${esc(r.destination_number||'')}"></label><button type="submit" class="secondary">Save number</button></form><p class="small muted">AI voice answering: ${r.is_active && r.intake_enabled ? 'enabled' : 'not enabled'}.</p></div>`).join('') : empty('Your number comes next.', 'HootOwl will connect your business number. You can finish your profile and personalize your workspace now.')}</section></div>`;
}
async function loadReceptionist() {
 try { receptionistData = await api('/receptionist'); if (view === 'receptionist') render(); }
 catch (error) { feedback(error.message, true); }
}
function receptionist() {
 if (!receptionistData) return `<section class="card"><p class="muted">Loading your AI receptionist…</p></section>`;
 const d = receptionistData, name = workspace.business.name;
 const p = d.profile || { assistant_name: '', business_name: name, name_only_when_asked: true, started_on: '', greeting: `Thanks for calling ${name}. How can we help you today?`,
  closing_line: '', services: '', service_area_label: '', service_radius_miles: 50, place_hints: '', voice_id: d.voices[0].id, ready: false };
 const voices = d.voices.some(v => v.id === p.voice_id) ? d.voices : [{ id: p.voice_id, name: 'Your current voice', description: 'Set up for you by HootOwl' }, ...d.voices];
 const aiOn = d.routes.some(r => r.is_active && r.intake_enabled);
 const canPreview = !!d.profile && d.routes.some(r => r.destination_number);
 const area = d.profile && !d.profile.has_service_center ? '<p class="muted small full">HootOwl sets your service area’s center point. Until it does, your assistant won’t turn callers away by distance.</p>' : '';
 return `<div class="settings-stack"><section class="card"><div class="section-heading"><h2>Meet your AI receptionist.</h2>${badge(p.ready ? 'Ready to answer' : 'Not ready yet', !p.ready)}</div>
 <p class="section-intro">Choose how your assistant greets callers, what it offers, and how it sounds. ${aiOn ? 'AI answering is on for your HootOwl number.' : 'HootOwl turns on AI answering for your number when your plan includes it. Until then, calls ring your phone.'}</p>
 <form id="receptionist-form"><div class="form-grid">
 <label>Assistant name<input name="assistant_name" value="${esc(p.assistant_name)}" required maxlength="60" placeholder="Cindy"></label>
 <label>Business name, as it should be spoken<input name="business_name" value="${esc(p.business_name)}" required maxlength="120"></label>
 <label class="full">Greeting <span class="muted small">The first thing every caller hears</span><textarea name="greeting" rows="2" required maxlength="300">${esc(p.greeting)}</textarea></label>
 <label class="full">Closing line <span class="muted small">Said once a caller’s details are saved. Leave blank for a standard line.</span><textarea name="closing_line" rows="2" maxlength="300">${esc(p.closing_line)}</textarea></label>
 <label class="full">Services you offer <span class="muted small">Optional</span><textarea name="services" rows="3" maxlength="1000" placeholder="Plumbing repairs, water heaters, drain cleaning">${esc(p.services)}</textarea></label>
 <label>Service area<input name="service_area_label" value="${esc(p.service_area_label)}" maxlength="200" placeholder="Nocona, Texas"></label>
 <label>Service radius in miles<input name="service_radius_miles" type="number" min="1" max="500" required value="${esc(p.service_radius_miles)}"></label>${area}
 <label class="full">Local place names <span class="muted small">Optional · town names callers might say that are easy to mishear</span><textarea name="place_hints" rows="2" maxlength="600">${esc(p.place_hints)}</textarea></label>
 <label>Start date <span class="muted small">Optional · used if a caller asks how long they’ve worked there</span><input name="started_on" type="date" value="${esc(p.started_on || '')}"></label>
 <label class="check-inline"><input type="checkbox" name="name_only_when_asked" ${p.name_only_when_asked ? 'checked' : ''}> Only say the assistant’s name when a caller asks</label>
 <fieldset class="full voice-picker"><legend>Voice</legend>${voices.map(v => `<label class="voice-option"><input type="radio" name="voice_id" value="${esc(v.id)}" ${v.id === p.voice_id ? 'checked' : ''} required><span><strong>${esc(v.name)}</strong><span class="muted small">${esc(v.description)}</span></span></label>`).join('')}</fieldset>
 <label class="check-inline full"><input type="checkbox" name="ready" ${p.ready ? 'checked' : ''}> My receptionist is ready to answer calls</label>
 </div><div class="form-footer"><p>Your assistant always follows HootOwl’s safety rules, never claims to be a person, and never sends texts.</p><button class="primary" type="submit">Save receptionist</button></div></form></section>
 <section class="card"><h2>Hear it for yourself.</h2><p class="section-intro">We’ll call your forwarding phone from your HootOwl number so you can talk to your assistant just like a caller would. Save first to hear your latest changes. Preview calls left today: ${esc(d.previews_left)}.</p>
 <button id="preview-call" class="secondary" ${canPreview && d.previews_left > 0 ? '' : 'disabled'}>✆ Call me to preview</button>${canPreview ? '' : '<p class="muted small">Save your receptionist and add a forwarding phone number on the Business page to use previews.</p>'}</section></div>`;
}
const options = (values, selected) => values.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
function preferences() {
 const u = workspace.user;
 return `<div class="grid"><div class="settings-stack"><section class="card"><h2>Make it yours.</h2><p class="section-intro">Preview your look as you choose. Save to use these preferences whenever you sign in, including on another device.</p><form id="preferences-form"><div class="form-grid"><label class="full">Your display name<input name="display_name" value="${esc(u.display_name)}" required maxlength="80" autocomplete="name"></label><label>Appearance<select name="theme">${options([['system', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']], u.theme)}</select></label><label>Accent color<select name="accent">${options([['forest', 'Forest green'], ['ocean', 'Ocean blue'], ['plum', 'Warm plum']], u.accent)}</select></label><label>Inbox spacing<select name="density">${options([['comfortable', 'Comfortable'], ['compact', 'Compact']], u.density)}</select></label><label>Time format<select name="time_format">${options([['12', '12-hour · 2:30 PM'], ['24', '24-hour · 14:30']], u.time_format)}</select></label></div><div class="form-footer"><p>These preferences are just for your account.</p><button class="primary" type="submit">Save my preferences</button></div></form></section><section class="card"><h2>Account security</h2><p class="section-intro">Signed in as ${esc(u.email)}. Changing your password signs out your other sessions.</p><form id="password-form"><label>Current password<input name="current_password" type="password" autocomplete="current-password" required maxlength="128"></label><label>New password<input name="new_password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><p class="muted small">Use between 12 and 128 characters.</p><button type="submit" class="secondary">Update password</button></form></section></div><div><section class="card"><p class="eyebrow">YOUR LOOK, AT A GLANCE</p><div class="preview-card"><div class="section-heading"><span class="monogram">${esc(initials(workspace.business.name))}</span>${badge('Your workspace')}</div><h3>${esc(workspace.business.name)}</h3><p>Room for your next conversation.</p><div class="swatches" aria-hidden="true"><span class="swatch"></span><span class="swatch"></span><span class="swatch"></span></div></div><p class="muted small">Colors and appearance update here as you choose. Press Save to keep them.</p></section><div class="mobile-actions"><button class="secondary" data-view="install">Add to my phone</button><button class="secondary" data-logout>Sign out</button></div></div></div>`;
}
function install() {
 const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
 return `<section class="hero"><div><p class="eyebrow">MADE TO GO WITH YOU</p><h2>One tap.<br>Back to your business.</h2><p>${standalone ? 'You’re already using HootOwl as a home-screen app on this device.' : 'Add HootOwl to your home screen for a full-screen workspace, without downloading an app from a store.'}</p>${installPrompt ? '<button id="install-now" class="primary">Install HootOwl →</button>' : ''}</div><div class="hero-art" aria-hidden="true"><div class="orbit"><span class="owl">HO</span></div></div></section><div class="install-grid"><section class="card"><h2>On iPhone or iPad</h2><ol class="steps"><li>Open this workspace in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>. If offered, turn on <strong>Open as Web App</strong>.</li><li>Tap <strong>Add</strong>, then open HootOwl from your home screen.</li></ol></section><section class="card"><h2>On Android</h2><ol class="steps"><li>Open this workspace in <strong>Chrome</strong>.</li><li>Open the browser’s three-dot menu.</li><li>Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li><li>Confirm, then open HootOwl from your home screen.</li></ol></section></div><p class="muted small">An internet connection is required to load leads and save changes. This release does not send push notifications. Use your regular workspace address, not a one-time invitation link, when installing.</p>`;
}
function bindForms() {
 if (view === 'plan') bindPlan();
 if ($('#business-form')) $('#business-form').onsubmit = event => {
  event.preventDefault(); submit(event.target, data => api('/business', { method: 'PATCH', body: JSON.stringify({ ...data, complete_setup: true }) }), async () => { await refresh(); feedback('Business details saved. Your profile is ready.'); }).catch(error => feedback(error.message, true));
 };
 if ($('#preferences-form')) {
  $('#preferences-form').onchange = event => applyTheme(Object.fromEntries(new FormData(event.currentTarget)));
  $('#preferences-form').onsubmit = event => { event.preventDefault(); submit(event.target, data => api('/preferences', { method: 'PATCH', body: JSON.stringify(data) }), async () => { await refresh(); feedback('Your preferences are saved to your account.'); }).catch(error => feedback(error.message, true)); };
 }
 if ($('#password-form')) $('#password-form').onsubmit = event => { event.preventDefault(); submit(event.target, data => api('/password', { method: 'POST', body: JSON.stringify(data) }), () => { event.target.reset(); feedback('Password updated. Your other sessions have been signed out.'); }).catch(error => feedback(error.message, true)); };
 document.querySelectorAll('form[data-route]').forEach(form => { form.onsubmit = event => { event.preventDefault(); submit(form, data => api('/routes/' + form.dataset.route, { method: 'PATCH', body: JSON.stringify(data) }), async () => { await refresh(); feedback('Call-forwarding number saved.'); }).catch(error => feedback(error.message, true)); }; });
 if ($('#receptionist-form')) $('#receptionist-form').onsubmit = event => {
  event.preventDefault(); const form = event.target;
  submit(form, data => api('/receptionist', { method: 'PUT', body: JSON.stringify({ ...data, service_radius_miles: Number(data.service_radius_miles),
   name_only_when_asked: form.elements.name_only_when_asked.checked, ready: form.elements.ready.checked }) }),
   async () => { receptionistData = null; await loadReceptionist(); feedback('Your AI receptionist is saved.'); }).catch(error => feedback(error.message, true));
 };
 if ($('#preview-call')) $('#preview-call').onclick = async event => {
  event.target.disabled = true;
  try { const result = await api('/receptionist/preview', { method: 'POST', body: '{}' }); feedback(`Calling ${result.calling} now. Answer to talk to your assistant.`); receptionistData = null; await loadReceptionist(); }
  catch (error) { feedback(error.message, true); event.target.disabled = false; }
 };
 if ($('#install-now')) $('#install-now').onclick = async () => { try { await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); } catch { feedback('Use your browser menu to add HootOwl to your home screen.', true); } };
}
async function logout() { try { await api('/session', { method: 'DELETE' }); showLogin(); $('#signin-form').reset(); $('#auth-error').textContent = ''; } catch (error) { feedback(error.message, true); } }
document.addEventListener('click', async event => {
 const button = event.target.closest('button'); if (!button) return;
 if (button.dataset.view) navigate(button.dataset.view);
 if (button.dataset.filter) { filter = button.dataset.filter; render(); }
 if (button.hasAttribute('data-logout')) await logout();
 if (button.dataset.lead) {
  const lead = leads.calls.find(c => c.call_sid === button.dataset.lead); if (!lead) return;
  leadId = lead.call_sid; $('#lead-title').textContent = lead.caller_number;
  $('#lead-form').elements.status.value = lead.follow_up_status; $('#lead-form').elements.notes.value = lead.customer_notes;
  $('#lead-error').textContent = ''; $('#lead-dialog').showModal();
 }
});
$('#signin-form').onsubmit = event => { event.preventDefault(); $('#auth-error').textContent = ''; submit(event.target, data => api('/session', { method: 'POST', body: JSON.stringify(data) }), async result => {
 event.target.reset();
 if (result.two_factor_required) return showTwoFactor(result);
 view = 'home'; await refresh();
}).catch(error => { $('#auth-error').textContent = error.message; }); };
const methodNames = { totp: 'Authenticator app', sms: 'Text message', recovery: 'Recovery code' };
function showTwoFactor(result) {
 challenge = result.challenge;
 const available = [result.methods.totp && 'totp', result.methods.sms && 'sms', 'recovery'].filter(Boolean);
 $('#twofa-method').innerHTML = available.map(m => `<option value="${m}">${methodNames[m]}</option>`).join('');
 $('#signin-form').hidden = true; $('#twofa-form').hidden = false;
 $('#auth-title').textContent = 'One more step.'; $('#auth-description').textContent = 'Enter a code to finish signing in.';
 syncTwoFactorMethod();
}
function syncTwoFactorMethod() { $('#twofa-sms').hidden = $('#twofa-method').value !== 'sms'; }
function hideTwoFactor() { challenge = null; $('#twofa-form').hidden = true; $('#twofa-form').reset(); showLogin(); }
$('#twofa-method').onchange = syncTwoFactorMethod;
$('#twofa-cancel').onclick = hideTwoFactor;
$('#twofa-sms').onclick = async () => { $('#auth-error').textContent = ''; try { await api('/session/2fa/sms', { method: 'POST', body: JSON.stringify({ challenge }) }); $('#auth-error').textContent = 'We texted you a code.'; } catch (error) { $('#auth-error').textContent = error.message; } };
$('#twofa-form').onsubmit = event => { event.preventDefault(); $('#auth-error').textContent = ''; submit(event.target, data => api('/session/2fa', { method: 'POST', body: JSON.stringify({ ...data, challenge }) }), async () => { challenge = null; event.target.reset(); event.target.hidden = true; view = 'home'; await refresh(); }).catch(error => { $('#auth-error').textContent = error.message; }); };
$('#join-form').onsubmit = event => { event.preventDefault(); $('#auth-error').textContent = ''; submit(event.target, data => api('/register', { method: 'POST', body: JSON.stringify({ ...data, token: invitation }) }), async () => { invitation = null; event.target.reset(); view = 'business'; await refresh(); }).catch(error => { $('#auth-error').textContent = error.message; }); };
$('#lead-form').onsubmit = event => { event.preventDefault(); submit(event.target, data => api('/leads/' + encodeURIComponent(leadId), { method: 'PATCH', body: JSON.stringify(data) }), async () => { $('#lead-dialog').close(); await refresh(); feedback('Follow-up saved.'); }).catch(error => { $('#lead-error').textContent = error.message; }); };
$('#close-lead').onclick = () => $('#lead-dialog').close(); $('#logout').onclick = logout; $('#refresh').onclick = () => { $('#feedback').hidden = true; refresh(); };
function networkStatus() { $('#network-status').hidden = navigator.onLine; }
addEventListener('online', networkStatus); addEventListener('offline', networkStatus); networkStatus();
addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; if (workspace && view === 'install') render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal/' }).catch(() => {});
(async () => {
 if (invitation) {
  $('#signin-form').hidden = true; $('#auth-title').textContent = 'Checking your invitation…';
  try { const details = await api('/invitation', { method: 'POST', body: JSON.stringify({ token: invitation }) }); $('#auth-title').textContent = 'Make yourself at home.'; $('#auth-description').textContent = 'Create your account for ' + details.name + '.'; $('#invite-email').value = details.email; $('#join-form').hidden = false; $('#auth-help').textContent = 'This invitation connects your account to your business. Already have an account? Open the regular workspace address to sign in.'; }
  catch (error) { showLogin(); $('#auth-error').textContent = error.message; }
 } else { await refresh(); }
})();
