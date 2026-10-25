import { formesDuNom, indexerParNom } from "./nomsModeles.ts";

/**
 * Prix publiés par les fournisseurs cloud, en jetons d'entrée et de sortie.
 *
 * ── D'où viennent ces chiffres ──────────────────────────────────────────────
 *
 * Relevés le 27/09/2026 sur la page de prix officielle de chaque fournisseur
 * que OxoAI sait brancher par clé (fournisseurs.ts), et recopiés tels qu'ils
 * y sont écrits : rien n'est déduit d'un graphique, converti d'une devise à
 * l'autre ni arrondi. Un modèle absent de la page n'a pas de ligne, et un
 * fournisseur dont la page ne donne pas de prix lisible (Groq pour Llama :
 * « Contact sales ») n'en a pas non plus pour ce modèle.
 *
 * Ce qui est pris : le tarif standard, par million de jetons, pour un contexte
 * court quand la page distingue (OpenAI « short context », Google et xAI
 * « ≤ 200k », Anthropic « Base input tokens »). Ce qui ne l'est pas : le cache,
 * le traitement par lots, la priorité, les paliers gratuits. Un coût calculé
 * avec ces prix est donc une **estimation**, et l'écran le dit.
 *
 * Deux usages, un seul fichier (la passerelle et l'interface le lisent) :
 *  - « Mon usage » (usage.ts) : un modèle cloud sans tarif saisi prend le prix
 *    publié par **son** fournisseur, jamais celui d'un autre (le même Llama
 *    coûte 0,65 € chez IONOS et 0,90 € chez Scaleway) ;
 *  - « Comparer les modèles » : le prix de l'éditeur du modèle, en dollars.
 *
 * Demandé par Medhi le 27/09/2026 : « dans mon usage ça serait sympa d'avoir
 * le tarif de tous les modèles cloud ». Les prix changent : la date du relevé
 * et le lien vers la page sont affichés avec chaque montant.
 */

export type Devise = "USD" | "EUR";

export interface FournisseurPrix {
  /** Identifiant au catalogue des fournisseurs (fournisseurs.ts). */
  id: string;
  nom: string;
  /** Page lue. */
  page: string;
  /** Date du relevé, AAAA-MM-JJ. */
  releveLe: string;
  /** Devise dans laquelle le fournisseur facture, et dans laquelle ses prix sont pris. */
  devise: Devise;
  /** Hôtes de son API : reconnaître un backend déclaré sans catalogue (profil de l'agence). */
  hotes: string[];
}

export interface Tarif {
  devise: Devise;
  /** Par million de jetons d'entrée. */
  entree: number;
  /** Par million de jetons de sortie. */
  sortie: number;
  /** Premier jour d'application, quand la page en annonce un. */
  depuis?: string;
  /** Dernier jour d'application, quand la page en annonce un (prix de lancement). */
  jusquAu?: string;
}

export interface LignePrix {
  fournisseur: string;
  /** Noms du modèle tels que la page les écrit (nom commercial, identifiant d'API). */
  noms: string[];
  /**
   * Identifiants d'API que le fournisseur dit servis par ce modèle, sans être
   * son nom : « deepseek-v4-flash » est facturé au prix de DeepSeek V4.1
   * Flash. Comptent pour « Mon usage », pas pour placer le modèle sur le
   * graphique (ce serait prêter à l'ancien modèle le prix du nouveau).
   */
  api?: string[];
  prix: Tarif[];
}

