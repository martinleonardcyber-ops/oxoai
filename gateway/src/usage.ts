import { db } from "./db.ts";
import { tousLesBackends } from "./config.ts";
import { models } from "./router.ts";
import { journaliser } from "./audit.ts";
import type { BackendKind, ModelInfo } from "./types.ts";
import { t, tf } from "./langue.ts";
import { fournisseurDuBackend, prixPublie, type Devise } from "./prixPublies.ts";

/**
 * Consommation des modèles : ce que l'écran « Mon usage » affiche.
 *
 * Cet écran a longtemps montré un budget, une courbe de coûts et une table de
 * modèles entièrement inventés, alors que la passerelle ne comptait rien. Un
 * tableau de bord faux est pire qu'un écran vide : il a l'air d'une mesure.
 * Tout ce qui est rendu ici vient donc de trois sources, et de trois seulement :
 *
 *  1. **Les jetons lus dans la réponse du moteur.** Un moteur compatible OpenAI
 *     (LM Studio, et les hébergeurs européens : Mistral, Scaleway, OVH) renvoie
 *     `usage` quand on le lui demande par `stream_options.include_usage`. Ce
 *     sont ses propres chiffres, pas les nôtres.
 *  2. **Une estimation, marquée comme telle**, quand le moteur ne dit rien :
 *     elle part du nombre de caractères. Elle ne se confond jamais avec une
 *     mesure : les deux sont additionnées dans des compteurs séparés, et
 *     l'écran dit laquelle il affiche.
 *  3. **Les tarifs des modèles distants**, dans cet ordre :
 *      - un tarif saisi à la main, qui l'emporte toujours et est marqué comme
 *        tel, dans sa devise (euros pour un tarif saisi avant que la devise
 *        existe : c'était la seule que l'écran proposait) ;
 *      - sinon, le prix publié par le fournisseur qui sert le modèle
 *        (prixPublies.ts), avec la même correspondance de noms que les notes
 *        (« cle-…/ », suffixes de date : nomsModeles.ts). L'écran écrit « prix
 *        publié par {fournisseur}, relevé du {date} », avec le lien, et dit le
 *        coût « estimé » : cache, lots et paliers gratuits n'y sont pas ;
 *      - sinon, « tarif non renseigné », et rien n'est compté : jamais zéro.
 *     Un modèle local n'a toujours pas de tarif.
 *
 *     Jusqu'au 27/09/2026, il n'y avait **aucun prix par défaut** : un tarif
 *     recopié serait faux le jour où l'hébergeur le change. Medhi a changé la
 *     règle ce jour-là (« dans mon usage ça serait sympa d'avoir le tarif de
 *     tous les modèles cloud ») ; le risque demeure, et l'écran le dit par la
 *     date du relevé et le lien vers la page.
 *
 * Les devises ne se convertissent pas : aucun taux n'est inventé. Chaque coût
 * reste dans la devise de son tarif, et les totaux se font devise par devise
 * (« 1,20 $ + 0,30 € »).
 */

/* ------------------------------------------------------------------ */
/* Local ou distant                                                    */
/* ------------------------------------------------------------------ */

/**
 * Un modèle local tourne sur le matériel du client : son poste (LM Studio) ou
 * son cluster (exo). Il ne coûte aucun frais d'API, seulement l'électricité et
 * la machine, que l'instance ne mesure pas et ne prétend pas mesurer.
 *
 * Tout backend compatible OpenAI ajouté par le profil de déploiement est tenu
 * pour distant, même s'il tourne en réalité dans la salle serveur du client :
 * l'instance ne peut pas le savoir. Dans ce cas, renseigner un tarif de 0 € le
 * dit explicitement, plutôt que de le supposer.
 */
export function estLocal(kind: BackendKind | string | undefined): boolean {
  return kind === "lmstudio" || kind === "llamacpp" || kind === "exo";
}

/* ------------------------------------------------------------------ */
/* Registre                                                            */
/* ------------------------------------------------------------------ */

interface Compteurs {
  requetes: number;
  entree: number;
  sortie: number;
  /** Part de `sortie` passée à raisonner, quand le moteur la précise. */
  raisonnement: number;
}

interface Ligne {
  backend: string;
  local: boolean;
  /** Jetons lus dans la réponse du moteur. */
  exact: Compteurs;
  /** Jetons estimés faute de réponse du moteur. Jamais mêlés aux premiers. */
  estime: Compteurs;
}

/** Jour (AAAA-MM-JJ, heure de l'instance), puis compte, puis modèle (uid). */
type Jours = Record<string, Record<string, Record<string, Ligne>>>;

interface Registre {
  version: 1;
  jours: Jours;
}

