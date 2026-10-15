// Savings goal and spending analysis. Pure functions over the bookings, so they can be tested
// without the interface. Amounts are in Rappen, months are "YYYY-MM".

import { merchantKey } from "./learn.js";

// Money moved to the savings account (and the 3rd pillar) is not spent: it counts towards the goal.
// "Sparen & Anlegen" is the category of an earlier version and counts as savings account.
export const SPAR_KAT = new Set(["Säule 3a", "Sparkonto", "Sparen & Anlegen"]);
// Investments (E-Trading) are not spent either, but count towards the goal only when the user says so.
export const ANLAGE_KAT = new Set(["Anlagen (E-Trading)"]);
// Money taken back from savings or investments is no income.
export const SPAR_RUECK = new Set(["Entnahme Sparkonto"]);
export const ANLAGE_RUECK = new Set(["Entnahme Anlagen"]);
// Credit card top-ups and payments: neither spending nor saving (the purchases come with the card statement).
export const KARTE_KAT = new Set(["Kreditkarte (Übertrag)"]);
// Costs that cannot be cut from one month to the next (they need a contract change).
export const FIX_KAT = new Set([
  "Wohnen & Miete", "Krankenkasse", "Versicherungen privat", "Steuern",
  "Miete & Raumkosten", "Versicherungen", "Treuhand & Buchhaltung",
]);
// everyday shopping is regular, but not a subscription
const NO_ABO = new Set(["Lebensmittel", "Restaurant & Ausgang", "Bargeld", "Online-Shopping", "Kleidung"]);
// at most this share of a variable category is suggested as a cut
const MAX_CUT = 0.4;

