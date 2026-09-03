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
let currentRows = [];
let currentMetric = 'Total Entries';

const METRIC_LABELS = {
  'Total Entries': 'Entrées',
  'Charged Unique Users': 'Participants',
  'Net Revenue CHF': 'Revenu net (CHF)'
};

function cleanNumber(raw) {
  if (typeof raw !== 'string') return Number(raw) || 0;
  const cleaned = raw.replace(/[',’\s]/g, '').replace(/CHF/gi, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function csvUrlFor(sheetTab) {
  const encodedTab = encodeURIComponent(sheetTab);
  return `https://docs.google.com/spreadsheets/d/${DASHBOARD_CONFIG.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodedTab}`;
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
  if (!contest) return;

  document.getElementById('station-name').textContent = contest.station || '';
  showStatus('Chargement des données…');

  Papa.parse(csvUrlFor(contest.sheetTab), {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      const rows = results.data.filter(r => r.Timestamp);
      if (rows.length === 0) {
        showStatus(`Aucune donnée trouvée dans l'onglet "${contest.sheetTab}". Vérifie que le nom de l'onglet dans config.js correspond exactement, et que le Sheet est partagé en "Toute personne disposant du lien".`);
        return;
      }
      currentRows = rows;
      showStatus('');
      renderDashboard(rows);
    },
    error: () => {
      showStatus("Impossible de charger les données. Vérifie que le Google Sheet est bien partagé en \"Toute personne disposant du lien peut consulter\".");
    }
  });
}

function renderDashboard(rows) {
  const latest = rows[rows.length - 1];
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;

  renderKpis(latest, previous);
  renderLastUpdate(latest.Timestamp);
  renderNetworkSplit(latest);
  renderStats(latest);
  renderEvolutionChart(rows, currentMetric);
}

function renderDelta(elId, latestVal, prevVal, formatter) {
  const el = document.getElementById(elId);
  if (!previousExists(prevVal)) { el.textContent = ''; return; }
  const diff = latestVal - prevVal;
  if (diff === 0) { el.textContent = 'stable / h'; el.classList.remove('positive'); return; }
  el.textContent = `${diff > 0 ? '▲ +' : '▼ '}${formatter(Math.abs(diff))} / h`;
  el.classList.toggle('positive', diff > 0);
}

function previousExists(v) { return v !== null && v !== undefined; }

function renderKpis(latest, previous) {
  const users = cleanNumber(latest['Charged Unique Users']);
  const entries = cleanNumber(latest['Total Entries']);
  const revenue = cleanNumber(latest['Net Revenue CHF']);
  const cost = cleanNumber(latest['Bulk Cost CHF']);

  document.getElementById('kpi-users').textContent = NUM_FMT.format(users);
  document.getElementById('kpi-entries').textContent = NUM_FMT.format(entries);
  document.getElementById('kpi-revenue').textContent = CHF_FMT.format(revenue);
  document.getElementById('kpi-cost').textContent = CHF_FMT.format(cost);

  if (previous) {
    renderDelta('kpi-users-delta', users, cleanNumber(previous['Charged Unique Users']), n => NUM_FMT.format(n));
    renderDelta('kpi-entries-delta', entries, cleanNumber(previous['Total Entries']), n => NUM_FMT.format(n));
    renderDelta('kpi-revenue-delta', revenue, cleanNumber(previous['Net Revenue CHF']), n => CHF_FMT.format(n));
    renderDelta('kpi-cost-delta', cost, cleanNumber(previous['Bulk Cost CHF']), n => CHF_FMT.format(n));
  } else {
    ['kpi-users-delta', 'kpi-entries-delta', 'kpi-revenue-delta', 'kpi-cost-delta'].forEach(id => {
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

document.getElementById('evolution-chart').parentElement; // ensure canvas exists before chart init
populateContestSelect();
setupMetricToggle();
if (DASHBOARD_CONFIG.contests.length > 0) {
  document.getElementById('contest-select').value = DASHBOARD_CONFIG.contests[0].id;
  loadContest(DASHBOARD_CONFIG.contests[0].id);
} else {
  showStatus('Aucun concours configuré. Ajoute-en un dans config.js.');
}
