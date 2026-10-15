// Kassenbuch — app shell: lock screen, pages, dialogs. All data lives encrypted in vault.js.

import * as vault from "./vault.js";
import { fmt, fmt0, MONTHS, MONTHS_LONG, RATES, todayIso, dmy, esc, parseBetrag, vatOf, nettoOf, uid, plural, debounce, daysBetween } from "./util.js";
import { KAT, konto, bereichOf, defaultKat } from "./categories.js";
import { train, learnedCount, merchantKey } from "./learn.js";
import { processFile, markDupes } from "./process.js";
import { bookDue, INTERVAL_LABEL } from "./recurring.js";
import { loadScript } from "./extract.js";
import { columnChart, lineChart, sparkline, bindTooltips } from "./charts.js";
import { analyze, goalStatus, thisMonth, budgetPlan, tips, addYm, isTransfer, isAnlage, FIX_KAT } from "./savings.js";

const $ = (id) => document.getElementById(id);
const PERIOD_SIZE = { monat: 1, quartal: 3, semester: 6, jahr: 12 };
const PERIOD_NAME = { monat: "Monat", quartal: "Quartal", semester: "Semester", jahr: "Jahr" };
const BEREICH_NAME = { geschaeft: "Geschäft", privat: "Privat", alle: "Alle" };
const MWST_LIMIT = 10000000; // CHF 100'000 annual turnover, in Rappen
const ZAHLUNGSFRIST = 30;
const RATE_LABEL = { 8.1: "8.1 % Normalsatz", 2.6: "2.6 % reduziert", 3.8: "3.8 % Beherbergung", 0: "0 % ausgenommen / privat", 7.7: "7.7 % (bis 2023)", 2.5: "2.5 % (bis 2023)", 3.7: "3.7 % (bis 2023)" };
const QUELLE = { gelernt: ["paid", "gelernt"], regel: ["open", "erkannt"], vorschlag: ["warn", "Vorschlag"], unsicher: ["late", "bitte prüfen"] };

// View preferences only (nothing financial) are kept unencrypted in this browser.
const prefs = (() => { try { return JSON.parse(localStorage.getItem("kassenbuch.prefs") || "{}"); } catch (_) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("kassenbuch.prefs", JSON.stringify(prefs)); } catch (_) {} };

const now = new Date();
const state = {
  data: null,
  view: "uebersicht",
  bereich: prefs.bereich || "geschaeft",
  period: { mode: PERIOD_SIZE[prefs.mode] ? prefs.mode : "monat", year: now.getFullYear(), idx: 0 },
  filter: "alle", q: "", sort: prefs.sort === "neu" ? "neu" : "auszug",
  queue: [],
  notice: "",
  editing: null, editingRec: null, editGoal: false,
};
state.period.idx = Math.floor(now.getMonth() / PERIOD_SIZE[state.period.mode]);

