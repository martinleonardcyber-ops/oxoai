import { deployment } from "./deployment.ts";
import { ouverteDepuisLEcran } from "./reseau.ts";
import { cleLlamaCpp, moteurOuvert, urlLlamaCpp } from "./llamaCppBase.ts";
import type { BackendConfig, Role } from "./types.ts";

/** Port d'écoute de la passerelle. */
export const PORT = Number(process.env.OXOAI_GATEWAY_PORT ?? 8787);

/**
 * Interface d'écoute. **Boucle locale par défaut** : sur un poste autonome, la
 * passerelle donne accès aux fichiers et à l'exécution d'outils, elle n'a
 * aucune raison d'être joignable depuis le réseau. Une instance partagée
 * l'ouvre explicitement — `OXOAI_GATEWAY_HOST=0.0.0.0`, ou `share: true` dans
 * le profil de déploiement — pour que ce soit une décision, pas un défaut.
 */
/**
 * Trois façons d'ouvrir l'instance au réseau, dans l'ordre de priorité :
 * la variable d'environnement (essais, conteneurs), le profil de déploiement
 * posé par l'intégrateur, et l'interrupteur réglé depuis l'écran
 * (`reseau.ts`) — celui qui permet à une personne d'inviter un collègue sans
 * éditer de fichier.
 */
/*
 * Une variable **vide** compte comme absente. `listen(port, "")` n'écoute pas
 * « nulle part » mais **partout** : toutes les interfaces, comme 0.0.0.0. Et
 * `surLeReseau`, ci-dessous, tient "" pour local — l'instance se serait donc
 * ouverte au réseau sans chiffrement, tout en se croyant sur la boucle locale.
 * Trouvé par la batterie de sécurité (scripts/securite.mjs).
 */
const hoteDemande = process.env.OXOAI_GATEWAY_HOST?.trim();
export const HOST =
  hoteDemande ||
  (deployment().share || ouverteDepuisLEcran() ? "0.0.0.0" : "127.0.0.1");

/**
 * L'instance est-elle joignable depuis le réseau ?
 *
 * Une seule fonction, parce que deux endroits en décidaient séparément et ne
 * disaient pas la même chose : `tls.ts` ne chiffrait que sur `share: true` ou
 * `OXOAI_GATEWAY_HOST=0.0.0.0`. Une adresse d'écoute nommée — `192.168.1.10`,
 * `::`, le nom de la machine — ouvrait donc l'instance au réseau **en clair**,
 * jetons compris, sans que rien ne le signale.
 */
export const surLeReseau = (): boolean =>
  !["127.0.0.1", "::1", "localhost", ""].includes(HOST.trim().toLowerCase());

const BASE_BACKENDS: BackendConfig[] = [
  {
    id: "exo",
    label: "Cluster exo",
    baseUrl: process.env.OXOAI_EXO_URL ?? "http://localhost:52415/v1",
    kind: "exo",
    priority: 5,
    enabled: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: process.env.OXOAI_LMSTUDIO_URL ?? "http://localhost:1234/v1",
    kind: "lmstudio",
    priority: 10,
    // Coupé là où sert le moteur ouvert (Mac Intel) : un seul moteur local à la fois (llamaCppBase.ts).
    enabled: !moteurOuvert(),
  },
  /*
   * Le moteur ouvert, llama.cpp (MIT), posé et démarré par OxoAI
   * (llamaCpp.ts, 28/09/2026) : sur 127.0.0.1, avec une clé tirée pour
   * cette machine. Ses modèles sont chargés à 32 768 jetons, comme ceux de
   * LM Studio sur une machine de 36 Go ou moins (`optionsDeChargement`).
   */
  ...(moteurOuvert()
    ? [
        {
          id: "llamacpp",
          label: "llama.cpp",
          baseUrl: urlLlamaCpp(),
          kind: "llamacpp" as const,
          priority: 10,
          apiKey: cleLlamaCpp(),
          enabled: true,
          contexte: 32_768,
        },
      ]
    : []),
];

/**
 * Backends d'inférence, du plus prioritaire au moins prioritaire.
 * Mode strict EU/local : aucun fournisseur américain par défaut. Les clouds
 * européens (tous OpenAI-compatibles) s'ajoutent par le profil de déploiement,
 * qui peut aussi reconfigurer ou désactiver les backends de base.
 */
