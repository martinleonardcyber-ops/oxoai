import { apiFetch, GATEWAY_BASE } from "./endpoint";
import { billet } from "./flux";
import { langue, t } from "./i18n";

/**
 * Téléchargement direct de l'application, servi par l'instance
 * (gateway/src/telechargement.ts).
 */

export type Plateforme = "macos" | "windows" | "linux";

export interface EtatPaquet {
  plateforme: Plateforme;
  disponible: boolean;
  pret: boolean;
  version?: string;
  architecture?: string;
  taille?: number;
  raison?: string;
}

export async function etatPaquets(): Promise<EtatPaquet[] | null> {
  try {
    const res = await apiFetch("/oxoai/telecharger");
    if (!res.ok) return null;
    return ((await res.json()) as { paquets: EtatPaquet[] }).paquets;
  } catch {
    return null;
  }
}

export async function preparerMac(): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await apiFetch("/oxoai/telecharger/macos/preparer", { method: "POST" });
    if (res.ok) return { ok: true };
    const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return { ok: false, message: corps.error?.message ?? t("L'instance n'a pas répondu.") };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}

/**
 * Ouvre le téléchargement.
 *
 * Le fichier part par un lien, que l'application de bureau confie au
 * navigateur du poste (`setWindowOpenHandler`, electron/main.cjs) : c'est lui
 * qui l'enregistre dans Téléchargements, avec sa barre de progression. Le lien
 * porte un billet d'une minute, pas un jeton.
 */
export async function telecharger(plateforme: Plateforme): Promise<boolean> {
  // Seulement les trois paquets connus : l'adresse ouverte ne se compose pas d'autre chose.
  if (!["macos", "windows", "linux"].includes(plateforme)) return false;
  const b = await billet();
  if (!b) return false;
  window.open(
    `${GATEWAY_BASE}/oxoai/telecharger/${plateforme}?flux=${encodeURIComponent(b)}&langue=${langue()}`,
    "_blank",
    "noopener",
  );
  return true;
}
