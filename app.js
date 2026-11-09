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
let hourlyChart = null;
let currentRows = [];
let currentMetric = null;
let lastRenderedKey = null;
let discoveredContests = [];
let overallContest = null;
let currentView = 'game'; // 'game' | 'overall'
let lastGameId = null;
let loadSeq = 0;
let accessToken = null;
let tokenClient = null;
let hasStartedDashboard = false;
let staleReloadTimer = null;
let currentGoal = null;

// Colonne (AZ) contenant l'objectif de revenu net du concours, en CHF.
const GOAL_COL = 'Objectif CHF';
// Fenêtre utilisée pour estimer le rythme actuel de revenu.
const PACE_WINDOW_HOURS = 24;

const AUTO_REFRESH_START = { hour: 9, minute: 10 };
const AUTO_REFRESH_END = { hour: 20, minute: 10 };
const AUTO_REFRESH_STEP_MINUTES = 60;

let lastRefreshAt = Date.now();

const fmtNum = n => NUM_FMT.format(n);
const fmtChf = n => CHF_FMT.format(n);

// Boutons du graphique d'évolution, par vue, dans l'ordre d'affichage.
// Le bouton "Stops" n'apparaît que si la dernière valeur est > 0.
// `get` (optionnel) calcule la valeur d'une ligne ; sinon on lit la colonne `col`.
const NET_REVENUE_KEY = 'revenu-net-calcule';
// `goalMetric` : métrique sur laquelle la ligne d'objectif est tracée.
const GAME_METRICS = {
  default: NET_REVENUE_KEY,
  goalMetric: NET_REVENUE_KEY,
  list: [
    { col: 'Charged Entries', label: 'Participations', fmt: fmtNum },
    { col: 'Charged Unique Users', label: 'Participants', fmt: fmtNum },
    { col: NET_REVENUE_KEY, label: 'Revenu net', fmt: fmtChf, get: netRevenueValue },
    { col: 'Outpayment CHF', label: 'Revenu brut', fmt: fmtChf },
    { col: 'Stops Cumulés', label: 'Stops', fmt: fmtNum, onlyIfPositive: true }
  ]
};
const OVERALL_METRICS = {
  default: 'Net Revenue CHF',
  goalMetric: 'Net Revenue CHF',
  list: [
    { col: 'Charged Entries', label: 'Participations', fmt: fmtNum },
    { col: 'Outpayment CHF', label: 'Revenu brut', fmt: fmtChf },
    { col: 'Net Revenue CHF', label: 'Revenu net', fmt: fmtChf }
  ]
};

const STALE_AFTER_MS = 48 * 3600 * 1000;

const WEEKDAY_COLUMNS = ['Entrées Lundi', 'Entrées Mardi', 'Entrées Mercredi', 'Entrées Jeudi', 'Entrées Vendredi', 'Entrées Samedi', 'Entrées Dimanche'];
const WEEKDAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + 'h');
const HOUR_COLUMNS = HOUR_LABELS.map(h => `entries_${h}`);

// Convertit une cellule en nombre, ou null si la cellule est vide, absente
// ou ne contient pas de vraie valeur numérique. Gère "1'234.5", "1,234.5",
// "8 665,42" (virgule décimale) et un éventuel suffixe "CHF".
function parseNumber(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw).replace(/CHF/gi, '').replace(/['’\s  ]/g, '');
  if (s === '') return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');
  } else if (/,\d{1,2}$/.test(s)) {
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function num(row, col) {
  return row ? parseNumber(row[col]) : null;
}

function firstNum(row, cols) {
  for (const col of cols) {
    const v = num(row, col);
    if (v !== null) return v;
  }
  return null;
}

function setPanelVisible(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

function isVisible(id) {
  const el = document.getElementById(id);
  return !!el && el.style.display !== 'none';
}

// ---- Authentification Google ----

function showSigninError(message) {
  const el = document.getElementById('signin-error');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

function handleTokenResponse(response) {
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
    scheduleDailyReload();
  } else {
    const select = document.getElementById('contest-select');
    if (select.value) loadContest(select.value);
  }
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DASHBOARD_CONFIG.googleClientId,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    callback: handleTokenResponse
  });

  document.getElementById('signin-button').addEventListener('click', () => {
    showSigninError('');
    tokenClient.requestAccessToken();
  });

  // Tentative de connexion silencieuse au chargement de la page : si une
  // session Google valide existe déjà (écran laissé allumé, page rechargée),
  // le dashboard démarre sans qu'il faille recliquer "Se connecter avec
  // Google". Si ça échoue, on laisse simplement l'écran de connexion tel quel.
  tokenClient.requestAccessToken({
    prompt: '',
    callback: (response) => {
      if (response.error) return;
      handleTokenResponse(response);
    }
  });
}

// Filet de sécurité pour un écran laissé sans surveillance sur la durée :
// un rechargement complet chaque nuit repart sur une base saine (et retente
// une connexion silencieuse toute seule, cf. ci-dessus) plutôt que de
// compter indéfiniment sur l'état JS d'un onglet resté ouvert.
function scheduleDailyReload() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  setTimeout(() => location.reload(), next.getTime() - now.getTime());
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

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
}

