import { apiFetch } from "./endpoint";
import { t } from "@/lib/i18n";

/**
 * La machine de l'agent, vue de l'interface (gateway/src/machine.ts) : ce que
 * l'ordinateur peut porter, où en est la machine, et de quoi la démarrer,
 * l'arrêter et la regarder.
 */
export interface EtatMachine {
  conseil: "linux" | "macos" | "aucun";
  raison: string;
  obstacles: string[];
  memoireGo: number;
  disqueLibreGo: number;
  docker: "absent" | "eteint" | "pret";
  imagePrete: boolean;
  etat: "absent" | "arrete" | "en_marche";
  pret: boolean;
  preparationEnCours: boolean;
  dossierEchange: string;
  /** Système retenu pour la machine. */
  systeme: "linux" | "macos";
  /** La machine macOS : possible sur ce Mac, et sinon pourquoi. */
  macos: { possible: boolean; obstacles: string[]; presente: boolean; lume: boolean };
  progression: { etape: string; message: string; erreur?: string } | null;
}

export async function lireMachine(): Promise<EtatMachine> {
  const res = await apiFetch("/oxoai/machine");
  if (!res.ok) throw new Error(t("L'instance n'a pas répondu."));
  return (await res.json()) as EtatMachine;
}

export async function demarrerMachine(): Promise<void> {
  await apiFetch("/oxoai/machine/demarrer", { method: "POST" });
}

export async function arreterMachine(): Promise<void> {
  await apiFetch("/oxoai/machine/arreter", { method: "POST" });
}

/** Efface la machine et rend sa place sur le disque. Refusé tant qu'elle est choisie. */
export async function effacerMachine(): Promise<void> {
  const res = await apiFetch("/oxoai/machine/effacer", { method: "POST" });
  if (!res.ok) {
    const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  }
}

/**
 * L'écran de la machine, en image, sous forme d'URL locale à afficher.
 * `null` si la machine ne répond pas. L'appelant libère l'URL précédente.
 */
export async function ecranMachine(): Promise<string | null> {
  try {
    const res = await apiFetch("/oxoai/machine/ecran");
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}
