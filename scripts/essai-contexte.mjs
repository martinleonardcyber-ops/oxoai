/*
 * Conversations coupées : la place du modèle, les réponses coupées, les refus
 * « context length exceeded » (16/10/2026).
 *
 * Signalé par Medhi : « des fois il y a des soucis avec le contexte chez
 * certaines personnes, ça se coupe, limite ». Aucun vrai modèle, aucun vrai
 * LM Studio : une passerelle jetable (dossier personnel, PATH et données
 * jetables, un « Linux x64 de 16 Go sans carte NVIDIA » simulé comme en 7 decies
 * de securite.mjs), devant un faux `lms` et un faux LM Studio qui refuse comme
 * le vrai une demande plus grande que la taille chargée, coupe une réponse par
 * sa longueur, ou réfléchit sans fin. Ce que cela prouve : ce que Helix envoie
 * et ce que l'écran reçoit. Ce que cela ne prouve pas : ce qu'un vrai modèle en
 * fait (PROJET.md).
 *
 *   node scripts/essai-contexte.mjs            (le code de ce dépôt)
 *   ESSAI_RACINE=/copie node scripts/...       (une autre copie, pour rejouer
 *                                               l'essai sur le code d'avant)
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as serveurNet } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = resolve(process.env.ESSAI_RACINE ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const portLibre = () =>
  new Promise((ok) => {
    const s = serveurNet();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
let reussis = 0;
const echecs = [];
function verifier(nom, condition, obtenu) {
  if (condition) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${String(obtenu).slice(0, 600)}`);
  }
}

const ICI = mkdtempSync(join(tmpdir(), "helix-essai-contexte-"));
const BIN = join(ICI, "bin");
mkdirSync(BIN);
mkdirSync(join(ICI, "maison", ".lmstudio", ".internal"), { recursive: true });
mkdirSync(join(ICI, "espace"));
symlinkSync(process.execPath, join(BIN, "node"));
const INTERNE = join(ICI, "maison", ".lmstudio", ".internal");
// Le moteur sans interface, déclaré comme llmster le fait : c'est le moteur de Helix tant qu'aucune application n'est déclarée.
writeFileSync(join(INTERNE, "llmster-install-location.json"), JSON.stringify({ path: process.execPath, argv: [], cwd: join(ICI, "maison") }));
const applicationDeLaPersonne = (oui) => {
  const f = join(INTERNE, "app-install-location.json");
  if (oui) writeFileSync(f, JSON.stringify({ path: process.execPath }));
  else rmSync(f, { force: true });
};
writeFileSync(
  join(BIN, "lms"),
  [
    "#!/usr/bin/env node",
    'const fs = require("node:fs"), path = require("node:path");',
    "const dir = process.env.FAUX_LMS_DIR, a = process.argv.slice(2);",
    'fs.appendFileSync(path.join(dir, "appels.log"), a.join(" ") + "\\n");',
    'const lire = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { return []; } };',
    'const charges = lire("charges.json"), installes = lire("installes.json"), json = a.includes("--json");',
    'const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };',
    'if (a[0] === "version") console.log("lms 0.0.0-essai");',
    'else if (a[0] === "ps") console.log(JSON.stringify(charges.map((c) => ({ modelKey: c.cle, path: c.cle, identifier: c.cle, type: "llm", sizeBytes: 2.5e9, contextLength: c.contexte, status: "idle" }))));',
    'else if (a[0] === "ls") console.log(json ? JSON.stringify(installes.map((k) => ({ modelKey: k, path: k, type: "llm", sizeBytes: 2.5e9, paramsString: "4B", maxContextLength: 262144 }))) : installes.join("\\n"));',
    'else if (a[0] === "load") fs.writeFileSync(path.join(dir, "charges.json"), JSON.stringify([...charges.filter((c) => c.cle !== a[1]), { cle: a[1], contexte: Number(opt("--context-length") ?? 4096) }]));',
    'else if (a[0] === "unload") fs.writeFileSync(path.join(dir, "charges.json"), JSON.stringify(charges.filter((c) => c.cle !== a[1])));',
    'else if (a[0] === "server") console.log(JSON.stringify({ running: true }));',
  ].join("\n"),
);
chmodSync(join(BIN, "lms"), 0o755);
writeFileSync(join(BIN, "security"), `#!/bin/sh\necho "$*" >> "${join(ICI, "security.log")}"\nexit 1\n`);
chmodSync(join(BIN, "security"), 0o755);

const MINISTRAL = "mistralai/ministral-3-3b";
const QWEN = "qwen/qwen3.5-4b";
const lireCharges = () => {
  try {
    return JSON.parse(readFileSync(join(ICI, "charges.json"), "utf8"));
  } catch {
    return [];
  }
};
const poser = (charges) => {
  writeFileSync(join(ICI, "installes.json"), JSON.stringify([MINISTRAL, QWEN]));
  writeFileSync(join(ICI, "charges.json"), JSON.stringify(charges));
  writeFileSync(join(ICI, "appels.log"), "");
};
const appelsLms = () => readFileSync(join(ICI, "appels.log"), "utf8").split("\n").filter(Boolean);

/*
 * Le faux LM Studio. Il refuse comme le vrai une demande plus grande que la
 * taille chargée (message relevé dans LM Studio : « …the model is loaded with
 * context length of only 4096 tokens, which is not enough… »), estimée à
 * 3,5 caractères par jeton ; `PLAFOND` (en caractères) le fait refuser plus
 * tôt, pour un refus que l'estimation de Helix n'a pas vu venir.
 */
