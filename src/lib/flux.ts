import { apiFetch, GATEWAY_BASE } from "./endpoint";
import { langue } from "./i18n";

/**
 * Flux d'évènements de l'instance.
 *
 * `EventSource` ne sait pas poser d'en-tête : l'adresse était donc la seule
 * façon de s'authentifier, et elle portait le jeton d'instance et le jeton de
 * séance. Deux secrets à longue durée de vie, dans une URL, c'est-à-dire dans
 * les journaux d'accès de tout intermédiaire.
 *
 * Désormais l'interface demande un **billet** par une requête normale, avec ses
 * en-têtes, et ne pose que lui dans l'adresse : une valeur à usage unique, qui
 * vaut une minute (`gateway/src/flux.ts`).
 *
 * Conséquence : la reconnexion automatique d'`EventSource` ne peut plus rejouer
 * la même adresse, puisque le billet est consommé. C'est donc ce module qui
 * rouvre, avec un billet neuf, en espaçant les tentatives. Ce n'est pas une
 * perte : la reconnexion du navigateur était muette et sans limite.
 */

/** Premier délai de reprise, doublé à chaque échec, plafonné. */
const REPRISE_MS = 1_000;
const REPRISE_MAX_MS = 30_000;

/**
 * Un billet d'une minute et d'un seul usage.
 *
 * Exporté : le téléchargement de l'application en a besoin pour la même
 * raison que les flux — un lien ouvert dans le navigateur ne porte pas
 * d'en-tête, et les jetons n'ont rien à faire dans une adresse.
 */
export async function billet(): Promise<string | null> {
  try {
    const res = await apiFetch("/oxoai/flux/ticket", { method: "POST" });
    if (!res.ok) return null;
    const corps = (await res.json()) as { billet?: string };
    return corps.billet ?? null;
  } catch {
    return null;
  }
}

/**
 * Ouvre un flux et rappelle `onEvent` à chaque trame. Rend de quoi le fermer.
 *
 * L'ouverture est asynchrone (il faut le billet) mais l'appelant n'a rien à
 * attendre : fermer avant que le flux soit ouvert annule l'ouverture.
 */
export function ouvrirFlux(
  chemin: string,
  onEvent: (donnees: string) => void,
  options: {
    onOuvert?: () => void;
    /**
     * Rouvrir après une coupure. Vrai par défaut. Certains flux ne le veulent
     * pas : celui de l'agent de code, par exemple, doit rendre la main à la
     * conversation plutôt que d'attendre en silence.
     */
    reprendre?: boolean;
    /** Appelé à chaque coupure, avant une éventuelle reprise. */
    onErreur?: () => void;
  } = {},
): () => void {
  let ferme = false;
  let source: EventSource | null = null;
  let attente: ReturnType<typeof setTimeout> | null = null;
  let delai = REPRISE_MS;

  const reprendre = () => {
    if (ferme || options.reprendre === false) return;
    attente = setTimeout(() => void ouvrir(), delai);
    delai = Math.min(delai * 2, REPRISE_MAX_MS);
  };

  const ouvrir = async () => {
    if (ferme) return;
    const b = await billet();
    if (ferme) return;
    if (!b) {
      options.onErreur?.();
      return reprendre();
    }

    const separateur = chemin.includes("?") ? "&" : "?";
    /*
     * La langue voyage ici dans l'adresse, faute de pouvoir poser un en-tête
     * sur un `EventSource`. Elle ne dit rien de secret — contrairement aux
     * jetons, que le billet remplace justement pour cette raison.
     */
    source = new EventSource(
      `${GATEWAY_BASE}${chemin}${separateur}flux=${encodeURIComponent(b)}&langue=${langue()}`,
    );
    source.onopen = () => {
      // Une connexion qui tient remet le compteur de reprise à zéro.
      delai = REPRISE_MS;
      options.onOuvert?.();
    };
    source.onmessage = (message) => {
      try {
        onEvent(message.data);
      } catch {
        /* une trame illisible ne doit pas casser l'abonnement */
      }
    };
    source.onerror = () => {
      source?.close();
      source = null;
      options.onErreur?.();
      reprendre();
    };
  };

  void ouvrir();

  return () => {
    ferme = true;
    if (attente) clearTimeout(attente);
    source?.close();
    source = null;
  };
}