function setupFullscreenToggle() {
  const btn = document.getElementById('fullscreen-button');
  btn.addEventListener('click', toggleFullscreen);

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'f' || e.ctrlKey || e.altKey || e.metaKey) return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    toggleFullscreen();
  });

  document.addEventListener('fullscreenchange', () => {
    const isFullscreen = !!document.fullscreenElement;
    document.body.classList.toggle('is-fullscreen', isFullscreen);
    const label = isFullscreen ? 'Quitter le plein écran (F)' : 'Plein écran (F)';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    // Le conteneur change de taille en dehors d'un resize de fenêtre classique :
    // on force les charts à se redimensionner plutôt que de compter sur leur
    // ResizeObserver, qui peut rater la transition plein écran. L'animation
    // d'entrée/sortie du plein écran n'est pas terminée au moment où cet
    // événement se déclenche, donc on redimensionne aussi une fois qu'elle
    // a eu le temps de se terminer.
    const resizeCharts = () => [evolutionChart, loyaltyChart, weekdayChart, hourlyChart].forEach(chart => chart && chart.resize());
    resizeCharts();
    setTimeout(resizeCharts, 300);
  });
}

// ---- Récupération des données via l'API Google Sheets ----

function sheetApiUrl(sheetId, sheetTab) {
  const range = encodeURIComponent(`${sheetTab}!A:AZ`);
  return `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
}

function sheetMetadataUrl(sheetId) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
}

function parseContestFromTabName(title, sheetKey, sheetId) {
  const id = title.toLowerCase().replace(/ /g, '-');

  // Le Sheet "Media One" (concours suivis uniquement au niveau groupe) ne
  // suit pas la convention "Station - Concours" : chaque onglet est déjà
  // rattaché à Media One tel quel, sans découpage sur " - ".
  if (sheetKey === 'Media One') {
    return { id, label: title, sheetTab: title, station: 'Media One', sheetId };
  }

  const separatorIndex = title.indexOf(' - ');
  const station = separatorIndex === -1 ? 'One FM' : title.slice(0, separatorIndex);
  const label = separatorIndex === -1 ? title : title.slice(separatorIndex + 3);
  return { id, label, sheetTab: title, station, sheetId };
}

function discoverContests() {
  if (!accessToken) return;
  showStatus('Chargement des concours…');

  const sheetEntries = Object.entries(DASHBOARD_CONFIG.sheetIds);

  Promise.all(sheetEntries.map(([sheetKey, sheetId]) =>
    fetch(sheetMetadataUrl(sheetId), {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => {
        const titles = (json.sheets || []).map(s => s.properties.title);
        return titles.map(title => parseContestFromTabName(title, sheetKey, sheetId)).reverse();
      })
  ))
    .then(perSheetContests => {
      // La feuille "Overall" du Sheet Media One contient les cumuls de tous
      // les jeux : elle alimente la vue "Bilan global" et ne figure pas dans
      // la liste des concours. Les onglets sont déjà triés du plus récent au
      // plus ancien (dernier onglet du Sheet = concours le plus récent).
      const all = perSheetContests.flat();
      overallContest = all.find(isOverallContest) || null;
      discoveredContests = all.filter(c => !isOverallContest(c));
      document.getElementById('overall-button').style.display = overallContest ? '' : 'none';

      if (discoveredContests.length === 0 && !overallContest) {
        showStatus("Aucun onglet trouvé dans le Google Sheet.");
        return;
      }

      const select = document.getElementById('contest-select');
      select.innerHTML = '';
      discoveredContests.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => showGameView(select.value));

      if (discoveredContests.length === 0) {
        showOverallView();
        return;
      }
      showGameView(discoveredContests[0].id);
    })
    .catch(err => {
      showStatus("Impossible de charger la liste des concours (" + err.message + ").");
    });
}

function showStatus(message) {
  const el = document.getElementById('status-message');
  const main = document.getElementById('dashboard-content');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
  main.style.display = message ? 'none' : 'block';
}

function isOverallContest(c) {
  return c.station === 'Media One' && c.sheetTab.trim().toLowerCase() === 'overall';
}

function applyViewChrome() {
  const isOverall = currentView === 'overall';
  document.getElementById('contest-select').style.display = isOverall ? 'none' : '';
  document.getElementById('overall-button').style.display = !isOverall && overallContest ? '' : 'none';
}

function showGameView(contestId) {
  if (!contestId) return;
  currentView = 'game';
  lastGameId = contestId;
  document.getElementById('contest-select').value = contestId;
  applyViewChrome();
  loadContest(contestId);
}

function showOverallView() {
  if (!overallContest) return;
  currentView = 'overall';
  applyViewChrome();
  loadContest(overallContest.id);
}

// Point d'entrée unique du chargement (aussi appelé par le rafraîchissement
// et le renouvellement du token) : en vue "Bilan global", on recharge
// toujours la feuille Overall, quel que soit l'identifiant reçu.
function loadContest(contestId) {
  const contest = currentView === 'overall'
    ? overallContest
    : discoveredContests.find(c => c.id === contestId);
  if (!contest || !accessToken) return;

  const seq = ++loadSeq;
  document.getElementById('station-name').textContent = contest.station || '';
  showStatus('Chargement des données…');

  fetch(sheetApiUrl(contest.sheetId, contest.sheetTab), {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  })
    .then(res => {
      if (res.status === 401) {
        // Token expiré : on le renouvelle en silence, ce qui redéclenchera loadContest().
        // Si ça ne débloque rien après quelques secondes (écran resté seul,
        // renouvellement silencieux qui échoue sans même remonter d'erreur),
        // on recharge la page plutôt que de rester coincé sur "Chargement…" :
        // au démarrage, initAuth() retente elle-même une connexion silencieuse.
        tokenClient.requestAccessToken({ prompt: '' });
        clearTimeout(staleReloadTimer);
        staleReloadTimer = setTimeout(() => location.reload(), 20000);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(json => {
      if (!json || seq !== loadSeq) return; // réponse d'un chargement remplacé entre-temps
      const values = json.values || [];
      if (values.length === 0) {
        showStatus(`Aucune donnée trouvée dans l'onglet "${contest.sheetTab}". Vérifie que le nom de l'onglet dans config.js correspond exactement.`);
        return;
      }
      const header = values[0];
      const allRows = values.slice(1).map(row => {
        const obj = {};
        header.forEach((key, i) => { obj[key] = row[i]; });
        return obj;
      });
      const rows = allRows.filter(r => r.Timestamp);
      // L'objectif peut être saisi sur une ligne sans Timestamp (ex. avant
      // le premier envoi de Make.com) : on le cherche donc sur toutes les lignes.
      currentGoal = readGoal(allRows);

      // Concours pas encore démarré (onglet créé, mais aucune ligne de
      // données envoyée par Make.com) : renderDashboard() affiche alors
      // simplement le titre et un court message, sans panneau vide.
      clearTimeout(staleReloadTimer);
      currentRows = rows;
      showStatus('');
      renderDashboard(contest, currentRows);
    })
    .catch(err => {
      if (seq !== loadSeq) return;
      clearTimeout(staleReloadTimer);
      if (err.message && err.message.includes('403')) {
        showStatus("Ton compte Google n'a pas accès à ce Sheet. Vérifie que tu es connecté avec le bon compte et que tu as au moins un accès lecteur sur le document.");
      } else {
        showStatus("Impossible de charger les données (" + err.message + ").");
      }
    });
}

// ---- Rendu ----
// Règle générale : une valeur absente, vide ou non numérique n'est jamais
// affichée (ni "0", ni "—"), et un KPI, un bouton ou un panneau sans
// données est masqué.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function currentMetricsConfig() {
  return currentView === 'overall' ? OVERALL_METRICS : GAME_METRICS;
}

function renderDashboard(contest, rows) {
  const isOverall = currentView === 'overall';
  const latest = rows.length ? rows[rows.length - 1] : null;
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;

  // Nouveau concours ou nouvelle vue : le graphique repart sur sa métrique
  // par défaut. Un simple rafraîchissement conserve le choix en cours.
  const key = `${currentView}:${contest.id}`;
  if (key !== lastRenderedKey) {
    currentMetric = null;
    lastRenderedKey = key;
  }

  renderViewHead(contest, latest);
  renderLastUpdate(latest ? latest.Timestamp : null);

  const empty = document.getElementById('empty-state');
  empty.textContent = isOverall
    ? 'Pas encore de données dans la feuille Overall.'
    : 'Pas encore de données pour ce concours.';
  empty.style.display = latest ? 'none' : '';

  renderKpis(isOverall ? overallKpiDefs() : gameKpiDefs(latest), latest, isOverall ? null : previous);
  renderGoal(rows);
  renderEvolution(rows);

  // Les conteneurs doivent être visibles pendant la création des graphiques,
  // sinon Chart.js les dessine à une taille nulle. Ils sont re-masqués plus
  // bas s'ils ne contiennent finalement aucun panneau.
  setPanelVisible('secondary-grid', true);
  setPanelVisible('two-col-grid', true);

  if (isOverall) {
    renderNetworkSplit(latest);
    renderSmsPanel(latest);
    renderSingleStat('panel-errors', 'stat-errors', num(latest, 'Error Count'), fmtNum);
    renderSingleStat('panel-stops', 'stat-stops', num(latest, 'Stops Cumulés'), fmtNum);
    ['panel-loyalty', 'panel-weekday', 'panel-hourly'].forEach(id => setPanelVisible(id, false));
  } else {
    ['panel-network', 'panel-sms', 'panel-errors', 'panel-stops'].forEach(id => setPanelVisible(id, false));
    renderLoyalty(latest);
    renderWeekdayVolume(latest);
    renderHourlyVolume(latest);
  }

  setPanelVisible('secondary-grid', ['panel-network', 'panel-sms', 'panel-errors', 'panel-stops'].some(isVisible));
  setPanelVisible('two-col-grid', ['panel-loyalty', 'panel-weekday'].some(isVisible));
}

function formatDateTime(date, withYear) {
  const opts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
  if (withYear) opts.year = 'numeric';
  return date.toLocaleString('fr-CH', opts);
}

function parseTimestamp(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? null : date;
}

function renderViewHead(contest, latest) {
  const isOverall = currentView === 'overall';
  document.getElementById('view-title').textContent = isOverall ? 'Bilan global' : contest.label;
  document.getElementById('back-button').style.display = isOverall && lastGameId ? '' : 'none';

  const badge = document.getElementById('view-badge');
  const cap = isOverall ? null : num(latest, 'Entry Cap');
  if (cap !== null && cap > 0) {
    badge.textContent = `Plafond atteint : ${fmtNum(cap)}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  const context = document.getElementById('view-context');
  if (isOverall) {
    const date = parseTimestamp(latest && latest.Timestamp);
    context.textContent = 'Cumul de tous les jeux depuis le début.'
      + (date ? ` Dernière mise à jour : ${formatDateTime(date, true)}` : '');
    context.classList.toggle('stale', !date || Date.now() - date.getTime() > STALE_AFTER_MS);
    context.style.display = '';
  } else {
    context.style.display = 'none';
  }
}

