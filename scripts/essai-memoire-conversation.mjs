/*
 * Mémoire de la conversation (16/10/2026, gateway/src/memoireConversation.ts).
 *
 * Demandé par Medhi : ce qui sort de la place du modèle dans un long Chat ne
 * doit plus être perdu. Aucun vrai modèle, aucun vrai LM Studio : une
 * passerelle jetable (dossier personnel, PATH et données jetables, un « Linux
 * x64 de 16 Go sans carte NVIDIA » simulé comme dans essai-contexte.mjs),
 * devant un faux `lms` et un faux LM Studio qui sert un modèle chargé à 4 096
 * jetons et un faux modèle d'embeddings (un vecteur par sac de mots haché,
 * comme en 6 ter de securite.mjs).
 *
 * Ce que l'essai vérifie : un fait donné au début d'un très long Chat, sorti
 * de la place, revient au modèle quand on le redemande à la fin ; il ne vient
 * pas dans le Chat d'une autre personne (même identifiant de Chat compris) ;
 * il ne vient d'un autre Chat que si le réglage est allumé ; la mémoire est
 * chiffrée sur le disque ; supprimer le Chat l'efface ; une mémoire illisible
 * n'est pas écrasée ; sans modèle d'embeddings, la recherche par les mots
 * suffit ; l'export la contient, l'effacement du compte l'efface ; le résumé
 * au repos n'appelle le modèle que sur une machine confortable, et quand rien
 * d'autre ne tourne. Ce que l'essai ne prouve pas : qu'un vrai modèle se sert
 * bien des extraits (PROJET.md).
 *
 *   node scripts/essai-memoire-conversation.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const ICI = mkdtempSync(join(tmpdir(), "helix-essai-memoire-"));
const BIN = join(ICI, "bin");
mkdirSync(BIN);
const INTERNE = join(ICI, "maison", ".lmstudio", ".internal");
mkdirSync(INTERNE, { recursive: true });
mkdirSync(join(ICI, "espace"));
symlinkSync(process.execPath, join(BIN, "node"));
// L'application LM Studio de la personne : Helix ne recharge pas le modèle, il garde ses 4 096 jetons.
writeFileSync(join(INTERNE, "llmster-install-location.json"), JSON.stringify({ path: process.execPath, argv: [], cwd: join(ICI, "maison") }));
writeFileSync(join(INTERNE, "app-install-location.json"), JSON.stringify({ path: process.execPath }));
const MINISTRAL = "mistralai/ministral-3-3b";
const EMBED = "text-embedding-nomic-embed-text-v1.5";
writeFileSync(join(ICI, "installes.json"), JSON.stringify([MINISTRAL]));
writeFileSync(join(ICI, "charges.json"), JSON.stringify([{ cle: MINISTRAL, contexte: 4096 }]));
writeFileSync(join(ICI, "appels.log"), "");
writeFileSync(
  join(BIN, "lms"),
  [
    "#!/usr/bin/env node",
    'const fs = require("node:fs"), path = require("node:path");',
    "const dir = process.env.FAUX_LMS_DIR, a = process.argv.slice(2);",
    'fs.appendFileSync(path.join(dir, "appels.log"), a.join(" ") + "\\n");',
    'const lire = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { return []; } };',
    'const charges = lire("charges.json"), installes = lire("installes.json"), json = a.includes("--json");',
    'if (a[0] === "version") console.log("lms 0.0.0-essai");',
    'else if (a[0] === "ps") console.log(JSON.stringify(charges.map((c) => ({ modelKey: c.cle, path: c.cle, identifier: c.cle, type: "llm", sizeBytes: 2.5e9, contextLength: c.contexte, status: "idle" }))));',
    'else if (a[0] === "ls") console.log(json ? JSON.stringify(installes.map((k) => ({ modelKey: k, path: k, type: "llm", sizeBytes: 2.5e9, paramsString: "3B", maxContextLength: 262144 }))) : installes.join("\\n"));',
    'else if (a[0] === "server") console.log(JSON.stringify({ running: true }));',
  ].join("\n"),
);
chmodSync(join(BIN, "lms"), 0o755);
writeFileSync(join(BIN, "security"), `#!/bin/sh\necho "$*" >> "${join(ICI, "security.log")}"\nexit 1\n`);
chmodSync(join(BIN, "security"), 0o755);

/* Le faux modèle d'embeddings : un sac de mots haché sur 64 dimensions. */
const vecteur = (texte) => {
  const v = new Array(64).fill(0.01);
  for (const mot of String(texte).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) {
    if (mot.length < 3) continue;
    let h = 0;
    for (const c of mot) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
};
const RECUES = [];
let EMBEDDINGS = true;
let APPELS_EMBED = 0;
const PORT_LM = await portLibre();
const lm = createServer((req, res) => {
  let corps = "";
  req.on("data", (b) => (corps += b));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") {
      return res.end(JSON.stringify({ data: [{ id: MINISTRAL, object: "model" }, ...(EMBEDDINGS ? [{ id: EMBED, object: "model" }] : [])] }));
    }
    const d = JSON.parse(corps || "{}");
    if (req.url === "/v1/embeddings") {
      if (!EMBEDDINGS) {
        res.statusCode = 404;
        return res.end("{}");
      }
      APPELS_EMBED++;
      const entrees = Array.isArray(d.input) ? d.input : [d.input];
      return res.end(JSON.stringify({ data: entrees.map((t, index) => ({ index, embedding: vecteur(t) })) }));
    }
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      return res.end("{}");
    }
    RECUES.push(d);
    if (d.stream === false) return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "Résumé d'essai." }, finish_reason: "stop" }] }));
    res.setHeader("Content-Type", "text/event-stream");
    const m = (o) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: d.model, ...o })}\n\n`);
    m({ choices: [{ index: 0, delta: { role: "assistant", content: "Réponse d'essai." } }] });
    m({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((ok) => lm.listen(PORT_LM, "127.0.0.1", ok));

const PORT = await portLibre();
const DONNEES = join(ICI, "donnees");
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
const ENV = {
  PATH: `${BIN}:/usr/bin:/bin`,
  HOME: join(ICI, "maison"),
  TMPDIR: tmpdir(),
  FAUX_LMS_DIR: ICI,
  HELIX_CONFIG: join(ICI, "profil.json"),
  HELIX_DATA_DIR: DONNEES,
  HELIX_WORKSPACE: join(ICI, "espace"),
  HELIX_GATEWAY_HOST: "127.0.0.1",
  HELIX_LMSTUDIO_URL: `http://127.0.0.1:${PORT_LM}/v1`,
  HELIX_EXO_URL: "http://127.0.0.1:9/v1",
  HELIX_OPENCODE_BIN: "/usr/bin/true",
  // Le résumé au repos, s'il devait partir, partirait vite : l'essai vérifie qu'il ne part pas sur ce « petit PC ».
  HELIX_MEMOIRE_REPOS_MS: "800",
};
const passerelle = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ICI, "lancer.mjs")], {
  cwd: RACINE,
  env: { ...ENV, HELIX_GATEWAY_PORT: String(PORT) },
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
  JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
} catch {
  /* passerelle muette : les contrôles le diront */
}
const avecJeton = { "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-Helix-Langue": "fr" };
const appel = (chemin, init = {}) => fetch(`${G}${chemin}`, init).catch(() => ({ ok: false, status: 0, json: async () => ({}), text: async () => "" }));

