/*
 * Essai de l'extension VS Code (extensions/vscode/extension.js), 29/09/2026.
 *
 *   npm run essai:vscode
 *
 * Un faux module `vscode` (commandes, coffre, vue du Chat, saisies répondues
 * d'avance) charge la vraie extension, contre une passerelle jetable et un
 * faux modèle compatible OpenAI : Chat en flux, fichier joint, connexion et
 * séance, un tour de OxoAI Code, déconnexion, adresse refusée. Rien ne touche
 * ~/.oxoai ni LM Studio. Ce que l'essai ne voit pas : l'affichage de la vue
 * dans un vrai VS Code.
 *
 *   npm run essai:vscode -- --modele
 *
 * Avec le modèle de LM Studio (http://127.0.0.1:1234) au lieu du faux : une
 * vraie réponse au Chat, et OxoAI Code qui crée un fichier dans le projet,
 * carte d'accord comprise. Compter quelques minutes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as net } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Module from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const libre = () => new Promise((ok) => { const s = net(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const AVEC_MODELE = process.argv.includes("--modele");

// Faux modèle : répond « Bonjour depuis le faux modèle. » en flux.
const PORT_MODELE = await libre();
const appelsModele = [];
createServer((req, res) => {
  let corps = "";
  req.on("data", (b) => (corps += b));
  req.on("end", () => {
    if (req.url.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: [{ id: "faux-modele", object: "model" }] }));
    }
    if (req.url.endsWith("/chat/completions")) {
      appelsModele.push(JSON.parse(corps || "{}"));
      res.setHeader("Content-Type", "text/event-stream");
      /*
       * « balises-essai » (29/09/2026) : la réflexion laissée dans le texte, balises coupées entre deux morceaux, puis
       * « fermante-essai » : sans balise ouvrante (gabarit qui l'a posée), comme un moteur qui ne sépare pas.
       */
      // La dernière question seulement : l'historique renvoyé à chaque tour porte les précédentes.
      const derniere = String(appelsModele.at(-1)?.messages?.at(-1)?.content ?? "");
      const enLigne = /balises-essai/.test(derniere)
        ? ["<thi", "nk>\nJe réfléchis", " encore.</th", "ink>\n\nBonjour ", "depuis le faux modèle."]
        : /fermante-essai/.test(derniere)
          ? ["Je réfléchis", " encore.\n</think>", "\n\nBonjour ", "depuis le faux modèle."]
          : null;
      if (enLigne) {
        for (const m of enLigne) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "faux-modele", choices: [{ index: 0, delta: { content: m }, finish_reason: null }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      // Deux morceaux de réflexion d'abord, comme Qwen3 (`reasoning_content`) : la vue doit le dire, sans les montrer.
      for (const r of ["Je réfléchis", " encore."]) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "faux-modele", choices: [{ index: 0, delta: { reasoning_content: r }, finish_reason: null }] })}\n\n`);
      const morceaux = ["Bonjour ", "depuis le ", "faux modèle."];
      for (const m of morceaux) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "faux-modele", choices: [{ index: 0, delta: { role: "assistant", content: m }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "faux-modele", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    res.statusCode = 404;
    res.end("{}");
  });
}).listen(PORT_MODELE, "127.0.0.1");

const PORT = await libre();
const BANC = mkdtempSync(join(tmpdir(), "oxoai-essai-vscode-"));
const DONNEES = join(BANC, "donnees"), PROJET = join(BANC, "projet"), ESPACE = join(BANC, "espace");
for (const d of [DONNEES, PROJET, ESPACE, join(BANC, "lume")]) mkdirSync(d, { recursive: true });
const G = `http://127.0.0.1:${PORT}`;
const passerelle = spawn(process.execPath, [join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    ...process.env,
    OXOAI_GATEWAY_PORT: String(PORT), OXOAI_DATA_DIR: DONNEES, OXOAI_CODE_DIR: PROJET, OXOAI_WORKSPACE: ESPACE,
    OXOAI_LUME_DIR: join(BANC, "lume"), OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    ...(AVEC_MODELE ? {} : { OXOAI_LMSTUDIO_URL: `http://127.0.0.1:${PORT_MODELE}/v1` }), OXOAI_CONFIG: join(BANC, "oxoai.config.json"), OXOAI_GATEWAY_HOST: "",
  },
  stdio: ["ignore", "pipe", "pipe"], detached: true,
});
writeFileSync(join(BANC, "oxoai.config.json"), "{}");
let journal = "";
passerelle.stdout.on("data", (b) => (journal += b));
passerelle.stderr.on("data", (b) => (journal += b));
for (let i = 0; i < 80; i++) { try { await fetch(`${G}/health`); break; } catch { await attendre(250); } }
await attendre(1500);

