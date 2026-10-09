'use strict';

// ------------------------------------------------------------------ helpers

const state = { me: null, slack: null, authMode: 'dev' };
const $app = document.getElementById('app');

// Tiny DOM builder. Strings become text nodes, so user data is never parsed as HTML.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (typeof body === 'string') { opts.headers['Content-Type'] = 'text/csv'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith('/auth')) { state.me = null; render(); throw new Error('Please sign in'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}

// Wrap an async handler so failures surface as a toast.
const act = (fn) => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message, true); } };

function modal(title, body, actions) {
  const root = document.getElementById('modal-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('h2', {}, title), body, h('div', { class: 'actions' }, actions(close))));
  root.replaceChildren(backdrop);
  backdrop.querySelector('input, select, textarea')?.focus();
  return close;
}

function field(label, input) { return h('label', { class: 'field' }, label, input); }
function fmtMinutes(m) { if (!m) return ''; return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; }
function fmtDate(s) { return s ? s.slice(0, 10) : '—'; }
function bar(percent) { return h('div', { class: `bar${percent >= 100 ? ' done' : ''}`, title: `${percent}%` }, h('span', { style: `width:${percent}%` })); }
function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
const TYPE_LABEL = { course: 'Course', video: 'Video', document: 'Doc', quiz: 'Quiz', live_session: 'Live session', link: 'Link' };
const isStaff = () => ['admin', 'manager'].includes(state.me?.role);
const isAdmin = () => state.me?.role === 'admin';

function dueBadge(a) {
  if (a.completed_at) return h('span', { class: 'pill ok' }, `Completed ${fmtDate(a.completed_at)}`);
  if (a.overdue) return h('span', { class: 'pill bad' }, `Overdue · ${a.due_at}`);
  if (a.due_at) return h('span', { class: 'pill warn' }, `Due ${a.due_at}`);
  return h('span', { class: 'pill' }, 'No due date');
}

function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle && h('div', { class: 'muted' }, subtitle)),
    h('div', { class: 'row' }, actions));
}

// ------------------------------------------------------------------ router

const routes = [
  ['my-learning', MyLearning],
  ['plans', Plans],
  ['plans/:id', PlanDetail],
  ['content', Content],
  ['people', People, isStaff],
  ['people/:id', Person, isStaff],
  ['reports', Reports, isStaff],
  ['reports/plans/:id', PlanReport, isStaff],
  ['slack', SlackPage, isAdmin],
];

function renderNav() {
  const current = location.hash.slice(2).split('/')[0] || 'my-learning';
  const links = [['my-learning', 'My learning'], ['plans', 'Learning plans'], ['content', 'Content']];
  if (isStaff()) links.push(['people', 'People'], ['reports', 'Reports']);
  if (isAdmin()) links.push(['slack', 'Slack']);
  document.getElementById('nav').replaceChildren(...(state.me ? links.map(([path, label]) =>
    h('a', { href: `#/${path}`, class: current === path ? 'active' : '' }, label)) : []));
  document.getElementById('whoami').replaceChildren(...(state.me ? [
    h('span', { class: 'muted' }, `${state.me.name} · ${state.me.role}`),
    state.authMode === 'dev' && h('button', { onclick: act(async () => { await api('POST', '/auth/logout'); state.me = null; render(); }) }, 'Sign out'),
  ] : []));
}

