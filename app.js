const COLORS = {
  accent: '#f2a93c',
  accent2: '#45b8ac',
  accent3: '#c98bd9',
  positive: '#6fcf97',
  negative: '#e8735c'
};

const NUM_FMT = new Intl.NumberFormat('fr-CH');
const CHF_FMT = new Intl.NumberFormat('fr-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

let evolutionChart = null;
let loyaltyChart = null;
let weekdayChart = null;
let currentRows = [];
let currentMetric = 'Total Entries';
let accessToken = null;
let tokenClient = null;
let hasStartedDashboard = false;

const AUTO_REFRESH_START = { hour: 9, minute: 10 };
const AUTO_REFRESH_END = { hour: 20, minute: 10 };
const AUTO_REFRESH_STEP_MINUTES = 60;

let lastRefreshAt = Date.now();

const METRIC_LABELS = {
  'Total Entries': 'Entrées',
  'Charged Unique Users': 'Participants',
  'Net Revenue CHF': 'Revenu net (CHF)',
  'Stops Cumulés': 'Stops cumulés'
};

const WEEKDAY_COLUMNS = ['Entrées Lundi', 'Entrées Mardi', 'Entrées Mercredi', 'Entrées Jeudi', 'Entrées Vendredi', 'Entrées Samedi', 'Entrées Dimanche'];
const WEEKDAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

function cleanNumber(raw) {
  if (typeof raw !== 'string') return Number(raw) || 0;
  const cleaned = raw.replace(/[',’\s]/g, '').replace(/CHF/gi, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ---- Authentification Google ----

function showSigninError(message) {
  const el = document.getElementById('signin-error');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DASHBOARD_CONFIG.googleClientId,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    callback: (response) => {
      if (response.error) {
        if (hasStartedDashboard) {
          showStatus('Session Google expirée. Recharge la page et reconnecte-toi.');
          return;
        }
        showSigninError("Connexion Google refusée ou annulée. Réessaie.");
        return;
      }
      accessToken = response.access_token;
      if (!hasStartedDashboard) {
        hasStartedDashboard = true;
        showSigninError('');
        document.getElementById('signin-screen').style.display = 'none';
        document.getElementById('app-shell').style.display = 'block';
        startDashboard();
        scheduleAutoRefresh();
      } else {
        const select = document.getElementById('contest-select');
        if (select.value) loadContest(select.value);
      }
    }
  });

  document.getElementById('signin-button').addEventListener('click', () => {
    showSigninError('');
    tokenClient.requestAccessToken();
  });
}

// ---- Rafraîchissement automatique (H+10 de 9h10 à 20h10) ----

function nextAutoRefreshSlot() {
  const now = new Date();
  const startTotalMin = AUTO_REFRESH_START.hour * 60 + AUTO_REFRESH_START.minute;
  const endTotalMin = AUTO_REFRESH_END.hour * 60 + AUTO_REFRESH_END.minute;
  for (let mins = startTotalMin; mins <= endTotalMin; mins += AUTO_REFRESH_STEP_MINUTES) {
    const slot = new Date(now);
    slot.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    if (slot.getTime() > now.getTime()) return slot;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(AUTO_REFRESH_START.hour, AUTO_REFRESH_START.minute, 0, 0);
  return tomorrow;
}

function scheduleAutoRefresh() {
  const delay = nextAutoRefreshSlot().getTime() - Date.now();
  setTimeout(() => {
    refreshData();
    scheduleAutoRefresh();
  }, delay);
}

function refreshData() {
  lastRefreshAt = Date.now();
  const select = document.getElementById('contest-select');
  if (select.value) loadContest(select.value);
}

// Filet de sécurité : un onglet mis en veille/arrière-plan par le navigateur
// (mise en veille de l'ordi, throttling des timers) peut manquer un créneau
// programmé. Quand l'onglet redevient visible, on rattrape si un créneau
// aurait dû se déclencher entre-temps.
function catchUpAutoRefreshIfNeeded() {
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const startMin = AUTO_REFRESH_START.hour * 60 + AUTO_REFRESH_START.minute;
  const endMin = AUTO_REFRESH_END.hour * 60 + AUTO_REFRESH_END.minute;
  const withinWindow = totalMin >= startMin && totalMin <= endMin;
  const minutesSinceLastRefresh = (Date.now() - lastRefreshAt) / 60000;
  if (withinWindow && minutesSinceLastRefresh >= AUTO_REFRESH_STEP_MINUTES) {
    refreshData();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasStartedDashboard) {
    catchUpAutoRefreshIfNeeded();
  }
});

// ---- Bouton de rafraîchissement manuel ----

function setupManualRefresh() {
  const btn = document.getElementById('refresh-button');
  btn.addEventListener('click', () => {
    btn.classList.remove('is-spinning');
    void btn.offsetWidth; // relance l'animation même si elle vient de tourner
    btn.classList.add('is-spinning');
    refreshData();
  });
}

// ---- Plein écran ----

function setupFullscreenToggle() {
  const btn = document.getElementById('fullscreen-button');
  btn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = !!document.fullscreenElement;
    document.body.classList.toggle('is-fullscreen', isFullscreen);
    const label = isFullscreen ? 'Quitter le plein écran' : 'Plein écran';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // Le conteneur change de taille en dehors d'un resize de fenêtre classique :
    // on force les charts à se redimensionner plutôt que de compter sur leur
    // ResizeObserver, qui peut rater la transition plein écran. L'animation
    // d'entrée/sortie du plein écran n'est pas terminée au moment où cet
    // événement se déclenche, donc on redimensionne aussi une fois qu'elle
    // a eu le temps de se terminer.
    const resizeCharts = () => [evolutionChart, loyaltyChart, weekdayChart].forEach(chart => chart && chart.resize());
    resizeCharts();
    setTimeout(resizeCharts, 300);
  });
}