function renderLastUpdate(timestamp) {
  const el = document.getElementById('last-update');
  const date = parseTimestamp(timestamp);
  if (!date) { el.textContent = ''; return; }
  const minsAgo = Math.round((Date.now() - date.getTime()) / 60000);
  const timeStr = formatDateTime(date, false);
  el.textContent = minsAgo >= 0 && minsAgo < 180
    ? `Mise à jour il y a ${minsAgo} min (${timeStr})`
    : `Dernière donnée : ${timeStr}`;
}

// ---- Revenu net (vue Jeu) ----

// Revenu net d'une ligne, par ordre de priorité :
//  a. "Net Revenue CHF" renseigné et > 0 → valeur réelle ;
//  b. sinon "Revenu Net Estimé CHF" renseigné et non nul → estimation du Sheet ;
//  c. sinon Outpayment CHF − Charged Entries × bulkCostPerEntryChf → estimation calculée ;
//  d. sinon null.
function netRevenue(row) {
  const real = num(row, 'Net Revenue CHF');
  if (real !== null && real > 0) return { value: real, estimate: false };

  const sheetEstimate = num(row, 'Revenu Net Estimé CHF');
  if (sheetEstimate !== null && sheetEstimate !== 0) return { value: sheetEstimate, estimate: true };

  const gross = num(row, 'Outpayment CHF');
  const entries = num(row, 'Charged Entries');
  const costPerEntry = DASHBOARD_CONFIG.bulkCostPerEntryChf;
  if (gross !== null && entries !== null && typeof costPerEntry === 'number' && isFinite(costPerEntry)) {
    return { value: Math.round((gross - entries * costPerEntry) * 100) / 100, estimate: true };
  }
  return null;
}

