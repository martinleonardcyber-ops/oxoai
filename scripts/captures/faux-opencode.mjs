/*
 * Le faux OpenCode des captures (scripts/captures/capturer.mjs, 28/09/2026).
 *
 * Il part de celui de la batterie de sécurité (scripts/faux-opencode.mjs) :
 * l'ancienne API d'OpenCode 1.18.32 dont la passerelle se sert (sessions,
 * `prompt_async`, flux `/event`, fournisseurs de la configuration), avec son
 * mot de passe. Il y ajoute ce qu'il faut pour l'écran de OxoAI Code :
 *
 *  - à chaque demande, un appel au modèle par la passerelle, avec des outils,
 *    comme le vrai (la passerelle y reconnaît une session vivante, index.ts,
 *    `attendreAppel`) ; le modèle est le faux modèle de la scène ;
 *  - puis la séance de la scène (`--scene <fichier JSON>`) : liste de tâches,
 *    lectures, recherche, modifications, et une commande de tests laissée en
 *    cours, au rythme donné. Les évènements sont ceux du vrai
 *    (`message.updated`, `message.part.updated`, `message.part.delta`), que
 *    la passerelle traduit pour l'écran (fluxCode.ts).
 *
 * Il ne touche à aucun fichier et ne lance aucune commande : les modifications
 * et la commande de la scène ne sont que des évènements.
 *
 * Usage (par l'enveloppe posée par capturer.mjs) :
 *   faux-opencode.mjs --version
 *   faux-opencode.mjs serve --port N [--hostname 127.0.0.1] --scene fichier.json
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.18.32\n");
  process.exit(0);
}
if (!args.includes("serve")) process.exit(1);
const port = Number(args[args.indexOf("--port") + 1]);
const scene = args.includes("--scene") ? JSON.parse(readFileSync(args[args.indexOf("--scene") + 1], "utf8")) : { etapes: [] };
const attendu = "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString("base64");
const id = (prefixe) => `${prefixe}_${randomBytes(12).toString("hex")}`;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const flux = new Map();
const dossiers = new Map();
const messages = new Map();
const emettre = (evenement, dossier) => {
  for (const [res, d] of flux) if (dossier === undefined || d === dossier) res.write(`data: ${JSON.stringify(evenement)}\n\n`);
};

function configuration() {
  try {
    return JSON.parse(readFileSync(join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencode.json"), "utf8"));
  } catch {
    return {};
  }
}

/** L'appel au modèle, par la passerelle, comme le vrai : la demande et un outil déclaré. */
async function appelerModele(texte) {
  const oxoai = configuration().provider?.oxoai ?? {};
  const base = String(oxoai.options?.baseURL ?? "").replace(/\/+$/, "");
  const modele = Object.keys(oxoai.models ?? {})[0] ?? "";
  if (!base) return;
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OXOAI_OPENCODE_JETON ?? ""}`,
        "X-OxoAI-Relais": process.env.OXOAI_OPENCODE_CLE_RELAIS ?? "",
      },
      body: JSON.stringify({
        model: modele,
        stream: true,
        messages: [{ role: "system", content: "You are opencode." }, { role: "user", content: texte }],
        tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } } } } }],
      }),
    });
    await r.text();
  } catch {
    /* la scène se joue quand même */
  }
}

/** Joue la séance de la scène dans une session : les évènements du vrai, au rythme voulu. */
async function jouer(sessionID, messageID, dossier) {
  const ev = (type, properties) => emettre({ type, properties: { sessionID, ...properties } }, dossier);
  ev("message.updated", { info: { id: messageID, sessionID, role: "user" } });
  ev("session.status", { status: { type: "busy" } });
  const assistant = id("msg");
  ev("message.updated", { info: { id: assistant, sessionID, role: "assistant" } });
  ev("message.part.updated", { part: { id: id("prt"), sessionID, messageID: assistant, type: "step-start" } });
  // Une courte réflexion d'abord, comme un modèle qui raisonne, puis les outils.
  const reflexion = id("prt");
  const debutReflexion = Date.now();
  ev("message.part.updated", { part: { id: reflexion, sessionID, messageID: assistant, type: "reasoning", text: "", time: { start: debutReflexion } } });
  ev("message.part.delta", { partID: reflexion, messageID: assistant, field: "text", delta: scene.reflexion ?? "" });
  await attendre(scene.avantMs ?? 800);
  ev("message.part.updated", { part: { id: reflexion, sessionID, messageID: assistant, type: "reasoning", text: scene.reflexion ?? "", time: { start: debutReflexion, end: Date.now() } } });
  for (const etape of scene.etapes) {
    const part = { id: id("prt"), sessionID, messageID: assistant, type: "tool", tool: etape.outil, callID: id("call") };
    const debut = Date.now();
    ev("message.part.updated", { part: { ...part, state: { status: "pending", input: {} } } });
    ev("message.part.updated", { part: { ...part, state: { status: "running", input: etape.entree, time: { start: debut } } } });
    if (etape.enCours) break;
    await attendre(etape.dureeMs ?? 300);
    ev("message.part.updated", {
      part: { ...part, state: { status: "completed", input: etape.entree, output: etape.sortie ?? "", title: etape.titre ?? "", metadata: {}, time: { start: debut, end: Date.now() } } },
    });
    await attendre(etape.apresMs ?? 250);
  }
  // La commande reste en cours : la capture se prend pendant qu'elle tourne. La séance s'arrête avec le serveur.
}

const serveur = http.createServer((req, res) => {
  let corps = "";
  req.on("data", (b) => (corps += b));
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", "http://x");
    const chemin = url.pathname;
    const json = (valeur, statut = 200) => {
      res.writeHead(statut, { "Content-Type": "application/json" });
      res.end(JSON.stringify(valeur));
    };
    if (req.headers.authorization !== attendu) return json({ error: "unauthorized" }, 401);

    if (chemin === "/api/session") return json([]);
    if (chemin === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      flux.set(res, url.searchParams.get("directory") ?? "");
      res.on("close", () => flux.delete(res));
      return;
    }
    if (chemin === "/config/providers") {
      return json({ providers: [{ id: "oxoai", models: configuration().provider?.oxoai?.models ?? {} }] });
    }
    if (chemin === "/session/status") return json({});
    if (chemin === "/api/session/active") return json({ data: {} });
    if (chemin === "/mcp/oxoai/connect") return json(true);
    if (chemin === "/session" && req.method === "POST") {
      const nouvelle = id("ses");
      dossiers.set(nouvelle, url.searchParams.get("directory") ?? "");
      return json({ id: nouvelle });
    }
    const reponse = chemin.match(/^\/permission\/([^/]+)\/reply$/);
    if (reponse && req.method === "POST") return json(true);
    const session = chemin.match(/^\/session\/(ses_[A-Za-z0-9]+)(\/[a-z_]+)?$/);
    if (session) {
      if (session[2] === "/prompt_async") {
        const d = JSON.parse(corps || "{}");
        const texte = (d.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
        const messageID = d.messageID ?? id("msg");
        const liste = messages.get(session[1]) ?? [];
        liste.push({ info: { id: messageID, role: "user" }, parts: [{ type: "text", text: texte }] });
        messages.set(session[1], liste);
        res.writeHead(204);
        res.end();
        const dossier = url.searchParams.get("directory") ?? dossiers.get(session[1]) ?? "";
        void appelerModele(texte);
        void jouer(session[1], messageID, dossier);
        return;
      }
      if (session[2] === "/message") return json(messages.get(session[1]) ?? []);
      if (session[2] === "/abort") return json(true);
      return json({ id: session[1] });
    }
    json({ error: "inconnu" }, 404);
  });
});
serveur.listen(port, "127.0.0.1");
// Parti avec la passerelle : un faux serveur ne lui survit pas.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 1000);
process.on("SIGTERM", () => process.exit(0));