// ---------- saving ----------
async function persistNow() {
  if (!state.data || !vault.isUnlocked()) return;
  try {
    await vault.saveData(state.data);
    $("saved").textContent = `Gespeichert ${new Date().toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) { toast("Speichern fehlgeschlagen: " + e.message); }
}
const save = debounce(persistNow, 250);

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// On phones the share sheet ("In Dateien sichern", AirDrop, Mail) is the reliable way to keep a file;
// on computers a normal download. Resolves "saved", "shared" or "aborted".
const touchDevice = matchMedia("(pointer: coarse)").matches;
function anchorDownload(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return "saved";
}
async function download(name, blob) {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  if (!touchDevice || !navigator.canShare?.({ files: [file] })) return anchorDownload(name, blob);
  try { await navigator.share({ files: [file] }); return "shared"; }
  catch (e) {
    if (e.name === "AbortError") return "aborted";
    // the tap that started a long task has expired: ask for one more tap
    return new Promise((resolve) => {
      const d = $("dlg-share");
      $("share-name").textContent = name;
      $("share-go").onclick = async () => {
        d.close();
        try { await navigator.share({ files: [file] }); resolve("shared"); }
        catch (err) { resolve(err.name === "AbortError" ? "aborted" : anchorDownload(name, blob)); }
      };
      d.onclose = () => setTimeout(() => resolve("aborted"), 0);
      d.showModal();
    });
  }
}
const savedNote = (r, what) => { if (r !== "aborted") toast(r === "shared" ? `${what} bereit.` : `${what} gespeichert. Du findest die Datei in deinen Downloads.`); };

// ---------- lock screen ----------
function showLock(mode) {
  $("app").hidden = true; $("lock").hidden = false; $("lock-loading").hidden = true;
  for (const f of ["setup", "unlock", "restore"]) $("form-" + f).hidden = f !== mode;
  $("restore-warn").hidden = mode !== "restore" || !hasVaultCache;
  const focus = { setup: "setup-pw", unlock: "unlock-pw", restore: "restore-file" }[mode];
  setTimeout(() => $(focus)?.focus(), 30);
}
let hasVaultCache = false;

$("form-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("setup-pw").value, pw2 = $("setup-pw2").value, m = $("setup-msg");
  if (pw.length < 8) return (m.textContent = "Das Passwort braucht mindestens 8 Zeichen.");
  if (pw !== pw2) return (m.textContent = "Die beiden Passwörter sind nicht gleich.");
  if (!$("setup-ok").checked) return (m.textContent = "Bitte bestätige, dass du den Hinweis gelesen hast.");
  m.textContent = "";
  try { afterUnlock(await vault.createVault(pw)); $("form-setup").reset(); }
  catch (err) { m.textContent = "Das Kassenbuch konnte nicht erstellt werden: " + err.message; }
});

$("form-unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("unlock-btn"), m = $("unlock-msg");
  btn.disabled = true; btn.textContent = "Entsperre …"; m.textContent = "";
  try { afterUnlock(await vault.unlock($("unlock-pw").value)); $("unlock-pw").value = ""; }
  catch (err) { m.textContent = err.message; $("unlock-pw").select(); }
  finally { btn.disabled = false; btn.textContent = "Entsperren"; }
});

document.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => showLock("restore")));
$("restore-back").addEventListener("click", () => showLock(hasVaultCache ? "unlock" : "setup"));
$("form-restore").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = $("restore-file").files[0], m = $("restore-msg");
  if (!f) return (m.textContent = "Bitte eine Sicherungsdatei wählen.");
  m.textContent = "Wird wiederhergestellt …";
  try { afterUnlock(await vault.importBackup(await f.text(), $("restore-pw").value)); $("form-restore").reset(); m.textContent = ""; toast("Sicherung wiederhergestellt."); }
  catch (err) { m.textContent = err.message; }
});

$("btn-reset-start").addEventListener("click", () => { $("reset-confirm").hidden = false; $("reset-word").focus(); });
$("btn-reset").addEventListener("click", async () => {
  if ($("reset-word").value.trim().toUpperCase() !== "LÖSCHEN") return toast("Bitte LÖSCHEN eintippen.");
  await vault.wipe(); hasVaultCache = false; $("reset-word").value = ""; $("reset-confirm").hidden = true;
  showLock("setup");
});

function afterUnlock(data) {
  hasVaultCache = true;
  state.data = data;
  state.data.settings = { ...vault.emptyData().settings, ...data.settings };
  const created = bookDue(state.data);
  if (created.length) { save(); state.notice = `${plural(created.length, "wiederkehrende Buchung", "wiederkehrende Buchungen")} automatisch eingetragen.`; }
  $("lock").hidden = true; $("app").hidden = false;
  route(location.hash.slice(1) || "uebersicht");
  touch();
}

async function lockNow() {
  await persistNow();
  vault.lock();
  state.data = null; state.queue = [];
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("view").innerHTML = "";
  showLock("unlock");
}
$("btn-lock").addEventListener("click", lockNow);

// ---------- light / dark ----------
const THEMES = { auto: "Automatisch", light: "Hell", dark: "Dunkel" };
const THEME_ICON = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
};
function applyTheme(t) {
  if (!THEMES[t]) t = "auto";
  prefs.theme = t; savePrefs();
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  // the browser bar follows the page
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.setAttribute("content", dark ? "#111916" : "#eef2f0"); m.removeAttribute("media"); });
  const b = $("btn-theme");
  b.querySelector(".t-ico").innerHTML = THEME_ICON[t];
  b.querySelector(".t-label").textContent = THEMES[t];
  const next = { auto: "light", light: "dark", dark: "auto" }[t];
  b.title = `Darstellung: ${THEMES[t]}. Klicken für ${THEMES[next]}.`;
  b.setAttribute("aria-label", b.title);
  if (state.data && state.view === "einstellungen") renderSettings();
}
$("btn-theme").addEventListener("click", () => applyTheme({ auto: "light", light: "dark", dark: "auto" }[prefs.theme || "auto"]));
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if ((prefs.theme || "auto") === "auto") applyTheme("auto"); });
applyTheme(prefs.theme || "auto");

// lock automatically after a period without activity
let lastActive = Date.now();
const touch = () => { lastActive = Date.now(); };
["pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) => addEventListener(ev, touch, { passive: true }));
function checkIdle() {
  const minutes = prefs.autolock ?? 15;
  if (state.data && minutes > 0 && Date.now() - lastActive > minutes * 60000 && !state.queue.some((q) => q.state === "busy")) lockNow();
}
setInterval(checkIdle, 20000);
// timers pause while the phone shows another app: check again when coming back, save when leaving
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkIdle();
  else if (state.data) persistNow();
});
addEventListener("pagehide", () => { if (state.data) vault.saveData(state.data); });

// ---------- periods and aggregation ----------
function range() { const { mode, year, idx } = state.period; return rangeOf(mode, year, idx); }
function rangeOf(mode, year, idx) {
  const size = PERIOD_SIZE[mode], m0 = idx * size;
  const label = mode === "jahr" ? String(year) : mode === "semester" ? `${idx + 1}. Semester ${year}`
    : mode === "quartal" ? `Q${idx + 1} ${year}` : `${MONTHS_LONG[idx]} ${year}`;
  return { from: `${year}-${String(m0 + 1).padStart(2, "0")}-01`, to: `${year}-${String(m0 + size).padStart(2, "0")}-31`, months: size, label };
}
const mwstModus = () => state.data.settings.mwst || "effektiv";
const allTx = () => Object.entries(state.data.tx).map(([id, t]) => ({ id, ...t }));
const visibleTx = () => allTx().filter((t) => state.bereich === "alle" || bereichOf(t) === state.bereich);
const inRange = (t, r) => t.datum >= r.from && t.datum <= r.to;
function sums(list) {
  const s = { incB: 0, incN: 0, expB: 0, expN: 0, vatOut: 0, vatIn: 0 };
  for (const t of list) {
    const v = vatOf(t.betragCent, t.ustSatz || 0);
    if (t.typ === "einnahme") { s.incB += t.betragCent; s.incN += t.betragCent - v; s.vatOut += v; }
    else { s.expB += t.betragCent; s.expN += t.betragCent - v; s.vatIn += v; }
  }
  return s;
}

function controlsHtml(withPeriod = true) {
  const seg = (act, items, cur, label) => `<div class="seg" role="group" aria-label="${label}">${Object.entries(items).map(([k, v]) =>
    `<button type="button" data-act="${act}" data-v="${k}" aria-pressed="${cur === k}">${v}</button>`).join("")}</div>`;
  return `<div class="controls">${seg("bereich", BEREICH_NAME, state.bereich, "Bereich")}${withPeriod ? seg("mode", PERIOD_NAME, state.period.mode, "Zeitraum")
    + `<div class="stepper"><button class="icon-btn" type="button" data-act="prev" aria-label="Vorheriger Zeitraum">‹</button><span>${esc(range().label)}</span><button class="icon-btn" type="button" data-act="next" aria-label="Nächster Zeitraum">›</button></div>` : ""}</div>`;
}

// When the chosen period and area show nothing although there are bookings, say where they are.
function elsewhereHtml() {
  const all = allTx();
  if (!all.length) return "";
  const dates = all.map((t) => t.datum).sort();
  const [first, last] = [dates[0], dates[dates.length - 1]];
  const span = first.slice(0, 7) === last.slice(0, 7) ? `${MONTHS_LONG[+first.slice(5, 7) - 1]} ${first.slice(0, 4)}` : `${dmy(first)} bis ${dmy(last)}`;
  return `<div class="alert info"><span>Hier ist nichts zu sehen, aber deine <strong>${plural(all.length, "Buchung", "Buchungen")}</strong> sind gespeichert (${esc(span)}).</span><button class="btn sm" data-act="jump-latest">Buchungen anzeigen</button></div>`;
}

// ---------- routing ----------
const VIEWS = { uebersicht: renderOverview, erfassen: renderCapture, buchungen: renderBookings, sparen: renderSavings, wiederkehrend: renderRecurring, einstellungen: renderSettings };
function route(v) {
  if (!VIEWS[v]) v = "uebersicht";
  state.view = v;
  history.replaceState(null, "", "#" + v);
  document.querySelectorAll(".nav[data-view]").forEach((b) => { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  render();
  scrollTo(0, 0);
}
function render() { if (state.data) VIEWS[state.view](); }
document.querySelectorAll(".nav[data-view]").forEach((b) => b.addEventListener("click", () => route(b.dataset.view)));
addEventListener("hashchange", () => { if (state.data) route(location.hash.slice(1)); });

// shared controls on every page
$("view").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, p = state.period;
  if (act === "bereich") { state.bereich = b.dataset.v; prefs.bereich = state.bereich; savePrefs(); render(); }
  else if (act === "mode") {
    const m = p.mode === "jahr" ? now.getMonth() : p.idx * PERIOD_SIZE[p.mode];
    p.mode = b.dataset.v; p.idx = Math.floor(m / PERIOD_SIZE[p.mode]); prefs.mode = p.mode; savePrefs(); render();
  } else if (act === "prev" || act === "next") {
    const count = 12 / PERIOD_SIZE[p.mode];
    p.idx += act === "next" ? 1 : -1;
    if (p.idx < 0) { p.idx = count - 1; p.year--; }
    if (p.idx >= count) { p.idx = 0; p.year++; }
    render();
  } else if (act === "goto") route(b.dataset.v);
  else if (act === "jump-latest") {
    // show the year of the latest booking, business and private together
    const latest = allTx().reduce((a, t) => (t.datum > a ? t.datum : a), "");
    if (!latest) return;
    state.bereich = prefs.bereich = "alle"; p.mode = prefs.mode = "jahr"; p.year = +latest.slice(0, 4); p.idx = 0; savePrefs();
    if (state.view === "buchungen") state.filter = "alle";
    render();
  }
  else if (act === "new-entry") openEntry(null);
  else pageClick(act, b, e);
});
$("view").addEventListener("change", (e) => pageChange(e));
$("view").addEventListener("input", (e) => pageInput(e));
let pageClick = () => {}, pageChange = () => {}, pageInput = () => {};
function setHandlers(click, change = () => {}, input = () => {}) { pageClick = click; pageChange = change; pageInput = input; }

// =====================================================================
// Übersicht
// =====================================================================
function renderOverview() {
  const r = range(), pr = prevRange(), modus = mwstModus(), biz = state.bereich === "geschaeft";
  const brutto = !biz || modus !== "effektiv";
  const all = visibleTx().filter((t) => !isTransfer(t)), inP = all.filter((t) => inRange(t, r)), s = sums(inP);
  const prevP = all.filter((t) => inRange(t, pr)), ps = sums(prevP);
  const net = (f) => visibleTx().filter((t) => f(t) && inRange(t, r)).reduce((a, t) => a + (t.typ === "ausgabe" ? t.betragCent : -t.betragCent), 0);
  const moved = net((t) => isTransfer(t) && !isAnlage(t)), invested = net(isAnlage);
  const inc = brutto ? s.incB : s.incN, exp = brutto ? s.expB : s.expN, profit = inc - exp;
  const pInc = brutto ? ps.incB : ps.incN, pExp = brutto ? ps.expB : ps.expN, pProfit = pInc - pExp;
  const val = (t) => (brutto ? t.betragCent : nettoOf(t));
  const count = (typ) => plural(inP.filter((t) => t.typ === typ).length, "Buchung", "Buchungen");

  let k4 = { label: "MWST-Schuld", val: fmt(s.vatOut - s.vatIn), cls: s.vatOut - s.vatIn > 0 ? "exp" : "inc", sub: `Umsatzsteuer ${fmt0(s.vatOut)} − Vorsteuer ${fmt0(s.vatIn)}` };
  if (!biz) {
    const lohn = inP.filter((t) => t.typ === "einnahme" && t.kategorie === "Lohn");
    const detail = lohn.filter((t) => t.lohn?.bruttolohn);
    const gross = detail.reduce((a, t) => a + t.lohn.bruttolohn, 0);
    const ded = detail.reduce((a, t) => a + t.lohn.bruttolohn - (t.lohn.nettolohn || t.betragCent), 0);
    k4 = { label: "Lohn ausbezahlt", val: fmt(lohn.reduce((a, t) => a + t.betragCent, 0)), cls: "",
      sub: !lohn.length ? "Lohnabrechnung unter „Erfassen“ einlesen" : gross ? `brutto ${fmt0(gross)} · Abzüge ${fmt0(ded)}` : plural(lohn.length, "Lohnzahlung", "Lohnzahlungen") };
  } else if (modus === "keine") {
    const y = sums(all.filter((t) => t.datum.startsWith(String(state.period.year))));
    k4 = { label: "Umsatz im Jahr", val: fmt0(y.incB), cls: "", sub: `MWST-pflichtig ab ${fmt0(MWST_LIMIT)} · ${Math.round((y.incB / MWST_LIMIT) * 100)} % erreicht` };
  } else if (modus === "saldo") {
    const rate = Number(state.data.settings.saldoSatz) || 0;
    k4 = rate ? { label: "MWST-Schuld", val: fmt(Math.round(s.incB * rate / 100)), cls: "", sub: `${rate} % Saldosteuersatz auf ${fmt0(s.incB)} Umsatz` }
      : { label: "MWST-Schuld", val: "–", cls: "", sub: "Saldosteuersatz in den Einstellungen eintragen" };
  }

  // the last twelve months up to the end of the chosen period, for the sparklines
  const endYm = r.to.slice(0, 7);
  const last12 = Array.from({ length: 12 }, (_, i) => addYm(endYm, i - 11)).map((ym) => {
    const m = sums(all.filter((t) => t.datum.startsWith(ym)));
    const mi = brutto ? m.incB : m.incN, me = brutto ? m.expB : m.expN;
    return { inc: mi, exp: me, bal: mi - me };
  });

  const open = all.filter((t) => t.typ === "einnahme" && t.status === "offen");
  const late = open.filter((t) => daysBetween(t.datum, todayIso()) > ZAHLUNGSFRIST);
  const lastBackup = state.data.settings.lastBackup;
  const needBackup = Object.keys(state.data.tx).length && (!lastBackup || daysBetween(lastBackup, todayIso()) > 30);
  const empty = !Object.keys(state.data.tx).length;
  const word = biz ? "Gewinn" : "Saldo";
  const quote = inc > 0 ? Math.round((profit / inc) * 100) : null;

  $("view").innerHTML = `
    <div class="pagehead"><h1>Übersicht</h1>${controlsHtml()}</div>
    ${state.notice ? `<div class="alert info"><strong>${esc(state.notice)}</strong><button class="btn ghost sm" data-act="goto" data-v="buchungen">Ansehen</button></div>` : ""}
    ${empty ? `<section class="panel welcome"><h2>Willkommen in deinem Kassenbuch</h2>
      <p class="muted">So kommen deine Zahlen hinein. Alles bleibt verschlüsselt auf diesem Computer.</p>
      <div class="steps">
        <div><b>1. Dokumente einlesen</b><span class="small muted">Lohnabrechnung, Rechnungen, Quittungen oder den Kontoauszug als PDF, Foto oder CSV.</span><button class="btn sm" data-act="goto" data-v="erfassen">Erfassen</button></div>
        <div><b>2. Feste Zahlungen anlegen</b><span class="small muted">Miete, Krankenkasse, Abos: einmal eintragen, die App bucht sie jeden Monat selbst.</span><button class="btn ghost sm" data-act="goto" data-v="wiederkehrend">Wiederkehrend</button></div>
        <div><b>3. Sicherung einrichten</b><span class="small muted">Eine verschlüsselte Sicherungsdatei schützt vor Datenverlust.</span><button class="btn ghost sm" data-act="goto" data-v="einstellungen">Einstellungen</button></div>
      </div></section>` : ""}
    ${!empty && !inP.length ? elsewhereHtml() : ""}
    <section class="dash-top" aria-label="Kennzahlen ${esc(r.label)}">
      <div class="hero">
        <span class="label">${word} ${esc(r.label)}</span>
        <span class="hero-val ${profit < 0 ? "neg" : ""}">${fmt(profit)}</span>
        ${deltaHtml(profit, pProfit, true, pr.label)}
        ${quote != null ? `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, quote)}" aria-label="${biz ? "Marge" : "Sparquote"}"><div style="width:${Math.max(0, Math.min(100, quote))}%"></div></div>
          <span class="small muted">${biz ? "Marge" : "Sparquote"} <b class="fg">${quote} %</b> der Einnahmen${moved > 0 ? ` · ${fmt0(moved)} aufs Sparkonto` : moved < 0 ? ` · ${fmt0(-moved)} vom Sparkonto genommen` : ""}${invested > 0 ? ` · ${fmt0(invested)} angelegt` : invested < 0 ? ` · ${fmt0(-invested)} aus Anlagen` : ""}</span>` : `<span class="small muted">noch keine Einnahmen in ${esc(r.label)}</span>`}
      </div>
      <div class="tile"><span class="label"><i class="key" style="background:var(--c-inc)"></i>Einnahmen</span><span class="tile-val">${fmt(inc)}</span>${deltaHtml(inc, pInc, true, pr.label)}<span class="sub">${brutto ? count("einnahme") : `netto · brutto ${fmt0(s.incB)}`}</span>${sparkline(last12.map((m) => m.inc))}</div>
      <div class="tile"><span class="label"><i class="key" style="background:var(--c-exp)"></i>Ausgaben</span><span class="tile-val">${fmt(exp)}</span>${deltaHtml(exp, pExp, false, pr.label)}<span class="sub">${brutto ? count("ausgabe") : `netto · brutto ${fmt0(s.expB)}`}</span>${sparkline(last12.map((m) => m.exp))}</div>
      <div class="tile"><span class="label">${k4.label}</span><span class="tile-val">${k4.val}</span><span class="sub">${esc(k4.sub)}</span></div>
    </section>
    ${goalStrip()}
    ${open.length ? `<div class="alert"><span><strong>${plural(open.length, "offene Rechnung", "offene Rechnungen")}</strong> über ${fmt(open.reduce((a, t) => a + t.betragCent, 0))}</span>${late.length ? `<span>${late.length} davon über ${ZAHLUNGSFRIST} Tage alt</span>` : ""}<button class="btn ghost sm" data-act="show-open">Anzeigen</button></div>` : ""}
    ${needBackup ? `<div class="alert"><span><strong>Sicherung empfohlen:</strong> ${lastBackup ? `letzte Sicherung am ${dmy(lastBackup)}` : "noch keine Sicherung erstellt"}.</span><button class="btn ghost sm" data-act="goto" data-v="einstellungen">Jetzt sichern</button></div>` : ""}
    <div class="grid2">
      ${monthPanel(all, brutto, word)}
      <section class="panel"><div class="panel-head"><h2>Ausgaben nach Kategorie</h2><span class="muted small">${Object.keys(state.data.settings.budgets || {}).length ? (r.months === 1 ? "Budget pro Monat" : `Budget × ${r.months} Monate`) : esc(r.label)}</span></div>
        <div class="cats">${catsHtml(inP, r, brutto)}</div></section>
    </div>
    <div class="grid2 even">
      ${cumulativePanel(all, r, pr, val)}
      ${statsPanel(inP, r, val, exp, inc, profit)}
    </div>`;
  bindTooltips($("view"));
  setHandlers((act, b) => {
    if (act === "show-open") { state.filter = "offen"; route("buchungen"); }
    else if (act === "table") {
      const t = $(b.dataset.v), on = t.hidden;
      t.hidden = !on; b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "Diagramm" : "Tabelle";
      t.previousElementSibling.hidden = on;
    }
  });
  state.notice = "";
}

function prevRange() {
  const { mode, year, idx } = state.period, count = 12 / PERIOD_SIZE[mode];
  return idx > 0 ? rangeOf(mode, year, idx - 1) : rangeOf(mode, year - 1, count - 1);
}

// change against the previous period: arrow, sign and words carry it, the colour only repeats it
function deltaHtml(cur, prev, upIsGood, prevLabel) {
  if (!prev || !cur) return `<span class="delta flat">${prev ? `${esc(prevLabel)}: ${fmt0(prev)}` : "kein Vergleich"}</span>`;
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (!pct) return `<span class="delta flat">gleich wie ${esc(prevLabel)}</span>`;
  const good = (pct > 0) === upIsGood;
  return `<span class="delta ${good ? "good" : "bad"}"><span aria-hidden="true">${pct > 0 ? "▲" : "▼"}</span> ${pct > 0 ? "+" : "−"}${Math.abs(pct)} % vs ${esc(prevLabel)}</span>`;
}

function monthPanel(all, brutto, word) {
  const y = state.period.year, { mode, idx } = state.period;
  const months = Array.from({ length: 12 }, (_, i) => {
    const ym = `${y}-${String(i + 1).padStart(2, "0")}`, m = sums(all.filter((t) => t.datum.startsWith(ym)));
    const inc = brutto ? m.incB : m.incN, exp = brutto ? m.expB : m.expN;
    return { label: MONTHS[i], title: `${MONTHS_LONG[i]} ${y}`, values: { inc, exp, bal: inc || exp ? inc - exp : null }, dim: Math.floor(i / PERIOD_SIZE[mode]) !== idx };
  });
  const series = [{ key: "inc", label: "Einnahmen", color: "var(--c-inc)" }, { key: "exp", label: "Ausgaben", color: "var(--c-exp)" }];
  const line = { key: "bal", label: word, color: "var(--c-bal)" };
  const table = `<table class="data"><thead><tr><th>Monat</th><th class="r">Einnahmen</th><th class="r">Ausgaben</th><th class="r">${word}</th></tr></thead><tbody>
    ${months.map((m) => `<tr><td>${m.title}</td><td class="r num">${fmt(m.values.inc)}</td><td class="r num">${fmt(m.values.exp)}</td><td class="r num">${m.values.bal == null ? "–" : fmt(m.values.bal)}</td></tr>`).join("")}</tbody></table>`;
  return `<section class="panel"><div class="panel-head"><h2>Monatsverlauf ${y}</h2>
      <div class="legend"><span><i style="background:var(--c-inc)"></i>Einnahmen</span><span><i style="background:var(--c-exp)"></i>Ausgaben</span><span><i class="lkey" style="background:var(--c-bal)"></i>${word}</span>
      <button class="btn quiet sm" data-act="table" data-v="t-month" aria-pressed="false">Tabelle</button></div></div>
      <div class="chart">${columnChart({ groups: months, series, line, fmt, ariaLabel: `Einnahmen, Ausgaben und ${word} pro Monat ${y}` })}</div>
      <div class="table-wrap" id="t-month" hidden>${table}</div></section>`;
}

// spending added up day by day, this period against the one before
function cumulativePanel(all, r, pr, val) {
  const today = todayIso(), days = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) { if (!isRealDate(d)) continue; days.push(d); }
  const pdays = [];
  for (let d = pr.from; d <= pr.to; d = addDays(d, 1)) { if (!isRealDate(d)) continue; pdays.push(d); }
  const step = days.length > 92 ? 7 : 1;
  const run = (list, dates, stopAt) => {
    const by = new Map(); for (const t of list) if (t.typ === "ausgabe") by.set(t.datum, (by.get(t.datum) || 0) + val(t));
    let acc = 0; const out = [];
    dates.forEach((d, i) => { acc += by.get(d) || 0; if (i % step === step - 1 || i === dates.length - 1) out.push(stopAt && d > stopAt ? null : acc); });
    return out;
  };
  const cur = run(all.filter((t) => inRange(t, r)), days, today), prev = run(all.filter((t) => inRange(t, pr)), pdays);
  const n = Math.max(cur.length, prev.length);
  const xs = Array.from({ length: n }, (_, i) => { const d = days[Math.min(days.length - 1, (i + 1) * step - 1)]; return d ? dmy(d).slice(0, 6) : ""; });
  const ticks = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const lastCur = [...cur].reverse().find((v) => v != null) || 0;
  const idxNow = cur.findIndex((v) => v == null); const at = idxNow < 0 ? cur.length - 1 : idxNow - 1;
  const prevAt = prev[Math.min(prev.length - 1, Math.max(0, at))] || 0;
  if (!lastCur && !prev.some(Boolean)) return `<section class="panel"><h2>Ausgaben aufsummiert</h2><p class="muted">Keine Ausgaben in ${esc(r.label)} und ${esc(pr.label)}.</p></section>`;
  const diff = lastCur - prevAt;
  return `<section class="panel"><div class="panel-head"><h2>Ausgaben aufsummiert</h2>
      <div class="legend"><span><i class="lkey" style="background:var(--c-exp)"></i>${esc(r.label)}</span><span><i class="lkey" style="background:var(--c-ctx)"></i>${esc(pr.label)}</span></div></div>
      <div class="chart">${lineChart({ xs, ticks, fmt, ariaLabel: `Ausgaben aufsummiert ${r.label} im Vergleich zu ${pr.label}`,
        series: [{ key: "prev", label: pr.label, color: "var(--c-ctx)", values: prev, context: true }, { key: "cur", label: r.label, color: "var(--c-exp)", values: cur }] })}</div>
      <p class="small">${prevAt ? `Bis jetzt <b>${fmt0(lastCur)}</b> ausgegeben, ${diff > 0 ? `<b class="exp">${fmt0(diff)} mehr</b>` : diff < 0 ? `<b class="inc">${fmt0(-diff)} weniger</b>` : "gleich viel"} als zum gleichen Zeitpunkt in ${esc(pr.label)}.` : `Bis jetzt <b>${fmt0(lastCur)}</b> ausgegeben.`}</p>
    </section>`;
}
const addDays = (iso, n) => { const d = new Date(iso.slice(0, 7) + "-01T12:00:00"); d.setDate(+iso.slice(8, 10) + n); return d.toISOString().slice(0, 10); };
const isRealDate = (iso) => { const d = new Date(iso + "T12:00:00"); return !isNaN(d) && d.toISOString().slice(0, 10) === iso; };

function statsPanel(inP, r, val, exp, inc, profit) {
  const spend = inP.filter((t) => t.typ === "ausgabe");
  const today = todayIso(), end = r.to < today ? r.to : today;
  const daysSoFar = r.from > today ? 0 : Math.max(1, daysBetween(r.from, end) + 1);
  const biggest = spend.reduce((a, t) => (!a || val(t) > val(a) ? t : a), null);
  const byM = new Map();
  for (const t of spend) {
    const k = merchantKey(t.partner || t.notiz || "") || t.kategorie;
    const e = byM.get(k) || { name: t.partner || t.notiz || t.kategorie, n: 0, sum: 0 }; e.n++; e.sum += val(t); byM.set(k, e);
  }
  const often = [...byM.values()].sort((a, b) => b.n - a.n || b.sum - a.sum)[0];
  const fix = spend.filter((t) => FIX_KAT.has(t.kategorie)).reduce((a, t) => a + val(t), 0);
  const wd = [0, 0, 0, 0, 0, 0, 0];
  for (const t of spend) wd[(new Date(t.datum + "T12:00:00").getDay() + 6) % 7] += val(t);
  const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"], WDL = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const topWd = wd.indexOf(Math.max(...wd));
  const stat = (label, value, sub = "") => `<div class="stat"><dt>${label}</dt><dd><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</dd></div>`;
  return `<section class="panel"><div class="panel-head"><h2>Statistik</h2><span class="muted small">${esc(r.label)}</span></div>
      <dl class="stats">
        ${stat("Ø Ausgaben pro Tag", daysSoFar ? fmt(Math.round(exp / daysSoFar)) : "–", daysSoFar ? plural(daysSoFar, "Tag", "Tage") : "")}
        ${stat("Grösste Ausgabe", biggest ? fmt(val(biggest)) : "–", biggest ? `${esc((biggest.partner || biggest.notiz || biggest.kategorie).slice(0, 40))} · ${dmy(biggest.datum)}` : "")}
        ${stat("Am häufigsten", often ? esc(often.name.slice(0, 28)) : "–", often ? `${plural(often.n, "Zahlung", "Zahlungen")} · ${fmt0(often.sum)}` : "")}
        ${stat("Fixkosten", exp ? `${Math.round((fix / exp) * 100)} %` : "–", exp ? `${fmt0(fix)} der Ausgaben` : "")}
        ${stat("Buchungen", String(inP.length), `${inP.filter((t) => t.typ === "einnahme").length} Einnahmen · ${spend.length} Ausgaben`)}
        ${stat("Teuerster Wochentag", spend.length ? WDL[topWd] : "–", spend.length ? fmt0(wd[topWd]) : "")}
      </dl>
      ${spend.length ? `<h3>Ausgaben nach Wochentag</h3><div class="chart">${columnChart({ height: 170, fmt, ariaLabel: "Ausgaben nach Wochentag",
        groups: WD.map((d, i) => ({ label: d, title: WDL[i], values: { exp: wd[i] } })), series: [{ key: "exp", label: "Ausgaben", color: "var(--c-exp)" }] })}</div>` : ""}
    </section>`;
}

// whether investments (E-Trading) count towards the savings goal
const goalOpts = () => ({ anlagen: !!state.data.settings.anlagenImZiel });

// a one-line reminder of the savings goal on the overview
function goalStrip() {
  const g = state.data.settings.sparziel;
  if (!g) return Object.keys(state.data.tx).length ? `<div class="alert info"><span><strong>Tipp:</strong> Lege ein Sparziel fest. Die App zeigt dir dann, wie viel du jeden Monat noch ausgeben kannst.</span><button class="btn ghost sm" data-act="goto" data-v="sparen">Sparziel festlegen</button></div>` : "";
  const st = goalStatus(g, allTx(), todayIso(), goalOpts()), line = goalLine(g, st);
  return `<button type="button" class="goal-strip" data-act="goto" data-v="sparen">
      <span><b>Sparziel ${fmt0(g.betrag)}</b><small class="${line.cls}">${esc(line.text)}</small></span>
      <span class="goal-bar sm"><span class="fill${st.diff < 0 && st.started ? " behind" : ""}" style="width:${Math.max(0, Math.min(100, st.pct * 100)).toFixed(1)}%"></span></span>
      <span class="num">${fmt0(st.savedTotal)} · ${Math.round(st.pct * 100)} %</span>
    </button>`;
}

function niceMax(v) {
  if (v <= 0) return 100000;
  const raw = v / 4, e = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= raw) return m * e * 4;
  return 40 * e;
}
function catsHtml(inP, r, brutto) {
  const by = new Map();
  for (const t of inP) if (t.typ === "ausgabe") by.set(t.kategorie, (by.get(t.kategorie) || 0) + (brutto ? t.betragCent : nettoOf(t)));
  const budgets = state.data.settings.budgets || {};
  for (const k of Object.keys(budgets)) if (!by.has(k)) by.set(k, 0);
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) return `<p class="muted">Keine Ausgaben in ${esc(r.label)}.</p>`;
  const top = Math.max(...rows.map((x) => x[1])), total = rows.reduce((a, x) => a + x[1], 0);
  return rows.map(([k, v]) => {
    const b = budgets[k] ? budgets[k] * r.months : 0;
    let cls = "", hint = "", width = top ? (v / top) * 100 : 0;
    if (b) {
      const pct = v / b; width = Math.min(100, pct * 100);
      cls = pct > 1 ? "over" : pct > 0.85 ? "near" : "ok";
      hint = pct > 1 ? `<div class="hint over">${fmt(v - b)} über Budget (${fmt0(b)})</div>` : `<div class="hint">${Math.round(pct * 100)} % von ${fmt0(b)} · noch ${fmt(b - v)} frei</div>`;
    }
    const share = total ? Math.round((v / total) * 100) : 0;
    return `<div class="cat"><div class="cat-top"><span>${esc(k)}</span><span><span class="share">${share} %</span> <span class="num">${fmt(v)}</span></span></div><div class="bar ${cls}"><div style="width:${width.toFixed(1)}%"></div></div>${hint}</div>`;
  }).join("");
}

// =====================================================================
// Erfassen: drop documents, the app's AI reads them, the user checks and books
// =====================================================================
function renderCapture() {
  $("view").innerHTML = `
    <div class="pagehead"><h1>Erfassen</h1><button class="btn ghost" data-act="new-entry">Ohne Dokument erfassen</button></div>
    <div class="actions only-touch"><label class="btn" for="cam-in">Beleg fotografieren</label><input type="file" id="cam-in" class="vh" accept="image/*" capture="environment"></div>
    <label class="drop" id="drop" for="file-in">
      <input type="file" id="file-in" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.csv,.xml,.eml,application/pdf,image/*,text/csv">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9 15l3-3 3 3"/></svg>
      <strong class="only-mouse">Dokumente hier ablegen</strong><strong class="only-touch">Dokument auswählen</strong>
      <span class="only-mouse">oder klicken, um Dateien auszuwählen</span><span class="only-touch">aus Dateien, Fotos oder Mail-Anhängen</span>
      <span class="small muted">Lohnabrechnung, Rechnung, Quittung (PDF oder Foto) · Kontoauszug (CSV, camt.053 oder PDF) · E-Mail (.eml)</span>
    </label>
    <p class="small muted">Die eingebaute KI liest die Dokumente direkt auf diesem Gerät, ohne Internet. Sie lernt aus jeder Korrektur, die du vor dem Buchen machst.</p>
    <div class="queue" id="queue"></div>`;
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  $("file-in").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  $("cam-in").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  setHandlers(queueClick, queueChange, queueInput);
  renderQueue();
}

let chain = Promise.resolve();
function addFiles(list) {
  for (const file of [...list].slice(0, 30)) {
    const item = { id: uid(), name: file.name, state: "busy", step: "Wartet …", file };
    state.queue.unshift(item);
    chain = chain.then(() => runItem(item));
  }
  renderQueue();
}

async function runItem(item) {
  item.step = "Wird gelesen …"; renderQueue();
  try {
    const s = state.data.settings;
    const results = await processFile(item.file, { firma: s.firma, ibans: s.ibans, eigeneKonten: [...(s.eigeneKonten || []), ...(s.ibans || [])], learn: state.data.learn }, (msg) => { item.step = msg; renderQueue(); });
    const at = state.queue.indexOf(item);
    const items = results.map((r) => ({ id: uid(), state: "review", ...r, name: r.name || item.name }));
    for (const it of items) if (it.kind === "auszug") markDupes(it.rows, state.data);
    for (const it of items) if (it.kind !== "auszug" && it.waehrung && it.waehrung !== "CHF") { it.originalBetrag = it.betragCent; it.betragCent = null; }
    if (at >= 0) state.queue.splice(at, 1, ...items);
  } catch (e) {
    item.state = "err"; item.error = e.message || "Das Dokument konnte nicht gelesen werden.";
  }
  renderQueue();
}

function datalistId(bereich, typ) { return `dl-${bereich}-${typ}`; }
function ensureDatalists() {
  const used = {};
  for (const t of Object.values(state.data.tx)) (used[datalistId(bereichOf(t), t.typ)] ||= new Set()).add(t.kategorie);
  for (const b of ["geschaeft", "privat"]) for (const typ of ["einnahme", "ausgabe"]) {
    const id = datalistId(b, typ);
    let dl = $(id);
    if (!dl) { dl = document.createElement("datalist"); dl.id = id; document.body.appendChild(dl); }
    const all = new Set([...KAT[b][typ], ...(used[id] || [])]);
    dl.innerHTML = [...all].map((k) => `<option value="${esc(k)}" label="${esc(konto(k) ? "Konto " + konto(k) : "")}">`).join("");
  }
}

const rateOptions = (cur) => RATES.map((r) => `<option value="${r}"${r === cur ? " selected" : ""}>${RATE_LABEL[r]}</option>`).join("");
const amountText = (rappen) => (rappen ? (rappen / 100).toLocaleString("de-CH", { minimumFractionDigits: 2 }) : "");

function itemHtml(it) {
  const head = `<div class="card-head"><span class="file">${esc(it.name)}</span>`;
  if (it.state === "busy") return `<div class="card">${head}</div><div class="progress"><span class="pulse"></span>${esc(it.step)}</div></div>`;
  if (it.state === "err") return `<div class="card err">${head}<button class="btn quiet sm" data-act="q-drop" data-q="${it.id}">Entfernen</button></div><p class="msg err">${esc(it.error)}</p></div>`;
  if (it.state === "booked") return `<div class="card done">${head}<span class="chip paid">gebucht</span></div><p class="msg ok">${esc(it.bookedText || "Gebucht.")}</p></div>`;
  return it.kind === "auszug" ? statementHtml(it, head) : docHtml(it, head);
}

function docHtml(it, head) {
  const q = (f) => `id="q-${it.id}-${f}" data-q="${it.id}" data-f="${f}"`;
  const priv = it.bereich === "privat";
  const [cls, word] = QUELLE[it.quelle] || QUELLE.unsicher;
  const lohn = it.kind === "lohn";
  const fremd = it.waehrung && it.waehrung !== "CHF";
  const lf = (k, label) => `<div class="field"><label for="q-${it.id}-l-${k}">${label}</label><input type="text" inputmode="decimal" id="q-${it.id}-l-${k}" data-q="${it.id}" data-l="${k}" value="${amountText(it.lohn[k])}"></div>`;
  return `<div class="card">${head}<span>${lohn ? '<span class="chip paid">Lohnabrechnung</span>' : `<span class="chip ${it.typ === "einnahme" ? "paid" : "late"}">${it.typ === "einnahme" ? "Einnahme" : "Ausgabe"}</span>`}</span></div>
    <div class="review${it.preview ? "" : " noimg"}">
      ${it.preview ? `<img src="${it.preview}" alt="Vorschau von ${esc(it.name)}" data-act="q-zoom" data-q="${it.id}">` : ""}
      <div style="display:grid;gap:12px">
        ${it.warnings?.length ? `<ul class="warnings">${it.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
        ${it.struct ? `<div class="alert info"><span>Ist das ein Kontoauszug? Dann konnte die App den Aufbau nicht lesen. Speichere den anonymen Aufbau (nur Positionen und Platzhalter, keine Namen, Beträge oder IBAN) und lade ihn im Chat bei Claude hoch, damit die Erkennung angepasst werden kann. Bis dahin: Kontoauszug im E-Banking als CSV oder camt.053 exportieren.</span><button class="btn ghost sm" data-act="q-struct" data-q="${it.id}">Anonymen Aufbau speichern</button></div>` : ""}
        <div class="fields">
          ${lohn ? "" : `<div class="field w2"><span class="flabel">Art</span><div class="typ" role="radiogroup" aria-label="Art">
            <label><input type="radio" name="q-${it.id}-typ" value="einnahme" data-q="${it.id}" data-f="typ"${it.typ === "einnahme" ? " checked" : ""}><span>Einnahme</span></label>
            <label><input type="radio" name="q-${it.id}-typ" value="ausgabe" data-q="${it.id}" data-f="typ"${it.typ === "ausgabe" ? " checked" : ""}><span>Ausgabe</span></label></div></div>`}
          <div class="field"><label for="q-${it.id}-bereich">Bereich</label><select ${q("bereich")}><option value="geschaeft"${!priv ? " selected" : ""}>Geschäft</option><option value="privat"${priv ? " selected" : ""}>Privat</option></select></div>
          <div class="field"><label for="q-${it.id}-datum">${lohn ? "Ausbezahlt am" : "Datum"}</label><input type="date" ${q("datum")} value="${esc(it.datum || "")}"></div>
          <div class="field"><label for="q-${it.id}-betrag">${lohn ? "Auszahlung (CHF)" : fremd ? `Betrag in CHF (Beleg: ${esc(it.waehrung)} ${amountText(it.originalBetrag)})` : "Betrag brutto (CHF)"}</label><input type="text" inputmode="decimal" ${q("betrag")} value="${amountText(it.betragCent)}"></div>
          ${lohn ? "" : `<div class="field"><label for="q-${it.id}-ust">MWST</label><select ${q("ust")}${priv ? " disabled" : ""}>${rateOptions(priv ? 0 : it.ustSatz)}</select></div>`}
          <div class="field w2"><label for="q-${it.id}-kategorie">Kategorie <span class="chip ${cls}">${word}</span></label><input type="text" ${q("kategorie")} list="${datalistId(it.bereich, it.typ)}" value="${esc(it.kategorie)}"></div>
          <div class="field"><label for="q-${it.id}-partner">${lohn ? "Arbeitgeber" : it.typ === "einnahme" ? "Kunde" : "Lieferant"}</label><input type="text" ${q("partner")} value="${esc(it.partner)}"></div>
          ${lohn ? "" : `<div class="field"><label for="q-${it.id}-status">Status</label><select ${q("status")}><option value="bezahlt"${it.status === "bezahlt" ? " selected" : ""}>bezahlt</option><option value="offen"${it.status === "offen" ? " selected" : ""}>offen</option></select></div>
          <div class="field"><label for="q-${it.id}-beleg">Beleg-Nr.</label><input type="text" ${q("beleg")} value="${esc(it.beleg)}"></div>`}
          <div class="field ${lohn ? "w2" : "w2"}"><label for="q-${it.id}-notiz">Notiz</label><input type="text" ${q("notiz")} value="${esc(it.notiz)}"></div>
          ${lohn ? `<div class="w4"><p class="label" style="margin:4px 0 8px">Lohnabrechnung ${esc(it.monatLabel || "")}</p><div class="fields">
            ${lf("bruttolohn", "Bruttolohn")}${lf("ahvIvEo", "AHV/IV/EO")}${lf("alv", "ALV")}${lf("bvg", "BVG")}${lf("nbuKtg", "NBU/KTG")}${lf("quellensteuer", "Quellensteuer")}${lf("uebrigeAbzuege", "Übrige Abzüge")}${lf("nettolohn", "Nettolohn")}</div></div>` : ""}
        </div>
        <p class="msg err" id="q-${it.id}-msg" role="alert"></p>
        <div class="actions"><button class="btn" data-act="q-book" data-q="${it.id}">Buchen</button><button class="btn quiet" data-act="q-drop" data-q="${it.id}">Verwerfen</button></div>
      </div>
    </div></div>`;
}

// Movements already booked (from an earlier import) whose date or order differs from this statement.
function misaligned(it) {
  return it.rows.map((r, i) => ({ r, i, t: r.dup && r.dupId && state.data.tx[r.dupId] }))
    .filter(({ r, i, t }) => t && (t.datum !== r.datum || (String(t.quelle || "").startsWith("Kontoauszug") && t.reihe !== i)
      || (isTransfer(r) && t.kategorie !== r.kategorie)));
}

function alignBooked(it) {
  const list = misaligned(it);
  for (const { r, i, t } of list) {
    t.datum = r.datum;
    // a transfer to or from an own account booked under another category before
    if (isTransfer(r) && t.kategorie !== r.kategorie) { t.kategorie = r.kategorie; t.bereich = "privat"; }
    if (String(t.quelle || "").startsWith("Kontoauszug")) { t.reihe = i; t.quelle = `Kontoauszug ${it.name}`; }
  }
  save();
  toast(`${plural(list.length, "Buchung", "Buchungen")} an den Kontoauszug angeglichen.`);
  renderQueue();
}

function statementHtml(it, head) {
  const open = it.rows.filter((r) => !r.booked), sel = open.filter((r) => r.checked).length, dups = open.filter((r) => r.dup).length;
  const k = it.konto || {};
  const meta = [k.bank, k.iban].filter(Boolean).map(esc).join(" · ");
  const rows = it.rows.map((r, i) => {
    const base = `data-q="${it.id}" data-i="${i}"`;
    const [cls, word] = QUELLE[r.quelle] || QUELLE.unsicher;
    const note = [r.dup && "Schon gebucht?", r.matchId && `Zahlung für offene Rechnung ${esc(r.matchLabel)}: wird als bezahlt markiert`].filter(Boolean).join(" · ");
    return `<div class="imp-row${r.dup ? " dup" : ""}${r.booked ? " booked" : ""}">
      <input type="checkbox" id="q-${it.id}-c-${i}" ${base} data-r="checked" ${r.checked ? "checked" : ""} ${r.booked ? "disabled" : ""} aria-label="Bewegung vom ${dmy(r.datum)} übernehmen">
      <span class="d num">${dmy(r.datum)}</span>
      <span class="imp-text"><strong>${esc(r.partner || r.text || "–")}</strong><small>${note ? note + " · " : ""}${esc(r.partner ? r.text : "")}</small></span>
      <select class="y" id="q-${it.id}-y-${i}" ${base} data-r="typ" aria-label="Art"><option value="ausgabe"${r.typ === "ausgabe" ? " selected" : ""}>Ausgabe</option><option value="einnahme"${r.typ === "einnahme" ? " selected" : ""}>Einnahme</option></select>
      <span class="k" style="display:grid;gap:2px"><input type="text" id="q-${it.id}-k-${i}" ${base} data-r="kategorie" list="${datalistId(r.bereich, r.typ)}" value="${esc(r.kategorie)}" aria-label="Kategorie"><span class="chip ${cls}" style="justify-self:start">${word}</span></span>
      <select class="b" id="q-${it.id}-b-${i}" ${base} data-r="bereich" aria-label="Bereich"><option value="geschaeft"${r.bereich === "geschaeft" ? " selected" : ""}>Geschäft</option><option value="privat"${r.bereich === "privat" ? " selected" : ""}>Privat</option></select>
      <span class="amt ${r.typ === "einnahme" ? "inc" : "exp"}">${r.typ === "einnahme" ? "+" : "−"} ${fmt(r.betragCent)}</span>
    </div>`;
  }).join("");
  return `<div class="card">${head}<span class="chip open">Kontoauszug</span></div>
    ${meta ? `<p class="small muted">${meta}</p>` : ""}
    ${it.hinweis ? `<ul class="warnings"><li>${esc(it.hinweis)}</li></ul>` : ""}
    <p class="small muted">${plural(it.rows.length, "Bewegung", "Bewegungen")}${dups ? ` · ${dups} sehen schon gebucht aus und sind abgewählt` : ""}. Die MWST steht nicht im Kontoauszug und wird mit 0 % gebucht. Für die Vorsteuer den Geschäftsbeleg einlesen.</p>
    ${misaligned(it).length ? `<div class="alert info"><span>${plural(misaligned(it).length, "gebuchte Bewegung weicht", "gebuchte Bewegungen weichen")} beim Datum, in der Reihenfolge oder als Übertrag aufs Sparkonto von diesem Auszug ab.</span><button class="btn ghost sm" data-act="q-align" data-q="${it.id}">An Auszug angleichen</button></div>` : ""}
    <div class="imp">${rows}</div>
    <div class="actions">
      <button class="btn" data-act="q-book-rows" data-q="${it.id}" ${sel && !it.busy ? "" : "disabled"}>${plural(sel, "Bewegung", "Bewegungen")} buchen</button>
      <button class="btn ghost sm" data-act="q-all" data-q="${it.id}">${sel === open.length ? "Keine auswählen" : "Alle auswählen"}</button>
      <button class="btn quiet sm" data-act="q-drop" data-q="${it.id}">Verwerfen</button>
      ${it.progress ? `<span class="msg">${esc(it.progress)}</span>` : ""}
    </div></div>`;
}

// Patch only cards that changed, so typing in one card survives progress in another.
// Replacing a card can blur the field being edited, and that field's change event renders again.
// Such a nested render waits until the current one is done.
let queueRendering = false, queueAgain = false;
function renderQueue() {
  if (queueRendering) { queueAgain = true; return; }
  queueRendering = true;
  try { renderQueueNow(); } finally { queueRendering = false; }
  if (queueAgain) { queueAgain = false; renderQueue(); }
}
function renderQueueNow() {
  const el = $("queue");
  if (!el || !state.data) return;
  ensureDatalists();
  const focusId = el.contains(document.activeElement) ? document.activeElement.id : "";
  const keep = new Set(state.queue.map((i) => i.id));
  [...el.children].forEach((n) => { if (!keep.has(n.dataset.id)) n.remove(); });
  let prev = null;
  for (const it of state.queue) {
    const html = itemHtml(it);
    let node = [...el.children].find((n) => n.dataset.id === it.id);
    if (!node) { node = document.createElement("div"); node.dataset.id = it.id; }
    if (node._html !== html) { node.innerHTML = html; node._html = html; }
    const ref = prev ? prev.nextSibling : el.firstChild;
    if (node !== ref) el.insertBefore(node, ref);
    prev = node;
  }
  if (focusId && document.activeElement?.id !== focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}
const qItem = (el) => state.queue.find((i) => i.id === el.dataset.q);

function queueInput(e) {
  const el = e.target, it = qItem(el); if (!it) return;
  // keep what is typed without re-rendering the card
  if (el.dataset.f === "betrag") it.betragText = el.value;
  else if (el.dataset.f && ["kategorie", "partner", "beleg", "notiz"].includes(el.dataset.f)) { it[el.dataset.f] = el.value; if (el.dataset.f === "kategorie") it.quelle = "gelernt"; }
  else if (el.dataset.l) { it.lohnText ||= {}; it.lohnText[el.dataset.l] = el.value; }
  else if (el.dataset.r === "kategorie") { const r = it.rows[+el.dataset.i]; r.kategorie = el.value; }
}
function queueChange(e) {
  const el = e.target, it = qItem(el); if (!it) return;
  if (el.dataset.f) {
    const f = el.dataset.f;
    if (f === "typ") it.typ = el.value;
    else if (f === "bereich") { it.bereich = el.value; if (it.bereich === "privat") it.ustSatz = 0; }
    else if (f === "datum") it.datum = el.value;
    else if (f === "betrag") { const v = parseBetrag(el.value); it.betragCent = v && v > 0 ? v : null; delete it.betragText; }
    else if (f === "ust") it.ustSatz = +el.value;
    else if (f === "status") it.status = el.value;
    else if (f === "kategorie") { it.kategorie = el.value.trim(); it.quelle = "gelernt"; }
    else it[f] = el.value;
    if (["typ", "bereich"].includes(f)) renderQueue();
  } else if (el.dataset.l) {
    const v = parseBetrag(el.value); it.lohn[el.dataset.l] = v && v > 0 ? v : 0;
  } else if (el.dataset.r) {
    const r = it.rows[+el.dataset.i], f = el.dataset.r;
    if (f === "checked") r.checked = el.checked;
    else if (f === "typ") r.typ = el.value;
    else if (f === "bereich") r.bereich = el.value;
    else if (f === "kategorie") { r.kategorie = el.value.trim() || r.kategorie; r.quelle = "gelernt"; }
    renderQueue();
  }
}

async function queueClick(act, b) {
  const it = qItem(b); if (!it) return;
  if (act === "q-drop") { state.queue.splice(state.queue.indexOf(it), 1); renderQueue(); }
  else if (act === "q-zoom") window.open(it.preview, "_blank");
  else if (act === "q-struct") download("kassenbuch-aufbau-anonym.txt", new Blob([it.struct], { type: "text/plain" }));
  else if (act === "q-all") {
    const open = it.rows.filter((r) => !r.booked), all = open.every((r) => r.checked);
    open.forEach((r) => { r.checked = !all; }); renderQueue();
  } else if (act === "q-book") bookDoc(it);
  else if (act === "q-book-rows") bookRows(it);
  else if (act === "q-align") alignBooked(it);
}

async function archive(it) {
  if (it.fileId !== undefined) return it.fileId || undefined;
  if (!it.file) { it.fileId = ""; return undefined; }
  try { it.fileId = uid(); await vault.putFile(it.fileId, it.file, it.file.name); return it.fileId; }
  catch (e) { it.fileId = ""; toast("Das Original konnte nicht gespeichert werden: " + e.message); return undefined; }
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

async function bookDoc(it) {
  const msg = $(`q-${it.id}-msg`);
  // pick up anything still being typed
  if (it.betragText !== undefined) { const v = parseBetrag(it.betragText); it.betragCent = v && v > 0 ? v : null; }
  if (it.lohnText) for (const [k, v] of Object.entries(it.lohnText)) { const n = parseBetrag(v); it.lohn[k] = n && n > 0 ? n : 0; }
  if (!it.datum) return (msg.textContent = "Bitte ein Datum angeben.");
  if (!it.betragCent) return (msg.textContent = it.waehrung !== "CHF" ? "Bitte den Betrag in CHF eintragen." : "Bitte einen Betrag angeben.");
  if (!it.kategorie?.trim()) return (msg.textContent = "Bitte eine Kategorie angeben.");
  const fileId = await archive(it);
  const t = clean({
    typ: it.typ, bereich: it.bereich, datum: it.datum, betragCent: it.betragCent, ustSatz: it.bereich === "privat" ? 0 : it.ustSatz || 0,
    kategorie: it.kategorie.trim(), partner: it.partner?.trim(), beleg: it.beleg?.trim(), status: it.status || "bezahlt", notiz: it.notiz?.trim(),
    erstellt: new Date().toISOString(), quelle: it.name, lohn: it.kind === "lohn" ? it.lohn : undefined, belegFile: fileId,
  });
  if (!t.ustSatz) t.ustSatz = 0;
  state.data.tx[uid()] = t;
  train(state.data.learn, t);
  save();
  it.state = "booked"; it.bookedText = `Gebucht: ${t.partner || t.kategorie}, ${fmt(t.betragCent)} am ${dmy(t.datum)}.`;
  renderQueue();
}

async function bookRows(it) {
  const sel = it.rows.filter((r) => r.checked && !r.booked);
  if (!sel.length) return;
  it.busy = true;
  const fileId = await archive(it);
  let booked = 0, paid = 0;
  for (const r of sel) {
    const reihe = it.rows.indexOf(r);
    const inv = r.matchId && state.data.tx[r.matchId];
    if (inv) { inv.status = "bezahlt"; inv.bezahltAm = r.datum; paid++; }
    else {
      const t = clean({
        typ: r.typ, bereich: r.bereich, datum: r.datum, betragCent: r.betragCent, ustSatz: 0, kategorie: r.kategorie || defaultKat(r.typ, r.bereich),
        partner: r.partner, notiz: r.text.slice(0, 80), status: "bezahlt", erstellt: new Date().toISOString(), quelle: `Kontoauszug ${it.name}`, belegFile: fileId,
      });
      t.reihe = reihe; // position in the statement: keeps bookings of the same day in its order
      t.ustSatz = 0;
      state.data.tx[uid()] = t;
      train(state.data.learn, { ...t, text: r.text });
      booked++;
    }
    r.booked = true; r.checked = false;
  }
  save();
  it.busy = false;
  if (it.rows.every((r) => r.booked || !r.checked) && !it.rows.some((r) => !r.booked && !r.dup)) {
    it.state = "booked";
    it.bookedText = `${plural(booked, "Bewegung", "Bewegungen")} gebucht${paid ? `, ${plural(paid, "Rechnung", "Rechnungen")} als bezahlt markiert` : ""}.`;
  } else it.progress = `${plural(booked, "Bewegung", "Bewegungen")} gebucht${paid ? `, ${plural(paid, "Rechnung", "Rechnungen")} als bezahlt markiert` : ""}.`;
  renderQueue();
}

// =====================================================================
// Buchungen
// =====================================================================
// Oldest first, like a bank statement: by date, then by the position in the statement it came
// from, then by the time it was entered.
function byStatementOrder(a, b) {
  return a.datum.localeCompare(b.datum)
    || (a.quelle === b.quelle && a.reihe != null && b.reihe != null ? a.reihe - b.reihe : 0)
    || String(a.erstellt).localeCompare(String(b.erstellt));
}

function renderBookings() {
  const r = range();
  const all = visibleTx();
  const base = state.filter === "offen" ? all : all.filter((t) => inRange(t, r));
  const q = state.q.toLowerCase();
  const list = base.filter((t) => {
    if (state.filter === "einnahme" && t.typ !== "einnahme") return false;
    if (state.filter === "ausgabe" && t.typ !== "ausgabe") return false;
    if (state.filter === "offen" && t.status !== "offen") return false;
    if (q && ![t.partner, t.kategorie, t.beleg, t.notiz, t.quelle].join(" ").toLowerCase().includes(q)) return false;
    return true;
  }).sort(byStatementOrder);
  if (state.sort === "neu") list.reverse();
  const hasFiles = list.some((t) => t.belegFile);
  const filters = { alle: "Alle", einnahme: "Einnahmen", ausgabe: "Ausgaben", offen: "Offen" };
  $("view").innerHTML = `
    <div class="pagehead"><h1>Buchungen</h1>${controlsHtml()}</div>
    <section class="panel">
      <div class="filters">
        <input type="search" id="search" placeholder="Suchen nach Partner, Kategorie, Beleg, Notiz" value="${esc(state.q)}" aria-label="Buchungen durchsuchen">
        <div class="seg" role="group" aria-label="Filter">${Object.entries(filters).map(([k, v]) => `<button type="button" data-act="filter" data-v="${k}" aria-pressed="${state.filter === k}">${v}</button>`).join("")}</div>
        <div class="seg" role="group" aria-label="Reihenfolge">${Object.entries({ auszug: "Wie Kontoauszug", neu: "Neueste zuerst" }).map(([k, v]) => `<button type="button" data-act="sort" data-v="${k}" aria-pressed="${state.sort === k}">${v}</button>`).join("")}</div>
      </div>
      <div class="actions">
        <button class="btn sm" data-act="new-entry">Neue Buchung</button>
        <button class="btn ghost sm" data-act="export-csv">CSV für Excel / Treuhand</button>
        <button class="btn ghost sm" data-act="export-zip" ${hasFiles ? "" : "disabled"} title="${hasFiles ? "" : "In dieser Auswahl gibt es keine gespeicherten Belege"}">Belege als ZIP</button>
        <span class="small muted">${plural(list.length, "Buchung", "Buchungen")} ${state.filter === "offen" ? "aus allen Zeiträumen" : "in " + esc(r.label)}</span>
      </div>
      <div class="list" id="list">${list.length ? list.map(rowHtml).join("") : `<div class="empty">${Object.keys(state.data.tx).length ? (state.q ? `Keine passenden Buchungen in ${esc(r.label)}.` : `<span>Keine Buchungen in ${esc(r.label)}${state.bereich === "alle" ? "" : ` im Bereich ${esc(BEREICH_NAME[state.bereich])}`}.</span>${elsewhereHtml()}`) : `<b>Noch keine Buchungen</b><span>Lies unter „Erfassen“ ein Dokument ein oder erfasse eine Buchung von Hand.</span><button class="btn sm" data-act="goto" data-v="erfassen">Zum Erfassen</button>`}</div>`}</div>
    </section>`;
  $("search").addEventListener("input", debounce((e) => { state.q = e.target.value; renderBookings(); const s = $("search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 200));
  setHandlers((act, b) => {
    if (act === "filter") { state.filter = b.dataset.v; renderBookings(); }
    else if (act === "sort") { state.sort = prefs.sort = b.dataset.v; savePrefs(); renderBookings(); }
    else if (act === "edit") openEntry(b.dataset.id);
    else if (act === "export-csv") exportCsv(list, r);
    else if (act === "export-zip") exportZip(list, r, b);
  });
}

function rowHtml(t) {
  const late = t.typ === "einnahme" && t.status === "offen" && daysBetween(t.datum, todayIso()) > ZAHLUNGSFRIST;
  const chips = [
    t.status === "offen" ? `<span class="chip ${late ? "late" : "open"}">${late ? "überfällig" : "offen"}</span>` : "",
    state.bereich === "alle" && bereichOf(t) === "privat" ? `<span class="chip neutral">Privat</span>` : "",
    t.wiederkehrend ? `<span class="chip neutral">wiederkehrend</span>` : "",
    t.belegFile ? `<span class="chip neutral">Beleg</span>` : "",
  ].join("");
  const sub = [t.kategorie, t.beleg, t.notiz].filter(Boolean).map(esc).join(" · ");
  return `<button type="button" class="row" data-act="edit" data-id="${esc(t.id)}">
    <span class="date num">${dmy(t.datum)}</span>
    <span class="who"><strong>${esc(t.partner || t.kategorie)}</strong><small>${sub}</small></span>
    <span class="st">${chips}</span>
    <span class="amt ${t.typ === "einnahme" ? "inc" : "exp"}">${t.typ === "einnahme" ? "+" : "−"} ${fmt(t.betragCent)}<small>${t.ustSatz ? `${t.ustSatz} % MWST` : "ohne MWST"}</small></span>
  </button>`;
}

// ---------- export ----------
function buildCsv(rows, fileNames) {
  const n = (c) => (c / 100).toFixed(2);
  // a leading = + - @ would make Excel evaluate imported bank text as a formula
  const q = (v) => `"${String(v ?? "").replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""')}"`;
  const head = ["Datum", "Bereich", "Art", "Beleg-Nr", "Partner", "Konto KMU", "Kategorie", "Netto CHF", "MWST-Satz", "MWST CHF", "Brutto CHF", "Status", "Notiz"];
  if (fileNames) head.push("Belegdatei");
  const lines = [head.join(";")];
  for (const t of [...rows].sort((a, b) => a.datum.localeCompare(b.datum))) {
    const v = vatOf(t.betragCent, t.ustSatz || 0);
    const cols = [dmy(t.datum), bereichOf(t) === "privat" ? "Privat" : "Geschäft", t.typ === "einnahme" ? "Einnahme" : "Ausgabe", q(t.beleg), q(t.partner),
      konto(t.kategorie), q(t.kategorie), n(t.betragCent - v), (t.ustSatz || 0) + " %", n(v), n(t.betragCent), t.status, q(t.notiz)];
    if (fileNames) cols.push(q(fileNames.get(t.belegFile) ? "Belege/" + fileNames.get(t.belegFile) : ""));
    lines.push(cols.join(";"));
  }
  return "﻿" + lines.join("\r\n");
}
const exportLabel = (r) => `${state.bereich === "alle" ? "" : state.bereich + "-"}${state.filter === "offen" ? "offen" : r.label.replace(/\s+/g, "-").toLowerCase()}`;
function exportCsv(list, r) {
  if (!list.length) return toast("Keine Buchungen in dieser Auswahl.");
  download(`kassenbuch-${exportLabel(r)}.csv`, new Blob([buildCsv(list)], { type: "text/csv" })).then((res) => savedNote(res, "CSV"));
}
const safeName = (v) => String(v || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
function fileBase(t) {
  if (/^Kontoauszug /.test(t.quelle || "")) return "Kontoauszug_" + safeName(t.quelle.slice(12).replace(/\.[a-z0-9]+$/i, ""));
  return [t.datum, safeName(t.partner || t.kategorie), (t.betragCent / 100).toFixed(2)].join("_");
}
const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
async function exportZip(list, r, btn) {
  const ids = [...new Set(list.filter((t) => t.belegFile).map((t) => t.belegFile))];
  if (!ids.length) return toast("In dieser Auswahl gibt es keine gespeicherten Belege.");
  btn.disabled = true;
  try {
    await loadScript("vendor/jszip.min.js");
    const zip = new window.JSZip(), names = new Map(), used = new Set();
    for (const [i, id] of ids.entries()) {
      btn.textContent = `Beleg ${i + 1} von ${ids.length} …`;
      const f = await vault.getFile(id);
      if (!f) continue;
      const base = fileBase(list.find((t) => t.belegFile === id)), ext = EXT[f.blob.type] || (f.name.split(".").pop() || "pdf");
      let name = `${base}.${ext}`, k = 2;
      while (used.has(name)) name = `${base}_${k++}.${ext}`;
      used.add(name); names.set(id, name);
      zip.file("Belege/" + name, f.blob);
    }
    zip.file("Buchungen.csv", buildCsv(list, names));
    savedNote(await download(`belege-${exportLabel(r)}.zip`, await zip.generateAsync({ type: "blob" })), `ZIP mit ${plural(names.size, "Beleg", "Belegen")} und Buchungsliste`);
  } catch (e) { toast("Das ZIP konnte nicht erstellt werden: " + e.message); }
  finally { btn.disabled = false; btn.textContent = "Belege als ZIP"; }
}

// ---------- entry dialog ----------
const dlg = $("dlg-entry");
dlg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) dlg.close(); });
$("e-ust").innerHTML = rateOptions(8.1);
$("r-ust").innerHTML = rateOptions(8.1);
const eTyp = () => document.querySelector('input[name="e-typ"]:checked').value;
function syncEntry() {
  const t = eTyp(), priv = $("e-bereich").value === "privat";
  ensureDatalists();
  $("e-kat").setAttribute("list", datalistId(priv ? "privat" : "geschaeft", t));
  $("e-partner-label").textContent = t === "einnahme" ? (priv ? "Arbeitgeber / Absender" : "Kunde") : "Lieferant / Empfänger";
  $("e-ust").disabled = priv;
  if (priv) $("e-ust").value = "0";
  const b = parseBetrag($("e-betrag").value), rate = +$("e-ust").value;
  $("e-calc").textContent = b && b > 0 ? `Netto ${fmt(b - vatOf(b, rate))} · MWST ${fmt(vatOf(b, rate))}` : "";
}
$("entry").addEventListener("input", syncEntry);
$("entry").addEventListener("change", (e) => {
  if (e.target.id === "e-bereich" && e.target.value === "geschaeft" && $("e-ust").value === "0") $("e-ust").value = "8.1";
  syncEntry();
});

function openEntry(id) {
  const t = id ? state.data.tx[id] : null;
  state.editing = id;
  $("entry").reset();
  $("entry-title").textContent = t ? "Buchung bearbeiten" : "Neue Buchung";
  (t?.typ === "einnahme" ? $("e-typ-ein") : $("e-typ-aus")).checked = true;
  $("e-bereich").value = t ? bereichOf(t) : state.bereich === "privat" ? "privat" : "geschaeft";
  $("e-datum").value = t?.datum || todayIso();
  $("e-betrag").value = t ? amountText(t.betragCent) : "";
  $("e-ust").value = String(t ? (RATES.includes(t.ustSatz) ? t.ustSatz : 0) : $("e-bereich").value === "privat" ? 0 : 8.1);
  $("e-kat").value = t?.kategorie || "";
  $("e-partner").value = t?.partner || "";
  $("e-beleg").value = t?.beleg || "";
  $("e-status").value = t?.status || "bezahlt";
  $("e-notiz").value = t?.notiz || "";
  $("e-msg").textContent = "";
  $("e-delete").hidden = !t; $("e-delete").textContent = "Löschen"; delete $("e-delete").dataset.armed;
  $("e-file-open").hidden = $("e-file-save").hidden = !t?.belegFile;
  const l = t?.lohn;
  $("e-lohn").hidden = !l;
  if (l) {
    const row = (label, v) => `<div><span>${label}</span><span class="num">${fmt(v || 0)}</span></div>`;
    $("e-lohn").innerHTML = row("Bruttolohn", l.bruttolohn) + row("AHV/IV/EO", l.ahvIvEo) + row("ALV", l.alv) + row("BVG", l.bvg) + row("NBU/KTG", l.nbuKtg)
      + (l.quellensteuer ? row("Quellensteuer", l.quellensteuer) : "") + (l.uebrigeAbzuege ? row("Übrige Abzüge", l.uebrigeAbzuege) : "") + row("Nettolohn", l.nettolohn);
  }
  syncEntry();
  dlg.showModal();
  setTimeout(() => $(t ? "e-betrag" : "e-betrag").focus(), 30);
}

$("entry").addEventListener("submit", (e) => {
  e.preventDefault();
  const betragCent = parseBetrag($("e-betrag").value), m = $("e-msg");
  if (!$("e-datum").value) return (m.textContent = "Bitte ein Datum wählen.");
  if (!betragCent || betragCent <= 0) return (m.textContent = "Bitte einen Betrag wie 1'081.00 eingeben.");
  if (!$("e-kat").value.trim()) return (m.textContent = "Bitte eine Kategorie angeben.");
  const prev = state.editing ? state.data.tx[state.editing] : {};
  const bereich = $("e-bereich").value;
  const t = {
    ...prev,
    typ: eTyp(), bereich, datum: $("e-datum").value, betragCent, ustSatz: bereich === "privat" ? 0 : +$("e-ust").value,
    kategorie: $("e-kat").value.trim(), partner: $("e-partner").value.trim(), beleg: $("e-beleg").value.trim(),
    status: $("e-status").value, notiz: $("e-notiz").value.trim(), erstellt: prev.erstellt || new Date().toISOString(),
  };
  if (t.status === "bezahlt") delete t.bezahltAm;
  const id = state.editing || uid();
  state.data.tx[id] = t;
  train(state.data.learn, t);
  save();
  dlg.close();
  toast(state.editing ? "Änderungen gespeichert." : "Buchung hinzugefügt.");
  render();
});

$("e-delete").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Wirklich löschen?"; return; }
  const id = state.editing, t = state.data.tx[id];
  delete state.data.tx[id];
  if (t?.belegFile && !Object.values(state.data.tx).some((x) => x.belegFile === t.belegFile)) await vault.deleteFile(t.belegFile).catch(() => {});
  save(); dlg.close(); toast("Buchung gelöscht."); render();
});
async function entryFile(saveIt) {
  const t = state.data.tx[state.editing]; if (!t?.belegFile) return;
  const f = await vault.getFile(t.belegFile);
  if (!f) return toast("Der Beleg wurde nicht gefunden.");
  const ext = EXT[f.blob.type] || (f.name.split(".").pop() || "pdf");
  if (saveIt) savedNote(await download(`${fileBase(t)}.${ext}`, f.blob), "Beleg");
  else { const url = URL.createObjectURL(f.blob); window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
$("e-file-open").addEventListener("click", () => entryFile(false));
$("e-file-save").addEventListener("click", () => entryFile(true));

// =====================================================================
// Sparziel: goal, progress, what is still free this month, where the money goes, budget plan
// =====================================================================
const ymLabel = (ym) => `${MONTHS_LONG[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const ymShort = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;

function goalForm(g) {
  const nowYm = todayIso().slice(0, 7);
  const starts = Array.from({ length: 25 }, (_, i) => addYm(nowYm, i - 12));
  return `<form id="goal-form" class="fields" novalidate>
      <div class="field"><label for="g-betrag">Sparziel (CHF)</label><input id="g-betrag" type="text" inputmode="decimal" value="${amountText(g ? g.betrag : 1500000)}"></div>
      <div class="field"><label for="g-start">Ab Monat</label><select id="g-start">${starts.map((ym) => `<option value="${ym}"${ym === (g?.start || nowYm) ? " selected" : ""}>${ymLabel(ym)}</option>`).join("")}</select></div>
      <div class="field"><label for="g-monate">Dauer</label><select id="g-monate">${[6, 12, 18, 24, 36].map((n) => `<option value="${n}"${n === (g?.monate || 12) ? " selected" : ""}>${n} Monate</option>`).join("")}</select></div>
      <div class="field" style="align-self:end"><button class="btn" type="submit">${g ? "Ziel speichern" : "Ziel festlegen"}</button></div>
      <p class="msg err w4" id="g-msg" role="alert"></p>
    </form>`;
}

function goalLine(g, st) {
  if (!st.started) return { cls: "", text: `Das Ziel startet im ${ymLabel(g.start)}.` };
  if (st.reached) return { cls: "inc", text: `Ziel erreicht: ${fmt0(st.savedTotal)} gespart.` };
  if (st.ended) return { cls: "exp", text: `Die Zeit ist um: ${fmt0(st.savedTotal)} von ${fmt0(g.betrag)} gespart.` };
  if (!st.fullMonths) return { cls: "", text: `Der erste Monat läuft. Ziel: Ende ${ymLabel(g.start)} sollen ${fmt0(st.target)} übrig sein.` };
  return st.diff >= 0
    ? { cls: "inc", text: `Auf Kurs: ${fmt0(st.diff)} vor dem Plan.` }
    : { cls: "exp", text: `${fmt0(-st.diff)} hinter dem Plan. Bis Ende ${ymLabel(st.endYm)} brauchst du jetzt ${fmt0(st.needPerMonth)} pro Monat.` };
}

function goalChart(st) {
  const nowYm = todayIso().slice(0, 7);
  const vals = st.months.map((m) => (m.ym <= nowYm ? m.saved : null));
  const hi = Math.max(st.target, ...vals.filter((v) => v != null)), lo = Math.min(0, ...vals.filter((v) => v != null));
  const max = niceMax(hi), min = lo < 0 ? -niceMax(-lo) / 2 : 0;
  const W = 640, H = 220, L = 50, R = 8, T = 10, B = 26, n = st.months.length, cw = (W - L - R) / n, bw = Math.min(26, cw * 0.6);
  const ys = (v) => T + (H - T - B) * (max - v) / (max - min);
  const axis = (cent) => { const e = cent / 100; return Math.abs(e) >= 1000 ? (e / 1000).toLocaleString("de-CH", { maximumFractionDigits: 1 }) + "k" : String(Math.round(e)); };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gespart pro Monat im Vergleich zum Plan">`;
  for (let i = 0; i <= 4; i++) { const v = min + ((max - min) / 4) * i, yy = ys(v); svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="axis" x="${L - 8}" y="${yy + 4}" text-anchor="end">${axis(v)}</text>`; }
  st.months.forEach((m, i) => {
    const cx = L + cw * i + cw / 2, v = vals[i];
    if (v != null) {
      const cls = v >= m.target ? "b-inc" : v > 0 ? "b-warn" : "b-exp";
      svg += `<rect class="${cls}${m.ym === nowYm ? " dim" : ""}" x="${cx - bw / 2}" y="${Math.min(ys(v), ys(0))}" width="${bw}" height="${Math.abs(ys(0) - ys(v))}" rx="2"><title>${ymLabel(m.ym)}: ${fmt(v)} gespart (Plan ${fmt0(m.target)})${m.ym === nowYm ? ", Monat läuft noch" : ""}</title></rect>`;
    } else svg += `<rect class="b-future" x="${cx - bw / 2}" y="${ys(m.target)}" width="${bw}" height="${ys(0) - ys(m.target)}" rx="2"><title>${ymLabel(m.ym)}: Plan ${fmt0(m.target)}</title></rect>`;
    if (n <= 12 || i % 2 === 0) svg += `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${n <= 12 ? MONTHS[+m.ym.slice(5, 7) - 1] : ymShort(m.ym)}</text>`;
  });
  svg += `<line class="target" x1="${L}" x2="${W - R}" y1="${ys(st.target)}" y2="${ys(st.target)}"/>`;
  return svg + "</svg>";
}

function analysisHtml(an) {
  if (!an.n) return `<section class="panel"><h2>Wohin dein Geld geht</h2><p class="muted">Noch keine Buchungen. Lies unter „Erfassen“ deine Kontoauszüge der letzten Monate ein, dann zeigt die App hier, wo du sparen kannst.</p><div class="actions"><button class="btn sm" data-act="goto" data-v="erfassen">Kontoauszug einlesen</button></div></section>`;
  const period = an.months.slice().reverse().map(ymLabel).join(", ");
  const top = Math.max(...an.cats.map((c) => c.avg), 1);
  const cats = an.cats.map((c) => `<div class="cat"><div class="cat-top"><span>${esc(c.kategorie)} ${c.fix ? '<span class="chip neutral">fix</span>' : ""}</span><span class="num">${fmt(c.avg)}</span></div>
      <div class="bar${c.fix ? " fixbar" : ""}"><div style="width:${((c.avg / top) * 100).toFixed(1)}%"></div></div>
      ${c.fix ? "" : `<div class="hint">20 % weniger = ${fmt0(c.avg * 0.2 * 12)} im Jahr</div>`}</div>`).join("");
  const abos = an.abos.length ? `<div class="list-plain">${an.abos.map((a) => `<div class="lp-row"><span><b>${esc(a.name)}</b><small>${esc(a.kategorie)} · in ${a.monate} Monaten${a.fix ? " · Fixkosten" : ""}</small></span><span class="num">${fmt(a.betrag)} / Monat<small>${fmt0(a.proJahr)} im Jahr</small></span></div>`).join("")}</div>`
    : `<p class="muted small">Noch keine wiederkehrenden Abbuchungen erkannt. Dafür braucht es Buchungen aus mindestens zwei Monaten.</p>`;
  const topList = `<div class="list-plain">${an.top.map((t) => `<div class="lp-row"><span><b>${esc(t.name)}</b><small>${plural(t.count, "Zahlung", "Zahlungen")}</small></span><span class="num">${fmt(t.avg)} / Monat</span></div>`).join("")}</div>`;
  return `<section class="panel"><div class="panel-head"><h2>Wohin dein Geld geht</h2><span class="muted small">Durchschnitt pro Monat · ${esc(period)} · Geschäft und Privat</span></div>
      <div class="kpis kpis3">
        <div class="kpi"><span class="label">Einnahmen</span><span class="val inc">${fmt0(an.incAvg)}</span><span class="sub">pro Monat</span></div>
        <div class="kpi"><span class="label">Ausgaben</span><span class="val exp">${fmt0(an.expAvg)}</span><span class="sub">ohne Sparkonto, 3a und Anlagen</span></div>
        <div class="kpi"><span class="label">Bleibt übrig</span><span class="val ${an.savedAvg >= 0 ? "inc" : "exp"}">${fmt0(an.savedAvg)}</span><span class="sub">${an.incAvg > 0 ? `Sparquote ${Math.round((an.savedAvg / an.incAvg) * 100)} %` : "keine Einnahmen erfasst"}</span></div>
      </div>
      <div class="grid2">
        <div><h3>Ausgaben nach Kategorie</h3><div class="cats">${cats || '<p class="muted">Keine Ausgaben.</p>'}</div></div>
        <div style="display:grid;gap:18px;align-content:start">
          <div><h3>Abos und regelmässige Zahlungen</h3>${abos}</div>
          <div><h3>Grösste Ausgabenposten</h3>${topList}</div>
          <div><h3>Kleinbeträge</h3><p class="small">${an.small.count ? `Rund <b>${an.small.count} Zahlungen unter CHF 20</b> im Monat, zusammen <b>${fmt(an.small.avg)}</b>, also ${fmt0(an.small.avg * 12)} im Jahr.` : "Kaum Zahlungen unter CHF 20."}</p></div>
        </div>
      </div></section>`;
}

// The savings plan: every variable category (and every category that already has a budget) with
// its average so far, the suggested budget and your own budget, editable right in the table.
function planRows(plan, an) {
  const set = state.data.settings.budgets || {};
  const sug = new Map(plan.items.map((i) => [i.kategorie, i.budget]));
  const avg = new Map(an.cats.map((c) => [c.kategorie, c.avg]));
  const keys = [...new Set([...an.cats.filter((c) => !c.fix && c.avg > 0).map((c) => c.kategorie), ...Object.keys(set)])];
  return keys.map((k) => ({ kategorie: k, avg: avg.get(k) || 0, vorschlag: sug.get(k), budget: set[k], fix: an.cats.find((c) => c.kategorie === k)?.fix }))
    .sort((x, y) => y.avg - x.avg || x.kategorie.localeCompare(y.kategorie, "de"));
}

function planHtml(plan, st, an) {
  if (!an.n) return "";
  const rate = st.started ? st.needPerMonth : st.target;
  const rows = planRows(plan, an);
  const withBudget = rows.filter((r) => r.budget != null);
  const cut = withBudget.reduce((a, r) => a + Math.max(0, r.avg - r.budget), 0);
  const open = Math.max(0, plan.gap - cut);
  const sugMissing = plan.items.some((i) => (state.data.settings.budgets || {})[i.kategorie] !== i.budget);
  const intro = plan.gap
    ? `Bisher bleiben dir im Schnitt <b>${fmt0(an.savedAvg)}</b> im Monat. Für dein Ziel fehlen <b>${fmt0(plan.gap)}</b> pro Monat.${plan.items.length ? ` Der Vorschlag senkt jede variable Kategorie um ${Math.round(plan.share * 100)} %; du kannst jedes Budget selbst anpassen.` : ""}`
    : `Mit deinem bisherigen Durchschnitt von <b>${fmt0(an.savedAvg)}</b> pro Monat erreichst du das Ziel. Budgets helfen, dass es so bleibt.`;
  const status = !withBudget.length ? ""
    : plan.gap ? (open ? `<div class="alert"><span>Mit deinen Budgets sparst du <strong>${fmt0(cut)}</strong> pro Monat. Für das Ziel fehlen noch <strong>${fmt0(open)}</strong> pro Monat${plan.rest && open >= plan.rest ? ": das geht nur über Fixkosten, mehr Einnahmen oder einen längeren Zeitraum" : ""}.</span></div>`
      : `<p class="msg ok">Mit deinen Budgets sparst du ${fmt0(cut)} pro Monat. Das reicht für dein Ziel von ${fmt0(rate)} pro Monat.</p>`)
    : `<p class="msg ok">Deine Budgets halten deine Ausgaben auf dem jetzigen Niveau.</p>`;
  return `<section class="panel"><div class="panel-head"><h2>Dein Sparplan</h2><span class="muted small">Ziel: ${fmt0(rate)} pro Monat sparen</span></div>
      <p>${intro}</p>
      ${rows.length ? `<div class="table-wrap"><table class="plan"><thead><tr><th>Kategorie</th><th class="r">Bisher Ø</th><th class="r">Dein Budget / Monat</th><th class="r">Ersparnis</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr><td><label for="p-b-${i}">${esc(r.kategorie)}</label>${r.fix ? ' <span class="chip neutral">fix</span>' : ""}${r.vorschlag != null ? `<small class="muted" style="display:block">Vorschlag ${fmt0(r.vorschlag)}</small>` : ""}</td>
          <td class="r num">${r.avg ? fmt0(r.avg) : "–"}</td>
          <td class="r"><input type="text" inputmode="decimal" class="plan-edit num" id="p-b-${i}" data-k="${esc(r.kategorie)}" value="${r.budget != null ? amountText(r.budget) : ""}" placeholder="${r.vorschlag != null ? amountText(r.vorschlag) : "kein Budget"}"></td>
          <td class="r num ${r.budget != null && r.avg > r.budget ? "inc" : ""}">${r.budget != null && r.avg ? fmt0(r.avg - r.budget) : "–"}</td></tr>`).join("")}
        <tr class="sum"><td>Total pro Monat</td><td class="r num">${fmt0(rows.reduce((a, r) => a + r.avg, 0))}</td><td class="r num"><b>${withBudget.length ? fmt0(withBudget.reduce((a, r) => a + r.budget, 0)) : "–"}</b></td><td class="r num inc">${withBudget.length ? fmt0(cut) : "–"}</td></tr>
      </tbody></table></div>` : ""}
      ${status}
      <div class="actions">${plan.items.length && sugMissing ? `<button class="btn" data-act="plan-apply">${withBudget.length ? "Alle Vorschläge übernehmen" : "Vorschläge übernehmen"}</button>` : ""}<span class="small muted">Betrag eintippen und das Feld verlassen: Das Budget ist sofort gespeichert. Feld leeren entfernt das Budget.</span></div>
    </section>`;
}

function renderSavings() {
  const s = state.data.settings, g = s.sparziel, today = todayIso();
  const txs = allTx(), opts = goalOpts(), an = analyze(txs, today, opts);
  if (!g || state.editGoal) {
    $("view").innerHTML = `<div class="pagehead"><h1>Sparziel</h1></div>
      <section class="panel"><h2>${g ? "Sparziel ändern" : "Sparziel festlegen"}</h2>
        <p class="muted">Wie viel willst du in welcher Zeit sparen? Die App rechnet aus, wie viel du dafür jeden Monat zur Seite legen musst, zeigt dir, was du diesen Monat noch ausgeben kannst, und schlägt passende Budgets vor. Überträge aufs Sparkonto und Säule 3a zählen als gespart; Anlagen (E-Trading) werden separat gezeigt.</p>
        ${goalForm(g)}
        ${g ? `<div class="actions"><button class="btn quiet sm" type="button" data-act="goal-cancel">Abbrechen</button><button class="btn ghost danger sm" type="button" data-act="goal-del">Ziel löschen</button></div>` : ""}
      </section>
      ${analysisHtml(an)}`;
    $("goal-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const betrag = parseBetrag($("g-betrag").value);
      if (!betrag || betrag <= 0) { $("g-msg").textContent = "Bitte einen Betrag eingeben, z. B. 15'000."; return; }
      s.sparziel = { betrag: Math.abs(betrag), start: $("g-start").value, monate: +$("g-monate").value };
      state.editGoal = false; save(); renderSavings();
    });
    setHandlers((act) => {
      if (act === "goal-cancel") { state.editGoal = false; renderSavings(); }
      else if (act === "goal-del" && confirm("Sparziel löschen? Deine Buchungen bleiben erhalten.")) { delete s.sparziel; state.editGoal = false; save(); renderSavings(); }
    });
    return;
  }

  const st = goalStatus(g, txs, today, opts);
  const rate = st.started ? st.needPerMonth : st.target;
  const plan = budgetPlan(an, rate);
  const tm = thisMonth(txs, today, rate, an.incAvg, opts);
  const line = goalLine(g, st);
  const pct = Math.max(0, Math.min(100, st.pct * 100)), sollPct = Math.min(100, (st.soll / g.betrag) * 100);
  const tipList = tips(an, an.abos);
  $("view").innerHTML = `
    <div class="pagehead"><h1>Sparziel</h1><button class="btn ghost sm" data-act="goal-edit">Ziel ändern</button></div>
    <section class="panel goal">
      <div class="panel-head"><h2>${fmt0(g.betrag)} sparen bis Ende ${ymLabel(st.endYm)}</h2><span class="muted small">${ymLabel(g.start)} bis ${ymLabel(st.endYm)} · Plan ${fmt0(st.target)} pro Monat</span></div>
      <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Fortschritt Sparziel">
        <div class="fill${st.diff < 0 && st.started ? " behind" : ""}" style="width:${pct.toFixed(1)}%"></div>
        ${st.started && !st.ended && st.fullMonths ? `<div class="mark" style="left:${sollPct.toFixed(1)}%" title="Plan nach ${plural(st.fullMonths, "Monat", "Monaten")}: ${fmt0(st.soll)}"></div>` : ""}
      </div>
      <div class="goal-legend"><span><b class="num">${fmt(st.savedTotal)}</b> gespart · ${Math.round(st.pct * 100)} %</span>${st.started && !st.ended && st.fullMonths ? `<span class="muted">Plan nach ${plural(st.fullMonths, "Monat", "Monaten")}: ${fmt0(st.soll)}</span>` : ""}</div>
      <p class="goal-status ${line.cls}"><b>${esc(line.text)}</b></p>
      ${st.sparTotal || st.anlTotal ? `<p class="small muted" style="margin:0">Seit ${ymLabel(g.start)}: ${st.sparTotal >= 0 ? `${fmt0(st.sparTotal)} aufs Sparkonto` : `${fmt0(-st.sparTotal)} vom Sparkonto genommen`}${st.anlTotal ? ` · ${st.anlTotal > 0 ? `${fmt0(st.anlTotal)} in Anlagen (E-Trading)` : `${fmt0(-st.anlTotal)} aus Anlagen (E-Trading)`}${opts.anlagen ? ", zählt mit" : ", zählt nicht zum Sparziel"}` : ""}</p>` : ""}
      <label class="check small"><input type="checkbox" id="g-anlagen"${opts.anlagen ? " checked" : ""}> Anlagen (E-Trading) zum Sparziel zählen</label>
    </section>
    <section class="kpis" aria-label="Sparziel in Zahlen">
      <div class="kpi"><span class="label">Pro Monat nötig</span><span class="val">${fmt0(rate)}</span><span class="sub">${st.started ? `noch ${plural(st.remainingMonths, "Monat", "Monate")}` : `ab ${ymLabel(g.start)}`}</span></div>
      <div class="kpi"><span class="label">Bisher pro Monat</span><span class="val ${an.savedAvg >= rate ? "inc" : "exp"}">${an.n ? fmt0(an.savedAvg) : "–"}</span><span class="sub">${an.n ? `Durchschnitt ${plural(an.n, "Monat", "Monate")}` : "noch keine Buchungen"}</span></div>
      <div class="kpi"><span class="label">Prognose</span><span class="val ${st.prognose == null ? "" : st.prognose >= g.betrag ? "inc" : "exp"}">${st.prognose == null ? "–" : fmt0(st.prognose)}</span><span class="sub">${st.prognose == null ? "nach dem ersten vollen Monat" : "bei gleichem Tempo"}</span></div>
      <div class="kpi"><span class="label">Diesen Monat noch frei</span><span class="val ${tm.free >= 0 ? "inc" : "exp"}">${fmt0(tm.free)}</span><span class="sub">${tm.free > 0 ? `${fmt0(tm.perDay)} pro Tag · ${plural(tm.daysLeft, "Tag", "Tage")}` : "Sparrate in Gefahr"}</span></div>
    </section>
    <div class="grid2">
      <section class="panel"><div class="panel-head"><h2>Gespart pro Monat</h2><div class="legend"><span><i style="background:var(--inc)"></i>Plan erreicht</span><span><i style="background:var(--warn)"></i>darunter</span><span><i style="background:var(--exp)"></i>Minus</span></div></div>
        <div class="chart">${goalChart(st)}</div>
        <p class="small muted">Gespart = Einnahmen minus Ausgaben. Überträge aufs Sparkonto und Säule 3a zählen als gespart, Anlagen (E-Trading) ${opts.anlagen ? "ebenfalls" : "nicht"}.</p></section>
      <section class="panel"><h2>Diesen Monat</h2>
        <div class="calc">
          <div><span>Einnahmen${tm.incomeExpected ? " (erwartet, Durchschnitt)" : ""}</span><span class="num inc">${fmt(tm.income)}</span></div>
          <div><span>− Sparrate fürs Ziel</span><span class="num">${fmt(rate)}</span></div>
          <div><span>− bisherige Ausgaben</span><span class="num exp">${fmt(tm.exp)}</span></div>
          <div class="total"><span>Noch frei bis Monatsende</span><span class="num ${tm.free >= 0 ? "inc" : "exp"}">${fmt(tm.free)}</span></div>
        </div>
        <p class="small">${tm.free > 0 ? `Das sind <b>${fmt(tm.perDay)} pro Tag</b> für die restlichen ${plural(tm.daysLeft, "Tag", "Tage")}.` : `Diesen Monat ist nichts mehr frei, wenn du die Sparrate einhalten willst. Jeder weitere Franken geht vom Ziel ab.`}</p>
      </section>
    </div>
    ${planHtml(plan, st, an)}
    ${tipList.length ? `<section class="panel"><h2>Spartipps für dich</h2><div class="tips">${tipList.map((t) => `<div><b>${esc(t.title)}</b><span class="small">${esc(t.text)}</span></div>`).join("")}</div></section>` : ""}
    ${analysisHtml(an)}`;
  setHandlers((act) => {
    if (act === "goal-edit") { state.editGoal = true; renderSavings(); }
    else if (act === "plan-apply") {
      s.budgets = { ...(s.budgets || {}) };
      for (const i of plan.items) s.budgets[i.kategorie] = i.budget;
      save(); toast(`${plural(plan.items.length, "Budget", "Budgets")} übernommen.`); renderSavings();
    }
  }, (e) => {
    if (e.target.id === "g-anlagen") { s.anlagenImZiel = e.target.checked; save(); renderSavings(); }
    else if (e.target.classList.contains("plan-edit")) {
      const k = e.target.dataset.k, raw = e.target.value.trim(), v = parseBetrag(raw);
      if (!raw) { if (s.budgets?.[k] != null) { delete s.budgets[k]; save(); toast(`Budget ${k} entfernt.`); } }
      else if (!v || v <= 0) { toast("Bitte einen Betrag eingeben, z. B. 250."); }
      else { s.budgets = { ...(s.budgets || {}), [k]: Math.abs(v) }; save(); toast(`Budget ${k}: ${fmt0(Math.abs(v))} pro Monat.`); }
      const id = e.target.id; renderSavings();
      $(id)?.closest("tr")?.nextElementSibling?.querySelector("input")?.focus();
    }
  });
}

// =====================================================================
// Wiederkehrend
// =====================================================================
function renderRecurring() {
  const list = Object.entries(state.data.recurring).sort((a, b) => (a[1].naechstes || "9").localeCompare(b[1].naechstes || "9"));
  const monthly = list.filter(([, t]) => !t.pausiert).reduce((a, [, t]) => {
    const per = { monatlich: 1, vierteljaehrlich: 3, halbjaehrlich: 6, jaehrlich: 12 }[t.intervall] || 1;
    return a + (t.typ === "ausgabe" ? -1 : 1) * t.betragCent / per;
  }, 0);
  $("view").innerHTML = `
    <div class="pagehead"><h1>Wiederkehrend</h1><button class="btn" data-act="rec-new">Neue wiederkehrende Buchung</button></div>
    <p class="muted">Feste Zahlungen wie Miete, Krankenkasse oder Abos trägst du einmal ein. Die App bucht sie an jedem fälligen Datum selbst, sobald du das Kassenbuch öffnest.</p>
    <section class="panel">
      ${list.length ? `<div class="panel-head"><h2>${plural(list.length, "Vorlage", "Vorlagen")}</h2><span class="small muted">pro Monat im Schnitt <b class="num ${monthly < 0 ? "exp" : "inc"}">${fmt(Math.round(monthly))}</b></span></div>
      <div>${list.map(([id, t]) => `<div class="tpl">
        <div class="who"><strong>${esc(t.name)}</strong><small>${esc(INTERVAL_LABEL[t.intervall])} · ${esc(t.kategorie)} · ${BEREICH_NAME[t.bereich]}${t.pausiert ? " · pausiert" : ` · nächstes Mal ${dmy(t.naechstes)}`}${t.ende ? ` · bis ${dmy(t.ende)}` : ""}</small></div>
        <span class="num ${t.typ === "einnahme" ? "inc" : "exp"}">${t.typ === "einnahme" ? "+" : "−"} ${fmt(t.betragCent)}</span>
        <div class="actions"><button class="btn ghost sm" data-act="rec-edit" data-id="${id}">Bearbeiten</button><button class="btn quiet sm" data-act="rec-pause" data-id="${id}">${t.pausiert ? "Fortsetzen" : "Pausieren"}</button><button class="btn quiet sm" data-act="rec-del" data-id="${id}">Löschen</button></div>
      </div>`).join("")}</div>`
      : `<div class="empty"><b>Noch keine wiederkehrenden Buchungen</b><span>Zum Beispiel: Miete Büro, Krankenkasse, Handy-Abo, Microsoft 365, Säule 3a.</span><button class="btn sm" data-act="rec-new">Erste Vorlage anlegen</button></div>`}
    </section>`;
  setHandlers((act, b) => {
    const id = b.dataset.id, t = state.data.recurring[id];
    if (act === "rec-new") openRec(null);
    else if (act === "rec-edit") openRec(id);
    else if (act === "rec-pause") { t.pausiert = !t.pausiert; if (!t.pausiert) bookAndTell(); save(); renderRecurring(); }
    else if (act === "rec-del") {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Wirklich löschen?"; return; }
      delete state.data.recurring[id]; save(); toast("Vorlage gelöscht. Bereits gebuchte Einträge bleiben erhalten."); renderRecurring();
    }
  });
}
function bookAndTell() {
  const created = bookDue(state.data);
  if (created.length) toast(`${plural(created.length, "Buchung", "Buchungen")} eingetragen.`);
}
const rdlg = $("dlg-rec");
rdlg.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) rdlg.close(); });
function syncRec() {
  const typ = document.querySelector('input[name="r-typ"]:checked').value, priv = $("r-bereich").value === "privat";
  ensureDatalists();
  $("r-kat").setAttribute("list", datalistId(priv ? "privat" : "geschaeft", typ));
  $("r-ust").disabled = priv; if (priv) $("r-ust").value = "0";
}
$("rec").addEventListener("change", syncRec);
function openRec(id) {
  const t = id ? state.data.recurring[id] : null;
  state.editingRec = id;
  $("rec").reset();
  $("rec-title").textContent = t ? "Wiederkehrende Buchung bearbeiten" : "Neue wiederkehrende Buchung";
  $("r-name").value = t?.name || "";
  (t?.typ === "einnahme" ? $("r-typ-ein") : $("r-typ-aus")).checked = true;
  $("r-bereich").value = t?.bereich || (state.bereich === "geschaeft" ? "geschaeft" : "privat");
  $("r-betrag").value = t ? amountText(t.betragCent) : "";
  $("r-ust").value = String(t?.ustSatz ?? 8.1);
  $("r-kat").value = t?.kategorie || "";
  $("r-partner").value = t?.partner || "";
  $("r-intervall").value = t?.intervall || "monatlich";
  $("r-start").value = t?.naechstes || todayIso();
  $("r-ende").value = t?.ende || "";
  $("r-msg").textContent = "";
  syncRec();
  rdlg.showModal();
}
$("rec").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = $("r-msg"), betragCent = parseBetrag($("r-betrag").value);
  if (!$("r-name").value.trim()) return (m.textContent = "Bitte eine Bezeichnung angeben.");
  if (!betragCent || betragCent <= 0) return (m.textContent = "Bitte einen Betrag angeben.");
  if (!$("r-kat").value.trim()) return (m.textContent = "Bitte eine Kategorie angeben.");
  if (!$("r-start").value) return (m.textContent = "Bitte das nächste Datum angeben.");
  const bereich = $("r-bereich").value, start = $("r-start").value;
  const tpl = {
    ...(state.editingRec ? state.data.recurring[state.editingRec] : {}),
    name: $("r-name").value.trim(), typ: document.querySelector('input[name="r-typ"]:checked').value, bereich, betragCent,
    ustSatz: bereich === "privat" ? 0 : +$("r-ust").value, kategorie: $("r-kat").value.trim(), partner: $("r-partner").value.trim(),
    intervall: $("r-intervall").value, naechstes: start, tag: +start.slice(8, 10), ende: $("r-ende").value || null,
  };
  state.data.recurring[state.editingRec || uid()] = tpl;
  bookAndTell();
  save(); rdlg.close(); renderRecurring();
});

// =====================================================================
// Einstellungen
// =====================================================================
let installEvent = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; if (state.view === "einstellungen") render(); });

function renderSettings() {
  const s = state.data.settings;
  const budgets = Object.entries(s.budgets || {}).sort((a, b) => a[0].localeCompare(b[0], "de"));
  // average spending per category over the last months, as a guide for the budget
  const avgOf = new Map(analyze(allTx(), todayIso(), goalOpts()).cats.map((c) => [c.kategorie, c.avg]));
  const budgetCats = [...new Set([...KAT.privat.ausgabe, ...KAT.geschaeft.ausgabe, ...allTx().filter((t) => t.typ === "ausgabe").map((t) => t.kategorie)])]
    .filter((k) => k && !(s.budgets || {})[k]).sort((a, b) => a.localeCompare(b, "de"));
  const installed = matchMedia("(display-mode: standalone)").matches;
  $("view").innerHTML = `
    <div class="pagehead"><h1>Einstellungen</h1></div>
    <div class="settings">
      <section class="panel"><h2>Darstellung</h2>
        <div class="seg" role="group" aria-label="Darstellung">${Object.entries(THEMES).map(([k, v]) => `<button type="button" data-act="theme" data-v="${k}" aria-pressed="${(prefs.theme || "auto") === k}">${v}</button>`).join("")}</div>
        <p class="small muted">Automatisch folgt der Einstellung deines Computers bzw. iPhones. Umschalten geht auch jederzeit mit dem Knopf ${matchMedia("(max-width: 860px)").matches ? "oben rechts" : "unten in der Seitenleiste"}.</p>
      </section>
      <section class="panel"><h2>Über dich</h2>
        <div class="set-grid">
          <div class="field"><label for="s-firma">Dein Name oder Firmenname</label><input type="text" id="s-firma" value="${esc(s.firma)}"><span class="hint">Hilft der KI zu erkennen, ob eine Rechnung von dir stammt (Einnahme).</span></div>
          <div class="field"><label for="s-ibans">Deine Geschäfts-IBAN(s)</label><textarea id="s-ibans" rows="2" placeholder="CH93 0076 2011 6238 5295 7">${esc((s.ibans || []).join("\n"))}</textarea><span class="hint">Eine pro Zeile. Steht sie auf einer QR-Rechnung, ist es deine Rechnung an einen Kunden.</span></div>
          <div class="field"><label for="s-eigene">Deine Spar- und Anlagekonten</label><textarea id="s-eigene" rows="2" placeholder="Sparkonto CH12 0900 0000 1234 5678 9&#10;E-Trading CH34 0900 0000 9876 5432 1">${esc((s.eigeneKonten || []).join("\n"))}</textarea><span class="hint">IBAN oder Kontonummer von Sparkonto, E-Trading, 3a usw., eine pro Zeile. Überträge aufs Sparkonto zählen als gespart; steht „E-Trading“ oder „Depot“ in der Zeile, gilt das Konto als Anlage. Wörter wie „Übertrag“, „Sparkonto“ oder „E-Trading“ erkennt die App auch ohne Eintrag.</span></div>
        </div>
      </section>
      <section class="panel"><h2>MWST</h2>
        <div class="set-grid">
          <div class="field"><label for="s-mwst">Abrechnungsmethode</label><select id="s-mwst">
            <option value="effektiv"${s.mwst === "effektiv" ? " selected" : ""}>Effektive Methode</option>
            <option value="saldo"${s.mwst === "saldo" ? " selected" : ""}>Saldosteuersatz</option>
            <option value="keine"${s.mwst === "keine" ? " selected" : ""}>Nicht MWST-pflichtig</option></select></div>
          <div class="field" ${s.mwst === "saldo" ? "" : "hidden"}><label for="s-saldo">Saldosteuersatz in %</label><input type="text" id="s-saldo" inputmode="decimal" value="${s.saldoSatz ?? ""}" placeholder="laut ESTV-Bewilligung"></div>
        </div>
      </section>
      <section class="panel"><h2>Monatsbudgets</h2>
        <p class="small muted">Die Übersicht zeigt, wie viel von jedem Budget schon gebraucht ist. Betrag direkt ändern, er wird sofort gespeichert.</p>
        ${budgets.length ? `<div class="budget-list">${budgets.map(([k, v], i) => `<div class="budget-row">
            <label for="s-b-${i}">${esc(k)}${avgOf.get(k) ? `<small>bisher Ø ${fmt0(avgOf.get(k))} / Monat</small>` : ""}</label>
            <span class="budget-input"><input type="text" inputmode="decimal" id="s-b-${i}" class="b-edit" data-k="${esc(k)}" value="${amountText(v)}" aria-label="Budget ${esc(k)} pro Monat in CHF"><small>/ Monat</small></span>
            <button class="btn quiet sm" data-act="budget-del" data-k="${esc(k)}" aria-label="Budget ${esc(k)} entfernen">Entfernen</button>
          </div>`).join("")}</div>` : `<p class="small">Noch keine Budgets. Lege eines an, oder lass dir unter <a href="#sparen">Sparziel</a> passende Budgets vorschlagen.</p>`}
        <h3>Neues Budget</h3>
        <datalist id="dl-budget">${budgetCats.map((k) => `<option value="${esc(k)}">`).join("")}</datalist>
        <div class="set-grid"><div class="field"><label for="s-bkat">Kategorie</label><input type="text" id="s-bkat" list="dl-budget" placeholder="z. B. Restaurant & Ausgang"><span class="hint" id="s-bkat-hint"></span></div>
          <div class="field"><label for="s-bbetrag">Betrag pro Monat (CHF)</label><input type="text" id="s-bbetrag" inputmode="decimal"></div></div>
        <div class="actions"><button class="btn ghost sm" data-act="budget-add">Budget hinzufügen</button>${budgets.length ? `<button class="btn quiet sm" data-act="budget-clear">Alle Budgets entfernen</button>` : ""}</div>
      </section>
      <section class="panel"><h2>Eingebaute KI</h2>
        <p class="small">Die KI liest Dokumente auf diesem Computer und hat sich bisher <b>${plural(learnedCount(state.data.learn), "Partner", "Partner")}</b> mit ihrer Kategorie gemerkt. Jede Buchung, die du bestätigst oder korrigierst, macht sie genauer.</p>
        <div class="actions"><button class="btn ghost danger sm" data-act="learn-reset">Gelerntes vergessen</button></div>
      </section>
      <section class="panel"><h2>Datensicherung</h2>
        <p class="small">Deine Daten liegen nur auf diesem Gerät. Erstelle regelmässig eine Sicherung und lege sie zusätzlich ab, zum Beispiel auf einem USB-Stick oder in iCloud/OneDrive. Die Sicherung ist mit deinem aktuellen Passwort verschlüsselt.</p>
        <p class="small muted">Letzte Sicherung: ${s.lastBackup ? dmy(s.lastBackup) : "noch nie"}</p>
        <div class="actions"><button class="btn" data-act="backup">Sicherung erstellen</button><button class="btn ghost" data-act="restore">Sicherung wiederherstellen</button></div>
        <p class="small muted">Für die Treuhand: unter „Buchungen“ gibt es den CSV-Export und alle Belege als ZIP.</p>
      </section>
      <section class="panel"><h2>Sicherheit</h2>
        <div class="field" style="max-width:320px"><label for="s-autolock">Automatisch sperren nach</label><select id="s-autolock">
          ${[[5, "5 Minuten"], [15, "15 Minuten"], [30, "30 Minuten"], [60, "1 Stunde"], [0, "nie"]].map(([v, l]) => `<option value="${v}"${(prefs.autolock ?? 15) === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <form id="pw-form" class="set-grid" autocomplete="off">
          <div class="field"><label for="s-pw-old">Bisheriges Passwort</label><input type="password" id="s-pw-old" autocomplete="current-password"></div><div></div>
          <div class="field"><label for="s-pw-new">Neues Passwort (mind. 8 Zeichen)</label><input type="password" id="s-pw-new" autocomplete="new-password"></div>
          <div class="field"><label for="s-pw-new2">Neues Passwort wiederholen</label><input type="password" id="s-pw-new2" autocomplete="new-password"></div>
          <div class="actions" style="grid-column:1/-1"><button class="btn ghost sm" type="submit">Passwort ändern</button><span class="msg" id="s-pw-msg" role="status"></span></div>
        </form>
      </section>
      <section class="panel"><h2>App</h2>
        ${installed ? `<p class="small">Das Kassenbuch ist als App installiert.</p>` : installEvent ? `<p class="small">Installiere das Kassenbuch als App: Es erscheint dann im Dock bzw. Startmenü und öffnet sich in einem eigenen Fenster.</p><div class="actions"><button class="btn" data-act="install">App installieren</button></div>`
          : `<p class="small">Als App installieren: In Chrome oder Edge oben in der Adressleiste auf das Symbol „Installieren“ klicken. In Safari auf dem Mac: Ablage → Zum Dock hinzufügen.</p>`}
        <p class="small muted" id="s-storage"></p>
      </section>
      <section class="panel"><h2>Alles löschen</h2>
        <p class="small">Löscht alle Buchungen, Belege und Einstellungen auf diesem Computer endgültig. Erstelle vorher eine Sicherung.</p>
        <div class="actions"><input type="text" id="s-wipe-word" placeholder="LÖSCHEN eintippen" style="max-width:220px" aria-label="Zur Bestätigung LÖSCHEN eintippen"><button class="btn ghost danger sm" data-act="wipe">Alles löschen</button></div>
      </section>
    </div>`;
  navigator.storage?.estimate?.().then((est) => {
    const el = $("s-storage");
    if (el && est.usage != null) el.textContent = `Belegt auf diesem Computer: ${(est.usage / 1048576).toFixed(1)} MB`;
  }).catch(() => {});
  $("pw-form").addEventListener("submit", changePw);
  setHandlers(async (act, b) => {
    if (act === "theme") applyTheme(b.dataset.v);
    else if (act === "budget-add") {
      const k = $("s-bkat").value.trim(), v = parseBetrag($("s-bbetrag").value);
      if (!k || !v || v <= 0) return toast("Bitte Kategorie und Betrag angeben.");
      const had = (s.budgets || {})[k] != null;
      s.budgets = { ...(s.budgets || {}), [k]: Math.abs(v) }; save(); renderSettings();
      toast(had ? `Budget ${k} geändert.` : `Budget ${k} hinzugefügt.`);
    } else if (act === "budget-del") { delete s.budgets[b.dataset.k]; save(); renderSettings(); }
    else if (act === "budget-clear") {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Wirklich alle entfernen?"; return; }
      s.budgets = {}; save(); renderSettings(); toast("Alle Budgets entfernt.");
    }
    else if (act === "learn-reset") {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Wirklich alles Gelernte vergessen?"; return; }
      state.data.learn = vault.emptyData().learn; save(); toast("Die KI hat das Gelernte vergessen."); renderSettings();
    } else if (act === "backup") {
      b.disabled = true; b.textContent = "Wird erstellt …";
      try {
        await persistNow();
        const res = await download(`kassenbuch-sicherung-${todayIso()}.kassenbuch`, new Blob([await vault.exportBackup()], { type: "application/json" }));
        if (res !== "aborted") { s.lastBackup = todayIso(); save(); toast("Sicherung erstellt. Lege sie an einem zweiten Ort ab, zum Beispiel in iCloud Drive oder auf dem Computer."); }
      } catch (e) { toast("Die Sicherung konnte nicht erstellt werden: " + e.message); }
      renderSettings();
    } else if (act === "restore") { await lockNow(); showLock("restore"); }
    else if (act === "install" && installEvent) { installEvent.prompt(); installEvent = null; }
    else if (act === "wipe") {
      if ($("s-wipe-word").value.trim().toUpperCase() !== "LÖSCHEN") return toast("Bitte zuerst LÖSCHEN eintippen.");
      await vault.wipe(); hasVaultCache = false; state.data = null; state.queue = []; showLock("setup");
    }
  }, (e) => {
    const id = e.target.id;
    if (e.target.classList.contains("b-edit")) {
      const k = e.target.dataset.k, v = parseBetrag(e.target.value);
      if (!v || v <= 0) { toast("Bitte einen Betrag eingeben. Zum Löschen „Entfernen“ wählen."); e.target.value = amountText(s.budgets[k]); return; }
      s.budgets = { ...s.budgets, [k]: Math.abs(v) }; save();
      e.target.value = amountText(Math.abs(v)); toast(`Budget ${k}: ${fmt0(Math.abs(v))} pro Monat.`);
    } else if (id === "s-bkat") {
      // show what was spent so far and suggest it as the amount
      const avg = avgOf.get(e.target.value.trim()), cur = (s.budgets || {})[e.target.value.trim()];
      $("s-bkat-hint").textContent = cur ? `Hat schon ein Budget (${fmt0(cur)}): der neue Betrag ersetzt es.` : avg ? `Bisher Ø ${fmt0(avg)} pro Monat.` : "";
      if (avg && !$("s-bbetrag").value) $("s-bbetrag").placeholder = amountText(Math.floor(avg / 1000) * 1000);
    } else if (id === "s-firma") { s.firma = e.target.value.trim(); save(); }
    else if (id === "s-eigene") { s.eigeneKonten = e.target.value.split(/\n+/).map((x) => x.trim()).filter(Boolean); save(); }
    else if (id === "s-ibans") { s.ibans = e.target.value.split(/[\n,;]+/).map((x) => x.replace(/\s/g, "").toUpperCase()).filter(Boolean); save(); }
    else if (id === "s-mwst") { s.mwst = e.target.value; save(); renderSettings(); }
    else if (id === "s-saldo") {
      const v = parseFloat(e.target.value.replace(",", "."));
      if (v > 0 && v < 20) { s.saldoSatz = v; save(); } else { e.target.value = s.saldoSatz ?? ""; toast("Bitte einen Satz zwischen 0.1 und 20 % eingeben."); }
    } else if (id === "s-autolock") { prefs.autolock = +e.target.value; savePrefs(); }
  });
}

async function changePw(e) {
  e.preventDefault();
  const m = $("s-pw-msg"), o = $("s-pw-old").value, n = $("s-pw-new").value, n2 = $("s-pw-new2").value;
  m.className = "msg err";
  if (n.length < 8) return (m.textContent = "Das neue Passwort braucht mindestens 8 Zeichen.");
  if (n !== n2) return (m.textContent = "Die neuen Passwörter sind nicht gleich.");
  m.className = "msg"; m.textContent = "Wird geändert …";
  try {
    await vault.changePassword(o, n, state.data);
    e.target.reset(); m.className = "msg ok"; m.textContent = "Passwort geändert. Erstelle eine neue Sicherung, ältere Sicherungen öffnen sich weiter mit dem alten Passwort.";
  } catch (err) { m.className = "msg err"; m.textContent = err.message; }
}

// ---------- start ----------
async function start() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  vault.persist();
  try { hasVaultCache = await vault.hasVault(); }
  catch (_) { $("lock-loading").textContent = "Dieser Browser erlaubt keinen lokalen Speicher (z. B. im privaten Fenster). Öffne das Kassenbuch in einem normalen Fenster."; return; }
  showLock(hasVaultCache ? "unlock" : "setup");
}
start();