function netRevenueValue(row) {
  const net = netRevenue(row);
  return net ? net.value : null;
}

// Valeur d'une métrique ou d'un KPI pour une ligne : calculée si `get`, sinon lue dans `col`.
function metricValue(def, row) {
  if (!row) return null;
  return def.get ? def.get(row) : num(row, def.col);
}

// ---- KPI ----

function gameKpiDefs(latest) {
  const defs = [
    { label: 'Participants uniques', col: 'Charged Unique Users', fmt: fmtNum },
    { label: 'Participations facturées', col: 'Charged Entries', fmt: fmtNum }
  ];

  // 3e KPI : revenu net (réel ou estimé), avec le brut en rappel ; à défaut, le brut seul.
  const net = netRevenue(latest);
  const gross = num(latest, 'Outpayment CHF');
  if (net) {
    defs.push({
      label: net.estimate ? 'Revenu net estimé' : 'Revenu net',
      note: net.estimate ? 'estimation' : null,
      get: netRevenueValue,
      fmt: fmtChf,
      sub: gross !== null ? `brut : ${fmtChf(gross)}` : null
    });
  } else {
    defs.push({ label: 'Revenu brut', col: 'Outpayment CHF', fmt: fmtChf });
  }

  const bonus = num(latest, 'Bonus Entries');
  if (bonus !== null && bonus > 0) {
    defs.push({ label: 'Entrées totales', col: 'Total Entries', fmt: fmtNum });
  }
  return defs;
}

