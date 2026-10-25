import { apiFetch } from "@/lib/endpoint";
import { instance, isDesktopApp } from "@/lib/instance";
import { t, tf } from "@/lib/i18n";

/**
 * Où vont le moteur et les modèles (gateway/src/emplacementModeles.ts,
 * 28/09/2026) : l'état lu à la passerelle, le choix de l'administrateur.
 */

export interface EtatDeplacement {
  phase: "en-cours" | "fini" | "erreur";
  message: string;
  percent?: number;
  erreur?: string;
}

export interface EtatEmplacement {
  moteur: "lmstudio" | "llamacpp" | null;
  dossier: string;
  habituel: string;
  parDefaut: boolean;
  libre: number | null;
  introuvable: boolean;
  changement: "libre" | "deplacement" | "manuel" | "aucun";
  occupe?: number;
  manuel?: { dossier: string; pointeur: string; lms: string; modeles: string | null };
  alerte?: string;
  revenir?: boolean;
  deplacement: EtatDeplacement | null;
  necessaire: number;
  modele: { label: string; downloadGb: number };
  moteurPose: boolean;
  admin: boolean;
}

const message = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? tf("Demande refusée ({0}).", r.status);

export async function lireEmplacement(): Promise<EtatEmplacement> {
  const r = await apiFetch("/oxoai/emplacement-modeles");
  if (!r.ok) throw new Error(await message(r));
  return (await r.json()) as EtatEmplacement;
}

/** Choisit l'emplacement (null : l'emplacement habituel). `deplacement` : les modèles partent, suivre l'état. */
export async function choisirEmplacement(dossier: string | null): Promise<{ deplacement: boolean }> {
  const r = await apiFetch("/oxoai/emplacement-modeles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dossier }),
  });
  if (!r.ok) throw new Error(await message(r));
  const corps = (await r.json().catch(() => ({}))) as { deplacement?: boolean };
  return { deplacement: corps.deplacement === true };
}

/** Juge un dossier sans rien changer : le sous-dossier qui serait créé, et la place libre. `actuel` : c'est déjà l'emplacement retenu. */
export async function verifierEmplacement(dossier: string): Promise<{ dossier: string; libre: number | null; actuel?: boolean }> {
  const r = await apiFetch("/oxoai/emplacement-modeles/verifier", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dossier }),
  });
  if (!r.ok) throw new Error(await message(r));
  return (await r.json()) as { dossier: string; libre: number | null; actuel?: boolean };
}

type Selecteur = (options?: { titre?: string; message?: string; bouton?: string }) => Promise<string | null>;

/**
 * Le sélecteur de dossier du système, quand l'application tourne sur la
 * machine de l'instance. Pour une instance distante, le sélecteur ouvrirait
 * les disques de ce poste-ci, pas ceux de la machine où iront les modèles :
 * on saisit alors le chemin.
 */
export function selecteurDossier(): Selecteur | null {
  if (!isDesktopApp() || instance().remote) return null;
  const pont = (window as unknown as { oxoai?: { choisirDossier?: Selecteur } }).oxoai;
  return pont?.choisirDossier ?? null;
}

export const ouvrirSelecteur = (s: Selecteur) =>
  s({
    titre: t("Emplacement des modèles"),
    message: t("Choisissez le disque ou le dossier où iront le moteur et les modèles."),
    bouton: t("Choisir ce dossier"),
  });