async function render() {
  renderNav();
  if (!state.me) return $app.replaceChildren(Login());
  const path = location.hash.slice(2) || 'my-learning';
  for (const [pattern, view, guard] of routes) {
    const re = new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`);
    const m = path.match(re);
    if (!m) continue;
    if (guard && !guard()) break;
    $app.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    try {
      $app.replaceChildren(await view(...m.slice(1)));
    } catch (e) {
      $app.replaceChildren(h('div', { class: 'empty' }, e.message));
    }
    return;
  }
  location.hash = '#/my-learning';
}

window.addEventListener('hashchange', render);

(async function boot() {
  try { state.authMode = (await api('GET', '/auth/config')).mode; } catch { /* default */ }
  try { const r = await api('GET', '/api/me'); state.me = r.user; state.slack = r.slack; } catch { /* not signed in */ }
  render();
})();

// ------------------------------------------------------------------ login

function Login() {
  if (state.authMode !== 'dev') {
    return h('div', { class: 'card login' }, h('h1', {}, 'Not signed in'),
      h('p', { class: 'muted' }, 'Your SSO session did not map to an active LMS user. Ask Sales Enablement to add you.'));
  }
  const email = h('input', { type: 'email', placeholder: 'you@example.com', required: true, autocomplete: 'email' });
  return h('form', {
    class: 'card login',
    onsubmit: act(async (e) => {
      e.preventDefault();
      const r = await api('POST', '/auth/login', { email: email.value });
      const me = await api('GET', '/api/me');
      state.me = r.user; state.slack = me.slack;
      render();
    }),
  },
  h('h1', {}, 'Seller Academy'),
  h('p', { class: 'muted' }, 'Development sign-in. In production this is replaced by Okta SSO.'),
  field('Work email', email),
  h('button', { class: 'primary', type: 'submit' }, 'Sign in'),
  h('p', { class: 'muted small' }, 'Demo accounts: admin@example.com, sam.rivera@example.com (manager), jordan.lee@example.com (learner).'));
}

// ------------------------------------------------------------------ my learning

async function MyLearning() {
  const assignments = await api('GET', '/api/me/learning');
  const open = assignments.filter((a) => !a.completed_at);
  const done = assignments.filter((a) => a.completed_at);
  return h('div', {},
    pageHead(`Hi ${state.me.name.split(' ')[0]}`, 'Your assigned learning plans and courses.'),
    h('div', { class: 'tiles' },
      tile(open.length, 'In progress'), tile(open.filter((a) => a.overdue).length, 'Overdue'), tile(done.length, 'Completed')),
    h('h2', {}, 'To do'),
    open.length ? h('div', { class: 'grid' }, open.map((a) => AssignmentCard(a, true))) : h('div', { class: 'card empty' }, 'Nothing assigned right now. 🎉'),
    done.length > 0 && [h('h2', {}, 'Completed'), h('div', { class: 'grid' }, done.map((a) => AssignmentCard(a, true)))]);
}

function tile(num, label) {
  return h('div', { class: 'card tile' }, h('div', { class: 'num' }, num), h('div', { class: 'label' }, label));
}

function AssignmentCard(a, editable, manage) {
  const setStatus = (item, status) => act(async () => {
    const r = await api('POST', '/api/progress', { itemId: item.id, status });
    if (r.completedAssignments.length) toast(`🎉 Completed: ${r.completedAssignments.length > 1 ? `${r.completedAssignments.length} assignments` : a.title}`);
    render();
  });
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h3', {}, a.kind === 'plan' ? h('a', { href: `#/plans/${a.plan_id}` }, a.title) : a.title),
      dueBadge(a)),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('div', { style: 'flex:1' }, bar(a.progress.percent)),
      h('span', { class: 'muted small' }, `${a.progress.completed}/${a.progress.total} required`)),
    manage,
    h('ul', { class: 'items' }, a.items.map((it) => h('li', {},
      h('span', { class: `status-dot ${it.status}`, title: it.status.replace('_', ' ') }, it.status === 'completed' ? '✓' : ''),
      h('div', { class: 'grow' },
        it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title,
        h('div', { class: 'muted small' }, [TYPE_LABEL[it.type], fmtMinutes(it.duration_minutes), !it.required && 'optional'].filter(Boolean).join(' · '))),
      editable && (it.status === 'completed'
        ? h('button', { class: 'link small', onclick: setStatus(it, 'in_progress') }, 'Undo')
        : [it.status === 'not_started' && h('button', { class: 'small', onclick: setStatus(it, 'in_progress') }, 'Start'),
          h('button', { class: 'primary small', onclick: setStatus(it, 'completed') }, 'Mark complete')])))));
}

