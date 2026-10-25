import { instance } from "./instance";
import { langue } from "./i18n";
import { ecrireSecret, lireSecret } from "./coffre";

/**
 * Accès à la passerelle.
 *
 * - **Poste rattaché à une instance** : on vise son adresse, que ce soit le
 *   cluster de l'entreprise ou un serveur on-premise. Le poste n'a alors besoin
 *   d'aucun modèle installé.
 * - **Poste autonome, en développement** : « /api », relayé par le proxy Vite.
 * - **Poste autonome, application empaquetée** : l'interface est servie par
 *   l'application elle-même, sous `oxoai://app`, où un chemin relatif ne
 *   pointerait pas vers la passerelle.
 *
 * Toutes les requêtes portent le jeton d'instance : la passerelle donne accès
 * aux données de l'entreprise et à l'exécution d'outils, elle refuse tout appel
 * non authentifié.
 */
function resolve(): string {
  const configured = instance();
  if (configured.remote) return configured.url;

  /*
   * Servie par le serveur de développement (http), l'interface passe par son
   * proxy « /api ». Servie autrement — `oxoai://` dans l'application livrée,
   * `file://` pour les anciennes versions — il n'y a pas de proxy : on vise
   * l'adresse de la passerelle en entier.
   */
  const parUnServeurWeb =
    typeof window !== "undefined" && /^https?:$/.test(window.location.protocol);
  return parUnServeurWeb ? "/api" : configured.url;
}

export const GATEWAY_BASE: string = resolve();

/** Jeton courant, relu à chaque appel (il peut arriver après le démarrage). */
export function authToken(): string | undefined {
  return instance().token;
}

/*
 * Jeton de séance.
 *
 * Le jeton d'instance dit « cette machine a le droit de parler ». Celui-ci dit
 * « et voici qui parle » : c'est lui qui permet à l'instance de ne renvoyer que
 * les données de la personne connectée. Il expire, se révoque depuis les
 * réglages, et vit dans le trousseau du système quand il y en a un
 * (`lib/coffre.ts`) plutôt qu'en clair dans le stockage du navigateur.
 */
const CLE_SEANCE = "oxoai:session-token";

export function sessionToken(): string | undefined {
  return lireSecret(CLE_SEANCE);
}

export function setSessionToken(token: string | null): void {
  ecrireSecret(CLE_SEANCE, token);
}

/** En-têtes d'authentification à joindre à une requête. */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const session = sessionToken();
  if (session) headers["X-OxoAI-Session"] = session;
  /*
   * La langue de lecture de ce poste. L'instance sert plusieurs personnes, qui
   * ne lisent pas toutes la même : ses messages sont donc traduits par requête,
   * pas une fois pour toutes (gateway/src/langue.ts).
   */
  headers["X-OxoAI-Langue"] = langue();
  return headers;
}

/**
 * Émis quand l'instance ne reconnaît plus la séance de ce poste.
 *
 * Sans ce signal, l'application continuait de se croire connectée pendant que
 * le serveur refusait tout : l'utilisateur voyait son nom en bas de l'écran et
 * des erreurs incompréhensibles partout — « Dossiers illisibles », listes
 * vides — sans jamais comprendre qu'il devait se reconnecter.
 */
export const SEANCE_EXPIREE = "oxoai:seance-expiree";

/**
 * `fetch` vers la passerelle, jeton inclus.
 * À utiliser partout : c'est ce qui garantit qu'aucun appel ne part sans
 * autorisation.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const avaitSeance = Boolean(sessionToken());
  const res = await fetch(`${GATEWAY_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });

  /*
   * 401 alors qu'on présentait une séance : elle a expiré, été révoquée, ou
   * l'instance a été réinstallée. On l'oublie et on prévient l'application, qui
   * ramènera à l'écran de connexion. Le jeton d'instance, lui, reste valable.
   */
  if (res.status === 401 && avaitSeance) {
    setSessionToken(null);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(SEANCE_EXPIREE));
    }
  }
  return res;
}

/*
 * Les flux d'évènements ne passent plus par ici.
 *
 * `eventStreamUrl` posait le jeton d'instance et le jeton de séance dans
 * l'adresse, faute de pouvoir mettre des en-têtes sur un `EventSource`. Deux
 * secrets de longue durée dans une URL, donc dans les journaux d'accès de tout
 * intermédiaire. Ils sont remplacés par un billet à usage unique, valable une
 * minute, demandé par une requête normale : voir `lib/flux.ts` et
 * `gateway/src/flux.ts`.
 */
