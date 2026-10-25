/*
 * Modèles branchés par une clé : de bout en bout, contre de faux fournisseurs.
 *
 *   node scripts/essai-fournisseurs.mjs      (lancé aussi par npm run securite)
 *
 * Écrit le 27/09/2026, à la demande de Medhi : « sois sûr que si quelqu'un met
 * sa clé d'API de LLM tout fonctionne, et pareil pour les modèles de la clé ».
 *
 * Une passerelle neuve (dossier de données temporaire, aucun moteur local)
 * branche les clés de sept faux fournisseurs, puis s'en sert comme une
 * personne le ferait : liste des modèles, Chat en flux, raisonnement, appel
 * d'outil complet, image, erreurs (clé refusée, quota, débit, modèle retiré,
 * service surchargé, crédit, coupure en cours de flux), relais d'OpenCode,
 * OxoAI Code sur un modèle de clé personnelle, bases de connaissances,
 * routage Auto, adresse qui bascule vers le réseau interne.
 *
 * Chaque faux imite le point d'accès compatible OpenAI **dont OxoAI se sert**
 * chez ce fournisseur (OxoAI n'appelle ni `/v1/messages` d'Anthropic, ni
 * `generateContent` de Google : voir modelesCloud.ts), avec ce que sa
 * documentation dit de lui : en-tête de la clé, forme de la liste des modèles
 * et pagination, capacités déclarées, champs refusés (400 d'OpenAI, 422 de
 * Mistral, 400 en tableau de Google) ou ignorés (Anthropic), forme des appels
 * d'outils dans le flux (sans `index` chez Google, identifiants de neuf
 * caractères chez Mistral), canal de raisonnement (`reasoning_content`,
 * `reasoning`, morceaux `thinking`). Ce sont des imitations : ce qui n'a pas été
 * essayé avec de vraies clés est écrit dans PROJET.md.
 *
 * Aucune vraie clé, aucun appel sortant. La passerelle est lancée avec un
 * module préalable (`--import`) qui détourne `fetch` vers les faux (adresse du
 * fournisseur → 127.0.0.1) et refuse toute autre sortie, et qui répond aux
 * résolutions de noms des fournisseurs par une adresse de documentation
 * (203.0.113.0/24) : le contrôle « pas de réseau interne » (sortieReseau.ts)
 * s'exerce donc pour de vrai, sans interroger aucun serveur de noms.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { createServer as serveurHttp } from "node:http";
import { createServer as serveurTcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

let reussis = 0;
const echecs = [];
function verifier(nom, condition, obtenu) {
  if (condition) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${String(obtenu).replace(/cle-[a-z]+-bonne/g, "[clé]").slice(0, 400)}`);
  }
}

const portLibre = () =>
  new Promise((ok) => {
    const s = serveurTcp();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------- */
/* Les faux fournisseurs                                                      */
/* ------------------------------------------------------------------------- */

const ANTHROPIC = [
  "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
  "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-haiku-4-5", "claude-3-5-haiku-latest",
  "claude-3-7-sonnet-latest", "claude-sonnet-4-0", "claude-opus-4-0", "claude-fable-5", "claude-fable-5-1",
  "claude-essai-17", "claude-essai-18", "claude-essai-19", "claude-essai-20", "claude-essai-21", "claude-essai-22",
  "claude-essai-23", "claude-essai-24", "claude-essai-25",
];

/** Chaque dialecte : où il répond, sa clé, ses modèles, ce qu'il accepte. */
const DIALECTES = {
  openai: {
    hote: "api.openai.com", base: "/v1", cle: "cle-openai-bonne",
    modeles: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-nano", "gpt-5", "o3-mini", "text-embedding-3-small", "dall-e-3", "whisper-1", "tts-1", "gpt-4o-realtime-preview", "gpt-5-codex", "o3-pro", "gpt-3.5-turbo-instruct", "omni-moderation-latest", "gpt-image-1"],
    // Champs connus d'OpenAI : tout autre est refusé (400).
    champs: ["model", "messages", "stream", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens", "tools", "tool_choice", "reasoning_effort", "parallel_tool_calls", "n", "stop", "presence_penalty", "frequency_penalty", "seed", "user", "response_format", "logprobs", "metadata", "store"],
    refus: "openai",
  },
  anthropic: {
    hote: "api.anthropic.com", base: "/v1", cle: "cle-anthropic-bonne", modeles: ANTHROPIC,
    // Le point d'accès compatible ignore sans erreur la plupart des champs qu'il ne connaît pas (documentation Anthropic).
    champs: null,
  },
  google: {
    hote: "generativelanguage.googleapis.com", base: "/v1beta/openai", cle: "cle-google-bonne",
    modeles: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-embedding-001", "text-embedding-004", "aqa", "imagen-4.0-generate-001", "gemini-2.5-flash-preview-tts", "gemma-3-27b-it", "gemini-live-2.5-flash-preview"],
    champs: ["model", "messages", "stream", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens", "tools", "tool_choice", "reasoning_effort", "n", "stop", "response_format", "seed", "presence_penalty", "frequency_penalty", "extra_body"],
    refus: "google",
  },
  mistral: {
    hote: "api.mistral.ai", base: "/v1", cle: "cle-mistral-bonne",
    modeles: [
      { id: "mistral-large-latest", capabilities: { completion_chat: true, function_calling: true, vision: false } },
      { id: "mistral-medium-latest", capabilities: { completion_chat: true, function_calling: true, vision: true } },
      { id: "pixtral-large-latest", capabilities: { completion_chat: true, function_calling: true, vision: true } },
      { id: "magistral-medium-latest", capabilities: { completion_chat: true, function_calling: true, vision: false } },
      { id: "codestral-latest", capabilities: { completion_chat: true, completion_fim: true, function_calling: true, vision: false } },
      { id: "mistral-embed", capabilities: { completion_chat: false, function_calling: false, vision: false } },
      { id: "mistral-ocr-latest", capabilities: { completion_chat: false, function_calling: false, vision: true } },
      { id: "mistral-document-ai", capabilities: { completion_chat: false, function_calling: false, vision: false } },
    ],
    // Mistral refuse tout champ en trop (422, « extra_forbidden ») : `stream_options` et `reasoning_effort` compris.
    champs: ["model", "messages", "stream", "temperature", "top_p", "max_tokens", "tools", "tool_choice", "parallel_tool_calls", "response_format", "stop", "random_seed", "presence_penalty", "frequency_penalty", "n", "safe_prompt", "prediction", "prompt_mode"],
    refus: "mistral",
  },
  openrouter: {
    hote: "openrouter.ai", base: "/api/v1", cle: "cle-openrouter-bonne",
    modeles: [
      { id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "tool_choice", "max_tokens"] },
      { id: "deepseek/deepseek-r1", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["reasoning", "include_reasoning", "max_tokens"] },
      { id: "black-forest-labs/flux-pro", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, supported_parameters: [] },
      { id: "mistralai/mistral-small-3.2", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools"] },
    ],
    champs: null,
  },
  deepseek: {
    hote: "api.deepseek.com", base: "/v1", cle: "cle-deepseek-bonne",
    modeles: ["deepseek-chat", "deepseek-reasoner"],
    champs: null,
  },
  together: {
    hote: "api.together.xyz", base: "/v1", cle: "cle-together-bonne",
    // Together rend un tableau nu, avec un type par modèle.
    modeles: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", type: "chat", context_length: 131072 },
      { id: "Qwen/Qwen2.5-VL-72B-Instruct", type: "chat", context_length: 32768 },
      { id: "BAAI/bge-large-en-v1.5", type: "embedding" },
      { id: "black-forest-labs/FLUX.1-schnell", type: "image" },
      { id: "Salesforce/Llama-Rank-V1", type: "rerank" },
    ],
    champs: null,
  },
  // « Autre (compatible OpenAI) » : un nom choisi par la personne, d'abord public, puis qui bascule vers le réseau interne.
  rebond: { hote: "rebond.essai.test", base: "/v1", cle: "cle-rebond-bonne", modeles: ["modele-rebond"], champs: null },
};

const idDe = (m) => (typeof m === "string" ? m : m.id);
const etats = {};

function texteDe(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) return m.content.filter((p) => p.type === "text").map((p) => p.text).join(" ");
  return "";
}