// ------------------------------------------------------------------ plans

async function Plans() {
  const plans = await api('GET', '/api/plans');
  return h('div', {},
    pageHead('Learning plans', 'Curated sequences of content assigned to sellers.',
      isAdmin() && h('button', { class: 'primary', onclick: () => PlanEditor() }, 'New plan')),
    plans.length ? h('div', { class: 'grid' }, plans.map((p) => h('div', { class: 'card' },
      h('h3', {}, h('a', { href: `#/plans/${p.id}` }, p.title)),
      p.description && h('p', { class: 'muted' }, p.description),
      h('div', { class: 'row muted small' },
        `${p.item_count} items`, '·', fmtMinutes(p.total_minutes) || '0 min', p.due_days != null && ['·', `due in ${p.due_days} days`]),
      isStaff() && h('div', { class: 'row', style: 'margin-top:10px' },
        h('div', { style: 'flex:1' }, bar(pct(p.completed_count, p.assigned_count))),
        h('span', { class: 'small muted' }, `${p.completed_count}/${p.assigned_count} completed`)),
    ))) : h('div', { class: 'card empty' }, 'No learning plans yet.'));
}

async function PlanDetail(id) {
  const plan = await api('GET', `/api/plans/${id}`);
  return h('div', {},
    pageHead(plan.title, plan.description,
      isStaff() && h('button', { class: 'primary', onclick: () => AssignModal({ planId: plan.id }) }, 'Assign'),
      isStaff() && h('a', { class: 'btn', href: `#/reports/plans/${plan.id}` }, 'View progress'),
      isAdmin() && h('button', { onclick: () => PlanEditor(plan) }, 'Edit'),
      isAdmin() && h('button', {
        onclick: act(async () => {
          await api('PATCH', `/api/plans/${plan.id}`, { archived: !plan.archived });
          toast(plan.archived ? 'Plan restored' : 'Plan archived'); render();
        }),
      }, plan.archived ? 'Restore' : 'Archive')),
    plan.archived ? h('p', {}, h('span', { class: 'pill' }, 'Archived')) : null,
    h('p', { class: 'muted' }, plan.due_days != null ? `Default due date: ${plan.due_days} days after assignment.` : 'No default due date.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Item'), h('th', {}, 'Type'), h('th', {}, 'Length'), h('th', {}, 'Required'))),
      h('tbody', {}, plan.items.map((it, i) => h('tr', {},
        h('td', {}, i + 1),
        h('td', {}, it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title,
          it.description && h('div', { class: 'muted small' }, it.description)),
        h('td', {}, TYPE_LABEL[it.type]), h('td', {}, fmtMinutes(it.duration_minutes)),
        h('td', {}, it.required ? 'Yes' : h('span', { class: 'muted' }, 'Optional'))))))));
}