export const BACKENDS: BackendConfig[] = (() => {
  const overrides = deployment().backends ?? [];
  const merged = BASE_BACKENDS.map((base) => {
    const patch = overrides.find((o) => o.id === base.id);
    return { ...base, ...(patch ?? {}), origine: "local" } as BackendConfig;
  });
  // Backends supplémentaires propres au client (cloud européen, second cluster).
  for (const extra of overrides) {
    if (merged.some((b) => b.id === extra.id)) continue;
    if (!extra.baseUrl) continue;
    merged.push({
      id: extra.id,
      label: extra.label ?? extra.id,
      baseUrl: extra.baseUrl,
      kind: "openai-compatible",
      priority: extra.priority ?? 20,
      apiKey: extra.apiKey,
      enabled: extra.enabled !== false,
      // Fourni et facturé par l'agence : visible de tous, choisi d'office si le profil le veut.
      origine: "agence",
      pays: extra.pays,
      fournisseur: extra.fournisseur ?? extra.label ?? extra.id,
      ...(extra.modeles ? { modeles: extra.modeles } : {}),
      ...(typeof extra.contexte === "number" && extra.contexte >= 1024 ? { contexte: Math.floor(extra.contexte) } : {}),
    });
  }
  return merged;
})();

/*
 * Backends ajoutés depuis l'interface (clés de fournisseurs cloud,
 * fournisseurs.ts). Branchés par enregistrement plutôt que par import : le
 * magasin, qui les garde, dépend lui-même de la configuration.
 */
let supplementaires: () => BackendConfig[] = () => [];

export function brancherBackendsSupplementaires(source: () => BackendConfig[]): void {
  supplementaires = source;
}

/** Tous les backends : ceux de la machine, ceux du profil, ceux des clés. */
export function tousLesBackends(): BackendConfig[] {
  return [...BACKENDS, ...supplementaires()];
}

/**
 * Classification heuristique des modèles par rôle, à partir de leur identifiant.
 * Heuristique assumée : la plupart des serveurs OpenAI-compatibles n'exposent
 * aucune métadonnée de capacité. Affinable via un catalogue explicite.
 */
const ROLE_RULES: Record<Role, { include: RegExp[]; exclude?: RegExp[] }> = {
  embed: {
    include: [/embed/i, /bge-/i, /e5-/i, /nomic/i],
  },
  /*
   * Modèles capables de pointer un élément d'interface à partir d'une capture.
   * OpenCUA est le plus précis des modèles ouverts sur ce point ; Qwen3-VL le
   * suit et sert de repli quand la machine est plus modeste.
   */
  gui: {
    include: [/open-?cua/i, /ui-?tars/i, /showui/i, /cogagent/i, /qwen3-vl/i, /holo/i],
  },
  vision: {
    include: [/\bvl\b/i, /vision/i, /llava/i, /-vl-/i, /pixtral/i, /gemma-3/i],
    exclude: [/ui-?tars/i, /open-?cua/i],
  },
  code: {
    include: [/coder/i, /code/i, /devstral/i, /qwen3/i, /kimi/i, /glm/i, /deepseek/i],
    // Un modèle de vision reste mauvais en code : il ne doit pas capter ce rôle.
    exclude: [/embed/i, /ui-?tars/i, /nomic/i, /-vl-/i, /open-?cua/i],
  },
  chat: {
    include: [/.*/],
    exclude: [/embed/i, /bge-/i, /e5-/i, /nomic/i, /ui-?tars/i, /rerank/i],
  },
};

/** Modèles connus pour émettre un canal de raisonnement séparé. */
const REASONING_PATTERNS = [/qwen3/i, /kimi.*think/i, /deepseek-r/i, /magistral/i, /\bqwq\b/i];

export function classifyRoles(modelId: string): Role[] {
  const roles: Role[] = [];
  for (const [role, rule] of Object.entries(ROLE_RULES) as [Role, typeof ROLE_RULES[Role]][]) {
    const excluded = rule.exclude?.some((re) => re.test(modelId)) ?? false;
    if (excluded) continue;
    if (rule.include.some((re) => re.test(modelId))) roles.push(role);
  }
  return roles;
}

