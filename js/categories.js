// Categories for a Swiss consulting business (KMU-Kontenrahmen) and private finances.

export const KONTEN_EIN = {
  "Beratungshonorar": "3400", "Projektpauschale": "3400", "Schulung & Workshop": "3400",
  "Spesenrückerstattung": "3600", "Sonstige Einnahme": "3600",
};
export const KONTEN_AUS = {
  "Miete & Raumkosten": "6000", "Fahrzeug": "6200", "Versicherungen": "6300", "Büro & Verwaltung": "6500",
  "Telefon & Internet": "6510", "Treuhand & Buchhaltung": "6530", "Software & IT": "6570", "Werbung & Marketing": "6600",
  "Reisespesen": "6640", "Kundenbetreuung": "6641", "Weiterbildung": "5810", "Sonstige Ausgabe": "6700",
};
export const PRIVAT_EIN = ["Lohn", "Nebenerwerb", "Rückerstattung", "Sonstige Einnahme privat"];
export const PRIVAT_AUS = [
  "Wohnen & Miete", "Krankenkasse", "Lebensmittel", "Mobilität", "Versicherungen privat", "Steuern", "Säule 3a",
  "Gesundheit", "Kleidung", "Freizeit & Ferien", "Sparen & Anlegen", "Sonstiges privat",
];

export const KAT = {
  geschaeft: { einnahme: Object.keys(KONTEN_EIN), ausgabe: Object.keys(KONTEN_AUS) },
  privat: { einnahme: PRIVAT_EIN, ausgabe: PRIVAT_AUS },
};

export const konto = (k) => KONTEN_EIN[k] || KONTEN_AUS[k] || "";
export const bereichOf = (t) => (t.bereich === "privat" ? "privat" : "geschaeft");
export const defaultKat = (typ, bereich) => bereich === "privat"
  ? (typ === "einnahme" ? "Sonstige Einnahme privat" : "Sonstiges privat")
  : (typ === "einnahme" ? "Sonstige Einnahme" : "Sonstige Ausgabe");
