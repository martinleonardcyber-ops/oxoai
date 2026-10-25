/**
 * Vérifie les notes (Epoch AI), les prix publiés et leur usage, sans réseau ni modèle :
 * `node scripts/essai-notes-modeles.mjs` (Node 23.6 ou plus ; sinon ajouter --experimental-strip-types).
 *
 * Écrit le 27/09/2026 : Medhi voyait qu'aucun modèle cloud n'apparaissait dans « Comparer
 * les modèles ». Les identifiants essayés sont ceux que rendent les fournisseurs et LM Studio
 * (documentations et catalogue LM Studio), préfixés comme l'instance les préfixe.
 * La partie « Mon usage » tourne dans un processus à part, sur un dossier de données jetable :
 * rien du poste n'est lu ni écrit, et aucun moteur n'est appelé (port 9 : fermé).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (f) => import(pathToFileURL(join(RACINE, "gateway", "src", f)).href);
let echecs = 0;
const verifier = (nom, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${nom}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) echecs++;
};

/*
 * Même ce processus-ci ne lit rien du poste : le catalogue d'installation
 * consulte l'état des modèles de la machine (santeModeles.ts), qu'on prend
 * dans un dossier vide, et la clé de chiffrement est en fichier, pour que le
 * trousseau ne soit jamais sollicité.
 */
if (!process.argv.includes("--enfant-usage")) {
  const vide = mkdtempSync(join(tmpdir(), "oxoai-essai-notes-parent-"));
  writeFileSync(join(vide, "oxoai.config.json"), JSON.stringify({ chiffrement: "fichier" }));
  process.env.OXOAI_DATA_DIR = join(vide, "donnees");
  process.env.OXOAI_CONFIG = join(vide, "oxoai.config.json");
  process.env.OXOAI_LMSTUDIO_URL = "http://127.0.0.1:9/v1";
  process.env.OXOAI_EXO_URL = "http://127.0.0.1:9/v1";
  process.on("exit", () => rmSync(vide, { recursive: true, force: true }));
}

