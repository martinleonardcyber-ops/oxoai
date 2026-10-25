import { apiFetch } from "./endpoint";
import { decrireRythme as decrireRythmeTache } from "@/lib/tachesProgrammees";
import { DOCUMENT_MAX, EXTRACTION_MAX, LIBELLE_DOCUMENT_MAX, envoyerEnFlux } from "./televersement";
import { t, tf } from "@/lib/i18n";
import { nomDuPays } from "@/lib/fournisseurs";

/**
 * Employés : des agents OpenClaw qui travaillent pour toute l'équipe (voir
 * gateway/src/employes.ts). Ce module ne fait que parler à la passerelle :
 * c'est elle qui déploie, planifie et décide qui a le droit de quoi.
 */

export type Famille = "fichiers" | "bibliotheque" | "courrier" | "agenda" | "drive" | "slack" | "bureau";
export type Rythme = "jours-ouvres" | "chaque-jour" | "chaque-heure" | "chaque-semaine" | "chaque-mois" | "a-chaque-mail";
export type Liberte = "encadre" | "etendu" | "libre";
export type TypeCanal = "telegram" | "whatsapp" | "discord" | "slack" | "mattermost";

export interface CanalEmploye {
  type: TypeCanal;
  nom: string;
  /** Présents pour le propriétaire seulement. */
  acces?: "appairage" | "liste";
  autorises?: string[];
  outilsEntreprise?: boolean;
}

export interface ChampCanal {
  cle: string;
  libelle: string;
  secret: boolean;
  aide?: string;
}

export interface Mission {
  id?: string;
  nom: string;
  consigne: string;
  rythme: Rythme;
  /** « À chaque mail reçu » : ne réagir qu'aux messages dont l'expéditeur, ou l'objet, contient ce texte. */
  filtre?: { de?: string; objet?: string };
  heure: string;
  /** « Chaque semaine » : 0 dimanche … 6 samedi ; « chaque mois » : 1 à 28, ou -1 pour le dernier jour. */
  jour?: number;
  planifiee?: boolean;
}

export interface Employe {
  id: string;
  nom: string;
  poste: string;
  description?: string;
  outils: Famille[];
  missions: Mission[];
  enPause: boolean;
  autonome?: boolean;
  liberte?: Liberte;
  canaux?: CanalEmploye[];
  /** Agent de l'interface dont il est la mise en service. */
  agentId?: string;
  visibilite?: "personnel" | "groupes" | "organisation";
  /** Pour la visibilité « groupes » : les groupes à qui il est partagé. */
  groupes?: string[];
  toutesLesFamilles?: boolean;
  /** Bases de connaissances de l'agent : ce qu'il y lit, `lectureDesBases` le dit. */
  connaissances?: string[];
  ownerId: string;
  createdAt: string;
  updatedAt?: string;
  modele: string;
  /** Son modèle tel que l'instance le trouve, avec les droits de son propriétaire (absent : instance plus ancienne). */
  modeleEtat?: EtatModele;
  proprietaire: string;
  estProprietaire: boolean;
  jetons30Jours: number;
}

/**
 * Pourquoi son modèle ne répond plus (gateway/src/employes.ts, `etatDuModele`) :
 * désinstallé ou plus retenu par sa clé, clé retirée, service qui ne répond
 * pas, clé devenue personnelle à quelqu'un d'autre. Il ne bascule jamais sur
 * un autre modèle : l'écran le dit.
 */
export type RaisonModele = "retire" | "cle-retiree" | "hors-ligne" | "reserve";

export interface EtatModele {
  nom: string;
  disponible: boolean;
  raison?: RaisonModele;
  origine?: "local" | "agence" | "cle";
  fournisseur?: string;
  pays?: string;
}