async function PlanEditor(plan) {
  const content = await api('GET', '/api/content');
  const title = h('input', { value: plan?.title || '', required: true });
  const desc = h('textarea', { value: plan?.description || '' });
  const due = h('input', { type: 'number', min: 0, value: plan?.due_days ?? '', placeholder: 'e.g. 30' });
  let items = (plan?.items || []).map((it) => ({ item_id: it.id, title: it.title, required: Boolean(it.required) }));
  const list = h('ul', { class: 'plan-items' });
  const picker = h('select', {});

  function draw() {
    list.replaceChildren(...items.map((it, i) => h('li', {},
      h('span', { class: 'grow' }, `${i + 1}. ${it.title}`),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: it.required, onchange: (e) => { it.required = e.target.checked; } }), 'required'),
      h('button', { type: 'button', disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); }, title: 'Move up' }, '↑'),
      h('button', { type: 'button', disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); }, title: 'Move down' }, '↓'),
      h('button', { type: 'button', class: 'danger', onclick: () => { items.splice(i, 1); draw(); }, title: 'Remove' }, '✕'))));
    if (!items.length) list.append(h('li', { class: 'muted' }, 'No items yet.'));
    const used = new Set(items.map((x) => x.item_id));
    picker.replaceChildren(h('option', { value: '' }, 'Add content…'),
      ...content.filter((c) => !used.has(c.id)).map((c) => h('option', { value: c.id }, `${c.title} (${TYPE_LABEL[c.type]})`)));
  }
  picker.addEventListener('change', () => {
    const c = content.find((x) => x.id === Number(picker.value));
    if (c) { items.push({ item_id: c.id, title: c.title, required: true }); draw(); }
  });
  draw();

  modal(plan ? 'Edit learning plan' : 'New learning plan',
    h('div', {}, field('Title', title), field('Description', desc), field('Due (days after assignment)', due),
      h('div', { class: 'field' }, h('strong', { class: 'small' }, 'Content'), list, picker)),
    (close) => [
      h('button', { onclick: close }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: act(async () => {
          const body = { title: title.value, description: desc.value, due_days: due.value, items };
          const saved = plan ? await api('PATCH', `/api/plans/${plan.id}`, body) : await api('POST', '/api/plans', body);
          close(); toast('Plan saved');
          if (location.hash === `#/plans/${saved.id}`) render(); else location.hash = `#/plans/${saved.id}`;
        }),
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ content

async function Content() {
  const content = await api('GET', '/api/content');
  return h('div', {},
    pageHead('Content library', 'Courses, videos, docs, quizzes and live sessions.',
      isAdmin() && h('button', { class: 'primary', onclick: () => ContentEditor() }, 'Add content')),
    content.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Type'), h('th', {}, 'Length'), h('th', {}, 'In plans'), h('th', {}))),
      h('tbody', {}, content.map((c) => h('tr', {},
        h('td', {}, c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.title) : c.title,
          c.description && h('div', { class: 'muted small' }, c.description)),
        h('td', {}, TYPE_LABEL[c.type]), h('td', {}, fmtMinutes(c.duration_minutes)), h('td', {}, c.plan_count),
        h('td', { style: 'white-space:nowrap;text-align:right' },
          isStaff() && h('button', { onclick: () => AssignModal({ itemId: c.id }) }, 'Assign'), ' ',
          isAdmin() && h('button', { onclick: () => ContentEditor(c) }, 'Edit'), ' ',
          isAdmin() && h('button', {
            class: 'danger',
            onclick: act(async () => {
              if (!confirm(`Delete "${c.title}"? It will be removed from all plans and assignments.`)) return;
              await api('DELETE', `/api/content/${c.id}`); toast('Deleted'); render();
            }),
          }, 'Delete'))))))) : h('div', { class: 'card empty' }, 'No content yet.'));
}

function ContentEditor(c) {
  const title = h('input', { value: c?.title || '' });
  const type = h('select', {}, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v, selected: c?.type === v }, l)));
  const url = h('input', { type: 'url', value: c?.url || '', placeholder: 'https://…' });
  const dur = h('input', { type: 'number', min: 0, value: c?.duration_minutes ?? '' });
  const desc = h('textarea', { value: c?.description || '' });
  modal(c ? 'Edit content' : 'Add content',
    h('div', {}, field('Title', title), field('Type', type), field('URL', url), field('Duration (minutes)', dur), field('Description', desc)),
    (close) => [
      h('button', { onclick: close }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: act(async () => {
          const body = { title: title.value, type: type.value, url: url.value, duration_minutes: dur.value, description: desc.value };
          if (c) await api('PATCH', `/api/content/${c.id}`, body); else await api('POST', '/api/content', body);
          close(); toast('Saved'); render();
        }),
      }, 'Save'),
    ]);
}

// ------------------------------------------------------------------ assigning

/**
 * opts: { planId?, itemId?, userIds?, filter? } — anything missing is chosen in the dialog.
 */
