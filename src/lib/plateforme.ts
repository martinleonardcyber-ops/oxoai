/**
 * Le système du poste, tel que le donne l'application de bureau (preload.cjs).
 * `null` dans un navigateur, ou avec une application d'avant le 27/09/2026 :
 * l'écran garde alors ses textes d'avant (écrits pour macOS).
 */
export type Plateforme = "darwin" | "win32" | "linux";

export function plateformePoste(): Plateforme | null {
  try {
    const p = (window as unknown as { oxoai?: { plateforme?: unknown } }).oxoai?.plateforme;
    return p === "darwin" || p === "win32" || p === "linux" ? p : null;
  } catch {
    return null;
  }
}
