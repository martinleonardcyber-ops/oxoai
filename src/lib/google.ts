import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * L'application Google de l'instance (gateway/src/clientGoogle.ts), partagée par
 * Google Drive et Google Agenda, et le connecteur Google Agenda
 * (gateway/src/agendaGoogle.ts). Aucun jeton ni secret ne revient par ici : le
 * secret part une fois, à l'enregistrement, et l'instance le garde chiffré.
 */

export interface EtatClientGoogle {
  disponible: boolean;
  source?: "config" | "ecran";
  identifiant?: string;
  avecSecret?: boolean;
  /** La personne peut-elle l'enregistrer ou le retirer (administrateur) ? */
  modifiable?: boolean;
}

export interface EtatAgendaGoogle {
  configure: boolean;
  ecriture?: boolean;
  compte?: string;
  depuis?: string;
  aReconnecter: boolean;
  attente: boolean;
  issue?: { ok: boolean; message: string; quand: string };
  client: EtatClientGoogle;
}

export interface Resultat {
  ok: boolean;
  message: string;
  url?: string;
}

async function lire<T>(chemin: string): Promise<T | null> {
  try {
    const res = await apiFetch(chemin);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function poster(chemin: string, corps?: unknown): Promise<Resultat> {
  try {
    const res = await apiFetch(chemin, {
      method: "POST",
      ...(corps !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<Resultat> & { error?: { message?: string } };
    if (json.error?.message) return { ok: false, message: json.error.message };
    return { ok: json.ok === true, message: json.message ?? tf("La demande a échoué ({0}).", res.status), url: typeof json.url === "string" ? json.url : undefined };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez.") };
  }
}

export const etatClientGoogle = () => lire<EtatClientGoogle>("/oxoai/google/client");
export const enregistrerClientGoogle = (clientId: string, clientSecret: string) => poster("/oxoai/google/client", { clientId, clientSecret });
export const effacerClientGoogle = () => poster("/oxoai/google/client/effacer");

export const etatAgendaGoogle = () => lire<EtatAgendaGoogle>("/oxoai/agenda/google");
export const connecterAgendaGoogle = (ecriture: boolean) => poster("/oxoai/agenda/google/connecter", { ecriture });
export const collerAdresseAgendaGoogle = (adresse: string) => poster("/oxoai/agenda/google/code", { adresse });
export const oublierAgendaGoogle = () => poster("/oxoai/agenda/google/oublier");