async function AssignModal(opts = {}) {
  const [plans, content, facets] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/content'), api('GET', '/api/users/facets')]);
  const what = h('select', {},
    h('optgroup', { label: 'Learning plans' }, plans.map((p) => h('option', { value: `plan:${p.id}`, selected: opts.planId === p.id }, p.title))),
    h('optgroup', { label: 'Single content items' }, content.map((c) => h('option', { value: `item:${c.id}`, selected: opts.itemId === c.id }, c.title))));
  const due = h('input', { type: 'date' });
  const dueHint = h('div', { class: 'muted small' });
  const updateHint = () => {
    const [kind, id] = what.value.split(':');
    const p = kind === 'plan' && plans.find((x) => x.id === Number(id));
    dueHint.textContent = p && p.due_days != null ? `Leave blank to use the plan default (${p.due_days} days).` : 'Optional.';
  };
  what.addEventListener('change', updateHint); updateHint();

  const filterSelects = {};
  let target;
  if (opts.userIds?.length) {
    target = h('p', {}, `${opts.userIds.length} selected ${opts.userIds.length === 1 ? 'person' : 'people'}`);
  } else {
    target = h('div', {},
      h('p', { class: 'muted small', style: 'margin-top:0' }, 'Assign to everyone (active) matching all chosen filters.'),
      h('div', { class: 'row' }, ['team', 'region', 'segment', 'role'].map((k) => {
        filterSelects[k] = h('select', {}, h('option', { value: '' }, `Any ${k}`), facets[k].map((v) => h('option', { value: v, selected: opts.filter?.[k] === v }, v)));
        return filterSelects[k];
      })));
  }
  const notify = h('input', { type: 'checkbox', checked: Boolean(state.slack?.enabled), disabled: !state.slack?.enabled });

  modal('Assign learning',
    h('div', {},
      field('What', what),
      h('div', { class: 'field' }, h('span', {}, 'Who'), target),
      field('Due date', h('div', {}, due, dueHint)),
      h('label', { class: 'check' }, notify, state.slack?.enabled ? 'Notify in Slack' : 'Notify in Slack (Slack not configured)')),
    (close) => [
      h('button', { onclick: close }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: act(async () => {
          const [kind, id] = what.value.split(':');
          const filter = Object.fromEntries(Object.entries(filterSelects).map(([k, s]) => [k, s.value]).filter(([, v]) => v));
          if (!opts.userIds?.length && !Object.keys(filter).length && !confirm('No filters chosen — assign to every active user?')) return;
          const r = await api('POST', '/api/assignments', {
            [kind === 'plan' ? 'planId' : 'itemId']: Number(id),
            userIds: opts.userIds || [],
            filter: opts.userIds?.length ? undefined : filter,
            allUsers: !opts.userIds?.length && !Object.keys(filter).length,
            dueAt: due.value || undefined,
            notify: notify.checked,
          });
          close();
          toast(`Assigned to ${r.created}${r.skipped ? ` (${r.skipped} already had it)` : ''}${r.slack ? ` · ${r.slack.sent} Slack DM(s) sent` : ''}`);
          render();
        }),
      }, 'Assign'),
    ]);
}

// ------------------------------------------------------------------ people

const peopleFilter = { q: '', team: '', region: '', segment: '', role: '' };