function overallKpiDefs() {
  return [
    { label: 'Participants uniques', col: 'Charged Unique Users', fmt: fmtNum },
    { label: 'Participations facturées', col: 'Charged Entries', fmt: fmtNum },
    { label: 'Revenu brut', col: 'Outpayment CHF', fmt: fmtChf },
    { label: 'Revenu net réel', col: 'Net Revenue CHF', fmt: fmtChf }
  ];
}

function formatDelta(latestVal, prevVal, fmt) {
  const diff = latestVal - prevVal;
  const formattedAbs = fmt(Math.abs(diff));
  if (!/[1-9]/.test(formattedAbs)) return { text: 'stable / h', positive: false };
  return { text: `${diff > 0 ? '▲ +' : '▼ '}${formattedAbs} / h`, positive: diff > 0 };
}

// previous = null : pas de variation "/ h" (vue Bilan global, ou une seule ligne).
function renderKpis(defs, latest, previous) {
  const row = document.getElementById('kpi-row');
  const items = defs
    .map(d => Object.assign({}, d, { value: metricValue(d, latest) }))
    .filter(d => d.value !== null);

  row.innerHTML = '';
  row.style.display = items.length ? '' : 'none';
  row.style.setProperty('--kpi-cols', String(items.length || 1));

  items.forEach(d => {
    const kpi = el('div', 'kpi');
    kpi.append(el('div', 'label', d.label));
    if (d.note) kpi.append(el('div', 'note', d.note));
    kpi.append(el('div', 'value display', d.fmt(d.value)));
    if (d.sub) kpi.append(el('div', 'sub', d.sub));
    // Variation affichée seulement si les deux dernières lignes ont une vraie valeur.
    const prev = metricValue(d, previous);
    if (prev !== null) {
      const delta = formatDelta(d.value, prev, d.fmt);
      kpi.append(el('div', 'delta' + (delta.positive ? ' positive' : ''), delta.text));
    }
    row.append(kpi);
  });
}