// Deux personnes : l'administratrice (A), puis une collègue (B) créée par elle, qui choisit son mot de passe.
const MDP_A = `Ess-${randomBytes(12).toString("hex")}!9`;
const MDP_B = `Col-${randomBytes(12).toString("hex")}!7`;
const creeA = await (await appel("/helix/auth/create", { method: "POST", headers: avecJeton, body: JSON.stringify({ fullName: "Essai", email: "essai@example.test", password: MDP_A }) })).json().catch(() => ({}));
const SEANCE_A = creeA.session?.token ?? "";
const ID_A = creeA.account?.id ?? "";
const avecA = { ...avecJeton, "X-Helix-Session": SEANCE_A };
const PROVISOIRE = `Prov-${randomBytes(8).toString("hex")}!3`;
const creeB = await (await appel("/helix/auth/create", { method: "POST", headers: avecA, body: JSON.stringify({ fullName: "Collègue", email: "collegue@example.test", password: PROVISOIRE }) })).json().catch(() => ({}));
const ID_B = creeB.account?.id ?? "";
const connexionB = await (
  await appel("/helix/auth/mot-de-passe-provisoire", { method: "POST", headers: avecJeton, body: JSON.stringify({ accountId: ID_B, password: PROVISOIRE, nouveau: MDP_B }) })
).json().catch(() => ({}));
const SEANCE_B = connexionB.session?.token ?? "";
const avecB = { ...avecJeton, "X-Helix-Session": SEANCE_B };