async function People() {
  const params = new URLSearchParams(Object.entries(peopleFilter).filter(([, v]) => v));
  const [users, facets] = await Promise.all([api('GET', `/api/users?${params}`), api('GET', '/api/users/facets')]);
  const selected = new Set();
  const assignBtn = h('button', { class: 'primary', disabled: true, onclick: () => AssignModal({ userIds: [...selected] }) }, 'Assign to selected');
  const sync = () => { assignBtn.disabled = !selected.size; assignBtn.textContent = selected.size ? `Assign to ${selected.size} selected` : 'Assign to selected'; };

  const q = h('input', { type: 'search', placeholder: 'Search name or email', value: peopleFilter.q });
  let qTimer;
  q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { peopleFilter.q = q.value; render(); }, 300); });

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none', onchange: act(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const report = await api('POST', '/api/users/import', await file.text());
    e.target.value = '';
    modal('Import results',
      h('div', {},
        h('p', {}, `${report.created} created, ${report.updated} updated, ${report.errors.length} error(s).`),
        report.errors.length > 0 && h('pre', { class: 'errors' }, report.errors.map((x) => `Row ${x.row}${x.email ? ` (${x.email})` : ''}: ${x.error}`).join('\n'))),
      (close) => [h('button', { class: 'primary', onclick: () => { close(); render(); } }, 'Done')]);
  }) });

  const allBox = h('input', { type: 'checkbox', onchange: (e) => {
    $app.querySelectorAll('tbody input[type=checkbox]').forEach((cb) => { cb.checked = e.target.checked; cb.dispatchEvent(new Event('change')); });
  } });

  return h('div', {},
    pageHead('People', `${users.length} ${users.length === 1 ? 'person' : 'people'}`,
      isAdmin() && [fileInput,
        h('button', { onclick: () => fileInput.click() }, 'Import CSV'),
        h('a', { class: 'btn', href: '/users-template.csv', download: 'users-template.csv' }, 'CSV template'),
        h('button', { onclick: () => UserEditor() }, 'Add person')],
      h('button', { onclick: () => AssignModal({ filter: { ...peopleFilter, q: undefined } }) }, 'Assign by filter'),
      assignBtn),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, q,
      ['team', 'region', 'segment', 'role'].map((k) => h('select', { onchange: (e) => { peopleFilter[k] = e.target.value; render(); } },
        h('option', { value: '' }, `All ${k}s`), facets[k].map((v) => h('option', { value: v, selected: peopleFilter[k] === v }, v))))),
    users.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, allBox), h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', {}, 'Team'), h('th', {}, 'Region'), h('th', {}, 'Segment'), h('th', {}, 'Manager'), h('th', {}, 'Slack'))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('input', { type: 'checkbox', onchange: (e) => { e.target.checked ? selected.add(u.id) : selected.delete(u.id); sync(); } })),
        h('td', {}, h('a', { href: `#/people/${u.id}` }, u.name), !u.active && [' ', h('span', { class: 'pill' }, 'inactive')],
          h('div', { class: 'muted small' }, [u.title, u.email].filter(Boolean).join(' · '))),
        h('td', {}, u.role), h('td', {}, u.team || '—'), h('td', {}, u.region || '—'), h('td', {}, u.segment || '—'),
        h('td', {}, u.manager_name || '—'),
        h('td', {}, u.slack_user_id ? h('span', { class: 'pill ok' }, 'linked') : h('span', { class: 'pill' }, '—'))))))) : h('div', { class: 'card empty' }, 'No people match.'));
}

function UserEditor(u, onSaved) {
  const f = {};
  const input = (k, attrs = {}) => (f[k] = h('input', { value: u?.[k] ?? '', ...attrs }));
  const role = (f.role = h('select', {}, ['learner', 'manager', 'admin'].map((r) => h('option', { value: r, selected: (u?.role || 'learner') === r }, r))));
  const active = h('input', { type: 'checkbox', checked: u ? Boolean(u.active) : true });
  modal(u ? 'Edit person' : 'Add person',
    h('div', {},
      field('Name', input('name')), field('Email', input('email', { type: 'email' })), field('Title', input('title')),
      field('Role', role), field('Team', input('team')), field('Region', input('region')), field('Segment', input('segment')),
      field('Manager email', (f.manager_email = h('input', { type: 'email', value: u?.manager_email || '' }))),
      field('Slack user ID', input('slack_user_id', { placeholder: 'Looked up by email if blank' })),
      h('label', { class: 'check' }, active, 'Active')),
    (close) => [
      h('button', { onclick: close }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: act(async () => {
          const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
          body.active = active.checked;
          if (u) await api('PATCH', `/api/users/${u.id}`, body); else await api('POST', '/api/users', body);
          close(); toast('Saved'); onSaved ? onSaved() : render();
        }),
      }, 'Save'),
    ]);
}

