/** Rôles fonctionnels exposés par la passerelle (cf. ADR-001). */
export type Role = "chat" | "code" | "vision" | "gui" | "embed";

export const ROLES: Role[] = ["chat", "code", "vision", "gui", "embed"];

/** Type de backend d'inférence. */
export type BackendKind = "lmstudio" | "llamacpp" | "exo" | "openai-compatible";

/**
 * Un moteur de modèles posé sur cette machine par OxoAI : LM Studio, ou
 * llama.cpp sur un Mac Intel (llamaCpp.ts, 28/09/2026). Ce qui vaut pour « le
 * modèle local » (outils allégés, taille de conversation connue, essai de
 * santé, découpage des tâches) vaut pour les deux ; ce qui passe par `lms`
 * reste à LM Studio seul.
 */
export const moteurDeLaMachine = (kind: BackendKind | string | undefined): boolean => kind === "lmstudio" || kind === "llamacpp";

export interface BackendConfig {
  id: string;
  label: string;
  /** Racine de l'API OpenAI-compatible, sans slash final (ex. http://localhost:1234/v1). */
  baseUrl: string;
  kind: BackendKind;
  /** Plus petit = préféré. Le cluster passe avant le poste local. */
  priority: number;
  /** Clé API si le backend en exige une (clouds EU). */
  apiKey?: string;
  /** Backend désactivé sans être retiré de la configuration. */
  enabled: boolean;
  /**
   * D'où vient ce backend : la machine ou le cluster (`local`), le profil de
   * déploiement de l'agence (`agence`), ou une clé ajoutée depuis l'interface
   * (`cle`, voir fournisseurs.ts). Un modèle `cle` n'est jamais choisi
   * d'office : il coûte à quelqu'un, il faut le demander.
   */
  origine?: "local" | "agence" | "cle";
  /** Clé personnelle : seul ce compte (et ses employés) peut s'en servir. */
  proprietaire?: string;
  /** Modèles retenus parmi ceux du fournisseur ; absent, tous. */
  modeles?: string[];
  /** Où tourne le service, pour que chacun sache où partent ses messages. */
  pays?: string;
  /** Nom du fournisseur affiché (« Mistral AI », « OpenAI »…). */
  fournisseur?: string;
  /** En-têtes propres au fournisseur. */
  entetes?: Record<string, string>;
  /** Identifiant du fournisseur au catalogue (fournisseurs.ts : « openai », « anthropic »…), pour une clé. */
  catalogue?: string;
  /** En-tête qui porte la clé pour lister les modèles, quand ce n'est pas `Authorization` (modelesCloud.ts). */
  cleEnTete?: string;
  /**
   * Taille de conversation de ses modèles, en jetons, quand on la connaît
   * mieux que lui (profil de déploiement) : sert à mesurer la place d'un
   * document joint (documentsJoints.ts, 27/09/2026).
   */
  contexte?: number;
}

export interface BackendStatus {
  id: string;
  label: string;
  kind: BackendKind;
  baseUrl: string;
  online: boolean;
  /** Latence du contrôle de santé, en millisecondes. */
  latencyMs?: number;
  error?: string;
  modelCount: number;
}

export interface ModelInfo {
  /** Identifiant tel qu'attendu par le backend. */
  id: string;
  /** Identifiant qualifié unique côté passerelle : "<backend>/<id>". */
  uid: string;
  backendId: string;
  backendLabel: string;
  backendKind: BackendKind;
  /** Rôles que ce modèle peut tenir. */
  roles: Role[];
  /** Modèle actuellement chargé en mémoire (info LM Studio). */
  loaded?: boolean;
  /** Taille sur disque, en octets. */
  sizeBytes?: number;
  /** Nombre de paramètres affiché (ex. "8B"). */
  params?: string;
  /** Famille d'architecture (ex. "qwen3"). */
  arch?: string;
  /** Nature déclarée par LM Studio : "llm" ou "embedding". Sert à trier, pas à afficher. */
  nature?: string;
  /** Déclaré par LM Studio : lit les images. */
  voit?: boolean;
  /** Déclaré par LM Studio : sait appeler des outils. */
  outils?: boolean;
  /** LM Studio : taille de conversation la plus grande que le modèle accepte (`maxContextLength`). */
  contexteMax?: number;
  /** LM Studio : taille de conversation avec laquelle il est chargé en ce moment (`contextLength`), s'il l'est. */
  contexteCharge?: number;
  /**
   * Autre service : taille de conversation publiée dans sa liste de modèles
   * (`context_length`, `max_context_length`, `max_model_len`), s'il la publie.
   */
  contextePublie?: number;
  /**
   * Entraîné sur cette machine (entrainement.ts). Choisissable dans le
   * sélecteur, jamais choisi d'office : c'est un petit modèle spécialisé.
   */
  entraine?: boolean;
  /** Le modèle émet un canal de raisonnement séparé. */
  reasoning?: boolean;
  /** Voir `BackendConfig` : origine, clé personnelle, pays, fournisseur. */
  origine?: "local" | "agence" | "cle";
  proprietaire?: string;
  pays?: string;
  fournisseur?: string;
  /** Fournisseur cloud reconnu (prixPublies.ts : « openai », « mistral »…), pour ses prix et ses noms de modèles. */
  catalogue?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Corps accepté par /v1/chat/completions (surensemble d'OpenAI). */
export interface ChatRequest {
  /** Modèle explicite (`uid` ou identifiant brut). Prioritaire sur `role`. */
  model?: string;
  /** Extension OxoAI : laisser la passerelle choisir le modèle du rôle. */
  role?: Role;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Extension OxoAI : niveau d'effort de raisonnement issu de l'UI. */
  effort?: "adaptatif" | "aucun" | "faible" | "moyen" | "eleve" | "max";
  /** Extension OxoAI : autoriser l'agent à utiliser les outils MCP. */
  tools?: boolean;
  [key: string]: unknown;
}