let reussis = 0; const echecs = [];
const verifier = (nom, c, obtenu) => { if (c) { reussis++; console.log(`  ✓ ${nom}`); } else { echecs.push(nom); console.log(`  ✗ ${nom} — obtenu : ${String(obtenu).slice(0, 500)}`); } };

const JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
const MDP = "Essai-VSCode-2026!";
await fetch(`${G}/oxoai/auth/create`, { method: "POST", headers: { Authorization: `Bearer ${JETON}`, "Content-Type": "application/json" }, body: JSON.stringify({ fullName: "Essai VS Code", email: "vscode@example.test", password: MDP }) });

// Faux module vscode.
const messages = { info: [], erreur: [], avert: [] };
const reponsesSaisie = [];
const secrets = new Map();
const commandes = new Map();
const postes = [];
let fournisseur = null;
const reglagesVs = { adresse: G, jeton: "", modele: "" };
const Uri = { joinPath: (...p) => ({ p: p.map(String).join("/") }), file: (f) => ({ p: f }) };
const vscode = {
  Uri,
  workspace: {
    getConfiguration: () => ({ get: (k) => reglagesVs[k] }),
    asRelativePath: () => "exemple.js",
    workspaceFolders: [{ uri: { fsPath: PROJET }, name: "projet" }],
  },
  window: {
    activeTextEditor: null,
    showInformationMessage: (m) => messages.info.push(m),
    showErrorMessage: (m) => messages.erreur.push(m),
    // Une carte d'accord de OxoAI Code : « Autoriser », comme la personne qui clique.
    showWarningMessage: (m) => {
      messages.avert.push(m);
      return Promise.resolve(/^OxoAI Code veut/.test(m) ? "Autoriser" : undefined);
    },
    showQuickPick: async (items) => items[0],
    showInputBox: async () => reponsesSaisie.shift(),
    registerWebviewViewProvider: (_id, f) => { fournisseur = f; return { dispose() {} }; },
  },
  commands: {
    registerCommand: (n, f) => { commandes.set(n, f); return { dispose() {} }; },
    executeCommand: async (n, ...a) => commandes.get(n)?.(...a),
  },
};
const charger = Module._load;
Module._load = function (demande, ...reste) { return demande === "vscode" ? vscode : charger.call(this, demande, ...reste); };
process.env.OXOAI_DATA_DIR = DONNEES; // le jeton du poste, lu seulement pour le port que l'application a ouvert
const extension = Module.createRequire(import.meta.url)(join(RACINE, "extensions", "vscode", "extension.js"));
const contexte = { subscriptions: [], extensionUri: { p: "ext" }, secrets: { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) } };
extension.activate(contexte);

let surMessage = null;
const vue = { webview: { options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u.p, postMessage: (m) => { postes.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { surMessage = f; } } };
fournisseur.resolveWebviewView(vue);
const attendreFin = async (depuis, ms = 120_000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (postes.slice(depuis).some((m) => m.type === "fin" || m.type === "erreur")) return; await attendre(200); }
};

