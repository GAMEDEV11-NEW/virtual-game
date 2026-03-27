const page = String(document.body?.dataset?.page || '').trim();

const state = {
  page: 1,
  limit: 25,
  search: '',
  total: 0,
  historyRows: [],
  expandedMatchKeyRows: {},
  liveKind: 'match',
  expandedContestRows: {},
  autoRefreshEnabled: true,
  autoRefreshTimer: null
};

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(value) {
  if (!value) return '';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  const HH = pad(dt.getHours());
  const mm = pad(dt.getMinutes());
  const ss = pad(dt.getSeconds());
  const dd = pad(dt.getDate());
  const MM = pad(dt.getMonth() + 1);
  const yyyy = dt.getFullYear();
  return `${HH}:${mm}:${ss} ${dd}-${MM}-${yyyy}`;
}

function qs(obj) {
  const params = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      params.set(k, String(v));
    }
  });
  return params.toString();
}

function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

function syncAutoRefreshButton() {
  const btn = document.getElementById('autoRefreshToggle');
  if (!btn) return;
  btn.textContent = state.autoRefreshEnabled ? 'Auto Refresh: ON' : 'Auto Refresh: OFF';
}

function startAutoRefresh(loader) {
  stopAutoRefresh();
  if (!state.autoRefreshEnabled) return;
  state.autoRefreshTimer = setInterval(() => {
    loader().catch(() => {});
  }, 5000);
}

function bindAutoRefreshToggle(loader) {
  syncAutoRefreshButton();
  on('autoRefreshToggle', 'click', () => {
    state.autoRefreshEnabled = !state.autoRefreshEnabled;
    syncAutoRefreshButton();
    if (state.autoRefreshEnabled) {
      loader().catch(() => {});
      startAutoRefresh(loader);
    } else {
      stopAutoRefresh();
    }
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    ...options
  });

  if (response.status === 401) {
    if (page !== 'login') window.location.href = '/login';
    throw new Error('unauthorized');
  }

  return response.json();
}

async function checkSession() {
  try {
    const response = await fetch('/api/session', { credentials: 'include' });
    if (response.status !== 200) return false;
    const data = await response.json();
    return !!data.authenticated;
  } catch (_) {
    return false;
  }
}

async function getSessionDataOrRedirect() {
  const response = await fetch('/api/session', { credentials: 'include' });
  if (response.status !== 200) {
    window.location.href = '/login';
    return null;
  }
  const data = await response.json();
  if (!data || !data.authenticated) {
    window.location.href = '/login';
    return null;
  }
  const usersNavLink = document.getElementById('usersNavLink');
  if (usersNavLink && data.can_manage_users) {
    usersNavLink.style.display = '';
  }
  return data;
}

async function doLogout() {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  } catch (_) {
  }
  window.location.href = '/login';
}

function renderPageInfo() {
  const pageInfo = document.getElementById('pageInfo');
  if (!pageInfo) return;
  const totalPages = Math.max(1, Math.ceil((state.total || 0) / state.limit));
  pageInfo.textContent = `Page ${state.page} / ${totalPages} | Total ${state.total}`;

  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  if (prevBtn) prevBtn.disabled = state.page <= 1;
  if (nextBtn) nextBtn.disabled = state.page >= totalPages;
}

async function loadDashboard() {
  const data = await fetchJson('/api/overview');
  const serviceEl = document.getElementById('service');
  if (serviceEl) serviceEl.textContent = JSON.stringify(data.service || {}, null, 2);

  const live = data.live || {};
  const counts = live.redis_counts || {};
  const cards = [
    ['server id', live.server_id || '-'],
    ['active game count', live.active_game_count || 0],
    ['scanned match keys', live.scanned_match_keys || 0],
    ['match keys', counts.match_keys || 0],
    ['match_server keys', counts.match_server_keys || 0],
    ['contest_join keys', counts.contest_join_keys || 0],
    ['user_to_socket keys', counts.user_to_socket_keys || 0],
    ['socket_to_user keys', counts.socket_to_user_keys || 0]
  ];

  const cardsEl = document.getElementById('liveCards');
  if (cardsEl) {
    cardsEl.innerHTML = cards
      .map(([key, value]) => `<div class="card"><div class="k">${key}</div><div class="v">${value}</div></div>`)
      .join('');
  }
}