/* ------------------------------------------------------------------ */
/* Partie « Mon usage », dans le processus enfant                      */
/* ------------------------------------------------------------------ */
if (process.argv.includes("--enfant-usage")) {
  const u = await mod("usage.ts");
  const sortie = {};
  const c = { entree: 2_000_000, sortie: 1_000_000, requetesEstimees: 0 };
  const publie = { entree: 0.1, sortie: 0.4, devise: "USD", fournisseur: "OpenAI", page: "https://platform.openai.com/docs/pricing", releveLe: "2026-09-27" };
  sortie.publie = u.coutDuModele(c, false, undefined, publie);
  sortie.saisi = u.coutDuModele(c, false, { entree: 1, sortie: 3, devise: "USD", depuis: "2026-09-27T10:00:00Z", par: "essai" }, publie);
  sortie.inconnu = u.coutDuModele(c, false, undefined, null);
  sortie.local = u.coutDuModele(c, true, { entree: 1, sortie: 3, depuis: "", par: "" }, publie);
  sortie.ancien = u.coutDuModele(c, false, { entree: 1, sortie: 3, depuis: "2026-09-20T10:00:00Z", par: "essai" }, null);
  sortie.prixCle = u.prixPublieDe("cle-537cdd45fe/gpt-4.1-nano", { id: "cle-537cdd45fe", kind: "openai-compatible", catalogue: "openai", baseUrl: "https://api.openai.com/v1" });
  sortie.prixLocal = u.prixPublieDe("lmstudio/gpt-oss-20b", { id: "lmstudio", kind: "lmstudio" });
  sortie.prixAutre = u.prixPublieDe("cle-9/gpt-4.1-nano", { id: "cle-9", kind: "openai-compatible", catalogue: "compatible", baseUrl: "https://llm.exemple.fr/v1" });

  // Tarifs et registre présents mais illisibles : rien n'est écrit par-dessus.
  const dossier = process.env.OXOAI_DATA_DIR;
  const abime = '{"value": {"cle-1/gpt-4.1": {"entree": 2, "sortie"';
  writeFileSync(join(dossier, "tarifs.json"), abime);
  writeFileSync(join(dossier, "usage.json"), abime);
  sortie.definir = await u.definirTarif({ modele: "cle-1/gpt-4.1", entree: 1, sortie: 1 }, "essai");
  u.enregistrer("essai", { uid: "cle-1/gpt-4.1", backendId: "cle-1", backendKind: "openai-compatible" }, { entree: 10, sortie: 10, raisonnement: 0, exacte: true });
  await new Promise((ok) => setTimeout(ok, 300));
  const rapport = await u.rapport("essai", "jour");
  sortie.illisibles = rapport.tarifsIllisibles;
  sortie.tarifsIntacts = readFileSync(join(dossier, "tarifs.json"), "utf8") === abime;
  sortie.registreIntact = readFileSync(join(dossier, "usage.json"), "utf8") === abime;
  console.log(JSON.stringify(sortie));
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Correspondance des noms                                             */
/* ------------------------------------------------------------------ */
const n = await mod("notesModeles.ts");
const p = await mod("prixPublies.ts");

console.log("Notes ECI : identifiants réels de l'instance");
/** [identifiant, fournisseur cloud ou undefined pour la machine, nom Epoch attendu ou null] */
const CAS = [
  // Cloud, branchés par une clé (préfixe « cle-… » ajouté par l'instance).
  ["cle-537cdd45fe/gpt-4.1-nano", "openai", "GPT-4.1 nano"],
  ["cle-537cdd45fe/gpt-4.1-nano-2025-04-14", "openai", "GPT-4.1 nano"],
  ["cle-537cdd45fe/gpt-5.6-luna", "openai", "GPT-5.6 Luna"],
  ["cle-537cdd45fe/gpt-5-2025-08-07", "openai", "GPT-5"],
  ["cle-537cdd45fe/o3", "openai", "o3"],
  ["cle-537cdd45fe/gpt-4o-2024-08-06", "openai", "GPT-4o (Aug 2024)"],
  ["cle-537cdd45fe/gpt-4o", "openai", null], // trois instantanés notés séparément : ambigu
  ["cle-a1b2c3d4e5/claude-sonnet-4-5-20250929", "anthropic", "Claude Sonnet 4.5"],
  ["cle-a1b2c3d4e5/claude-opus-4-5", "anthropic", "Claude Opus 4.5"],
  ["cle-a1b2c3d4e5/claude-3-5-haiku-latest", "anthropic", "Claude 3.5 Haiku"],
  ["cle-f00dcafe01/gemini-2.5-flash", "google", "Gemini 2.5 Flash (Jun 2025)"],
  ["cle-f00dcafe01/gemini-3.1-pro-preview", "google", "Gemini 3.1 Pro"],
  ["cle-f00dcafe01/gemini-3.8-flash", "google", "Gemini 3.8 Flash"],
  ["cle-0123456789/mistral-medium-latest", "mistral", "Mistral Medium 3.5"],
  ["cle-0123456789/mistral-medium-3", "mistral", "Mistral Medium 3.5"], // pas le Mistral Medium 3 de 2025
  ["cle-0123456789/ministral-3b-latest", "mistral", null], // Ministral 3 3B, non noté ; pas le Ministral 3B de 2024
  ["cle-0123456789/magistral-small-2509", "mistral", "Magistral Small 1.2"],
  ["cle-dee95eek00/deepseek-flash", "deepseek", "DeepSeek V4.1 Flash"],
  ["cle-dee95eek00/deepseek-v4-flash", "deepseek", "DeepSeek V4.1 Flash"], // servi par V4.1 Flash, dit la page
  ["cle-9a9a9a9a9a/grok-4.20-0309-reasoning", "xai", "Grok 4.20"],
  ["cle-0f0f0f0f0f/openai/gpt-oss-120b", "openrouter", "gpt-oss-120b"],
  ["cle-0f0f0f0f0f/qwen/qwen3.8-27b", "groq", "Qwen 3.8 27B"],
  // Sur la machine (LM Studio), sans renvoi de fournisseur.
  ["qwen3-8b", undefined, "Qwen3-8B"],
  ["lmstudio/qwen3-8b-mlx-4bit", undefined, "Qwen3-8B"],
  ["qwen/qwen3.5-9b", undefined, "Qwen3.5-9B"],
  ["qwen/qwen3.8-27b", undefined, "Qwen 3.8 27B"],
  ["qwen/qwen3-30b-a3b", undefined, "Qwen3-30B-A3B"],
  ["qwen/qwen3.5-35b-a3b", undefined, "Qwen3.5-35B-A3B"],
  ["openai/gpt-oss-20b", undefined, "gpt-oss-20b"],
  ["mistralai/magistral-small-2509", undefined, "Magistral Small 1.2"],
  ["deepseek/deepseek-v4-flash", undefined, "DeepSeek-V4-Flash"], // les poids d'avril, pas V4.1
  ["google/gemma-3-4b", undefined, "Gemma 3 4B"],
  ["meta-llama/Llama-3.1-8B-Instruct", undefined, "Llama 3.1-8B"],
  ["qwen3.5-4b@q4_k_m", undefined, null],
  ["mistralai/ministral-3-3b", undefined, null], // surtout pas « Ministral 3B » (2024)
  ["qwen3-4b", undefined, null], // surtout pas la note de Qwen3-8B
  ["qwen3-vl-8b", undefined, null],
  ["zai-org/glm-4.7-flash", undefined, null], // surtout pas GLM-4.7
  ["qwen/qwen3-30b-a3b-2507", undefined, null], // une date courte désigne un autre modèle
  // Inconnus.
  ["cle-5e5e5e5e5e/modele-maison-v2", "compatible", null],
  ["", undefined, null],
];
for (const [id, fournisseur, attendu] of CAS) {
  const m = n.noteDuModele(id, fournisseur);
  verifier(`${id || "(vide)"} → ${attendu ?? "pas de note"}`, (m?.nom ?? null) === attendu, m ? `${m.nom} ${m.eci}` : "rien");
}
verifier(
  "renvoi du fournisseur seulement pour un modèle cloud : deepseek-v4-flash local reste DeepSeek-V4-Flash",
  n.noteDuModeleServi({ id: "deepseek/deepseek-v4-flash", origine: "local", catalogue: "deepseek" })?.nom === "DeepSeek-V4-Flash" &&
    n.noteDuModeleServi({ id: "deepseek-v4-flash", origine: "cle", catalogue: "deepseek" })?.nom === "DeepSeek V4.1 Flash",
);
verifier("valeur recopiée telle que publiée (Qwen3-8B : 136.17, GPT-6 Astra : 166.6)", n.noteDuModele("qwen3-8b")?.eci === 136.17 && n.noteDuModele("gpt-6-astra")?.eci === 166.6);

console.log("\nTable des notes et attribution");
const noms = new Set(n.MODELES_NOTES.map((m) => m.nom));
verifier(`${n.MODELES_NOTES.length} modèles notés, noms uniques`, n.MODELES_NOTES.length === 217 && noms.size === n.MODELES_NOTES.length);
verifier(
  "chaque note est un nombre publié plausible, chaque date AAAA-MM-JJ depuis 2024",
  n.MODELES_NOTES.every((m) => Number.isFinite(m.eci) && m.eci > 50 && m.eci < 200 && /^20(2[4-9])-\d\d-\d\d$/.test(m.sortie)),
);
verifier(
  "source nommée : Epoch AI, CC BY 4.0, page et date du relevé",
  n.SOURCE_NOTES.nom === "Epoch AI" && n.SOURCE_NOTES.licence === "CC BY 4.0" && n.SOURCE_NOTES.page.startsWith("https://epoch.ai/") && n.SOURCE_NOTES.releveLe === "2026-09-27",
);
verifier("aucun alias mobile repris (deepseek-chat, deepseek-reasoner)", !n.MODELES_NOTES.some((m) => (m.ids ?? []).some((i) => /^deepseek-(chat|reasoner)$/.test(i))));

console.log("\nPrix publiés");
const prix = (f, id, o) => {
  const r = p.prixPublie(f, id, o);
  return r ? `${r.tarif.devise} ${r.tarif.entree}/${r.tarif.sortie}` : "rien";
};
const PRIX = [
  ["openai", "gpt-4.1-nano", undefined, "USD 0.1/0.4"],
  ["openai", "gpt-4.1-nano-2025-04-14", undefined, "USD 0.1/0.4"],
  ["openai", "gpt-4o", undefined, "USD 2.5/10"],
  ["openai", "gpt-4o-2024-05-13", undefined, "USD 5/15"],
  ["openai", "gpt-4o-2024-08-06", undefined, "rien"], // la page prouve que les instantanés n'ont pas tous le même prix
  ["anthropic", "claude-sonnet-4-5-20250929", undefined, "USD 3/15"],
  ["anthropic", "claude-opus-4-1", undefined, "rien"], // retiré, pas relevé
  ["google", "gemini-3.8-flash", { le: new Date("2026-10-01T12:00:00") }, "USD 0.75/3.75"],
  ["google", "gemini-3.8-flash", { le: new Date("2027-02-01T12:00:00") }, "USD 1.5/7.5"],
  ["mistral", "mistral-small-latest", undefined, "EUR 0.12/0.5"],
  ["mistral", "mistral-small-2603", { devise: "USD" }, "USD 0.15/0.6"],
  ["mistral", "ministral-3b-2512", undefined, "EUR 0.088/0.088"],
  ["deepseek", "deepseek-v4-flash", undefined, "USD 0.3/1.2"],
  ["deepseek", "deepseek-v4-flash", { parNomSeulement: true }, "rien"],
  ["xai", "grok-4.7", undefined, "USD 2/6"],
  ["groq", "openai/gpt-oss-20b", undefined, "USD 0.075/0.3"],
  ["together", "moonshotai/Kimi-K3", undefined, "USD 3/15"],
  ["scaleway", "llama-3.3-70b-instruct", undefined, "EUR 0.9/0.9"],
  ["ovhcloud", "Meta-Llama-3_3-70B-Instruct", undefined, "EUR 0.67/0.67"],
  ["ionos", "meta-llama/Llama-3.3-70B-Instruct", undefined, "EUR 0.65/0.65"],
  ["openrouter", "openai/gpt-4.1-nano", undefined, "USD 0.1/0.4"],
  ["openai", "claude-opus-4-5", undefined, "rien"], // jamais le prix d'un autre fournisseur
  ["compatible", "gpt-4.1-nano", undefined, "rien"],
];
for (const [f, id, o, attendu] of PRIX) {
  const lu = prix(f, id, o);
  verifier(`${f} ${id}${o?.le ? ` le ${o.le.toISOString().slice(0, 10)}` : ""}${o?.devise ? ` en ${o.devise}` : ""} → ${attendu}`, lu === attendu, lu);
}
verifier(
  "fournisseur d'un backend : par son catalogue, sinon par l'hôte de son adresse, sinon aucun",
  p.fournisseurDuBackend({ catalogue: "openai" })?.id === "openai" &&
    p.fournisseurDuBackend({ baseUrl: "https://api.mistral.ai/v1" })?.id === "mistral" &&
    p.fournisseurDuBackend({ catalogue: "compatible", baseUrl: "https://llm.exemple.fr/v1" }) === undefined,
);
verifier(
  "chaque ligne a un fournisseur relevé, une devise et des prix positifs",
  p.PRIX_PUBLIES.every(
    (l) => p.FOURNISSEURS_PRIX.some((f) => f.id === l.fournisseur) && l.prix.length > 0 && l.prix.every((t) => ["EUR", "USD"].includes(t.devise) && t.entree >= 0 && t.sortie >= 0),
  ),
);
verifier(
  "chaque fournisseur cité a sa page et sa date de relevé",
  p.FOURNISSEURS_PRIX.every((f) => f.page.startsWith("https://") && /^\d{4}-\d\d-\d\d$/.test(f.releveLe)),
);
const placees = n.MODELES_NOTES.filter((m) => n.prixDeLEditeur(m));
verifier(`${placees.length} modèles notés ont un prix de leur éditeur (abscisse du graphique)`, placees.length >= 50);
verifier(
  "prix de l'éditeur pour les modèles cloud des exemples : GPT-4.1 nano 0,40 $, Claude Sonnet 4.5 15 $, Mistral Medium 3.5 7,50 $ (dollars)",
  n.prixDeLEditeur(n.noteDuModele("gpt-4.1-nano"))?.tarif.sortie === 0.4 &&
    n.prixDeLEditeur(n.noteDuModele("claude-sonnet-4-5"))?.tarif.sortie === 15 &&
    n.prixDeLEditeur(n.noteDuModele("Mistral Medium 3.5"))?.tarif.sortie === 7.5,
);
verifier("l'ancien DeepSeek V4 Flash ne prend pas le prix du nouveau", n.prixDeLEditeur(n.noteDuModele("deepseek/deepseek-v4-flash")) === undefined);

console.log("\nCatalogue d'installation");
const prov = await mod("provision.ts");
const fiche = (k) => prov.CATALOG.find((e) => e.key === k);
verifier("Qwen3 8B noté 136.17, Qwen3.5 4B sans note", fiche("qwen3-8b")?.eci === 136.17 && fiche("qwen/qwen3.5-4b")?.eci === undefined);
// Hors requête, la passerelle parle anglais (langue de base) : on vérifie la forme, pas la langue.
const lignes = (k) => (fiche(k)?.description ?? "").split("\n");
verifier(
  "la note sur sa propre ligne, source nommée, et « pas de note » dit comme tel",
  lignes("qwen3-8b").length === 2 && /Epoch AI/.test(lignes("qwen3-8b")[1]) && /136\.17/.test(lignes("qwen3-8b")[1]) &&
    lignes("qwen3-4b").length === 2 && /Epoch AI/.test(lignes("qwen3-4b")[1]) && !/\d/.test(lignes("qwen3-4b")[1]),
  JSON.stringify([fiche("qwen3-8b")?.description, fiche("qwen3-4b")?.description]),
);
const pc = (Go) => ({ platform: "win32", arch: "x64", totalMemoryGb: Go, cpuCount: 8, appleSilicon: false });
verifier("PC de 16 Go sans carte : Qwen3 8B (noté) avant Qwen3.5 4B (non noté)", prov.recommend(pc(16)).key === "qwen3-8b");
verifier("PC de 8 Go sans carte : aucun modèle noté ne tient, le plus lourd d'abord (Qwen3.5 4B)", prov.recommend(pc(8)).key === "qwen/qwen3.5-4b");

console.log("\nMon usage (processus à part, données jetables)");
const ICI = mkdtempSync(join(tmpdir(), "oxoai-essai-notes-"));
mkdirSync(join(ICI, "donnees"));
mkdirSync(join(ICI, "maison"));
// Clé de chiffrement en fichier, dans le dossier jetable : le trousseau du poste n'est jamais sollicité.
writeFileSync(join(ICI, "oxoai.config.json"), JSON.stringify({ chiffrement: "fichier" }));
const brut = await new Promise((ok) => {
  const enfant = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "--enfant-usage"], {
    cwd: ICI,
    env: {
      // Sans /usr/bin : même une régression ne trouverait pas `security` (le trousseau) ; elle échouerait ici, sans fenêtre.
      PATH: "/bin",
      HOME: join(ICI, "maison"),
      TMPDIR: tmpdir(),
      OXOAI_CONFIG: join(ICI, "oxoai.config.json"),
      OXOAI_DATA_DIR: join(ICI, "donnees"),
      OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
      OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let s = "";
  enfant.stdout.on("data", (b) => (s += b));
  enfant.stderr.on("data", (b) => (s += b));
  const minuterie = setTimeout(() => enfant.kill(), 60_000);
  enfant.on("close", () => {
    clearTimeout(minuterie);
    ok(s);
  });
});
rmSync(ICI, { recursive: true, force: true });
let e = {};
try {
  e = JSON.parse(brut.trim().split("\n").at(-1));
} catch {
  e = { erreur: brut.slice(-3000) };
}
verifier(
  "prix publié appliqué : 2 M d'entrée et 1 M de sortie à 0,10 $ / 0,40 $ font 0,60 $, estimé, cité",
  e.publie?.statut === "calcule" && e.publie.source === "publie" && Math.abs(e.publie.montant - 0.6) < 1e-9 && e.publie.devise === "USD" && e.publie.estime === true && e.publie.publie?.fournisseur === "OpenAI",
  JSON.stringify(e.publie ?? e),
);
verifier(
  "tarif saisi prioritaire sur le prix publié, dans sa devise",
  e.saisi?.source === "saisi" && Math.abs(e.saisi.montant - 5) < 1e-9 && e.saisi.devise === "USD",
  JSON.stringify(e.saisi),
);
verifier("modèle sans prix connu : « non renseigné », jamais zéro", e.inconnu?.statut === "non-renseigne" && !("montant" in (e.inconnu ?? {})), JSON.stringify(e.inconnu));
verifier("modèle local : gratuit, même avec un tarif ou un prix sous la main", e.local?.statut === "gratuit", JSON.stringify(e.local));
verifier("tarif ancien sans devise : lu en euros", e.ancien?.devise === "EUR" && e.ancien?.source === "saisi", JSON.stringify(e.ancien));
verifier(
  "prix publié retrouvé pour « cle-537cdd45fe/gpt-4.1-nano » (OpenAI) ; aucun pour un modèle local ni un fournisseur inconnu",
  e.prixCle?.entree === 0.1 && e.prixCle?.sortie === 0.4 && e.prixCle?.devise === "USD" && e.prixLocal === null && e.prixAutre === null,
  JSON.stringify([e.prixCle, e.prixLocal, e.prixAutre]),
);
verifier(
  "tarifs illisibles : la saisie est refusée et le fichier reste tel quel",
  e.definir?.ok === false && e.tarifsIntacts === true,
  JSON.stringify([e.definir, e.tarifsIntacts]),
);
verifier("registre illisible : une mesure n'écrit rien par-dessus", e.registreIntact === true, JSON.stringify(e.registreIntact ?? e));
verifier("tarifs illisibles : le rapport le dit", e.illisibles === true, JSON.stringify(e.illisibles ?? e));

console.log(echecs ? `\n${echecs} échec(s)` : "\ntout est bon");
process.exit(echecs ? 1 : 0);
