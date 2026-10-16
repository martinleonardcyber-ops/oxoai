import {
  Blocks,
  BookOpen,
  Brain,
  Compass,
  FileText,
  Folder,
  Gamepad2,
  Globe,
  Laptop,
  Mail,
  Monitor,
  Search,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CleMarquePetite } from "@/components/ui/marques";

/**
 * Le dessin qui va devant chaque service de la liste.
 *
 * Pourquoi cette table vit côté écran, et non dans le catalogue de la
 * passerelle : un logo est une affaire de présentation. La passerelle dit ce
 * qu'un service fait et comment il se branche ; elle n'a pas à transporter des
 * tracés SVG, ni à savoir quelle charte de marque permet quoi.
 *
 * Une entrée absente n'est pas un défaut : elle retombe sur l'icône neutre
 * ci-dessous, puis sur un carré générique. Un service sans logo reste
 * branchable.
 *
 * Troisième tournée (28/09/2026, décision de Medhi : « mets les vrais ») :
 * chaque service affiché porte son vrai logo, en couleur, y compris ceux dont
 * la charte demandait un accord (Slack, HubSpot, Box, PayPal…). Sources dans
 * scripts/marques/sources.json.
 */
export const MARQUE_DU_CONNECTEUR: Record<string, CleMarquePetite> = {
  courrier: "gmail",
  agenda: "googleAgenda",
  drive: "googleDrive",
  sheets: "googleSheets",
  slides: "googleSlides",
  notion: "notion",
  "notion-jeton": "notion",
  linear: "linear",
  // « Jira et Confluence » : le logo d'Atlassian couvre les deux produits.
  atlassian: "atlassian",
  sentry: "sentry",
  figma: "figma",
  webflow: "webflow",
  wix: "wix",
  vercel: "vercel",
  github: "github",
  "github-jeton": "github",
  gitlab: "gitlab",
  postgres: "postgresql",
  brave: "brave",
  kubernetes: "kubernetes",
  cartes: "googleMaps",
  canva: "canva",
  firecrawl: "firecrawl",
  exa: "exa",
  x: "x",
  trello: "trello",
  clickup: "clickup",
  todoist: "todoist",
  tavily: "tavily",
  // Troisième tournée (28/09/2026) : les services qui gardaient une icône neutre.
  slack: "slack",
  "slack-mcp": "slack",
  "slack-jeton": "slack",
  asana: "asana",
  hubspot: "hubspot",
  intercom: "intercom",
  "airtable-mcp": "airtable",
  "airtable-jeton": "airtable",
  box: "box",
  paypal: "paypal",
  square: "square",
  monday: "monday",
  calendly: "calendly",
  zoom: "zoom",
  // Palmier Pro (29/09/2026) : l'icône de son site, scripts/marques/sources.json.
  palmier: "palmier",
  // Roblox Studio et Blender (12/10/2026) : l'icône du site de Roblox, le logo du kit de la Blender Foundation.
  roblox: "roblox",
  blender: "blender",
};

/**
 * Icône neutre pour les services qui ne sont la marque de personne : les
 * serveurs livrés avec le produit (fichiers, mémoire, navigateur…), le
 * courrier par IMAP et l'entrée « autre ». Depuis la troisième tournée du
 * 28/09/2026, aucun service de marque ne s'y trouve plus. Tavily garde la
 * sienne pour le cas où la ligne serait trop petite pour sa charte.
 */
export const ICONE_DU_CONNECTEUR: Record<string, LucideIcon> = {
  fichiers: Folder,
  bibliotheque: FileText,
  reunions: Video,
  bureau: Laptop,
  ecran: Monitor,
  memoire: Brain,
  reflexion: Brain,
  documentation: BookOpen,
  navigateur: Globe,
  tavily: Search,
  courrierIMAP: Mail,
  autre: Compass,
  /*
   * Unreal Engine (16/10/2026) : pas le logo. C'est une marque d'Epic Games,
   * dont l'usage passe par ses règles de marque et, hors des productions
   * faites avec le moteur, par un accord qu'Helix n'a pas : une icône neutre,
   * et le nom écrit en toutes lettres.
   */
  unreal: Gamepad2,
};

/** Le carré générique, quand ni marque ni icône ne sont connues. */
export const ICONE_PAR_DEFAUT: LucideIcon = Blocks;

/**
 * Le logo de l'éditeur d'un modèle, déduit de son identifiant.
 *
 * Déduit, et non déclaré : l'identifiant est la seule chose que tous les
 * moteurs donnent. « mistralai/Mistral-Small-3.2 » et « mistral-medium » ont
 * en commun le mot qui compte. Une correspondance manquante ne casse rien, la
 * ligne s'affiche avec l'icône neutre.
 *
 * L'ordre compte : la première correspondance gagne. DeepSeek passe avant Qwen
 * et Llama (« DeepSeek-R1-Distill-Qwen-7B » est un modèle de DeepSeek), et
 * OpenAI en dernier, pour que « gpt » ne prenne pas le nom d'un autre.
 *
 * Troisième tournée (28/09/2026) : OpenAI (GPT, o1 à o4, gpt-oss), DeepSeek,
 * Qwen, Llama (logo de Meta), Gemma, GLM (Z.ai) et MiniMax ont leur logo.
 * Restent neutres, faute de fichier relevé : Phi (Microsoft), Granite (IBM),
 * Nemotron (NVIDIA), OLMo (Ai2).
 * Partagé par le sélecteur de modèles et la comparaison des modèles.
 */
const MARQUE_DU_MODELE: [RegExp, CleMarquePetite][] = [
  [/claude|anthropic/i, "claude"],
  [/deepseek/i, "deepseek"],
  [/mistral|mixtral|magistral|devstral|codestral|ministral|pixtral|voxtral/i, "mistral"],
  [/gemini/i, "gemini"],
  [/gemma/i, "gemma"],
  [/kimi|moonshot/i, "kimi"],
  [/perplexity|sonar/i, "perplexity"],
  [/grok/i, "grok"],
  [/qwen|qwq/i, "qwen"],
  [/llama|\bmeta\b/i, "meta"],
  [/\bglm|chatglm|zai-org|z-ai|zhipu|\bz\.ai\b/i, "zai"],
  [/minimax/i, "minimax"],
  [/gpt|openai|chatgpt|(^|[/:])o[1-9](-|$)/i, "openai"],
];

export function marqueDuModele(id: string): CleMarquePetite | undefined {
  return MARQUE_DU_MODELE.find(([re]) => re.test(id))?.[1];
}

/**
 * Logo des fournisseurs de modèles, par identifiant du catalogue de la
 * passerelle (gateway/src/fournisseurs.ts). Seul « compatible », qui n'est
 * personne, garde la clé neutre.
 */
export const MARQUE_DU_FOURNISSEUR: Record<string, CleMarquePetite> = {
  mistral: "mistral",
  scaleway: "scaleway",
  ovhcloud: "ovhcloud",
  ionos: "ionos",
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  openrouter: "openrouter",
  groq: "groq",
  deepseek: "deepseek",
  xai: "xai",
  together: "together",
};