async function loadLive() {
  const query = qs({ page: state.page, limit: state.limit, q: state.search, kind: state.liveKind });
  const data = await fetchJson(`/api/live?${query}`);
  state.total = Number(data.total || 0);
  renderPageInfo();

  const isContestJoin = state.liveKind === 'contest_join';
  const head = document.getElementById('liveTableHead');
  if (head) {
    head.innerHTML = isContestJoin
      ? '<tr><th>Key</th><th>User</th><th>Contest</th><th>LID</th><th>League</th><th>Status</th><th>Match</th><th>Joined</th><th>Details</th></tr>'
      : '<tr><th>Key</th><th>Status</th><th>User1</th><th>User2</th><th>Turn</th><th>Updated</th><th>Details</th></tr>';
  }

  const body = document.querySelector('#liveTable tbody');
  if (!body) return;
  const rows = Array.isArray(data.items) ? data.items : [];
  body.innerHTML = rows.map((row) => {
    if (isContestJoin) {
      const rowKey = String(row.key || `${row.user_id || ''}:${row.contest_id || ''}:${row.l_id || ''}`);
      const expanded = !!state.expandedContestRows[rowKey];
      const safeRowKey = esc(rowKey);
      return `<tr>
        <td class="mono">${esc(row.key || '')}</td>
        <td>${esc(row.user_id || '')}</td>
        <td>${esc(row.contest_id || '')}</td>
        <td class="mono">${esc(row.l_id || '')}</td>
        <td>${esc(row.league_id || '')}</td>
        <td>${esc(row.status || '')}</td>
        <td class="mono">${esc(row.match_id || '')}</td>
        <td>${esc(row.joined_at || '')}</td>
        <td><button type="button" data-action="toggle-contest-detail" data-key="${safeRowKey}">${expanded ? 'Hide' : 'View'}</button></td>
      </tr>
      <tr class="live-contest-detail-row" style="${expanded ? '' : 'display:none'}">
        <td colspan="9" class="mono">${esc(JSON.stringify(row.details || {}, null, 2))}</td>
      </tr>`;
    }
    const rowKey = String(row.key || `match:${row.game_id || ''}`);
    const expanded = !!state.expandedContestRows[rowKey];
    const safeRowKey = esc(rowKey);
    return `<tr>
      <td class="mono">${esc(row.key || '')}</td>
      <td>${esc(row.status || '')}</td>
      <td>${esc(row.user1_id || '')}</td>
      <td>${esc(row.user2_id || '')}</td>
      <td>${esc(row.turn || '')}</td>
      <td>${esc(row.updated_at || '')}</td>
      <td><button type="button" data-action="toggle-contest-detail" data-key="${safeRowKey}">${expanded ? 'Hide' : 'View'}</button></td>
    </tr>
    <tr class="live-contest-detail-row" style="${expanded ? '' : 'display:none'}">
      <td colspan="7" class="mono">${esc(JSON.stringify(row.details || {}, null, 2))}</td>
    </tr>`;
  }).join('');
}

