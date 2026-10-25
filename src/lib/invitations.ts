import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Inviter un collègue, et rejoindre une instance sur invitation.
 *
 * Le parcours tient en trois gestes, et c'est voulu : une personne déjà là
 * tape une adresse, le collègue reçoit un mail, il saisit l'adresse de
 * l'instance et son code. Il n'a **jamais** à recopier le jeton d'instance, et
 * il choisit **lui-même** son mot de passe : personne d'autre ne le connaît,
 * pas même celui qui l'a invité.
 *
 * Le détail du code (durée, usage unique, adresse liée) est dans
 * `gateway/src/invitations.ts`.
 */

/** Quatre groupes de quatre, tirés d'un alphabet sans caractères ambigus. */
const FORME_CODE = /^[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}$/;

/** La valeur saisie ressemble-t-elle à un code, plutôt qu'à un jeton d'instance ? */
export const estCodeInvitation = (valeur: string): boolean => FORME_CODE.test(valeur.trim());

/**
 * Un lien d'invitation collé, décomposé en adresse et code.
 *
 * Le clic est la voie normale : le système réveille l'application et remplit
 * les deux champs. Mais un lien `oxoai://` ne s'ouvre que si l'application est
 * déjà installée, et certaines messageries le rendent en texte mort. La
 * personne fait alors ce que tout le monde fait — elle le copie et le colle —
 * et le champ doit comprendre, au lieu de répondre « adresse invalide ».
 *
 * On accepte aussi l'adresse seule : coller `https://poste.local:8787` dans le
 * champ du code n'est pas une erreur à signaler, c'est un champ à remplir.
 */