const RECUES = [];
let MODE = "normal";
let PLAFOND = Infinity;
const PORT_LM = await portLibre();
const lm = createServer((req, res) => {
  let corps = "";
  req.on("data", (b) => (corps += b));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: MINISTRAL, object: "model" }, { id: QWEN, object: "model" }] }));
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      return res.end("{}");
    }
    const d = JSON.parse(corps || "{}");
    RECUES.push(d);
    const taille = JSON.stringify({ m: d.messages, t: d.tools ?? [] }).length;
    const charge = lireCharges().find((c) => c.cle === d.model);
    const contexte = charge?.contexte ?? 4096;
    if (taille / 3.5 > contexte || taille > PLAFOND) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error: `Trying to keep the first ${Math.ceil(taille / 3.5)} tokens when context the overflows. However, the model is loaded with context length of only ${contexte} tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input`,
        }),
      );
    }
    if (d.stream === false) {
      const tri = String(d.messages?.[0]?.content ?? "").startsWith("Tu organises un travail");
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: tri ? '{"etapes": []}' : "Bonjour !" }, finish_reason: "stop" }] }));
    }
    res.setHeader("Content-Type", "text/event-stream");
    const m = (o) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: d.model, ...o })}\n\n`);
    const dernier = String(d.messages?.at(-1)?.content ?? "");
    if (MODE === "longueur" || (MODE === "longueur-une-fois" && !/coupée par sa longueur/.test(dernier))) {
      m({ choices: [{ index: 0, delta: { role: "assistant", content: "Début de la réponse, qui s'arrête au milieu d'une" } }] });
      m({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
    } else if (MODE === "reflexion" && d.reasoning_effort !== "none") {
      m({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: Array.from({ length: 60 }, (_, i) => `Étape ${i} : je considère ${(i * 7919) % 1000} et ${(i * 104729) % 997}.`).join(" ") } }] });
      m({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
    } else {
      m({ choices: [{ index: 0, delta: { role: "assistant", content: MODE === "longueur-une-fois" ? " phrase, et voici la fin." : "Réponse d'essai." } }] });
      m({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((ok) => lm.listen(PORT_LM, "127.0.0.1", ok));

const PORT = await portLibre();
writeFileSync(join(ICI, "profil.json"), JSON.stringify({ chiffrement: "fichier", autoProvision: false, backends: [{ id: "exo", enabled: false }] }));
writeFileSync(
  join(ICI, "lancer.mjs"),
  `import os from "node:os";
   Object.defineProperty(process, "platform", { value: "linux" });
   Object.defineProperty(process, "arch", { value: "x64" });
   os.totalmem = () => 16 * 1024 ** 3;
   (await import("node:module")).syncBuiltinESMExports();
   await import(${JSON.stringify(join(RACINE, "gateway", "src", "index.ts"))});`,
);
poser([]);
const passerelle = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ICI, "lancer.mjs")], {
  cwd: RACINE,
  env: {
    PATH: `${BIN}:/usr/bin:/bin`,
    HOME: join(ICI, "maison"),
    TMPDIR: tmpdir(),
    FAUX_LMS_DIR: ICI,
    HELIX_CONFIG: join(ICI, "profil.json"),
    HELIX_DATA_DIR: join(ICI, "donnees"),
    HELIX_WORKSPACE: join(ICI, "espace"),
    HELIX_GATEWAY_PORT: String(PORT),
    HELIX_GATEWAY_HOST: "127.0.0.1",
    HELIX_LMSTUDIO_URL: `http://127.0.0.1:${PORT_LM}/v1`,
    HELIX_EXO_URL: "http://127.0.0.1:9/v1",
    HELIX_OPENCODE_BIN: "/usr/bin/true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let journal = "";