interface Tarif {
  /** Par million de jetons d'entrée, dans `devise`. */
  entree: number;
  /** Par million de jetons de sortie, dans `devise`. */
  sortie: number;
  /** Absente d'un tarif saisi avant le 27/09/2026 : c'était alors toujours des euros. */
  devise?: Devise;
  /** Horodatage ISO de la saisie. */
  depuis: string;
  /** Compte qui l'a saisi. */
  par: string;
}

/**
 * Compte sous lequel ranger une requête sans séance.
 *
 * L'écran Code passe par OpenCode, qui présente le jeton d'instance mais
 * aucune séance : l'instance ne sait pas qui parle. Ces requêtes sont
 * comptées quand même, pour ne pas fausser un total d'instance futur, mais ne
 * sont rendues à personne : les attribuer à quelqu'un serait inventer.
 */
const SANS_SEANCE = "sans-seance";

/**
 * Conservation : 13 mois.
 *
 * De quoi comparer un mois à celui de l'année précédente, pas davantage : un
 * journal qui grossit sans fin est réécrit à chaque requête, et finit par
 * peser sur chacune d'elles.
 */
const CONSERVATION_JOURS = 396;

/**
 * Un jeton vaut environ quatre caractères, pour le français comme pour
 * l'anglais, avec les tokeniseurs des modèles courants. C'est un ordre de
 * grandeur, et c'est pour cela que la mesure qui en sort porte la mention
 * « estimée ».
 */
const CARACTERES_PAR_JETON = 4;

const vide = (): Compteurs => ({ requetes: 0, entree: 0, sortie: 0, raisonnement: 0 });

/**
 * Jour calendaire à l'heure de l'instance.
 *
 * Pas l'heure universelle : une requête envoyée à 1 h du matin à Paris, en
 * été, tomberait sinon sur la veille, et « aujourd'hui » à l'écran ne serait
 * pas le même jour que celui de la personne qui regarde.
 */
function jourDe(date: Date): string {
  const a = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const j = String(date.getDate()).padStart(2, "0");
  return `${a}-${m}-${j}`;
}

/** Jour situé `n` jours avant `date`, en jours calendaires. */
function joursAvant(date: Date, n: number): Date {
  // Midi, pour qu'un changement d'heure ne fasse jamais sauter ou doubler un jour.
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  d.setDate(d.getDate() - n);
  return d;
}

let registre: Registre | null = null;
let tarifs: Record<string, Tarif> | null = null;
/**
 * Registre ou tarifs présents mais illisibles. Ils valaient `{}` jusqu'au
 * 27/09/2026, et la première mesure ou le premier tarif saisi remplaçait tout
 * ce qu'on n'avait pas pu lire. Ils restent désormais `null` : rien n'est écrit
 * par-dessus (règle du projet, pertes du 20/09 et du 24/09).
 */
let illisible = { registre: false, tarifs: false };
let chargement: Promise<void> | null = null;

function estLigne(v: unknown): v is Ligne {
  return typeof v === "object" && v !== null && "exact" in v && "estime" in v;
}

/**
 * Relit registre et tarifs, une fois. Un magasin illisible n'est pas pris pour
 * un magasin vide : il reste `null`, rien n'est écrit par-dessus, et la
 * lecture est retentée à l'appel suivant.
 */
async function charger(): Promise<void> {
  if (chargement) return chargement;
  chargement = (async () => {
    try {
      const brut = (await db().read("usage")) as Registre | null;
      registre =
        brut && typeof brut === "object" && typeof brut.jours === "object"
          ? { version: 1, jours: brut.jours }
          : { version: 1, jours: {} };
      illisible.registre = false;
    } catch (err) {
      console.error("[usage] registre illisible, rien n'est écrit par-dessus :", err instanceof Error ? err.message : err);
      registre = null;
      illisible.registre = true;
    }
    try {
      const brut = await db().read("tarifs");
      tarifs = brut && typeof brut === "object" ? (brut as Record<string, Tarif>) : {};
      illisible.tarifs = false;
    } catch (err) {
      console.error("[usage] tarifs illisibles, rien n'est écrit par-dessus :", err instanceof Error ? err.message : err);
      tarifs = null;
      illisible.tarifs = true;
    }
    if (illisible.registre || illisible.tarifs) chargement = null;
  })();
  return chargement;
}

/** Pour les essais : oublie ce qui a été lu ; la lecture suivante repart du magasin. */
export function oublierLecture(): void {
  registre = null;
  tarifs = null;
  illisible = { registre: false, tarifs: false };
  chargement = null;
}