export function lireLienInvitation(
  colle: string,
): { adresse?: string; code?: string } | null {
  const texte = colle.trim();
  if (!texte) return null;
  try {
    const url = new URL(texte);
    if (url.protocol === "oxoai:" && url.host === "rejoindre") {
      const champs = new URLSearchParams(url.hash.replace(/^#/, ""));
      const adresse = champs.get("a")?.trim();
      const code = champs.get("c")?.trim();
      if (!adresse && !code) return null;
      return {
        ...(adresse ? { adresse } : {}),
        ...(code && estCodeInvitation(code) ? { code } : {}),
      };
    }
    if (url.protocol === "http:" || url.protocol === "https:") return { adresse: url.origin };
  } catch {
    /* pas une URL : peut-être un code nu, traité ci-dessous */
  }
  return estCodeInvitation(texte) ? { code: texte } : null;
}

/** Ce que porte un lien d'invitation, une fois ouvert par l'application. */
export interface InvitationRecue {
  adresse: string;
  code: string;
}

/**
 * S'abonne aux liens `oxoai://rejoindre` ouverts depuis le système.
 *
 * Hors application native — navigateur, développement — il n'y a pas de pont :
 * l'abonnement ne sert alors à rien, et le dit en ne faisant rien. La voie
 * manuelle, elle, reste toujours là.
 */
export function surInvitation(rappel: (invitation: InvitationRecue) => void): () => void {
  const pont = (
    window as unknown as {
      oxoai?: { surInvitation?: (r: (i: InvitationRecue) => void) => () => void };
    }
  ).oxoai?.surInvitation;
  if (!pont) return () => undefined;
  return pont((invitation) => {
    if (invitation && typeof invitation.adresse === "string" && typeof invitation.code === "string") {
      rappel(invitation);
    }
  });
}

export interface Invitation {
  email: string;
  creeLe: string;
  expire: string;
}

export interface InvitationCreee {
  /** Absent quand le mail est parti : il reste dans la boîte de l'invitée (revue du 26/09/2026). */
  code?: string;
  email: string;
  expire: string;
  /** Le mail est-il réellement parti ? */
  envoye: boolean;
  /** Pourquoi il n'est pas parti, le cas échéant. */
  motif?: string;
  adresse: string;
  /** Lien `oxoai://rejoindre` : une seule chose à transmettre, au lieu de deux. */
  lien?: string;
}

/** Ce que rend une invitation de projet : le membre, et le sort du mail. */
export interface ResultatInvitation {
  ok: boolean;
  reason?: string;
  /** La personne avait déjà un compte : rien n'a été envoyé, elle est membre. */
  immediate?: boolean;
  invitation?: InvitationCreee;
  echecInvitation?: string;
}

export async function inviter(
  email: string,
): Promise<{ ok: true; valeur: InvitationCreee } | { ok: false; message: string }> {
  try {
    const res = await apiFetch("/oxoai/invitations/inviter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const corps = (await res.json().catch(() => ({}))) as Partial<InvitationCreee> & {
      error?: { message?: string };
    };
    // Le code n'est rendu que si le mail n'a pas pu partir : c'est l'adresse qui dit que l'invitation existe.
    if (!res.ok || !corps.email) {
      return { ok: false, message: corps.error?.message ?? t("Invitation impossible.") };
    }
    return { ok: true, valeur: corps as InvitationCreee };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}

export async function invitationsEnAttente(): Promise<Invitation[]> {
  try {
    const res = await apiFetch("/oxoai/invitations");
    if (!res.ok) return [];
    return ((await res.json()) as { invitations?: Invitation[] }).invitations ?? [];
  } catch {
    return [];
  }
}

/** Le compte connecté est-il l'administrateur de l'instance ? `false` si l'instance ne répond pas. */
export async function suisAdministrateur(): Promise<boolean> {
  try {
    const res = await apiFetch("/oxoai/invitations");
    if (!res.ok) return false;
    return ((await res.json()) as { administrateur?: boolean }).administrateur === true;
  } catch {
    return false;
  }
}

export async function annulerInvitation(email: string): Promise<boolean> {
  try {
    const res = await apiFetch("/oxoai/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Rattache ce poste à une instance avec un code.
 *
 * Seul appel du produit qui vise une adresse **avant** de savoir si elle est
 * la bonne : il ne passe donc pas par `apiFetch`, qui suppose une instance
 * déjà configurée. Il ne porte aucun secret, sinon le code lui-même.
 */
export async function rejoindreAvecCode(
  adresse: string,
  code: string,
): Promise<{ ok: true; jeton: string; email: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${adresse.replace(/\/+$/, "")}/oxoai/invitations/rejoindre`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
      signal: AbortSignal.timeout(8000),
    });
    const corps = (await res.json().catch(() => ({}))) as {
      jeton?: string;
      email?: string;
      error?: { message?: string };
    };
    if (!res.ok || !corps.jeton || !corps.email) {
      return { ok: false, message: corps.error?.message ?? tf("L'instance a répondu {0}.", res.status) };
    }
    return { ok: true, jeton: corps.jeton, email: corps.email };
  } catch {
    return {
      ok: false,
      message: t("Instance injoignable à cette adresse. Vérifiez-la auprès de la personne qui vous a invité."),
    };
  }
}

/*
 * Invitation en cours de parcours, entre le rattachement du poste et la
 * création du compte. Dans le stockage de session : elle ne survit pas à la
 * fermeture de l'application, ce qui est exactement sa durée de vie utile.
 */
const CLE = "oxoai:invitation-en-cours";

export function retenirInvitation(code: string, email: string): void {
  try {
    sessionStorage.setItem(CLE, JSON.stringify({ code, email }));
  } catch {
    /* stockage indisponible : la personne ressaisira son code */
  }
}

export function invitationEnCours(): { code: string; email: string } | null {
  try {
    const brut = sessionStorage.getItem(CLE);
    return brut ? (JSON.parse(brut) as { code: string; email: string }) : null;
  } catch {
    return null;
  }
}

export function oublierInvitation(): void {
  try {
    sessionStorage.removeItem(CLE);
  } catch {
    /* rien à oublier */
  }
}