async function loadHistory() {
  const query = qs({ page: state.page, limit: state.limit, q: state.search });
  const data = await fetchJson(`/api/historic?${query}`);
  state.total = Number(data.total || 0);
  state.historyRows = Array.isArray(data.items) ? data.items : [];
  renderPageInfo();

  const statusBody = document.querySelector('#historicStatusTable tbody');
  const statuses = Array.isArray(data.status_counts) ? data.status_counts : [];
  if (statusBody) {
    statusBody.innerHTML = statuses
      .map((row) => `<tr><td>${row.status || ''}</td><td>${row.count || 0}</td></tr>`)
      .join('');
  }

  const body = document.querySelector('#historicTable tbody');
  if (!body) return;
  const rows = state.historyRows;
  body.innerHTML = rows.map((row, index) => {
    const userLabel = row.user_name ? `${row.user_name} (${row.user_id || ''})` : String(row.user_id || '');
    const opponentLabel = row.opponent_name ? `${row.opponent_name} (${row.opponent_user_id || ''})` : String(row.opponent_user_id || '');
    const expanded = !!state.expandedMatchKeyRows[index];
    const matchId = row.match_id || '';
    const hasMatchId = !!String(matchId).trim();
    return (
    `<tr class="history-main-row">
      <td class="mono">
        ${hasMatchId ? `<button type="button" data-action="toggle-match-key" data-index="${index}">${expanded ? 'Unmatch' : 'Match'}</button>` : ''}
      </td>
      <td class="mono">${row.l_id || ''}</td>
      <td class="mono">${row.opponent_l_id || ''}</td>
      <td>${esc(userLabel)}</td>
      <td>${esc(opponentLabel)}</td>
      <td>${row.contest_id || ''}</td>
      <td>${row.status || ''}</td>
      <td>${row.contest_type || ''}</td>
      <td>${row.turn_id || ''}</td>
      <td>${row.winner_user_id || ''}</td>
      <td>${row.server_id || ''}</td>
      <td>${formatTimestamp(row.last_move_at)}</td>
      <td>${row.lock_version || ''}</td>
      <td>${formatTimestamp(row.joined_at)}</td>
      <td>${formatTimestamp(row.started_at)}</td>
      <td>${formatTimestamp(row.ended_at)}</td>
      <td><button type="button" data-action="preview-history" data-index="${index}">View</button></td>
    </tr>
    <tr class="history-matchkey-row" style="${expanded && hasMatchId ? '' : 'display:none'}">
      <td colspan="17" class="cell-match-key mono">${matchId}</td>
    </tr>`
    );
  }).join('');
}

function renderHistoryPreview(value) {
  const preview = document.getElementById('historyPreview');
  if (!preview) return;
  preview.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function loadHistoryS3Preview(row) {
  if (!row || !row.match_id) {
    renderHistoryPreview('Match ID missing for preview.');
    return;
  }

  renderHistoryPreview('Loading S3 file...');
  try {
    const data = await fetchJson(`/api/historic/${encodeURIComponent(row.match_id)}/state`);
    if (data.status !== 'ok') {
      renderHistoryPreview({
        status: 'error',
        message: data.message || 'failed_to_load_s3_state'
      });
      return;
    }
    renderHistoryPreview({
      match_id: data.match_id || '',
      s3_key: data.s3_key || '',
      updated_at: formatTimestamp(data.updated_at),
      s3_state: data.s3_state || {}
    });
  } catch (error) {
    renderHistoryPreview({
      status: 'error',
      message: error?.message || 'failed_to_load_s3_state'
    });
  }
}

function bindCommonControls(loader) {
  on('logoutBtn', 'click', () => {
    doLogout().catch(() => {});
  });

  on('pageSizeSelect', 'change', (e) => {
    state.limit = Math.max(1, Number(e.target.value || 25));
    state.page = 1;
    loader().catch(() => {});
  });

  on('searchInput', 'input', (e) => {
    state.search = String(e.target.value || '').trim();
    state.page = 1;
    loader().catch(() => {});
  });

  on('refreshBtn', 'click', () => {
    loader().catch(() => {});
  });

  on('prevBtn', 'click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loader().catch(() => {});
    }
  });

  on('nextBtn', 'click', () => {
    state.page += 1;
    loader().catch(() => {});
  });
}