/*
 * Écritures coalescées.
 *
 * Une demande découpée enchaîne des dizaines de requêtes au moteur en quelques
 * secondes. Écrire le registre à chaque fois, en parallèle, ferait se croiser
 * les écritures. On n'en garde qu'une en cours ; celles qui arrivent pendant
 * sont fondues dans la suivante, qui part avec l'état le plus récent.
 */
let ecriture: Promise<void> | null = null;
let enAttente = false;

function persister(): void {
  if (ecriture) {
    enAttente = true;
    return;
  }
  ecriture = (async () => {
    try {
      do {
        enAttente = false;
        purger();
        await db().write("usage", registre);
      } while (enAttente);
    } catch (err) {
      // Une mesure perdue ne doit jamais faire tomber une conversation.
      console.error("[usage] registre non écrit :", err instanceof Error ? err.message : err);
    } finally {
      ecriture = null;
    }
  })();
}

/** Retire les jours au-delà de la conservation. */
function purger(): void {
  if (!registre) return;
  const limite = jourDe(joursAvant(new Date(), CONSERVATION_JOURS));
  for (const jour of Object.keys(registre.jours)) {
    if (jour < limite) delete registre.jours[jour];
  }
}

/* ------------------------------------------------------------------ */
/* Enregistrement d'une requête                                        */
/* ------------------------------------------------------------------ */

export interface Mesure {
  entree: number;
  sortie: number;
  raisonnement: number;
  /** Lue dans la réponse du moteur (vrai) ou estimée par les caractères (faux). */
  exacte: boolean;
}

/** Ajoute une requête au registre. Ne lève jamais d'exception. */
export function enregistrer(
  qui: string | undefined,
  model: Pick<ModelInfo, "uid" | "backendId" | "backendKind">,
  mesure: Mesure,
): void {
  void charger()
    .then(() => {
      if (!registre) return;
      const jour = jourDe(new Date());
      const compte = qui || SANS_SEANCE;
      const parCompte = (registre.jours[jour] ??= {});
      const parModele = (parCompte[compte] ??= {});
      const ligne = (parModele[model.uid] ??= {
        backend: model.backendId,
        local: estLocal(model.backendKind),
        exact: vide(),
        estime: vide(),
      });
      const cible = mesure.exacte ? ligne.exact : ligne.estime;
      cible.requetes += 1;
      cible.entree += mesure.entree;
      cible.sortie += mesure.sortie;
      cible.raisonnement += mesure.raisonnement;
      persister();
    })
    .catch((err: unknown) =>
      console.error("[usage] mesure perdue :", err instanceof Error ? err.message : err),
    );
}

/** `usage` au format OpenAI, s'il est présent et lisible. */
function lireUsage(valeur: unknown): Omit<Mesure, "exacte"> | null {
  if (!valeur || typeof valeur !== "object") return null;
  const u = valeur as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  const entier = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const entree = entier(u.prompt_tokens);
  const sortie = entier(u.completion_tokens);
  // Sans ces deux nombres, ce n'est pas une mesure : on retombera sur l'estimation.
  if (entree === null || sortie === null) return null;
  return {
    entree,
    sortie,
    raisonnement: entier(u.completion_tokens_details?.reasoning_tokens) ?? 0,
  };
}

/** Caractères de texte envoyés au moteur : ce sur quoi s'appuie l'estimation d'entrée. */
function caracteresEnvoyes(payload: Record<string, unknown>): number {
  let total = 0;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const m of messages as { content?: unknown; tool_calls?: unknown }[]) {
    if (typeof m?.content === "string") total += m.content.length;
    else if (Array.isArray(m?.content)) {
      /*
       * Seul le texte compte. Une capture d'écran en base64 fait des
       * centaines de milliers de caractères : la compter ferait passer une
       * image pour un roman, et l'estimation serait fausse d'un facteur cent.
       */
      for (const p of m.content as { type?: string; text?: string }[]) {
        if (p?.type === "text" && typeof p.text === "string") total += p.text.length;
      }
    }
    if (Array.isArray(m?.tool_calls)) total += JSON.stringify(m.tool_calls).length;
  }
  // Les définitions d'outils partent avec chaque requête, et le moteur les lit.
  if (Array.isArray(payload.tools)) total += JSON.stringify(payload.tools).length;
  return total;
}

const enJetons = (caracteres: number) => Math.ceil(caracteres / CARACTERES_PAR_JETON);

/**
 * Relevé d'une requête au moteur, du départ à la fin de la réponse.
 *
 * On lui présente chaque fragment reçu ; il retient le dernier `usage` vu, et
 * compte au passage les caractères produits pour le cas où le moteur n'en
 * renverrait aucun. `clore()` enregistre, une seule fois.
 */