/** Un modèle qu'on peut donner à un employé, tel que `GET /oxoai/employes` le liste. */
export interface ModeleEmploye {
  uid: string;
  nom: string;
  charge: boolean;
  origine: "local" | "agence" | "cle";
  pays?: string;
  fournisseur?: string;
  /** Déclaré par LM Studio : sait appeler des outils (absent : on ne sait pas). */
  outils?: boolean;
  /** Taille sur disque, en octets. */
  taille?: number;
  params?: string;
  /** Entraîné sur cette machine : jamais proposé d'office. */
  entraine?: boolean;
  /** A mal répondu sur cette machine (essai de mise en route) : jamais proposé d'office. */
  defaillant?: boolean;
  /** Clé personnelle de la personne qui regarde : facturée sur sa clé. */
  personnel?: boolean;
}

export interface EtatEmployes {
  catalogueCanaux: Record<TypeCanal, { nom: string; champs: ChampCanal[]; qr: boolean }>;
  moteur: {
    installe: boolean;
    version?: string;
    enMarche: boolean;
    raison?: string;
    /** Installé par l'application elle-même (sinon trouvé sur la machine). */
    gere: boolean;
    installation: EtatInstallation;
    /** Version éprouvée plus récente que celle en place : la mise à jour proposée. */
    miseAJour?: string;
    /** Version publiée plus récente encore, pas encore éprouvée. */
    parue?: string;
    /** Système de la machine de l'instance (`win32` : ses commandes passent par PowerShell). Absent d'une instance plus ancienne. */
    plateforme?: string;
    /** Windows : OpenClaw installé, mais les bibliothèques Visual C++ de Microsoft manquent (il ne démarre pas sans elles). */
    visualCpp?: "absent" | "ancien";
  };
  employes: Employe[];
  familles: { id: Famille; disponible: boolean }[];
  modeles: ModeleEmploye[];
}

export interface EtatInstallation {
  /** `visualcpp` : Windows seulement, les bibliothèques de Microsoft qu'OpenClaw demande (29/09/2026). */
  etape: "repos" | "preparation" | "visualcpp" | "node" | "openclaw" | "verification" | "termine" | "erreur";
  message: string;
  /** Avancement du téléchargement (Node, ou le paquet de Microsoft), de 0 à 100. */
  avancement?: number;
  version?: string;
  /** Version remplacée, quand c'était une mise à jour. */
  de?: string;
  /** Windows conseille de redémarrer le PC pour finir l'installation des bibliothèques de Microsoft. */
  redemarrage?: boolean;
}

/** Les étapes pendant lesquelles une installation est en cours. */
export const ETAPES_EN_COURS: readonly EtatInstallation["etape"][] = ["preparation", "visualcpp", "node", "openclaw", "verification"];

/** Le message d'une étape, avec l'avancement du téléchargement quand il y en a un. */
export const messageEtape = (i: EtatInstallation): string =>
  `${i.message}${(i.etape === "node" || i.etape === "visualcpp") && i.avancement !== undefined && i.avancement < 100 ? ` ${i.avancement} %` : ""}`;

/** Lance l'installation d'OpenClaw sur la machine de l'instance ; on suit ensuite `moteur.installation`. */
export async function installerOpenClaw(): Promise<void> {
  await lire(await poster("/oxoai/openclaw/installer", {}));
}

/**
 * Installe OpenClaw s'il manque et attend la fin, en rapportant chaque étape.
 * Sert au déploiement : l'employé se déploie dès qu'OpenClaw est prêt.
 */
export async function assurerOpenClaw(suivi: (e: EtatInstallation) => void): Promise<void> {
  const etat = await chargerEmployes();
  // Installé mais sans les bibliothèques de Microsoft (Windows) : la même route les installe, puis relance l'instance.
  if (etat.moteur.installe && !etat.moteur.visualCpp) return;
  await installerOpenClaw();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const m = (await chargerEmployes()).moteur;
    suivi(m.installation);
    if (m.installe && !ETAPES_EN_COURS.includes(m.installation.etape)) return;
    if (m.installation.etape === "erreur") throw new Error(m.installation.message);
  }
}

export interface Echange {
  quand: string;
  question: string;
  reponse: string;
  ok: boolean;
}

export interface Execution {
  mission: string;
  quand: string;
  statut: string;
  resume: string;
  dureeMs?: number;
}

