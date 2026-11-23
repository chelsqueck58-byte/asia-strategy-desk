const state = {
  prep: null,
  market: null,
  news: null,
  themeFilter: "All",
  countryFilter: null,
  search: "",
  ratingFilter: "All",
  drill: { cat: "All", reviewOnly: false, index: 0, order: [], revealed: false },
};

const STORAGE = { drill: "asd.drill", log: "asd.log", tab: "asd.tab" };
const TABS = ["today", "view", "numbers", "calendar", "drill", "notes"];

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

async function loadJson(path) {
  const response = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : "#";
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const decimals = Math.abs(value) >= 1000 ? 0 : digits;
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function direction(value) {
  if (value === null || value === undefined || Number.isNaN(value) || Math.abs(value) < 0.005) return "flat";
  return value > 0 ? "up" : "down";
}

function timeAgo(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function ratingFor(country) {
  const match = state.prep.countries.find((entry) => entry.name === country);
  return match ? match.rating : null;
}

function ratingBadge(rating) {
  if (!rating) return null;
  const base = rating.split(" ")[0].toLowerCase();
  return el("span", { class: `badge ${base}`, text: rating });
}

function sparkline(values) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((value, index) => `${((index / (values.length - 1)) * 100).toFixed(1)},${(24 - ((value - min) / span) * 22 - 1).toFixed(1)}`)
    .join(" ");
  const tone = values[values.length - 1] >= values[0] ? "var(--up)" : "var(--down)";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 24");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", tone);
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  return svg;
}

function showBanner(message) {
  const banner = $("#banner");
  banner.textContent = message;
  banner.hidden = !message;
}

function setUpdated() {
  const parts = [];
  if (state.market) parts.push(`Prices ${timeAgo(state.market.updated)}`);
  if (state.news) parts.push(`news ${timeAgo(state.news.updated)}`);
  $("#updated").textContent = parts.length ? parts.join(" · ") : "No live data loaded";
}

/* ---------- Today ---------- */

function allQuotes() {
  return state.market ? state.market.groups.flatMap((group) => group.items) : [];
}

function renderMovers() {
  const box = clear($("#movers"));
  const movers = allQuotes()
    .filter((quote) => !quote.error && quote.country && Math.abs(quote.change_pct) >= 1.5)
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 6);
  if (!movers.length) {
    box.append(el("p", { class: "muted", text: "No market in the house list moved more than 1.5% in the latest session." }));
    return;
  }
  for (const quote of movers) {
    box.append(
      el("div", { class: "card" },
        el("div", { class: "meta" }, el("strong", { text: quote.label }), ratingBadge(ratingFor(quote.country))),
        el("p", { class: direction(quote.change_pct), text: formatPct(quote.change_pct) }),
        el("p", { class: "muted tiny", text: "Say: what moved it, does it test the house view, what flips my mind?" })
      )
    );
  }
}

function daysUntil(isoDate) {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [year, month, day] = isoDate.split("-").map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - start) / 86400000);
}