export class Releve {
  private readonly qui: string | undefined;
  private readonly model: Pick<ModelInfo, "uid" | "backendId" | "backendKind">;
  private readonly caracteresEntree: number;
  private usage: Omit<Mesure, "exacte"> | null = null;
  private caracteresSortie = 0;
  private caracteresRaisonnement = 0;
  private clos = false;

  // Champs explicites : Node exécute ce fichier en retirant simplement les
  // types, et ne gère pas les propriétés déclarées dans la signature.
  constructor(
    qui: string | undefined,
    model: Pick<ModelInfo, "uid" | "backendId" | "backendKind">,
    payload: Record<string, unknown>,
  ) {
    this.qui = qui;
    this.model = model;
    this.caracteresEntree = caracteresEnvoyes(payload);
  }

  /** Un fragment de flux (`chat.completion.chunk`). */
  observer(json: unknown): void {
    try {
      if (!json || typeof json !== "object") return;
      const fragment = json as {
        usage?: unknown;
        choices?: {
          delta?: {
            content?: unknown;
            reasoning_content?: unknown;
            tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[];
          };
        }[];
      };
      /*
       * `usage` arrive dans un fragment à part, dont `choices` est vide. Il
       * est lu ici, avant tout le reste, pour qu'aucun test sur `choices` ne
       * puisse le faire sauter.
       */
      const lu = lireUsage(fragment.usage);
      if (lu) this.usage = lu;

      const delta = fragment.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === "string") this.caracteresSortie += delta.content.length;
      if (typeof delta.reasoning_content === "string") {
        this.caracteresRaisonnement += delta.reasoning_content.length;
      }
      for (const appel of delta.tool_calls ?? []) {
        const f = appel?.function;
        if (typeof f?.name === "string") this.caracteresSortie += f.name.length;
        if (typeof f?.arguments === "string") this.caracteresSortie += f.arguments.length;
      }
    } catch {
      /* une mesure ne doit jamais faire échouer la conversation */
    }
  }

  /** Une réponse complète (`stream: false`), comme celle de la planification. */
  observerReponse(json: unknown): void {
    try {
      if (!json || typeof json !== "object") return;
      const rep = json as {
        usage?: unknown;
        choices?: {
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
            tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[];
          };
        }[];
      };
      const message = rep.choices?.[0]?.message;
      this.observer({
        usage: rep.usage,
        choices: message ? [{ delta: message }] : [],
      });
    } catch {
      /* idem */
    }
  }

  /** Enregistre la requête : exacte si le moteur a parlé, estimée sinon. */
  clore(): void {
    if (this.clos) return;
    this.clos = true;
    const mesure: Mesure = this.usage
      ? { ...this.usage, exacte: true }
      : {
          entree: enJetons(this.caracteresEntree),
          sortie: enJetons(this.caracteresSortie + this.caracteresRaisonnement),
          raisonnement: enJetons(this.caracteresRaisonnement),
          exacte: false,
        };
    enregistrer(this.qui, this.model, mesure);
  }
}

/** Relève et enregistre une réponse complète (`stream: false`) en un appel. */
export function releverReponse(
  qui: string | undefined,
  model: Pick<ModelInfo, "uid" | "backendId" | "backendKind">,
  payload: Record<string, unknown>,
  reponse: unknown,
): void {
  const releve = new Releve(qui, model, payload);
  releve.observerReponse(reponse);
  releve.clore();
}

/**
 * Lit un flux SSE brut par morceaux, sans le modifier, et présente chaque
 * fragment JSON à `surJson`. Sert au relais, qui retransmet les octets tels
 * quels : on lit une copie, on ne touche jamais à ce qui part vers le client.
 */
export function lecteurSSE(surJson: (json: unknown) => void): (morceau: Uint8Array) => void {
  const decodeur = new TextDecoder();
  let tampon = "";
  return (morceau) => {
    try {
      tampon += decodeur.decode(morceau, { stream: true });
      const evenements = tampon.split(/\r?\n\r?\n/);
      tampon = evenements.pop() ?? "";
      for (const evenement of evenements) {
        for (const ligne of evenement.split(/\r?\n/)) {
          if (!ligne.startsWith("data:")) continue;
          const brut = ligne.slice(5).trim();
          if (!brut || brut === "[DONE]") continue;
          try {
            surJson(JSON.parse(brut));
          } catch {
            /* fragment illisible : le client en jugera, pas nous */
          }
        }
      }
    } catch {
      /* idem */
    }
  };
}

/* ------------------------------------------------------------------ */
/* `stream_options` : demandé, et abandonné si le moteur le refuse     */
/* ------------------------------------------------------------------ */

/** Backends qui ont refusé `stream_options` puis accepté la même requête sans. */
const refusStreamOptions = new Set<string>();