export const LIBELLE_FAMILLE: Record<Famille, string> = {
  fichiers: t("Fichiers de l'équipe"),
  bibliotheque: t("Bibliothèque"),
  courrier: "Mails",
  agenda: t("Agenda"),
  drive: "Google Drive",
  slack: "Slack",
  bureau: "Documents Office",
};

export const DETAIL_FAMILLE: Record<Famille, string> = {
  fichiers: t("Lire, chercher et écrire dans le dossier de travail"),
  bibliotheque: t("Chercher et lire les documents de la bibliothèque ouverts à toute l'équipe"),
  courrier: t("Lire la boîte mail de l'entreprise, y préparer des brouillons, envoyer après accord si l'envoi est activé"),
  agenda: t("Lire l'agenda de l'entreprise"),
  drive: t("Lire les documents du Drive"),
  slack: t("Lire les salons Slack"),
  bureau: t("Créer des documents Word, Excel, PowerPoint et PDF"),
};

/** Dans l'ordre du choix, comme les tâches programmées (27/09/2026). */
export const LIBELLE_RYTHME: Record<Rythme, string> = {
  "chaque-jour": t("Chaque jour"),
  "jours-ouvres": t("Du lundi au vendredi"),
  "chaque-semaine": t("Chaque semaine"),
  "chaque-mois": t("Chaque mois"),
  "chaque-heure": t("Chaque heure"),
  "a-chaque-mail": t("À chaque mail reçu"),
};

/** « qwen3-8b · LM Studio (sur la machine, chargé) », « mistral-large · Mistral AI (cloud, France, facturé) ». */
export function libelleModele(m: ModeleEmploye): string {
  const ou =
    m.origine === "local"
      ? m.charge
        ? t("sur la machine, chargé")
        : t("sur la machine")
      : m.origine === "cle"
        ? tf("cloud, {0}, facturé", m.pays ? nomDuPays(m.pays) : t("pays non précisé"))
        : tf("cloud, {0}", m.pays ? nomDuPays(m.pays) : t("pays non précisé"));
  return `${m.nom} · ${m.fournisseur ?? ""} (${ou})`;
}

/** Le nom court d'un modèle, pour la liste : « qwen/qwen3-8b » devient « qwen3-8b ». */
export const nomCourtModele = (nom: string) => nom.split("/").pop() || nom;

/* ---- Le modèle proposé pour un poste ------------------------------------ */

/** Ce que le poste demande à son modèle. */
export interface BesoinDuPoste {
  /** Il se sert d'outils : services branchés, bases de connaissances, documents de référence. */
  outils: boolean;
  /** Longueur de sa fiche de poste, en caractères. */
  longueurPoste: number;
}

/** En dessous : un poste court, tâche simple et répétitive (trier, relever, reformuler). */
const POSTE_COURT = 600;

export interface Proposition {
  uid: string;
  /** Pourquoi celui-là, en une ligne. */
  raison: string;
}

/**
 * Le modèle proposé à la création d'un agent, et rappelé dans ses réglages
 * (27/09/2026, demandé par Medhi : « on doit choisir le modèle selon l'agent
 * aussi, pas tous le même »). La personne décide ; la proposition dit pourquoi.
 *
 *  - Jamais un modèle de clé d'office : il est facturé à quelqu'un (même
 *    règle que le mode Auto, gateway/src/router.ts). Ni un modèle entraîné
 *    ici, ni un modèle qui a mal répondu sur cette machine.
 *  - Un poste qui se sert d'outils : un modèle qui déclare savoir les appeler.
 *    Celui qui est déjà chargé d'abord (pas de second modèle en mémoire),
 *    sinon le plus gros : un petit modèle se perd plus vite entre deux outils.
 *  - Un poste court, sans outils : le plus léger, qui répond vite et laisse
 *    la mémoire aux autres.
 *  - Sinon : celui qui est déjà chargé, qui répond sans temps de chargement.
 *
 * `null` : aucun modèle gratuit, il faut en choisir un (facturé) ou en installer un.
 */