console.log("1. Activation et page");
verifier("commandes enregistrées", ["oxoai.expliquer", "oxoai.ameliorer", "oxoai.nouveau", "oxoai.seConnecter", "oxoai.seDeconnecter"].every((c) => commandes.has(c)), [...commandes.keys()]);
verifier("page avec CSP à nonce et onglets Chat/Code", /script-src 'nonce-/.test(vue.webview.html) && /onglet-code/.test(vue.webview.html), vue.webview.html.slice(0, 200));

console.log("2. Chat (jeton du poste, faux modèle)");
{
  const d = postes.length;
  surMessage({ type: "question", texte: "Dis bonjour", joindre: false });
  await attendreFin(d);
  const suite = postes.slice(d);
  const texte = suite.filter((m) => m.type === "morceau").map((m) => m.texte).join("");
  if (AVEC_MODELE) console.log(`    réponse du modèle : ${JSON.stringify(texte.slice(0, 200))}`);
  if (!AVEC_MODELE) verifier("réflexion du modèle signalée à la vue, jamais affichée comme réponse", suite.some((m) => m.type === "reflexion") && !texte.includes("réfléchis"), JSON.stringify(suite).slice(0, 300));
  verifier("réponse reçue en flux, puis « fin »", (AVEC_MODELE ? texte.trim().length > 0 : texte === "Bonjour depuis le faux modèle.") && suite.at(-1)?.type === "fin", JSON.stringify(suite).slice(0, 400) + " | " + journal.slice(-400));
}
if (!AVEC_MODELE) {
  // Réflexion dans le texte (29/09/2026) : dite à la vue, jamais affichée ni gardée comme réponse, balises comprises.
  for (const [forme, nom] of [["balises-essai", "entre <think> et </think>, balises coupées"], ["fermante-essai", "sans balise ouvrante (</think> seul)"]]) {
    const d = postes.length;
    const avant = [...(fournisseur.historique ?? [])];
    surMessage({ type: "question", texte: `Dis bonjour ${forme}`, joindre: false });
    await attendreFin(d);
    const suite = postes.slice(d);
    let vu = "";
    for (const m of suite) {
      if (m.type === "morceau") vu += m.texte;
      if (m.type === "requalifier") vu = vu.slice(0, Math.max(0, vu.length - m.caracteres));
    }
    const garde = [...(fournisseur.historique ?? [])].slice(avant.length).find((m) => m.role === "assistant")?.content ?? "";
    verifier(
      `réflexion ${nom} : signalée à la vue, retirée de la réponse affichée et de l'historique`,
      // Requalifiée, la vue le dit d'elle-même (« Le modèle réfléchit… ») : le message de requalification vaut signal.
      suite.some((m) => m.type === "reflexion" || m.type === "requalifier") && vu.trim() === "Bonjour depuis le faux modèle." && garde.trim() === "Bonjour depuis le faux modèle." && suite.at(-1)?.type === "fin",
      JSON.stringify({ vu, garde, suite }).slice(0, 500),
    );
  }
}
{
  const d = postes.length;
  surMessage({ type: "question", texte: "Et encore ?", joindre: false });
  await attendreFin(d);
  const dernier = appelsModele.at(-1);
  if (AVEC_MODELE) verifier("second tour : réponse reçue", postes.slice(d).some((m) => m.type === "morceau") && postes.at(-1)?.type === "fin", JSON.stringify(postes.slice(d)).slice(0, 300));
  else verifier("le second tour envoie l'historique (4 messages dont la réponse)", (dernier?.messages ?? []).filter((m) => m.role !== "system").length >= 3, JSON.stringify(dernier?.messages ?? []).slice(0, 300));
}
{
  vscode.window.activeTextEditor = { document: { getText: (sel) => (sel ? "" : "const a = 1;"), languageId: "javascript", uri: {} }, selection: { isEmpty: true } };
  const d = postes.length;
  await commandes.get("oxoai.expliquer")();
  verifier("« Expliquer » sans sélection : le dit", messages.info.some((m) => /Sélectionnez d'abord/.test(m)), messages.info);
  surMessage({ type: "question", texte: "Relis ce fichier", joindre: true });
  await attendreFin(d);
  const envoye = JSON.stringify(appelsModele.at(-1)?.messages ?? []);
  const lu = postes.slice(d).filter((m) => m.type === "morceau").map((m) => m.texte).join("");
  if (AVEC_MODELE) console.log(`    sur le fichier joint : ${JSON.stringify(lu.slice(0, 200))}`);
  if (AVEC_MODELE) verifier("fichier ouvert joint : le modèle en parle", /const|a\s*=\s*1|variable|constante/i.test(lu), lu.slice(0, 300));
  else verifier("fichier ouvert joint à la question", /exemple\.js/.test(envoye) && /const a = 1;/.test(envoye), envoye.slice(0, 300));
  vscode.window.activeTextEditor = null;
}

console.log("3. Connexion (compte, mot de passe, séance dans le coffre)");
{
  reponsesSaisie.push("mauvais-mot-de-passe");
  await commandes.get("oxoai.seConnecter")();
  verifier("mauvais mot de passe : refusé, rien dans le coffre", messages.erreur.length > 0 && secrets.size === 0, JSON.stringify([messages.erreur, [...secrets.keys()]]));
  reponsesSaisie.push(MDP);
  await commandes.get("oxoai.seConnecter")();
  const cle = `oxoai.seance:${G}`;
  verifier("bon mot de passe : séance gardée pour cette adresse", secrets.has(cle) && messages.info.some((m) => /Connecté à OxoAI/.test(m)), JSON.stringify([...secrets.keys(), messages.info]));
  const r = await fetch(`${G}/oxoai/auth/sessions`, { headers: { Authorization: `Bearer ${JETON}`, "X-OxoAI-Session": secrets.get(cle) } });
  const corps = await r.json().catch(() => ({}));
  verifier("la séance est valide et dite « VS Code »", r.ok && JSON.stringify(corps).includes("VS Code"), `${r.status} ${JSON.stringify(corps).slice(0, 300)}`);
}

console.log("4. Code (OxoAI Code sur le dossier ouvert)");
{
  const d = postes.length;
  surMessage({ type: "code", texte: AVEC_MODELE ? "Crée le fichier bonjour.txt contenant exactement le mot bonjour. Rien d'autre." : "Réponds juste bonjour, sans toucher aux fichiers." });
  await attendreFin(d, AVEC_MODELE ? 600_000 : 180_000);
  const suite = postes.slice(d);
  const erreur = suite.find((m) => m.type === "erreur");
  verifier("un tour de Code se termine (texte rendu, « fin »)", !erreur && suite.at(-1)?.type === "fin" && suite.some((m) => m.type === "code"), JSON.stringify(suite).slice(0, 600));
  if (AVEC_MODELE) {
    const { existsSync } = await import("node:fs");
    const f = join(PROJET, "bonjour.txt");
    console.log(`    actions : ${JSON.stringify(suite.filter((m) => m.outil).map((m) => m.outil))} ; cartes : ${JSON.stringify(messages.avert)}`);
    verifier("OxoAI Code a créé bonjour.txt dans le dossier ouvert", existsSync(f) && /bonjour/i.test(readFileSync(f, "utf8")), existsSync(f) ? readFileSync(f, "utf8") : "absent");
  }
}

console.log("5. Déconnexion");
{
  await commandes.get("oxoai.seDeconnecter")();
  verifier("séance retirée du coffre", secrets.size === 0, [...secrets.keys()]);
  const d = postes.length;
  surMessage({ type: "code", texte: "écris un fichier" });
  await attendreFin(d, 30_000);
  const e = postes.slice(d).find((m) => m.type === "erreur");
  verifier("Code sans séance : demande de se connecter", e && /connect/i.test(e.texte), JSON.stringify(postes.slice(d)));
}

console.log("6. Adresse refusée");
{
  reglagesVs.adresse = "http://exemple.com:8787";
  const d = postes.length;
  surMessage({ type: "question", texte: "bonjour", joindre: false });
  await attendreFin(d, 10_000);
  const e = postes.slice(d).find((m) => m.type === "erreur");
  verifier("http hors de la boucle locale : refusé, jeton pas envoyé", e && /https/.test(e.texte), JSON.stringify(postes.slice(d)));
}

console.log(`\n${reussis} réussis, ${echecs.length} échoués.`);
try { process.kill(-passerelle.pid, "SIGTERM"); } catch {}
process.exit(echecs.length ? 1 : 0);
