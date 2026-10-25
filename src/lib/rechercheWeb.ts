import { apiFetch } from "./endpoint";

/**
 * Recherche sur le web du Chat (gateway/src/rechercheWeb.ts, 28/09/2026), vue
 * de l'interface : permise ou non sur cette instance, et le moteur auquel les
 * questions partent, que la puce et le menu « + » nomment.
 */

export interface EtatRechercheWeb {
  autorisee: boolean;
  /** Le service qui reçoit les questions (« DuckDuckGo »). */
  moteur: string;
  /** Pourquoi elle est désactivée, quand elle l'est. */
  raison?: string;
}

/** Une source du web sous une réponse : son numéro (cité « [n] » dans la réponse), son titre, son adresse, et si la page a été ouverte. */
export interface SourceWeb {
  n: number;
  titre: string;
  adresse: string;
  lue: boolean;
}

/** `null` : l'instance ne répond pas, ou ne connaît pas encore la recherche sur le web (version plus ancienne). */
export async function etatRechercheWeb(): Promise<EtatRechercheWeb | null> {
  try {
    const res = await apiFetch("/oxoai/recherche-web");
    return res.ok ? ((await res.json()) as EtatRechercheWeb) : null;
  } catch {
    return null;
  }
}

/**
 * Une adresse qu'on peut mettre dans un lien : http ou https seulement. Les
 * sources sont gardées avec le Chat et le suivent chez qui on le partage ;
 * un `javascript:` glissé dans des données synchronisées ne devient pas un lien.
 */
export function lienSur(adresse: string): string | null {
  try {
    const u = new URL(adresse);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Le nom du site, pour l'afficher à côté du titre. */
export function siteDe(adresse: string): string {
  try {
    return new URL(adresse).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
