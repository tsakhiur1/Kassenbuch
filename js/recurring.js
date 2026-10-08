// Recurring bookings (rent, subscriptions, health insurance): due entries are booked automatically
// whenever the app is unlocked, up to today.

import { addMonths, todayIso, uid } from "./util.js";

export const INTERVALS = { monatlich: 1, vierteljaehrlich: 3, halbjaehrlich: 6, jaehrlich: 12 };
export const INTERVAL_LABEL = { monatlich: "monatlich", vierteljaehrlich: "vierteljährlich", halbjaehrlich: "halbjährlich", jaehrlich: "jährlich" };

export function nextDate(tpl, iso) {
  return addMonths(iso, INTERVALS[tpl.intervall] || 1, tpl.tag || +iso.slice(8, 10));
}

// Returns the bookings created; advances each template's next date.
export function bookDue(data, today = todayIso()) {
  const created = [];
  for (const [id, tpl] of Object.entries(data.recurring)) {
    if (tpl.pausiert) continue;
    let guard = 0;
    while (tpl.naechstes && tpl.naechstes <= today && (!tpl.ende || tpl.naechstes <= tpl.ende) && guard++ < 120) {
      const tx = {
        typ: tpl.typ, bereich: tpl.bereich, datum: tpl.naechstes, betragCent: tpl.betragCent, ustSatz: tpl.ustSatz || 0,
        kategorie: tpl.kategorie, partner: tpl.partner || "", beleg: "", status: "bezahlt", notiz: tpl.name,
        erstellt: new Date().toISOString(), wiederkehrend: id,
      };
      data.tx[uid()] = tx;
      created.push(tx);
      tpl.naechstes = nextDate(tpl, tpl.naechstes);
    }
  }
  return created;
}