/**
 * Corps à envoyer au moteur, avec la demande de consommation quand elle a un
 * sens : en flux seulement. En `stream: false`, `usage` est de toute façon dans
 * la réponse, et OpenAI refuse `stream_options` hors flux.
 */
export function avecMesure(
  backendId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.stream !== true) {
    if (!("stream_options" in payload)) return payload;
    const { stream_options: _retire, ...sans } = payload;
    return sans;
  }
  if (refusStreamOptions.has(backendId)) return payload;
  const existant =
    payload.stream_options && typeof payload.stream_options === "object"
      ? (payload.stream_options as Record<string, unknown>)
      : {};
  return { ...payload, stream_options: { ...existant, include_usage: true } };
}

/** Le même corps, sans `stream_options` : pour le second essai. */
export function sansMesure(payload: Record<string, unknown>): Record<string, unknown> {
  const { stream_options: _retire, ...sans } = payload;
  return sans;
}

/**
 * Faut-il réessayer sans `stream_options` après ce code ?
 *
 * Un moteur qui ne connaît pas le champ répond 400 ou 422. Une erreur
 * d'authentification ou une limite de débit n'a rien à voir avec lui : les
 * rejouer ne ferait que doubler la charge.
 */
export function refusPossible(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

/** Retient qu'un backend ne veut pas de `stream_options`, pour ne plus le lui envoyer. */
export function noterRefus(backendId: string): void {
  if (!refusStreamOptions.has(backendId)) {
    refusStreamOptions.add(backendId);
    console.log(
      `[usage] ${backendId} refuse stream_options : sa consommation sera estimée.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Tarifs                                                              */
/* ------------------------------------------------------------------ */

/** Un euro (ou un dollar) par jeton : au-delà, c'est une faute de frappe, pas un tarif. */
const TARIF_MAX = 1_000_000;

const DEVISES: readonly Devise[] = ["EUR", "USD"];

/** Devise d'un tarif saisi : euros quand elle manque (tarifs d'avant le 27/09/2026). */
export const deviseDuTarif = (t: { devise?: unknown }): Devise =>
  DEVISES.includes(t.devise as Devise) ? (t.devise as Devise) : "EUR";

/** Nature du modèle d'après son identifiant qualifié, même s'il est hors ligne. */
function backendDe(uid: string): { id: string; kind: BackendKind; catalogue?: string; baseUrl?: string } | null {
  const id = uid.split("/")[0];
  const b = tousLesBackends().find((x) => x.id === id);
  return b ? { id: b.id, kind: b.kind, catalogue: b.catalogue, baseUrl: b.baseUrl } : null;
}

/** Ce que l'écran montre d'un prix publié : de quoi le citer. */
export interface PrixCite {
  entree: number;
  sortie: number;
  devise: Devise;
  fournisseur: string;
  page: string;
  releveLe: string;
}

/**
 * Ce que l'écran montre d'un modèle : son nom, et le service qui le sert
 * (28/09/2026). Mon usage montrait l'identifiant technique
 * (« cle-3f9a…/gpt-4o-mini »), illisible pour qui a branché sa clé. Le service
 * est son nom dans OxoAI (celui donné à la clé) ; une clé retirée depuis ne
 * laisse que le nom du modèle.
 */
export function designation(uid: string): { nom: string; service?: string } {
  const id = uid.split("/")[0] ?? "";
  const b = tousLesBackends().find((x) => x.id === id);
  const nom = uid.startsWith(`${id}/`) && uid.length > id.length + 1 ? uid.slice(id.length + 1) : uid;
  return b ? { nom, service: b.label } : { nom };
}

/** Le prix publié pour un modèle distant, par son fournisseur, ou rien. */
export function prixPublieDe(
  uid: string,
  backend: { id: string; kind: BackendKind | string; catalogue?: string; baseUrl?: string } | null,
  le = new Date(),
): PrixCite | null {
  if (!backend || estLocal(backend.kind)) return null;
  const f = fournisseurDuBackend(backend);
  if (!f) return null;
  const idModele = uid.startsWith(`${backend.id}/`) ? uid.slice(backend.id.length + 1) : uid;
  const p = prixPublie(f.id, idModele, { le });
  return p
    ? { entree: p.tarif.entree, sortie: p.tarif.sortie, devise: p.tarif.devise, fournisseur: p.fournisseur.nom, page: p.fournisseur.page, releveLe: p.fournisseur.releveLe }
    : null;
}

/**
 * Coût d'un modèle sur la période, d'après ses jetons : le tarif saisi s'il y
 * en a un, sinon le prix publié, sinon rien. Jamais zéro faute de tarif.
 */
export function coutDuModele(
  c: { entree: number; sortie: number; requetesEstimees: number },
  local: boolean,
  saisi: Tarif | undefined,
  publie: PrixCite | null,
): Cout {
  if (local) return { statut: "gratuit" };
  const montant = (p: { entree: number; sortie: number }) => (c.entree * p.entree + c.sortie * p.sortie) / 1_000_000;
  if (saisi) {
    return { statut: "calcule", source: "saisi", montant: montant(saisi), devise: deviseDuTarif(saisi), estime: c.requetesEstimees > 0 };
  }
  if (publie) {
    return {
      statut: "calcule",
      source: "publie",
      montant: montant(publie),
      devise: publie.devise,
      // Toujours estimé : le prix publié ne sait rien du cache, des lots ni des paliers gratuits.
      estime: true,
      publie: { fournisseur: publie.fournisseur, page: publie.page, releveLe: publie.releveLe },
    };
  }
  return { statut: "non-renseigne" };
}

export type ResultatTarif = { ok: true } | { ok: false; raison: string };

/**
 * Renseigne, change ou retire le tarif d'un modèle distant.
 *
 * `entree` et `sortie` à `null` : le tarif est retiré, et l'écran repasse à
 * « tarif non renseigné ». Un modèle local est refusé : il n'a pas de frais
 * d'API, et un tarif saisi par erreur lui en inventerait.
 */
export async function definirTarif(
  corps: unknown,
  qui: string,
): Promise<ResultatTarif> {
  await charger();
  // Illisibles : on n'écrit pas une table de tarifs par-dessus celle qu'on n'a pas pu lire.
  if (!tarifs) return { ok: false, raison: t("Tarifs illisibles sur cette instance.") };

  const c = (corps ?? {}) as { modele?: unknown; entree?: unknown; sortie?: unknown; devise?: unknown };
  if (typeof c.modele !== "string" || !c.modele.includes("/")) {
    return { ok: false, raison: t("« modele » doit être l'identifiant complet, par exemple « mistral/mistral-large ».") };
  }
  const backend = backendDe(c.modele);
  if (!backend) return { ok: false, raison: tf("Moteur inconnu pour « {0} ».", c.modele) };
  if (estLocal(backend.kind)) {
    return {
      ok: false,
      raison: t("Ce modèle est local : il n'a pas de frais d'API, il n'y a pas de tarif à renseigner."),
    };
  }

  const ancien = tarifs[c.modele] ?? null;

  if (c.entree === null && c.sortie === null) {
    delete tarifs[c.modele];
  } else {
    const valide = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= TARIF_MAX;
    if (!valide(c.entree) || !valide(c.sortie)) {
      return {
        ok: false,
        raison:
          t("Les deux prix sont requis, par million de jetons, et doivent être des nombres positifs ou nuls."),
      };
    }
    if (c.devise !== undefined && !DEVISES.includes(c.devise as Devise)) {
      return { ok: false, raison: t("« devise » doit valoir EUR ou USD.") };
    }
    tarifs[c.modele] = {
      entree: c.entree as number,
      sortie: c.sortie as number,
      devise: (c.devise as Devise | undefined) ?? "EUR",
      depuis: new Date().toISOString(),
      par: qui,
    };
  }

  await db().write("tarifs", tarifs);
  const resume = (x: Tarif | null) => (x ? { entree: x.entree, sortie: x.sortie, devise: deviseDuTarif(x) } : null);
  journaliser("tarif.modifie", qui, {
    modele: c.modele,
    ancien: resume(ancien),
    nouveau: resume(tarifs[c.modele] ?? null),
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Rapport                                                             */
/* ------------------------------------------------------------------ */

export const PERIODES = ["jour", "semaine", "mois", "tout"] as const;
export type Periode = (typeof PERIODES)[number];

export function estPeriode(v: unknown): v is Periode {
  return typeof v === "string" && (PERIODES as readonly string[]).includes(v);
}

interface CompteursRendus extends Compteurs {
  /** Requêtes dont la consommation est estimée, et non lue dans la réponse. */
  requetesEstimees: number;
}

/**
 * Coût d'un modèle sur la période.
 *  - `gratuit`       : modèle local, aucun frais d'API ;
 *  - `non-renseigne` : modèle distant sans tarif saisi ni prix publié connu,
 *                      aucun montant n'est calculé ;
 *  - `calcule`       : jetons × tarif, dans la devise du tarif ; `source` dit
 *                      s'il a été saisi ou publié ; `estime` si une part des
 *                      jetons l'est, et toujours pour un prix publié.
 */
export type Cout =
  | { statut: "gratuit" }
  | { statut: "non-renseigne" }
  | {
      statut: "calcule";
      montant: number;
      devise: Devise;
      estime: boolean;
      source: "saisi" | "publie";
      publie?: { fournisseur: string; page: string; releveLe: string };
    };

export interface Rapport {
  periode: Periode;
  du: string;
  au: string;
  totaux: CompteursRendus & {
    /** Somme des coûts calculés, devise par devise : aucun taux de change n'est inventé. */
    couts: { devise: Devise; montant: number }[];
    /** Un coût au moins est estimé (jetons estimés, ou prix publié). */
    coutEstime: boolean;
    /** Modèles distants utilisés sur la période et restés sans tarif. */
    sansTarif: number;
  };
  modeles: (CompteursRendus & {
    uid: string;
    /** Le nom du modèle et son service, pour l'écran (`designation`). */
    nom: string;
    service?: string;
    backend: string;
    local: boolean;
    cout: Cout;
  })[];
  jours: { jour: string; entree: number; sortie: number; requetes: number }[];
  /** Modèles distants connus, pour la saisie des tarifs, avec le prix publié quand il est connu. */
  distants: {
    uid: string;
    nom: string;
    service?: string;
    backend: string;
    tarif: { entree: number; sortie: number; devise: Devise; depuis: string } | null;
    publie: PrixCite | null;
  }[];
  /** Les tarifs saisis n'ont pas pu être lus : aucun coût distant n'est calculé, rien n'est réécrit. */
  tarifsIllisibles: boolean;
  conservationJours: number;
}

const fusion = (ligne: Ligne): CompteursRendus => ({
  requetes: ligne.exact.requetes + ligne.estime.requetes,
  entree: ligne.exact.entree + ligne.estime.entree,
  sortie: ligne.exact.sortie + ligne.estime.sortie,
  raisonnement: ligne.exact.raisonnement + ligne.estime.raisonnement,
  requetesEstimees: ligne.estime.requetes,
});

/**
 * Consommation d'un compte, et de lui seul, sur une période.
 *
 * Le compte vient de la séance, jamais d'un paramètre : il n'existe aucun
 * moyen, par cette fonction, de lire la consommation d'un collègue.
 */
export async function rapport(compte: string, periode: Periode): Promise<Rapport> {
  await charger();
  const jours = registre?.jours ?? {};
  const maintenant = new Date();
  const au = jourDe(maintenant);

  // « Tout » commence au premier jour où ce compte a consommé, pas treize mois
  // plus tôt : une courbe de quatre cents jours plats n'apprend rien.
  const premierJour =
    Object.keys(jours)
      .filter((j) => jours[j]?.[compte])
      .sort()[0] ?? au;
  const du =
    periode === "jour"
      ? au
      : periode === "semaine"
        ? jourDe(joursAvant(maintenant, 6))
        : periode === "mois"
          ? jourDe(joursAvant(maintenant, 29))
          : premierJour < au
            ? premierJour
            : au;

  // Tous les jours de la période, y compris ceux sans activité : un creux
  // dans la courbe est une information, un jour absent en est une autre.
  const serie: Rapport["jours"] = [];
  for (let d = joursAvant(maintenant, 0); jourDe(d) >= du; d = joursAvant(d, 1)) {
    serie.unshift({ jour: jourDe(d), entree: 0, sortie: 0, requetes: 0 });
  }

  const parModele = new Map<string, { backend: string; local: boolean; c: CompteursRendus }>();
  for (const point of serie) {
    const lignes = jours[point.jour]?.[compte];
    if (!lignes) continue;
    for (const [uid, ligne] of Object.entries(lignes)) {
      if (!estLigne(ligne)) continue;
      const f = fusion(ligne);
      point.entree += f.entree;
      point.sortie += f.sortie;
      point.requetes += f.requetes;
      const cumul = parModele.get(uid) ?? {
        backend: ligne.backend,
        local: ligne.local,
        c: { requetes: 0, entree: 0, sortie: 0, raisonnement: 0, requetesEstimees: 0 },
      };
      cumul.c.requetes += f.requetes;
      cumul.c.entree += f.entree;
      cumul.c.sortie += f.sortie;
      cumul.c.raisonnement += f.raisonnement;
      cumul.c.requetesEstimees += f.requetesEstimees;
      parModele.set(uid, cumul);
    }
  }

  const tableTarifs = tarifs ?? {};
  const tarifsIllisibles = tarifs === null;
  /*
   * Tarifs illisibles : un tarif saisi existe peut-être, et le prix publié ne
   * doit pas passer devant lui. Aucun coût distant n'est donc calculé, et
   * l'écran dit pourquoi.
   */
  const publieDe = (uid: string) => (tarifsIllisibles ? null : prixPublieDe(uid, backendDe(uid)));
  const modeles: Rapport["modeles"] = [...parModele.entries()]
    .map(([uid, { backend, local, c }]) => {
      const cout = coutDuModele(c, local, tableTarifs[uid], local ? null : publieDe(uid));
      return { uid, ...designation(uid), backend, local, ...c, cout };
    })
    .sort((a, b) => b.entree + b.sortie - (a.entree + a.sortie));

  const totaux: Rapport["totaux"] = {
    requetes: 0,
    entree: 0,
    sortie: 0,
    raisonnement: 0,
    requetesEstimees: 0,
    couts: [],
    coutEstime: false,
    sansTarif: 0,
  };
  for (const m of modeles) {
    totaux.requetes += m.requetes;
    totaux.entree += m.entree;
    totaux.sortie += m.sortie;
    totaux.raisonnement += m.raisonnement;
    totaux.requetesEstimees += m.requetesEstimees;
    if (m.cout.statut === "calcule") {
      const devise = m.cout.devise;
      const cumul = totaux.couts.find((x) => x.devise === devise);
      if (cumul) cumul.montant += m.cout.montant;
      else totaux.couts.push({ devise, montant: m.cout.montant });
      if (m.cout.estime) totaux.coutEstime = true;
    } else if (m.cout.statut === "non-renseigne") totaux.sansTarif += 1;
  }

  /*
   * Modèles distants proposés à la saisie d'un tarif : ceux que l'instance
   * découvre en ce moment, ceux qui ont déjà un tarif, et ceux que **ce
   * compte** a utilisés et qui sont hors ligne aujourd'hui : un modèle utilisé
   * hier doit pouvoir être tarifé demain. Pas ceux des collègues : même sans
   * chiffre, la liste des modèles qu'une autre personne a sollicités ne
   * regarde qu'elle.
   */
  const distants = new Map<string, string>();
  try {
    for (const m of await models()) {
      if (!estLocal(m.backendKind)) distants.set(m.uid, m.backendId);
    }
  } catch {
    /* découverte indisponible : on s'en tient à ce qui a déjà servi */
  }
  for (const parCompte of Object.values(jours)) {
    for (const [uid, ligne] of Object.entries(parCompte[compte] ?? {})) {
      if (estLigne(ligne) && !ligne.local) distants.set(uid, ligne.backend);
    }
  }
  for (const uid of Object.keys(tableTarifs)) {
    const b = backendDe(uid);
    if (b) distants.set(uid, b.id);
  }

  return {
    periode,
    du,
    au,
    totaux,
    modeles,
    jours: serie,
    distants: [...distants.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([uid, backend]) => {
        const t = tableTarifs[uid];
        return {
          uid,
          ...designation(uid),
          backend,
          tarif: t ? { entree: t.entree, sortie: t.sortie, devise: deviseDuTarif(t), depuis: t.depuis } : null,
          publie: publieDe(uid),
        };
      }),
    tarifsIllisibles,
    conservationJours: CONSERVATION_JOURS,
  };
}

/**
 * Consommation d'un compte, jour par jour et modèle par modèle, telle qu'elle
 * est enregistrée : pour l'export de ses données (droit d'accès). Même règle
 * que `rapport` : le compte vient de la séance, jamais d'un paramètre.
 */
export async function consommationDe(compte: string): Promise<{
  conservationJours: number;
  jours: Record<string, Record<string, CompteursRendus & { backend: string; local: boolean }>>;
}> {
  await charger();
  const sortie: Record<string, Record<string, CompteursRendus & { backend: string; local: boolean }>> = {};
  for (const [jour, parCompte] of Object.entries(registre?.jours ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const lignes = parCompte[compte];
    if (!lignes) continue;
    for (const [uid, ligne] of Object.entries(lignes)) {
      if (!estLigne(ligne)) continue;
      (sortie[jour] ??= {})[uid] = { backend: ligne.backend, local: ligne.local, ...fusion(ligne) };
    }
  }
  return { conservationJours: CONSERVATION_JOURS, jours: sortie };
}

/**
 * Efface la consommation d'un compte, tous jours confondus (droit à
 * l'effacement). Les totaux des collègues ne bougent pas : chaque ligne est
 * rangée par compte, rien n'est agrégé en dehors d'elle.
 */
export async function oublierCompte(compte: string): Promise<number> {
  await charger();
  let lignes = 0;
  for (const parCompte of Object.values(registre?.jours ?? {})) {
    if (parCompte[compte]) {
      lignes += Object.keys(parCompte[compte]!).length;
      delete parCompte[compte];
    }
  }
  if (lignes > 0) {
    persister();
    await ecriture;
  }
  return lignes;
}
