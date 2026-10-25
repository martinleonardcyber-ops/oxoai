import type http from "node:http";

/**
 * En-têtes de sécurité et d'origine, en un seul endroit.
 *
 * Ils vivaient dans `index.ts`, mais le flux de conversation est servi depuis
 * `chat.ts`, qui écrivait donc les siens à la main — et les avait figés sur
 * `Access-Control-Allow-Origin: *`. Les importer depuis `index.ts` aurait créé
 * un cycle, `index` important déjà `chat`. D'où ce module : un seul endroit
 * pour une règle qui doit valoir partout.
 */

/**
 * En-têtes présents sur toutes les réponses — **y compris les flux
 * d'évènements**, ce qui n'était pas le cas.
 *
 * La passerelle ne sert que du JSON et des flux d'évènements : rien ne doit
 * être interprété comme du contenu à afficher, ni encadré dans une page tierce.
 *
 * Cette affirmation était fausse : quatre réponses ouvraient leur en-tête à la
 * main — `provision/stream`, `computer/events`, `code/events`,
 * `approbation/evenements` — plus la relance de `code/prompt`, et n'en
 * portaient aucun (mesuré : quatre lignes d'en-tête, aucune de sécurité). Elles
 * passent désormais toutes par `entetesFlux` ou par `send`.
 *
 * `Cross-Origin-Resource-Policy: same-site` ne gêne pas ces flux : le contrôle
 * de politique de ressource ne s'applique qu'aux requêtes en mode `no-cors`, et
 * `EventSource` comme `fetch` demandent le mode `cors`. Vérifié au navigateur,
 * depuis `file://` et depuis une origine http distincte : les évènements
 * arrivent.
 */
export const ENTETES_SECURITE = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-site",
  /*
   * Les réponses portent conversations, profils, exports RGPD : aucune ne doit
   * rester dans un cache disque du navigateur ou d'un proxy, où elle
   * survivrait à la déconnexion.
   */
  "Cache-Control": "no-store",
} as const;

/**
 * Origines auxquelles l'instance répond, quand un navigateur en annonce une.
 *
 * `Access-Control-Allow-Origin: *` était renvoyé à tout le monde. Ce n'était
 * pas une faille en soi — le jeton et la séance voyagent dans des en-têtes que
 * le navigateur n'ajoute jamais de lui-même — mais une page quelconque ouverte
 * par un collègue pouvait au moins lire les réponses des routes publiques, et
 * une origine explicite ne coûte rien.
 *
 * Quatre cas légitimes, et rien d'autre :
 *
 *  - **l'application de bureau** sert son interface sous `oxoai://app` depuis
 *    la 0.23.0 (`electron/main.cjs`, `servirInterface`). Aucune page du web ne
 *    peut porter cette origine : le schéma n'existe que dans l'application ;
 *  - **une application de bureau antérieure** chargeait la sienne depuis
 *    `file://`, ce que le navigateur annonce par l'origine opaque `null` ;
 *  - **le serveur de développement** sert la même interface depuis la boucle
 *    locale, `http://localhost:5173` (Vite en choisit un autre port quand
 *    celui-ci est pris : toute la boucle locale est donc admise, et une origine
 *    de boucle locale suppose déjà un processus sur la machine) ;
 *  - **un poste rattaché** charge l'interface depuis l'adresse de son instance,
 *    donc depuis cette passerelle elle-même : l'origine vaut alors son propre
 *    hôte.
 *
 * Sans en-tête `Origin` — curl, OpenCode, tout client hors navigateur — il n'y
 * a rien à autoriser : aucun `Access-Control-Allow-Origin` n'est posé, et cela
 * ne change rien pour eux, puisque seul un navigateur lit cet en-tête.
 */
/** Origine de l'interface servie par l'application de bureau (electron/main.cjs). */
const ORIGINE_APPLICATION = "oxoai://app";

function origineAutorisee(req: http.IncomingMessage): string | null {
  const origine = req.headers.origin;
  if (typeof origine !== "string" || origine === "") return null;

  /*
   * L'interface de l'application de bureau, depuis la 0.23.0.
   *
   * Elle est servie par l'application elle-même sous `oxoai://app`, une
   * origine qu'aucune page du web ne peut porter : le schéma n'existe que
   * dans l'application, déclaré par son propre processus. L'admettre revient
   * donc à admettre l'interface livrée, et rien d'autre. Le jeton d'instance
   * reste exigé par ailleurs.
   */
  if (origine === ORIGINE_APPLICATION) return origine;

  /*
   * `file://` : le navigateur envoie littéralement « null ». C'était l'origine
   * de l'interface jusqu'à la 0.22.0 incluse ; conservée pour qu'un poste
   * resté sur une version antérieure continue de parler à une instance mise à
   * jour.
   */
  if (origine === "null") return "null";

  let url: URL;
  try {
    url = new URL(origine);
  } catch {
    // Origine illisible : on n'autorise pas ce qu'on ne comprend pas.
    return null;
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    const hote = url.hostname;
    if (hote === "localhost" || hote === "127.0.0.1" || hote === "[::1]" || hote === "::1") {
      return origine;
    }
    // L'instance elle-même : `Host` porte l'adresse par laquelle on l'atteint.
    const propre = req.headers.host;
    if (propre && (origine === `http://${propre}` || origine === `https://${propre}`)) {
      return origine;
    }
  }

  return null;
}

/**
 * En-têtes de partage entre origines.
 *
 * `Vary: Origin` est posé même quand rien n'est autorisé : la réponse dépend de
 * l'origine demandée, et un cache partagé ne doit jamais resservir à un poste
 * la réponse préparée pour un autre.
 */
export function entetesOrigine(req: http.IncomingMessage): Record<string, string> {
  const permise = origineAutorisee(req);
  return permise ? { "Access-Control-Allow-Origin": permise, Vary: "Origin" } : { Vary: "Origin" };
}

/**
 * En-tête d'une réponse en flux d'évènements.
 *
 * Écrit à un seul endroit : c'est ce qui garantit qu'un flux ajouté plus tard
 * porte les en-têtes de sécurité sans que personne ait à y penser. Les quatre
 * flux existants les avaient tous oubliés, chacun à sa façon.
 */
export function entetesFlux(req: http.IncomingMessage): Record<string, string | number> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    ...entetesOrigine(req),
    ...ENTETES_SECURITE,
    // Après les en-têtes communs : un flux ne doit pas non plus être transformé
    // (compressé, donc mis en attente) par un intermédiaire.
    "Cache-Control": "no-store, no-transform",
  };
}