export function proposerModele(modeles: ModeleEmploye[], besoin: BesoinDuPoste): Proposition | null {
  const gratuits = modeles.filter((m) => m.origine !== "cle" && !m.entraine && !m.defaillant);
  // Les modèles de la machine d'abord ; ceux de l'intégrateur (profil de l'instance) seulement s'il n'y en a pas.
  const locaux = gratuits.filter((m) => m.origine === "local");
  const base = locaux.length > 0 ? locaux : gratuits;
  if (base.length === 0) return null;
  const charge = (liste: ModeleEmploye[]) => liste.find((m) => m.charge);
  if (besoin.outils) {
    const capables = base.filter((m) => m.outils === true);
    if (capables.length > 0) {
      const deja = charge(capables);
      if (deja) return { uid: deja.uid, raison: t("il sait appeler des outils, dont son poste se sert, et il est déjà chargé") };
      const plusGros = [...capables].sort((a, b) => (b.taille ?? 0) - (a.taille ?? 0))[0]!;
      return { uid: plusGros.uid, raison: t("il sait appeler des outils, dont son poste se sert") };
    }
    const repli = charge(base.filter((m) => m.outils !== false)) ?? base.find((m) => m.outils !== false) ?? base[0]!;
    return { uid: repli.uid, raison: t("aucun des modèles de l'instance ne déclare savoir appeler des outils, dont son poste se sert : relisez ses premières réponses") };
  }
  if (besoin.longueurPoste <= POSTE_COURT) {
    const peses = base.filter((m) => m.taille);
    if (peses.length > 0) {
      const leger = [...peses].sort((a, b) => (a.taille ?? 0) - (b.taille ?? 0))[0]!;
      return { uid: leger.uid, raison: t("le plus léger de l'instance : son poste est court et ne se sert d'aucun outil") };
    }
  }
  const deja = charge(base);
  if (deja) return { uid: deja.uid, raison: t("il est déjà chargé : il répond sans temps de chargement") };
  return { uid: base[0]!.uid, raison: t("le modèle de conversation de l'instance") };
}

/** Ce que l'écran dit quand son modèle ne répond plus. */
export function texteModeleIndisponible(etat: EtatModele, estProprietaire: boolean): string {
  const quoi =
    etat.raison === "cle-retiree"
      ? tf("La clé qui donnait accès à son modèle ({0}) a été retirée.", etat.nom)
      : etat.raison === "hors-ligne"
        ? tf("Le service qui fait tourner son modèle ({0}) ne répond pas.", etat.nom)
        : etat.raison === "reserve"
          ? tf("Son modèle ({0}) est maintenant réservé à la personne qui a branché sa clé.", etat.nom)
          : tf("Son modèle ({0}) n'est plus sur l'instance.", etat.nom);
  const suite = estProprietaire
    ? t("Il ne prend pas un autre modèle de lui-même : choisissez-en un dans ses réglages.")
    : t("Il ne prend pas un autre modèle de lui-même : seule la personne qui l'a créé peut lui en choisir un.");
  return `${quoi} ${suite}`;
}

/** « Chaque jour ouvré à 8 h 30 » : l'heure n'a pas de sens pour « chaque heure ». */
export function decrireRythme(m: Pick<Mission, "rythme" | "heure" | "filtre" | "jour">): string {
  if (m.rythme === "a-chaque-mail") {
    const conditions = [
      m.filtre?.de ? tf("de « {0} »", m.filtre.de) : "",
      m.filtre?.objet ? tf("dont l'objet contient « {0} »", m.filtre.objet) : "",
    ].filter(Boolean);
    return conditions.length ? tf("À chaque mail reçu {0}", conditions.join(" et ")) : LIBELLE_RYTHME[m.rythme];
  }
  if (m.rythme === "chaque-heure") return LIBELLE_RYTHME[m.rythme];
  // Même phrase que pour les tâches programmées : « Chaque mardi à 9 h 30 », « Le 5 de chaque mois à 8 h ».
  const rythme =
    m.rythme === "chaque-jour"
      ? { type: "jour" as const }
      : m.rythme === "jours-ouvres"
        ? { type: "jours-ouvres" as const }
        : m.rythme === "chaque-semaine"
          ? { type: "semaine" as const, jour: m.jour ?? 1 }
          : { type: "mois" as const, jour: m.jour ?? 1 };
  return decrireRythmeTache(rythme, m.heure);
}

