import { classifyRoles, isReasoningModel } from "./config.ts";
import type { Role } from "./types.ts";
import { tf } from "./langue.ts";
import { echapperRegex } from "./texteBrut.ts";

/**
 * Les modèles des fournisseurs cloud : ceux qu'une personne branche avec sa clé
 * (fournisseurs.ts) et ceux du prestataire (profil de déploiement).
 *
 * Écrit le 27/09/2026, à la demande de Medhi : « si quelqu'un met sa clé d'API,
 * tout fonctionne, et les modèles de la clé aussi ». Helix parle à tous par leur
 * point d'accès compatible OpenAI (Anthropic et Google compris) ; chacun a
 * pourtant son dialecte, relevé dans sa documentation et imité par
 * scripts/essai-fournisseurs.mjs :
 *
 *  - la liste des modèles : `{ data: [...] }` presque partout, un tableau nu
 *    chez Together, des pages chez Anthropic (`has_more`, `last_id`, vingt
 *    modèles par page), des identifiants préfixés `models/` chez Google ;
 *  - ce que la liste dit des modèles : rien chez OpenAI, Anthropic, Google ;
 *    les capacités chez Mistral (`capabilities.vision`, `completion_chat`…),
 *    les modalités chez OpenRouter (`architecture.input_modalities`), le type
 *    chez Together. Ce qui est déclaré l'emporte sur ce que le nom laisse
 *    deviner. Avant ce module, seul le nom comptait, et « gpt-4o »,
 *    « claude-sonnet-4-5 » ou « gemini-2.5-flash » passaient pour aveugles :
 *    l'image jointe était retirée avant l'envoi (« ne sait pas lire les
 *    images »), alors que ces trois modèles les lisent ;
 *  - les refus de champs : OpenAI refuse `max_tokens` sur gpt-5 et la série o
 *    (« Use 'max_completion_tokens' instead »), une température autre que 1
 *    sur les mêmes, tout champ qu'il ne connaît pas (400) ; Mistral refuse tout
 *    champ en trop (422, `extra_forbidden`) ; Anthropic, lui, ignore presque
 *    tout ce qu'il ne connaît pas. `corrigerRequete` lit le refus et rejoue
 *    la requête sans le champ nommé ;
 *  - le flux : le raisonnement arrive dans `reasoning_content` (DeepSeek, xAI,
 *    LM Studio), dans `reasoning` (OpenRouter, Groq), ou dans des morceaux
 *    `thinking` du contenu (Magistral, chez Mistral) ; Google a longtemps
 *    envoyé ses appels d'outils sans `index`, ce qui collait deux appels en un.
 *
 * Aucun de ces comportements n'a été vu sur un vrai compte : ils viennent des
 * documentations et des retours publiés, et sont vérifiés contre des faux
 * fournisseurs qui les reproduisent. PROJET.md dit ce qui reste à essayer.
 */

/** Un modèle tel que la liste du fournisseur le décrit. */
export interface ModeleDistant {
  id: string;
  /** Déclaré : converse (false pour un modèle d'OCR, d'images, de plongement…). */
  converse?: boolean;
  /** Déclaré : lit les images. */
  voit?: boolean;
  /** Déclaré : sait appeler des outils. */
  outils?: boolean;
  /** Déclaré : a un canal de raisonnement. */
  raisonne?: boolean;
  /** Taille de conversation déclarée, en jetons. */
  contexteMax?: number;
}

