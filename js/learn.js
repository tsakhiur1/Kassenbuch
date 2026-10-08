// The app's own AI for sorting bookings. It runs entirely on this computer and combines:
//  1. a memory of counterparties the user has booked before (strongest signal),
//  2. built-in rules for common Swiss merchants, insurers and authorities,
//  3. a naive Bayes classifier over words, trained on every confirmed booking.

import { KAT, defaultKat } from "./categories.js";

const STOP = new Set([
  "der", "die", "das", "und", "oder", "fuer", "von", "vom", "mit", "bei", "auf", "aus", "ihre", "ihr", "zahlung",
  "einkauf", "kartenzahlung", "karte", "debitkarte", "kreditkarte", "gutschrift", "belastung", "lastschrift", "auftrag",
  "dauerauftrag", "ebanking", "banking", "ebill", "lsv", "twint", "maestro", "visa", "mastercard", "postfinance", "card",
  "ueberweisung", "rechnung", "zahlungsauftrag", "eingang", "ausgang", "chf", "eur", "ref", "referenz",
  "mitteilung", "datum", "valuta", "betrag", "the", "and", "sepa", "esr", "qrr", "scor", "nr",
]);

// Banks often write "ZUERICH" where a receipt says "Zürich": fold umlauts and accents first.
const fold = (s) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

export function tokens(text) {
  return [...new Set(fold(String(text || ""))
    .replace(/[0-9]/g, " ")
    .split(/[^a-z&]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w)))];
}

// "Debitkarte MIGROS ZUERICH 1234" -> "migros zuerich"
export function merchantKey(text) {
  return tokens(text).slice(0, 2).join(" ");
}

// [pattern, category, area, direction]
const RULES = [
  [/\b(migros|coop|denner|lidl|aldi|volg|spar|landi|globus|manor food|alnatura)\b/i, "Lebensmittel", "privat", "ausgabe"],
  [/\b(css|helsana|sanitas|swica|visana|kpt|groupe mutuel|concordia|assura|atupri|ökk|oekk|sympany|egk|agrisano|krankenkasse|krankenversicherung)\b/i, "Krankenkasse", "privat", "ausgabe"],
  [/\b(steuerverwaltung|steueramt|staatssteuer|gemeindesteuer|bundessteuer|steuerrechnung)\b/i, "Steuern", "privat", "ausgabe"],
  [/\b(säule\s*3a|saeule\s*3a|viac|frankly|finpension|vorsorge\s*3a|3a[- ]konto)\b/i, "Säule 3a", "privat", "ausgabe"],
  [/\b(mietzins|wohnungsmiete|liegenschaftsverwaltung|immobilien)\b/i, "Wohnen & Miete", "privat", "ausgabe"],
  [/\b(sbb|zvv|bls|postauto|mobility|libero|bernmobil|vbz|tpg|uber|taxi)\b/i, "Mobilität", "privat", "ausgabe"],
  [/\b(swisscom|sunrise|salt|wingo|yallo|init7|quickline|upc)\b/i, "Telefon & Internet", "geschaeft", "ausgabe"],
  [/\b(microsoft|adobe|google|icloud|dropbox|zoom|slack|notion|github|atlassian|canva|openai|anthropic|bexio|abacus|infomaniak|hostpoint)\b/i, "Software & IT", "geschaeft", "ausgabe"],
  [/\b(digitec|galaxus|brack|interdiscount|mediamarkt|fust|office world|papeterie)\b/i, "Büro & Verwaltung", "geschaeft", "ausgabe"],
  [/\b(treuhand|buchhaltung|steuerberatung)\b/i, "Treuhand & Buchhaltung", "geschaeft", "ausgabe"],
  [/\b(weiterbildung|seminar|kursgebühr|fachhochschule|hochschule|akademie|academy)\b/i, "Weiterbildung", "geschaeft", "ausgabe"],
  [/\b(hotel|booking\.com|airbnb)\b/i, "Reisespesen", "geschaeft", "ausgabe"],
  [/\b(axa|mobiliar|allianz|generali|helvetia|baloise|vaudoise|smile\.direct|zurich versicherung)\b/i, "Versicherungen privat", "privat", "ausgabe"],
  [/\b(apotheke|pharmacie|amavita|sunstore|zahnarzt|arztpraxis|spital|physio)\b/i, "Gesundheit", "privat", "ausgabe"],
  [/\b(zalando|h&m|zara|ochsner|dosenbach|c&a|uniqlo)\b/i, "Kleidung", "privat", "ausgabe"],
  [/\b(lohn|lohnzahlung|salär|salaer|gehalt|salary|lohnabrechnung)\b/i, "Lohn", "privat", "einnahme"],
  [/\b(honorar|beratung|consulting|workshop)\b/i, "Beratungshonorar", "geschaeft", "einnahme"],
];