passerelle.stdout.on("data", (b) => (journal += b));
passerelle.stderr.on("data", (b) => (journal += b));
const G = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try {
    await fetch(`${G}/health`);
    break;
  } catch {
    await attendre(250);
  }
}
let JETON = "";
try {
  JETON = readFileSync(join(ICI, "donnees", "instance-token"), "utf8").trim();
} catch {
  /* passerelle muette : les contrôles le diront */
}
/*
 * Une séance ouverte : faire agir le modèle avec des outils l'exige
 * (index.ts). Compte d'essai de l'instance jetable, mot de passe tiré au sort.
 */
let SEANCE = "";
try {
  const r = await fetch(`${G}/helix/auth/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JETON}` },
    body: JSON.stringify({ fullName: "Essai", email: "essai@example.test", password: `Ess-${randomBytes(12).toString("hex")}!9` }),
  });
  SEANCE = (await r.json()).session?.token ?? "";
} catch {
  /* sans séance : les contrôles avec outils le diront */
}
const envoyer = async (corps) => {
  const avant = RECUES.length;
  const texte = await (
    await fetch(`${G}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-Helix-Langue": "fr", ...(SEANCE ? { "X-Helix-Session": SEANCE } : {}) },
      body: JSON.stringify({ stream: true, effort: "moyen", ...corps }),
    }).catch(() => ({ text: async () => "" }))
  ).text();
  // Le texte de la réponse, recollé ; les événements de l'écran à part.
  const evenements = [];
  let reponse = "";
  for (const ligne of texte.split("\n")) {
    if (!ligne.startsWith("data:")) continue;
    try {
      const j = JSON.parse(ligne.slice(5));
      if (j.helix) evenements.push(j.helix);
      const c = j.choices?.[0]?.delta?.content;
      if (typeof c === "string") reponse += c;
      if (j.error) evenements.push({ ...j.error, type: "erreur-api", typeApi: j.error.type });
    } catch {
      /* [DONE] */
    }
  }
  return { texte, reponse, evenements, flux: RECUES.slice(avant).filter((r) => r.stream !== false) };
};
const SYSTEME = "Tu es l'assistant de l'entreprise. Réponds dans la langue de la personne.";
const changer = async (charges) => {
  poser(charges);
  // La découverte des modèles est gardée quelques secondes par la passerelle.
  await attendre(5200);
};

console.log(`\nEssai de la place de conversation, sur ${RACINE}`);

// 1 a. Moteur de Helix, modèle chargé par LM Studio seul à 4 096 jetons : rechargé avec la taille de Helix.
console.log("\n1. Modèle déjà chargé avec 4 096 jetons");
await changer([{ cle: MINISTRAL, contexte: 4096 }]);
const r1 = await envoyer({ model: MINISTRAL, tools: false, messages: [{ role: "system", content: SYSTEME }, { role: "user", content: "Bonjour" }] });
const appels1 = appelsLms();
verifier(
  "moteur de Helix (llmster seul) : le modèle chargé à 4 096 jetons est rechargé avec 32 768, au repos, avant la réponse",
  appels1.includes(`unload ${MINISTRAL}`) && appels1.some((l) => l.startsWith(`load ${MINISTRAL}`) && l.includes("--context-length 32768")) && lireCharges()[0]?.contexte === 32768,
  JSON.stringify(appels1),
);
verifier("et la réponse arrive, sans erreur", /Réponse d'essai/.test(r1.reponse) && !r1.evenements.some((e) => e.type === "error"), JSON.stringify(r1.evenements).slice(0, 300));

// 1 b. Application LM Studio de la personne : rien n'est rechargé ; les outils ne tiennent pas, ils sont retirés et c'est dit.
// Un autre modèle que celui que Helix vient de recharger : celui-ci n'a jamais été chargé par Helix.
applicationDeLaPersonne(true);
await changer([{ cle: MINISTRAL, contexte: 32768 }, { cle: QWEN, contexte: 4096 }]);
const r1b = await envoyer({ model: QWEN, tools: true, messages: [{ role: "system", content: SYSTEME }, { role: "user", content: "Quels sont les fichiers de mon dossier ?" }] });
const appels1b = appelsLms();
const outilsPartis = r1b.flux.map((r) => (Array.isArray(r.tools) ? r.tools.length : 0));
verifier("application LM Studio de la personne : le modèle n'est jamais déchargé ni rechargé par Helix", !appels1b.some((l) => l.startsWith("unload") || l.startsWith("load")), JSON.stringify(appels1b));
verifier(
  "ses outils ne tiennent pas dans 4 096 jetons : ils ne partent pas, et le moteur ne refuse rien",
  r1b.flux.length > 0 && outilsPartis.every((n) => n === 0) && !r1b.evenements.some((e) => e.type === "error"),
  `outils envoyés ${JSON.stringify(outilsPartis)}, événements ${JSON.stringify(r1b.evenements).slice(0, 400)}, flux ${r1b.texte.slice(0, 400)}`,
);
verifier(
  "la personne lit pourquoi, et comment agrandir la place (Context Length de 32 768 dans LM Studio)",
  /qwen\/qwen3\.5-4b n'a qu'une conversation de 4096 jetons : trop peu pour ses outils/.test(r1b.reponse) && /Context Length » de 32 768/.test(r1b.reponse),
  r1b.reponse.slice(0, 400),
);

// 3. Le moteur refuse une demande que l'estimation de Helix croyait tenir : raccourcie et renvoyée.
console.log("\n3. Refus « context length » du moteur");
applicationDeLaPersonne(true);
await changer([{ cle: MINISTRAL, contexte: 32768 }]);
PLAFOND = 30_000;
const fil3 = [{ role: "system", content: SYSTEME }];
for (let i = 0; i < 12; i++) {
  fil3.push({ role: "user", content: `Question ${i} : ${"développe ".repeat(30)}` });
  fil3.push({ role: "assistant", content: `Réponse ${i}. ${"Une longue explication détaillée. ".repeat(80)}` });
}
fil3.push({ role: "user", content: "Et pour conclure ?" });
const r3 = await envoyer({ model: MINISTRAL, tools: false, messages: fil3 });
verifier(
  "refusé une première fois, la demande repart raccourcie (consigne et question gardées), et la réponse arrive",
  r3.flux.length >= 2 && r3.flux.at(-1).messages.length < r3.flux[0].messages.length && r3.flux.at(-1).messages.at(-1)?.content === "Et pour conclure ?" &&
    String(r3.flux.at(-1).messages[0]?.content).startsWith(SYSTEME) && /Réponse d'essai/.test(r3.reponse),
  `${r3.flux.map((r) => r.messages.length).join(" → ")} messages ; ${r3.reponse.slice(0, 200)} ${JSON.stringify(r3.evenements).slice(0, 300)}`,
);
verifier("et c'est dit en tête de la réponse", /La conversation dépassait la place de mistralai\/ministral-3-3b/.test(r3.reponse), r3.reponse.slice(0, 300));
// Le relais (OpenClaw, OpenCode) : le refus est dit dans des mots que le client reconnaît, pour qu'il compacte sa conversation.
const r3b = await envoyer({
  model: MINISTRAL,
  messages: fil3,
  tools: [{ type: "function", function: { name: "lire", description: "Lit un fichier", parameters: { type: "object", properties: {} } } }],
});
const err3b = r3b.evenements.find((e) => e.type === "erreur-api");
verifier(
  "relais d'un client de l'API : l'erreur porte « context length exceeded » et le code context_length_exceeded (OpenClaw et OpenCode compactent alors), avec le message traduit",
  Boolean(err3b) && /context length exceeded/.test(err3b.message) && err3b.code === "context_length_exceeded" && /dépasse/.test(err3b.message),
  JSON.stringify(err3b ?? r3b.texte.slice(0, 300)),
);
PLAFOND = Infinity;

// 2. Réponse coupée par sa longueur.
console.log("\n2. Réponse coupée par sa longueur (finish_reason: length)");
MODE = "longueur-une-fois";
const r2 = await envoyer({ model: MINISTRAL, tools: false, messages: [{ role: "system", content: SYSTEME }, { role: "user", content: "Écris un long texte" }] });
verifier(
  "coupée en route avec de la place : la suite est demandée d'elle-même (réponse partielle puis note), et s'écrit à la suite, sans paragraphe neuf",
  r2.flux.length === 2 && r2.flux[1].messages.at(-2)?.role === "assistant" && /coupée par sa longueur/.test(r2.flux[1].messages.at(-1)?.content) &&
    r2.reponse.includes("au milieu d'une phrase, et voici la fin."),
  `${r2.flux.length} requêtes ; ${JSON.stringify(r2.reponse)}`,
);
MODE = "longueur";
const r2b = await envoyer({ model: MINISTRAL, tools: false, messages: [{ role: "system", content: SYSTEME }, { role: "user", content: "Écris un très long texte" }] });
verifier(
  "toujours coupée : deux suites au plus, puis l'écran reçoit « coupee » (note et bouton Continuer), sans erreur",
  r2b.flux.length === 3 && r2b.evenements.some((e) => e.type === "coupee" && /a été coupée/.test(e.message)) && !r2b.evenements.some((e) => e.type === "error"),
  `${r2b.flux.length} requêtes ; ${JSON.stringify(r2b.evenements).slice(0, 300)}`,
);
MODE = "normal";

// 6. La réflexion prend toute la place.
console.log("\n6. Réflexion qui prend toute la place de la réponse");
await changer([{ cle: MINISTRAL, contexte: 32768 }, { cle: QWEN, contexte: 32768 }]);
MODE = "reflexion";
const r6 = await envoyer({ model: QWEN, tools: false, messages: [{ role: "system", content: SYSTEME }, { role: "user", content: "Combien font 2 et 2 ?" }] });
verifier(
  "réflexion coupée sans réponse : nouvel essai sans réflexion (reasoning_effort « none »), dit, et la réponse arrive",
  r6.flux.length === 2 && r6.flux[1].reasoning_effort === "none" && /Réponse d'essai/.test(r6.reponse) && /a pris toute la place de la réponse : nouvel essai sans réflexion/.test(r6.reponse),
  `${r6.flux.map((r) => r.reasoning_effort).join(", ")} ; ${JSON.stringify(r6.reponse).slice(0, 300)} ${JSON.stringify(r6.evenements).slice(0, 200)}`,
);
MODE = "normal";

// 4 et 5. Les fonctions seules.
console.log("\n4 et 5. Résultat d'outil trop grand, refus reconnus, tailles des modèles cloud");
const u = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    `const h = await import(${JSON.stringify(join(RACINE, "gateway", "src", "historique.ts"))});
     const c = await import(${JSON.stringify(join(RACINE, "gateway", "src", "modelesCloud.ts"))});
     const gros = "ligne de fichier\\n".repeat(1200);
     const fil = [{ role: "system", content: "S" }, { role: "user", content: "Q" }, { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name: "lire", arguments: "{}" } }] }, { role: "tool", tool_call_id: "1", content: gros }];
     const r = h.tenirDansLaPlace(fil, 2000, 1);
     const refus = [
       [400, '{"error":"The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input"}'],
       [400, '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}'],
       [400, '{"error":{"message":"This model\\'s maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}'],
       [400, '{"object":"error","message":"Prompt contains 40001 tokens and 0 draft tokens, too large for model with 32768 maximum context length","type":"invalid_request_invalid_args"}'],
       [400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'],
       [400, '{"error":{"code":400,"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}'],
       [500, '{"error":"ollama error: context length exceeded"}'],
     ].map(([s, d]) => c.depasseLeContexte(s, d));
     const pasRefus = [
       [413, '{"error":{"message":"Request too large for model llama-3.3-70b in organization org_x on tokens per minute (TPM): Limit 6000, Requested 8098","type":"tokens","code":"rate_limit_exceeded"}}'],
       [429, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'],
       [400, '{"error":{"message":"Invalid value for context: expected string"}}'],
     ].map(([s, d]) => c.depasseLeContexte(s, d));
     console.log(JSON.stringify({ coupe: r.dernierCoupe, apres: r.apres, long: r.messages[3].content.length, note: /caractères de plus retirés/.test(r.messages[3].content), refus, pasRefus,
       tailles: ["gpt-4o", "gpt-5-mini", "claude-sonnet-4-5", "gemini-2.5-pro", "deepseek-chat", "o3", "modele-inconnu"].map((n) => c.contexteConnuParNom(n)) }));`,
  ],
  { cwd: RACINE, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${BIN}:/usr/bin:/bin`, HOME: join(ICI, "maison"), HELIX_DATA_DIR: join(ICI, "u"), HELIX_CONFIG: join(ICI, "absent.json") } },
);
let fx = {};
try {
  fx = JSON.parse((u.stdout ?? "").trim().split("\n").at(-1));
} catch {
  fx = { erreur: `${u.stdout ?? ""}${u.stderr ?? ""}`.slice(-400) };
}
verifier(
  "un seul résultat d'outil plus grand que la place (14 400 caractères pour 2 000 jetons) est coupé, avec une note, sous la place",
  fx.coupe === true && fx.apres <= 2100 && fx.long < 7000 && fx.note === true,
  JSON.stringify(fx).slice(0, 300),
);
verifier(
  "refus reconnus : LM Studio, llama.cpp, OpenAI, Mistral, Anthropic, Google, Ollama ; pas un débit par minute, un quota, ni un champ « context » mal formé",
  JSON.stringify(fx.refus) === JSON.stringify([true, true, true, true, true, true, true]) && JSON.stringify(fx.pasRefus) === JSON.stringify([false, false, false]),
  JSON.stringify({ refus: fx.refus, pasRefus: fx.pasRefus, erreur: fx.erreur }),
);
verifier(
  "modèles cloud sans taille publiée : celle de leur famille (gpt-4o 128 000, gpt-5 272 000, Claude 200 000, Gemini 1 000 000, DeepSeek 64 000, o3 200 000), rien pour un inconnu",
  JSON.stringify(fx.tailles) === JSON.stringify([128000, 272000, 200000, 1000000, 64000, 200000, null]),
  JSON.stringify(fx.tailles),
);

passerelle.kill();
lm.close();
await attendre(300);
verifier("aucun appel au trousseau macOS (dossier personnel jetable, clé par fichier)", !existsSync(join(ICI, "security.log")), "security appelé");
if (echecs.length > 0 || process.env.ESSAI_JOURNAL) console.log(journal.split("\n").filter((l) => /^\[(chat|helix)\]/.test(l)).join("\n").slice(-4000));
rmSync(ICI, { recursive: true, force: true });
console.log(`\n${reussis} réussi(s), ${echecs.length} échec(s)`);
process.exit(echecs.length > 0 ? 1 : 0);