export const ymOf = (iso) => iso.slice(0, 7);
export function addYm(ym, n) {
  const [y, m] = ym.split("-").map(Number), t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const daysInMonth = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
const isSparOut = (t) => t.typ === "ausgabe" && SPAR_KAT.has(t.kategorie);
const isAnlOut = (t) => t.typ === "ausgabe" && ANLAGE_KAT.has(t.kategorie);
const isSparIn = (t) => t.typ === "einnahme" && SPAR_RUECK.has(t.kategorie);
const isAnlIn = (t) => t.typ === "einnahme" && ANLAGE_RUECK.has(t.kategorie);
export const isKarte = (t) => KARTE_KAT.has(t.kategorie);
export const isTransfer = (t) => isSparOut(t) || isAnlOut(t) || isSparIn(t) || isAnlIn(t) || isKarte(t);
export const isAnlage = (t) => isAnlOut(t) || isAnlIn(t);
const isSpend = (t) => t.typ === "ausgabe" && !isTransfer(t);
const isIncome = (t) => t.typ === "einnahme" && !isTransfer(t);

// Totals of a list of bookings. "saved" is what counts towards the goal: income minus spending,
// minus money taken back from the savings account; investments only count with opts.anlagen.
function totals(list, opts = {}) {
  const sum = (f) => list.filter(f).reduce((a, t) => a + t.betragCent, 0);
  const m = { inc: sum(isIncome), exp: sum(isSpend), sparOut: sum(isSparOut), sparIn: sum(isSparIn), anlOut: sum(isAnlOut), anlIn: sum(isAnlIn) };
  m.spar = m.sparOut - m.sparIn; m.anl = m.anlOut - m.anlIn;
  m.karte = sum((t) => isKarte(t) && t.typ === "ausgabe") - sum((t) => isKarte(t) && t.typ === "einnahme");
  m.saved = m.inc - m.exp - m.sparIn - (opts.anlagen ? m.anlIn : m.anl);
  return m;
}
const monthTotals = (txs, ym, opts) => ({ ym, ...totals(txs.filter((t) => ymOf(t.datum) === ym), opts) });

// goal: { betrag, start: "YYYY-MM", monate }
export function goalStatus(goal, txs, today, opts = {}) {
  const nowYm = ymOf(today), target = Math.round(goal.betrag / goal.monate);
  const months = Array.from({ length: goal.monate }, (_, i) => ({ ...monthTotals(txs, addYm(goal.start, i), opts), target }));
  const endYm = addYm(goal.start, goal.monate - 1);
  const started = nowYm >= goal.start, ended = nowYm > endYm;
  const past = months.filter((m) => m.ym <= nowYm);
  const full = months.filter((m) => m.ym < nowYm);
  const savedTotal = past.reduce((a, m) => a + m.saved, 0);
  // The plan is checked on complete months only: early in a month the rent is paid but the
  // salary has not arrived yet, which would look like falling behind.
  const savedFull = full.reduce((a, m) => a + m.saved, 0);
  const soll = !started ? 0 : ended ? goal.betrag : target * full.length;
  const remainingMonths = ended ? 0 : goal.monate - full.length;
  const needPerMonth = remainingMonths ? Math.max(0, Math.round((goal.betrag - savedTotal) / remainingMonths)) : 0;
  const avgFull = full.length ? full.reduce((a, m) => a + m.saved, 0) / full.length : null;
  const prognose = avgFull == null ? null : Math.round(avgFull * goal.monate);
  return {
    months, target, endYm, started, ended, savedTotal, soll, remainingMonths, needPerMonth, prognose,
    pct: goal.betrag ? savedTotal / goal.betrag : 0,
    reached: savedTotal >= goal.betrag,
    savedFull, fullMonths: full.length,
    sparTotal: past.reduce((a, m) => a + m.spar, 0), anlTotal: past.reduce((a, m) => a + m.anl, 0),
    diff: (ended ? savedTotal : savedFull) - soll, // positive: ahead of plan
  };
}

// The money left this month after the planned saving: what may still be spent, per day.
export function thisMonth(txs, today, savingTarget, avgIncome, opts = {}) {
  const ym = ymOf(today), m = monthTotals(txs, ym, opts);
  const income = Math.max(m.inc, avgIncome || 0);
  const free = income - savingTarget - m.exp;
  const daysLeft = daysInMonth(ym) - (+today.slice(8, 10)) + 1;
  return { ...m, income, incomeExpected: income > m.inc, free, daysLeft, perDay: free > 0 ? Math.floor(free / daysLeft) : 0 };
}

// Spending analysis over the (up to) three most recent months with bookings. The current month
// only counts when there is nothing older, because it is not complete yet.
export function analyze(txs, today, opts = {}) {
  const nowYm = ymOf(today);
  let months = [...new Set(txs.map((t) => ymOf(t.datum)))].filter((ym) => ym <= nowYm).sort().reverse();
  if (months.length > 1) months = months.filter((ym) => ym !== nowYm);
  months = months.slice(0, 3);
  const n = months.length;
  const inWin = txs.filter((t) => months.includes(ymOf(t.datum)));
  const per = (v) => (n ? Math.round(v / n) : 0);
  const sum = (list) => list.reduce((a, t) => a + t.betragCent, 0);
  const spend = inWin.filter(isSpend);
  const tot = totals(inWin, opts);
  const incAvg = per(tot.inc), expAvg = per(tot.exp);

  const byCat = new Map();
  for (const t of spend) byCat.set(t.kategorie, (byCat.get(t.kategorie) || 0) + t.betragCent);
  const spar = {};
  for (const t of inWin.filter((t) => isSparOut(t) || isAnlOut(t))) spar[t.kategorie] = (spar[t.kategorie] || 0) + t.betragCent;
  for (const k of Object.keys(spar)) spar[k] = per(spar[k]);
  const cats = [...byCat.entries()].map(([kategorie, v]) => ({ kategorie, avg: per(v), fix: FIX_KAT.has(kategorie) }))
    .sort((a, b) => b.avg - a.avg);

  // subscriptions: the same counterparty in at least two different months with (about) the same amount
  const since = addYm(nowYm, -6);
  const groups = new Map();
  for (const t of txs) {
    if (!isSpend(t) || NO_ABO.has(t.kategorie) || ymOf(t.datum) < since) continue;
    const key = merchantKey(t.partner || t.notiz || t.kategorie);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const abos = [];
  for (const [key, list] of groups) {
    const amounts = list.map((t) => t.betragCent).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const same = list.filter((t) => Math.abs(t.betragCent - median) <= Math.max(100, median * 0.1));
    const ms = new Set(same.map((t) => ymOf(t.datum)));
    if (ms.size >= 2 && same.length <= ms.size + 1) {
      const t = same[same.length - 1];
      abos.push({ key, name: t.partner || t.notiz || key, kategorie: t.kategorie, betrag: median, proJahr: median * 12, monate: ms.size, fix: FIX_KAT.has(t.kategorie) });
    }
  }
  abos.sort((a, b) => b.proJahr - a.proJahr);

  const smallList = spend.filter((t) => t.betragCent < 2000);
  const small = { count: n ? Math.round(smallList.length / n) : 0, avg: per(sum(smallList)) };

  const byMerchant = new Map();
  for (const t of spend) {
    const key = merchantKey(t.partner || t.notiz || "") || t.kategorie;
    const e = byMerchant.get(key) || { name: t.partner || t.notiz || t.kategorie, sum: 0, count: 0 };
    e.sum += t.betragCent; e.count++; byMerchant.set(key, e);
  }
  const top = [...byMerchant.values()].map((e) => ({ name: e.name, avg: per(e.sum), count: e.count })).sort((a, b) => b.avg - a.avg).slice(0, 5);

  return { months, n, incAvg, expAvg, savedAvg: per(tot.saved), sparAvg: per(tot.spar), anlAvg: per(tot.anl), spar, cats, abos, small, top };
}

// Budgets that close the gap between what is saved now and what the goal needs. Fixed costs stay;
// each variable category gives the same share, at most MAX_CUT.
export function budgetPlan(an, needPerMonth) {
  const gap = Math.max(0, needPerMonth - an.savedAvg);
  const variable = an.cats.filter((c) => !c.fix && c.avg > 0);
  const totalVar = variable.reduce((a, c) => a + c.avg, 0);
  if (!gap || !totalVar) return { gap, share: 0, items: [], rest: gap };
  const share = Math.min(MAX_CUT, gap / totalVar);
  const items = variable.map((c) => {
    const budget = Math.floor((c.avg * (1 - share)) / 1000) * 1000; // round down to 10 francs
    return { kategorie: c.kategorie, avg: c.avg, budget, cut: c.avg - budget };
  });
  const cutTotal = items.reduce((a, i) => a + i.cut, 0);
  return { gap, share, items, rest: Math.max(0, gap - cutTotal) };
}

// Concrete Swiss tips, only where the bookings show they apply.
export function tips(an, abos) {
  const cat = (k) => an.cats.find((c) => c.kategorie === k)?.avg || 0;
  const out = [];
  const kk = cat("Krankenkasse");
  if (kk > 30000) out.push({ title: "Krankenkasse", text: `Du zahlst rund ${chf(kk)} im Monat. Eine höhere Franchise oder ein Hausarzt- bzw. Telmed-Modell spart oft mehrere hundert Franken im Jahr. Die Grundversicherung kannst du jeweils bis 30. November auf Ende Jahr wechseln; Prämien vergleichen z. B. auf priminfo.admin.ch.` });
  const resto = cat("Restaurant & Ausgang");
  if (resto > 20000) out.push({ title: "Auswärts essen", text: `Restaurant und Take-away kosten dich rund ${chf(resto)} im Monat. Zwei Mal pro Woche Mittagessen mitnehmen spart etwa ${chf(2 * 4.3 * 1500)} im Monat.` });
  const aboSum = abos.filter((a) => !a.fix).reduce((a, x) => a + x.betrag, 0);
  if (aboSum > 5000) out.push({ title: "Abos prüfen", text: `Wiederkehrende Abbuchungen ohne Fixkosten: ${chf(aboSum)} im Monat, also ${chf(aboSum * 12)} im Jahr. Kündige, was du im letzten Monat nicht gebraucht hast.` });
  const tel = cat("Telefon & Internet") + cat("Handy & Internet");
  if (tel > 8000) out.push({ title: "Handy und Internet", text: `${chf(tel)} im Monat ist viel. Günstige Schweizer Abos (z. B. Wingo, Yallo, Lebara, Aldi suisse mobile) kosten oft unter CHF 30.` });
  const cash = cat("Bargeld");
  if (cash > 20000) out.push({ title: "Bargeld", text: `Du beziehst rund ${chf(cash)} Bargeld im Monat, und wofür es ausgegeben wird, sieht die App nicht. Ein fester Wochenbetrag macht es planbar.` });
  if (an.small.count >= 15) out.push({ title: "Kleinbeträge", text: `Rund ${an.small.count} Zahlungen unter CHF 20 im Monat ergeben zusammen ${chf(an.small.avg)}. Kaffee, Snacks und TWINT-Kleinbeträge läppern sich.` });
  if (!an.spar["Säule 3a"] && an.savedAvg > 0) out.push({ title: "Säule 3a", text: "Einzahlungen in die Säule 3a sind bis zum jährlichen Maximalbetrag vom steuerbaren Einkommen abziehbar (2025: CHF 7'258 mit Pensionskasse). Das spart Steuern und zählt hier als gespart." });
  return out;
}
const chf = (rappen) => `CHF ${Math.round(rappen / 100).toLocaleString("de-CH")}`;