// ---- Objectif de revenu net ----

// Dernière valeur numérique > 0 de la colonne objectif, ou null.
function readGoal(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = num(rows[i], GOAL_COL);
    if (v !== null && v > 0) return v;
  }
  return null;
}

// Revenu net d'une ligne, selon la vue (calculé en vue Jeu, lu en Bilan global).
function goalRevenue(row) {
  if (currentView === 'overall') {
    const v = num(row, 'Net Revenue CHF');
    return v === null ? null : { value: v, estimate: false };
  }
  return netRevenue(row);
}

// Rythme de revenu net (CHF / heure) sur les dernières PACE_WINDOW_HOURS,
// ou null si l'historique est trop court pour être parlant.
function revenuePace(rows) {
  const points = rows
    .map(r => ({ date: parseTimestamp(r.Timestamp), net: goalRevenue(r) }))
    .filter(p => p.date && p.net);
  if (points.length < 2) return null;

  const last = points[points.length - 1];
  const windowStart = last.date.getTime() - PACE_WINDOW_HOURS * 3600 * 1000;
  // Point de référence : le dernier relevé avant le début de la fenêtre,
  // ou à défaut le tout premier relevé.
  let ref = points[0];
  for (const p of points) {
    if (p.date.getTime() <= windowStart) ref = p; else break;
  }
  const hours = (last.date.getTime() - ref.date.getTime()) / 3600000;
  if (hours < 3) return null;
  return (last.net.value - ref.net.value) / hours;
}

