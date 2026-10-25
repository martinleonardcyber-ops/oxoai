/*
 * Le moteur ouvert (llama.cpp) de bout en bout, avec le vrai llama.cpp et un
 * vrai modèle.
 *
 *   node scripts/essai-llamacpp.mjs
 *
 * Écrit le 28/09/2026 (gateway/src/llamaCpp.ts). Sur un Mac Intel, c'est le
 * moteur par défaut ; ailleurs, `OXOAI_MOTEUR=llamacpp` le choisit, et c'est
 * ce que fait cet essai (sur un Mac à puce Apple, l'archive arm64 de la même
 * publication). Une passerelle jetable (dossier personnel, données neuves,
 * clé en fichier, faux `security`, LM Studio éteint) :
 *  - l'écran de mise en route voit « llama.cpp », sans conditions à accepter ;
 *  - l'installation du moteur (route de l'administrateur) télécharge
 *    l'archive épinglée, vérifie son empreinte, et enchaîne sur le modèle
 *    conseillé pour cette machine ;
 *  - un téléchargement coupé (passerelle arrêtée) reprend où il en était ;
 *  - le modèle est chargé, passe l'essai de santé, répond dans le Chat, en
 *    flux, avec et sans réflexion, et appelle un outil ;
 *  - le serveur écoute sur 127.0.0.1 seulement et refuse une requête sans
 *    sa clé ; il s'arrête avec la passerelle.
 *
 * `OXOAI_ESSAI_DONNEES=<dossier>` garde les données (moteur et modèles) d'une
 * fois sur l'autre : le modèle ne se retélécharge pas. Sans lui, tout vit dans
 * un dossier temporaire, effacé à la fin (1,8 Go téléchargés à chaque fois).
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  console.log("Essai prévu pour macOS (archives épinglées : macos-x64 et macos-arm64).");
  process.exit(2);
}
const portLibre = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = mkdtempSync(join(tmpdir(), "oxoai-essai-llamacpp-"));
const MAISON = join(TMP, "maison");
const DONNEES = process.env.OXOAI_ESSAI_DONNEES ?? join(TMP, "donnees");
const BIN = join(TMP, "bin");
for (const d of [MAISON, DONNEES, BIN]) mkdirSync(d, { recursive: true });
writeFileSync(join(BIN, "security"), `#!/bin/sh\necho "$@" >> "${join(TMP, "security.log")}"\nexit 44\n`);
chmodSync(join(BIN, "security"), 0o755);
const PATH = [BIN, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
writeFileSync(join(TMP, "profil.json"), JSON.stringify({ chiffrement: "fichier" }));

const PORT = await portLibre();
const PORT_LLAMA = await portLibre();
const G = `http://127.0.0.1:${PORT}`;
const LLAMA = join(DONNEES, "llamacpp");

let passerelle = null;
let journal = "";
function demarrer() {
  passerelle = spawn(process.execPath, [join(RACINE, "gateway", "src", "index.ts")], {
    env: {
      PATH,
      HOME: MAISON,
      LANG: "C",
      OXOAI_CONFIG: join(TMP, "profil.json"),
      OXOAI_DATA_DIR: DONNEES,
      OXOAI_GATEWAY_PORT: String(PORT),
      OXOAI_MOTEUR: "llamacpp",
      OXOAI_LLAMACPP_PORT: String(PORT_LLAMA),
      OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
      OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  passerelle.stdout.on("data", (b) => (journal += b));
  passerelle.stderr.on("data", (b) => (journal += b));
}
async function arreter() {
  if (!passerelle || passerelle.exitCode !== null) return;
  const lui = passerelle;
  const fin = new Promise((r) => lui.once("exit", r));
  lui.kill("SIGTERM");
  await Promise.race([fin, attendre(10_000)]);
  if (lui.exitCode === null) lui.kill("SIGKILL");
}
/** Les `llama-server` qui tournent depuis ce dossier de données (par chemin, jamais par nom seul). */
function serveursDeLEssai() {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(join(LLAMA, "b11146", "llama-server")))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
  } catch {
    return [];
  }
}

const vivant = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let reussis = 0;
const echecs = [];
const verifier = (nom, ok, obtenu) => {
  if (ok) {
    reussis++;
    console.log(`  ✓ ${nom}`);
  } else {
    echecs.push(nom);
    console.log(`  ✗ ${nom}  —  obtenu : ${String(obtenu).slice(0, 500)}`);
  }
};