const envoyer = async (seance, messages, memoire) => {
  const avant = RECUES.length;
  const texte = await (
    await appel("/v1/chat/completions", {
      method: "POST",
      headers: { ...avecJeton, "X-Helix-Session": seance },
      body: JSON.stringify({ stream: true, effort: "moyen", model: MINISTRAL, tools: false, messages, ...(memoire ? { memoire } : {}) }),
    })
  ).text();
  const evenements = [];
  let reponse = "";
  for (const ligne of texte.split("\n")) {
    if (!ligne.startsWith("data:")) continue;
    try {
      const j = JSON.parse(ligne.slice(5));
      if (j.helix) evenements.push(j.helix);
      const c = j.choices?.[0]?.delta?.content;
      if (typeof c === "string") reponse += c;
    } catch {
      /* [DONE] */
    }
  }
  const flux = RECUES.slice(avant).filter((r) => r.stream !== false);
  return { reponse, evenements, flux, envoye: flux.at(-1)?.messages ?? [] };
};
const systemeDe = (r) => String(r.envoye[0]?.content ?? "");
const SYSTEME = "Tu es l'assistant de l'entreprise. Réponds dans la langue de la personne.";
const SUJETS = ["planning", "livraison", "budget", "recrutement", "formation", "inventaire", "facturation", "réunion", "fournisseurs", "sécurité"];
/** Une très longue conversation : le fait au début, puis `n` échanges sans rapport, puis la question. */
const conversation = (fait, n, question, graine = "") => {
  const fil = [{ role: "system", content: SYSTEME }, { role: "user", content: fait }, { role: "assistant", content: "C'est noté." }];
  for (let i = 0; i < n; i++) {
    const s = SUJETS[i % SUJETS.length];
    fil.push({ role: "user", content: `${graine}Point ${i} sur le ${s} de la semaine ${i} : ${`il faut revoir le ${s}, l'organisation et les délais de l'équipe ${i}. `.repeat(6)}` });
    fil.push({ role: "assistant", content: `${graine}Pour le ${s} (point ${i}) : ${`je propose de répartir le travail du ${s} par étapes, avec un suivi régulier. `.repeat(6)}` });
  }
  fil.push({ role: "user", content: question });
  return fil;
};
const FAIT = "Retiens bien ceci : le code du portail de l'entrepôt de Lyon est 4521B.";
const QUESTION = "Au fait, quel est le code du portail de l'entrepôt de Lyon ?";
const dossierMemoire = join(DONNEES, "memoire-conversations");
const fichiersMemoire = () => {
  const sortie = [];
  try {
    for (const d of readdirSync(dossierMemoire)) for (const f of readdirSync(join(dossierMemoire, d))) sortie.push(join(dossierMemoire, d, f));
  } catch {
    /* rien encore */
  }
  return sortie;
};

console.log(`\nEssai de la mémoire de la conversation, sur ${RACINE}`);
verifier("deux comptes et leurs séances (administratrice et collègue)", Boolean(SEANCE_A && SEANCE_B && ID_A && ID_B), JSON.stringify({ a: Boolean(SEANCE_A), b: Boolean(SEANCE_B) }));