async function initLoginPage() {
  const ok = await checkSession();
  if (ok) {
    window.location.href = '/dashboard';
    return;
  }

  async function doLogin() {
    const user = String(document.getElementById('loginUser')?.value || '').trim();
    const pass = String(document.getElementById('loginPass')?.value || '');
    const errEl = document.getElementById('loginError');
    if (errEl) errEl.textContent = '';

    if (!user || !pass) {
      if (errEl) errEl.textContent = 'Username and password are required.';
      return;
    }

    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: user, password: pass })
    });
    const data = await response.json();
    if (response.status !== 200 || data.status !== 'ok') {
      if (errEl) errEl.textContent = 'Invalid username or password.';
      return;
    }
    window.location.href = '/dashboard';
  }

  on('loginBtn', 'click', () => {
    doLogin().catch(() => {});
  });

  on('loginPass', 'keydown', (e) => {
    if (e.key === 'Enter') doLogin().catch(() => {});
  });
}

async function initDashboardPage() {
  const session = await getSessionDataOrRedirect();
  if (!session) return;
  on('logoutBtn', 'click', () => {
    doLogout().catch(() => {});
  });
  bindAutoRefreshToggle(loadDashboard);

  await loadDashboard();
  startAutoRefresh(loadDashboard);
}

async function initLivePage() {
  const session = await getSessionDataOrRedirect();
  if (!session) return;

  on('liveKindMatch', 'click', () => {
    state.liveKind = 'match';
    state.page = 1;
    const a = document.getElementById('liveKindMatch');
    const b = document.getElementById('liveKindContestJoin');
    if (a) a.classList.add('active');
    if (b) b.classList.remove('active');
    const input = document.getElementById('searchInput');
    if (input) input.placeholder = 'Search game/user/status...';
    loadLive().catch(() => {});
  });

  on('liveKindContestJoin', 'click', () => {
    state.liveKind = 'contest_join';
    state.page = 1;
    const a = document.getElementById('liveKindMatch');
    const b = document.getElementById('liveKindContestJoin');
    if (a) a.classList.remove('active');
    if (b) b.classList.add('active');
    const input = document.getElementById('searchInput');
    if (input) input.placeholder = 'Search contest/user/lid...';
    loadLive().catch(() => {});
  });

  bindCommonControls(loadLive);
  bindAutoRefreshToggle(loadLive);
  const tableBody = document.querySelector('#liveTable tbody');
  if (tableBody) {
    tableBody.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = String(target.dataset?.action || '').trim();
      if (action !== 'toggle-contest-detail') return;
      const key = String(target.dataset?.key || '').trim();
      if (!key) return;
      state.expandedContestRows[key] = !state.expandedContestRows[key];
      loadLive().catch(() => {});
    });
  }
  await loadLive();
  startAutoRefresh(loadLive);
}

async function initHistoryPage() {
  const session = await getSessionDataOrRedirect();
  if (!session) return;

  bindCommonControls(loadHistory);
  renderHistoryPreview('Click "View" to load S3 JSON file data.');
  const tableBody = document.querySelector('#historicTable tbody');
  if (tableBody) {
    tableBody.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = String(target.dataset?.action || '').trim();
      const index = Number(target.dataset?.index);
      const row = Number.isFinite(index) ? state.historyRows[index] : null;
      if (!row) return;

      if (action === 'toggle-match-key') {
        state.expandedMatchKeyRows[index] = !state.expandedMatchKeyRows[index];
        loadHistory().catch(() => {});
        return;
      }

      if (action === 'preview-history') {
        loadHistoryS3Preview(row).catch(() => {});
      }
    });
  }
  await loadHistory();
}

