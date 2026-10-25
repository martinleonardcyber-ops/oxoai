/*
 * Connecteurs déjà livrés, revérifiés le 28/09/2026 (SECURITE.md § 49) : un
 * parcours de connexion complet, puis un outil de lecture, contre de faux
 * serveurs écrits d'après la documentation officielle du jour.
 *
 *   node scripts/essai-connecteurs.mjs   (lancé aussi par npm run securite, section 16 septies)
 *
 * Pourquoi cet essai : `essai-natifs.mjs` éprouve de bout en bout les huit
 * connexions natives du 28/09 (Sheets, Slides, YouTube, LinkedIn, Facebook,
 * Instagram, TikTok, X), mais rien n'éprouvait le reste. Le bouton « Se
 * connecter » des serveurs MCP distants (oauthMcp.ts : découverte, inscription
 * automatique, PKCE, retour, échange, outils) n'était vu que par morceaux ;
 * Google Drive, Google Agenda et Slack n'étaient essayés que jusqu'à la
 * première page de la connexion, jamais jusqu'à une lecture. La revérification
 * a trouvé cinq adresses MCP périmées et un transport que OxoAI ne parlait pas
 * (Webflow, SSE) : c'est ce que cet essai tient désormais.
 *
 * Comme essai-natifs.mjs : une passerelle neuve (dossier de données
 * temporaire, clé de chiffrement en fichier, aucun moteur), lancée avec un
 * module préalable qui renvoie vers un faux serveur local les requêtes faites
 * aux hôtes des services (par `fetch` pour le SDK MCP, par `https.request`
 * pour Drive, Agenda et Slack) et refuse toute autre sortie. Les faux serveurs
 * imitent la documentation et les métadonnées publiques relevées le
 * 28/09/2026 ; rien n'a été essayé contre les vrais services.
 *
 *  I.   Serveurs MCP distants, par le bouton « Se connecter » :
 *       Jira et Confluence (inscription automatique, serveur d'autorisation sur
 *       un autre hôte), Asana V2 (application déclarée, identifiant et
 *       secret), Webflow (ancien transport SSE).
 *  II.  Google Drive et Google Agenda (retour sur la boucle locale, PKCE),
 *       Slack (jeton de bot relu).
 *  III. Dans un second processus qui relit les mêmes données chiffrées : un
 *       outil de lecture par service ; l'adresse réalignée d'un connecteur
 *       branché avant ; l'autorisation d'une adresse qui n'est pas présentée à
 *       une autre.
 *  IV.  Débrancher, et rien de secret nulle part.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as serveurHttp } from "node:http";
import { createServer as serveurTcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

let reussis = 0;
const echecs = [];
/** Ce qui ressemble à un jeton ou un secret de l'essai ne se recopie pas dans la sortie. */
const SECRETS = /(ACCES|ACTU)-[A-Za-z0-9.-]+|SECRET-[A-Z0-9-]+|GOCSPX-[A-Za-z0-9-]+|xoxb-[A-Za-z0-9-]+/;
const TOUS_SECRETS = new RegExp(SECRETS.source, "g");
const masquer = (s) => String(s).replace(TOUS_SECRETS, "[masqué]");
function verifier(nom, condition, obtenu) {
  if (condition) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${masquer(obtenu).slice(0, 400)}`);
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
const b64url = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => b64url(createHash("sha256").update(v).digest());

/* ------------------------------------------------------------------------- */
/* Identifiants d'essai                                                       */
/* ------------------------------------------------------------------------- */

const GOOGLE = { id: "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com", secret: "GOCSPX-SECRET-CONNECTEURS-ESSAI" };
const ASANA = { id: "1209999999999999", secret: "SECRET-ASANA-ESSAI" };
const SLACK = "xox" + "b-1234567890-0987654321-ESSAIJETONSLACK0000";
const PORTEES = {
  drive: "https://www.googleapis.com/auth/drive.readonly",
  agenda: "https://www.googleapis.com/auth/calendar.readonly",
};

/*
 * Les trois serveurs MCP, tels que leurs métadonnées publiques les décrivaient
 * le 28/09/2026 (lues sans compte, voir SECURITE.md § 49) :
 *  - Atlassian : ressource `https://mcp.atlassian.com/v2/mcp`, serveur
 *    d'autorisation `https://auth.atlassian.com/<locataire>` (émetteur à
 *    chemin), inscription automatique, PKCE S256 ;
 *  - Asana V2 : ressource `https://mcp.asana.com/v2/mcp`, serveur
 *    d'autorisation `https://app.asana.com`, **sans** inscription automatique ;
 *  - Webflow : ressource `https://mcp.webflow.com/sse`, serveur
 *    d'autorisation sur le même hôte, inscription automatique, et le seul
 *    transport documenté est l'ancien, SSE.
 */
