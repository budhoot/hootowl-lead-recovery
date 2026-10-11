'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let workspace, leads = { calls: [], replies: [] }, view = 'home', filter = 'open', leadId, requestId = 0, installPrompt;
let invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
if (invitation) history.replaceState(null, '', location.pathname);
const titles = { home: 'A good day starts here.', inbox: 'Every conversation matters.', business: 'Make yourself at home.', preferences: 'A space that feels like you.', install: 'Your business. In your pocket.' };
const labels = { home: 'YOUR WORKSPACE', inbox: 'YOUR LEAD INBOX', business: 'BUSINESS SETTINGS', preferences: 'APPEARANCE & ACCOUNT', install: 'TAKE HOOTOWL WITH YOU' };
const statusLabel = value => ({ new: 'New', in_progress: 'Following up', resolved: 'Resolved' }[value] || value);
function date(value) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: workspace.business.timezone, hour12: workspace.user.time_format === '12' }).format(new Date(value)); }
const initials = name => name.split(/\s+/).slice(0, 2).map(v => v[0]).join('').toUpperCase();
const badge = (label, paused = false) => `<span class="badge${paused ? ' paused' : ''}">${esc(label)}</span>`;
const empty = (title, message) => `<div class="empty"><div class="empty-icon" aria-hidden="true">☷</div><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
function feedback(message, isError = false) { $('#feedback').textContent = message; $('#feedback').className = isError ? 'error' : ''; $('#feedback').hidden = false; }
function applyTheme(user) { for (const key of ['theme', 'accent', 'density']) document.documentElement.dataset[key] = user[key]; }
function showLogin() {
 requestId++; workspace = null; leads = { calls: [], replies: [] }; $('#content').replaceChildren();
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
 $('#content').innerHTML = ({ home, inbox, business, preferences, install })[view]();
 bindForms();
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
 if ($('#business-form')) $('#business-form').onsubmit = event => {
  event.preventDefault(); submit(event.target, data => api('/business', { method: 'PATCH', body: JSON.stringify({ ...data, complete_setup: true }) }), async () => { await refresh(); feedback('Business details saved. Your profile is ready.'); }).catch(error => feedback(error.message, true));
 };
 if ($('#preferences-form')) {
  $('#preferences-form').onchange = event => applyTheme(Object.fromEntries(new FormData(event.currentTarget)));
  $('#preferences-form').onsubmit = event => { event.preventDefault(); submit(event.target, data => api('/preferences', { method: 'PATCH', body: JSON.stringify(data) }), async () => { await refresh(); feedback('Your preferences are saved to your account.'); }).catch(error => feedback(error.message, true)); };
 }
 if ($('#password-form')) $('#password-form').onsubmit = event => { event.preventDefault(); submit(event.target, data => api('/password', { method: 'POST', body: JSON.stringify(data) }), () => { event.target.reset(); feedback('Password updated. Your other sessions have been signed out.'); }).catch(error => feedback(error.message, true)); };
 document.querySelectorAll('form[data-route]').forEach(form => { form.onsubmit = event => { event.preventDefault(); submit(form, data => api('/routes/' + form.dataset.route, { method: 'PATCH', body: JSON.stringify(data) }), async () => { await refresh(); feedback('Call-forwarding number saved.'); }).catch(error => feedback(error.message, true)); }; });
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
$('#signin-form').onsubmit = event => { event.preventDefault(); $('#auth-error').textContent = ''; submit(event.target, data => api('/session', { method: 'POST', body: JSON.stringify(data) }), async () => { event.target.reset(); view = 'home'; await refresh(); }).catch(error => { $('#auth-error').textContent = error.message; }); };
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
