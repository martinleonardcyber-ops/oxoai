import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Atelier bureautique de Cowork, côté interface.
 *
 * L'agent ne prépare rien lui-même : la passerelle exécute une liste de
 * paquets figée dans son code. L'interface se contente de montrer ce qui
 * manque, d'annoncer l'impact avant d'installer, et de suivre la progression.
 */

export interface OutilSysteme {
  id: "python3" | "pip" | "node" | "npm";
  nom: string;
  present: boolean;
  version?: string;
  chemin?: string;
}

export interface OutilOptionnel {
  id: "libreoffice" | "poppler";
  nom: string;
  present: boolean;
  apport: string;
  obtention: string;
}

export interface Bibliotheque {
  nom: string;
  usage: string;
  ecosysteme: "python" | "node";
  installee: boolean;
  version?: string;
}

export interface Diagnostic {
  racine: string;
  systeme: OutilSysteme[];
  bibliotheques: Bibliotheque[];
  optionnels: OutilOptionnel[];
  pret: boolean;
  installable: boolean;
  obstacles: string[];
  tailleEstimeeMo: number;
}

export interface Progres {
  phase: "verification" | "python" | "node" | "termine" | "erreur";
  message: string;
  percent: number;
  detail?: string;
}

export interface Etape {
  id: "python" | "node";
  ok: boolean;
  message: string;
}

export interface Bilan {
  ok: boolean;
  duree: number;
  etapes: Etape[];
  diagnostic: Diagnostic;
}

export interface Epreuve {
  id: string;
  libelle: string;
  ok: boolean;
  detail: string;
}

export interface Verification {
  ok: boolean;
  message: string;
  epreuves: Epreuve[];
}

/** Inventaire de la machine. `null` si la passerelle ne répond pas. */
export async function diagnostic(): Promise<Diagnostic | null> {
  try {
    const res = await apiFetch("/oxoai/atelier");
    if (!res.ok) return null;
    return (await res.json()) as Diagnostic;
  } catch {
    return null;
  }
}

/**
 * Lance la préparation et suit sa progression.
 *
 * La réponse est un flux d'événements servi par la requête elle-même : une
 * seule fenêtre demande, une seule attend. `EventSource` ne sachant pas
 * envoyer de POST, on lit le corps de la réponse au fil de l'eau.
 */
export async function preparer(onProgres: (p: Progres) => void): Promise<Bilan> {
  const res = await apiFetch("/oxoai/atelier/preparer", { method: "POST" });

  if (!res.ok) {
    const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? tf("La préparation a été refusée ({0}).", res.status));
  }
  if (!res.body) throw new Error(t("La passerelle n'a envoyé aucun flux de progression."));

  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder();
  let tampon = "";
  let bilan: Bilan | null = null;
  let erreur: string | null = null;

  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    tampon += decodeur.decode(value, { stream: true });

    // Les événements sont séparés par une ligne vide.
    const evenements = tampon.split("\n\n");
    tampon = evenements.pop() ?? "";

    for (const evenement of evenements) {
      for (const ligne of evenement.split("\n")) {
        if (!ligne.startsWith("data:")) continue;
        try {
          const trame = JSON.parse(ligne.slice(5).trim()) as
            | ({ type: "progres" } & Progres)
            | { type: "bilan"; bilan: Bilan }
            | { type: "erreur"; message: string };
          if (trame.type === "progres") onProgres(trame);
          else if (trame.type === "bilan") bilan = trame.bilan;
          else erreur = trame.message;
        } catch {
          /* fragment illisible : la trame suivante fera foi */
        }
      }
    }
  }

  if (erreur) throw new Error(erreur);
  if (!bilan) throw new Error(t("La préparation s'est interrompue sans rendre de bilan."));
  return bilan;
}

/** Épreuves fonctionnelles : produire puis relire un document de chaque format. */
export async function verifier(): Promise<Verification> {
  const res = await apiFetch("/oxoai/atelier/verifier", { method: "POST" });
  if (!res.ok) {
    const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? tf("Vérification impossible ({0}).", res.status));
  }
  return (await res.json()) as Verification;
}