/**
 * Refus de l'instance, avec son code quand l'écran sait le traiter : ici,
 * `memoire-a-vider` (gateway/src/employes.ts, `CODE_MEMOIRE`), qui demande la
 * confirmation de vider la mémoire de l'agent avant d'élargir son audience.
 */
export class RefusInstance extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const CODE_MEMOIRE = "memoire-a-vider";

/** Ce qui élargit l'audience de l'agent, tel que l'instance le dit. */
export type RaisonElargissement = "visibilite" | "groupes" | "messagerie" | "mission-mail" | "liberte" | "outils";

export const estRefusMemoire = (err: unknown): err is RefusInstance => err instanceof RefusInstance && err.code === CODE_MEMOIRE;

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string; details?: Record<string, unknown> } };
  if (!res.ok) throw new RefusInstance(corps.error?.message ?? t("L'instance n'a pas répondu."), corps.error?.code, corps.error?.details);
  return corps;
}

const poster = (chemin: string, corps: unknown) =>
  apiFetch(chemin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });

export async function chargerEmployes(): Promise<EtatEmployes> {
  return lire<EtatEmployes>(await apiFetch("/oxoai/employes"));
}

/** Pourquoi un agent toujours actif ne lit que ce qui est ouvert à toute l'équipe (gateway/src/employes.ts, `lectureDesBases`). */
export type RaisonEquipeSeulement = "organisation" | "sans-groupe" | "messagerie" | "mission-mail" | "liberte" | "outils";

/** Ce qu'il lira réellement dans ses bases de connaissances, calculé par l'instance comme son outil le fait. */
export interface LectureDesBases {
  /** `equipe` : ouvert à toute l'équipe ; `groupes` : aussi partagé à chacun de ses groupes ; `proprietaire` : tout ce que vous voyez. */
  regle: "equipe" | "groupes" | "proprietaire";
  raisons: RaisonEquipeSeulement[];
  outilsQuiSortent: Famille[];
  bases: {
    id: string;
    nom?: string;
    visibilite?: "prive" | "groupes" | "organisation";
    lue: boolean;
    documents: number;
    documentsLus: number;
    raison?: "prive" | "groupes-equipe" | "groupes-autres" | "inconnue" | "documents";
  }[];
}

export async function lectureDesBases(id: string, bases: string[]): Promise<LectureDesBases> {
  return lire<LectureDesBases>(await poster(`/oxoai/employes/${encodeURIComponent(id)}/connaissances`, { bases }));
}

export interface NouvelEmploye {
  nom: string;
  poste: string;
  outils: Famille[];
  missions: Mission[];
  autonome: boolean;
  liberte: Liberte;
  agentId?: string;
  visibilite?: "personnel" | "groupes" | "organisation";
  groupes?: string[];
  description?: string;
  /** Toutes les familles d'outils branchées, y compris celles branchées plus tard. */
  toutesLesFamilles?: boolean;
  /** Bases de connaissances de l'agent. */
  connaissances?: string[];
  /** Exigés pour le palier « libre ». */
  motDePasse?: string;
  code?: string;
  modele?: string;
}

export async function deployerEmploye(
  e: NouvelEmploye,
): Promise<{ employe: Employe; avertissement?: string }> {
  return lire(await poster("/oxoai/employes", e));
}

export async function modifierEmploye(
  id: string,
  changements: Partial<
    Pick<Employe, "poste" | "outils" | "missions" | "enPause" | "autonome" | "modele" | "liberte" | "description" | "toutesLesFamilles" | "connaissances" | "visibilite" | "groupes">
  > & {
    motDePasse?: string;
    code?: string;
    /** Confirmé à l'écran : sa mémoire est mise de côté puis vidée avant que son audience s'élargisse. */
    viderMemoire?: boolean;
  },
): Promise<{ employe: Employe; avertissement?: string }> {
  return lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}`, changements));
}

export async function supprimerEmploye(id: string): Promise<void> {
  await lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}/supprimer`, {}));
}

