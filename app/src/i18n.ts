import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";

// Locale bundles live at src/locales/<lng>/<ns>.json and are discovered at
// build time, so adding a namespace never requires touching this file.
const bundles = {
  ko: import.meta.glob<{ default: Record<string, unknown> }>(
    "./locales/ko/*.json",
    { eager: true },
  ),
  en: import.meta.glob<{ default: Record<string, unknown> }>(
    "./locales/en/*.json",
    { eager: true },
  ),
};

export const LANGUAGES = ["ko", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

const LANGUAGE_STORAGE_KEY = "sawhorse.language";

function toResources(mods: Record<string, { default: Record<string, unknown> }>) {
  const namespaces: Record<string, Record<string, unknown>> = {};
  for (const [path, mod] of Object.entries(mods)) {
    const name = path.split("/").pop()!.replace(/\.json$/, "");
    namespaces[name] = mod.default;
  }
  return namespaces;
}

void i18next.use(initReactI18next).init({
  resources: {
    ko: toResources(bundles.ko),
    en: toResources(bundles.en),
  },
  lng: getLanguage(),
  fallbackLng: "ko",
  interpolation: { escapeValue: false },
});

const i18n = i18next as unknown as I18n;
export default i18n;

export function getLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

export function setLanguage(lng: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    // storage unavailable — session-only switch
  }
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
}