const objet = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const booleen = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const nombre = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** Lit une page de `/models`, quel que soit le dialecte. `suite` : l'identifiant d'où repartir (Anthropic). */
export function lireModeles(corps: unknown): { modeles: ModeleDistant[]; suite?: string } {
  const c = objet(corps);
  const entrees = Array.isArray(corps) ? corps : Array.isArray(c.data) ? c.data : [];
  const modeles: ModeleDistant[] = [];
  for (const brute of entrees) {
    const e = objet(brute);
    if (typeof e.id !== "string" || !e.id) continue;
    // Google préfixe ses identifiants (« models/gemini-… ») mais les attend sans préfixe.
    const m: ModeleDistant = { id: e.id.replace(/^models\//, "") };
    // Mistral : `capabilities` de booléens.
    const cap = objet(e.capabilities);
    if (booleen(cap.completion_chat) !== undefined) m.converse = cap.completion_chat as boolean;
    if (booleen(cap.vision) !== undefined) m.voit = cap.vision as boolean;
    if (booleen(cap.function_calling) !== undefined) m.outils = cap.function_calling as boolean;
    // OpenRouter : modalités d'entrée et de sortie, paramètres acceptés.
    const archi = objet(e.architecture);
    if (Array.isArray(archi.input_modalities)) m.voit = archi.input_modalities.includes("image");
    if (Array.isArray(archi.output_modalities)) m.converse = archi.output_modalities.includes("text");
    if (Array.isArray(e.supported_parameters)) {
      m.outils = e.supported_parameters.includes("tools");
      if (e.supported_parameters.includes("reasoning")) m.raisonne = true;
    }
    // Together : un type par modèle.
    if (typeof e.type === "string" && Array.isArray(corps)) m.converse = ["chat", "language", "code"].includes(e.type);
    const contexte =
      nombre(e.max_context_length) ?? nombre(e.context_length) ?? nombre(e.context_window) ?? nombre(e.max_input_tokens) ?? nombre(e.max_model_len);
    if (contexte) m.contexteMax = contexte;
    modeles.push(m);
  }
  const suite = c.has_more === true && typeof c.last_id === "string" && c.last_id ? c.last_id : undefined;
  return { modeles, ...(suite ? { suite } : {}) };
}

/** Refus de la liste des modèles : le statut, et ce que le fournisseur a répondu. */
export class ErreurListe extends Error {
  readonly statut: number;
  readonly detail: string;
  constructor(statut: number, detail: string) {
    super(`HTTP ${statut}`);
    this.statut = statut;
    this.detail = detail;
  }
  /*
   * La clé est-elle en cause ? 401 et 403 d'ordinaire ; Google, lui, répond
   * 400 « API key not valid » à une clé fausse.
   */
  get cleRefusee(): boolean {
    return this.statut === 401 || this.statut === 403 || CLE_REFUSEE.test(this.detail);
  }
}

/** Ce que disent les fournisseurs d'une clé fausse, quel que soit le statut. */
const CLE_REFUSEE = /api[ _-]?key not valid|invalid[ _-]?api[ _-]?key|incorrect api key|invalid x-api-key|authentication_error/i;

/** Les en-têtes d'un appel au fournisseur : la clé dans `Authorization`, ou dans l'en-tête qu'il demande. */
export function entetesAvecCle(
  b: { apiKey?: string; entetes?: Record<string, string>; cleEnTete?: string },
  pourLaListe = false,
): Record<string, string> {
  if (!b.apiKey) return { ...(b.entetes ?? {}) };
  /*
   * Anthropic : sa liste de modèles est son API native, qui attend la clé dans
   * `x-api-key` ; sa conversation compatible OpenAI la lit dans
   * `Authorization`, comme le paquet `openai` l'envoie (documentation relue le
   * 27/09/2026). On suit chacune, plutôt que d'envoyer les deux.
   */
  if (pourLaListe && b.cleEnTete) return { ...(b.entetes ?? {}), [b.cleEnTete]: b.apiKey };
  return { ...(b.entetes ?? {}), Authorization: `Bearer ${b.apiKey}` };
}

/** Tous les modèles d'un fournisseur, pages comprises (dix au plus : mille modèles chacune suffisent). */
export async function listerModelesDistants(
  baseUrl: string,
  entetes: Record<string, string>,
  options: { redirect: "error" | "follow"; delaiMs: number },
): Promise<ModeleDistant[]> {
  const tous: ModeleDistant[] = [];
  let suite: string | undefined;
  for (let page = 0; page < 10; page++) {
    const adresse = suite ? `${baseUrl}/models?limit=1000&after_id=${encodeURIComponent(suite)}` : `${baseUrl}/models`;
    const r = await fetch(adresse, { headers: entetes, redirect: options.redirect, signal: AbortSignal.timeout(options.delaiMs) });
    if (!r.ok) throw new ErreurListe(r.status, (await r.text().catch(() => "")).slice(0, 2000));
    const lu = lireModeles(await r.json());
    tous.push(...lu.modeles);
    if (!lu.suite || lu.suite === suite) break;
    suite = lu.suite;
  }
  return tous;
}

/*
 * Un fournisseur rend aussi ses modèles d'images, de voix, de transcription et
 * de plongement : aucun ne converse. On ne propose que ceux qui le peuvent.
 * Ajoutés le 27/09/2026 : `aqa` et `live` (Google : réponse à des passages,
 * voix en direct), `ocr` (Mistral), `lyria` (musique, Google).
 */
const PAS_DE_CONVERSATION =
  /embed|tts|whisper|dall-?e|moderation|audio|realtime|transcri|image|imagen|veo|sora|lyria|speech|rerank|search-preview|davinci|babbage|computer-use|guard|\baqa\b|\blive\b|ocr/i;

/*
 * Chez OpenAI, des modèles qui ne répondent qu'à l'API « Responses », pas à
 * `/chat/completions` : codex, les « pro », la recherche approfondie, et
 * l'ancien « instruct », qui ne connaît que les complétions. Proposés, ils
 * échouaient au premier message.
 */
const REPONSES_SEULEMENT = /codex|(?:^|-)pro(?:-|$)|deep-research|instruct/i;

/** Ce modèle converse-t-il par `/chat/completions` ? */
export function converse(m: ModeleDistant, fournisseur?: string): boolean {
  if (m.converse === false) return false;
  if (PAS_DE_CONVERSATION.test(m.id)) return false;
  if (fournisseur === "openai" && REPONSES_SEULEMENT.test(m.id)) return false;
  return true;
}

/*
 * Ce que le nom laisse deviner, pour un fournisseur qui ne déclare rien
 * (OpenAI, Anthropic, Google, xAI, DeepSeek). Seulement pour un modèle cloud :
 * sur la machine, LM Studio sait et le dit (backends.ts). Familles relevées le
 * 27/09/2026 dans les fiches des fournisseurs ; la série o « mini » ne voit pas
 * (o1-mini, o3-mini), o4-mini si.
 */
const VOIT_PAR_NOM =
  /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-5|chatgpt|^o[134](?!-mini)|^o4-mini|claude|gemini|gemma-3|pixtral|mistral-(?:medium|small)|grok-(?:4|2-vision)|vision|llama-4|qwen[\d.]*-?vl|-vl\b|kimi-(?:k2\.5|vl)|glm-4\.\d+v|nova-(?:lite|pro)/i;
const CODE_PAR_NOM =
  /gpt-4\.1|gpt-5|^o[34]|claude|gemini-(?:2\.5|3)|codestral|devstral|mistral-(?:large|medium)|grok-(?:3|4|code)|gpt-oss/i;
const RAISONNE_PAR_NOM =
  /^o[134]|gpt-5(?!-chat)|deepseek-reasoner|magistral|gemini-(?:2\.5|3)|grok-3-mini|grok-4(?!.*non-reasoning)|reasoning|thinking|gpt-oss/i;

/** Le nom sans le préfixe du fabricant (« openai/gpt-4o » chez OpenRouter). */
const nomCourt = (id: string) => id.split("/").pop() ?? id;

/** Rôles, outils et raisonnement d'un modèle cloud : le déclaré d'abord, le nom ensuite. */
export function capacitesDistantes(m: ModeleDistant): { roles: Role[]; reasoning: boolean; voit?: boolean; outils?: boolean; contexteMax?: number } {
  const nom = nomCourt(m.id);
  let roles = classifyRoles(m.id);
  const voit = m.voit ?? (VOIT_PAR_NOM.test(nom) || undefined);
  if (voit === true && !roles.includes("vision")) roles = [...roles, "vision"];
  if (m.voit === false) roles = roles.filter((r) => r !== "vision" && r !== "gui");
  if (roles.includes("chat") && !roles.includes("code") && (m.outils === true || CODE_PAR_NOM.test(nom))) roles = [...roles, "code"];
  return {
    roles,
    reasoning: m.raisonne ?? (isReasoningModel(m.id) || RAISONNE_PAR_NOM.test(nom)),
    ...(voit !== undefined ? { voit } : {}),
    ...(m.outils !== undefined ? { outils: m.outils } : {}),
    ...(m.contexteMax ? { contexteMax: m.contexteMax } : {}),
  };
}

/* ------------------------------------------------------------------------ */
/* Le flux : texte, raisonnement, appels d'outils, erreurs                   */
/* ------------------------------------------------------------------------ */

/** Texte et raisonnement d'un fragment, quel que soit le dialecte. */
export function lireDelta(delta: unknown): { texte: string; reflexion: string } {
  const d = objet(delta);
  let texte = "";
  let reflexion = "";
  if (typeof d.content === "string") texte = d.content;
  else if (Array.isArray(d.content)) {
    // Magistral (Mistral) : des morceaux `text` et `thinking`, ce dernier fait lui-même de morceaux.
    for (const brut of d.content) {
      const p = objet(brut);
      if (p.type === "text" && typeof p.text === "string") texte += p.text;
      else if (p.type === "thinking") {
        if (typeof p.thinking === "string") reflexion += p.thinking;
        else if (Array.isArray(p.thinking)) for (const q of p.thinking) if (typeof objet(q).text === "string") reflexion += objet(q).text as string;
      }
    }
  }
  // L'un ou l'autre, jamais les deux : un moteur qui envoie les deux les double.
  if (typeof d.reasoning_content === "string") reflexion += d.reasoning_content;
  else if (typeof d.reasoning === "string") reflexion += d.reasoning;
  return { texte, reflexion };
}

export interface AppelOutil {
  id: string;
  name: string;
  args: string;
}

/**
 * Ajoute les fragments d'appels d'outils d'un morceau du flux.
 *
 * Le format OpenAI numérote chaque appel (`index`) et découpe ses arguments.
 * Sans numéro (Google, vu dans des retours publiés), tout allait à l'appel 0 :
 * deux appels parallèles devenaient un seul, au nom collé (« lirelire ») et
 * aux arguments illisibles. Sans numéro, on range donc par identifiant ; sans
 * identifiant, un nom ouvre un nouvel appel et le reste complète le dernier.
 */
export function accumulerAppels(appels: AppelOutil[], fragments: unknown): void {
  if (!Array.isArray(fragments)) return;
  for (const brut of fragments) {
    const f = objet(brut);
    const fonction = objet(f.function);
    const id = typeof f.id === "string" ? f.id : "";
    const nom = typeof fonction.name === "string" ? fonction.name : "";
    const args = typeof fonction.arguments === "string" ? fonction.arguments : fonction.arguments !== undefined ? JSON.stringify(fonction.arguments) : "";
    const neuf = (): AppelOutil => {
      const a = { id: "", name: "", args: "" };
      appels.push(a);
      return a;
    };
    let case_: AppelOutil | undefined;
    if (typeof f.index === "number" && f.index >= 0 && f.index < 128) {
      while (appels.length <= f.index) appels.push({ id: "", name: "", args: "" });
      case_ = appels[f.index];
      // Même numéro, autre identifiant : un autre appel, rangé à part.
      if (case_ && id && case_.id && case_.id !== id) case_ = appels.find((a) => a.id === id) ?? neuf();
    } else if (id) case_ = appels.find((a) => a.id === id) ?? neuf();
    else if (nom) case_ = neuf();
    else case_ = appels.at(-1) ?? neuf();
    if (!case_) continue;
    if (id) case_.id = id;
    if (nom) case_.name += nom;
    if (args) case_.args += args;
  }
}

/**
 * Une erreur envoyée au milieu du flux (OpenRouter, fournisseur surchargé), ou
 * null. Le statut est celui qu'elle porte (`error.code` chez OpenRouter), 500
 * sinon ; le texte est rendu tel quel, en JSON, pour `messageDuFournisseur`.
 */
export function erreurDansFlux(json: unknown): { statut: number; detail: string } | null {
  const e = objet(json).error;
  if (!e) return null;
  const code = objet(e).code;
  const statut = typeof code === "number" && code >= 400 && code < 600 ? code : 500;
  return { statut, detail: JSON.stringify({ error: typeof e === "string" ? { message: e } : e }) };
}

/* ------------------------------------------------------------------------ */
/* Refus du fournisseur : ce qu'on corrige, et ce qu'on dit                  */
/* ------------------------------------------------------------------------ */

/** Ce que le fournisseur dit de son refus, sans l'enveloppe JSON. */
export function messageDuRefus(detail: string): string {
  let j: unknown;
  try {
    j = JSON.parse(detail);
  } catch {
    return abreger(detail.replace(/<[^>]+>/g, " "));
  }
  const premier = Array.isArray(j) ? objet(j[0]) : objet(j);
  const e = premier.error;
  const candidats = [
    objet(e).message,
    typeof e === "string" ? e : undefined,
    premier.message,
    premier.detail,
    // Mistral (422) : `message.detail[0].msg`, avec le champ en cause dans `loc`.
    Array.isArray(objet(premier.message).detail)
      ? ((objet(premier.message).detail as unknown[]).map((d) => `${objet(d).msg ?? ""} (${String(objet(d).loc ?? "")})`).join(" ; "))
      : undefined,
  ];
  const texte = candidats.find((c): c is string => typeof c === "string" && c.trim().length > 0);
  return abreger(texte ?? detail);
}

/**
 * Le refus tel qu'on peut le montrer. Vu le 29/09/2026 : OpenAI renvoie la
 * clé masquée (« sk-proj-****…**** », une centaine d'étoiles), et la coupe à
 * 240 caractères tombait au milieu de son adresse (« https://platform. »).
 * Les étoiles deviennent « … », et la coupe se fait entre deux mots.
 */
function abreger(texte: string): string {
  const net = texte.replace(/\*{4,}/g, "…").replace(/\s+/g, " ").trim();
  if (net.length <= 240) return net;
  const coupe = net.slice(0, 240);
  const espace = coupe.lastIndexOf(" ");
  return `${(espace > 160 ? coupe.slice(0, espace) : coupe).replace(/[\s,;:.]+$/, "")}…`;
}

/** Une modification de la requête, rejouable sur les suivantes. */
export type Correction =
  | { type: "retirer"; champ: string }
  | { type: "renommer"; champ: string; vers: string }
  | { type: "borner"; champ: string; max: number }
  | { type: "remplacer"; champ: string; de: unknown; vers: unknown };

/** Ce sans quoi il n'y a plus de requête : jamais retiré. */
const ESSENTIELS = new Set(["model", "messages", "stream", "tools"]);

export function appliquerCorrection(corps: Record<string, unknown>, c: Correction): Record<string, unknown> {
  if (!(c.champ in corps)) return corps;
  const copie = { ...corps };
  const valeur = copie[c.champ];
  if (c.type === "retirer") delete copie[c.champ];
  else if (c.type === "renommer") {
    delete copie[c.champ];
    copie[c.vers] = valeur;
  } else if (c.type === "borner") {
    if (typeof valeur === "number" && valeur > c.max) copie[c.champ] = c.max;
  } else if (valeur === c.de) copie[c.champ] = c.vers;
  return copie;
}

/**
 * La correction à faire pour qu'une requête refusée passe, ou null.
 *
 * On ne corrige que ce que le refus nomme, et seulement un champ facultatif :
 * un modèle inconnu, une clé refusée ou une conversation trop longue restent
 * des refus, et la personne les lit (`messageDuFournisseur`).
 */
export function correctionPour(corps: Record<string, unknown>, detail: string): Correction | null {
  // Le nom du champ vient du corps de la requête (clés arbitraires que l'appelant contrôle) :
  // sans échappement, une clé comme « ( » ou « [ » faisait lever `new RegExp` (audit du
  // 27/09/2026), et l'erreur interne remontait au client. Un contrôle qui ne comprend pas
  // son entrée doit refuser, jamais planter : on l'échappe, un champ inhabituel ne correspond
  // simplement à rien et son refus est dit tel quel.
  const nomme = (champ: string) => new RegExp(`\\b${echapperRegex(champ)}\\b`).test(detail);
  for (const champ of ["max_tokens", "max_completion_tokens"]) {
    if (!(champ in corps) || !nomme(champ)) continue;
    // gpt-5 et la série o : « Use 'max_completion_tokens' instead ».
    if (champ === "max_tokens" && nomme("max_completion_tokens")) return { type: "renommer", champ, vers: "max_completion_tokens" };
    // « supports at most 16384 completion tokens » : on prend la borne que le refus donne.
    const actuel = Number(corps[champ]);
    const bornes = (detail.match(/\d{3,7}/g) ?? []).map(Number).filter((n) => n >= 256 && n < actuel);
    if (bornes.length > 0) return { type: "borner", champ, max: Math.max(...bornes) };
    return { type: "retirer", champ };
  }
  // « reasoning_effort does not support 'none' … Supported values are: 'minimal', 'low'… » (gpt-5).
  if (corps.reasoning_effort === "none" && nomme("reasoning_effort") && /\bminimal\b/.test(detail)) {
    return { type: "remplacer", champ: "reasoning_effort", de: "none", vers: "minimal" };
  }
  // Le plus long d'abord : « stream_options » avant un éventuel champ plus court qu'il contiendrait.
  const facultatifs = Object.keys(corps)
    .filter((k) => !ESSENTIELS.has(k))
    .sort((a, b) => b.length - a.length);
  const champ = facultatifs.find(nomme);
  return champ ? { type: "retirer", champ } : null;
}

/**
 * Le refus d'un fournisseur cloud, dit à la personne : qui refuse, pourquoi,
 * et quoi faire. Null quand le refus n'est pas de ceux qu'on sait nommer ; le
 * message ordinaire s'applique alors (chat.ts).
 */
export function messageDuFournisseur(statut: number, detail: string, modele: string, fournisseur: string): string | null {
  const dit = messageDuRefus(detail) || String(statut);
  if (statut === 401 || statut === 403 || (statut === 400 && CLE_REFUSEE.test(detail))) {
    return tf(
      "{0} refuse la clé ({1}) : elle a peut-être été révoquée, a expiré, ou n'a pas accès à {2}. Vérifiez-la dans Réglages, Modèles cloud. Réponse du fournisseur : {3}",
      fournisseur,
      statut,
      modele,
      dit,
    );
  }
  if (statut === 402) {
    return tf("{0} refuse la demande faute de crédit (402) : rechargez le compte lié à la clé. Réponse du fournisseur : {1}", fournisseur, dit);
  }
  if (statut === 429) {
    return /quota|billing|credit|crédit|exceeded your current|insufficient/i.test(detail)
      ? tf(
          "Le quota de la clé {0} est épuisé (429) : ajoutez du crédit ou relevez la limite chez le fournisseur, ou choisissez un autre modèle. Réponse du fournisseur : {1}",
          fournisseur,
          dit,
        )
      : tf("{0} limite le débit de cette clé (429) : trop de requêtes en peu de temps. Réessayez dans une minute. Réponse du fournisseur : {1}", fournisseur, dit);
  }
  if (statut === 404 || (statut < 500 && /model_not_found|not_found_error|does not exist|unknown model|invalid model|no such model|model .*not found|is not found/i.test(detail))) {
    return tf(
      "{0} ne connaît pas (ou plus) le modèle {1} ({2}) : il a peut-être été retiré. Choisissez-en un autre, ou mettez à jour les modèles de la clé dans Réglages, Modèles cloud. Réponse du fournisseur : {3}",
      fournisseur,
      modele,
      statut,
      dit,
    );
  }
  if (statut >= 500) {
    return tf("{0} est indisponible ou surchargé ({1}) : réessayez dans un instant. Réponse du fournisseur : {2}", fournisseur, statut, dit);
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Conversation trop longue                                                  */
/* ------------------------------------------------------------------------ */

/*
 * Ce que les moteurs répondent quand la demande dépasse la place du modèle
 * (relevé le 16/10/2026 dans leurs sources et leurs documentations) :
 *  - LM Studio : « The number of tokens to keep from the initial prompt is
 *    greater than the context length », ou « Trying to keep the first N tokens
 *    when context the overflows. However, the model is loaded with context
 *    length of only 4096 tokens, which is not enough » ;
 *  - llama.cpp (serveur) : « the request exceeds the available context size,
 *    try increasing it », type `exceed_context_size_error` ;
 *  - OpenAI, vLLM, DeepSeek : « This model's maximum context length is 128000
 *    tokens. However, your messages resulted in … », code
 *    `context_length_exceeded` ; Groq : « Please reduce the length of the
 *    messages or completion » ;
 *  - Mistral : « Prompt contains 40000 tokens and 0 draft tokens, too large for
 *    model with 32768 maximum context length » ;
 *  - Anthropic : « prompt is too long: 210000 tokens > 200000 maximum » ;
 *  - Google : « The input token count (…) exceeds the maximum number of tokens
 *    allowed » ; Ollama : « context length exceeded ».
 * Avant, une expression bien plus large (« context », « exceed ») prenait aussi
 * pour une conversation trop longue des refus sans rapport ; et un débit limité
 * par minute (Groq, « Request too large … tokens per minute ») n'en est pas un.
 */
const CONTEXTE_DEPASSE =
  /context[_ ]length[_ ]exceeded|maximum context length|greater than the context length|context length of only|exceeds? the available context size|exceed_context_size_error|context[_ ]window[_ ]exceeded|exceeds? (?:the )?(?:model'?s? )?context (?:window|length|size)|prompt is too long|too large for model with \d+ maximum context|input token count.{0,40}exceeds the maximum|input (?:is )?too long for the model|reduce the length of the messages|n_ctx|context overflow|context size (?:has been )?exceeded/i;

/** Le refus du moteur dit-il que la demande dépasse la place du modèle ? */
export function depasseLeContexte(statut: number, detail: string): boolean {
  if (statut === 429 || statut === 401 || statut === 403 || statut === 402) return false;
  if (/per minute|\bTPM\b|rate.?limit|quota/i.test(detail)) return false;
  return CONTEXTE_DEPASSE.test(detail);
}

/**
 * Taille de conversation d'un modèle cloud quand le fournisseur ne la publie
 * pas dans sa liste (OpenAI, Anthropic, Google, DeepSeek, xAI) : sans elle, la
 * conversation n'était jamais mesurée (chat.ts, `tailleConnue`), et un long
 * Chat finissait refusé par le fournisseur (16/10/2026). Chiffres bas de chaque
 * famille, relevés dans les fiches des fournisseurs : trop bas, Helix retire un
 * peu tôt les plus anciens messages ; trop haut, le refus du fournisseur est
 * rattrapé par un nouvel essai raccourci (chat.ts).
 */
const TAILLES_PAR_NOM: [RegExp, number][] = [
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-5/i, 272_000],
  [/^o[134](?:-|$)/i, 200_000],
  [/gpt-4o|gpt-4-turbo|gpt-4\.5|chatgpt-4o/i, 128_000],
  [/gpt-3\.5/i, 16_385],
  [/^gpt-4(?:-\d{4})?$/i, 8_192],
  [/claude/i, 200_000],
  [/gemini-(?:1\.5|2|3)/i, 1_000_000],
  [/deepseek/i, 64_000],
  [/grok-(?:3|4)/i, 128_000],
  [/llama-?(?:3\.[1-3]|4)/i, 128_000],
];

export function contexteConnuParNom(id: string): number | undefined {
  const nom = nomCourt(id);
  return TAILLES_PAR_NOM.find(([motif]) => motif.test(nom))?.[1];
}
