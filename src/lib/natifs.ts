import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Google Sheets, Google Slides, YouTube, LinkedIn, Facebook, Instagram,
 * TikTok, X et Microsoft 365 (gateway/src/oauthNatif.ts). Aucun jeton ni
 * secret ne revient par ici : le secret d'une application part une fois, à
 * l'enregistrement, et l'instance le garde chiffré.
 */

// Brevo et Mailchimp : 28/09/2026 (gateway/src/natifs/projetsRegles.ts). `envoi` : envoyer une campagne.
// `linkedinPage` : la Page d'entreprise LinkedIn, par sa propre application (29/09/2026).
export type IdNatif = "sheets" | "slides" | "youtube" | "linkedin" | "linkedinPage" | "facebook" | "instagram" | "tiktok" | "x" | "docs" | "forms" | "dropbox" | "brevo" | "mailchimp";
/**
 * Microsoft 365 (28/09/2026) : une seule connexion pour Outlook, OneDrive,
 * SharePoint, Excel, Word et Teams, avec son propre panneau
 * (ConnecteurMicrosoft.tsx). Elle reste hors de `IdNatif`, que le panneau
 * commun (ConnecteurNatif.tsx) parcourt service par service.
 */
export type ServiceMicrosoft = "outlook" | "onedrive" | "sharepoint" | "excel" | "word" | "teams";
export type IdNatifTous = IdNatif | "microsoft";
/** `page` : l'ancienne case de LinkedIn (retirée le 29/09/2026), qu'un compte branché avant peut encore porter dans `accordes`. */
export type IdChoix = "ecriture" | "page" | "envoi" | ServiceMicrosoft;

export interface EtatNatif {
  id: IdNatifTous;
  nom: string;
  google: boolean;
  /** `annuaire` : Microsoft 365 seulement (identifiant de l'annuaire Entra, domaine ou « common »). */
  application: { disponible: boolean; identifiant?: string; avecSecret?: boolean; source?: "google" | "ecran"; annuaire?: string };
  /** `ecriture` : portées ajoutées si l'écriture est cochée ; `admin` : consentement de l'administrateur de l'annuaire (Microsoft 365). */
  choix: { id: IdChoix; portees: string[]; revue: boolean; ecriture?: string[]; admin?: boolean }[];
  lecture: string[];
  retour: string;
  configure: boolean;
  compte?: string;
  accordes?: IdChoix[];
  depuis?: string;
  expireLe?: string;
  aReconnecter: boolean;
  attente: boolean;
  issue?: { ok: boolean; message: string; quand: string };
  documentation: string[];
}

export interface EtatNatifs {
  services: EtatNatif[];
  administrateur: boolean;
}

export interface ResultatNatif {
  ok: boolean;
  message: string;
  url?: string;
  etat?: EtatNatifs;
}

export async function etatNatifs(): Promise<EtatNatifs | null> {
  try {
    const res = await apiFetch("/oxoai/natifs");
    if (!res.ok) return null;
    return (await res.json()) as EtatNatifs;
  } catch {
    return null;
  }
}

async function poster(suite: string, corps: Record<string, unknown>): Promise<ResultatNatif> {
  try {
    const res = await apiFetch(`/oxoai/natifs${suite}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    const json = (await res.json().catch(() => ({}))) as Partial<ResultatNatif> & Partial<EtatNatifs> & { error?: { message?: string } };
    if (json.error?.message) return { ok: false, message: json.error.message };
    return {
      ok: json.ok === true,
      message: json.message ?? tf("La demande a échoué ({0}).", res.status),
      url: typeof json.url === "string" ? json.url : undefined,
      etat: Array.isArray(json.services) ? { services: json.services, administrateur: json.administrateur === true } : undefined,
    };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez.") };
  }
}

export const enregistrerApplication = (service: IdNatifTous, clientId: string, clientSecret: string, annuaire?: string) =>
  poster("/application", { service, clientId, clientSecret, ...(annuaire !== undefined ? { annuaire } : {}) });
export const effacerApplication = (service: IdNatifTous) => poster("/application/effacer", { service });
export const connecterNatif = (service: IdNatifTous, choix: IdChoix[]) => poster("/connecter", { service, choix });
export const collerAdresseNatif = (service: IdNatifTous, adresse: string) => poster("/code", { service, adresse });
export const oublierNatif = (service: IdNatifTous) => poster("/oublier", { service });