async function loadUsers() {
  const data = await fetchJson('/api/users');
  const body = document.querySelector('#usersTable tbody');
  const envAdminUser = String(data.env_admin_user || '').trim();
  const currentUser = String(data.current_user || '').trim();
  const rows = Array.isArray(data.users) ? data.users : [];
  if (body) {
    const createRow = `
      <tr>
        <td><input id="createUsername" type="text" placeholder="new username" /></td>
        <td><input id="createPassword" type="password" placeholder="new password" /></td>
        <td><button data-action="create-user" type="button">Create</button></td>
      </tr>`;

    const userRows = rows.map((u) => {
      const username = String(u.username || '').trim();
      const safeUsername = esc(username);
      const isProtected = username === envAdminUser;
      const isCurrent = username === currentUser;
      return `<tr>
        <td>${safeUsername}</td>
        <td><input type="password" data-password-for="${safeUsername}" placeholder="enter new password" /></td>
        <td class="users-actions">
          <button data-action="update-user" data-username="${safeUsername}" type="button">Update</button>
          <button data-action="delete-user" data-username="${safeUsername}" type="button" ${isProtected ? 'disabled' : ''}>Delete</button>
          ${isProtected ? '<span class="badge">env-admin</span>' : ''}
          ${isCurrent ? '<span class="badge">you</span>' : ''}
        </td>
      </tr>`;
    }).join('');

    body.innerHTML = createRow + userRows;
  }
}

async function initUsersPage() {
  const session = await getSessionDataOrRedirect();
  if (!session) return;
  if (!session.can_manage_users) {
    window.location.href = '/dashboard';
    return;
  }

  on('logoutBtn', 'click', () => {
    doLogout().catch(() => {});
  });

  const msgEl = document.getElementById('usersMessage');
  const tableBody = document.querySelector('#usersTable tbody');
  if (tableBody) {
    tableBody.addEventListener('click', (event) => {
      Promise.resolve().then(async () => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action = String(target.dataset?.action || '').trim();
        if (!action) return;
        if (msgEl) msgEl.textContent = '';

        if (action === 'create-user') {
          const username = String(document.getElementById('createUsername')?.value || '').trim();
          const password = String(document.getElementById('createPassword')?.value || '');
          if (!username || !password) {
            if (msgEl) msgEl.textContent = 'Create: username and password required.';
            return;
          }
          const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (res.status !== 200 || data.status !== 'ok') {
            if (msgEl) msgEl.textContent = `Create failed: ${data.message || 'unknown_error'}`;
            return;
          }
          if (msgEl) msgEl.textContent = 'User created.';
          await loadUsers();
          return;
        }

        const username = String(target.dataset?.username || '').trim();
        if (!username) return;

        if (action === 'update-user') {
          const safeUsername = (window.CSS && typeof window.CSS.escape === 'function')
            ? window.CSS.escape(username)
            : username.replace(/["\\]/g, '\\$&');
          const pwdInput = document.querySelector(`input[data-password-for="${safeUsername}"]`);
          const password = String(pwdInput?.value || '');
          if (!password) {
            if (msgEl) msgEl.textContent = 'Update: new password required.';
            return;
          }
          const res = await fetch(`/api/users/${encodeURIComponent(username)}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ password })
          });
          const data = await res.json();
          if (res.status !== 200 || data.status !== 'ok') {
            if (msgEl) msgEl.textContent = `Update failed: ${data.message || 'unknown_error'}`;
            return;
          }
          if (msgEl) msgEl.textContent = 'Password updated.';
          await loadUsers();
          return;
        }

        if (action === 'delete-user') {
          const ok = window.confirm(`Delete user "${username}"?`);
          if (!ok) return;
          const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
            method: 'DELETE',
            credentials: 'include'
          });
          const data = await res.json();
          if (res.status !== 200 || data.status !== 'ok') {
            if (msgEl) msgEl.textContent = `Delete failed: ${data.message || 'unknown_error'}`;
            return;
          }
          if (msgEl) msgEl.textContent = 'User deleted.';
          await loadUsers();
        }
      }).catch(() => {});
    });
  }

  await loadUsers();
}

if (page === 'login') {
  initLoginPage().catch(() => {});
} else if (page === 'dashboard') {
  initDashboardPage().catch(() => {});
} else if (page === 'live') {
  initLivePage().catch(() => {});
} else if (page === 'history') {
  initHistoryPage().catch(() => {});
} else if (page === 'users') {
  initUsersPage().catch(() => {});
}
