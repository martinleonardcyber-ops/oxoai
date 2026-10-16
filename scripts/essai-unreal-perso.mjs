/*
 * Blender muet, Unreal Editor et serveurs MCP ajoutés par l'administrateur,
 * essayés de bout en bout (16/10/2026).
 *
 *   npm run essai:unreal-perso      (repris par npm run securite, section 47)
 *
 * Trois demandes de Medhi du 16/10/2026 :
 *  1. Blender (bogue vu dans le Chat : « bouge le cube sur blender », trois
 *     `get_addon_status` d'une minute chacun) : un module dont le port est
 *     ouvert mais qui ne répond pas doit échouer vite, avec un message qui
 *     dit quoi faire ; « il a pu être exécuté » ne se dit que d'une écriture ;
 *     le même appel n'est pas relancé trois fois dans une réponse.
 *  2. Unreal Editor par son serveur MCP officiel (en HTTP sur la boucle) :
 *     reconnu avant chaque requête, lectures libres, `call_tool` sur carte,
 *     appels un par un.
 *  3. « Créer son propre MCP » : un serveur ajouté par l'administrateur, sans
 *     interpréteur de commandes ni code en ligne, écriture par défaut, sans
 *     les variables de la passerelle, retiré proprement.
 *
 * Rien de réel n'est touché : faux serveur de Blender (stdio) et faux module
 * sur un port libre, faux Unreal Editor (HTTP « streamable », servi par ce
 * processus Node, reconnu par HELIX_ESSAI_UNREAL_EXECUTABLE), faux serveur
 * ajouté (un script Node), faux modèle qui joue un plan d'appels.
 *
 *  A. Règles, dans ce processus : classement d'Unreal, jugement des commandes,
 *     adresses et variables d'un serveur ajouté, sonde de Blender.
 *  B. La passerelle : Blender muet, délai dépassé (lecture, écriture),
 *     garde de répétition ; Unreal ; serveur ajouté.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as serveurHttp } from "node:http";
import { createServer as serveurTcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

let reussis = 0;
const echecs = [];
function verifier(nom, condition, obtenu) {
  if (condition) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${String(typeof obtenu === "string" ? obtenu : JSON.stringify(obtenu)).slice(0, 600)}`);
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
const importer = (...p) => import(pathToFileURL(join(RACINE, ...p)).href);
const AUX = mkdtempSync(join(tmpdir(), "helix-essai-unreal-perso-"));
mkdirSync(join(AUX, "espace-a"), { recursive: true });
writeFileSync(join(AUX, "profil-a.json"), JSON.stringify({ chiffrement: "fichier" }));
Object.assign(process.env, { HELIX_DATA_DIR: join(AUX, "donnees-a"), HELIX_WORKSPACE: join(AUX, "espace-a"), HELIX_CONFIG: join(AUX, "profil-a.json") });
const NODE = realpathSync(process.execPath);

/* ------------------------------------------------------------------------- */
/* A. Les règles                                                              */
/* ------------------------------------------------------------------------- */