async function Person(id) {
  const { user, assignments } = await api('GET', `/api/users/${id}/learning`);
  const manager = (a) => h('div', { class: 'row small', style: 'margin-top:8px' },
    h('button', { class: 'small', onclick: act(async () => {
      const v = prompt('New due date (YYYY-MM-DD), blank to clear', a.due_at || '');
      if (v === null) return;
      await api('PATCH', `/api/assignments/${a.id}`, { dueAt: v.trim() || null }); toast('Due date updated'); render();
    }) }, 'Change due date'),
    h('button', { class: 'small danger', onclick: act(async () => {
      if (!confirm(`Remove "${a.title}" from ${user.name}?`)) return;
      await api('DELETE', `/api/assignments/${a.id}`); toast('Assignment removed'); render();
    }) }, 'Unassign'));
  return h('div', {},
    pageHead(user.name, [user.title, user.email, user.team, user.region].filter(Boolean).join(' · '),
      h('button', { class: 'primary', onclick: () => AssignModal({ userIds: [user.id] }) }, 'Assign'),
      isAdmin() && h('button', { onclick: () => UserEditor(user) }, 'Edit')),
    assignments.length ? h('div', { class: 'grid' }, assignments.map((a) => AssignmentCard(a, false, manager(a))))
      : h('div', { class: 'card empty' }, 'Nothing assigned yet.'));
}

// ------------------------------------------------------------------ reports

async function Reports() {
  const r = await api('GET', '/api/reports/overview');
  const t = r.totals;
  const statusTable = (rows, nameCell) => h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Assigned'), h('th', {}, 'Completed'), h('th', {}, 'Overdue'), h('th', { style: 'width:30%' }, 'Completion'))),
    h('tbody', {}, rows.map((x) => h('tr', {},
      h('td', {}, nameCell(x)), h('td', {}, x.assigned), h('td', {}, x.completed || 0),
      h('td', {}, x.overdue ? h('span', { class: 'pill bad' }, x.overdue) : 0),
      h('td', {}, h('div', { class: 'row' }, h('div', { style: 'flex:1' }, bar(pct(x.completed, x.assigned))), h('span', { class: 'small muted' }, `${pct(x.completed, x.assigned)}%`))))))));

  return h('div', {},
    pageHead('Reports', state.me.role === 'manager' ? 'Your reporting org.' : 'All sellers.'),
    h('div', { class: 'tiles' },
      tile(t.learners, 'Learners'), tile(t.assignments, 'Assignments'),
      tile(`${pct(t.completed, t.assignments)}%`, 'Completion rate'), tile(t.overdue, 'Overdue')),
    h('h2', {}, 'By learning plan'),
    r.plans.length ? statusTable(r.plans, (p) => h('a', { href: `#/reports/plans/${p.id}` }, p.title)) : h('div', { class: 'card empty' }, 'No plan assignments yet.'),
    h('h2', {}, 'By team'),
    r.byTeam.length ? statusTable(r.byTeam.map((x) => ({ ...x })), (x) => x.team) : h('div', { class: 'card empty' }, 'No assignments yet.'),
    h('h2', {}, 'Overdue'),
    r.overdue.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Assignment'), h('th', {}, 'Due'), h('th', {}, 'Progress'))),
      h('tbody', {}, r.overdue.map((a) => h('tr', {},
        h('td', {}, h('a', { href: `#/people/${a.user_id}` }, a.user_name)),
        h('td', {}, a.title), h('td', {}, h('span', { class: 'pill bad' }, a.due_at)),
        h('td', {}, a.plan_id ? h('a', { href: `#/reports/plans/${a.plan_id}` }, 'view') : '—')))))) : h('div', { class: 'card empty' }, 'Nothing overdue. 🎉'));
}