function eventCard(event) {
  const days = daysUntil(event.date);
  const [, month, day] = event.date.split("-").map(Number);
  const monthName = new Date(2000, month - 1, 1).toLocaleString("en", { month: "short" });
  const label = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days}d` : `${-days}d ago`;
  return el("div", { class: `event${days < 0 ? " past" : ""}` },
    el("div", { class: "when" }, el("div", { class: "day", text: day }), el("div", { class: "mon", text: monthName }), el("div", { class: "in", text: label })),
    el("div", {}, el("div", { class: "what", text: event.label }), el("div", { class: "test", text: `Tests: ${event.test}` }))
  );
}

function renderNextEvents() {
  const box = clear($("#next-events"));
  const upcoming = state.prep.events.filter((event) => daysUntil(event.date) >= 0).slice(0, 3);
  if (!upcoming.length) box.append(el("p", { class: "muted", text: "No upcoming events in the calendar." }));
  for (const event of upcoming) box.append(eventCard(event));
}

function tileFor(quote) {
  const isYield = quote.kind === "yield";
  const change = isYield ? (quote.price - quote.prev) * 100 : quote.change_pct;
  const changeText = isYield ? `${change > 0 ? "+" : ""}${change.toFixed(1)}bp` : formatPct(change);
  return el("div", { class: "tile" },
    el("div", { class: "name" }, el("span", { text: quote.label }), ratingBadge(quote.country ? ratingFor(quote.country) : null)),
    el("div", { class: "px", text: isYield ? `${quote.price.toFixed(2)}%` : formatNumber(quote.price) }),
    el("div", { class: `chg ${direction(change)}`, text: changeText }),
    el("div", { class: "ytd", text: `YTD ${formatPct(quote.ytd_pct)}${quote.proxy ? " · ETF proxy" : ""}` }),
    sparkline(quote.spark)
  );
}

function renderMarket() {
  const box = clear($("#market"));
  if (!state.market) {
    box.append(el("p", { class: "muted", text: "Market data not available. Run scripts/fetch_data.py or wait for the next scheduled refresh." }));
    return;
  }
  for (const group of state.market.groups) {
    const tiles = el("div", { class: "tiles" });
    for (const quote of group.items) {
      tiles.append(quote.error ? el("div", { class: "tile" }, el("div", { class: "name", text: quote.label }), el("div", { class: "muted tiny", text: "unavailable" })) : tileFor(quote));
    }
    box.append(el("div", { class: "group-title", text: group.name }), tiles);
  }
}

function renderThemeChips() {
  const box = clear($("#theme-chips"));
  const themes = ["All", ...new Set((state.news ? state.news.items : []).map((item) => item.theme))];
  for (const theme of themes) {
    box.append(el("button", {
      class: "chip", type: "button", "aria-pressed": String(state.themeFilter === theme), text: theme,
      onclick: () => { state.themeFilter = theme; renderNews(); },
    }));
  }
}

function renderCountryChips() {
  const box = clear($("#country-chips"));
  const countries = [...new Set((state.news ? state.news.items : []).flatMap((item) => item.tags))].sort();
  if (!countries.length) return;
  box.append(el("button", {
    class: "chip", type: "button", "aria-pressed": String(state.countryFilter === null), text: "All markets",
    onclick: () => { state.countryFilter = null; renderNews(); },
  }));
  for (const country of countries) {
    const rating = ratingFor(country);
    box.append(el("button", {
      class: "chip", type: "button", "aria-pressed": String(state.countryFilter === country), text: rating ? `${country} · ${rating}` : country,
      onclick: () => { state.countryFilter = country; renderNews(); },
    }));
  }
}

function filteredNews() {
  const items = state.news ? state.news.items : [];
  const needle = state.search.trim().toLowerCase();
  return items.filter((item) => {
    if (state.themeFilter !== "All" && item.theme !== state.themeFilter) return false;
    if (state.countryFilter && !item.tags.includes(state.countryFilter)) return false;
    if (needle && !item.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function renderNews() {
  renderThemeChips();
  renderCountryChips();
  const list = clear($("#news"));
  if (!state.news) {
    list.append(el("li", { class: "muted", text: "News not available. Run scripts/fetch_data.py or wait for the next scheduled refresh." }));
    return;
  }
  const items = filteredNews().slice(0, 60);
  if (!items.length) list.append(el("li", { class: "muted", text: "No headlines match those filters." }));
  for (const item of items) {
    const tags = item.tags.map((country) => el("span", { class: "tag" }, country, ratingBadge(ratingFor(country))));
    list.append(el("li", {},
      el("a", { href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer", text: item.title }),
      el("div", { class: "meta" }, el("span", { text: item.source }), el("span", { text: timeAgo(item.published) }), el("span", { text: item.theme }), tags)
    ));
  }
}

/* ---------- House view ---------- */

function renderStaticView() {
  const { prep } = state;
  $("#pitch").textContent = prep.pitch;
  const rules = clear($("#rules"));
  for (const rule of prep.rules) rules.append(el("li", { text: rule }));
  $("#targets").textContent = prep.targets;
  const team = clear($("#team"));
  for (const person of prep.team) {
    team.append(el("div", { class: "card" }, el("strong", { text: person.name }), el("p", { class: "muted tiny", text: person.role }), el("p", { text: person.note })));
  }
}

function renderRatingChips() {
  const box = clear($("#rating-chips"));
  for (const rating of ["All", "OW", "EW", "UW"]) {
    box.append(el("button", {
      class: "chip", type: "button", "aria-pressed": String(state.ratingFilter === rating), text: rating,
      onclick: () => { state.ratingFilter = rating; renderCountries(); },
    }));
  }
}

function renderCountries() {
  renderRatingChips();
  const box = clear($("#countries"));
  const visible = state.prep.countries.filter((country) => state.ratingFilter === "All" || country.rating === state.ratingFilter);
  for (const country of visible) {
    box.append(el("div", { class: "card country" },
      el("h3", {}, ratingBadge(country.rating), country.name, country.tag ? el("span", { class: "muted tiny", text: country.tag }) : null),
      el("ul", {}, country.points.map((point) => el("li", { text: point }))),
      country.risks ? el("p", { class: "risk", text: `Risks: ${country.risks}` }) : null,
      country.names ? el("p", { class: "names" }, el("strong", { text: "Names: " }), country.names) : null
    ));
  }
}

function fillTable(table, headers, rows) {
  clear(table);
  table.append(el("thead", {}, el("tr", {}, headers.map((header) => el("th", { class: header.num ? "num" : "", text: header.label })))));
  const body = el("tbody");
  for (const row of rows) body.append(el("tr", {}, row));
  table.append(body);
}

function renderSectors() {
  fillTable($("#sectors"), [{ label: "Rating" }, { label: "Sector" }, { label: "Why (MS)" }, { label: "Within-sector preference" }],
    state.prep.sectors.map((sector) => [el("td", {}, ratingBadge(sector.rating)), el("td", {}, el("strong", { text: sector.name })), el("td", { text: sector.why }), el("td", { text: sector.pref || "—" })]));
  fillTable($("#toolkit"), [{ label: "Tool" }, { label: "What it is" }, { label: "Current reading" }],
    state.prep.toolkit.map((tool) => [el("td", {}, el("strong", { text: tool.tool })), el("td", { text: tool.what }), el("td", { text: tool.reading })]));
}

/* ---------- Numbers & earnings ---------- */

function quoteBySymbol(symbol) {
  return allQuotes().find((quote) => quote.symbol === symbol && !quote.error) || null;
}

function renderNumbers() {
  const rows = state.prep.numbers.map((row) => {
    const quote = row.symbol ? quoteBySymbol(row.symbol) : null;
    const live = quote ? quote.price : null;
    const sinceFri = quote && row.friNum ? (live / row.friNum - 1) * 100 : null;
    const upside = live && row.targetNum ? (row.targetNum / live - 1) * 100 : null;
    return [
      el("td", {}, el("strong", { text: row.name })),
      el("td", { class: "num", text: row.fri }),
      el("td", { class: "num", text: live ? formatNumber(live, 0) : "—" }),
      el("td", { class: `num ${direction(sinceFri)}`, text: formatPct(sinceFri) }),
      el("td", { class: "num", text: row.ytd }),
      el("td", { class: "num", text: row.target }),
      el("td", { class: `num ${direction(upside)}`, text: upside === null ? "—" : formatPct(upside) }),
      el("td", { text: row.context }),
    ];
  });
  fillTable($("#numbers"),
    [{ label: "Index" }, { label: "Fri 20 Nov", num: true }, { label: "Live", num: true }, { label: "vs Fri", num: true }, { label: "YTD (Fri)", num: true }, { label: "MS 2027 target", num: true }, { label: "Live upside", num: true }, { label: "So-what" }],
    rows);
  fillTable($("#rates"), [{ label: "Item" }, { label: "Level" }, { label: "Next / so-what" }],
    state.prep.rates.map((rate) => [el("td", {}, el("strong", { text: rate.name })), el("td", { text: rate.value }), el("td", { text: rate.next })]));
}

function renderEarnings() {
  $("#earn-takeaway").textContent = state.prep.earningsTakeaway;
  fillTable($("#earnings"), [{ label: "Company" }, { label: "Result" }, { label: "Capex / guide" }, { label: "Stock" }, { label: "Read-across" }],
    state.prep.earnings.map((row) => [
      el("td", {}, el("strong", { text: row.co }), el("div", { class: "muted tiny", text: row.date })),
      el("td", { text: row.result }), el("td", { text: row.guide }), el("td", { text: row.reaction }), el("td", { text: row.read }),
    ]));
}

/* ---------- Calendar ---------- */

function renderCalendar() {
  const box = clear($("#events"));
  for (const event of state.prep.events) box.append(eventCard(event));
  fillTable($("#timeline"), [{ label: "When" }, { label: "Event" }, { label: "Takeaway" }],
    state.prep.timeline.map((row) => [el("td", { text: row.when }), el("td", { text: row.what }), el("td", { text: row.so })]));
}

/* ---------- Drill ---------- */

function drillProgress() {
  return readStore(STORAGE.drill, {});
}

function drillPool() {
  const progress = drillProgress();
  return state.prep.qa
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => state.drill.cat === "All" || card.cat === state.drill.cat)
    .filter(({ index }) => !state.drill.reviewOnly || progress[index] !== "know");
}

function resetDrillOrder() {
  state.drill.order = drillPool().map(({ index }) => index);
  state.drill.index = 0;
  state.drill.revealed = false;
}

function renderDrillCats() {
  const box = clear($("#drill-cats"));
  const cats = ["All", ...new Set(state.prep.qa.map((card) => card.cat))];
  for (const cat of cats) {
    box.append(el("button", {
      class: "chip", type: "button", "aria-pressed": String(state.drill.cat === cat), text: cat,
      onclick: () => { state.drill.cat = cat; resetDrillOrder(); renderDrill(); },
    }));
  }
}

function renderDrill() {
  renderDrillCats();
  const progress = drillProgress();
  const known = Object.values(progress).filter((value) => value === "know").length;
  $("#drill-stats").textContent = `${known} of ${state.prep.qa.length} marked as known. Progress is saved in this browser only.`;
  const total = state.drill.order.length;
  const answer = $("#drill-a");
  if (!total) {
    $("#drill-meta").textContent = "Nothing in this pile";
    $("#drill-q").textContent = "No cards match. Clear the review filter or pick another category.";
    answer.hidden = true;
    $("#drill-grade").hidden = true;
    return;
  }
  const cardIndex = state.drill.order[state.drill.index];
  const card = state.prep.qa[cardIndex];
  $("#drill-meta").textContent = `${card.cat} · card ${state.drill.index + 1} of ${total}${progress[cardIndex] === "know" ? " · known" : progress[cardIndex] === "review" ? " · to review" : ""}`;
  $("#drill-q").textContent = card.q;
  answer.textContent = card.a;
  answer.hidden = !state.drill.revealed;
  $("#drill-grade").hidden = !state.drill.revealed;
  $("#drill-show").textContent = state.drill.revealed ? "Hide answer" : "Show answer";
}

function stepDrill(delta) {
  const total = state.drill.order.length;
  if (!total) return;
  state.drill.index = (state.drill.index + delta + total) % total;
  state.drill.revealed = false;
  renderDrill();
}

function gradeDrill(result) {
  const total = state.drill.order.length;
  if (!total) return;
  const progress = drillProgress();
  progress[state.drill.order[state.drill.index]] = result;
  writeStore(STORAGE.drill, progress);
  stepDrill(1);
}

function shuffleDrill() {
  const order = [...state.drill.order];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  state.drill.order = order;
  state.drill.index = 0;
  state.drill.revealed = false;
  renderDrill();
}

function bindDrill() {
  $("#drill-show").addEventListener("click", () => { state.drill.revealed = !state.drill.revealed; renderDrill(); });
  $("#drill-next").addEventListener("click", () => stepDrill(1));
  $("#drill-prev").addEventListener("click", () => stepDrill(-1));
  $("#drill-shuffle").addEventListener("click", shuffleDrill);
  $("#drill-know").addEventListener("click", () => gradeDrill("know"));
  $("#drill-review-btn").addEventListener("click", () => gradeDrill("review"));
  $("#drill-review").addEventListener("change", (event) => {
    state.drill.reviewOnly = event.target.checked;
    resetDrillOrder();
    renderDrill();
  });
  const ask = clear($("#ask"));
  for (const question of state.prep.askThem) ask.append(el("li", { text: question }));
  $("#close").textContent = `Close (20s): "${state.prep.close}"`;
}

/* ---------- Pitches & log ---------- */

function renderPitches() {
  const box = clear($("#pitches"));
  for (const pitch of state.prep.pitches) {
    const section = (label, text) => el("p", {}, el("span", { class: "lbl", text: label }), text);
    box.append(el("details", { class: "pitch" },
      el("summary", { text: pitch.name }),
      section("Setup", pitch.setup), section("Thesis", pitch.thesis), section("Risks", pitch.risks), section("House-view check", pitch.check)
    ));
  }
}

const LOG_FIELDS = ["view", "e1", "e2", "risk"];

function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function loadLogDay() {
  const date = $("#log-date").value;
  const entry = readStore(STORAGE.log, {})[date] || {};
  for (const field of LOG_FIELDS) $(`#log-${field}`).value = entry[field] || "";
  $("#log-status").textContent = entry.view || entry.e1 || entry.e2 || entry.risk ? "Entry loaded." : "No entry for this date yet.";
}