const LOCATAIRE = "VCeDsk8ZHncYF1g234fKtc4lNipbBhu3";
const MCP = {
  "mcp.atlassian.com": {
    chemin: "/v2/mcp",
    as: `https://auth.atlassian.com/${LOCATAIRE}`,
    outil: { name: "getJiraIssue", description: "Lit un ticket Jira.", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } }, required: ["issueIdOrKey"] } },
    rendu: (a) => `Ticket ${a.issueIdOrKey} : Réparer la passerelle (statut : En cours).`,
  },
  "mcp.asana.com": {
    chemin: "/v2/mcp",
    as: "https://app.asana.com",
    outil: { name: "get_task", description: "Lit une tâche Asana.", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
    rendu: (a) => `Tâche ${a.task_id} : Préparer le salon, échéance vendredi.`,
  },
  "mcp.webflow.com": {
    chemin: "/sse",
    sse: true,
    as: "https://mcp.webflow.com",
    outil: { name: "sites_list", description: "Liste les sites Webflow.", inputSchema: { type: "object", properties: {} } },
    rendu: () => "Sites : Vitrine Essai (vitrine-essai.webflow.io).",
  },
};
const AS = {
  [`auth.atlassian.com/${LOCATAIRE}`]: {
    issuer: `https://auth.atlassian.com/${LOCATAIRE}`,
    authorization_endpoint: "https://auth.atlassian.com/authorize",
    token_endpoint: "https://auth.atlassian.com/oauth/token",
    registration_endpoint: `https://auth.atlassian.com/${LOCATAIRE}/dcr/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  },
  "app.asana.com": {
    issuer: "https://app.asana.com",
    authorization_endpoint: "https://app.asana.com/-/oauth_authorize",
    token_endpoint: "https://app.asana.com/-/oauth_token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  },
  "mcp.webflow.com": {
    issuer: "https://mcp.webflow.com",
    authorization_endpoint: "https://mcp.webflow.com/oauth/authorize",
    token_endpoint: "https://mcp.webflow.com/oauth/token",
    registration_endpoint: "https://mcp.webflow.com/oauth/register",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
  },
};
/** Hôte du serveur MCP servi par chaque point d'échange de jetons. */
const JETONS_VERS = { "auth.atlassian.com": "mcp.atlassian.com", "app.asana.com": "mcp.asana.com", "mcp.webflow.com": "mcp.webflow.com" };
const HOTES = [...Object.keys(MCP), "auth.atlassian.com", "app.asana.com", "oauth2.googleapis.com", "www.googleapis.com", "slack.com"];

/* ------------------------------------------------------------------------- */
/* Faux serveurs                                                              */
/* ------------------------------------------------------------------------- */

const recues = [];
/** Inscriptions automatiques reçues, par hôte : l'identifiant rendu, ce que l'instance a déclaré. */
const inscrits = {};
/** Autorisations accordées par la « personne », en attente d'échange : code → demande. */
const codes = new Map();
/** Jetons d'accès émis, par hôte de serveur MCP ou par service. */
const emis = {};
/** Flux SSE ouverts (Webflow), par session. */
const flux = new Map();
let compteur = 0;

function reponse(res, statut, json, entetes = {}) {
  res.writeHead(statut, { "Content-Type": "application/json", ...entetes });
  res.end(JSON.stringify(json));
}

/** Une réponse JSON-RPC du faux serveur MCP (initialisation, liste, appel). */
function rpc(hote, message) {
  const d = MCP[hote];
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `faux ${hote}`, version: "1.0.0" } } };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: [d.outil] } };
  if (message.method === "tools/call") {
    if (message.params?.name !== d.outil.name) return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "outil inconnu" } };
    return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: d.rendu(message.params.arguments ?? {}) }] } };
  }
  if (message.id === undefined) return null;
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "méthode inconnue" } };
}

const faux = serveurHttp(async (req, res) => {
  const morceaux = [];
  for await (const m of req) morceaux.push(m);
  const corps = Buffer.concat(morceaux).toString("utf8");
  const url = new URL(req.url ?? "/", "http://faux");
  const p = url.pathname;
  const q = url.searchParams;

  // La « personne » accorde l'accès sur la page du service : l'essai dépose ici la demande, et reçoit le code.
  if (p === "/__autoriser") {
    const demande = JSON.parse(corps);
    const code = `CODE-${demande.hote}-${++compteur}`;
    codes.set(code, demande);
    return reponse(res, 200, { code });
  }

  const hote = String(req.headers["x-hote"] ?? "");
  recues.push({ hote, methode: req.method, chemin: `${p}${url.search}`, entetes: req.headers, corps });
  const f = new URLSearchParams(corps);
  const auth = String(req.headers.authorization ?? "");

  /* ---- Métadonnées publiques (RFC 9728, RFC 8414) ---- */
  if (req.method === "GET" && p.startsWith("/.well-known/oauth-protected-resource")) {
    const d = MCP[hote];
    if (!d || p !== `/.well-known/oauth-protected-resource${d.chemin}`) return reponse(res, 404, { error: "not_found" });
    return reponse(res, 200, { resource: `https://${hote}${d.chemin}`, authorization_servers: [d.as], bearer_methods_supported: ["header"] });
  }
  if (req.method === "GET" && p.startsWith("/.well-known/oauth-authorization-server")) {
    const cle = `${hote}${p.slice("/.well-known/oauth-authorization-server".length)}`;
    return AS[cle] ? reponse(res, 200, AS[cle]) : reponse(res, 404, { error: "not_found" });
  }
  if (req.method === "GET" && p.startsWith("/.well-known/openid-configuration")) return reponse(res, 404, { error: "not_found" });

  /* ---- Inscription automatique (RFC 7591) ---- */
  if (req.method === "POST" && ((hote === "auth.atlassian.com" && p === `/${LOCATAIRE}/dcr/register`) || (hote === "mcp.webflow.com" && p === "/oauth/register"))) {
    const meta = JSON.parse(corps || "{}");
    const client = { client_id: `dcr-${hote}-${++compteur}`, client_secret: `SECRET-DCR-${compteur}`, client_id_issued_at: Math.floor(Date.now() / 1000), ...meta };
    inscrits[hote] = { client, meta };
    return reponse(res, 201, client);
  }

  /* ---- Échange du code, et renouvellement ---- */
  const pointJetons = (hote === "auth.atlassian.com" && p === "/oauth/token") || (hote === "app.asana.com" && p === "/-/oauth_token") || (hote === "mcp.webflow.com" && p === "/oauth/token");
  if (req.method === "POST" && pointJetons) {
    let clientId = f.get("client_id") ?? "";
    let secret = f.get("client_secret") ?? "";
    if (auth.startsWith("Basic ")) [clientId, secret] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").map(decodeURIComponent);
    const attendu = hote === "app.asana.com" ? { id: ASANA.id, secret: ASANA.secret } : { id: inscrits[hote]?.client.client_id, secret: inscrits[hote]?.client.client_secret };
    if (!attendu.id || clientId !== attendu.id || secret !== attendu.secret) return reponse(res, 401, { error: "invalid_client" });
    const mcp = JETONS_VERS[hote];
    if (f.get("grant_type") === "refresh_token") {
      if (f.get("refresh_token") !== `ACTU-MCP-${mcp}`) return reponse(res, 400, { error: "invalid_grant" });
    } else {
      const demande = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      if (!demande || demande.hote !== hote) return reponse(res, 400, { error: "invalid_grant" });
      // PKCE : le vérificateur, gardé par l'instance, doit être celui du défi envoyé au départ.
      if (s256(f.get("code_verifier") ?? "") !== demande.code_challenge) return reponse(res, 400, { error: "invalid_grant", error_description: "PKCE" });
      if (f.get("redirect_uri") !== demande.redirect_uri) return reponse(res, 400, { error: "invalid_grant", error_description: "redirect_uri" });
    }
    emis[mcp] = `ACCES-MCP-${mcp}-${++compteur}`;
    return reponse(res, 200, { access_token: emis[mcp], token_type: "Bearer", expires_in: 3600, refresh_token: `ACTU-MCP-${mcp}` });
  }

  /* ---- Serveurs MCP ---- */
  const d = MCP[hote];
  if (d) {
    const porteur = emis[hote] && auth === `Bearer ${emis[hote]}`;
    const refus = () =>
      reponse(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": `Bearer resource_metadata="https://${hote}/.well-known/oauth-protected-resource${d.chemin}"` });
    if (p === d.chemin && !d.sse) {
      if (!porteur) return refus();
      if (req.method === "GET") return reponse(res, 405, { error: "method_not_allowed" });
      if (req.method === "DELETE") return reponse(res, 200, {});
      const message = JSON.parse(corps);
      const r = rpc(hote, message);
      if (!r) {
        res.writeHead(202);
        return res.end();
      }
      return reponse(res, 200, r, message.method === "initialize" ? { "Mcp-Session-Id": "session-essai" } : {});
    }
    if (d.sse && p === d.chemin) {
      if (!porteur) return refus();
      // Ancien transport : pas de POST ici (c'est ce qui décide le repli du client).
      if (req.method !== "GET") return reponse(res, 405, { error: "method_not_allowed" });
      const session = `s${++compteur}`;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: endpoint\ndata: /messages?sessionId=${session}\n\n`);
      flux.set(session, res);
      req.on("close", () => flux.delete(session));
      return;
    }
    if (d.sse && p === "/messages" && req.method === "POST") {
      if (!porteur) return refus();
      const sortie = flux.get(q.get("sessionId") ?? "");
      if (!sortie) return reponse(res, 404, { error: "session inconnue" });
      res.writeHead(202);
      res.end();
      const r = rpc(hote, JSON.parse(corps));
      if (r) sortie.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
      return;
    }
    return reponse(res, 404, { error: "not_found" });
  }

  /* ---- Google : jetons ---- */
  if (hote === "oauth2.googleapis.com") {
    if (p === "/revoke") return reponse(res, 200, {});
    if (p === "/token") {
      if (f.get("client_id") !== GOOGLE.id || f.get("client_secret") !== GOOGLE.secret) return reponse(res, 401, { error: "invalid_client" });
      // La boîte Gmail branchée par « Se connecter avec Google » (section V) : un renouvellement un peu lent, et une panne passagère.
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "ACTU-panne") return reponse(res, 503, { error: "backendError" });
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "ACTU-courrier") {
        await attendre(150);
        return reponse(res, 200, { access_token: `ACCES-courrier-${++compteur}`, expires_in: 3599, scope: "https://mail.google.com/", token_type: "Bearer" });
      }
      if (f.get("grant_type") === "refresh_token") {
        const svc = (f.get("refresh_token") ?? "").replace("ACTU-", "");
        if (!PORTEES[svc]) return reponse(res, 400, { error: "invalid_grant" });
        emis[svc] = `ACCES-${svc}-${++compteur}`;
        return reponse(res, 200, { access_token: emis[svc], expires_in: 3599, scope: PORTEES[svc], token_type: "Bearer" });
      }
      const demande = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      if (!demande || demande.hote !== "accounts.google.com") return reponse(res, 400, { error: "invalid_grant" });
      if (s256(f.get("code_verifier") ?? "") !== demande.code_challenge || f.get("redirect_uri") !== demande.redirect_uri) return reponse(res, 400, { error: "invalid_grant" });
      const svc = demande.scope === PORTEES.drive ? "drive" : "agenda";
      emis[svc] = `ACCES-${svc}-${++compteur}`;
      return reponse(res, 200, { access_token: emis[svc], refresh_token: `ACTU-${svc}`, expires_in: 3599, scope: demande.scope, token_type: "Bearer" });
    }
  }
  /* ---- Google : Drive et Agenda ---- */
  if (hote === "www.googleapis.com") {
    const svc = p.startsWith("/drive/") ? "drive" : p.startsWith("/calendar/") ? "agenda" : "";
    if (!svc || !emis[svc] || auth !== `Bearer ${emis[svc]}`) return reponse(res, 401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    if (p === "/drive/v3/about") return reponse(res, 200, { user: { displayName: "Alice Essai", emailAddress: "alice@example.test" } });
    if (p === "/drive/v3/files") {
      const maintenant = new Date(Date.now() - 86_400_000).toISOString();
      return reponse(res, 200, { files: [{ id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", name: "Budget essai 2026", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: maintenant, webViewLink: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit" }], incompleteSearch: false });
    }
    if (p === "/calendar/v3/users/me/calendarList") return reponse(res, 200, { items: [{ id: "alice@example.test", summary: "Alice Essai", primary: true, accessRole: "owner" }] });
    if (p === `/calendar/v3/calendars/${encodeURIComponent("alice@example.test")}/events`) {
      const debut = new Date(Date.now() + 26 * 3600_000);
      const fin = new Date(debut.getTime() + 3600_000);
      return reponse(res, 200, { items: [{ id: "evenement-essai", status: "confirmed", summary: "Réunion chantier essai", start: { dateTime: debut.toISOString() }, end: { dateTime: fin.toISOString() } }] });
    }
    return reponse(res, 404, { error: { code: 404 } });
  }
  /* ---- Slack ---- */
  if (hote === "slack.com") {
    if (auth !== `Bearer ${SLACK}`) return reponse(res, 200, { ok: false, error: "invalid_auth" });
    const entetes = { "x-oauth-scopes": "channels:read,channels:history,users:read" };
    if (p === "/api/auth.test") return reponse(res, 200, { ok: true, url: "https://essai.slack.com/", team: "Espace Essai", user: "oxoai", team_id: "T0ESSAI01", user_id: "U0OXOAI01", bot_id: "B0ESSAI01" }, entetes);
    if (p === "/api/users.conversations") return reponse(res, 200, { ok: true, channels: [{ id: "C0ESSAI01", name: "chantier-essai", is_private: false }], response_metadata: { next_cursor: "" } }, entetes);
    if (p === "/api/conversations.history") return reponse(res, 200, { ok: true, messages: [{ type: "message", user: "U0MARIE01", text: "Livraison du béton jeudi matin.", ts: `${Math.floor(Date.now() / 1000) - 3600}.000100` }], has_more: false }, entetes);
    if (p === "/api/users.info") return reponse(res, 200, { ok: true, user: { id: "U0MARIE01", name: "marie", real_name: "Marie Essai", profile: { display_name: "Marie", real_name: "Marie Essai" } } }, entetes);
    return reponse(res, 200, { ok: false, error: "unknown_method" });
  }
  return reponse(res, 404, { error: "hôte inconnu de l'essai" });
});
const PORT_FAUX = await portLibre();
await new Promise((ok) => faux.listen(PORT_FAUX, "127.0.0.1", ok));

/* ------------------------------------------------------------------------- */
/* Instance jetable                                                           */
/* ------------------------------------------------------------------------- */

const DONNEES = mkdtempSync(join(tmpdir(), "oxoai-connecteurs-donnees-"));
const AUX = mkdtempSync(join(tmpdir(), "oxoai-connecteurs-aux-"));
const ESPACE = mkdtempSync(join(tmpdir(), "oxoai-connecteurs-espace-"));
const PREALABLE = join(AUX, "prealable.mjs");
/*
 * Le module préalable : ce qui part vers un hôte des services revient au faux
 * serveur, avec l'hôte d'origine dans `x-hote` ; tout le reste est refusé.
 * `fetch` est celui du SDK MCP, `https.request` celui de clientHttps.ts
 * (Drive, Agenda, Slack), qui appelle l'objet par défaut de `node:https`.
 */
writeFileSync(
  PREALABLE,
  `import https from "node:https";
import http from "node:http";
const HOTES = new Set(${JSON.stringify(HOTES)});
const fetchOrigine = globalThis.fetch;
globalThis.fetch = async (entree, options = {}) => {
  const brute = typeof entree === "string" || entree instanceof URL ? String(entree) : entree.url;
  const a = new URL(brute);
  if (["127.0.0.1", "localhost", "[::1]"].includes(a.hostname)) return fetchOrigine(entree, options);
  if (a.protocol !== "https:" || !HOTES.has(a.hostname)) throw new TypeError("fetch failed (essai : aucune sortie vers " + a.hostname + ")");
  let init = options;
  if (typeof entree === "object" && !(entree instanceof URL)) {
    init = { method: entree.method, headers: entree.headers, body: ["GET", "HEAD"].includes(entree.method) ? undefined : await entree.arrayBuffer(), ...options };
  }
  const entetes = new Headers(init.headers ?? {});
  entetes.set("x-hote", a.hostname);
  return fetchOrigine("http://127.0.0.1:${PORT_FAUX}" + a.pathname + a.search, { ...init, headers: entetes, redirect: "manual" });
};
https.request = (options, rappel) => {
  const hote = options.host ?? options.hostname;
  if (!HOTES.has(hote)) throw new Error("essai : aucune sortie vers " + hote);
  return http.request({ host: "127.0.0.1", port: ${PORT_FAUX}, path: options.path, method: options.method, agent: false, headers: { ...(options.headers ?? {}), "x-hote": hote } }, rappel);
};
`,
);
writeFileSync(join(AUX, "profil.json"), JSON.stringify({ chiffrement: "fichier", backends: [{ id: "lmstudio", enabled: false }, { id: "exo", enabled: false }] }));

const PORT = await portLibre();
const G = `http://127.0.0.1:${PORT}`;
const ENV = {
  ...process.env,
  OXOAI_CONFIG: join(AUX, "profil.json"),
  OXOAI_GATEWAY_PORT: String(PORT),
  OXOAI_DATA_DIR: DONNEES,
  OXOAI_WORKSPACE: ESPACE,
  OXOAI_CODE_DIR: ESPACE,
  OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
  OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
  OXOAI_GATEWAY_HOST: "127.0.0.1",
};
const passerelle = spawn(process.execPath, ["--import", PREALABLE, join(RACINE, "gateway", "src", "index.ts")], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
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
  faux.close();
  process.exit(1);
}

const JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
const avecJeton = { "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Langue": "fr" };
const appel = (chemin, options = {}) => fetch(`${G}${chemin}`, { redirect: "manual", ...options });
const poster = (chemin, entetes, corps) => appel(chemin, { method: "POST", headers: entetes, body: JSON.stringify(corps ?? {}) });
const premier = await (await poster("/oxoai/auth/create", avecJeton, { fullName: "Alice Essai", email: "alice@example.test", password: "Mot2PasseSolide!42" })).json();
const A = { ...avecJeton, "X-OxoAI-Session": premier.session?.token };
// Une collègue, membre sans droit d'administration (tournée des connecteurs du 28/09/2026, section II).
const creeB = await (await poster("/oxoai/auth/create", A, { fullName: "Bruno Essai", email: "bruno@example.test", password: "Provisoire2Passe!11" })).json();
const connB = await (await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: creeB.account?.id, password: "Provisoire2Passe!11", nouveau: "Bruno2PasseSolide!57" })).json();
const B = { ...avecJeton, "X-OxoAI-Session": connB.session?.token };
const installes = async () => (await (await appel("/oxoai/connecteurs", { headers: A })).json()).installes ?? [];
/** La « personne » ouvre la page d'autorisation et dit oui : le service rend un code, lié au défi PKCE et à l'adresse de retour. */
const accorder = async (adresse) => {
  const a = new URL(adresse);
  const demande = { hote: a.hostname, ...Object.fromEntries(a.searchParams) };
  const r = await fetch(`http://127.0.0.1:${PORT_FAUX}/__autoriser`, { method: "POST", body: JSON.stringify(demande) });
  return { ...demande, code: (await r.json()).code };
};

/* ------------------------------------------------------------------------- */
console.log("\nI. Serveurs MCP distants : « Se connecter », de bout en bout");
const branches = {};
{
  // Jira et Confluence : inscription automatique, serveur d'autorisation d'Atlassian sur un autre hôte.
  const depart = await (await poster("/oxoai/connecteurs/connecter", A, { id: "atlassian" })).json();
  const adresse = depart.adresse ? new URL(depart.adresse) : null;
  const inscrit = inscrits["auth.atlassian.com"];
  verifier(
    "Atlassian : les métadonnées sont lues à l'adresse du catalogue (/v2/mcp), l'instance s'inscrit elle-même auprès d'auth.atlassian.com, avec son adresse de retour",
    depart.ok === true && Boolean(inscrit) && JSON.stringify(inscrit.meta.redirect_uris) === JSON.stringify([`${G}/oxoai/oauth/retour`]) && recues.some((x) => x.hote === "mcp.atlassian.com" && x.chemin === "/.well-known/oauth-protected-resource/v2/mcp"),
    JSON.stringify(depart).slice(0, 300),
  );
  verifier(
    "Atlassian : la page d'autorisation est celle d'Atlassian, avec PKCE S256, un state, la ressource et l'identifiant inscrit",
    adresse?.origin === "https://auth.atlassian.com" && adresse.pathname === "/authorize" && adresse.searchParams.get("code_challenge_method") === "S256" && (adresse.searchParams.get("code_challenge") ?? "").length >= 43 && (adresse.searchParams.get("state") ?? "").length >= 32 && adresse.searchParams.get("resource") === "https://mcp.atlassian.com/v2/mcp" && adresse.searchParams.get("client_id") === inscrit?.client.client_id,
    depart.adresse,
  );
  /*
   * Un refus dans la page du service (revue du 28/09/2026) : l'écran qui
   * attend l'accord le lit dans l'état des connecteurs, au lieu d'attendre
   * cinq minutes. Un refus au `state` inventé ne note rien.
   */
  const etatDemande = adresse?.searchParams.get("state") ?? "";
  await appel(`/oxoai/oauth/retour?error=access_denied&state=${"z".repeat(32)}`);
  const sansIssue = (await (await appel("/oxoai/connecteurs", { headers: A })).json()).issues ?? {};
  const refusRetour = await appel(`/oxoai/oauth/retour?error=access_denied&state=${encodeURIComponent(etatDemande)}`);
  const issueRefus = ((await (await appel("/oxoai/connecteurs", { headers: A })).json()).issues ?? {}).atlassian;
  verifier(
    "Atlassian : un refus dans la page du service est noté pour l'écran qui attend (issue en échec, message fixe), un refus au state inventé ne note rien",
    // 28/09/2026 : le message dit la cause et le remède (refusOauth.ts) plutôt que le seul code.
    refusRetour.status === 400 && !sansIssue.atlassian && issueRefus?.ok === false && /“Cancel”|« Annuler »/.test(issueRefus?.message ?? ""),
    JSON.stringify({ sansIssue, issueRefus }),
  );
  /*
   * Après un refus, l'autorisation ne sert plus (usage unique, tournée des
   * connexions du 28/09/2026) : la personne recommence par « Se connecter »,
   * qui donne une nouvelle adresse, avec un nouveau state.
   */
  const nouvelle = await (await poster("/oxoai/connecteurs/connecter", A, { id: "atlassian" })).json();
  verifier("Atlassian : après un refus, « Se connecter » donne une nouvelle autorisation (l'ancienne ne sert plus)", Boolean(nouvelle.adresse) && new URL(nouvelle.adresse).searchParams.get("state") !== etatDemande, JSON.stringify(nouvelle).slice(0, 200));
  // Sans page d'autorisation (code d'avant la revérification), la suite échoue sans s'arrêter.
  const accord = nouvelle.adresse ? await accorder(nouvelle.adresse) : { code: "", state: "" };
  const faux = await appel(`/oxoai/oauth/retour?code=${accord.code}&state=${"x".repeat(32)}`);
  verifier("Atlassian : un retour avec un state inventé est refusé (400), rien n'est échangé", faux.status === 400 && !recues.some((x) => x.chemin === "/oauth/token"), faux.status);
  // Le navigateur que le service renvoie ne porte que sa propre langue (Accept-Language) : la page doit la suivre.
  const retour = await appel(`/oxoai/oauth/retour?code=${encodeURIComponent(accord.code)}&state=${encodeURIComponent(accord.state)}`, { headers: { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" } });
  const page = await retour.text();
  const echange = recues.find((x) => x.hote === "auth.atlassian.com" && x.chemin === "/oauth/token");
  verifier("Atlassian : le bon retour aboutit (le code s'échange avec le vérificateur PKCE gardé par l'instance), et la page le dit dans la langue du navigateur (elle était toujours en anglais)", retour.status === 200 && /branché/.test(page) && Boolean(echange) && new URLSearchParams(echange.corps).get("resource") === "https://mcp.atlassian.com/v2/mcp", `${retour.status} ${page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
  const vu = (await installes()).find((c) => c.id === "atlassian");
  verifier("Atlassian : branché, serveur démarré, un outil listé par le transport « streamable » avec le jeton en Bearer", vu?.running === true && vu.toolCount === 1 && vu.distant === true && recues.some((x) => x.hote === "mcp.atlassian.com" && x.methode === "POST" && x.chemin === "/v2/mcp" && /tools\/list/.test(x.corps)), JSON.stringify(vu));
  const issueFinale = ((await (await appel("/oxoai/connecteurs", { headers: A })).json()).issues ?? {}).atlassian;
  verifier("Atlassian : après le bon retour, l'issue notée est un succès (le refus d'avant ne compte plus)", issueFinale?.ok === true, JSON.stringify(issueFinale));
  branches.atlassian = vu?.running === true;
  const rejoue = await appel(`/oxoai/oauth/retour?code=${encodeURIComponent(accord.code)}&state=${encodeURIComponent(accord.state)}`);
  verifier("Atlassian : le même retour rejoué ne mène plus à rien (400)", rejoue.status === 400, rejoue.status);

  // Asana V2 : pas d'inscription automatique ; une « MCP app » déclarée chez Asana.
  const sansAppli = await (await poster("/oxoai/connecteurs/connecter", A, { id: "asana" })).json();
  verifier(
    "Asana : sans application déclarée, le message dit où la créer (console d'Asana) et quelle adresse de retour y mettre ; rien n'est demandé à Asana",
    sansAppli.ok === false && /app\.asana\.com\/0\/my-apps/.test(sansAppli.message ?? "") && (sansAppli.message ?? "").includes(`${G}/oxoai/oauth/retour`) && !recues.some((x) => x.hote === "app.asana.com"),
    sansAppli.message,
  );
  const departAsana = await (await poster("/oxoai/connecteurs/connecter", A, { id: "asana", clientId: ASANA.id, clientSecret: ASANA.secret })).json();
  const adresseAsana = departAsana.adresse ? new URL(departAsana.adresse) : null;
  verifier(
    "Asana : avec l'identifiant de l'application, la page d'autorisation est celle d'Asana (/-/oauth_authorize), PKCE S256, et aucune inscription automatique n'est tentée",
    adresseAsana?.origin === "https://app.asana.com" && adresseAsana.pathname === "/-/oauth_authorize" && adresseAsana.searchParams.get("client_id") === ASANA.id && adresseAsana.searchParams.get("code_challenge_method") === "S256" && !recues.some((x) => /register/.test(x.chemin) && x.hote.includes("asana")),
    JSON.stringify(departAsana).slice(0, 300),
  );
  verifier("Asana : la réponse ne rend pas le secret de l'application", !JSON.stringify(departAsana).includes(ASANA.secret), "secret rendu");
  const accordAsana = departAsana.adresse ? await accorder(departAsana.adresse) : { code: "", state: "" };
  const retourAsana = await appel(`/oxoai/oauth/retour?code=${encodeURIComponent(accordAsana.code)}&state=${encodeURIComponent(accordAsana.state)}`);
  const vuAsana = (await installes()).find((c) => c.id === "asana");
  verifier("Asana : le code s'échange avec l'identifiant et le secret de l'application, le serveur V2 démarre avec un outil", retourAsana.status === 200 && vuAsana?.running === true && vuAsana.toolCount === 1, `${retourAsana.status} ${JSON.stringify(vuAsana)}`);
  branches.asana = vuAsana?.running === true;

  // Webflow : l'adresse documentée est celle de l'ancien transport SSE.
  /*
   * D'abord un échange raté (code refusé par le service) : le `state` n'est
   * plus reçu ensuite, même avec un bon code. Il ne restait effacé qu'après un
   * échange réussi : l'adresse d'autorisation, retrouvée dans l'historique du
   * navigateur, servait encore dix minutes à qui voulait y brancher son propre
   * compte (tournée des connecteurs du 28/09/2026).
   */
  const departRate = await (await poster("/oxoai/connecteurs/connecter", A, { id: "webflow" })).json();
  const accordRate = departRate.adresse ? await accorder(departRate.adresse) : { code: "", state: "" };
  const rate = await appel(`/oxoai/oauth/retour?code=CODE-INVENTE&state=${encodeURIComponent(accordRate.state)}`);
  const reprise = await appel(`/oxoai/oauth/retour?code=${encodeURIComponent(accordRate.code)}&state=${encodeURIComponent(accordRate.state)}`);
  verifier("Webflow : après un échange raté, le même state ne sert plus (400), même avec un bon code : rien n'est branché", rate.status === 400 && reprise.status === 400 && !(await installes()).some((c) => c.id === "webflow"), `${rate.status} ${reprise.status}`);
  const departWf = await (await poster("/oxoai/connecteurs/connecter", A, { id: "webflow" })).json();
  const accordWf = departWf.adresse ? await accorder(departWf.adresse) : null;
  const retourWf = accordWf ? await appel(`/oxoai/oauth/retour?code=${encodeURIComponent(accordWf.code)}&state=${encodeURIComponent(accordWf.state)}`) : { status: 0 };
  const vuWf = (await installes()).find((c) => c.id === "webflow");
  const postSse = recues.some((x) => x.hote === "mcp.webflow.com" && x.methode === "POST" && x.chemin === "/sse");
  const getSse = recues.some((x) => x.hote === "mcp.webflow.com" && x.methode === "GET" && x.chemin === "/sse" && x.entetes.authorization?.startsWith("Bearer "));
  verifier("Webflow : le transport « streamable » est refusé (405) et OxoAI se replie sur SSE, à la même adresse, avec le jeton : branché, un outil", retourWf.status === 200 && vuWf?.running === true && vuWf.toolCount === 1 && postSse && getSse, `${retourWf.status} ${JSON.stringify(vuWf)} post=${postSse} get=${getSse}`);
  branches.webflow = vuWf?.running === true;

  const etat = await (await appel("/oxoai/connecteurs", { headers: A })).text();
  verifier("l'état des connecteurs ne contient ni jeton, ni secret, ni identifiant d'application", !SECRETS.test(etat) && !etat.includes(ASANA.secret) && !etat.includes("dcr-"), etat.match(SECRETS)?.[0] ?? "identifiant");
  const catalogue = JSON.parse(etat).catalogue ?? [];
  verifier("catalogue servi : Figma et Vercel présents, Asana demande une application", catalogue.some((e) => e.id === "figma") && catalogue.some((e) => e.id === "vercel") && catalogue.find((e) => e.id === "asana")?.oauth === "appli", catalogue.map((e) => e.id).join(", "));
}

/* ------------------------------------------------------------------------- */
console.log("\nII. Google Drive, Google Agenda et Slack : connexion complète");
{
  const g = await poster("/oxoai/google/client", A, { clientId: GOOGLE.id, clientSecret: GOOGLE.secret });
  verifier("application Google de l'instance enregistrée", g.status === 200, g.status);

  /*
   * Un compte pour toute l'instance : une collègue ne le branche, ne le
   * remplace ni ne le débranche (tournée des connecteurs du 28/09/2026 : une
   * séance suffisait, et l'agenda de l'instance pouvait être remplacé par un
   * serveur à elle, qui recevait les rendez-vous écrits par les agents de tous).
   */
  const refusesB = [];
  for (const [route, corps] of [
    ["/oxoai/drive/connecter", {}],
    ["/oxoai/drive/code", { adresse: "http://127.0.0.1:1/?state=x&code=y" }],
    ["/oxoai/agenda/google/connecter", { ecriture: true }],
    ["/oxoai/agenda/google/code", { adresse: "http://127.0.0.1:1/?state=x&code=y" }],
    ["/oxoai/agenda/configurer", { url: "https://agenda.exemple.test/dav/", identifiant: "bruno", motDePasse: "x" }],
    ["/oxoai/slack/configurer", { jeton: SLACK }],
  ]) {
    const r = await poster(route, B, corps);
    refusesB.push(`${route} ${r.status}`);
  }
  const lectureB = await appel("/oxoai/drive", { headers: B });
  verifier("une collègue (membre) ne peut ni brancher Drive, Google Agenda, un agenda CalDAV ou Slack, ni coller l'adresse de retour (403) ; elle lit l'état", refusesB.every((x) => x.endsWith(" 403")) && lectureB.status === 200 && !recues.some((x) => x.hote === "slack.com"), refusesB.join(", "));

  for (const [svc, route] of [["drive", "/oxoai/drive"], ["agenda", "/oxoai/agenda/google"]]) {
    const depart = await (await poster(`${route}/connecter`, A, {})).json();
    const adresse = depart.url ? new URL(depart.url) : null;
    const retour = adresse?.searchParams.get("redirect_uri") ?? "";
    verifier(
      `${svc} : consentement Google (accounts.google.com/o/oauth2/v2/auth), portée ${PORTEES[svc].split("/").pop()} seule, PKCE S256, accès durable demandé, retour sur la boucle locale`,
      adresse?.origin === "https://accounts.google.com" && adresse.pathname === "/o/oauth2/v2/auth" && adresse.searchParams.get("scope") === PORTEES[svc] && adresse.searchParams.get("code_challenge_method") === "S256" && adresse.searchParams.get("access_type") === "offline" && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(retour),
      depart.url ?? JSON.stringify(depart),
    );
    if (!adresse) continue;
    const accord = await accorder(adresse.toString());
    const intrus = await fetch(`${retour}?state=${"y".repeat(43)}&code=${accord.code}`);
    verifier(`${svc} : un retour au mauvais state est refusé et n'annule pas la connexion en cours`, intrus.status === 400, intrus.status);
    const bon = await fetch(`${retour}?state=${encodeURIComponent(accord.state)}&code=${encodeURIComponent(accord.code)}`);
    const texte = await bon.text();
    verifier(`${svc} : le bon retour aboutit (code échangé avec le vérificateur, compte lu avant tout enregistrement)`, bon.status === 200 && /alice@example\.test/.test(texte), `${bon.status} ${texte.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  const drive = await (await appel("/oxoai/drive", { headers: A })).json();
  verifier("Drive : l'état dit le compte branché, sans jeton", drive.configure === true && drive.compte === "alice@example.test" && !SECRETS.test(JSON.stringify(drive)), JSON.stringify(drive).slice(0, 200));
  const agenda = await (await appel("/oxoai/agenda/google", { headers: A })).json();
  verifier("Agenda : l'état dit le compte branché, en lecture seule", agenda.configure === true && agenda.compte === "alice@example.test" && agenda.ecriture !== true, JSON.stringify(agenda).slice(0, 200));

  const slack = await (await poster("/oxoai/slack/configurer", A, { jeton: SLACK })).json();
  const oublisB = [];
  for (const route of ["/oxoai/drive/oublier", "/oxoai/agenda/google/oublier", "/oxoai/agenda/oublier", "/oxoai/slack/oublier"]) oublisB.push(`${route} ${(await poster(route, B, {})).status}`);
  const driveApresB = await (await appel("/oxoai/drive", { headers: A })).json();
  const slackApresB = await (await appel("/oxoai/slack", { headers: A })).json();
  verifier("une collègue ne peut pas débrancher le Drive, l'agenda ni le Slack de l'organisation (403) : ils restent branchés", oublisB.every((x) => x.endsWith(" 403")) && driveApresB.configure === true && slackApresB.configure === true, `${oublisB.join(", ")} drive=${driveApresB.configure} slack=${slackApresB.configure}`);
  verifier("Slack : le jeton de bot est essayé (auth.test), ses autorisations relues (lecture seule), les salons listés, puis enregistré", slack.ok === true && /Espace Essai/.test(slack.message ?? "") && /chantier-essai/.test(slack.message ?? ""), slack.message);
  verifier("Slack : la réponse ne rend pas le jeton", !JSON.stringify(slack).includes(SLACK), "jeton rendu");
}

/* ------------------------------------------------------------------------- */
console.log("\nIII. Un outil de lecture par service, dans un second processus qui relit les données chiffrées");
const ENFANT = join(AUX, "lecture.mjs");
const src = (f) => JSON.stringify(pathToFileURL(join(RACINE, "gateway", "src", f)).href);
writeFileSync(
  ENFANT,
  `const mode = process.argv[2];
const c = await import(${src("connecteurs.ts")});
const m = await import(${src("mcp.ts")});
const o = await import(${src("oauthMcp.ts")});
const sortie = {};
if (mode === "lire") {
  await c.charger();
  for (const id of ["atlassian", "asana", "webflow"]) sortie["demarre_" + id] = await m.startServer(id);
  sortie.atlassian = await m.callTool("atlassian__getJiraIssue", { issueIdOrKey: "ESSAI-7" });
  sortie.asana = await m.callTool("asana__get_task", { task_id: "1201" });
  sortie.webflow = await m.callTool("webflow__sites_list", {});
  // Un connecteur branché avant la revérification garde son ancienne adresse : réalignée sur le catalogue.
  const ancien = (id, url) => c.aligner({ id, label: id, description: "", url, secrets: {}, depuis: "" }).url;
  sortie.aligne = { asana: ancien("asana", "https://mcp.asana.com/sse"), atlassian: ancien("atlassian", "https://mcp.atlassian.com/v1/sse"), wix: ancien("wix", "https://mcp.wix.com/sse"), square: ancien("square", "https://mcp.squareup.com/sse"), paypal: ancien("paypal", "https://mcp.paypal.com/mcp"), figma: ancien("figma", "https://mcp.figma.com/mcp") };
  // L'autorisation obtenue pour une adresse n'est pas présentée à une autre.
  sortie.memeAdresse = Boolean(await new o.FournisseurAutorisation("atlassian", "https://mcp.atlassian.com/v2/mcp", "").tokens());
  sortie.autreAdresse = (await new o.FournisseurAutorisation("atlassian", "https://mcp.atlassian.com/v1/sse", "").tokens()) === undefined && (await new o.FournisseurAutorisation("atlassian", "https://mcp.atlassian.com/v1/sse", "").clientInformation()) === undefined;
  const { chargerClientGoogle } = await import(${src("clientGoogle.ts")});
  await chargerClientGoogle();
  const d = await import(${src("drive.ts")});
  sortie.drive = await d.callTool("drive__chercher", { texte: "budget" });
  const ag = await import(${src("agenda.ts")});
  sortie.agenda = await ag.callTool("agenda__prochains", { jours: 3 });
  const s = await import(${src("slack.ts")});
  sortie.slack = await s.callTool("slack__messages", { salon: "chantier-essai" });
} else {
  await c.charger();
  sortie.jetonsAtlassian = Boolean(await new o.FournisseurAutorisation("atlassian", "https://mcp.atlassian.com/v2/mcp", "").tokens());
  sortie.jetonsAsana = Boolean(await new o.FournisseurAutorisation("asana", "https://mcp.asana.com/v2/mcp", "").tokens());
}
console.log("RESULTAT " + JSON.stringify(sortie));
process.exit(0);
`,
);
const enfant = (mode) =>
  new Promise((fin) => {
    const e = spawn(process.execPath, ["--import", PREALABLE, ENFANT, mode], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    e.stdout.on("data", (b) => (stdout += b));
    e.stderr.on("data", (b) => (stderr += b));
    const minuterie = setTimeout(() => e.kill(), 120_000);
    e.on("close", (status, signal) => {
      clearTimeout(minuterie);
      const ligne = stdout.split("\n").find((l) => l.startsWith("RESULTAT "));
      let r = {};
      try {
        r = JSON.parse(ligne?.slice("RESULTAT ".length) ?? "{}");
      } catch {
        /* rendu illisible : les contrôles le diront */
      }
      fin({ r, ligne, brut: `${stdout}${stderr}`, status, signal });
    });
  });
const lecture = await enfant("lire");
{
  const r = lecture.r;
  verifier("le second processus s'est déroulé jusqu'au bout", Boolean(lecture.ligne), `${lecture.status} ${lecture.signal} ${lecture.brut.slice(-800)}`);
  verifier("Atlassian : après redémarrage, le jeton relu du magasin chiffré suffit ; l'outil de lecture rend le ticket", r.demarre_atlassian?.ok === true && r.atlassian?.ok === true && /ESSAI-7 : Réparer la passerelle/.test(r.atlassian?.content ?? ""), JSON.stringify(r.atlassian ?? r.demarre_atlassian));
  verifier("Asana V2 : l'outil de lecture rend la tâche", r.asana?.ok === true && /1201 : Préparer le salon/.test(r.asana?.content ?? ""), JSON.stringify(r.asana ?? r.demarre_asana));
  verifier("Webflow : l'outil de lecture passe par le flux SSE et rend les sites", r.webflow?.ok === true && /Vitrine Essai/.test(r.webflow?.content ?? ""), JSON.stringify(r.webflow ?? r.demarre_webflow));
  verifier(
    "un connecteur branché avant la revérification est réaligné sur l'adresse du catalogue (Asana V2, Atlassian V2, Wix, Square, PayPal) ; hors catalogue (Figma), rien ne change",
    r.aligne?.asana === "https://mcp.asana.com/v2/mcp" && r.aligne?.atlassian === "https://mcp.atlassian.com/v2/mcp" && r.aligne?.wix === "https://mcp.wix.com/mcp" && r.aligne?.square === "https://mcp.squareup.com/mcp" && r.aligne?.paypal === "https://mcp.paypal.com/http" && r.aligne?.figma === "https://mcp.figma.com/mcp",
    JSON.stringify(r.aligne),
  );
  verifier("l'autorisation d'une adresse n'est pas présentée à une autre (ni jeton, ni inscription) ; témoin : la même adresse la retrouve", r.memeAdresse === true && r.autreAdresse === true, `${r.memeAdresse} ${r.autreAdresse}`);
  const renouvDrive = recues.some((x) => x.hote === "oauth2.googleapis.com" && x.chemin === "/token" && new URLSearchParams(x.corps).get("refresh_token") === "ACTU-drive");
  verifier("Drive : jeton renouvelé par le jeton d'actualisation chiffré, puis drive__chercher rend le fichier", r.drive?.ok === true && /Budget essai 2026/.test(r.drive?.content ?? "") && renouvDrive, JSON.stringify(r.drive));
  verifier("Agenda : agenda__prochains lit l'agenda principal par l'API Google", r.agenda?.ok === true && /Réunion chantier essai/.test(r.agenda?.content ?? ""), JSON.stringify(r.agenda));
  verifier("Slack : slack__messages lit le salon, auteur résolu", r.slack?.ok === true && /Livraison du béton/.test(r.slack?.content ?? "") && /Marie/.test(r.slack?.content ?? ""), JSON.stringify(r.slack));
}

/* ------------------------------------------------------------------------- */
console.log("\nIV. Débrancher, et rien de secret nulle part");
{
  const retrait = await (await poster("/oxoai/connecteurs/retirer", A, { id: "atlassian" })).json();
  verifier("Atlassian retiré de l'instance", retrait.ok === true && !(await installes()).some((c) => c.id === "atlassian"), retrait.message);
  const apres = await enfant("apres");
  verifier("le retrait efface aussi l'autorisation (plus de jeton pour Atlassian) ; témoin : Asana garde le sien", apres.r.jetonsAtlassian === false && apres.r.jetonsAsana === true, JSON.stringify(apres.r));
  for (const route of ["/oxoai/drive/oublier", "/oxoai/agenda/google/oublier", "/oxoai/slack/oublier"]) await poster(route, A, {});

  // Le disque : aucun jeton, secret ni code en clair, où que ce soit dans le dossier de données.
  const fuites = [];
  const parcourir = (d) => {
    for (const nom of readdirSync(d)) {
      const chemin = join(d, nom);
      if (statSync(chemin).isDirectory()) parcourir(chemin);
      else {
        const texte = readFileSync(chemin, "latin1");
        for (const x of [...(texte.match(TOUS_SECRETS) ?? []), ...[ASANA.secret, GOOGLE.secret, SLACK].filter((s) => texte.includes(s))]) fuites.push(`${nom}: ${x.slice(0, 12)}`);
      }
    }
  };
  parcourir(DONNEES);
  verifier("aucun jeton, jeton d'actualisation, secret d'application ni jeton Slack en clair dans le dossier de données (journal d'audit compris)", fuites.length === 0, fuites.slice(0, 5).join(" | "));
  verifier("aucun jeton ni secret dans la sortie de la passerelle", !SECRETS.test(journal), journal.match(SECRETS)?.[0]);
  verifier("aucun jeton ni secret dans la sortie du second processus (hors du rendu contrôlé plus haut)", !SECRETS.test(lecture.brut.replace(lecture.ligne ?? "", "")), "fuite");
  const hors = recues.filter((x) => !HOTES.includes(x.hote));
  verifier("aucune requête vers un hôte hors de la liste de l'essai", hors.length === 0, hors.map((x) => x.hote).join(", "));
}

/* ------------------------------------------------------------------------- */
console.log("\nV. Courrier branché par « Se connecter avec Google » : IMAP en XOAUTH2, renouvellement");
const COURRIER = mkdtempSync(join(tmpdir(), "oxoai-connecteurs-courrier-"));
{
  /*
   * Un faux serveur IMAP en TLS (certificat fabriqué par tls.ts, accepté par ce
   * processus seul), qui se comporte comme Gmail d'après sa documentation
   * (https://developers.google.com/workspace/gmail/imap/xoauth2-protocol, lue
   * le 28/09/2026) : un refus de XOAUTH2 envoie d'abord « + <erreur en base 64> »
   * et attend une ligne vide avant le « NO ». Il annonce aussi LOGINDISABLED,
   * qui ne ferme que LOGIN.
   */
  writeFileSync(join(COURRIER, "profil.json"), JSON.stringify({ chiffrement: "fichier", share: true, backends: [{ id: "lmstudio", enabled: false }, { id: "exo", enabled: false }] }));
  const script = join(COURRIER, "courrier.mjs");
  writeFileSync(
    script,
    `import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
const { tlsMaterial } = await import(${src("tls.ts")});
const m = tlsMaterial();
const connecterOrigine = tls.connect;
tls.connect = (...a) => { if (a[0] && typeof a[0] === "object") a[0] = { ...a[0], ca: m.cert }; return connecterOrigine(...a); };
syncBuiltinESMExports();
const { ClientImap } = await import(${src("courrier.ts")});
const co = await import(${src("courrierOauth.ts")});
// Hors requête, la passerelle parle anglais (langue.ts) : l'essai lit les messages en français, comme l'écran d'un poste français.
const { dansLaLangue } = await import(${src("langue.ts")});
const BON = "ACCES-IMAP-BON";
const sortie = { auths: 0 };
const serveur = tls.createServer({ cert: m.cert, key: m.key }, (s) => {
  let tampon = "";
  let courant = "";
  let litteral = 0;
  let suite = null;
  s.on("error", () => {});
  s.write("* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 LOGINDISABLED] Essai pret\\r\\n");
  s.on("data", (b) => {
    tampon += b.toString("latin1");
    for (;;) {
      // Un littéral synchronisant ({n}) : « + », puis ses n octets, puis la suite de la ligne.
      if (litteral > 0) {
        if (tampon.length < litteral) return;
        courant += tampon.slice(0, litteral);
        tampon = tampon.slice(litteral);
        litteral = 0;
      }
      const i = tampon.indexOf("\\r\\n");
      if (i < 0) return;
      const morceau = tampon.slice(0, i);
      tampon = tampon.slice(i + 2);
      const annonce = /\\{(\\d+)\\}$/.exec(morceau);
      if (annonce) {
        courant += morceau.slice(0, annonce.index);
        litteral = Number(annonce[1]);
        s.write("+ vas-y\\r\\n");
        continue;
      }
      const l = courant + morceau;
      courant = "";
      if (suite) { const t = suite; suite = null; s.write(t + " NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\\r\\n"); continue; }
      const [tag, cmd, ...r] = l.split(" ");
      const c = (cmd ?? "").toUpperCase();
      if (c === "CAPABILITY") s.write("* CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 LOGINDISABLED\\r\\n" + tag + " OK Fait\\r\\n");
      else if (c === "AUTHENTICATE") {
        sortie.auths++;
        const clair = Buffer.from(r[1] ?? "", "base64").toString("utf8");
        if (clair.includes("auth=Bearer " + BON)) s.write(tag + " OK Bienvenue\\r\\n");
        else { suite = tag; s.write("+ " + Buffer.from('{"status":"401","schemes":"Bearer","scope":"https://mail.google.com/"}').toString("base64") + "\\r\\n"); }
      } else if (c === "LOGIN") s.write(tag + " NO LOGIN desactive\\r\\n");
      else if (c === "EXAMINE") s.write("* 2 EXISTS\\r\\n* OK [UIDVALIDITY 7] ok\\r\\n" + tag + " OK [READ-ONLY] fait\\r\\n");
      else if (c === "LOGOUT") { s.write("* BYE a bientot\\r\\n" + tag + " OK\\r\\n"); s.end(); }
      else s.write(tag + " BAD inconnu\\r\\n");
    }
  });
});
await new Promise((ok) => serveur.listen(0, "127.0.0.1", ok));
const base = { serveur: "127.0.0.1", port: serveur.address().port, chiffrement: "tls", identifiant: "boite@example.test", motDePasse: "", adresse: "boite@example.test" };
const jetons = (acces) => ({ fournisseur: "google", clientId: ${JSON.stringify(GOOGLE.id)}, clientSecret: ${JSON.stringify(GOOGLE.secret)}, refreshToken: "ACTU-courrier", accessToken: acces, expire: Date.now() + 3600_000 });
await dansLaLangue("fr", async () => {
const c1 = new ClientImap({ ...base, oauth: jetons(BON) });
try { await c1.connecter(); sortie.total = await c1.ouvrir("INBOX"); } catch (e) { sortie.erreurBon = e.message; } finally { await c1.fermer(); }
const c2 = new ClientImap({ ...base, oauth: jetons("ACCES-IMAP-REVOQUE") });
const t0 = Date.now();
try { await c2.connecter(); sortie.refuseAccepte = true; } catch (e) { sortie.refus = { message: e.message, categorie: e.categorie, ms: Date.now() - t0 }; } finally { await c2.fermer(); }
const perime = { fournisseur: "google", clientId: ${JSON.stringify(GOOGLE.id)}, clientSecret: ${JSON.stringify(GOOGLE.secret)}, refreshToken: "ACTU-courrier" };
sortie.simultanes = (await Promise.all([co.accesValide(perime), co.accesValide(perime), co.accesValide(perime)])).map((r) => (r.ok ? r.acces : "ECHEC " + r.message));
const panne = await co.accesValide({ ...perime, refreshToken: "ACTU-panne" });
sortie.panne = panne.ok ? "ok" : panne.message;
});
serveur.close();
console.log("RESULTAT " + JSON.stringify(sortie));
process.exit(0);
`,
  );
  const r = await new Promise((fin) => {
    const e = spawn(process.execPath, ["--import", PREALABLE, "--no-warnings", script], { env: { ...ENV, OXOAI_CONFIG: join(COURRIER, "profil.json"), OXOAI_DATA_DIR: COURRIER }, stdio: ["ignore", "pipe", "pipe"] });
    let texte = "";
    e.stdout.on("data", (b) => (texte += b));
    e.stderr.on("data", (b) => (texte += b));
    const minuterie = setTimeout(() => e.kill(), 90_000);
    e.on("close", () => {
      clearTimeout(minuterie);
      const ligne = texte.split("\n").find((l) => l.startsWith("RESULTAT "));
      try {
        fin({ ...JSON.parse(ligne?.slice("RESULTAT ".length) ?? "{}"), brut: texte });
      } catch {
        fin({ brut: texte });
      }
    });
  });
  verifier("IMAP en XOAUTH2 : la boîte s'ouvre avec le jeton, même si le serveur annonce LOGINDISABLED (qui ne ferme que LOGIN)", r.total === 2 && !r.erreurBon, r.erreurBon ?? r.brut?.slice(-400));
  verifier(
    "IMAP en XOAUTH2 : un jeton refusé (« + » puis ligne vide, comme Gmail) est dit refusé tout de suite, pas après vingt secondes d'attente (« le serveur a cessé de répondre »)",
    r.refuseAccepte !== true && r.refus?.categorie === "authentification" && /a refusé l'accès à la boîte/.test(r.refus?.message ?? "") && (r.refus?.ms ?? 99_999) < 5000,
    JSON.stringify(r.refus ?? r.brut?.slice(-400)),
  );
  const renouvellements = recues.filter((x) => x.hote === "oauth2.googleapis.com" && new URLSearchParams(x.corps).get("refresh_token") === "ACTU-courrier").length;
  verifier("courrier : trois lectures qui renouvellent en même temps ne font qu'un renouvellement chez Google, et reçoivent le même jeton", renouvellements === 1 && new Set(r.simultanes ?? []).size === 1 && /^ACCES-courrier-/.test(r.simultanes?.[0] ?? ""), `${renouvellements} renouvellement(s) ${JSON.stringify(r.simultanes)}`);
  verifier("courrier : une panne passagère de Google (503) au renouvellement ne dit pas de rebrancher la boîte", /réessayez dans quelques minutes/i.test(r.panne ?? "") && !/rebrancher/.test(r.panne ?? ""), r.panne);
}

passerelle.kill();
faux.close();
await attendre(200);
for (const d of [DONNEES, AUX, ESPACE, COURRIER]) rmSync(d, { recursive: true, force: true });

console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
if (echecs.length) {
  console.log("Échecs :");
  for (const e of echecs) console.log(`  - ${e}`);
  process.exit(1);
}
process.exit(0);