// ---- Récupération des données via l'API Google Sheets ----

function sheetApiUrl(sheetTab) {
  const range = encodeURIComponent(`${sheetTab}!A:Z`);
  return `https://sheets.googleapis.com/v4/spreadsheets/${DASHBOARD_CONFIG.sheetId}/values/${range}`;
}

function populateContestSelect() {
  const select = document.getElementById('contest-select');
  select.innerHTML = '';
  DASHBOARD_CONFIG.contests.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => loadContest(select.value));
}

function showStatus(message) {
  const el = document.getElementById('status-message');
  const main = document.getElementById('dashboard-content');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
  main.style.display = message ? 'none' : 'block';
}

function loadContest(contestId) {
  const contest = DASHBOARD_CONFIG.contests.find(c => c.id === contestId);
  if (!contest || !accessToken) return;

  document.getElementById('station-name').textContent = contest.station || '';
  showStatus('Chargement des données…');

  fetch(sheetApiUrl(contest.sheetTab), {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  })
    .then(res => {
      if (res.status === 401) {
        // Token expiré : on le renouvelle en silence, ce qui redéclenchera loadContest().
        tokenClient.requestAccessToken({ prompt: '' });
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(json => {
      if (!json) return;
      const values = json.values || [];
      if (values.length < 2) {
        showStatus(`Aucune donnée trouvée dans l'onglet "${contest.sheetTab}". Vérifie que le nom de l'onglet dans config.js correspond exactement.`);
        return;
      }
      const header = values[0];
      const rows = values.slice(1).map(row => {
        const obj = {};
        header.forEach((key, i) => { obj[key] = row[i]; });
        return obj;
      }).filter(r => r.Timestamp);

      currentRows = rows;
      showStatus('');
      renderDashboard(rows);
    })
    .catch(err => {
      if (err.message && err.message.includes('403')) {
        showStatus("Ton compte Google n'a pas accès à ce Sheet. Vérifie que tu es connecté avec le bon compte et que tu as au moins un accès lecteur sur le document.");
      } else {
        showStatus("Impossible de charger les données (" + err.message + ").");
      }
    });
}

// ---- Rendu ----

function renderDashboard(rows) {
  const latest = rows[rows.length - 1];
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;

  renderKpis(latest, previous);
  renderLastUpdate(latest.Timestamp);
  renderNetworkSplit(latest);
  renderStats(latest);
  renderEvolutionChart(rows, currentMetric);
  renderLoyalty(latest);
  renderWeekdayVolume(latest);
}

function renderDelta(elId, latestVal, prevVal, formatter) {
  const el = document.getElementById(elId);
  if (prevVal === null || prevVal === undefined) { el.textContent = ''; return; }
  const diff = latestVal - prevVal;
  const formattedAbs = formatter(Math.abs(diff));
  if (!/[1-9]/.test(formattedAbs)) { el.textContent = 'stable / h'; el.classList.remove('positive'); return; }
  el.textContent = `${diff > 0 ? '▲ +' : '▼ '}${formattedAbs} / h`;
  el.classList.toggle('positive', diff > 0);
}

function renderKpis(latest, previous) {
  const users = cleanNumber(latest['Charged Unique Users']);
  const chargedEntries = cleanNumber(latest['Charged Entries']);
  const entries = cleanNumber(latest['Total Entries']);
  const revenue = cleanNumber(latest['Net Revenue CHF']);

  document.getElementById('kpi-users').textContent = NUM_FMT.format(users);
  document.getElementById('kpi-charged-entries').textContent = NUM_FMT.format(chargedEntries);
  document.getElementById('kpi-entries').textContent = NUM_FMT.format(entries);
  document.getElementById('kpi-revenue').textContent = CHF_FMT.format(revenue);

  if (previous) {
    renderDelta('kpi-users-delta', users, cleanNumber(previous['Charged Unique Users']), n => NUM_FMT.format(n));
    renderDelta('kpi-charged-entries-delta', chargedEntries, cleanNumber(previous['Charged Entries']), n => NUM_FMT.format(n));
    renderDelta('kpi-entries-delta', entries, cleanNumber(previous['Total Entries']), n => NUM_FMT.format(n));
    renderDelta('kpi-revenue-delta', revenue, cleanNumber(previous['Net Revenue CHF']), n => CHF_FMT.format(n));
  } else {
    ['kpi-users-delta', 'kpi-charged-entries-delta', 'kpi-entries-delta', 'kpi-revenue-delta'].forEach(id => {
      document.getElementById(id).textContent = '';
    });
  }
}

function renderLastUpdate(timestamp) {
  const date = new Date(timestamp);
  const el = document.getElementById('last-update');
  if (isNaN(date.getTime())) { el.textContent = ''; return; }
  const minsAgo = Math.round((Date.now() - date.getTime()) / 60000);
  const timeStr = date.toLocaleString('fr-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  el.textContent = minsAgo >= 0 && minsAgo < 180
    ? `Mise à jour il y a ${minsAgo} min (${timeStr})`
    : `Dernière donnée : ${timeStr}`;
}

function renderNetworkSplit(latest) {
  const operators = [
    { label: 'Swisscom', value: cleanNumber(latest['Swisscom']), color: COLORS.accent },
    { label: 'Sunrise', value: cleanNumber(latest['Sunrise']), color: COLORS.accent2 },
    { label: 'Salt', value: cleanNumber(latest['Salt']), color: COLORS.accent3 }
  ];
  const total = operators.reduce((sum, o) => sum + o.value, 0) || 1;

  const container = document.getElementById('network-split');
  container.innerHTML = operators.map(o => {
    const pct = (o.value / total) * 100;
    return `
      <div class="bar-row">
        <span>${o.label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${o.color};"></div></div>
        <span class="bar-value">${pct.toFixed(0)}%</span>
      </div>`;
  }).join('');
}

function renderStats(latest) {
  document.getElementById('stat-delivered').textContent = NUM_FMT.format(cleanNumber(latest['Delivered Bulk']));
  document.getElementById('stat-bulkcost').textContent = CHF_FMT.format(cleanNumber(latest['Bulk Cost CHF']));
  document.getElementById('stat-cap').textContent = NUM_FMT.format(cleanNumber(latest['Entry Cap']));
  document.getElementById('stat-errors').textContent = NUM_FMT.format(cleanNumber(latest['Error Count']));
}

function renderEvolutionChart(rows, metric) {
  const labels = rows.map(r => {
    const d = new Date(r.Timestamp);
    return d.toLocaleString('fr-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  });
  const data = rows.map(r => cleanNumber(r[metric]));

  const ctx = document.getElementById('evolution-chart').getContext('2d');
  if (evolutionChart) evolutionChart.destroy();

  evolutionChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: METRIC_LABELS[metric],
        data,
        borderColor: COLORS.accent,
        backgroundColor: 'rgba(242, 169, 60, 0.12)',
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#868c99', maxTicksLimit: 8, font: { family: 'Inter', size: 11 } },
          grid: { color: '#2a2f3a' }
        },
        y: {
          ticks: { color: '#868c99', font: { family: 'Inter', size: 11 } },
          grid: { color: '#2a2f3a' }
        }
      }
    }
  });
}

function renderLoyalty(latest) {
  const once = cleanNumber(latest['Participants 1x']);
  const multi = cleanNumber(latest['Participants 2x+']);
  const total = once + multi || 1;

  const segments = [
    { label: '1 participation', value: once, color: COLORS.accent },
    { label: '2+ participations', value: multi, color: COLORS.accent2 }
  ];

  const ctx = document.getElementById('loyalty-chart').getContext('2d');
  if (loyaltyChart) loyaltyChart.destroy();

  loyaltyChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: segments.map(s => s.label),
      datasets: [{
        data: segments.map(s => s.value),
        backgroundColor: segments.map(s => s.color),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });

  const legend = document.getElementById('loyalty-legend');
  legend.innerHTML = segments.map(s => {
    const pct = (s.value / total) * 100;
    return `
      <div class="legend-row">
        <span class="legend-dot" style="background:${s.color};"></span>
        <span>${s.label}</span>
        <span class="legend-value">${NUM_FMT.format(s.value)} (${pct.toFixed(0)}%)</span>
      </div>`;
  }).join('');
}

function renderWeekdayVolume(latest) {
  const data = WEEKDAY_COLUMNS.map(col => cleanNumber(latest[col]));

  const ctx = document.getElementById('weekday-chart').getContext('2d');
  if (weekdayChart) weekdayChart.destroy();

  weekdayChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: WEEKDAY_LABELS,
      datasets: [{
        data,
        backgroundColor: COLORS.accent,
        borderRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#868c99', font: { family: 'Inter', size: 11 } },
          grid: { color: '#2a2f3a' }
        },
        y: {
          ticks: { color: '#868c99', font: { family: 'Inter', size: 11 } },
          grid: { color: '#2a2f3a' }
        }
      }
    }
  });
}

function setupMetricToggle() {
  const buttons = document.querySelectorAll('#metric-toggle button');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMetric = btn.dataset.metric;
      if (currentRows.length) renderEvolutionChart(currentRows, currentMetric);
    });
  });
}

function startDashboard() {
  populateContestSelect();
  setupMetricToggle();
  setupManualRefresh();
  setupFullscreenToggle();
  if (DASHBOARD_CONFIG.contests.length > 0) {
    document.getElementById('contest-select').value = DASHBOARD_CONFIG.contests[0].id;
    loadContest(DASHBOARD_CONFIG.contests[0].id);
  } else {
    showStatus('Aucun concours configuré. Ajoute-en un dans config.js.');
  }
}

initAuth();