function formatDuration(hours) {
  if (hours < 1) return "moins d'une heure";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} jours`;
}

function renderGoal(rows) {
  const latest = rows.length ? rows[rows.length - 1] : null;
  const net = goalRevenue(latest);
  const goal = currentGoal;
  setPanelVisible('panel-goal', goal !== null && net !== null);
  if (goal === null || net === null) return;

  const ratio = net.value / goal;
  const pct = Math.max(0, ratio * 100);
  const reached = ratio >= 1;
  const remaining = goal - net.value;

  document.getElementById('goal-pct').textContent = `${pct.toFixed(pct < 10 ? 1 : 0)} %`;
  document.getElementById('goal-pct').classList.toggle('reached', reached);

  const fill = document.getElementById('goal-fill');
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.classList.toggle('reached', reached);
  document.getElementById('goal-track').setAttribute('aria-valuenow', String(Math.round(pct)));

  document.getElementById('goal-current').textContent = fmtChf(net.value);
  document.getElementById('goal-target').textContent = fmtChf(goal);
  document.getElementById('goal-estimate').style.display = net.estimate ? '' : 'none';

  const rem = document.getElementById('goal-remaining');
  rem.classList.toggle('reached', reached);
  rem.textContent = reached
    ? `Objectif atteint${remaining < 0 ? ` (+${fmtChf(-remaining)})` : ''}`
    : `Reste ${fmtChf(remaining)}`;

  // Projection au rythme récent, seulement tant que l'objectif n'est pas atteint.
  const paceEl = document.getElementById('goal-pace');
  const pace = reached ? null : revenuePace(rows);
  if (pace === null) {
    paceEl.style.display = 'none';
  } else if (pace <= 0) {
    paceEl.textContent = `Aucune progression du revenu net sur les dernières ${PACE_WINDOW_HOURS} h.`;
    paceEl.style.display = '';
  } else {
    paceEl.textContent = `Au rythme des dernières ${PACE_WINDOW_HOURS} h (${fmtChf(pace * 24)} / jour), `
      + `objectif atteint dans ≈ ${formatDuration(remaining / pace)}.`;
    paceEl.style.display = '';
  }
}

// ---- Graphique d'évolution ----

function availableMetrics(rows) {
  const latest = rows[rows.length - 1];
  return currentMetricsConfig().list.filter(m => {
    if (m.onlyIfPositive) {
      const v = metricValue(m, latest);
      return v !== null && v > 0;
    }
    return rows.some(r => metricValue(m, r) !== null);
  });
}

function renderEvolution(rows) {
  const metrics = rows.length ? availableMetrics(rows) : [];
  setPanelVisible('panel-evolution', metrics.length > 0);
  if (metrics.length === 0) {
    if (evolutionChart) { evolutionChart.destroy(); evolutionChart = null; }
    return;
  }

  const cfg = currentMetricsConfig();
  if (!metrics.some(m => m.col === currentMetric)) {
    currentMetric = metrics.some(m => m.col === cfg.default) ? cfg.default : metrics[0].col;
  }
  const metric = metrics.find(m => m.col === currentMetric);

  const toggle = document.getElementById('metric-toggle');
  toggle.innerHTML = '';
  metrics.forEach(m => {
    const btn = el('button', m.col === currentMetric ? 'active' : '', m.label);
    btn.type = 'button';
    btn.dataset.metric = m.col;
    toggle.append(btn);
  });

  const labels = rows.map(r => {
    const d = parseTimestamp(r.Timestamp);
    return d ? formatDateTime(d, false) : '';
  });
  const data = rows.map(r => metricValue(metric, r));

  const lastValue = [...data].reverse().find(v => v !== null);
  document.getElementById('evolution-current-value').textContent =
    lastValue === undefined ? '' : metric.fmt(lastValue);

  const ctx = document.getElementById('evolution-chart').getContext('2d');
  if (evolutionChart) evolutionChart.destroy();

  const datasets = [{
    label: metric.label,
    data,
    borderColor: COLORS.accent,
    backgroundColor: 'rgba(242, 169, 60, 0.12)',
    fill: true,
    tension: 0.25,
    spanGaps: true,
    pointRadius: 0,
    pointHoverRadius: 4,
    borderWidth: 2
  }];

  // Ligne d'objectif horizontale, sur la courbe de revenu net uniquement.
  // L'axe Y est étendu jusqu'à l'objectif pour que l'écart reste visible.
  const showGoal = currentGoal !== null && metric.col === cfg.goalMetric;
  if (showGoal) {
    datasets.push({
      label: 'Objectif',
      data: rows.map(() => currentGoal),
      borderColor: COLORS.positive,
      borderDash: [6, 5],
      borderWidth: 1.5,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 0
    });
  }

  evolutionChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: item => `${item.dataset.label} : ${metric.fmt(item.parsed.y)}` }
        }
      },
      scales: {
        x: {
          ticks: { color: '#868c99', maxTicksLimit: 8, font: { family: 'Inter', size: 11 } },
          grid: { color: '#2a2f3a' }
        },
        y: {
          suggestedMax: showGoal ? currentGoal * 1.05 : undefined,
          ticks: { color: '#868c99', font: { family: 'Inter', size: 11 }, callback: v => fmtNum(v) },
          grid: { color: '#2a2f3a' }
        }
      }
    }
  });
}

function setupMetricToggle() {
  document.getElementById('metric-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-metric]');
    if (!btn || btn.dataset.metric === currentMetric) return;
    currentMetric = btn.dataset.metric;
    if (currentRows.length) renderEvolution(currentRows);
  });
}

// ---- Panneaux du Bilan global ----

function renderNetworkSplit(latest) {
  const operators = [
    { label: 'Swisscom', value: num(latest, 'Swisscom'), color: COLORS.accent },
    { label: 'Sunrise', value: num(latest, 'Sunrise'), color: COLORS.accent2 },
    { label: 'Salt', value: num(latest, 'Salt'), color: COLORS.accent3 }
  ].filter(o => o.value !== null);
  const total = operators.reduce((sum, o) => sum + o.value, 0);
  setPanelVisible('panel-network', total > 0);
  if (total <= 0) return;

  const container = document.getElementById('network-split');
  container.innerHTML = '';
  operators.forEach(o => {
    const pct = (o.value / total) * 100;
    const row = el('div', 'bar-row');
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${pct}%`;
    fill.style.background = o.color;
    track.append(fill);
    row.append(el('span', '', o.label), track, el('span', 'bar-value', `${pct.toFixed(0)}%`));
    container.append(row);
  });
}