export const FOURNISSEURS_PRIX: FournisseurPrix[] = [
  // Adresse suivie le 28/09/2026 : platform.openai.com/docs/pricing y renvoie (301).
  { id: "openai", nom: "OpenAI", page: "https://developers.openai.com/api/docs/pricing", releveLe: "2026-09-27", devise: "USD", hotes: ["api.openai.com"] },
  { id: "anthropic", nom: "Anthropic", page: "https://platform.claude.com/docs/en/about-claude/pricing", releveLe: "2026-09-27", devise: "USD", hotes: ["api.anthropic.com"] },
  { id: "google", nom: "Google", page: "https://ai.google.dev/gemini-api/docs/pricing", releveLe: "2026-09-27", devise: "USD", hotes: ["generativelanguage.googleapis.com"] },
  // La page affiche les deux devises ; Mistral facture en euros, ce sont eux qui comptent pour « Mon usage ».
  { id: "mistral", nom: "Mistral AI", page: "https://mistral.ai/pricing/api", releveLe: "2026-09-27", devise: "EUR", hotes: ["api.mistral.ai"] },
  // Tarif plein (heures de pointe) : hors pointe, la page annonce la moitié. L'estimation est donc un plafond.
  { id: "deepseek", nom: "DeepSeek", page: "https://api-docs.deepseek.com/quick_start/pricing", releveLe: "2026-09-27", devise: "USD", hotes: ["api.deepseek.com"] },
  { id: "xai", nom: "xAI", page: "https://docs.x.ai/docs/pricing", releveLe: "2026-09-27", devise: "USD", hotes: ["api.x.ai"] },
  { id: "groq", nom: "Groq", page: "https://console.groq.com/docs/models", releveLe: "2026-09-27", devise: "USD", hotes: ["api.groq.com"] },
  { id: "together", nom: "Together AI", page: "https://www.together.ai/pricing", releveLe: "2026-09-27", devise: "USD", hotes: ["api.together.xyz"] },
  // Région Paris ; le premier million de jetons est offert, ce que l'estimation ne retire pas.
  { id: "scaleway", nom: "Scaleway", page: "https://www.scaleway.com/en/pricing/model-as-a-service/", releveLe: "2026-09-27", devise: "EUR", hotes: ["api.scaleway.ai"] },
  { id: "ovhcloud", nom: "OVHcloud", page: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/", releveLe: "2026-09-27", devise: "EUR", hotes: ["oai.endpoints.kepler.ai.cloud.ovh.net"] },
  // La page anglaise affiche des dollars, l'allemande des euros : celle du point d'accès de Berlin (de-txl) fait foi.
  { id: "ionos", nom: "IONOS", page: "https://cloud.ionos.de/managed/ai-model-hub", releveLe: "2026-09-27", devise: "EUR", hotes: ["openai.inference.de-txl.ionos.com"] },
  // Lu dans la liste publique des modèles (prix par jeton, multipliés par un million).
  { id: "openrouter", nom: "OpenRouter", page: "https://openrouter.ai/api/v1/models", releveLe: "2026-09-27", devise: "USD", hotes: ["openrouter.ai"] },
];

const DEVISE_DE = new Map(FOURNISSEURS_PRIX.map((f) => [f.id, f.devise]));

/** Une ligne à un seul prix, dans la devise du fournisseur. */
function un(fournisseur: string, noms: string[], entree: number, sortie: number, api?: string[]): LignePrix {
  return { fournisseur, noms, ...(api ? { api } : {}), prix: [{ devise: DEVISE_DE.get(fournisseur) ?? "USD", entree, sortie }] };
}

/** Mistral : la page donne les deux devises, on garde les deux (euros pour l'usage, dollars pour le graphique). */
function mistral(noms: string[], api: string[], eur: [number, number], usd: [number, number]): LignePrix {
  return {
    fournisseur: "mistral",
    noms,
    api,
    prix: [
      { devise: "EUR", entree: eur[0], sortie: eur[1] },
      { devise: "USD", entree: usd[0], sortie: usd[1] },
    ],
  };
}

/** Google : prix de lancement jusqu'au 31/12/2026, puis le prix annoncé pour le 01/01/2027. */
function googleLancement(nom: string): LignePrix {
  return {
    fournisseur: "google",
    noms: [nom],
    prix: [
      { devise: "USD", entree: 0.75, sortie: 3.75, jusquAu: "2026-12-31" },
      { devise: "USD", entree: 1.5, sortie: 7.5, depuis: "2027-01-01" },
    ],
  };
}

export const PRIX_PUBLIES: LignePrix[] = [
  /* OpenAI : « Standard », contexte court. */
  un("openai", ["gpt-6-astra"], 10, 50),
  un("openai", ["gpt-6-sol"], 2, 10),
  un("openai", ["gpt-6-luna"], 0.1, 0.5),
  un("openai", ["gpt-5.6-sol"], 4, 20),
  un("openai", ["gpt-5.6-terra"], 2, 12),
  un("openai", ["gpt-5.6-luna"], 0.2, 1.2),
  un("openai", ["gpt-5.5"], 5, 30),
  un("openai", ["gpt-5.5-pro"], 30, 180),
  un("openai", ["gpt-5.4"], 2.5, 15),
  un("openai", ["gpt-5.4-mini"], 0.75, 4.5),
  un("openai", ["gpt-5.4-nano"], 0.2, 1.25),
  un("openai", ["gpt-5.4-pro"], 30, 180),
  un("openai", ["gpt-5.3-codex"], 1.75, 14),
  un("openai", ["gpt-5.2"], 1.75, 14),
  un("openai", ["gpt-5.2-pro"], 21, 168),
  un("openai", ["gpt-5.1"], 1.25, 10),
  un("openai", ["gpt-5"], 1.25, 10),
  un("openai", ["gpt-5-mini"], 0.25, 2),
  un("openai", ["gpt-5-nano"], 0.05, 0.4),
  un("openai", ["gpt-5-pro"], 15, 120),
  un("openai", ["gpt-4.1"], 2, 8),
  un("openai", ["gpt-4.1-mini"], 0.4, 1.6),
  un("openai", ["gpt-4.1-nano"], 0.1, 0.4),
  un("openai", ["gpt-4o"], 2.5, 10),
  un("openai", ["gpt-4o-2024-05-13"], 5, 15),
  un("openai", ["gpt-4o-mini"], 0.15, 0.6),
  un("openai", ["o1"], 15, 60),
  un("openai", ["o1-pro"], 150, 600),
  un("openai", ["o3-pro"], 20, 80),
  un("openai", ["o3"], 2, 8),
  un("openai", ["o4-mini"], 1.1, 4.4),
  un("openai", ["o3-mini"], 1.1, 4.4),
  un("openai", ["gpt-4-turbo-2024-04-09"], 10, 30),
  un("openai", ["gpt-4-0613"], 30, 60),
  un("openai", ["gpt-3.5-turbo"], 0.5, 1.5),

  /* Anthropic : « Base input tokens » et « Output tokens » ; ni les modèles retirés ni ceux sur invitation. */
  un("anthropic", ["Claude Fable 5.1"], 10, 50),
  un("anthropic", ["Claude Fable 5"], 10, 50),
  un("anthropic", ["Claude Opus 5.5"], 4, 20),
  un("anthropic", ["Claude Opus 5"], 5, 25),
  un("anthropic", ["Claude Opus 4.8"], 5, 25),
  un("anthropic", ["Claude Opus 4.7"], 5, 25),
  un("anthropic", ["Claude Opus 4.6"], 5, 25),
  un("anthropic", ["Claude Opus 4.5"], 5, 25),
  un("anthropic", ["Claude Sonnet 5"], 2, 10),
  un("anthropic", ["Claude Sonnet 4.6"], 3, 15),
  un("anthropic", ["Claude Sonnet 4.5"], 3, 15),
  un("anthropic", ["Claude Haiku 4.5"], 1, 5),

  /* Google : « Standard », offre payante, texte, invites de 200k jetons au plus. */
  googleLancement("gemini-3.8-flash"),
  googleLancement("gemini-3.7-flash"),
  googleLancement("gemini-3.6-flash"),
  un("google", ["gemini-3.5-flash"], 1.5, 9),
  un("google", ["gemini-3.5-flash-lite"], 0.3, 2.5),
  un("google", ["gemini-3.1-flash-lite"], 0.25, 1.5),
  un("google", ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"], 2, 12),
  un("google", ["gemini-3-flash-preview"], 0.5, 3),
  un("google", ["gemini-2.5-pro"], 1.25, 10),
  un("google", ["gemini-2.5-flash"], 0.3, 2.5),
  un("google", ["gemini-2.5-flash-lite"], 0.1, 0.4),

  /* Mistral : noms de la page de prix, identifiants d'API lus sur la fiche de chaque modèle (docs.mistral.ai). */
  mistral(["Mistral Medium 3.5"], ["mistral-medium-3-5", "mistral-medium-3", "mistral-medium-latest"], [1.25, 6.4], [1.5, 7.5]),
  mistral(["Mistral Small 4"], ["mistral-small-2603", "mistral-small-latest"], [0.12, 0.5], [0.15, 0.6]),
  mistral(["Mistral Large 3"], ["mistral-large-2512", "mistral-large-latest"], [0.44, 1.3], [0.5, 1.5]),
  mistral(["Codestral"], ["codestral-2508", "codestral-latest"], [0.26, 0.79], [0.3, 0.9]),
  mistral(["Ministral 3 3B"], ["ministral-3b-2512", "ministral-3b-latest"], [0.088, 0.088], [0.1, 0.1]),
  mistral(["Ministral 3 8B"], ["ministral-8b-2512", "ministral-8b-latest"], [0.13, 0.13], [0.15, 0.15]),
  mistral(["Ministral 3 14B"], ["ministral-14b-2512", "ministral-14b-latest"], [0.18, 0.18], [0.2, 0.2]),

  /* DeepSeek : « deepseek-flash » et les anciens noms, facturés au prix de Flash (note 1 de la page). */
  un("deepseek", ["DeepSeek-V4.1-Flash"], 0.3, 1.2, ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]),
  un("deepseek", ["DeepSeek-V4-Pro-0813"], 1.32, 3.96, ["deepseek-v4-pro"]),

  /* xAI : invites de moins de 200k jetons. */
  un("xai", ["grok-4.7"], 2, 6),
  un("xai", ["grok-4.6"], 2, 6),
  un("xai", ["grok-4.5"], 2, 6),
  un("xai", ["grok-4.3"], 1.25, 2.5),
  un("xai", ["grok-4.20-0309-reasoning"], 1.25, 2.5),
  un("xai", ["grok-4.20-0309-non-reasoning"], 1.25, 2.5),
  un("xai", ["grok-build-0.1"], 1, 2),

  /* Groq : modèles de production et d'essai qui ont un prix (Llama : « Contact sales »). */
  un("groq", ["openai/gpt-oss-120b"], 0.15, 0.6),
  un("groq", ["openai/gpt-oss-20b"], 0.075, 0.3),
  un("groq", ["openai/gpt-oss-safeguard-20b"], 0.075, 0.3),
  un("groq", ["qwen/qwen3.8-27b"], 0.8, 4),

  /* Together : noms de la page (elle ne donne pas les identifiants d'API). */
  un("together", ["Kimi K3"], 3, 15),
  un("together", ["MiniMax M3"], 0.3, 1.2),
  un("together", ["Qwen3.8-2.4T-A95B"], 2, 6),
  un("together", ["Muse Glimmer 30B"], 0.35, 1.5),
  un("together", ["DeepSeek V4 Pro 0813"], 1.32, 3.96),
  un("together", ["GLM-5.3"], 1.4, 4.4),
  un("together", ["GLM-5.3-Flash"], 0.15, 0.5),
  un("together", ["DeepSeek V4.1 Flash"], 0.3, 1.2),
  un("together", ["Gemma 4 31B"], 0.39, 0.97),
  un("together", ["Qwen3.7-Plus"], 0.32, 1.28),
  un("together", ["GLM-5.2"], 1.4, 4.4),
  un("together", ["Inkling"], 1, 4.05),
  un("together", ["DeepSeek V4 Flash 0731"], 0.14, 0.28),
  un("together", ["Qwen3.8 Flash"], 0.09, 0.28),
  un("together", ["Qwen3.7-Max"], 1.5, 4.5),
  un("together", ["gpt-oss-120B"], 0.15, 0.6),
  un("together", ["Qwen3.5-397B-A17B"], 0.6, 3.6),
  un("together", ["Qwen3.5 9B"], 0.17, 0.25),
  un("together", ["Llama 3.3 70B"], 1.04, 1.04),
  un("together", ["MiniMax M2.7"], 0.3, 1.2),
  un("together", ["Qwen3.6-Plus"], 0.5, 3),

  /* Scaleway : région Paris, identifiants d'API de la page. */
  un("scaleway", ["glm-5.2"], 1.8, 5.5),
  un("scaleway", ["deepseek-v4-flash-0731"], 0.4, 0.8),
  un("scaleway", ["qwen3.8-27b"], 0.6, 3.3),
  un("scaleway", ["gemma-4-26b-a4b-it"], 0.25, 0.5),
  un("scaleway", ["mistral-medium-3.5-128b"], 1.5, 7.5),
  un("scaleway", ["llama-3.3-70b-instruct"], 0.9, 0.9),
  un("scaleway", ["qwen3-235b-a22b-instruct-2507"], 0.75, 2.25),
  un("scaleway", ["qwen3-coder-30b-a3b-instruct"], 0.2, 0.8),
  un("scaleway", ["pixtral-12b-2409"], 0.2, 0.2),
  un("scaleway", ["mistral-small-3.2-24b-instruct-2506"], 0.15, 0.35),
  un("scaleway", ["gpt-oss-120b"], 0.15, 0.6),
  un("scaleway", ["qwen3.6-35b-a3b"], 0.25, 1.5),
  un("scaleway", ["qwen3.5-397b-a17b"], 0.6, 3.6),

  /* OVHcloud AI Endpoints : catalogue. */
  un("ovhcloud", ["Qwen3.8-27B"], 0.4, 2.7),
  un("ovhcloud", ["Qwen3.6-27B"], 0.4, 2.7),
  un("ovhcloud", ["Qwen3.5-397B-A17B"], 0.6, 3.6),
  un("ovhcloud", ["Qwen3.5-9B"], 0.1, 0.15),
  un("ovhcloud", ["gpt-oss-120b"], 0.08, 0.4),
  un("ovhcloud", ["gpt-oss-20b"], 0.04, 0.15),
  un("ovhcloud", ["Meta-Llama-3_3-70B-Instruct"], 0.67, 0.67),
  un("ovhcloud", ["Qwen2.5-VL-72B-Instruct"], 0.91, 0.91),

  /* IONOS AI Model Hub : page allemande, en euros. */
  un("ionos", ["Qwen3.5-9B"], 0.1, 0.15),
  un("ionos", ["Qwen3.5-397B-A17B"], 0.6, 3.6),
  un("ionos", ["Qwen3.8-27B"], 0.4, 2.7),
  un("ionos", ["Mistral Nemo Instruct"], 0.15, 0.15),
  un("ionos", ["Mistral Small 24B Instruct"], 0.1, 0.3),
  un("ionos", ["gpt-oss-120b"], 0.15, 0.65),
  un("ionos", ["Llama 3.3 70B Instruct"], 0.65, 0.65),

  /* OpenRouter : les modèles courants des grands éditeurs, sans les modèles d'images. */
  un("openrouter", ["anthropic/claude-fable-5"], 10, 50),
  un("openrouter", ["anthropic/claude-fable-5.1"], 10, 50),
  un("openrouter", ["anthropic/claude-haiku-4.5"], 1, 5),
  un("openrouter", ["anthropic/claude-opus-4.5"], 5, 25),
  un("openrouter", ["anthropic/claude-opus-4.6"], 5, 25),
  un("openrouter", ["anthropic/claude-opus-4.7"], 5, 25),
  un("openrouter", ["anthropic/claude-opus-4.8"], 5, 25),
  un("openrouter", ["anthropic/claude-opus-5"], 5, 25),
  un("openrouter", ["anthropic/claude-opus-5.5"], 4, 20),
  un("openrouter", ["anthropic/claude-sonnet-4.5"], 3, 15),
  un("openrouter", ["anthropic/claude-sonnet-4.6"], 3, 15),
  un("openrouter", ["anthropic/claude-sonnet-5"], 2, 10),
  un("openrouter", ["deepseek/deepseek-v4-flash"], 0.0469, 0.0938),
  un("openrouter", ["deepseek/deepseek-v4-flash-0731"], 0.021, 0.32),
  un("openrouter", ["deepseek/deepseek-v4-pro"], 0.348, 0.696),
  un("openrouter", ["deepseek/deepseek-v4-pro-0813"], 0.29304, 3.5),
  un("openrouter", ["deepseek/deepseek-v4.1-flash"], 0.035, 0.29),
  un("openrouter", ["google/gemini-3-flash-preview"], 0.5, 3),
  un("openrouter", ["google/gemini-3.1-flash-lite"], 0.25, 1.5),
  un("openrouter", ["google/gemini-3.1-flash-lite-preview"], 0.25, 1.5),
  un("openrouter", ["google/gemini-3.1-pro-preview"], 2, 12),
  un("openrouter", ["google/gemini-3.1-pro-preview-customtools"], 2, 12),
  un("openrouter", ["google/gemini-3.5-flash"], 1.5, 9),
  un("openrouter", ["google/gemini-3.5-flash-lite"], 0.3, 2.5),
  un("openrouter", ["google/gemini-3.6-flash"], 0.75, 3.75),
  un("openrouter", ["google/gemini-3.7-flash"], 0.75, 3.75),
  un("openrouter", ["google/gemini-3.8-flash"], 0.75, 3.75),
  un("openrouter", ["meta-llama/llama-3.3-70b-instruct"], 0.1, 0.32),
  un("openrouter", ["mistralai/ministral-3b-2512"], 0.1, 0.1),
  un("openrouter", ["moonshotai/kimi-k3"], 3, 15),
  un("openrouter", ["openai/gpt-4.1"], 2, 8),
  un("openrouter", ["openai/gpt-4.1-mini"], 0.4, 1.6),
  un("openrouter", ["openai/gpt-4.1-nano"], 0.1, 0.4),
  un("openrouter", ["openai/gpt-5.4"], 2.5, 15),
  un("openrouter", ["openai/gpt-5.4-mini"], 0.75, 4.5),
  un("openrouter", ["openai/gpt-5.4-nano"], 0.2, 1.25),
  un("openrouter", ["openai/gpt-5.4-pro"], 30, 180),
  un("openrouter", ["openai/gpt-5.5"], 5, 30),
  un("openrouter", ["openai/gpt-5.5-pro"], 30, 180),
  un("openrouter", ["openai/gpt-5.6-luna"], 0.2, 1.2),
  un("openrouter", ["openai/gpt-5.6-luna-pro"], 0.2, 1.2),
  un("openrouter", ["openai/gpt-5.6-sol"], 2, 10),
  un("openrouter", ["openai/gpt-5.6-sol-pro"], 2, 10),
  un("openrouter", ["openai/gpt-5.6-terra"], 2, 12),
  un("openrouter", ["openai/gpt-5.6-terra-pro"], 2, 12),
  un("openrouter", ["openai/gpt-6-astra"], 10, 50),
  un("openrouter", ["openai/gpt-6-astra-pro"], 10, 50),
  un("openrouter", ["openai/gpt-6-luna"], 0.1, 0.5),
  un("openrouter", ["openai/gpt-6-luna-pro"], 0.1, 0.5),
  un("openrouter", ["openai/gpt-6-sol"], 2, 10),
  un("openrouter", ["openai/gpt-6-sol-pro"], 2, 10),
  un("openrouter", ["openai/gpt-oss-120b"], 0.15, 0.6),
  un("openrouter", ["openai/gpt-oss-20b"], 0.018, 0.09),
  un("openrouter", ["openai/gpt-oss-safeguard-20b"], 0.075, 0.3),
  un("openrouter", ["qwen/qwen3.5-122b-a10b"], 0.26, 2.08),
  un("openrouter", ["qwen/qwen3.5-27b"], 0.195, 1.56),
  un("openrouter", ["qwen/qwen3.5-35b-a3b"], 0.3125, 1.25),
  un("openrouter", ["qwen/qwen3.5-397b-a17b"], 0.55, 3.5),
  un("openrouter", ["qwen/qwen3.5-9b"], 0.1, 0.15),
  un("openrouter", ["qwen/qwen3.5-flash-02-23"], 0.065, 0.26),
  un("openrouter", ["qwen/qwen3.5-plus-02-15"], 0.26, 1.56),
  un("openrouter", ["qwen/qwen3.5-plus-20260420"], 0.3, 1.8),
  un("openrouter", ["qwen/qwen3.6-27b"], 0.32, 3.2),
  un("openrouter", ["qwen/qwen3.6-35b-a3b"], 0.15, 1),
  un("openrouter", ["qwen/qwen3.6-flash"], 0.1875, 1.125),
  un("openrouter", ["qwen/qwen3.6-max-preview"], 1.027, 6.162),
  un("openrouter", ["qwen/qwen3.6-plus"], 0.325, 1.95),
  un("openrouter", ["qwen/qwen3.7-flash"], 0.03, 0.13),
  un("openrouter", ["qwen/qwen3.7-max"], 1.475, 4.425),
  un("openrouter", ["qwen/qwen3.7-plus"], 0.32, 1.28),
  un("openrouter", ["qwen/qwen3.8-2.4t-a95b"], 2, 6),
  un("openrouter", ["qwen/qwen3.8-27b"], 0.42, 3),
  un("openrouter", ["qwen/qwen3.8-flash"], 0.15, 0.47),
  un("openrouter", ["qwen/qwen3.8-max-0902"], 2, 6),
  un("openrouter", ["qwen/qwen3.8-max-prime"], 4, 12),
  un("openrouter", ["qwen/qwen3.8-omni-flash"], 0.15, 0.47),
  un("openrouter", ["x-ai/grok-4.5"], 2, 6),
  un("openrouter", ["x-ai/grok-4.6"], 2, 6),
  un("openrouter", ["x-ai/grok-4.7"], 1.6, 4.8),
  un("openrouter", ["z-ai/glm-5.2"], 0.6496, 2.0416),
  un("openrouter", ["z-ai/glm-5.3"], 1.4, 4.4),
  un("openrouter", ["z-ai/glm-5.3-flash"], 0.045, 0.14),
  un("openrouter", ["z-ai/glm-5.3-flashx"], 0.37, 1.25),
  un("openrouter", ["z-ai/glm-5.3-prime"], 2.8, 8.8),
];

/* ------------------------------------------------------------------ */
/* Recherche                                                           */
/* ------------------------------------------------------------------ */

/** Le fournisseur d'un backend : son identifiant au catalogue, sinon l'hôte de son adresse. */
export function fournisseurDuBackend(b: { catalogue?: string; baseUrl?: string }): FournisseurPrix | undefined {
  if (b.catalogue) {
    const f = FOURNISSEURS_PRIX.find((x) => x.id === b.catalogue);
    if (f) return f;
  }
  let hote = "";
  try {
    hote = b.baseUrl ? new URL(b.baseUrl).hostname.toLowerCase() : "";
  } catch {
    return undefined;
  }
  return hote ? FOURNISSEURS_PRIX.find((f) => f.hotes.includes(hote)) : undefined;
}

type Recherche = (id: string) => LignePrix | undefined;
const parFournisseur = new Map<string, { usage: Recherche; noms: Recherche }>();

function index(fournisseur: string): { usage: Recherche; noms: Recherche } {
  let i = parFournisseur.get(fournisseur);
  if (!i) {
    const lignes = PRIX_PUBLIES.filter((l) => l.fournisseur === fournisseur);
    i = {
      usage: indexerParNom(lignes.map((l) => ({ valeur: l, noms: [...l.noms, ...(l.api ?? [])] }))),
      noms: indexerParNom(lignes.map((l) => ({ valeur: l, noms: l.noms }))),
    };
    parFournisseur.set(fournisseur, i);
  }
  return i;
}

/** Le jour AAAA-MM-JJ, à l'heure locale. */
const jourDe = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface PrixTrouve {
  fournisseur: FournisseurPrix;
  ligne: LignePrix;
  tarif: Tarif;
}

/**
 * Le prix publié d'un modèle chez un fournisseur, dans sa devise de
 * facturation (ou `devise` si demandée), en vigueur le jour `le`.
 *
 * `parNomSeulement` : ignorer les identifiants d'API qui ne sont pas le nom du
 * modèle (graphique de comparaison).
 */
export function prixPublie(
  fournisseurId: string | undefined,
  idModele: string,
  options: { devise?: Devise; le?: Date; parNomSeulement?: boolean } = {},
): PrixTrouve | undefined {
  const fournisseur = FOURNISSEURS_PRIX.find((f) => f.id === fournisseurId);
  if (!fournisseur || !formesDuNom(idModele).exacte) return undefined;
  const i = index(fournisseur.id);
  const ligne = (options.parNomSeulement ? i.noms : i.usage)(idModele);
  if (!ligne) return undefined;
  const devise = options.devise ?? fournisseur.devise;
  const jour = jourDe(options.le ?? new Date());
  const tarif = ligne.prix.find(
    (p) => p.devise === devise && (!p.depuis || p.depuis <= jour) && (!p.jusquAu || jour <= p.jusquAu),
  );
  return tarif ? { fournisseur, ligne, tarif } : undefined;
}