export interface EnCours {
  travail: string;
  question: string;
  depuis: string;
}

/** Ses échanges avec l'employé, et le message qu'il traite encore s'il y en a un. */
export async function lireEchanges(id: string): Promise<{ echanges: Echange[]; enCours: EnCours | null }> {
  return lire(await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/echanges`));
}

/** `avertissement` : l'instance n'a pas pu dire toutes ses exécutions (la liste n'est pas complète). */
export async function lireActivite(id: string): Promise<{ executions: Execution[]; avertissement?: string }> {
  return lire<{ executions: Execution[]; avertissement?: string }>(
    await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/activite`),
  );
}

export async function lancerMission(id: string, mission: string): Promise<void> {
  await lire(
    await poster(`/oxoai/employes/${encodeURIComponent(id)}/missions/${encodeURIComponent(mission)}/lancer`, {}),
  );
}

/** Envoie un message ; la réponse s'attend avec `attendreReponse`. */
export async function envoyerMessage(id: string, texte: string): Promise<string> {
  const { travail } = await lire<{ travail: string }>(
    await poster(`/oxoai/employes/${encodeURIComponent(id)}/message`, { texte }),
  );
  return travail;
}

/**
 * Un modèle local met souvent une à trois minutes quand l'employé se sert de
 * ses outils : la passerelle rend la main tout de suite, et on vient voir où
 * il en est.
 */
export async function attendreReponse(
  id: string,
  travail: string,
  signal: AbortSignal,
): Promise<{ reponse: string; ok: boolean }> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    if (signal.aborted) throw new DOMException("Abandonné.", "AbortError");
    const etat = await lire<{ etat: string; reponse: string | null }>(
      await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/message/${travail}`, { signal }),
    );
    if (etat.etat !== "en-cours") return { reponse: etat.reponse ?? "", ok: etat.etat === "termine" };
  }
}

/* ---- Paliers ---------------------------------------------------------- */

export const PALIERS: Record<Liberte, { titre: string; detail: string }> = {
  encadre: {
    titre: t("Encadré"),
    detail: t("Ses outils de l'entreprise, ses fichiers de travail et sa mémoire. Rien d'autre."),
  },
  etendu: {
    titre: t("Étendu"),
    detail: t("En plus : recherche sur le web, lecture de pages, navigateur, envoi de messages sur ses canaux. Ces accès ne demandent pas votre accord : une page piégée peut le détourner (sauf pendant le traitement d'un mail reçu, où il ne les a pas)."),
  },
  libre: {
    titre: t("Libre"),
    detail:
      t("En plus : commandes sur la machine de l'instance, rappels qu'il se programme, fichiers hors de son espace. Votre mot de passe est demandé."),
  },
};

/* ---- Canaux ----------------------------------------------------------- */

export async function brancherCanal(
  id: string,
  donnees: { type: TypeCanal; champs: Record<string, string>; acces: "appairage" | "liste"; autorises: string[]; outilsEntreprise: boolean; viderMemoire?: boolean },
): Promise<{ avertissement?: string }> {
  return lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}/canaux`, donnees));
}

/* ---- Mémoire mise de côté --------------------------------------------- */

export interface CopieMemoire {
  id: string;
  quand: string;
  fichiers: number;
  octets: number;
  conversations: number;
  raisons: RaisonElargissement[];
  /** Faux quand son audience est aujourd'hui plus large qu'au moment de la copie. */
  restaurable: boolean;
}

export async function lireCopiesMemoire(id: string): Promise<{ copies: CopieMemoire[]; aLuHorsEquipe: boolean }> {
  return lire(await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/memoire`));
}

export async function restaurerMemoire(id: string, copie: string): Promise<{ fichiers: number }> {
  return lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}/memoire/${encodeURIComponent(copie)}/restaurer`, {}));
}

export async function supprimerCopieMemoire(id: string, copie: string): Promise<void> {
  await lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}/memoire/${encodeURIComponent(copie)}/supprimer`, {}));
}

export async function retirerCanal(id: string, type: TypeCanal): Promise<void> {
  await lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}/canaux/${type}/retirer`, {}));
}