function renderSmsPanel(latest) {
  const delivered = num(latest, 'Delivered Bulk');
  const cost = firstNum(latest, ['Total Bulk Cost CHF', 'Bulk Cost CHF']);
  setPanelVisible('stat-delivered-row', delivered !== null);
  setPanelVisible('stat-bulkcost-row', cost !== null);
  setPanelVisible('panel-sms', delivered !== null || cost !== null);
  if (delivered !== null) document.getElementById('stat-delivered').textContent = fmtNum(delivered);
  if (cost !== null) document.getElementById('stat-bulkcost').textContent = fmtChf(cost);
}

function renderSingleStat(panelId, valueId, value, fmt) {
  setPanelVisible(panelId, value !== null);
  if (value !== null) document.getElementById(valueId).textContent = fmt(value);
}

// ---- Panneaux de la vue Jeu ----

function renderLoyalty(latest) {
  const segments = [
    { label: '1 participation', value: num(latest, 'Participants 1x'), color: COLORS.accent },
    { label: '2+ participations', value: num(latest, 'Participants 2x+'), color: COLORS.accent2 }
  ].filter(s => s.value !== null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  setPanelVisible('panel-loyalty', total > 0);
  if (total <= 0) return;

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
  legend.innerHTML = '';
  segments.forEach(s => {
    const row = el('div', 'legend-row');
    const dot = el('span', 'legend-dot');
    dot.style.background = s.color;
    const pct = (s.value / total) * 100;
    row.append(dot, el('span', '', s.label), el('span', 'legend-value', `${fmtNum(s.value)} (${pct.toFixed(0)}%)`));
    legend.append(row);
  });
}

function renderBarChart(canvasId, existingChart, labels, data) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (existingChart) existingChart.destroy();

  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: COLORS.accent,
        borderRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: item => `${fmtNum(item.parsed.y)} entrées` } }
      },
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

// Panneau affiché seulement si au moins une colonne a une valeur > 0.
function renderVolumePanel(panelId, canvasId, existingChart, columns, labels, latest) {
  const data = columns.map(col => num(latest, col));
  const visible = data.some(v => v !== null && v > 0);
  setPanelVisible(panelId, visible);
  if (!visible) return existingChart;
  return renderBarChart(canvasId, existingChart, labels, data);
}

function renderWeekdayVolume(latest) {
  weekdayChart = renderVolumePanel('panel-weekday', 'weekday-chart', weekdayChart, WEEKDAY_COLUMNS, WEEKDAY_LABELS, latest);
}

function renderHourlyVolume(latest) {
  hourlyChart = renderVolumePanel('panel-hourly', 'hourly-chart', hourlyChart, HOUR_COLUMNS, HOUR_LABELS, latest);
}

function setupViewSwitch() {
  document.getElementById('overall-button').addEventListener('click', showOverallView);
  document.getElementById('back-button').addEventListener('click', () => showGameView(lastGameId));
}

function startDashboard() {
  setupMetricToggle();
  setupViewSwitch();
  setupManualRefresh();
  setupFullscreenToggle();
  discoverContests();
}

initAuth();