console.log("\n1. Un fait au début d'un très long Chat, demandé à la fin");
const fil1 = conversation(FAIT, 40, QUESTION);
const debut1 = Date.now();
const r1 = await envoyer(SEANCE_A, fil1, { chat: "chatA1", autresChats: false });
const duree1 = Date.now() - debut1;
const sansLeFait = !r1.envoye.some((m) => m.role !== "system" && String(m.content).includes("4521B"));
verifier("le message du fait est sorti de la place : il n'est plus parmi les messages envoyés", r1.envoye.length > 0 && r1.envoye.length < fil1.length && sansLeFait, `${r1.envoye.length} messages sur ${fil1.length}`);
verifier(
  "il revient au modèle, dans la consigne, en « extraits plus anciens de cette conversation », daté, avant les échanges récents",
  /Extraits plus anciens de cette conversation/.test(systemeDe(r1)) && /4521B/.test(systemeDe(r1)) && /\[Extrait 1 : la personne, \d\d\/\d\d\/\d{4} \d\d:\d\d\]/.test(systemeDe(r1)) && r1.envoye[0]?.role === "system",
  systemeDe(r1).slice(-900),
);
verifier("le modèle sait qu'il ne voit plus le début, et que des extraits lui en sont rendus", /ne te sont plus donnés en entier/.test(systemeDe(r1)), systemeDe(r1).slice(0, 600));
verifier("la question reste le dernier message, et la réponse arrive", r1.envoye.at(-1)?.content === QUESTION && /Réponse d'essai/.test(r1.reponse), JSON.stringify(r1.envoye.at(-1)).slice(0, 200));
const ev1 = r1.evenements.find((e) => e.type === "memoire");
verifier("l'écran reçoit « memoire » : combien d'extraits, aucun d'un autre Chat", ev1 && ev1.extraits >= 1 && !ev1.autresChats, JSON.stringify(r1.evenements.filter((e) => e.type !== "statut")).slice(0, 300));
const tailleEnvoyee = JSON.stringify(r1.envoye).length;
verifier("ce qui part au modèle tient dans sa place (4 096 jetons, à 3,5 caractères par jeton)", tailleEnvoyee / 3.5 < 4096, `${tailleEnvoyee} caractères`);
verifier("le modèle d'embeddings a servi (rangement et question)", APPELS_EMBED >= 2, APPELS_EMBED);

console.log("\n2. Rangée chiffrée, sur l'instance, au nom de la personne");
const fichiers = fichiersMemoire();
const brut = fichiers.length > 0 ? readFileSync(fichiers[0]) : Buffer.alloc(0);
verifier("un seul fichier, dans un dossier au nom d'une empreinte (ni l'identifiant ni l'adresse du compte)", fichiers.length === 1 && !fichiers[0].includes(ID_A) && !fichiers[0].includes("essai@"), fichiers.join(", "));
verifier("chiffré (en-tête HLXF1), sans le fait ni un mot de la conversation en clair", brut.subarray(0, 5).toString("latin1") === "HLXF1" && !brut.includes("4521B") && !brut.includes("portail") && !brut.includes("planning"), brut.subarray(0, 5).toString("latin1"));
// Recopié sous le nom d'un autre Chat, il ne se déchiffre pas : rien ne revient.
const copie = join(dirname(fichiers[0] ?? join(ICI, "x")), "chatCopie.mem");
if (fichiers[0]) writeFileSync(copie, brut);
const rCopie = await envoyer(SEANCE_A, [{ role: "system", content: SYSTEME }, { role: "user", content: QUESTION }], { chat: "chatCopie", autresChats: false });
verifier("le même fichier recopié sous le nom d'un autre Chat ne se lit pas (lié au compte et au Chat)", !/4521B/.test(systemeDe(rCopie)), systemeDe(rCopie).slice(-300));
rmSync(copie, { force: true });

console.log("\n3. Une autre personne, un autre Chat");
// B parle dans un Chat de même identifiant, avec sa propre longue conversation, et demande le code, réglage allumé.
const filB = conversation("Je m'occupe des plannings de l'atelier de Nantes.", 40, QUESTION, "B ");
const rB = await envoyer(SEANCE_B, filB, { chat: "chatA1", autresChats: true });
verifier(
  "la collègue, même dans un Chat de même identifiant et réglage allumé, ne reçoit jamais le fait d'une autre personne",
  rB.envoye.length > 0 && !rB.envoye.some((m) => String(m.content).includes("4521B")),
  systemeDe(rB).slice(-400),
);
verifier("elle a sa propre mémoire, à part (deux dossiers)", (() => { try { return readdirSync(dossierMemoire).length === 2; } catch { return false; } })(), fichiersMemoire().length);
const court = [{ role: "system", content: SYSTEME }, { role: "user", content: QUESTION }];
const rAutreOff = await envoyer(SEANCE_A, court, { chat: "chatA2", autresChats: false });
verifier("un autre Chat de la même personne, réglage éteint : rien ne vient du premier", !/4521B/.test(systemeDe(rAutreOff)) && !rAutreOff.evenements.some((e) => e.type === "memoire"), systemeDe(rAutreOff).slice(-300));
const rAutreOn = await envoyer(SEANCE_A, court, { chat: "chatA2", autresChats: true });
const evOn = rAutreOn.evenements.find((e) => e.type === "memoire");
verifier(
  "réglage « Retrouver aussi ce qui a été dit dans mes autres Chats » allumé : le fait vient, marqué comme d'un autre Chat",
  /4521B/.test(systemeDe(rAutreOn)) && /dans un autre Chat de la même personne/.test(systemeDe(rAutreOn)) && evOn?.autresChats >= 1,
  `${systemeDe(rAutreOn).slice(-400)} ${JSON.stringify(evOn)}`,
);
const rSansChat = await envoyer(SEANCE_A, court, undefined);
verifier("sans Chat nommé (un client de l'API), aucune mémoire n'est consultée", !/4521B/.test(systemeDe(rSansChat)), systemeDe(rSansChat).slice(-200));
const rIdBizarre = await envoyer(SEANCE_A, court, { chat: "../chatA1", autresChats: false });
verifier("un identifiant de Chat qui serait un chemin est ignoré", !/4521B/.test(systemeDe(rIdBizarre)) && !existsSync(join(DONNEES, "chatA1.mem")), systemeDe(rIdBizarre).slice(-200));

console.log("\n4. Sans modèle d'embeddings : la recherche par les mots");
EMBEDDINGS = false;
await attendre(5200);
const FAIT3 = "Note importante : le nom de code du projet client est Albatros-77.";
const r3 = await envoyer(SEANCE_A, conversation(FAIT3, 40, "Rappelle-moi le nom de code du projet client ?"), { chat: "chatA3", autresChats: false });
verifier("le fait revient par les mots seuls", /Albatros-77/.test(systemeDe(r3)) && !r3.envoye.slice(1).some((m) => String(m.content).includes("Albatros-77")), systemeDe(r3).slice(-500));
EMBEDDINGS = true;
await attendre(5200);

console.log("\n5. Mémoire illisible : rien n'est écrasé");
const cible = fichiersMemoire().find((f) => f.endsWith("chatA3.mem"));
let intacte = false;
let reponduQuandMeme = false;
if (cible) {
  const abime = Buffer.from(readFileSync(cible));
  abime[abime.length - 5] ^= 0xff;
  writeFileSync(cible, abime);
  const rAbime = await envoyer(SEANCE_A, conversation(FAIT3, 44, "Et le nom de code, déjà ?"), { chat: "chatA3", autresChats: false });
  intacte = readFileSync(cible).equals(abime);
  reponduQuandMeme = /Réponse d'essai/.test(rAbime.reponse);
}
verifier("une mémoire abîmée n'est pas remplacée par une mémoire vide ni réécrite (octets identiques)", intacte, cible ?? "pas de fichier");
verifier("et la réponse arrive quand même, sans extraits", reponduQuandMeme, "");
verifier("le journal le dit", /\[memoire\] .*illisible|\[memoire\] .*abîmée|rien rangé pour le Chat chatA3/.test(journal), journal.split("\n").filter((l) => l.includes("[memoire]")).slice(-4).join(" | "));

console.log("\n6. Export, suppression du Chat, bouton « Effacer la mémoire de ce Chat », effacement du compte");
const exportA = await (await appel("/helix/export", { headers: avecA })).json().catch(() => ({}));
const memoiresExport = JSON.stringify(exportA.memoireDesConversations ?? null);
verifier("l'export RGPD contient la mémoire de ses Chats, en texte, sans vecteurs", /4521B/.test(memoiresExport) && /chatA1/.test(memoiresExport) && !/vecteurs/.test(memoiresExport), memoiresExport.slice(0, 300));
verifier("et dit la mémoire illisible qu'il n'a pas pu lire", (exportA.nonInclus ?? []).some((l) => /Mémoire des conversations : 1 mémoire/.test(l)), JSON.stringify(exportA.nonInclus ?? []).slice(-300));
const exportB = await (await appel("/helix/export", { headers: avecB })).json().catch(() => ({}));
verifier("l'export de la collègue ne contient rien de la mémoire de l'autre", !JSON.stringify(exportB).includes("4521B") && (exportB.memoireDesConversations ?? []).length === 1, JSON.stringify(exportB.memoireDesConversations ?? null).slice(0, 200));

// Le Chat chatA1 existe dans la collection synchronisée, puis l'écran le supprime (la liste repart sans lui).
const maintenant = new Date().toISOString();
const chatA1 = { id: "chatA1", title: "Entrepôt", ownerId: ID_A, visibility: "prive", origin: "local", messages: [], createdAt: maintenant, updatedAt: maintenant };
const ecrit1 = await appel("/helix/data/sessions", { method: "PUT", headers: avecA, body: JSON.stringify({ value: [chatA1] }) });
const avantSuppression = fichiersMemoire().filter((f) => f.endsWith("chatA1.mem")).length;
const ecrit2 = await appel("/helix/data/sessions", { method: "PUT", headers: avecA, body: JSON.stringify({ value: [] }) });
const apresSuppression = fichiersMemoire().filter((f) => f.endsWith("chatA1.mem")).length;
verifier(
  "supprimer le Chat efface sa mémoire, celle de chaque personne qui y a parlé (les deux)",
  ecrit1.ok && ecrit2.ok && avantSuppression === 2 && apresSuppression === 0,
  `${ecrit1.status} ${ecrit2.status} : ${avantSuppression} puis ${apresSuppression}`,
);
const rApres = await envoyer(SEANCE_A, court, { chat: "chatA2", autresChats: true });
verifier("et le fait ne revient plus de nulle part", !/4521B/.test(systemeDe(rApres)), systemeDe(rApres).slice(-200));

const avantBouton = fichiersMemoire().filter((f) => f.endsWith("chatA3.mem")).length;
const bSurA = await appel("/helix/memoire-chat/chatA3", { method: "DELETE", headers: avecB });
const encore = fichiersMemoire().filter((f) => f.endsWith("chatA3.mem")).length;
const bouton = await appel("/helix/memoire-chat/chatA3", { method: "DELETE", headers: avecA });
const corpsBouton = await bouton.json().catch(() => ({}));
const sansSeance = await appel("/helix/memoire-chat/chatA3", { method: "DELETE", headers: avecJeton });
verifier(
  "« Effacer la mémoire de ce Chat » : la collègue n'efface que la sienne (rien chez l'autre), la titulaire efface la sienne, sans séance : refusé",
  avantBouton === 1 && bSurA.ok && encore === 1 && bouton.ok && corpsBouton.effacee === true && fichiersMemoire().filter((f) => f.endsWith("chatA3.mem")).length === 0 && sansSeance.status === 401,
  `${avantBouton} ${bSurA.status} ${encore} ${bouton.status} ${JSON.stringify(corpsBouton)} ${sansSeance.status}`,
);

// La collègue reparle (une mémoire à elle), puis supprime son compte.
await envoyer(SEANCE_B, conversation("Le badge de l'atelier est le 77.", 40, "Quel badge ?", "B2 "), { chat: "chatB9", autresChats: false });
const dossiersAvant = readdirSync(dossierMemoire).length;
const efface = await appel("/helix/compte/effacer", { method: "POST", headers: avecB, body: JSON.stringify({ password: MDP_B }) });
const dossiersApres = (() => { try { return readdirSync(dossierMemoire).length; } catch { return 0; } })();
verifier("l'effacement du compte efface toute sa mémoire des conversations", efface.ok && dossiersApres === dossiersAvant - 1, `${efface.status} ${dossiersAvant} → ${dossiersApres}`);

console.log("\n7. Résumé au repos");
await attendre(2500);
verifier(
  "sur ce petit PC (Linux, 16 Go, processeur seul), aucun appel au modèle pour résumer : rangement tel quel",
  !RECUES.some((r) => r.stream === false && /Tu résumes fidèlement/.test(String(r.messages?.[0]?.content ?? ""))),
  RECUES.filter((r) => r.stream === false).length,
);
// La fonction seule, comme sur une machine confortable : elle attend que rien ne tourne, puis résume et range le résumé.
const u = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--no-warnings",
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(join(RACINE, "gateway", "src", "memoireConversation.ts"))});
     const elements = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "personne", texte: "Message " + i + " : le stock de vis numéro " + i + " est à commander." }));
     await m.ranger("u1", "chatR", elements);
     const fin = m.debutDemande();
     let appels = 0;
     m.planifierResume("u1", "chatR", async (texte) => { appels++; return "Résumé : les vis 0 à 13 sont à commander. " + (texte.includes("Message 0") ? "ok" : ""); });
     await new Promise((r) => setTimeout(r, 900));
     const pendant = appels;
     fin();
     await new Promise((r) => setTimeout(r, 1500));
     const ex = m.pourExport("u1");
     const resume = ex.chats[0]?.entrees.find((e) => e.role === "resume");
     process.env.HELIX_MEMOIRE_RESUME = "non";
     console.log(JSON.stringify({ pendant, apres: appels, resume: resume?.texte ?? null, petit: m.machineConfortable() }));`,
  ],
  {
    cwd: RACINE,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...ENV, HELIX_DATA_DIR: join(ICI, "u"), HELIX_MEMOIRE_RESUME: "oui", HELIX_MEMOIRE_REPOS_MS: "700", HELIX_LMSTUDIO_URL: "http://127.0.0.1:9/v1" },
  },
);
let fx = {};
try {
  fx = JSON.parse((u.stdout ?? "").trim().split("\n").at(-1));
} catch {
  fx = { erreur: `${u.stdout ?? ""}${u.stderr ?? ""}`.slice(-500) };
}
verifier(
  "machine confortable : le résumé attend qu'aucune demande ne tourne, puis est fait une fois et rangé dans la mémoire (rôle « résumé »)",
  fx.pendant === 0 && fx.apres === 1 && /Résumé : les vis 0 à 13 sont à commander\. ok/.test(fx.resume ?? "") && fx.petit === false,
  JSON.stringify(fx).slice(0, 400),
);

const mesure = journal.split("\n").filter((l) => /^\[memoire\] Chat chatA1 : /.test(l));
console.log(`\n  Mesures : première question du long Chat (rangement de ${fil1.length - r1.envoye.length} messages et recherche) ${duree1} ms ; ${mesure.slice(0, 2).join(" | ")}`);

passerelle.kill();
lm.close();
await attendre(300);
verifier("aucun appel au trousseau macOS (dossier personnel jetable, clé par fichier)", !existsSync(join(ICI, "security.log")), "security appelé");
if (echecs.length > 0 || process.env.ESSAI_JOURNAL) console.log(journal.split("\n").filter((l) => /^\[(chat|helix|memoire)\]/.test(l)).join("\n").slice(-5000));
rmSync(ICI, { recursive: true, force: true });
console.log(`\n${reussis} réussi(s), ${echecs.length} échec(s)`);
process.exit(echecs.length > 0 ? 1 : 0);