async function PlanReport(id) {
  const { plan, learners } = await api('GET', `/api/reports/plans/${id}`);
  const label = { completed: '✓', in_progress: '…', not_started: '' };
  return h('div', {},
    pageHead(plan.title, `${learners.length} assigned · ${learners.filter((l) => l.completed_at).length} completed`,
      h('a', { class: 'btn', href: `/api/reports/plans/${plan.id}?format=csv` }, 'Export CSV'),
      h('button', { class: 'primary', onclick: () => AssignModal({ planId: plan.id }) }, 'Assign')),
    learners.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Due'), h('th', {}, 'Progress'),
        plan.items.map((it, i) => h('th', { title: it.title, style: 'text-align:center' }, `${i + 1}`)))),
      h('tbody', {}, learners.map((l) => h('tr', {},
        h('td', {}, h('a', { href: `#/people/${l.user_id}` }, l.name), h('div', { class: 'muted small' }, [l.team, l.region].filter(Boolean).join(' · '))),
        h('td', {}, dueBadge(l)),
        h('td', { style: 'min-width:140px' }, h('div', { class: 'row' }, h('div', { style: 'flex:1' }, bar(l.progress.percent)), h('span', { class: 'small muted' }, `${l.progress.percent}%`))),
        plan.items.map((it) => h('td', { style: 'text-align:center' },
          h('span', { class: `status-dot ${l.items[it.id]}`, style: 'display:inline-grid', title: `${it.title}: ${l.items[it.id].replace('_', ' ')}` }, label[l.items[it.id]])))))))) : h('div', { class: 'card empty' }, 'Nobody assigned yet.'),
    h('h2', {}, 'Items'),
    h('ol', { class: 'muted' }, plan.items.map((it) => h('li', {}, it.title, !it.required && ' (optional)'))));
}

// ------------------------------------------------------------------ slack

async function SlackPage() {
  const s = await api('GET', '/api/slack/status');
  const item = (ok, label) => h('li', {}, h('span', { class: `pill ${ok ? 'ok' : 'bad'}` }, ok ? 'configured' : 'missing'), ' ', label);
  return h('div', {},
    pageHead('Slack integration', 'Assignment DMs, due-date reminders, manager digests, plan completion shout-outs and the /learn command.'),
    h('div', { class: 'card' },
      h('h3', {}, 'Status'),
      h('ul', { style: 'list-style:none;padding:0' },
        item(s.enabled, 'SLACK_BOT_TOKEN — needed to send messages'),
        item(s.signingSecret, 'SLACK_SIGNING_SECRET — needed for /learn and buttons'),
        item(Boolean(s.announceChannel), `SLACK_ANNOUNCE_CHANNEL — completion shout-outs${s.announceChannel ? ` (${s.announceChannel})` : ' (optional)'}`)),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: !s.enabled, onclick: act(async () => {
          const r = await api('POST', '/api/slack/reminders', {});
          toast(`Reminders sent to ${r.learners} learner(s) and ${r.managers} manager(s)`);
        }) }, 'Send reminders now'),
        h('button', { disabled: !s.enabled, onclick: act(async () => {
          const r = await api('POST', '/api/slack/link-users', {});
          toast(`Linked ${r.linked} user(s) to Slack by email`);
        }) }, 'Link users by email'))),
    h('h2', {}, 'Setup'),
    h('ol', { class: 'card', style: 'padding-left:36px' },
      h('li', {}, 'Create a Slack app from the manifest in ', h('code', {}, 'slack-app-manifest.yml'), ' (replace the URLs with this server’s public URL).'),
      h('li', {}, 'Install it to the workspace and copy the Bot User OAuth Token and Signing Secret into the environment.'),
      h('li', {}, 'Schedule ', h('code', {}, 'npm run reminders'), ' daily, or set ', h('code', {}, 'REMINDER_INTERVAL_HOURS'), '.'),
      h('li', {}, 'Sellers type ', h('code', {}, '/learn'), ' in Slack to see their open learning and mark items complete.')));
}