console.log("\nA. Règles : Unreal Editor, serveurs ajoutés, sonde de Blender");
try {
  const { modifie, demandeToujours, resumerOutil } = await importer("gateway", "src", "approbation.ts");
  const ru = await importer("gateway", "src", "unrealRegles.ts");
  const u = await importer("gateway", "src", "unreal.ts");
  verifier(
    "Unreal : list_toolsets et describe_toolset sont des lectures sans carte ; call_tool, un outil annoncé sous son nom (Tool Search éteint) et un outil inconnu passent par la carte à tout niveau",
    ["list_toolsets", "describe_toolset"].every((n) => !modifie(`unreal__${n}`) && !demandeToujours(`unreal__${n}`)) && ["call_tool", "spawn_actor", "nouvel_outil"].every((n) => modifie(`unreal__${n}`) && demandeToujours(`unreal__${n}`)) && !ru.estEcritureUnreal("unrealx__call_tool"),
    "classement",
  );
  verifier(
    "Unreal : la carte de call_tool nomme l'outil et le jeu appelés, et dit ce que l'éditeur peut faire",
    /outil « spawn_actor » du jeu « ActorTools »/.test(resumerOutil("unreal__call_tool", { toolset: "ActorTools", tool: "spawn_actor", arguments: {} })) && /créer, modifier, exécuter ou lancer des tests/.test(resumerOutil("unreal__call_tool", {})),
    resumerOutil("unreal__call_tool", { toolset: "ActorTools", tool: "spawn_actor" }),
  );
  verifier(
    "Unreal : l'exécutable reconnu est celui de l'éditeur (UnrealEditor.app/Contents/MacOS/UnrealEditor, UnrealEditor.exe, UnrealEditor) ; un autre nom est refusé",
    u.estExecutableUnreal("/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor", "darwin") && u.estExecutableUnreal("C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe", "win32") && u.estExecutableUnreal("/opt/UE/Engine/Binaries/Linux/UnrealEditor", "linux") &&
      !u.estExecutableUnreal("/usr/bin/python3", "darwin") && !u.estExecutableUnreal("C:\\x\\UnrealEditor-Cmd.exe", "win32") && !u.estExecutableUnreal("/tmp/UnrealEditor.app/Contents/MacOS/../MacOS/UnrealEditor", "darwin") && !u.estExecutableUnreal("/opt/x/UnrealEditorX", "linux"),
    "estExecutableUnreal",
  );
  verifier(
    "Unreal sous Windows : signature Authenticode valide au nom d'Epic Games, ou absente (éditeur compilé depuis les sources) ; invalide ou d'un autre éditeur, refusée",
    u.signatureWindowsAcceptee({ statut: "Valid", sujet: "CN=\"Epic Games Inc.\", O=\"Epic Games Inc.\"" }) && u.signatureWindowsAcceptee({ statut: "NotSigned", sujet: "" }) && !u.signatureWindowsAcceptee({ statut: "HashMismatch", sujet: "CN=Epic Games Inc." }) && !u.signatureWindowsAcceptee({ statut: "Valid", sujet: "CN=Autre Editeur" }) && !u.signatureWindowsAcceptee(undefined),
    "signatureWindowsAcceptee",
  );
  const { dansLaLangue } = await importer("gateway", "src", "langue.ts");
  const conseil = (r, n) => dansLaLangue("fr", () => u.conseilUnreal(r, n)) ?? "";
  verifier(
    "Unreal : sans jeu d'outils (liste vide, ou aucun outil), le branchement dit d'activer « All Toolsets » ; une liste de jeux, rien",
    /All Toolsets/.test(conseil({ ok: true, content: "[]" }, 3)) && /All Toolsets/.test(conseil({ ok: true, content: '{"toolsets": []}' }, 3)) && /All Toolsets/.test(conseil(null, 0)) && conseil({ ok: true, content: '[{"name":"ActorTools"}]' }, 3) === "",
    conseil({ ok: true, content: "[]" }, 3),
  );

  const r = await importer("gateway", "src", "mcpPersoRegles.ts");
  const SCRIPT_SH = join(AUX, "lancer.sh");
  writeFileSync(SCRIPT_SH, "#!/bin/sh\necho\n");
  const refusees = [
    ["/bin/sh", ["-c", "touch /tmp/x"]],
    ["bash", ["-c", "id"]],
    ["zsh", []],
    ["/bin/bash", ["serveur.sh"]],
    ["cmd.exe", ["/c", "dir"]],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-Command", "x"]],
    ["pwsh", ["-c", "x"]],
    ["env", ["node", "x.js"]],
    ["sudo", ["node", "x.js"]],
    [NODE, ["-e", "require('fs')"]],
    [NODE, ["--eval=1"]],
    ["python3", ["-c", "print(1)"]],
    ["npx", ["-c", "rm -rf ~"]],
    [SCRIPT_SH, []],
    ["serveur.bat", []],
    ["relatif/serveur", []],
    ["/chemin/qui/n/existe/pas", []],
    ["", []],
    [NODE, ["a\0b"]],
  ];
  const mal = refusees.filter(([c, a]) => r.jugerCommande(c, a).ok);
  verifier(`serveur ajouté : ${refusees.length} commandes refusées (interpréteurs de commandes, code en ligne, scripts .sh/.bat, chemin relatif ou absent, argument illisible)`, mal.length === 0, mal);
  const acceptees = [
    [NODE, [join(RACINE, "scripts", "mcp-essai.mjs")]],
    ["node", ["serveur.js", "--port", "3000"]],
    ["npx", ["-y", "@exemple/serveur-mcp@1.2.3"]],
  ];
  const jugees = acceptees.map(([c, a]) => r.jugerCommande(c, a));
  verifier(
    "serveur ajouté : un programme et son fichier (node serveur.js), un nom cherché dans le PATH (chemin complet enregistré), npx : acceptés",
    jugees.every((j) => j.ok) && jugees[0].command === NODE && jugees[1].command.startsWith("/") && jugees[1].command.endsWith("node") && jugees[2].command === "npx",
    jugees,
  );
  const adresses = {
    "https://mcp.exemple.org/mcp": true,
    "http://127.0.0.1:4567/mcp": true,
    "http://localhost:4567/mcp": true,
    "http://mcp.exemple.org/mcp": false,
    "http://10.0.0.5:80/mcp": false,
    "https://127.0.0.1/mcp": false,
    "http://127.0.0.1/mcp": false,
    "http://127.0.0.1:8787/mcp": false,
    "http://127.0.0.1:1234/v1": false,
    "http://127.0.0.1:18789/": false,
    "https://jean:secret@mcp.exemple.org/": false,
    "ftp://exemple.org/": false,
    "pas une adresse": false,
  };
  const malA = Object.entries(adresses).filter(([a, attendu]) => r.jugerAdresse(a, 8787).ok !== attendu);
  verifier(
    "serveur ajouté : https, ou la boucle locale en http avec un port qui n'est pas l'un de l'instance (passerelle, LM Studio, OpenClaw) ; ni identifiants dans l'adresse, ni http ailleurs ; localhost ramené à 127.0.0.1",
    malA.length === 0 && r.jugerAdresse("http://localhost:4567/mcp", 8787).url === "http://127.0.0.1:4567/mcp",
    malA,
  );
  verifier(
    "serveur ajouté : variables de l'administrateur acceptées (nom de variable, 32 au plus), jamais une variable HELIX_ de l'instance",
    r.jugerVariables({ CLE_API: "abc", Autre_1: "x" }).ok && !r.jugerVariables({ HELIX_DATA_DIR: "/tmp" }).ok && !r.jugerVariables({ "A-B": "x" }).ok && !r.jugerVariables(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${i}`, "x"]))).ok,
    "jugerVariables",
  );
  verifier("serveur ajouté : un outil d'un serveur inconnu est une écriture par défaut (carte d'accord)", modifie("monserveur__lire") && modifie("monserveur__get_data"), "modifie");

  // La sonde de Blender, contre un module muet, un module qui répond, un port fermé.
  const b = await importer("gateway", "src", "blender.ts");
  const p = await portLibre();
  const muet = serveurTcp((c) => c.on("error", () => undefined)).listen(p, "127.0.0.1");
  await attendre(100);
  let t0 = Date.now();
  const sondeMuette = await b.sondeBlender(p, 1500);
  const dureeMuette = Date.now() - t0;
  muet.close();
  const p2 = await portLibre();
  const vivant = serveurTcp((c) => c.on("data", () => c.write('{"status":"error","message":"Unknown command type: ping"}'))).listen(p2, "127.0.0.1");
  await attendre(100);
  t0 = Date.now();
  const sondeVivante = await b.sondeBlender(p2, 1500);
  const dureeVivante = Date.now() - t0;
  vivant.close();
  const ferme = await b.sondeBlender(await portLibre(), 1500);
  verifier(
    `sonde de Blender : un module muet est dit en ${dureeMuette} ms (délai de la sonde : 1,5 s), un module qui répond, même par une erreur (ancienne version), en ${dureeVivante} ms ; port fermé : non`,
    sondeMuette === false && dureeMuette < 2500 && sondeVivante === true && dureeVivante < 1000 && ferme === false,
    { sondeMuette, dureeMuette, sondeVivante, dureeVivante, ferme },
  );
} catch (err) {
  verifier("partie A sans exception", false, err?.stack ?? String(err));
}

/* ------------------------------------------------------------------------- */
/* Les faux                                                                   */
/* ------------------------------------------------------------------------- */

/** Un faux serveur MCP stdio, en Node : il note chaque appel et son environnement. */
function fauxStdio(nom, outils, journal, corpsAppel) {
  const fichier = join(AUX, `faux-${nom}.mjs`);
  writeFileSync(
    fichier,
    `#!${NODE}
import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
const OUTILS = ${JSON.stringify(outils)};
const noter = (o) => appendFileSync(${JSON.stringify(journal)}, JSON.stringify(o) + "\\n");
noter({ demarre: true, pid: process.pid, cles: Object.keys(process.env), cle: process.env.CLE_ESSAI ?? null, cwd: process.cwd() });
const envoyer = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const versModule = (commande) => new Promise((ok) => {
  const s = connect(Number(process.env.BLENDER_PORT), process.env.BLENDER_HOST, () => s.write(JSON.stringify(commande)));
  let recu = "";
  s.on("data", (b) => { recu += b; try { const r = JSON.parse(recu); s.end(); ok(JSON.stringify(r.result ?? r)); } catch {} });
  s.on("error", (e) => ok("ERREUR " + e.message));
});
createInterface({ input: process.stdin }).on("line", async (ligne) => {
  let m; try { m = JSON.parse(ligne); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") return envoyer({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(nom)}, version: "1.0.0" } } });
  if (m.method === "tools/list") return envoyer({ jsonrpc: "2.0", id: m.id, result: { tools: OUTILS.map((name) => ({ name, description: "Outil " + name + " (faux).", inputSchema: { type: "object", properties: { code: { type: "string" }, texte: { type: "string" } } } })) } });
  if (m.method === "tools/call") {
    const n = m.params?.name, a = m.params?.arguments ?? {};
    noter({ appel: n, args: a });
    ${corpsAppel}
  }
  envoyer({ jsonrpc: "2.0", id: m.id, result: {} });
});
`,
  );
  chmodSync(fichier, 0o755);
  return fichier;
}
const lireJournal = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const appelsDe = (f) => lireJournal(f).filter((e) => e.appel).map((e) => e.appel);

const LECTURES_BLENDER = ["get_addon_status", "get_scene_info", "look"];
const ECRITURES_BLENDER = ["execute_blender_code"];
const JOURNAL_BLENDER = join(AUX, "journal-blender.jsonl");
const FAUX_BLENDER = fauxStdio(
  "blender",
  [...LECTURES_BLENDER, ...ECRITURES_BLENDER],
  JOURNAL_BLENDER,
  `return envoyer({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "REPERE-BLENDER " + n + " " + (await versModule({ type: n, params: a })) }] } });`,
);
const JOURNAL_PERSO = join(AUX, "journal-perso.jsonl");
const FAUX_PERSO = fauxStdio(
  "perso",
  ["lire_note", "ecrire_note", "echoue", "env"],
  JOURNAL_PERSO,
  `if (n === "echoue") return envoyer({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "panne simulée du service interne" }] } });
    if (n === "env") return envoyer({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "CLES " + Object.keys(process.env).join(",") }] } });
    return envoyer({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "REPERE-PERSO " + n + " " + JSON.stringify(a) }] } });`,
);

/** Le faux module de Blender : « normal » (répond à tout), « muet » (port ouvert, rien), « ping » (ne répond qu'au signal de vie). */
const module = { mode: "normal", recu: [] };
const serveurModule = serveurTcp((c) => {
  let recu = "";
  c.on("data", (b) => {
    recu += b;
    try {
      const commande = JSON.parse(recu);
      recu = "";
      module.recu.push({ type: commande.type, mode: module.mode });
      if (module.mode === "muet") return;
      if (module.mode === "ping" && commande.type !== "ping") return;
      c.write(JSON.stringify({ status: "success", result: commande.type === "ping" ? { pong: true } : { scene: "Cube, Camera, Light", commande: commande.type } }));
    } catch {
      /* commande incomplète */
    }
  });
  c.on("error", () => undefined);
});
const PORT_BLENDER = await portLibre();
await new Promise((ok) => serveurModule.listen(PORT_BLENDER, "127.0.0.1", ok));

/** Le faux Unreal Editor : MCP en HTTP « streamable » (réponses JSON), servi par ce processus Node. */
const unreal = { appels: [], enCours: 0, max: 0, toolsetsVides: true, requetes: 0 };
const OUTILS_UNREAL = ["list_toolsets", "describe_toolset", "call_tool"];
const serveurUnreal = serveurHttp(async (req, res) => {
  unreal.requetes++;
  if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
    res.writeHead(405).end();
    return;
  }
  const morceaux = [];
  for await (const m of req) morceaux.push(m);
  let m = {};
  try {
    m = JSON.parse(Buffer.concat(morceaux).toString("utf8"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (m.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const repondre = (result) => {
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "session-essai" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  };
  if (m.method === "initialize") return repondre({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Unreal MCP (faux)", version: "5.8" } });
  if (m.method === "tools/list") return repondre({ tools: OUTILS_UNREAL.map((name) => ({ name, description: `Outil ${name} (faux).`, inputSchema: { type: "object", properties: { toolset: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" } } } })) });
  if (m.method === "tools/call") {
    const n = m.params?.name;
    unreal.appels.push({ nom: n, args: m.params?.arguments ?? {} });
    unreal.enCours++;
    unreal.max = Math.max(unreal.max, unreal.enCours);
    await attendre(n === "call_tool" ? 400 : 20);
    unreal.enCours--;
    const texte = n === "list_toolsets" ? (unreal.toolsetsVides ? "[]" : '[{"name":"ActorTools","description":"Acteurs"}]') : `REPERE-UNREAL ${n} ${JSON.stringify(m.params?.arguments ?? {})}`;
    return repondre({ content: [{ type: "text", text: texte }] });
  }
  repondre({});
});
const PORT_UNREAL = await portLibre();
await new Promise((ok) => serveurUnreal.listen(PORT_UNREAL, "127.0.0.1", ok));

/** Un autre programme sur un port : `nc`, qui note tout ce qu'il reçoit. */
async function autreProgramme(port) {
  const p = spawn("/usr/bin/nc", ["-l", "127.0.0.1", String(port)], { stdio: ["ignore", "pipe", "ignore"] });
  const etat = { processus: p, recu: "" };
  p.stdout.on("data", (b) => (etat.recu += b));
  for (let i = 0; i < 40; i++) {
    try {
      if (execFileSync("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim()) break;
    } catch {
      /* pas encore à l'écoute */
    }
    await attendre(100);
  }
  return etat;
}

/* Le faux modèle : il joue le plan écrit dans la question, appel par appel. */
const json = (res, statut, corps) => {
  res.writeHead(statut, { "Content-Type": "application/json" });
  res.end(JSON.stringify(corps));
};
const texteDe = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? "").join(" ") : "");
function decision(demande) {
  const messages = Array.isArray(demande.messages) ? demande.messages : [];
  const question = texteDe([...messages].reverse().find((m) => m.role === "user"));
  const resultats = messages.filter((m) => m.role === "tool").map(texteDe);
  const noms = (demande.tools ?? []).map((o) => o.function?.name);
  const plan = /PLAN:(\[.*\])/s.exec(question);
  if (!plan) return { content: "Réponse sans outil." };
  const appels = JSON.parse(plan[1]);
  if (resultats.length < appels.length) {
    const [nom, args] = appels[resultats.length];
    if (!noms.includes(nom)) return { content: `OUTIL-ABSENT ${nom}` };
    return { tool_calls: [{ index: 0, id: `appel-${resultats.length}`, type: "function", function: { name: nom, arguments: JSON.stringify(args) } }] };
  }
  return { content: `FIN ${resultats.join(" || ")}` };
}
const fauxModele = serveurHttp(async (req, res) => {
  const morceaux = [];
  for await (const m of req) morceaux.push(m);
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "essai-outils", object: "model" }] });
  if (url.pathname !== "/v1/chat/completions") return json(res, 404, {});
  const demande = JSON.parse(Buffer.concat(morceaux).toString("utf8") || "{}");
  const delta = { role: "assistant", ...decision(demande) };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const morceau = (o) => res.write(`data: ${JSON.stringify({ id: "essai", object: "chat.completion.chunk", created: 1, model: demande.model, ...o })}\n\n`);
  morceau({ choices: [{ index: 0, delta }] });
  morceau({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] });
  morceau({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.end("data: [DONE]\n\n");
});
const PORT_MODELE = await portLibre();
await new Promise((ok) => fauxModele.listen(PORT_MODELE, "127.0.0.1", ok));

/* ------------------------------------------------------------------------- */
/* B. La passerelle d'essai                                                   */
/* ------------------------------------------------------------------------- */

const ESPACE = join(AUX, "espace");
mkdirSync(ESPACE, { recursive: true });
const DONNEES = join(AUX, "donnees");
const PROFIL = join(AUX, "profil.json");
writeFileSync(PROFIL, JSON.stringify({ chiffrement: "fichier", backends: [{ id: "lmstudio", enabled: false }, { id: "exo", enabled: false }, { id: "essai", label: "Essai", baseUrl: `http://127.0.0.1:${PORT_MODELE}/v1` }] }));
const PORT_PASSERELLE = await portLibre();
const passerelle = { G: `http://127.0.0.1:${PORT_PASSERELLE}`, journal: "" };
passerelle.processus = spawn(process.execPath, [join(RACINE, "gateway", "src", "index.ts")], {
  env: {
    ...process.env,
    HELIX_CONFIG: PROFIL,
    HELIX_GATEWAY_PORT: String(PORT_PASSERELLE),
    HELIX_DATA_DIR: DONNEES,
    HELIX_WORKSPACE: ESPACE,
    HELIX_CODE_DIR: ESPACE,
    HELIX_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
    HELIX_EXO_URL: "http://127.0.0.1:9/v1",
    HELIX_GATEWAY_HOST: "127.0.0.1",
    HELIX_ESSAI_BLENDER_SERVEUR: FAUX_BLENDER,
    HELIX_ESSAI_BLENDER_PORT: String(PORT_BLENDER),
    HELIX_ESSAI_BLENDER_EXECUTABLE: NODE,
    HELIX_ESSAI_BLENDER_SONDE_MS: "1500",
    HELIX_ESSAI_UNREAL_PORT: String(PORT_UNREAL),
    HELIX_ESSAI_UNREAL_EXECUTABLE: NODE,
    // Le délai d'un appel sans nouvelles, ramené de 60 s à 3 s pour l'essai (mcp.ts, DELAI_APPEL_MS).
    HELIX_MCP_DELAI_MS: "3000",
    // Une variable de la passerelle que le serveur ajouté ne doit pas recevoir.
    HELIX_ESSAI_FUITE: "VALEUR-DE-LA-PASSERELLE",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
passerelle.processus.stdout.on("data", (b) => (passerelle.journal += b));
passerelle.processus.stderr.on("data", (b) => (passerelle.journal += b));
for (let i = 0; i < 160; i++) {
  try {
    await fetch(`${passerelle.G}/health`);
    break;
  } catch {
    await attendre(250);
  }
}
const jeton = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
passerelle.J = { "Content-Type": "application/json", Authorization: `Bearer ${jeton}`, "X-Helix-Langue": "fr" };

const api = async (chemin, corps, entetes = passerelle.A) => {
  const r = await fetch(`${passerelle.G}${chemin}`, corps === undefined ? { headers: entetes } : { method: "POST", headers: entetes, body: JSON.stringify(corps) });
  return { statut: r.status, ...(await r.json().catch(() => ({}))) };
};
async function chat(plan, accorder = () => true, entetes = passerelle.A) {
  const debut = Date.now();
  const enCours = fetch(`${passerelle.G}/v1/chat/completions`, {
    method: "POST",
    headers: entetes,
    body: JSON.stringify({ model: "essai-outils", stream: true, tools: true, effort: "aucun", messages: [{ role: "user", content: `PLAN:${JSON.stringify(plan)}` }] }),
  }).then((r) => r.text());
  let fini = false;
  enCours.finally(() => (fini = true));
  const cartes = [];
  while (!fini) {
    const e = await api("/helix/approbation", undefined, entetes);
    for (const c of e.enAttente ?? []) {
      if (cartes.some((x) => x.id === c.id)) continue;
      cartes.push(c);
      await api("/helix/approbation/repondre", { id: c.id, accord: accorder(c) }, entetes);
    }
    await attendre(120);
  }
  const evenements = [];
  let texte = "";
  for (const ligne of (await enCours).split("\n")) {
    if (!ligne.startsWith("data: ") || ligne === "data: [DONE]") continue;
    try {
      const j = JSON.parse(ligne.slice(6));
      if (j.helix) evenements.push(j.helix);
      const d = j.choices?.[0]?.delta?.content;
      if (typeof d === "string") texte += d;
    } catch {
      /* ligne partielle */
    }
  }
  return { texte, fins: evenements.filter((e) => e.type === "tool_end"), cartes, duree: Date.now() - debut };
}

console.log("\nB. La passerelle : Blender muet, délai dépassé, répétitions ; Unreal Editor ; serveur ajouté par l'administrateur");
try {
  const cree = await api("/helix/auth/create", { fullName: "Alice Essai", email: "alice@example.test", password: "Mot2PasseSolide!42" }, passerelle.J);
  passerelle.A = { ...passerelle.J, "X-Helix-Session": cree.session?.token };
  const coll = await api("/helix/auth/create", { fullName: "Collègue", email: "collegue@example.test", password: "Provisoire2Collegue!7" });
  const connexion = await api("/helix/auth/mot-de-passe-provisoire", { accountId: coll.account?.id, password: "Provisoire2Collegue!7", nouveau: "Collegue2PasseSolide!9" }, passerelle.J);
  const B = { ...passerelle.J, "X-Helix-Session": connexion.session?.token };
  verifier("la passerelle d'essai démarre ; une administratrice et un collègue", Boolean(cree.session?.token && connexion.session?.token), passerelle.journal.slice(-1500));

  /* ---- 1. Blender ---- */
  const brancheB = await api("/helix/connecteurs/connecter", { id: "blender" });
  verifier("Blender (module qui répond) : branché", brancheB.statut === 200 && brancheB.pret, brancheB.message);

  module.mode = "muet";
  const avantMuet = module.recu.length;
  const brancheMuet = await api("/helix/connecteurs/connecter", { id: "blender" });
  verifier("module muet : « Réessayer » refuse en le disant (le module ne répond pas, quoi faire dans Blender), sans lancer le serveur", brancheMuet.statut === 400 && /pas même au simple signal de vie/.test(brancheMuet.message) && /Connect to MCP server/.test(brancheMuet.message), brancheMuet.message);
  // Le serveur arrêté par le « Réessayer » manqué est relancé quand le module répond, puis le module se tait.
  module.mode = "normal";
  await api("/helix/connecteurs/connecter", { id: "blender" });
  module.mode = "muet";
  const muet = await chat([["blender__get_addon_status", {}], ["blender__get_addon_status", { user_prompt: "bouge le cube" }], ["blender__get_scene_info", {}]]);
  const commandesMuet = module.recu.slice(avantMuet).filter((c) => c.mode === "muet" && c.type !== "ping");
  verifier(
    `le bogue du 16/10 rejoué (module muet, trois appels) : ${Math.round(muet.duree / 100) / 10} s en tout au lieu de trois minutes ; le premier dit que le module ne répond pas et quoi faire, les deux suivants ne partent pas (déjà constaté) ; aucune commande n'arrive au module`,
    muet.duree < 12_000 && muet.fins.length === 3 && muet.fins.every((f) => f.ok === false) && /pas même au simple signal de vie/.test(muet.fins[0].preview) && /déjà constaté/.test(muet.fins[1].preview) && /déjà constaté/.test(muet.fins[2].preview) && commandesMuet.length === 0,
    { duree: muet.duree, fins: muet.fins.map((f) => f.preview.slice(0, 160)), commandesMuet },
  );

  module.mode = "ping";
  const demarresAvant = lireJournal(JOURNAL_BLENDER).filter((e) => e.demarre).length;
  const lecture = await chat([["blender__get_scene_info", {}]]);
  verifier(
    "délai dépassé sur une lecture (module qui répond au signal de vie, pas à la commande) : abandonné, et dit « c'était une lecture : rien n'a été modifié », pas « il a pu être exécuté »",
    lecture.fins[0]?.ok === false && /pas répondu à temps/.test(lecture.fins[0].preview) && /C'était une lecture : rien n'a été modifié/.test(lecture.fins[0].preview) && !/a pu être exécuté/.test(lecture.fins[0].preview),
    lecture.fins[0]?.preview,
  );
  const ecriture = await chat([["blender__execute_blender_code", { code: "import bpy  # REPERE" }]]);
  verifier(
    "délai dépassé sur une écriture (carte acceptée) : « il a pu être exécuté quand même : vérifie avant de le refaire »",
    ecriture.cartes.length === 1 && ecriture.fins[0]?.ok === false && /a pu être exécuté quand même/.test(ecriture.fins[0].preview),
    ecriture.fins[0]?.preview,
  );
  verifier(
    "après un délai dépassé, le serveur de Blender, bloqué sur la commande sans réponse, est arrêté et un neuf est lancé à l'appel suivant",
    lireJournal(JOURNAL_BLENDER).filter((e) => e.demarre).length >= demarresAvant + 1,
    lireJournal(JOURNAL_BLENDER).filter((e) => e.demarre).length - demarresAvant,
  );
  module.mode = "normal";
  const repris = await chat([["blender__get_scene_info", {}]]);
  verifier("le module répond de nouveau : la lecture passe, dans une nouvelle réponse", repris.fins[0]?.ok === true && /Cube, Camera, Light/.test(repris.texte), repris.fins[0]?.preview);

  /* ---- 2. Unreal Editor ---- */
  const etat0 = await api("/helix/connecteurs");
  const fiche = (etat0.catalogue ?? []).find((e) => e.id === "unreal");
  verifier("la fiche « Unreal Engine » (Développement) : sur la boucle locale, port et chemin du serveur de l'éditeur, sans commande ni secret", fiche && fiche.local?.port === 8000 && fiche.local?.chemin === "/mcp" && fiche.categorie === "Développement" && !fiche.command && fiche.secrets.length === 0, fiche);
  // Le faux éditeur est fermé le temps de cet essai : un autre programme prend son port.
  await new Promise((ok) => serveurUnreal.close(ok));
  const autre = await autreProgramme(PORT_UNREAL);
  const refusAutre = await api("/helix/connecteurs/connecter", { id: "unreal" });
  await attendre(300);
  verifier("un autre programme sur le port de l'éditeur : refus « ce n'est pas Unreal Editor », il ne reçoit rien", refusAutre.statut === 400 && /Un autre programme occupe le port du serveur MCP d'Unreal Editor/.test(refusAutre.message) && autre.recu === "", `${refusAutre.message} | reçu : ${JSON.stringify(autre.recu.slice(0, 200))}`);
  autre.processus.kill("SIGKILL");
  await attendre(300);
  const ferme = await api("/helix/connecteurs/connecter", { id: "unreal" });
  verifier("éditeur fermé : refus clair, avec la marche à suivre (plugins « Unreal MCP » et « All Toolsets », Auto Start Server)", ferme.statut === 400 && /Unreal Editor ne répond pas/.test(ferme.message) && /All Toolsets/.test(ferme.message) && /Auto Start Server/.test(ferme.message), ferme.message);
  await new Promise((ok) => serveurUnreal.listen(PORT_UNREAL, "127.0.0.1", ok));
  const brancheU = await api("/helix/connecteurs/connecter", { id: "unreal" });
  const instU = (brancheU.etat?.installes ?? []).find((c) => c.id === "unreal");
  verifier("Unreal Editor reconnu : branché, trois outils ; sans jeu d'outils, le message dit d'activer « All Toolsets »", brancheU.statut === 200 && brancheU.pret && instU?.running && instU.toolCount === 3 && /All Toolsets/.test(brancheU.message), `${brancheU.message} ${JSON.stringify(instU)}`);
  unreal.toolsetsVides = false;
  const liste = await chat([["unreal__list_toolsets", {}], ["unreal__describe_toolset", { toolset: "ActorTools" }]]);
  verifier("lister et décrire les jeux d'outils : sans carte", liste.cartes.length === 0 && liste.fins.every((f) => f.ok) && /ActorTools/.test(liste.texte), `${JSON.stringify(liste.cartes)} ${liste.texte.slice(0, 200)}`);
  const avantCall = unreal.appels.length;
  const nonU = await chat([["unreal__call_tool", { toolset: "ActorTools", tool: "spawn_actor", arguments: { classe: "StaticMeshActor" } }]], () => false);
  verifier("call_tool : une carte qui nomme l'outil et le jeu ; refusée, rien n'arrive à l'éditeur", nonU.cartes.length === 1 && /spawn_actor/.test(nonU.cartes[0].resume) && nonU.fins[0]?.ok === false && unreal.appels.length === avantCall, `${JSON.stringify(nonU.cartes.map((c) => c.resume))}`);
  const parB = await chat([["unreal__list_toolsets", {}], ["unreal__call_tool", { toolset: "ActorTools", tool: "spawn_actor" }]], () => true, B);
  verifier("collègue non administrateur : il liste, mais call_tool est refusé avant toute carte", parB.fins[0]?.ok && parB.fins[1]?.ok === false && /réservé à l'administrateur/.test(parB.fins[1].preview) && parB.cartes.length === 0, `${JSON.stringify(parB.fins)} ${parB.cartes.length}`);
  unreal.max = 0;
  const [c1, c2] = await Promise.all([
    chat([["unreal__call_tool", { toolset: "ActorTools", tool: "a" }]]),
    chat([["unreal__call_tool", { toolset: "ActorTools", tool: "b" }]]),
  ]);
  verifier("deux Chats qui font agir l'éditeur en même temps : les appels passent un par un (outils exécutés en série sur le fil du jeu)", c1.fins[0]?.ok && c2.fins[0]?.ok && unreal.max === 1, { max: unreal.max, f1: c1.fins[0], f2: c2.fins[0] });

  /* ---- 3. Serveur ajouté par l'administrateur ---- */
  const etatAdmin = await api("/helix/connecteurs");
  const etatColl = await api("/helix/connecteurs", undefined, B);
  verifier("l'écran sait qui peut ajouter : l'administratrice (programme compris, depuis cette machine), pas le collègue", etatAdmin.personnalise?.ajouter === true && etatAdmin.personnalise?.programme === true && etatColl.personnalise?.ajouter === false && etatColl.personnalise?.programme === false, { admin: etatAdmin.personnalise, coll: etatColl.personnalise });
  const demande = { mode: "programme", id: "carnet-interne", label: "Carnet interne", description: "Notes de l'équipe.", command: NODE, args: [FAUX_PERSO], variables: { CLE_ESSAI: "secret-essai-123456" } };
  const parColl = await api("/helix/connecteurs/personnalise", demande, B);
  verifier("un collègue ne peut pas ajouter de serveur (403)", parColl.statut === 403, parColl);
  const avecJeton = await api(`/helix/connecteurs/personnalise?token=${jeton}`, demande);
  verifier("jeton dans l'adresse : refusé (400), en-têtes seulement", avecJeton.statut === 400, avecJeton);
  const TEMOIN = join(AUX, "PREUVE-SHELL");
  const refus = {
    "shell": await api("/helix/connecteurs/personnalise", { ...demande, id: "shell", command: "/bin/sh", args: ["-c", `touch ${TEMOIN}`] }),
    "code en ligne": await api("/helix/connecteurs/personnalise", { ...demande, id: "enligne", command: NODE, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(TEMOIN)}, "x")`] }),
    "variable HELIX_": await api("/helix/connecteurs/personnalise", { ...demande, id: "fuite", variables: { HELIX_DATA_DIR: "/tmp" } }),
    "adresse en http hors de la machine": await api("/helix/connecteurs/personnalise", { mode: "adresse", id: "distant", label: "Distant", url: "http://mcp.exemple.org/mcp" }),
    "port de la passerelle": await api("/helix/connecteurs/personnalise", { mode: "adresse", id: "boucle", label: "Boucle", url: `http://127.0.0.1:${PORT_PASSERELLE}/v1` }),
    "identifiant réservé": await api("/helix/connecteurs/personnalise", { ...demande, id: "fichiers" }),
    "identifiant du catalogue": await api("/helix/connecteurs/personnalise", { ...demande, id: "blender" }),
  };
  const malRefus = Object.entries(refus).filter(([, r]) => r.statut !== 400);
  await attendre(300);
  verifier(`refusés (400), rien n'est lancé : ${Object.keys(refus).join(", ")}`, malRefus.length === 0 && !existsSync(TEMOIN) && lireJournal(JOURNAL_PERSO).length === 0, malRefus.map(([k, r]) => `${k}: ${r.statut} ${r.message}`));
  const ajout = await api("/helix/connecteurs/personnalise", demande);
  const inst = (ajout.etat?.installes ?? []).find((c) => c.id === "carnet-interne");
  verifier("ajouté par l'administratrice : démarré, quatre outils, la commande montrée à elle seule", ajout.statut === 200 && inst?.running && inst.toolCount === 4 && inst.personnalise?.mode === "programme" && inst.personnalise.cible?.includes(FAUX_PERSO), `${ajout.message} ${JSON.stringify(inst)}`);
  const vuParB = ((await api("/helix/connecteurs", undefined, B)).installes ?? []).find((c) => c.id === "carnet-interne");
  verifier("le collègue voit le serveur, pas sa commande", vuParB && vuParB.personnalise && vuParB.personnalise.cible === undefined, vuParB);
  const demarrage = lireJournal(JOURNAL_PERSO).find((e) => e.demarre) ?? {};
  verifier(
    "le programme ne reçoit aucune variable de la passerelle (HELIX_…), mais celle de l'administratrice, et tourne depuis le dossier personnel",
    demarrage.cle === "secret-essai-123456" && !(demarrage.cles ?? []).some((k) => k.startsWith("HELIX_")) && demarrage.cwd === realpathSync((await import("node:os")).homedir()),
    { cles: demarrage.cles, cwd: demarrage.cwd },
  );
  const parDefaut = await chat([["carnet-interne__lire_note", {}]], () => false);
  verifier("par défaut, chaque outil du serveur ajouté demande l'accord (ici refusé : rien n'arrive au programme)", parDefaut.cartes.length === 1 && parDefaut.fins[0]?.ok === false && !appelsDe(JOURNAL_PERSO).includes("lire_note"), JSON.stringify(parDefaut.cartes.map((c) => c.detail?.outil)));
  const lecturesColl = await api("/helix/connecteurs/personnalise/lectures", { id: "carnet-interne", lectures: ["lire_note"] }, B);
  const lectures = await api("/helix/connecteurs/personnalise/lectures", { id: "carnet-interne", lectures: ["lire_note", "echoue", "env", "outil_invente"] });
  verifier("marquer des outils « lecture seule » : réservé à l'administratrice ; un outil que le serveur n'annonce pas est ignoré", lecturesColl.statut === 403 && lectures.statut === 200 && JSON.stringify(((lectures.etat?.installes ?? []).find((c) => c.id === "carnet-interne")?.personnalise?.lectures ?? []).sort()) === JSON.stringify(["echoue", "env", "lire_note"]), lectures);
  const lu = await chat([["carnet-interne__lire_note", {}], ["carnet-interne__ecrire_note", { texte: "x" }]], () => false);
  verifier("marqué « lecture seule » : sans carte ; les autres outils demandent toujours", lu.fins[0]?.ok && lu.cartes.length === 1 && lu.cartes[0].detail?.outil === "carnet-interne__ecrire_note", `${JSON.stringify(lu.fins)} ${JSON.stringify(lu.cartes.map((c) => c.detail?.outil))}`);
  const env = await chat([["carnet-interne__env", {}]]);
  verifier("vu de l'intérieur du programme : aucune variable HELIX_ de la passerelle", env.fins[0]?.ok && /CLES /.test(env.texte) && !/HELIX_/.test(env.texte) && !/VALEUR-DE-LA-PASSERELLE/.test(env.texte), env.texte.slice(0, 300));
  const avantEchecs = appelsDe(JOURNAL_PERSO).filter((n) => n === "echoue").length;
  const trois = await chat([["carnet-interne__echoue", {}], ["carnet-interne__echoue", {}], ["carnet-interne__echoue", {}]]);
  verifier(
    "le même appel qui échoue à l'identique : au deuxième échec, le résultat dit qu'il ne sera plus lancé ; le troisième ne part pas",
    appelsDe(JOURNAL_PERSO).filter((n) => n === "echoue").length - avantEchecs === 2 && /deux fois de suite à l'identique/.test(trois.fins[1]?.preview ?? "") && /déjà échoué deux fois/.test(trois.fins[2]?.preview ?? "") && trois.fins.every((f) => f.ok === false),
    trois.fins.map((f) => f.preview.slice(0, 120)),
  );
  const pid = lireJournal(JOURNAL_PERSO).find((e) => e.demarre)?.pid;
  const retraitColl = await api("/helix/connecteurs/retirer", { id: "carnet-interne" }, B);
  const relanceColl = await api("/helix/connecteurs/connecter", { id: "carnet-interne" }, B);
  const retrait = await api("/helix/connecteurs/retirer", { id: "carnet-interne" });
  await attendre(500);
  let vivant = true;
  try {
    process.kill(pid, 0);
  } catch {
    vivant = false;
  }
  const plusLa = await chat([["carnet-interne__lire_note", {}]]);
  verifier(
    "retrait et relance réservés à l'administratrice ; retiré, son programme est arrêté et ses outils ne sont plus proposés",
    retraitColl.statut === 403 && relanceColl.statut === 403 && retrait.statut === 200 && pid > 0 && !vivant && !(retrait.etat?.installes ?? []).some((c) => c.id === "carnet-interne") && /OUTIL-ABSENT carnet-interne__lire_note/.test(plusLa.texte),
    { retraitColl: retraitColl.statut, relanceColl: relanceColl.statut, retrait: retrait.message, vivant },
  );
  const boucle = await api("/helix/connecteurs/personnalise", { mode: "adresse", id: "unreal-bis", label: "Serveur local", url: `http://localhost:${PORT_UNREAL}/mcp` });
  const instBoucle = (boucle.etat?.installes ?? []).find((c) => c.id === "unreal-bis");
  verifier("par adresse, un serveur sur la boucle de cette machine (localhost ramené à 127.0.0.1) : ajouté, ses outils listés, l'adresse montrée à l'administratrice", boucle.statut === 200 && instBoucle?.running && instBoucle.toolCount === 3 && instBoucle.personnalise?.cible === `http://127.0.0.1:${PORT_UNREAL}/mcp`, `${boucle.message} ${JSON.stringify(instBoucle)}`);
  await api("/helix/connecteurs/retirer", { id: "unreal-bis" });
} catch (err) {
  verifier("partie B sans exception", false, `${err?.stack ?? String(err)} ${passerelle.journal.slice(-1500)}`);
}
passerelle.processus.kill("SIGTERM");
await attendre(1200);
serveurModule.close();
serveurUnreal.close();
fauxModele.close();

/*
 * Une instance ouverte aux collègues (profil `share`) : un programme de la
 * machine ne s'ajoute plus depuis l'écran, même par l'administrateur depuis
 * le poste ; l'intégrateur seul (`connecteursLibres`). Dans un processus à
 * part, qui lit ce profil.
 */
{
  const script = join(AUX, "regime.mjs");
  writeFileSync(script, `const c = await import(${JSON.stringify(pathToFileURL(join(RACINE, "gateway", "src", "connecteurs.ts")).href)});\nconsole.log(JSON.stringify({ poste: c.programmePermis(true), reseau: c.programmePermis(false) }));\nprocess.exit(0);\n`);
  const lancer = (profil) => {
    const f = join(AUX, `profil-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ chiffrement: "fichier", ...profil }));
    try {
      const sortie = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HELIX_CONFIG: f, HELIX_DATA_DIR: join(AUX, "donnees-regime"), HELIX_GATEWAY_HOST: "127.0.0.1" } });
      return JSON.parse(sortie.trim().split("\n").pop());
    } catch (err) {
      return { erreur: String(err?.stderr ?? err).slice(-300) };
    }
  };
  const ferme = lancer({});
  const ouverte = lancer({ share: true });
  const libre = lancer({ share: true, connecteursLibres: true });
  verifier(
    "programme de la machine : permis depuis le poste d'une instance fermée ; refusé sur une instance ouverte aux collègues ; permis là si l'intégrateur règle connecteursLibres",
    ferme.poste === true && ferme.reseau === false && ouverte.poste === false && ouverte.reseau === false && libre.poste === true && libre.reseau === true,
    { ferme, ouverte, libre },
  );
}

console.log(`\n${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
if (echecs.length) console.log(`Échecs :\n - ${echecs.join("\n - ")}`);
process.exit(echecs.length ? 1 : 0);