let JETON = "";
let seance = "";
const avecSeance = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Session": seance });
const appel = (chemin, options = {}) => fetch(`${G}${chemin}`, { headers: avecSeance(), ...options });
const json = async (chemin, options) => (await appel(chemin, options)).json().catch(() => ({}));
async function pret() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${G}/health`);
      return;
    } catch {
      await attendre(250);
    }
  }
  throw new Error(`passerelle muette :\n${journal.slice(-2000)}`);
}
async function suivreProvision(jusqua, delaiMs) {
  const fin = Date.now() + delaiMs;
  let etat = {};
  while (Date.now() < fin) {
    etat = (await json("/oxoai/provision")).state ?? {};
    if (jusqua(etat)) return etat;
    await attendre(1000);
  }
  return etat;
}

try {
  demarrer();
  await pret();
  JETON = readFileSync(join(DONNEES, "instance-token"), "utf8").trim();
  const compte = await (
    await fetch(`${G}/oxoai/auth/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JETON}` },
      body: JSON.stringify({ fullName: "Essai llama.cpp", email: "essai-llamacpp@example.test", password: "Essai2Llama!Solide42" }),
    })
  ).json();
  seance = compte.session?.token ?? "";

  console.log("\nÉcran de mise en route");
  const statut = await json("/oxoai/provision");
  verifier("le moteur présenté est llama.cpp", statut.moteur === "llamacpp", statut.moteur);
  verifier("rien d'installé au départ (sauf données gardées)", statut.moteurInstalle === existsSync(join(LLAMA, "b11146", "llama-server")), statut.moteurInstalle);
  verifier("poste non piloté par l'intégrateur : l'installation est proposée", statut.managed === false, statut.managed);
  verifier(
    "catalogue réduit aux modèles GGUF épinglés (Qwen3 1.7B, 4B, 8B, 30B A3B)",
    JSON.stringify((statut.catalog ?? []).map((c) => c.key).sort()) === JSON.stringify(["qwen/qwen3-30b-a3b", "qwen3-1.7b", "qwen3-4b", "qwen3-8b"]),
    (statut.catalog ?? []).map((c) => c.key),
  );
  const conseil = statut.recommended?.key;
  verifier("un modèle conseillé pour cette machine, pris dans ce catalogue", ["qwen3-1.7b", "qwen3-4b", "qwen3-8b", "qwen/qwen3-30b-a3b"].includes(conseil), conseil);
  const sansSeance = await fetch(`${G}/oxoai/provision/moteur`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${JETON}` }, body: "{}" });
  verifier("installer le moteur demande une séance", sansSeance.status === 401, sansSeance.status);

  console.log("\nInstallation du moteur, sans conditions à accepter");
  const lance = await appel("/oxoai/provision/moteur", { method: "POST", body: "{}" });
  verifier("installation acceptée sans `conditionsAcceptees`", lance.status === 202, lance.status);
  // Le moteur (11 Mo), puis le téléchargement du modèle conseillé commence.
  const enCours = await suivreProvision((e) => (e.phase === "downloading" && e.model) || e.phase === "error" || e.phase === "ready", 5 * 60_000);
  verifier("moteur posé à la version épinglée", existsSync(join(LLAMA, "b11146", "llama-server")), readdirSync(LLAMA).join(","));
  verifier("le modèle conseillé se télécharge ensuite", enCours.model === conseil || enCours.phase === "ready", JSON.stringify(enCours));
  const version = execFileSync(join(LLAMA, "b11146", "llama-server"), ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
  verifier("llama-server démarre (--version)", true, version);
  const audit = readdirSync(join(DONNEES, "audit")).map((n) => readFileSync(join(DONNEES, "audit", n), "utf8")).join("");
  verifier("installation inscrite au journal", audit.includes("moteur.llamacpp_installation"), audit.slice(-300));

  // Le conseillé peut être gros (Qwen3 8B, 5 Go, sur un Mac de 16 Go) : l'essai s'arrête, et passe au plus léger.
  if (enCours.phase === "downloading") {
    await attendre(4000);
    await arreter();
    const partiels = existsSync(join(LLAMA, "modeles")) ? readdirSync(join(LLAMA, "modeles")).filter((n) => n.endsWith(".partiel")) : [];
    verifier("arrêt en plein téléchargement : un `.partiel` reste, rien sous le nom définitif", partiels.length === 1, readdirSync(join(LLAMA, "modeles")).join(","));
    for (const p of partiels) if (!p.startsWith("Qwen3-1.7B")) rmSync(join(LLAMA, "modeles", p));
    verifier("aucun llama-server laissé derrière la passerelle", serveursDeLEssai().length === 0, serveursDeLEssai());
    demarrer();
    await pret();
  }

  console.log("\nQwen3 1.7B : téléchargement coupé, repris, vérifié");
  const leger = "Qwen3-1.7B-Q8_0.gguf";
  if (!existsSync(join(LLAMA, "modeles", leger))) {
    await appel("/oxoai/provision/start", { method: "POST", body: JSON.stringify({ model: "qwen3-1.7b" }) });
    const partiel = join(LLAMA, "modeles", `${leger}.partiel`);
    for (let i = 0; i < 600 && !(existsSync(partiel) && statSync(partiel).size > 300_000_000); i++) await attendre(500);
    const avant = existsSync(partiel) ? statSync(partiel).size : 0;
    await arreter();
    verifier("coupé en route (plus de 300 Mo reçus)", avant > 300_000_000, avant);
    demarrer();
    await pret();
    await appel("/oxoai/provision/start", { method: "POST", body: JSON.stringify({ model: "qwen3-1.7b" }) });
    await attendre(3000);
    const repris = existsSync(partiel) ? statSync(partiel).size : -1;
    verifier("la reprise part de ce qui était reçu (requête `Range`)", repris >= avant || existsSync(join(LLAMA, "modeles", leger)), `${avant} → ${repris}`);
  } else {
    await appel("/oxoai/provision/start", { method: "POST", body: JSON.stringify({ model: "qwen3-1.7b" }) });
  }
  const fini = await suivreProvision((e) => e.phase === "ready" || e.phase === "error", 30 * 60_000);
  verifier("Qwen3 1.7B téléchargé, empreinte vérifiée, chargé, essai de santé passé", fini.phase === "ready", JSON.stringify(fini));
  verifier("fichier du modèle à sa taille publiée", statSync(join(LLAMA, "modeles", leger)).size === 1_834_426_016, statSync(join(LLAMA, "modeles", leger)).size);

  console.log("\nLe serveur");
  const cle = readFileSync(join(LLAMA, "cle"), "utf8").trim();
  verifier("clé du serveur lisible par ce compte seul (0600)", (statSync(join(LLAMA, "cle")).mode & 0o777) === 0o600, (statSync(join(LLAMA, "cle")).mode & 0o777).toString(8));
  const sansCle = await fetch(`http://127.0.0.1:${PORT_LLAMA}/v1/models`).catch(() => null);
  verifier("sans la clé, le serveur refuse (401)", sansCle?.status === 401, sansCle?.status);
  const liste = await (await fetch(`http://127.0.0.1:${PORT_LLAMA}/v1/models`, { headers: { Authorization: `Bearer ${cle}` } })).json();
  verifier("avec la clé, il liste le modèle sous le nom du catalogue", (liste.data ?? []).some((m) => m.id === "qwen3-1.7b"), JSON.stringify(liste).slice(0, 300));
  const ecoute = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${PORT_LLAMA}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  verifier("écoute sur 127.0.0.1 seulement", ecoute.includes(`127.0.0.1:${PORT_LLAMA}`) && !ecoute.includes(`*:${PORT_LLAMA}`), ecoute);
  const webui = await fetch(`http://127.0.0.1:${PORT_LLAMA}/`, { headers: { Authorization: `Bearer ${cle}` } });
  const page = await webui.text();
  verifier("pas d'interface web", !/<html/i.test(page), `${webui.status} ${page.slice(0, 80)}`);

  console.log("\nDans le Chat");
  const modeles = await json("/v1/models");
  // La liste de la passerelle nomme chaque modèle par sa source : « llamacpp/qwen3-1.7b ».
  const lui = (modeles.data ?? []).find((m) => m.id === "llamacpp/qwen3-1.7b");
  verifier("le Chat voit Qwen3 1.7B, servi par llama.cpp", Boolean(lui), JSON.stringify(modeles).slice(0, 400));
  const flux = async (corps) => (await appel("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "llamacpp/qwen3-1.7b", stream: true, ...corps }) })).text();
  const texteDe = (sse) =>
    sse
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
  const sansReflexion = await flux({ effort: "aucun", messages: [{ role: "user", content: "Quelle est la capitale de la France ? Réponds en un mot." }] });
  verifier("réponse en flux, sans réflexion : « Paris »", /paris/i.test(texteDe(sansReflexion)), texteDe(sansReflexion) || sansReflexion.slice(-400));
  const avecReflexion = await flux({ effort: "moyen", messages: [{ role: "user", content: "Combien font 17 fois 3 ? Donne juste le nombre." }] });
  verifier("réponse avec réflexion : 51", /51/.test(texteDe(avecReflexion)), texteDe(avecReflexion) || avecReflexion.slice(-400));
  const outil = await flux({
    effort: "aucun",
    messages: [{ role: "user", content: "Quel temps fait-il à Lyon ? Utilise l'outil meteo." }],
    tools: [{ type: "function", function: { name: "meteo", description: "Donne la météo d'une ville.", parameters: { type: "object", properties: { ville: { type: "string" } }, required: ["ville"] } } }],
  });
  if (process.env.OXOAI_ESSAI_FLUX_OUTIL) writeFileSync(process.env.OXOAI_ESSAI_FLUX_OUTIL, outil);
  // Les arguments arrivent en morceaux (« L », « yon ») : on les recolle, comme le fait un client.
  const argumentsRecus = outil
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .flatMap((l) => {
      try {
        return (JSON.parse(l.slice(6)).choices?.[0]?.delta?.tool_calls ?? []).map((c) => c.function?.arguments ?? "");
      } catch {
        return [];
      }
    })
    .join("");
  verifier(
    "le modèle appelle l'outil fourni, arguments complets (analyse des appels par llama.cpp)",
    /"name":"meteo"/.test(outil) && /"ville":\s*"Lyon"/.test(argumentsRecus),
    argumentsRecus || outil.slice(-600),
  );

  /*
   * Passerelle tuée net (28/09/2026) : le llama-server qu'elle laisse était
   * gardé au redémarrage, sans que personne ne sache plus l'arrêter (il
   * survivait à la fermeture de OxoAI) ni lui faire voir un modèle posé
   * depuis. Il est désormais arrêté par son PID, puis remplacé.
   */
  console.log("\nPasserelle tuée net");
  const orphelins = serveursDeLEssai();
  passerelle.kill("SIGKILL");
  await attendre(1500);
  verifier("son llama-server lui survit (orphelin)", orphelins.length >= 1 && orphelins.every(vivant), orphelins);
  demarrer();
  await pret();
  await json("/oxoai/provision");
  let remplacants = [];
  for (let i = 0; i < 60; i++) {
    remplacants = serveursDeLEssai();
    if (remplacants.length >= 1 && orphelins.every((pid) => !vivant(pid))) break;
    await attendre(500);
  }
  verifier(
    "au redémarrage, l'orphelin est arrêté (par son PID) et remplacé",
    orphelins.every((pid) => !vivant(pid)) && remplacants.length >= 1 && remplacants.every((pid) => !orphelins.includes(pid)),
    `avant ${orphelins.join(",")} après ${remplacants.join(",")}`,
  );
  const encore = await flux({ effort: "aucun", messages: [{ role: "user", content: "Quelle est la capitale de l'Italie ? Réponds en un mot." }] });
  // « Roma » compte aussi : un petit modèle répond parfois dans la langue de la ville (vu le 28/09/2026 avec Qwen3 1.7B).
  verifier("le Chat répond encore, par le nouveau serveur : « Rome »", /\brom[ea]\b/i.test(texteDe(encore)), texteDe(encore) || encore.slice(-400));

  console.log("\nArrêt");
  const avantArret = serveursDeLEssai();
  verifier("llama-server tourne pendant la séance", avantArret.length >= 1, avantArret);
  await arreter();
  await attendre(1500);
  verifier("il s'arrête avec la passerelle (routeur et modèle)", serveursDeLEssai().length === 0, serveursDeLEssai());
} catch (err) {
  echecs.push(String(err));
  console.log(`  ✗ ${err instanceof Error ? err.stack : err}`);
} finally {
  await arreter();
  for (const pid of serveursDeLEssai()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* parti */
    }
  }
  if (echecs.length && process.env.OXOAI_ESSAI_BAVARD) console.log(journal.slice(-4000));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${reussis} réussis, ${echecs.length} échecs`);
process.exit(echecs.length ? 1 : 0);