function rule(text, typ) {
  for (const [re, kategorie, bereich, dir] of RULES) if (dir === typ && re.test(text)) return { kategorie, bereich };
  return null;
}

function bayes(nb, toks, typ) {
  if (nb.docs < 3 || !toks.length) return null;
  const labels = Object.entries(nb.labels).filter(([l]) => l.split("|")[1] === typ);
  if (!labels.length) return null;
  const vocab = Object.keys(nb.tokens).length + 1;
  const scores = labels.map(([label, info]) => {
    let s = Math.log(info.docs / nb.docs);
    for (const t of toks) s += Math.log(((nb.tokens[t]?.[label] || 0) + 1) / (info.words + vocab));
    return [label, s];
  });
  const max = Math.max(...scores.map((x) => x[1]));
  const exp = scores.map(([l, s]) => [l, Math.exp(s - max)]);
  const total = exp.reduce((a, x) => a + x[1], 0);
  const [label, p] = exp.sort((a, b) => b[1] - a[1])[0];
  // only trust it when the words actually were seen with that label before
  const seen = toks.some((t) => nb.tokens[t]?.[label]);
  if (!seen) return null;
  const [bereich, , kategorie] = label.split("|");
  return { kategorie, bereich, p: p / total };
}

// Suggest category and area for a booking; `quelle` tells the UI how sure we are.
// Scanned receipts are mostly business costs, bank statement lines mostly private: the caller decides the fallback.
export function suggest(learn, { text = "", partner = "", typ = "ausgabe", fallbackBereich = "privat" }) {
  const full = `${partner} ${text}`;
  const key = merchantKey(partner || text);
  const known = key && learn.merchants[key];
  if (known && known.typ === typ) return { kategorie: known.kategorie, bereich: known.bereich, quelle: "gelernt" };
  const nb = bayes(learn.nb, tokens(full), typ);
  if (nb && nb.p >= 0.8) return { kategorie: nb.kategorie, bereich: nb.bereich, quelle: "gelernt" };
  const r = rule(full, typ);
  if (r) return { ...r, quelle: "regel" };
  if (nb && nb.p >= 0.5) return { kategorie: nb.kategorie, bereich: nb.bereich, quelle: "vorschlag" };
  return { kategorie: defaultKat(typ, fallbackBereich), bereich: fallbackBereich, quelle: "unsicher" };
}

// Learn from a booking the user confirmed (new, edited or imported).
export function train(learn, t) {
  const text = `${t.partner || ""} ${t.notiz || ""} ${t.text || ""}`;
  const key = merchantKey(t.partner || t.text || t.notiz);
  if (key) learn.merchants[key] = { kategorie: t.kategorie, bereich: t.bereich, typ: t.typ, n: (learn.merchants[key]?.n || 0) + 1 };
  const toks = tokens(text);
  if (!toks.length) return;
  const label = `${t.bereich}|${t.typ}|${t.kategorie}`;
  const nb = learn.nb;
  nb.docs++;
  nb.labels[label] ||= { docs: 0, words: 0 };
  nb.labels[label].docs++;
  nb.labels[label].words += toks.length;
  for (const w of toks) { nb.tokens[w] ||= {}; nb.tokens[w][label] = (nb.tokens[w][label] || 0) + 1; }
}

export const learnedCount = (learn) => Object.keys(learn.merchants).length;

export function isKnownCategory(bereich, typ, kategorie) {
  return KAT[bereich]?.[typ]?.includes(kategorie);
}