function fauxFournisseur(nom) {
  const d = DIALECTES[nom];
  const etat = { requetes: [], revoquee: false, retires: new Set(), embeddings: 0 };
  etats[nom] = etat;
  return serveurHttp((req, res) => {
    let brut = "";
    req.on("data", (b) => (brut += b));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const chemin = url.pathname.startsWith(d.base) ? url.pathname.slice(d.base.length) : url.pathname;
      const json = (statut, corps) => {
        res.writeHead(statut, { "Content-Type": "application/json" });
        res.end(JSON.stringify(corps));
      };
      const bearer = req.headers.authorization === `Bearer ${d.cle}` && !etat.revoquee;
      const refuseCle = () => {
        if (nom === "anthropic") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        // Google répond 400, pas 401, à une clé fausse.
        if (nom === "google") return json(400, [{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }]);
        if (nom === "mistral") return json(401, { message: "Unauthorized", request_id: "essai" });
        return json(401, { error: { message: "Incorrect API key provided: cle-****. You can find your API key at your dashboard.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
      };

      if (req.method === "GET" && chemin === "/models") {
        etat.requetes.push({ chemin, entetes: { ...req.headers } });
        // Anthropic : sa liste est son API native, clé dans `x-api-key` et version exigée.
        if (nom === "anthropic") {
          if (req.headers["x-api-key"] !== d.cle || etat.revoquee || !req.headers["anthropic-version"]) return refuseCle();
          const limite = Number(url.searchParams.get("limit") ?? 20);
          const apres = url.searchParams.get("after_id");
          const debut = apres ? ANTHROPIC.indexOf(apres) + 1 : 0;
          const page = ANTHROPIC.slice(debut, debut + limite);
          return json(200, {
            data: page.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })),
            has_more: debut + limite < ANTHROPIC.length,
            first_id: page[0] ?? null,
            last_id: page.at(-1) ?? null,
          });
        }
        // OpenRouter liste sans clé ; les autres la veulent.
        if (nom !== "openrouter" && !bearer) return refuseCle();
        if (nom === "together") return json(200, d.modeles);
        if (nom === "google") return json(200, { object: "list", data: d.modeles.map((id) => ({ id: `models/${id}`, object: "model", owned_by: "google" })) });
        if (nom === "mistral" || nom === "openrouter") return json(200, { object: "list", data: d.modeles.map((m) => ({ object: "model", ...m })) });
        return json(200, { object: "list", data: d.modeles.map((id) => ({ id, object: "model", created: 1, owned_by: nom })) });
      }
      if (req.method === "GET" && chemin === "/key" && nom === "openrouter") {
        return bearer ? json(200, { data: { label: "essai", usage: 0 } }) : refuseCle();
      }
      if (chemin === "/embeddings") {
        etat.embeddings++;
        return json(404, { error: { message: "pas d'embeddings ici" } });
      }
      if (req.method !== "POST" || chemin !== "/chat/completions") return json(404, { error: { message: "inconnu" } });

      let corps;
      try {
        corps = JSON.parse(brut || "{}");
      } catch {
        return json(400, { error: { message: "JSON invalide" } });
      }
      etat.requetes.push({ chemin, entetes: { ...req.headers }, corps });
      if (!bearer) return refuseCle();

      // Champs inconnus : chacun son refus.
      const inconnus = d.champs ? Object.keys(corps).filter((k) => !d.champs.includes(k)) : [];
      if (inconnus.length > 0) {
        if (d.refus === "mistral") {
          return json(422, { object: "error", message: { detail: inconnus.map((k) => ({ type: "extra_forbidden", loc: ["body", k], msg: "Extra inputs are not permitted", input: corps[k] })) }, type: "invalid_request_error", param: null, code: null });
        }
        if (d.refus === "google") return json(400, [{ error: { code: 400, message: `Invalid JSON payload received. Unknown name "${inconnus[0]}": Cannot find field.`, status: "INVALID_ARGUMENT" } }]);
        return json(400, { error: { message: `Unrecognized request argument supplied: ${inconnus[0]}`, type: "invalid_request_error", param: null, code: null } });
      }
      const modele = String(corps.model ?? "");
      if (!d.modeles.map(idDe).includes(modele) || etat.retires.has(modele)) {
        if (nom === "anthropic") return json(404, { type: "error", error: { type: "not_found_error", message: `model: ${modele}` } });
        if (nom === "google") return json(404, [{ error: { code: 404, message: `models/${modele} is not found for API version v1main`, status: "NOT_FOUND" } }]);
        return json(404, { error: { message: `The model \`${modele}\` does not exist or you do not have access to it.`, type: "invalid_request_error", param: null, code: "model_not_found" } });
      }
      // OpenAI, série o et gpt-5 : `max_tokens`, une température autre que 1, `reasoning_effort: none` sont refusés.
      if (nom === "openai" && /^(gpt-5|o\d)/.test(modele)) {
        if ("max_tokens" in corps) return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } });
        if (corps.temperature !== undefined && corps.temperature !== 1) return json(400, { error: { message: `Unsupported value: 'temperature' does not support ${corps.temperature} with this model. Only the default (1) value is supported.`, type: "invalid_request_error", param: "temperature", code: "unsupported_value" } });
        if (corps.reasoning_effort === "none") return json(400, { error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'minimal', 'low', 'medium', and 'high'.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } });
      }
      if (nom === "openai" && /^gpt-4o/.test(modele) && "reasoning_effort" in corps) {
        return json(400, { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_parameter" } });
      }
      if (nom === "openai" && /^gpt-4o/.test(modele) && Number(corps.max_tokens) > 16384) {
        return json(400, { error: { message: `max_tokens is too large: ${corps.max_tokens}. This model supports at most 16384 completion tokens, whereas you provided ${corps.max_tokens}.`, type: "invalid_request_error", param: "max_tokens", code: "invalid_value" } });
      }
      const messages = Array.isArray(corps.messages) ? corps.messages : [];
      // Mistral : un identifiant d'appel d'outil fait neuf caractères alphanumériques.
      if (nom === "mistral" && messages.some((m) => m.role === "tool" && !/^[a-zA-Z0-9]{9}$/.test(String(m.tool_call_id)))) {
        return json(400, { object: "error", message: "Tool call id has to be a string of length 9 with only a-z, A-Z, 0-9", type: "invalid_request_error", param: null, code: "3280" });
      }

      const derniere = [...messages].reverse().find((m) => m.role === "user");
      const demande = texteDe(derniere);
      const outilsRendus = messages.filter((m) => m.role === "tool");
      const image = Array.isArray(derniere?.content) && derniere.content.some((p) => p.type === "image_url" && String(p.image_url?.url ?? "").startsWith("data:image/"));

      if (demande.includes("quota-essai")) return json(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", param: null, code: "insufficient_quota" } });
      if (demande.includes("debit-essai")) return json(429, { error: { message: `Rate limit reached for ${modele} on requests per min (RPM): Limit 3, Used 3. Please try again in 20s.`, type: "requests", param: null, code: "rate_limit_exceeded" } });
      if (demande.includes("surcharge-essai")) return json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
      if (demande.includes("credit-essai")) return json(402, { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } });

      // La réponse : une suite de fragments au format OpenAI.
      const fragments = [];
      const texte = (t) => fragments.push({ content: t });
      let fin = "stop";
      if (demande.includes("outil-essai")) {
        const outils = Array.isArray(corps.tools) ? corps.tools : [];
        const cible = outils.find((o) => o.function?.name === "bibliotheque__chercher") ?? outils[0];
        if (outilsRendus.length > 0) {
          const assistant = [...messages].reverse().find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
          const ids = new Set((assistant?.tool_calls ?? []).map((c) => c.id));
          const coherent = outilsRendus.length === ids.size && outilsRendus.every((m) => ids.has(m.tool_call_id) && typeof m.content === "string");
          texte(`CONCLUSION ${nom} : ${outilsRendus.length} résultat(s), ${coherent ? "identifiants cohérents" : "INCOHÉRENTS"}.`);
        } else if (!cible) {
          texte("PAS D'OUTILS");
        } else {
          const n = cible.function.name;
          fin = "tool_calls";
          if (nom === "google") {
            // Deux appels d'un coup, sans `index` ni identifiant.
            fragments.push({ role: "assistant", tool_calls: [
              { type: "function", function: { name: n, arguments: JSON.stringify({ texte: "rapport" }) } },
              { type: "function", function: { name: n, arguments: JSON.stringify({ texte: "budget" }) } },
            ] });
          } else if (nom === "mistral") {
            fragments.push({ role: "assistant", content: "", tool_calls: [{ id: "D681PevKs", type: "function", index: 0, function: { name: n, arguments: JSON.stringify({ texte: "rapport" }) } }] });
          } else {
            // OpenAI et ceux qui l'imitent : numéroté, arguments découpés.
            fragments.push({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_essai01", type: "function", function: { name: n, arguments: "" } }] });
            fragments.push({ tool_calls: [{ index: 0, function: { arguments: '{"texte":' } }] });
            fragments.push({ tool_calls: [{ index: 0, function: { arguments: '"rapport"}' } }] });
          }
        }
      } else if (demande.includes("image-essai")) {
        texte(`IMAGE ${image ? "VUE" : "ABSENTE"} ${nom}`);
      } else if (demande.includes("reflexion-essai")) {
        if (nom === "mistral") {
          fragments.push({ role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "Je pèse la question. " }] }] });
          fragments.push({ content: [{ type: "text", text: "Réponse réfléchie de mistral." }] });
        } else if (nom === "openrouter") {
          fragments.push({ role: "assistant", content: "", reasoning: "Je pèse la question. " });
          texte("Réponse réfléchie de openrouter.");
        } else {
          fragments.push({ role: "assistant", content: "", reasoning_content: "Je pèse la question. " });
          texte(`Réponse réfléchie de ${nom}.`);
        }
      } else {
        texte(`Bonjour de ${nom} (${modele}).`);
      }

      if (corps.stream !== true) {
        const contenu = fragments.map((f) => (typeof f.content === "string" ? f.content : "")).join("");
        return json(200, { id: "essai", object: "chat.completion", created: 1, model: modele, choices: [{ index: 0, message: { role: "assistant", content: contenu }, finish_reason: fin }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const envoyer = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: "essai", object: "chat.completion.chunk", created: 1, model: modele, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      for (const f of fragments) envoyer(f);
      if (demande.includes("coupure-essai")) {
        // OpenRouter : l'erreur arrive dans le flux, après un statut 200.
        res.write(`data: ${JSON.stringify({ id: "essai", object: "chat.completion.chunk", error: { code: 502, message: "Provider returned error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      envoyer({}, fin);
      if (corps.stream_options?.include_usage || nom === "mistral") {
        res.write(`data: ${JSON.stringify({ id: "essai", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
}

const PORTS = {};
const serveurs = [];
for (const nom of Object.keys(DIALECTES)) {
  PORTS[nom] = await portLibre();
  const s = fauxFournisseur(nom);
  await new Promise((ok) => s.listen(PORTS[nom], "127.0.0.1", ok));
  serveurs.push(s);
}

/* ------------------------------------------------------------------------- */
/* La passerelle, avec son module préalable                                   */
/* ------------------------------------------------------------------------- */

const DONNEES = mkdtempSync(join(tmpdir(), "oxoai-fournisseurs-"));
const AUX = mkdtempSync(join(tmpdir(), "oxoai-fournisseurs-aux-"));
const PROJET = mkdtempSync(join(tmpdir(), "oxoai-fournisseurs-projet-"));
const PORT = await portLibre();
const G = `http://127.0.0.1:${PORT}`;
const HOTES = Object.fromEntries(Object.entries(DIALECTES).map(([nom, d]) => [d.hote, PORTS[nom]]));
const DNS = join(AUX, "dns.json");
// Les noms des fournisseurs : une adresse publique de documentation. `interne.essai.test` : le réseau interne.
writeFileSync(DNS, JSON.stringify({ ...Object.fromEntries(Object.keys(HOTES).map((h) => [h, "203.0.113.10"])), "interne.essai.test": "10.0.0.5" }));
const BLOQUES = join(AUX, "sorties-bloquees.log");
const PREALABLE = join(AUX, "prealable.mjs");
writeFileSync(
  PREALABLE,
  `import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const hotes = ${JSON.stringify(HOTES)};
const dns = require("node:dns/promises");
const origine = dns.lookup;
dns.lookup = async (nom, options) => {
  const table = JSON.parse(readFileSync(${JSON.stringify(DNS)}, "utf8"));
  if (table[nom]) {
    const r = { address: table[nom], family: 4 };
    return options && options.all ? [r] : r;
  }
  return origine(nom, options);
};
syncBuiltinESMExports();
const fetchOrigine = globalThis.fetch;
globalThis.fetch = (entree, options) => {
  const adresse = new URL(typeof entree === "string" || entree instanceof URL ? String(entree) : entree.url);
  if (hotes[adresse.hostname]) {
    adresse.protocol = "http:";
    adresse.port = String(hotes[adresse.hostname]);
    adresse.hostname = "127.0.0.1";
    return fetchOrigine(adresse, options);
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(adresse.hostname)) return fetchOrigine(entree, options);
  appendFileSync(${JSON.stringify(BLOQUES)}, adresse.hostname + "\\n");
  return Promise.reject(new TypeError("fetch failed (essai : aucune sortie)"));
};
`,
);
// Clé en fichier, dans le dossier jetable : l'essai ne sollicite jamais le trousseau du poste (27/09/2026).
writeFileSync(join(AUX, "profil.json"), JSON.stringify({ chiffrement: "fichier", backends: [{ id: "lmstudio", enabled: false }, { id: "exo", enabled: false }] }));
// Le faux OpenCode de la batterie : OxoAI Code sans le vrai, ni aucun modèle.
const FAUX_OPENCODE = join(AUX, "opencode");
writeFileSync(FAUX_OPENCODE, `#!/bin/sh\nexec "${process.execPath}" "${join(RACINE, "scripts", "faux-opencode.mjs")}" "$@"\n`);
chmodSync(FAUX_OPENCODE, 0o755);
mkdirSync(join(AUX, "home"), { recursive: true });

const passerelle = spawn(process.execPath, ["--import", PREALABLE, join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    ...process.env,
    OXOAI_CONFIG: join(AUX, "profil.json"),
    OXOAI_GATEWAY_PORT: String(PORT),
    OXOAI_DATA_DIR: DONNEES,
    OXOAI_OPENCODE_BIN: FAUX_OPENCODE,
    OXOAI_CODE_DIR: PROJET,
    OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
    OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    OXOAI_GATEWAY_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
passerelle.stdout.on("data", (b) => (journal += b));
passerelle.stderr.on("data", (b) => (journal += b));
let demarree = false;
for (let i = 0; i < 120 && !demarree; i++) {
  try {
    await fetch(`${G}/health`);
    demarree = true;
  } catch {
    await attendre(250);
  }
}
if (!demarree) {
  console.log(`  ✗ la passerelle d'essai démarre  —  obtenu : ${journal.slice(-1500)}`);
  passerelle.kill();
  for (const s of serveurs) s.close();
  process.exit(1);
}

const JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
const avecJeton = { "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Langue": "fr" };
const appel = (chemin, options = {}) => fetch(`${G}${chemin}`, { redirect: "manual", ...options });
const poster = (chemin, entetes, corps) => appel(chemin, { method: "POST", headers: entetes, body: JSON.stringify(corps) });

const premier = await (await poster("/oxoai/auth/create", avecJeton, { fullName: "Alice Essai", email: "alice@example.test", password: "Mot2PasseSolide!42" })).json();
const A = { ...avecJeton, "X-OxoAI-Session": premier.session?.token };
const idA = premier.account?.id;
const creeB = await (await poster("/oxoai/auth/create", A, { fullName: "Bruno Essai", email: "bruno@example.test", password: "Provisoire2Passe!11" })).json();
const connB = await (await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: creeB.account?.id, password: "Provisoire2Passe!11", nouveau: "Bruno2PasseSolide!57" })).json();
const B = { ...avecJeton, "X-OxoAI-Session": connB.session?.token };

/** Un Chat de l'écran : le flux lu en entier, contenu, raisonnement, évènements et erreurs à part. */
async function chat(entetes, corps) {
  const r = await poster("/v1/chat/completions", entetes, { stream: true, tools: false, effort: "moyen", ...corps });
  const brut = await r.text();
  const sortie = { statut: r.status, contenu: "", reflexion: "", evenements: [], erreurs: [], brut, fini: brut.includes("[DONE]") };
  for (const ligne of brut.split("\n")) {
    if (!ligne.startsWith("data:")) continue;
    const t = ligne.slice(5).trim();
    if (!t || t === "[DONE]") continue;
    try {
      const j = JSON.parse(t);
      if (j.oxoai) {
        sortie.evenements.push(j.oxoai);
        if (j.oxoai.type === "error") sortie.erreurs.push(j.oxoai.message);
      }
      if (j.error) sortie.erreurs.push(j.error.message ?? JSON.stringify(j.error));
      const d = j.choices?.[0]?.delta;
      if (typeof d?.content === "string") sortie.contenu += d.content;
      if (typeof d?.reasoning_content === "string") sortie.reflexion += d.reasoning_content;
    } catch {
      /* fragment illisible */
    }
  }
  if (r.status !== 200) {
    try {
      sortie.erreurs.push(JSON.parse(brut).error?.message ?? brut);
    } catch {
      sortie.erreurs.push(brut);
    }
  }
  return sortie;
}
const dit = (s) => `${s.statut} ${s.contenu.slice(0, 120)} | ${s.erreurs.join(" / ").slice(0, 240)}`;

/* ------------------------------------------------------------------------- */
console.log("\nA. Brancher une clé : essai, liste des modèles, filtre");
const ATTENDUS = {
  openai: { voulus: ["gpt-4o", "gpt-4o-mini", "gpt-5", "o3-mini"], ecartes: ["text-embedding-3-small", "dall-e-3", "whisper-1", "tts-1", "gpt-4o-realtime-preview", "gpt-5-codex", "o3-pro", "gpt-3.5-turbo-instruct", "omni-moderation-latest", "gpt-image-1"] },
  anthropic: { voulus: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-essai-25"], ecartes: [] },
  google: { voulus: ["gemini-2.5-flash", "gemini-2.5-pro", "gemma-3-27b-it"], ecartes: ["gemini-embedding-001", "text-embedding-004", "aqa", "imagen-4.0-generate-001", "gemini-2.5-flash-preview-tts", "gemini-live-2.5-flash-preview", "models/gemini-2.5-flash"] },
  mistral: { voulus: ["mistral-large-latest", "pixtral-large-latest", "magistral-medium-latest", "codestral-latest"], ecartes: ["mistral-embed", "mistral-ocr-latest", "mistral-document-ai"] },
  openrouter: { voulus: ["openai/gpt-4o", "deepseek/deepseek-r1", "mistralai/mistral-small-3.2"], ecartes: ["black-forest-labs/flux-pro"] },
  deepseek: { voulus: ["deepseek-chat", "deepseek-reasoner"], ecartes: [] },
  together: { voulus: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-VL-72B-Instruct"], ecartes: ["BAAI/bge-large-en-v1.5", "black-forest-labs/FLUX.1-schnell", "Salesforce/Llama-Rank-V1"] },
};
const CHOISIS = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-5"],
  anthropic: ["claude-sonnet-4-5"],
  google: ["gemini-2.5-flash"],
  mistral: ["mistral-large-latest", "pixtral-large-latest", "magistral-medium-latest"],
  openrouter: ["openai/gpt-4o", "deepseek/deepseek-r1"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
};
const CLES = {};
for (const [nom, attendu] of Object.entries(ATTENDUS)) {
  const mauvaise = await poster("/oxoai/fournisseurs/essayer", A, { fournisseur: nom, cle: "cle-fausse-0000" });
  const jm = await mauvaise.json().catch(() => ({}));
  verifier(`${nom} : une clé fausse est dite refusée (400)`, mauvaise.status === 400 && /refuse cette clé/.test(jm.error?.message ?? ""), `${mauvaise.status} ${jm.error?.message}`);
  const essai = await poster("/oxoai/fournisseurs/essayer", A, { fournisseur: nom, cle: DIALECTES[nom].cle });
  const liste = (await essai.json().catch(() => ({}))).modeles ?? [];
  const manquants = attendu.voulus.filter((m) => !liste.includes(m));
  const intrus = attendu.ecartes.filter((m) => liste.includes(m));
  verifier(`${nom} : la bonne clé ouvre ses modèles de conversation (${liste.length})`, essai.status === 200 && manquants.length === 0, `${essai.status} manquants : ${manquants.join(", ")}`);
  if (attendu.ecartes.length > 0) verifier(`${nom} : ni plongement, ni image, ni voix, ni modèle hors /chat/completions`, intrus.length === 0, intrus.join(", "));
  const portee = nom === "openai" ? "equipe" : "moi";
  const ajout = await poster("/oxoai/fournisseurs", A, { fournisseur: nom, cle: DIALECTES[nom].cle, modeles: CHOISIS[nom], portee });
  const ja = await ajout.json().catch(() => ({}));
  CLES[nom] = ja.cle;
  verifier(`${nom} : la clé se branche (${portee === "equipe" ? "pour l'équipe" : "pour Alice"})`, ajout.status === 200 && ja.cle?.fin === DIALECTES[nom].cle.slice(-4), `${ajout.status} ${JSON.stringify(ja).slice(0, 120)}`);
}
{
  const requetesListe = etats.anthropic.requetes.filter((r) => r.chemin === "/models");
  verifier("anthropic : la liste est lue page par page (25 modèles, 20 par page)", requetesListe.some((r) => r.entetes["x-api-key"]) && requetesListe.length >= 2, requetesListe.length);
  verifier("anthropic : la liste reçoit la clé dans x-api-key, avec anthropic-version", requetesListe.every((r) => r.entetes["x-api-key"] && r.entetes["anthropic-version"] && !r.entetes.authorization), JSON.stringify(requetesListe.map((r) => Object.keys(r.entetes))).slice(0, 200));
  const cle = await poster("/oxoai/fournisseurs/essayer", A, { fournisseur: "openrouter", cle: "cle-fausse-0000" });
  verifier("openrouter : la liste est publique, mais une clé fausse est refusée par /key", cle.status === 400, cle.status);
}

/* ------------------------------------------------------------------------- */
console.log("\nB. Les modèles de la clé dans le sélecteur");
const modelesA = (await (await appel("/oxoai/models", { headers: A })).json()).models ?? [];
const modelesB = (await (await appel("/oxoai/models", { headers: B })).json()).models ?? [];
const uid = (nom, id) => `cle-${CLES[nom]?.id}/${id}`;
const m = (nom, id) => modelesA.find((x) => x.uid === uid(nom, id));
verifier("tous les modèles retenus sont proposés à Alice", Object.entries(CHOISIS).every(([nom, ids]) => ids.every((id) => m(nom, id))), Object.entries(CHOISIS).flatMap(([nom, ids]) => ids.filter((id) => !m(nom, id)).map((id) => `${nom}/${id}`)).join(", "));
verifier("chacun dit d'où il vient (clé, pays, fournisseur)", modelesA.filter((x) => x.origine === "cle").every((x) => x.pays && x.fournisseur), "sans pays");
for (const [nom, id] of [["openai", "gpt-4o"], ["openai", "gpt-5"], ["anthropic", "claude-sonnet-4-5"], ["google", "gemini-2.5-flash"], ["mistral", "pixtral-large-latest"], ["openrouter", "openai/gpt-4o"]]) {
  verifier(`${nom}/${id} lit les images (rôle vision)`, m(nom, id)?.roles?.includes("vision"), JSON.stringify(m(nom, id)?.roles));
}
for (const [nom, id] of [["mistral", "mistral-large-latest"], ["deepseek", "deepseek-chat"], ["openrouter", "deepseek/deepseek-r1"]]) {
  verifier(`${nom}/${id} ne passe pas pour un modèle de vision`, m(nom, id) && !m(nom, id).roles.includes("vision"), JSON.stringify(m(nom, id)?.roles));
}
verifier("mistral : ce que la liste déclare l'emporte (codestral n'est pas retenu, magistral raisonne)", m("mistral", "magistral-medium-latest")?.reasoning === true, JSON.stringify(m("mistral", "magistral-medium-latest")));
verifier("openai/gpt-5, deepseek-reasoner et deepseek-r1 raisonnent ; gpt-4o non", m("openai", "gpt-5")?.reasoning && m("deepseek", "deepseek-reasoner")?.reasoning && m("openrouter", "deepseek/deepseek-r1")?.reasoning && !m("openai", "gpt-4o")?.reasoning, "raisonnement mal déclaré");
verifier("Bruno voit les modèles de la clé d'équipe, pas ceux des clés d'Alice", modelesB.some((x) => x.uid === uid("openai", "gpt-4o")) && !modelesB.some((x) => x.uid === uid("anthropic", "claude-sonnet-4-5")), modelesB.map((x) => x.uid).join(", ").slice(0, 200));
{
  const avant = etats.openai.requetes.filter((r) => r.chemin === "/models").length;
  await appel("/oxoai/models", { headers: A });
  await appel("/oxoai/models", { headers: A });
  const apres = etats.openai.requetes.filter((r) => r.chemin === "/models").length;
  verifier("la liste d'un fournisseur n'est pas relue à chaque requête (gardée dix minutes)", apres === avant, `${avant} → ${apres}`);
}

/* ------------------------------------------------------------------------- */
console.log("\nC. Chat en flux, sans outils : chaque dialecte");
const SIMPLES = [["openai", "gpt-4o"], ["anthropic", "claude-sonnet-4-5"], ["google", "gemini-2.5-flash"], ["mistral", "mistral-large-latest"], ["openrouter", "openai/gpt-4o"], ["deepseek", "deepseek-chat"], ["together", "meta-llama/Llama-3.3-70B-Instruct-Turbo"]];
for (const [nom, id] of SIMPLES) {
  const s = await chat(A, { model: uid(nom, id), agent: "agent-inconnu", messages: [{ role: "user", content: "Bonjour" }] });
  verifier(`${nom} : la réponse arrive en flux, jusqu'au bout`, s.statut === 200 && s.contenu.includes(`Bonjour de ${nom}`) && s.fini && s.erreurs.length === 0, dit(s));
}
{
  const envoyes = Object.values(etats).flatMap((e) => e.requetes.filter((r) => r.corps).map((r) => r.corps));
  const fuite = envoyes.filter((c) => ["agent", "effort", "role", "connaissances"].some((k) => k in c) || typeof c.tools === "boolean");
  verifier("aucun champ propre à OxoAI ne part chez un fournisseur (agent, effort, role, connaissances, tools: false)", fuite.length === 0, JSON.stringify(fuite[0] ?? {}).slice(0, 200));
  const chat_template = envoyes.some((c) => "chat_template_kwargs" in c);
  verifier("aucun champ de moteur local (chat_template_kwargs) ne part chez un fournisseur", !chat_template, "envoyé");
  const mistral = etats.mistral.requetes.filter((r) => r.corps);
  verifier("mistral : stream_options refusé (422) une fois, puis plus envoyé", mistral.length >= 2 && !("stream_options" in mistral.at(-1).corps), mistral.map((r) => Object.keys(r.corps).join("+")).join(" | ").slice(0, 200));
  const cleEnvoyee = Object.entries(etats).every(([nom, e]) => e.requetes.filter((r) => r.corps).every((r) => r.entetes.authorization === `Bearer ${DIALECTES[nom].cle}`));
  verifier("la clé part dans Authorization pour la conversation, chez tous (Anthropic compris)", cleEnvoyee, "autre en-tête");
}

/* ------------------------------------------------------------------------- */
console.log("\nD. Raisonnement");
for (const [nom, id] of [["deepseek", "deepseek-reasoner"], ["openrouter", "deepseek/deepseek-r1"], ["mistral", "magistral-medium-latest"]]) {
  const s = await chat(A, { model: uid(nom, id), messages: [{ role: "user", content: "reflexion-essai" }] });
  verifier(`${nom}/${id} : la réflexion s'affiche à part, puis la réponse`, s.reflexion.includes("Je pèse la question") && s.contenu.includes("Réponse réfléchie") && !s.contenu.includes("pèse"), dit(s) + ` | réflexion : ${s.reflexion}`);
}
{
  const s = await chat(A, { model: uid("mistral", "magistral-medium-latest"), effort: "eleve", messages: [{ role: "user", content: "Bonjour" }] });
  const derniere = etats.mistral.requetes.filter((r) => r.corps).at(-1).corps;
  verifier("mistral/magistral : reasoning_effort refusé (422), retiré, la réponse arrive", s.contenu.includes("Bonjour de mistral") && !("reasoning_effort" in derniere), dit(s));
  const aucun = await chat(A, { model: uid("openai", "gpt-5"), effort: "aucun", messages: [{ role: "user", content: "Bonjour" }] });
  const envoye = etats.openai.requetes.filter((r) => r.corps?.model === "gpt-5").at(-1)?.corps ?? {};
  verifier("openai/gpt-5, niveau « Aucun » : reasoning_effort « none » refusé, « minimal » envoyé à la place", aucun.contenu.includes("Bonjour de openai") && envoye.reasoning_effort === "minimal", `${dit(aucun)} ${JSON.stringify(envoye).slice(0, 160)}`);
  const eleve = await chat(A, { model: uid("openai", "gpt-5"), effort: "eleve", messages: [{ role: "user", content: "Bonjour" }] });
  const envoyeEleve = etats.openai.requetes.filter((r) => r.corps?.model === "gpt-5").at(-1)?.corps ?? {};
  verifier("openai/gpt-5, niveau « Élevé » : reasoning_effort « high » part tel quel", eleve.contenu.includes("Bonjour de openai") && envoyeEleve.reasoning_effort === "high", JSON.stringify(envoyeEleve).slice(0, 160));
}

/* ------------------------------------------------------------------------- */
console.log("\nE. Appel d'outil complet : le modèle demande, OxoAI exécute, le modèle conclut");
for (const [nom, id] of SIMPLES) {
  const s = await chat(A, { model: uid(nom, id), tools: true, messages: [{ role: "user", content: "outil-essai : cherche le rapport dans la bibliothèque" }] });
  const debuts = s.evenements.filter((e) => e.type === "tool_start" && e.name === "bibliotheque__chercher");
  const fins = s.evenements.filter((e) => e.type === "tool_end" && e.name === "bibliotheque__chercher" && e.ok);
  const attendus = nom === "google" ? 2 : 1;
  verifier(
    `${nom} : ${attendus} appel(s) exécuté(s), résultat rendu au modèle, conclusion`,
    debuts.length === attendus && fins.length === attendus && s.contenu.includes(`CONCLUSION ${nom} : ${attendus} résultat(s), identifiants cohérents`),
    `${debuts.length} début(s), ${fins.length} fin(s) ; ${dit(s)}`,
  );
  if (nom === "google") verifier("google : deux appels sans index restent deux appels, aux arguments lisibles", debuts.map((e) => e.args?.texte).join(",") === "rapport,budget", JSON.stringify(debuts.map((e) => e.args)));
}

/* ------------------------------------------------------------------------- */
console.log("\nF. Images jointes");
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const avecImage = (texte) => [{ role: "user", content: [{ type: "text", text: texte }, { type: "image_url", image_url: { url: IMAGE } }] }];
for (const [nom, id] of [["openai", "gpt-4o"], ["anthropic", "claude-sonnet-4-5"], ["google", "gemini-2.5-flash"], ["mistral", "pixtral-large-latest"], ["openrouter", "openai/gpt-4o"]]) {
  const s = await chat(A, { model: uid(nom, id), messages: avecImage("image-essai") });
  verifier(`${nom}/${id} : l'image part, et le modèle la voit`, s.contenu.includes(`IMAGE VUE ${nom}`), dit(s));
}
{
  const s = await chat(A, { model: uid("deepseek", "deepseek-chat"), messages: avecImage("image-essai") });
  const statut = s.evenements.find((e) => e.type === "statut" && /ne sait pas lire les images/.test(e.message ?? ""));
  verifier("deepseek-chat (sans vision) : l'image ne part pas, et l'écran le dit", s.contenu.includes("IMAGE ABSENTE deepseek") && statut, dit(s));
}

/* ------------------------------------------------------------------------- */
console.log("\nG. Relais d'un client ordinaire (OpenCode, un script) : ses outils, ses champs");
{
  const avant = etats.openai.requetes.filter((r) => r.corps?.model === "gpt-5").length;
  const relais = async () => {
    const r = await poster("/v1/chat/completions", avecJeton, {
      model: "gpt-5", stream: true, max_tokens: 32000, temperature: 0.55,
      messages: [{ role: "user", content: "outil-essai" }],
      tools: [{ type: "function", function: { name: "lire_fichier", description: "Lit un fichier", parameters: { type: "object", properties: { chemin: { type: "string" } } } } }],
    });
    return { statut: r.status, texte: await r.text() };
  };
  const un = await relais();
  const envoyes = etats.openai.requetes.filter((r) => r.corps?.model === "gpt-5").slice(avant);
  const final = envoyes.at(-1)?.corps ?? {};
  verifier("gpt-5 par le relais : max_tokens renommé, température retirée, la réponse passe", un.statut === 200 && /"tool_calls"/.test(un.texte) && /lire_fichier/.test(un.texte) && un.texte.includes("[DONE]") && final.max_completion_tokens === 32000 && !("temperature" in final), `${un.statut} ${envoyes.length} requête(s) ${JSON.stringify(final).slice(0, 160)} ${un.texte.slice(0, 160)}`);
  const milieu = etats.openai.requetes.filter((r) => r.corps?.model === "gpt-5").length;
  const deux = await relais();
  const ensuite = etats.openai.requetes.filter((r) => r.corps?.model === "gpt-5").length - milieu;
  verifier("la correction est retenue : l'appel suivant part corrigé du premier coup", deux.statut === 200 && ensuite === 1, `${ensuite} requête(s)`);
  const perso = await poster("/v1/chat/completions", avecJeton, { model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "Bonjour" }] });
  const jp = await perso.text();
  verifier("au jeton d'instance seul, un modèle de clé personnelle est refusé (503, réservé)", perso.status === 503 && /réservé/.test(jp), `${perso.status} ${jp.slice(0, 120)}`);
}

/* ------------------------------------------------------------------------- */
console.log("\nH. Refus du fournisseur, dits à l'écran");
{
  const q = await chat(A, { model: uid("openai", "gpt-4o"), messages: [{ role: "user", content: "quota-essai" }] });
  verifier("quota épuisé (429) : dit comme tel, avec le fournisseur", q.erreurs.some((e) => /quota de la clé OpenAI est épuisé \(429\)/.test(e)), dit(q));
  const d = await chat(A, { model: uid("openai", "gpt-4o"), messages: [{ role: "user", content: "debit-essai" }] });
  verifier("débit limité (429) : « réessayez dans une minute »", d.erreurs.some((e) => /limite le débit de cette clé \(429\)/.test(e)), dit(d));
  const s = await chat(A, { model: uid("anthropic", "claude-sonnet-4-5"), messages: [{ role: "user", content: "surcharge-essai" }] });
  verifier("service surchargé (529) : dit, après un nouvel essai", s.erreurs.some((e) => /Anthropic est indisponible ou surchargé \(529\)/.test(e)), dit(s));
  const c = await chat(A, { model: uid("openrouter", "openai/gpt-4o"), messages: [{ role: "user", content: "credit-essai" }] });
  verifier("crédit épuisé (402) : dit", c.erreurs.some((e) => /faute de crédit \(402\)/.test(e)), dit(c));
  const coupe = await chat(A, { model: uid("openrouter", "openai/gpt-4o"), messages: [{ role: "user", content: "coupure-essai" }] });
  verifier("erreur au milieu du flux (OpenRouter) : dite, pas une bulle vide", coupe.erreurs.some((e) => /OpenRouter est indisponible ou surchargé \(502\)/.test(e)), dit(coupe));
  etats.openai.retires.add("gpt-4o-mini");
  const retire = await chat(A, { model: uid("openai", "gpt-4o-mini"), messages: [{ role: "user", content: "Bonjour" }] });
  verifier("modèle retiré par le fournisseur (404) : dit, avec quoi faire", retire.erreurs.some((e) => /ne connaît pas \(ou plus\) le modèle gpt-4o-mini \(404\)/.test(e)), dit(retire));
  etats.openai.revoquee = true;
  const revoquee = await chat(A, { model: uid("openai", "gpt-4o"), messages: [{ role: "user", content: "Bonjour" }] });
  verifier("clé révoquée (401) : dite comme telle, et non « modèle inconnu »", revoquee.erreurs.some((e) => /OpenAI refuse la clé \(401\)/.test(e)), dit(revoquee));
  etats.openai.revoquee = false;
  const cleGoogle = await poster("/oxoai/fournisseurs/essayer", A, { fournisseur: "google", cle: "cle-fausse-0000" });
  verifier("google : une clé fausse répond 400 (« API key not valid ») et reste dite refusée", cleGoogle.status === 400 && /refuse cette clé/.test((await cleGoogle.json()).error?.message ?? ""), cleGoogle.status);
  const langue = await chat({ ...A, "X-OxoAI-Langue": "en" }, { model: uid("openai", "gpt-4o"), messages: [{ role: "user", content: "quota-essai" }] });
  verifier("le refus suit la langue de la personne (anglais)", langue.erreurs.some((e) => /quota/i.test(e) && !/épuisé/.test(e)), dit(langue));
}

/* ------------------------------------------------------------------------- */
console.log("\nI. Routage Auto, bases de connaissances, adresse qui bascule");
{
  const auto = await chat(A, { messages: [{ role: "user", content: "Bonjour" }] });
  verifier("Auto sans modèle local : il ne prend pas un modèle de clé, et le dit en nommant celui qu'on peut choisir", auto.statut === 503 && auto.erreurs.some((e) => /ne choisit jamais un modèle branché par une clé/.test(e)), dit(auto));
  const doc = await (await poster("/oxoai/bibliotheque/documents", A, { nom: "Note-essai.txt", contenu: Buffer.from("Le code est PERLE-7710.").toString("base64"), texte: "Le code est PERLE-7710.", visibilite: "prive" })).json();
  const base = (await (await poster("/oxoai/connaissances", A, { nom: "Base-essai-cle", visibilite: "prive" })).json()).base;
  await poster(`/oxoai/connaissances/${base?.id}/documents`, A, { documents: [doc.element?.id] });
  let vue = "";
  for (let i = 0; i < 40; i++) {
    vue = JSON.stringify((await (await appel(`/oxoai/connaissances/${base?.id}`, { headers: A })).json()).base ?? {});
    if (/Une clé de fournisseur cloud ne sert pas à indexer/.test(vue)) break;
    await attendre(250);
  }
  const plongements = Object.values(etats).reduce((n, e) => n + e.embeddings, 0);
  verifier("base de connaissances sans modèle d'embeddings local : aucun appel chez un fournisseur, et l'écran dit pourquoi", plongements === 0 && /Une clé de fournisseur cloud ne sert pas à indexer/.test(vue), `${plongements} appel(s) ; ${vue.slice(0, 200)}`);

  const ajout = await poster("/oxoai/fournisseurs", A, { fournisseur: "compatible", adresse: "https://rebond.essai.test/v1", cle: DIALECTES.rebond.cle, nom: "Rebond", pays: "France", modeles: ["modele-rebond"] });
  const cleRebond = (await ajout.json()).cle;
  const avant = await chat(A, { model: `cle-${cleRebond?.id}/modele-rebond`, messages: [{ role: "user", content: "Bonjour" }] });
  verifier("fournisseur « compatible » à une adresse publique : il répond", avant.contenu.includes("Bonjour de rebond"), dit(avant));
  writeFileSync(DNS, JSON.stringify({ ...JSON.parse(readFileSync(DNS, "utf8")), "rebond.essai.test": "10.20.30.40" }));
  const n = etats.rebond.requetes.length;
  const apres = await chat(A, { model: `cle-${cleRebond?.id}/modele-rebond`, messages: [{ role: "user", content: "Bonjour" }] });
  verifier("la même adresse bascule vers le réseau interne : l'appel ne part pas, et c'est dit", etats.rebond.requetes.length === n && apres.erreurs.some((e) => /réseau interne/.test(e)), `${etats.rebond.requetes.length - n} requête(s) ; ${dit(apres)}`);
  const interne = await poster("/oxoai/fournisseurs/essayer", A, { fournisseur: "compatible", adresse: "https://interne.essai.test/v1", cle: "x" });
  verifier("une adresse du réseau interne est refusée dès l'essai", interne.status === 400 && /réseau interne/.test((await interne.json()).error?.message ?? ""), interne.status);
}

/* ------------------------------------------------------------------------- */
/*
 * Le cas vu par Medhi le 27/09/2026 (Helix 2026.927.3, Mac) : dans Code, un
 * modèle de sa propre clé OpenAI (gpt-4.1-nano) répondait « Modèle inconnu ou
 * réservé à la personne qui a branché sa clé : cle-…/gpt-4.1-nano ». Deux
 * refus à la suite : l'ouverture de la session résolvait le modèle sans dire
 * pour qui (index.ts, `reglageCode`), puis OpenCode appelait la passerelle au
 * jeton d'instance seul, sans personne en face (chat.ts, `resolve`).
 */
console.log("\nJ. OxoAI Code sur un modèle de clé personnelle (cas de Medhi : clé OpenAI, gpt-4.1-nano)");
{
  const ajout = await poster("/oxoai/fournisseurs", A, { fournisseur: "openai", cle: DIALECTES.openai.cle, modeles: ["gpt-4.1-nano"], portee: "moi" });
  const clePerso = (await ajout.json().catch(() => ({}))).cle;
  const nano = `cle-${clePerso?.id}/gpt-4.1-nano`;
  verifier("Alice branche sa clé OpenAI personnelle avec gpt-4.1-nano", ajout.status === 200 && clePerso?.portee === "moi", ajout.status);
  const ouverture = await poster("/oxoai/code/session", A, { model: nano, dossier: PROJET });
  const jo = await ouverture.json().catch(() => ({}));
  const session = jo.data?.id;
  verifier("Alice ouvre une session de Code sur gpt-4.1-nano de sa clé (avant : « modèle inconnu ou réservé »)", ouverture.status === 200 && /^ses_/.test(session ?? ""), `${ouverture.status} ${JSON.stringify(jo).slice(0, 160)}`);
  const refusB = await poster("/oxoai/code/session", B, { model: nano, dossier: PROJET });
  verifier("Bruno ne l'ouvre pas sur la clé personnelle d'Alice (503)", refusB.status === 503, refusB.status);
  const sessionB = (await (await poster("/oxoai/code/session", B, { model: uid("openai", "gpt-4o"), dossier: PROJET })).json().catch(() => ({}))).data?.id;
  let portFaux = 0;
  for (let i = 0; i < 40 && !portFaux; i++) {
    portFaux = Number(journal.match(/prêt sur le port (\d+)/)?.[1] ?? 0);
    if (!portFaux) await attendre(250);
  }
  const env = portFaux ? ((await (await fetch(`http://127.0.0.1:${portFaux}/essai/env`)).json().catch(() => ({}))).env ?? {}) : {};
  const relais = env.OXOAI_OPENCODE_CLE_RELAIS ?? "";
  // Ce qu'OpenCode envoie : le nom du modèle, ses outils, 32 000 jetons de réponse (opencode.ts).
  const appelCode = async (entetes) => {
    const r = await poster("/v1/chat/completions", { ...avecJeton, ...entetes }, {
      model: "gpt-4.1-nano", stream: true, max_tokens: 32000, effort: "moyen",
      messages: [{ role: "user", content: "Bonjour" }],
      tools: [{ type: "function", function: { name: "read", description: "Lit un fichier", parameters: { type: "object", properties: { filePath: { type: "string" } } } } }],
    });
    return { statut: r.status, texte: await r.text() };
  };
  const parOpencode = await appelCode({ "X-OxoAI-Relais": relais, "X-Session-Id": session ?? "" });
  verifier("l'appel d'OpenCode pour la session d'Alice reçoit gpt-4.1-nano de sa clé", Boolean(relais) && parOpencode.statut === 200 && parOpencode.texte.includes("Bonjour de openai (gpt-4.1-nano)"), `${parOpencode.statut} ${parOpencode.texte.slice(0, 160)}`);
  const pourB = await appelCode({ "X-OxoAI-Relais": relais, "X-Session-Id": sessionB ?? "" });
  verifier("le même appel pour une session de Bruno est refusé (503, réservé)", Boolean(sessionB) && pourB.statut === 503 && /réservé/.test(pourB.texte), `${pourB.statut} ${pourB.texte.slice(0, 120)}`);
  const sansCle = await appelCode({ "X-Session-Id": session ?? "" });
  verifier("sans la clé remise à OpenCode, le numéro de session d'Alice ne suffit pas (503)", sansCle.statut === 503, sansCle.statut);
  const autreSession = await appelCode({ "X-OxoAI-Relais": relais, "X-Session-Id": "ses_inconnueDuRegistre1" });
  verifier("avec la clé mais une session inconnue : refusé (503)", autreSession.statut === 503, autreSession.statut);
}

/* ------------------------------------------------------------------------- */
console.log("\nK. Rien ne sort vers un vrai fournisseur, aucune clé au journal");
{
  let bloques = "";
  try {
    bloques = readFileSync(BLOQUES, "utf8");
  } catch {
    /* rien de bloqué */
  }
  const fournisseurs = Object.values(DIALECTES).map((d) => d.hote);
  verifier("aucune requête n'a quitté la machine vers un fournisseur", !fournisseurs.some((h) => bloques.includes(h)), bloques.split("\n").filter(Boolean).join(", "));
  verifier("aucune clé en clair dans la sortie de la passerelle", !Object.values(DIALECTES).some((d) => journal.includes(d.cle)), "clé trouvée");
}

passerelle.kill();
for (const s of serveurs) s.close();
await attendre(400);
for (const d of [DONNEES, AUX, PROJET]) rmSync(d, { recursive: true, force: true });

console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
if (echecs.length) {
  console.log("Échecs :");
  for (const e of echecs) console.log(`  - ${e}`);
  process.exit(1);
}