export async function etatCanaux(id: string): Promise<Record<string, { enMarche: boolean; detail?: string }>> {
  return (await lire<{ etat: Record<string, { enMarche: boolean; detail?: string }> }>(
    await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/canaux`),
  )).etat;
}

export async function liaisonWhatsApp(
  id: string,
  attendre: boolean,
): Promise<{ connecte: boolean; qr?: string; message: string }> {
  return lire(await poster(`/oxoai/employes/${encodeURIComponent(id)}/canaux/whatsapp/qr`, { attendre }));
}

export interface DemandeAcces {
  canal: TypeCanal;
  code: string;
  expediteur: string;
  depuis?: string;
}

export async function lireDemandes(id: string): Promise<DemandeAcces[]> {
  return (await lire<{ demandes: DemandeAcces[] }>(await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/demandes`)))
    .demandes;
}

export async function accepterDemande(id: string, canal: TypeCanal, code: string): Promise<void> {
  await lire(
    await poster(
      `/oxoai/employes/${encodeURIComponent(id)}/demandes/${canal}/${encodeURIComponent(code)}/accepter`,
      {},
    ),
  );
}

/* ---- Documents de référence ------------------------------------------ */

export interface DocumentAgent {
  nom: string;
  fichier: string;
  lecture: string;
  taille: number;
  /** Le modèle peut le lire (texte, ou texte extrait à l'envoi). */
  lisible: boolean;
}

/** Formats qu'on peut confier à un agent : ceux dont on sait tirer le texte sur le poste. */
export const ACCEPT_DOCUMENTS = ".pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.txt,.md,.csv,.json,.html,.xml";

export async function lireDocuments(id: string): Promise<DocumentAgent[]> {
  return (await lire<{ documents: DocumentAgent[] }>(await apiFetch(`/oxoai/employes/${encodeURIComponent(id)}/documents`)))
    .documents;
}

/**
 * Confie un document à un agent. Le texte est extrait ici, sur le poste (PDF,
 * Word, Excel, PowerPoint, OpenDocument), et part avec le fichier : c'est ce
 * texte que l'agent lit.
 */
export async function envoyerDocument(id: string, fichier: File, onProgression?: (fraction: number) => void): Promise<DocumentAgent[]> {
  if (fichier.size > DOCUMENT_MAX) throw new Error(tf("{0} dépasse {1}.", fichier.name, LIBELLE_DOCUMENT_MAX));
  const ext = (fichier.name.split(".").pop() ?? "").toLowerCase();
  let texte: string | undefined;
  const { EXTENSIONS_DOCUMENTS, extraireTexte } = await import("./documents");
  // Au-delà de 100 Mo, pas d'extraction sur le poste : l'agent aura le fichier, sans son texte.
  if (EXTENSIONS_DOCUMENTS.includes(ext) && fichier.size <= EXTRACTION_MAX) texte = await extraireTexte(fichier, ext);
  const r = await envoyerEnFlux<{ documents: DocumentAgent[] }>(
    `/oxoai/employes/${encodeURIComponent(id)}/documents`,
    { nom: fichier.name, taille: fichier.size, texte },
    fichier,
    onProgression,
  );
  return r.documents;
}

export async function retirerDocument(id: string, nom: string): Promise<DocumentAgent[]> {
  return (
    await lire<{ documents: DocumentAgent[] }>(
      await poster(`/oxoai/employes/${encodeURIComponent(id)}/documents/${encodeURIComponent(nom)}/supprimer`, {}),
    )
  ).documents;
}

/*
 * Fichiers choisis à la création d'un agent : ils attendent sa mise en
 * service (l'espace de l'agent n'existe qu'ensuite), puis partent tout seuls.
 */
const fichiersEnAttente = new Map<string, File[]>();

export function retenirFichiers(agentId: string, fichiers: File[]): void {
  if (fichiers.length > 0) fichiersEnAttente.set(agentId, fichiers);
}

export function prendreFichiers(agentId: string): File[] {
  const f = fichiersEnAttente.get(agentId) ?? [];
  fichiersEnAttente.delete(agentId);
  return f;
}
