import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Role } from "./types.ts";

/**
 * Profil de déploiement client.
 *
 * OxoAI est installé par l'intégrateur, réglé sur le matériel et les usages de
 * chaque client (cluster de Mac Studio, poste isolé, serveur mutualisé). Ce
 * fichier prime sur toute détection automatique : ce que l'intégrateur écrit
 * ici fait foi.
 *
 * Fichier : `oxoai.config.json` à la racine, ou chemin donné par OXOAI_CONFIG.
 * Absent, la passerelle retombe sur la détection automatique (ADR-009).
 */

export interface BackendOverride {
  id: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  /** Où tourne le service (« France », « États-Unis »…), affiché à côté de chaque modèle. */
  pays?: string;
  /** Nom du fournisseur affiché. */
  fournisseur?: string;
  /** Modèles retenus parmi ceux du fournisseur ; absent, tous. */
  modeles?: string[];
  /** Taille de conversation de ses modèles, en jetons, quand le service ne la publie pas (documentsJoints.ts). */
  contexte?: number;
}

export interface ComputerUseConfig {
  /** Environnement d'exécution : VM sandboxée ou machine hôte. */
  mode: "sandbox" | "hote" | "desactive";
  /** Image ou VM à utiliser en mode sandbox (macOS sur Apple Silicon via Lume). */
  image?: string;
  /** Exiger une approbation humaine avant chaque action à risque. */
  requireApproval: boolean;
}

export interface DeploymentProfile {
  /** Nom du client, pour les journaux et le diagnostic. */
  client?: string;
  /** Modèle imposé par rôle : « lmstudio/qwen3-8b », « exo/kimi-k2 »... */
  models?: Partial<Record<Role, string>>;
  /** Backends d'inférence à ajouter ou reconfigurer. */
  backends?: BackendOverride[];
  /** Dossier de travail auquel l'agent a accès. */
  workspace?: string;
  /**
   * Chaîne de connexion PostgreSQL de l'instance partagée.
   * Absente, les données vivent dans des fichiers JSON locaux — suffisant pour
   * un poste isolé ou une petite équipe.
   */
  database?: string;
  /** Désactive le provisionnement automatique (l'intégrateur gère les modèles). */
  autoProvision?: boolean;
  computerUse?: ComputerUseConfig;
  /**
   * Instance partagée : la passerelle écoute sur le réseau et non seulement sur
   * la boucle locale. À n'activer que pour le poste qui héberge l'instance, et
   * derrière un pare-feu — c'est cette machine qui détient les données de
   * l'entreprise.
   */
  share?: boolean;
  /**
   * Chiffrement du transport.
   *
   * Absent : en clair sur la boucle locale, **auto-signé dès que l'instance est
   * partagée** — une instance ouverte au réseau ne doit jamais servir en clair.
   * `true` force le chiffrement même en local. `false` le désactive, à réserver
   * au cas où un reverse proxy termine déjà le TLS.
   */
  tls?: boolean | { cert: string; key: string };
  /**
   * Où vit la clé de chiffrement des données.
   *
   * `trousseau` (défaut macOS) : hors du disque de données — un disque copié ne
   * suffit pas. `fichier` : à côté des données, en `-rw-------` ; plus faible,
   * mais c'est la seule option d'une instance Linux. `false` : pas de
   * chiffrement, à n'utiliser qu'en connaissance de cause.
   */
  chiffrement?: "trousseau" | "fichier" | false;
  /**
   * Autoriser l'ajout d'un connecteur MCP dont la commande n'est pas au
   * catalogue de OxoAI.
   *
   * Absent ou `false` — le défaut, et la seule valeur raisonnable pour une
   * instance partagée : seuls les connecteurs du catalogue s'installent, et
   * leur commande vient de OxoAI, jamais de la requête. `true` ouvre l'exécution
   * d'une commande arbitraire à quiconque détient une séance sur l'instance :
   * c'est de l'exécution de code sur la machine de l'entreprise. À ne mettre que
   * pour brancher un serveur MCP interne, sur une instance dont on maîtrise qui
   * s'y connecte.
   */
  connecteursLibres?: boolean;
  /**
   * Adresses des personnes qui administrent l'instance (roles.ts).
   *
   * Absent : c'est le premier compte créé qui administre — celle ou celui qui
   * a mis l'instance en route. Sur une instance d'entreprise, l'intégrateur
   * nomme ici qui en répond.
   *
   * Ce rôle n'ouvre **aucune donnée personnelle** : il ouvre la vue d'ensemble
   * du journal d'audit, c'est-à-dire des traces d'actions. Rien d'autre.
   */
  administrateurs?: string[];
  /**
   * Client OAuth Google de **cette entreprise**, pour le connecteur Google
   * Drive (gateway/src/drive.ts).
   *
   * Aucun identifiant n'est livré avec OxoAI, et c'est voulu : un client OAuth
   * commun à toutes les installations ferait de l'agence l'éditeur d'une
   * application Google qui lit le Drive de tous ses clients, avec la
   * vérification annuelle payante qu'impose la portée `drive.readonly`, et un
   * rayon de souffle égal au parc entier. Chaque entreprise crée donc son
   * propre client, de type « Application de bureau », dans sa console Google
   * Cloud, et l'intégrateur recopie ici ses deux valeurs.
   *
   * Le « secret » d'un client de bureau n'en est pas vraiment un aux yeux de
   * Google (il est livré avec l'application) ; Google l'exige pourtant à
   * l'échange du code. Il reste dans ce fichier, jamais dans une réponse.
   */
  google?: { clientId?: string; clientSecret?: string };
  /**
   * Employés OpenClaw (employes.ts). OxoAI cherche OpenClaw tout seul (PATH,
   * nvm, Homebrew) ; `chemin` impose un exécutable précis, `port` déplace
   * l'instance dédiée si 18800 est pris sur la machine.
   */
  openclaw?: {
    chemin?: string;
    port?: number;
    /** Version d'OpenClaw installée par OxoAI (défaut : celle qu'OxoAI a éprouvée). */
    version?: string;
    /** Version de Node installée pour OpenClaw (défaut : dernière 24 LTS). */
    node?: string;
  };
  /**
   * Second emplacement où recopier le journal d'audit, ligne à ligne.
   *
   * Le chaînage détecte une falsification ; il n'empêche pas la suppression du
   * fichier. Une copie sur un autre volume — partage réseau, disque de
   * sauvegarde, montage en lecture seule côté serveur — est ce qui rend le
   * journal opposable après un incident.
   */
  journalCopie?: string;
  /**
   * Durée de conservation du journal d'audit, en jours (défaut 90, entre 30 et
   * 3650). Au-delà, les journées sont effacées de l'instance ; la copie
   * `journalCopie`, elle, n'est jamais purgée.
   */
  journalConservationJours?: number;
  /**
   * Imposer la double authentification à tous les comptes de l'instance.
   *
   * Une personne qui n'en a pas encore l'active à l'écran de connexion, juste
   * après son mot de passe, avant d'obtenir la moindre séance. Les séances déjà
   * ouvertes par un compte sans second facteur cessent de valoir, et personne
   * ne peut retirer le sien depuis l'interface. Seul l'outil de récupération,
   * sur le poste qui héberge l'instance, le peut encore : la personne devra
   * alors le réactiver à sa connexion suivante.
   */
  deuxFacteursObligatoire?: boolean;
  /**
   * La recherche sur le web du Chat (rechercheWeb.ts, 28/09/2026). Absent ou
   * `true` : chacun peut l'activer dans le menu « + », question par question,
   * et rien ne part tant qu'elle n'est pas activée. `false` : l'entrée reste
   * visible mais désactivée, et l'écran dit que c'est ce profil qui l'interdit ;
   * la passerelle refuse aussi une demande qui la réclamerait quand même.
   *
   * Ne touche ni au palier « étendu » des employés OpenClaw ni à la recherche
   * web de OxoAI Code, qui ont leurs propres réglages.
   */
  rechercheWeb?: boolean;
}