function saveLogDay() {
  const date = $("#log-date").value;
  if (!date) return;
  const log = readStore(STORAGE.log, {});
  log[date] = Object.fromEntries(LOG_FIELDS.map((field) => [field, $(`#log-${field}`).value]));
  const saved = writeStore(STORAGE.log, log);
  $("#log-status").textContent = saved ? `Saved ${new Date().toLocaleTimeString()}` : "Could not save: browser storage is unavailable.";
}

function bindLog() {
  $("#log-date").value = todayIso();
  $("#log-date").addEventListener("change", loadLogDay);
  for (const field of LOG_FIELDS) $(`#log-${field}`).addEventListener("input", saveLogDay);
  loadLogDay();
}

/* ---------- Tabs and boot ---------- */

function selectTab(name) {
  const tab = TABS.includes(name) ? name : "today";
  for (const button of document.querySelectorAll("#tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.id !== `tab-${tab}`;
  writeStore(STORAGE.tab, tab);
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}

function bindTabs() {
  for (const button of document.querySelectorAll("#tabs button")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  }
  window.addEventListener("hashchange", () => selectTab(location.hash.slice(1)));
  selectTab(location.hash.slice(1) || readStore(STORAGE.tab, "today"));
}

function renderLive() {
  setUpdated();
  renderMovers();
  renderNextEvents();
  renderMarket();
  renderNews();
  renderNumbers();
}

async function loadLive() {
  const [market, news] = await Promise.allSettled([loadJson("data/market.json"), loadJson("data/news.json")]);
  state.market = market.status === "fulfilled" ? market.value : null;
  state.news = news.status === "fulfilled" ? news.value : null;
  const missing = [state.market ? null : "prices", state.news ? null : "news"].filter(Boolean);
  showBanner(missing.length ? `Live ${missing.join(" and ")} could not be loaded. Prep content still works.` : "");
  renderLive();
}

async function boot() {
  bindTabs();
  try {
    state.prep = await loadJson("data/prep.json");
  } catch (error) {
    showBanner(`Could not load prep content (${error.message}). Serve this folder over http, e.g. python3 -m http.server.`);
    return;
  }
  renderStaticView();
  renderCountries();
  renderSectors();
  renderEarnings();
  renderCalendar();
  renderPitches();
  bindDrill();
  resetDrillOrder();
  renderDrill();
  bindLog();
  $("#news-search").addEventListener("input", (event) => { state.search = event.target.value; renderNews(); });
  $("#refresh").addEventListener("click", loadLive);
  await loadLive();
}

boot();