export function isReasoningModel(modelId: string): boolean {
  return REASONING_PATTERNS.some((re) => re.test(modelId));
}

/**
 * Niveaux de raisonnement proposés à l'écran, et ce qu'ils changent vraiment.
 *
 * ── Pourquoi trois réglages ne suffisaient pas ──────────────────────────────
 *
 * Le réglage ne faisait qu'une chose : relever un **plancher** de jetons. Un
 * client qui demandait déjà large ne voyait donc aucune différence entre
 * « rapide » et « approfondi ». Un bouton qui ne change rien est pire qu'un
 * bouton absent.
 *
 * Trois leviers, du plus sûr au moins répandu :
 *
 * 1. `minTokens` — le plancher d'origine. Il reste utile : un petit modèle
 *    dépense tout son budget à réfléchir et ne répond plus. Il vaut pour tous
 *    les moteurs, sans exception.
 * 2. `reasoning_effort` — champ OpenAI, suivi par la plupart des moteurs
 *    compatibles. C'est lui qui fait réellement réfléchir plus ou moins.
 * 3. `chat_template_kwargs.enable_thinking` — la façon dont LM Studio, vLLM et
 *    llama.cpp coupent le raisonnement d'un Qwen3 ou d'un DeepSeek.
 *
 * Les deux derniers sont des extensions : un moteur qui ne les connaît pas
 * refuse la requête entière. `chat.ts` la rejoue alors une fois sans eux et le
 * retient pour ce moteur, comme il le fait déjà pour `stream_options`. Le
 * niveau choisi garde dans tous les cas son effet sur le plancher.
 */
export interface NiveauEffort {
  /** Plancher de jetons : raisonner **et** répondre. */
  minTokens: number;
  /** Faut-il raisonner du tout ? */
  raisonner: boolean;
  /** Valeur de `reasoning_effort` envoyée au moteur, si elle a un sens. */
  amont?: "low" | "medium" | "high";
  /**
   * Consigne de profondeur, adressée au modèle lui-même.
   *
   * C'est le seul levier qui agit sur un modèle servi par LM Studio : mesuré
   * sur Qwen3 8B le 23/09/2026, `reasoning_effort` « low » et « high »
   * donnaient la même réflexion (232 et 263 jetons, du bruit), et
   * `enable_thinking` n'était pas transmis non plus. Une consigne brève
   * donnait 168 jetons de réflexion, une consigne approfondie 478 : du simple
   * au triple, sur la même question. Le moteur qui comprend
   * `reasoning_effort` reçoit les deux ; ils vont dans le même sens.
   */
  consigne?: string;
}

export const NIVEAUX_EFFORT: Record<string, NiveauEffort> = {
  aucun: { minTokens: 0, raisonner: false },
  faible: {
    minTokens: 768,
    raisonner: true,
    amont: "low",
    consigne: "Réfléchis brièvement avant de répondre : quelques lignes au plus.",
  },
  // Le niveau habituel : le modèle réfléchit comme il l'entend, sans consigne.
  moyen: { minTokens: 2048, raisonner: true, amont: "medium" },
  eleve: {
    minTokens: 6144,
    raisonner: true,
    amont: "high",
    consigne: "Réfléchis soigneusement avant de répondre : examine la question sous plusieurs angles.",
  },
  max: {
    minTokens: 16384,
    raisonner: true,
    amont: "high",
    consigne:
      "Réfléchis en profondeur avant de répondre : examine la question sous plusieurs angles, " +
      "vérifie chaque calcul et chaque affirmation deux fois, et cherche ce qui pourrait être faux.",
  },
};

/**
 * Anciens identifiants, encore enregistrés dans les profils d'avant.
 * Un poste qui n'a pas rouvert ses préférences continue d'envoyer « auto ».
 */
const ANCIENS: Record<string, string> = {
  rapide: "faible",
  auto: "moyen",
  approfondi: "eleve",
};

export const EFFORT_DEFAUT = "moyen";

export function niveauEffort(id: string | undefined): NiveauEffort {
  const cle = id ? (ANCIENS[id] ?? id) : EFFORT_DEFAUT;
  return NIVEAUX_EFFORT[cle] ?? NIVEAUX_EFFORT[EFFORT_DEFAUT];
}