const DEFAULT_PROFILE: DeploymentProfile = {
  autoProvision: true,
  computerUse: { mode: "desactive", requireApproval: true },
};

function locate(): string | null {
  const explicit = process.env.OXOAI_CONFIG;
  if (explicit && existsSync(explicit)) return explicit;
  const local = resolvePath(process.cwd(), "oxoai.config.json");
  return existsSync(local) ? local : null;
}

let cached: DeploymentProfile | null = null;
/** Champs réellement écrits dans le fichier, par opposition aux valeurs par défaut. */
let ecrits = new Set<string>();

/**
 * Le profil fixe-t-il lui-même ce réglage ? Un réglage écrit par
 * l'intégrateur fait foi : l'interface ne peut ni l'assouplir ni le changer.
 */
export function champImpose(cle: keyof DeploymentProfile): boolean {
  deployment();
  return ecrits.has(cle);
}

export function deployment(): DeploymentProfile {
  if (cached) return cached;

  const path = locate();
  if (!path) {
    cached = DEFAULT_PROFILE;
    return cached;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DeploymentProfile;
    cached = { ...DEFAULT_PROFILE, ...parsed };
    ecrits = new Set(Object.keys(parsed));
    console.log(
      `[oxoai] profil de déploiement chargé : ${path}` +
        (parsed.client ? ` (client : ${parsed.client})` : ""),
    );
    return cached;
  } catch (err) {
    console.error(
      `[oxoai] profil de déploiement illisible (${path}), retour aux valeurs par défaut :`,
      err instanceof Error ? err.message : err,
    );
    cached = DEFAULT_PROFILE;
    return cached;
  }
}

/** Modèle imposé pour un rôle, s'il est fixé par le profil client. */
export function pinnedModel(role: Role): string | undefined {
  return deployment().models?.[role];
}

export function autoProvisionEnabled(): boolean {
  return deployment().autoProvision !== false;
}
