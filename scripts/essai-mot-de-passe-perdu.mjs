/*
 * Mot de passe oublié (23/10/2026, gateway/src/accounts.ts, index.ts,
 * electron/motDePasseOublie.cjs).
 *
 * Demandé par Medhi : « Que faire quand quelqu'un perd son mot de passe ? Ça
 * arrive souvent. » Une passerelle jetable (dossier personnel, données et
 * PATH jetables, aucun moteur), lancée avec un canal comme l'application de
 * bureau lance la sienne, et un profil qui désigne deux administratrices.
 *
 * Ce que l'essai vérifie :
 *  - réinitialisation par une administratrice : mot de passe provisoire tiré
 *    par l'instance, séances et clé d'API du collègue tombées, ancien mot de
 *    passe refusé, le provisoire n'ouvre que le choix d'un mot de passe à soi,
 *    trace au journal au nom du collègue ;
 *  - refus : non-administrateur, mot de passe de l'administratrice absent ou
 *    faux, son propre compte, une autre administratrice ;
 *  - second facteur du collègue gardé, sauf si la case est cochée ;
 *  - codes de récupération : un code redéfinit le mot de passe une fois, pas
 *    deux ; un faux est refusé ; le second facteur reste demandé ensuite ;
 *  - la machine de l'instance : le canal `mot-de-passe-local` (celui de
 *    l'application) redéfinit le mot de passe et ferme les séances, et aucune
 *    route HTTP n'y mène ;
 *  - débit limité sur `/oxoai/auth/recuperer` ;
 *  - aucun mot de passe ni code en clair dans le journal d'audit ni dans la
 *    sortie de la passerelle.
 *
 * Ce que l'essai ne prouve pas : la fenêtre Touch ID de macOS ni le fichier
 * du code sous Windows (il faut la vraie application), voir PROJET.md.
 *
 *   node scripts/essai-mot-de-passe-perdu.mjs
 */
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
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

/* Un code TOTP, comme l'application du téléphone (RFC 6238, SHA-1, six chiffres). */
function depuisBase32(texte) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of texte.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const octets = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) octets.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(octets);
}
function totp(secret, decalage = 0) {
  const pas = Math.floor(Date.now() / 30_000) + decalage;
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(pas));
  const h = createHmac("sha1", depuisBase32(secret)).update(compteur).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}

const ICI = mkdtempSync(join(tmpdir(), "oxoai-essai-mdp-"));
const BIN = join(ICI, "bin");
mkdirSync(BIN);
mkdirSync(join(ICI, "maison"));
mkdirSync(join(ICI, "espace"));
symlinkSync(process.execPath, join(BIN, "node"));
writeFileSync(join(BIN, "security"), `#!/bin/sh\necho "$*" >> "${join(ICI, "security.log")}"\nexit 1\n`);
chmodSync(join(BIN, "security"), 0o755);

const PORT = await portLibre();
const DONNEES = join(ICI, "donnees");
writeFileSync(
  join(ICI, "profil.json"),
  JSON.stringify({
    chiffrement: "fichier",
    autoProvision: false,
    backends: [{ id: "exo", enabled: false }],
    administrateurs: ["alice@example.test", "chloe@example.test"],
  }),
);
writeFileSync(
  join(ICI, "lancer.mjs"),
  `import os from "node:os";
   Object.defineProperty(process, "platform", { value: "linux" });
   os.totalmem = () => 16 * 1024 ** 3;
   (await import("node:module")).syncBuiltinESMExports();
   await import(${JSON.stringify(join(RACINE, "gateway", "src", "index.ts"))});`,
);
// Avec un canal, comme l'application de bureau lance sa passerelle (canalApplication.ts lit `process.send`).
const passerelle = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ICI, "lancer.mjs")], {
  cwd: RACINE,
  env: {
    PATH: `${BIN}:/usr/bin:/bin`,
    HOME: join(ICI, "maison"),
    TMPDIR: tmpdir(),
    OXOAI_CONFIG: join(ICI, "profil.json"),
    OXOAI_DATA_DIR: DONNEES,
    OXOAI_WORKSPACE: join(ICI, "espace"),
    OXOAI_GATEWAY_HOST: "127.0.0.1",
    OXOAI_GATEWAY_PORT: String(PORT),
    OXOAI_LMSTUDIO_URL: "http://127.0.0.1:9/v1",
    OXOAI_EXO_URL: "http://127.0.0.1:9/v1",
    OXOAI_OPENCODE_BIN: "/usr/bin/true",
    OXOAI_MEMOIRE_RESUME: "non",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  detached: true,
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
const avecJeton = { "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Langue": "fr" };
const avec = (seance) => ({ ...avecJeton, "X-OxoAI-Session": seance });
const appel = async (chemin, init = {}) => {
  try {
    const r = await fetch(`${G}${chemin}`, init);
    const texte = await r.text();
    let corps = {};
    try {
      corps = JSON.parse(texte);
    } catch {
      /* pas du JSON */
    }
    return { status: r.status, corps };
  } catch {
    return { status: 0, corps: {} };
  }
};
const poster = (chemin, entetes, corps) => appel(chemin, { method: "POST", headers: entetes, body: JSON.stringify(corps) });
/** La séance sert-elle encore ? */
const seanceVivante = async (seance) => (await appel("/oxoai/auth/sessions", { headers: avec(seance) })).status === 200;
const connexion = (accountId, password) => poster("/oxoai/auth/verify", avecJeton, { accountId, password });

/** Tout ce qui est passé en clair, pour vérifier à la fin que rien ne traîne dans le journal. */
const SECRETS = [];
const mdp = (prefixe) => {
  const v = `${prefixe}-${randomBytes(10).toString("hex")}!7`;
  SECRETS.push(v);
  return v;
};

console.log(`\nEssai « mot de passe oublié », sur ${RACINE}`);

// Alice (première, administratrice), Bruno (collègue), Chloé (seconde administratrice, désignée par le profil).
const MDP_A = mdp("Alice");
const creeA = await poster("/oxoai/auth/create", avecJeton, { fullName: "Alice Martin", email: "alice@example.test", password: MDP_A });
let SA = creeA.corps.session?.token ?? "";
const ID_A = creeA.corps.account?.id ?? "";
const creerParAlice = async (nom, email) => {
  const prov = mdp("Prov");
  const cree = await poster("/oxoai/auth/create", avec(SA), { fullName: nom, email, password: prov });
  const id = cree.corps.account?.id ?? "";
  const propre = mdp(nom.split(" ")[0]);
  const ouvert = await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: id, password: prov, nouveau: propre });
  return { id, mdp: propre, seance: ouvert.corps.session?.token ?? "" };
};
const bruno = await creerParAlice("Bruno Petit", "bruno@example.test");
const chloe = await creerParAlice("Chloé Durand", "chloe@example.test");
verifier("trois comptes et leurs séances (Alice et Chloé administrent, Bruno non)", Boolean(SA && bruno.seance && chloe.seance), JSON.stringify({ a: Boolean(SA), b: Boolean(bruno.seance), c: Boolean(chloe.seance) }));

console.log("\n1. Refus : non-administrateur, mot de passe absent ou faux, son propre compte, une autre administratrice");
const parBruno = await poster("/oxoai/auth/reinitialiser", avec(bruno.seance), { accountId: ID_A, password: bruno.mdp });
const listeBruno = await appel("/oxoai/auth/reinitialiser", { headers: avec(bruno.seance) });
verifier("un collègue non administrateur ne réinitialise personne (403), ni ne lit la liste", parBruno.status === 403 && listeBruno.status === 403 && !parBruno.corps.provisoire, `${parBruno.status} ${listeBruno.status}`);
const sansSeance = await poster("/oxoai/auth/reinitialiser", avecJeton, { accountId: bruno.id, password: MDP_A });
verifier("sans séance : 401", sansSeance.status === 401, sansSeance.status);
const sansMdp = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: bruno.id });
const mauvaisMdp = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: bruno.id, password: "PasLeBonDuTout!42" });
verifier("le mot de passe de l'administratrice est exigé : absent 400, faux 403 (jamais 401, qui déconnecterait l'écran)", sansMdp.status === 400 && mauvaisMdp.status === 403, `${sansMdp.status} ${mauvaisMdp.status}`);
verifier("après ces refus, la séance de Bruno vit toujours", await seanceVivante(bruno.seance), "séance fermée");
const soiMeme = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: ID_A, password: MDP_A });
verifier("on ne réinitialise jamais son propre compte par là (400)", soiMeme.status === 400 && !soiMeme.corps.provisoire, soiMeme.status);
const liste = await appel("/oxoai/auth/reinitialiser", { headers: avec(SA) });
verifier("l'administratrice lit quels comptes administrent (Alice et Chloé, pas Bruno)", liste.status === 200 && liste.corps.administrateurs?.includes(chloe.id) && liste.corps.administrateurs?.includes(ID_A) && !liste.corps.administrateurs?.includes(bruno.id), JSON.stringify(liste.corps));
const autreAdmin = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: chloe.id, password: MDP_A });
verifier("une administratrice ne réinitialise pas une autre administratrice (403)", autreAdmin.status === 403 && !autreAdmin.corps.provisoire && /administre aussi/.test(autreAdmin.corps.error?.message ?? ""), `${autreAdmin.status} ${JSON.stringify(autreAdmin.corps)}`);
verifier("la séance de Chloé vit toujours", await seanceVivante(chloe.seance), "séance fermée");

console.log("\n2. Réinitialisation de Bruno : provisoire, séances et clé d'API tombées");
const cle = await poster("/oxoai/cles-api", avec(bruno.seance), { nom: "Essai", jours: 30, motDePasse: bruno.mdp });
const CLE = cle.corps.secret ?? "";
if (CLE) SECRETS.push(CLE);
const parCle = async () => (await appel("/v1/models", { headers: { Authorization: `Bearer ${CLE}` } })).status;
const avantCle = await parCle();
verifier("Bruno a une clé d'API qui sert", Boolean(CLE) && avantCle === 200, `${cle.status} ${avantCle}`);
const reinit = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: bruno.id, password: MDP_A });
const PROV = reinit.corps.provisoire ?? "";
if (PROV) SECRETS.push(PROV);
verifier("réinitialisé : un provisoire de seize caractères tiré par l'instance, qui expire dans 72 heures", reinit.status === 200 && /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/.test(PROV) && Math.abs(Date.parse(reinit.corps.expire) - Date.now() - 72 * 3600_000) < 60_000, JSON.stringify(reinit.corps));
verifier("la séance de Bruno est fermée", !(await seanceVivante(bruno.seance)), "séance vivante");
verifier("sa clé d'API ne sert plus", (await parCle()) === 401, await parCle());
verifier("la séance de l'administratrice, elle, vit", await seanceVivante(SA), "séance fermée");
const ancien = await connexion(bruno.id, bruno.mdp);
verifier("son ancien mot de passe est refusé", ancien.status === 401 && !ancien.corps.session, ancien.status);
const avecProv = await connexion(bruno.id, PROV);
verifier("le provisoire n'ouvre pas de séance : il mène au choix d'un mot de passe à soi (409, mot-de-passe-a-changer)", avecProv.status === 409 && avecProv.corps.error?.code === "mot-de-passe-a-changer" && !avecProv.corps.session, `${avecProv.status} ${JSON.stringify(avecProv.corps)}`);
bruno.mdp = mdp("Bruno");
const choisi = await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: bruno.id, password: PROV, nouveau: bruno.mdp });
bruno.seance = choisi.corps.session?.token ?? "";
verifier("Bruno choisit le sien et a une séance", choisi.status === 200 && Boolean(bruno.seance), choisi.status);
const reutilise = await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: bruno.id, password: PROV, nouveau: mdp("Autre") });
verifier("le provisoire ne resert pas", reutilise.status >= 400 && !reutilise.corps.session, reutilise.status);

console.log("\n3. Second facteur de Bruno : gardé, sauf case cochée");
const prep = await poster("/oxoai/auth/deux-facteurs/preparer", avec(bruno.seance), { password: bruno.mdp });
const SECRET = prep.corps.secret ?? "";
const act = await poster("/oxoai/auth/deux-facteurs/activer", avec(bruno.seance), { code: totp(SECRET) });
verifier("Bruno active la double authentification", act.status === 200 && Array.isArray(act.corps.codesDeSecours), act.status);
const r2 = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: bruno.id, password: MDP_A });
if (r2.corps.provisoire) SECRETS.push(r2.corps.provisoire);
bruno.mdp = mdp("Bruno");
const apres2 = await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: bruno.id, password: r2.corps.provisoire, nouveau: bruno.mdp });
verifier("sans la case, le code du téléphone est encore demandé après le provisoire (deux-facteurs-requis, pas de séance)", r2.corps.deuxFacteursRetire === false && apres2.status === 401 && apres2.corps.error?.code === "deux-facteurs-requis" && !apres2.corps.session, `${apres2.status} ${JSON.stringify(apres2.corps).slice(0, 200)}`);
const r3 = await poster("/oxoai/auth/reinitialiser", avec(SA), { accountId: bruno.id, password: MDP_A, retirerDeuxFacteurs: true });
if (r3.corps.provisoire) SECRETS.push(r3.corps.provisoire);
bruno.mdp = mdp("Bruno");
const apres3 = await poster("/oxoai/auth/mot-de-passe-provisoire", avecJeton, { accountId: bruno.id, password: r3.corps.provisoire, nouveau: bruno.mdp });
bruno.seance = apres3.corps.session?.token ?? "";
verifier("case cochée : second facteur retiré, séance ouverte avec le nouveau mot de passe", r3.corps.deuxFacteursRetire === true && apres3.status === 200 && Boolean(bruno.seance), `${apres3.status} ${JSON.stringify(r3.corps.deuxFacteursRetire)}`);

console.log("\n4. Codes de récupération");
const sansMdpCodes = await poster("/oxoai/auth/codes-recuperation", avec(bruno.seance), {});
verifier("tirer des codes demande le mot de passe", sansMdpCodes.status === 400 && !sansMdpCodes.corps.codes, sansMdpCodes.status);
const codes = await poster("/oxoai/auth/codes-recuperation", avec(bruno.seance), { password: bruno.mdp });
const CODES = codes.corps.codes ?? [];
SECRETS.push(...CODES);
verifier("dix codes remis, une fois", codes.status === 200 && CODES.length === 10 && CODES.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)), JSON.stringify(codes.corps).slice(0, 200));
const etat1 = await appel("/oxoai/auth/codes-recuperation", { headers: avec(bruno.seance) });
verifier("l'état dit combien il en reste, sans les codes", etat1.corps.restants === 10 && !JSON.stringify(etat1.corps).includes(CODES[0]), JSON.stringify(etat1.corps));
const faux = await poster("/oxoai/auth/recuperer", avecJeton, { accountId: bruno.id, code: "abcde-fghjk", nouveau: mdp("Faux") });
verifier("un faux code est refusé (401), rien ne change", faux.status === 401 && !faux.corps.session && (await seanceVivante(bruno.seance)), faux.status);
const sansCodes = await poster("/oxoai/auth/recuperer", avecJeton, { accountId: chloe.id, code: CODES[0], nouveau: mdp("Faux") });
verifier("le code d'un compte ne sert pas pour un autre, et la réponse ne dit pas qui a des codes (même 401, même message)", sansCodes.status === 401 && sansCodes.corps.error?.message === faux.corps.error?.message, `${sansCodes.status} ${JSON.stringify(sansCodes.corps)}`);
const court = await poster("/oxoai/auth/recuperer", avecJeton, { accountId: bruno.id, code: CODES[0], nouveau: "court" });
verifier("un nouveau mot de passe trop court est refusé sans consommer le code (400)", court.status === 400, court.status);
bruno.mdp = mdp("Bruno");
const recup = await poster("/oxoai/auth/recuperer", avecJeton, { accountId: bruno.id, code: CODES[0].toUpperCase(), nouveau: bruno.mdp });
verifier("un vrai code (majuscules acceptées) redéfinit le mot de passe et ouvre la séance", recup.status === 200 && Boolean(recup.corps.session?.token), `${recup.status} ${JSON.stringify(recup.corps).slice(0, 200)}`);
verifier("l'ancienne séance de Bruno est fermée", !(await seanceVivante(bruno.seance)), "séance vivante");
bruno.seance = recup.corps.session?.token ?? "";
const deuxFois = await poster("/oxoai/auth/recuperer", avecJeton, { accountId: bruno.id, code: CODES[0], nouveau: mdp("Encore") });
verifier("le même code ne sert pas deux fois", deuxFois.status === 401 && !deuxFois.corps.session, deuxFois.status);
const etat2 = await appel("/oxoai/auth/codes-recuperation", { headers: avec(bruno.seance) });
verifier("il en reste neuf", etat2.corps.restants === 9, JSON.stringify(etat2.corps));
// Avec la double authentification : le code de récupération remplace le mot de passe, pas le téléphone.
const prep2 = await poster("/oxoai/auth/deux-facteurs/preparer", avec(bruno.seance), { password: bruno.mdp });
await poster("/oxoai/auth/deux-facteurs/activer", avec(bruno.seance), { code: totp(prep2.corps.secret ?? "") });
bruno.mdp = mdp("Bruno");
const recup2fa = await poster("/oxoai/auth/recuperer", avecJeton, { accountId: bruno.id, code: CODES[1], nouveau: bruno.mdp });
verifier("double authentification active : après le code de récupération, le code du téléphone est demandé (pas de séance)", recup2fa.status === 401 && recup2fa.corps.error?.code === "deux-facteurs-requis" && Boolean(recup2fa.corps.defi) && !recup2fa.corps.session, `${recup2fa.status} ${JSON.stringify(recup2fa.corps).slice(0, 200)}`);
const fin2fa = await poster("/oxoai/auth/deux-facteurs", avecJeton, { defi: recup2fa.corps.defi, code: totp(prep2.corps.secret ?? "", 1) });
verifier("… et le code du téléphone ouvre la séance", fin2fa.status === 200 && Boolean(fin2fa.corps.session?.token), fin2fa.status);
bruno.seance = fin2fa.corps.session?.token ?? "";

console.log("\n5. Débit limité sur la route des codes de récupération");
const statuts = [];
for (let i = 0; i < 12; i++) statuts.push((await poster("/oxoai/auth/recuperer", avecJeton, { accountId: `u_inconnu${i}`, code: "abcde-fghjk", nouveau: "Inconnu-123456789" })).status);
verifier("au-delà de dix essais par minute, 429", statuts.includes(429), statuts.join(" "));

console.log("\n6. La machine de l'instance : le canal de l'application, et aucune route HTTP");
const demander = (message) =>
  new Promise((ok) => {
    const surMessage = (m) => {
      if (m?.type === "mot-de-passe-local" && m.id === message.id) {
        passerelle.off("message", surMessage);
        ok(m);
      }
    };
    passerelle.on("message", surMessage);
    passerelle.send(message);
    setTimeout(() => ok({ delai: true }), 15_000);
  });
const tropCourt = await demander({ type: "mot-de-passe-local", id: "e1", accountId: ID_A, motDePasse: "court" });
verifier("un mot de passe trop court est refusé par le canal", tropCourt.ok === false && typeof tropCourt.raison === "string", JSON.stringify(tropCourt));
verifier("… et la séance d'Alice vit toujours", await seanceVivante(SA), "séance fermée");
const NOUVEAU_A = mdp("AliceNeuf");
const local = await demander({ type: "mot-de-passe-local", id: "e2", accountId: ID_A, motDePasse: NOUVEAU_A });
verifier("le canal redéfinit le mot de passe d'Alice (administratrice, qui l'a oublié)", local.ok === true, JSON.stringify(local));
verifier("sa séance est fermée", !(await seanceVivante(SA)), "séance vivante");
const ancienA = await connexion(ID_A, MDP_A);
const neufA = await connexion(ID_A, NOUVEAU_A);
verifier("l'ancien mot de passe est refusé, le nouveau ouvre la séance", ancienA.status === 401 && neufA.status === 200 && Boolean(neufA.corps.session?.token), `${ancienA.status} ${neufA.status}`);
SA = neufA.corps.session?.token ?? "";
const inconnu = await demander({ type: "mot-de-passe-local", id: "e3", accountId: "u_inexistant", motDePasse: mdp("X") });
verifier("compte inconnu : refusé", inconnu.ok === false, JSON.stringify(inconnu));
const parHttp = await poster("/oxoai/auth/mot-de-passe-local", avecJeton, { accountId: ID_A, motDePasse: mdp("Pirate") });
const parHttp2 = await poster("/oxoai/mot-de-passe-local", avecJeton, { accountId: ID_A, motDePasse: mdp("Pirate") });
verifier("aucune route HTTP n'y mène (404), et le mot de passe d'Alice n'a pas changé", parHttp.status === 404 && parHttp2.status === 404 && (await connexion(ID_A, NOUVEAU_A)).status === 200, `${parHttp.status} ${parHttp2.status}`);

console.log("\n7. Le journal");
await attendre(300);
const audit = (() => {
  try {
    return readdirSync(join(DONNEES, "audit"))
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => readFileSync(join(DONNEES, "audit", n), "utf8"))
      .join("");
  } catch {
    return "";
  }
})();
const entrees = audit.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const reinitBruno = entrees.filter((e) => e.action === "motdepasse.reinitialise" && e.qui === bruno.id);
verifier("trois réinitialisations au nom de Bruno, l'administratrice dans le détail, séances fermées comptées", reinitBruno.length === 3 && reinitBruno.every((e) => e.detail.administrateur === ID_A && e.detail.par === "administrateur") && reinitBruno[0].detail.clesApiRevoquees === 1, JSON.stringify(reinitBruno.map((e) => e.detail)));
verifier("le refus pour une autre administratrice est écrit", entrees.some((e) => e.action === "motdepasse.reinitialisation_refusee" && e.qui === ID_A && e.detail.cible === chloe.id), "absent");
verifier("le retrait du second facteur est écrit", entrees.some((e) => e.action === "deuxfacteurs.desactive" && e.qui === bruno.id && e.detail.par === "administrateur"), "absent");
verifier("le code de récupération et l'application de bureau sont écrits (`par`)", entrees.some((e) => e.action === "motdepasse.redefini" && e.qui === bruno.id && e.detail.par === "code de récupération") && entrees.some((e) => e.action === "motdepasse.redefini" && e.qui === ID_A && e.detail.par === "application de bureau"), "absent");
verifier("codes de récupération créés : écrit", entrees.some((e) => e.action === "recuperation.codes_crees" && e.qui === bruno.id), "absent");
const enClair = SECRETS.filter((v) => v && (audit.includes(v) || journal.includes(v) || audit.toLowerCase().includes(v.toLowerCase())));
verifier(`aucun des ${SECRETS.length} mots de passe, provisoires, codes et clé en clair dans le journal d'audit ni dans la sortie de la passerelle`, SECRETS.length > 20 && enClair.length === 0, enClair.join(", "));

console.log("\n8. Le processus principal de l'application (electron/motDePasseOublie.cjs, avec des doublures d'Electron)");
{
  const { createRequire } = await import("node:module");
  const { installerMotDePasseOublie } = createRequire(import.meta.url)(join(RACINE, "electron", "motDePasseOublie.cjs"));
  const monter = ({ plateforme, touchId = "ok", disponible = true }) => {
    const canaux = {};
    const envoyes = [];
    const ouverts = [];
    const dossier = join(ICI, `app-${plateforme}-${Math.random().toString(36).slice(2)}`);
    const fenetre = { id: "fenetre" };
    let module;
    module = installerMotDePasseOublie({
      ipcMain: { handle: (nom, f) => (canaux[nom] = f) },
      systemPreferences: { promptTouchID: (raison) => (envoyes.push({ raison }), touchId === "ok" ? Promise.resolve() : Promise.reject(new Error("annulé"))) },
      shell: { openPath: async (p) => (ouverts.push(p), ""), showItemInFolder: (p) => ouverts.push(p) },
      dossier: () => dossier,
      depuisLaFenetre: (e) => e?.sender === fenetre,
      disponible: () => disponible,
      // La passerelle répond aussitôt, comme le fait index.ts.
      envoyer: (m) => {
        envoyes.push(m);
        setTimeout(() => module.recevoir({ type: "mot-de-passe-local", id: m.id, ok: true }), 5);
        return true;
      },
      langue: () => "fr",
      nom: "Essai",
      plateforme,
    });
    const appeler = (nom, demande, expediteur = fenetre) => canaux[nom]({ sender: expediteur }, demande);
    return { canaux, envoyes, ouverts, dossier, appeler };
  };
  const demande = { accountId: "u_essai", email: "essai@example.test", motDePasse: "Nouveau-mot-de-passe-1", retirerDeuxFacteurs: false };

  const mac = monter({ plateforme: "darwin" });
  verifier("macOS : sept canaux, tous gardés par la fenêtre (un autre expéditeur n'obtient rien)", Object.keys(mac.canaux).length === 7 && (await mac.appeler("oxoai:mdp-oublie", demande, { autre: true })).ok === false && (await mac.appeler("oxoai:mdp-oublie-etat", undefined, { autre: true })).disponible === false && mac.envoyes.length === 0, JSON.stringify(Object.keys(mac.canaux)));
  verifier("macOS : la reconnaissance passe par le système (« systeme »), pas par un fichier", (await mac.appeler("oxoai:mdp-oublie-etat")).moyen === "systeme" && (await mac.appeler("oxoai:mdp-oublie-fichier", demande)).ok === false, "fichier accepté");
  const okMac = await mac.appeler("oxoai:mdp-oublie", demande);
  verifier("macOS : Touch ID accepté, le mot de passe part à la passerelle par le canal, la raison nomme le compte", okMac.ok === true && /redéfinir le mot de passe de essai@example\.test/.test(mac.envoyes[0]?.raison ?? "") && mac.envoyes[1]?.type === "mot-de-passe-local" && mac.envoyes[1]?.motDePasse === demande.motDePasse, JSON.stringify(mac.envoyes));
  const refuseMac = monter({ plateforme: "darwin", touchId: "non" });
  const r = await refuseMac.appeler("oxoai:mdp-oublie", demande);
  verifier("macOS : Touch ID refusé ou annulé, rien ne part (`refuse`)", r.ok === false && r.raison === "refuse" && refuseMac.envoyes.filter((m) => m.type).length === 0, JSON.stringify(r));
  const rattache = monter({ plateforme: "darwin", disponible: false });
  verifier("poste rattaché (ou passerelle sans canal) : la porte n'existe pas", (await rattache.appeler("oxoai:mdp-oublie-etat")).disponible === false && (await rattache.appeler("oxoai:mdp-oublie", demande)).raison === "indisponible" && rattache.envoyes.length === 0, "porte ouverte");

  const win = monter({ plateforme: "win32" });
  verifier("Windows : la reconnaissance passe par un fichier", (await win.appeler("oxoai:mdp-oublie-etat")).moyen === "fichier", "autre moyen");
  const sansCode = await win.appeler("oxoai:mdp-oublie", { ...demande, code: "ABCD-EFGH" });
  verifier("Windows : sans code écrit, rien ne part", sansCode.ok === false && win.envoyes.length === 0, JSON.stringify(sansCode));
  const ecrit = await win.appeler("oxoai:mdp-oublie-fichier", demande);
  const contenu = existsSync(ecrit.fichier ?? "") ? readFileSync(ecrit.fichier, "utf8") : "";
  const code = /\b[A-Z2-9]{4}-[A-Z2-9]{4}\b/.exec(contenu)?.[0] ?? "";
  verifier("Windows : le code est écrit dans le dossier de l'application, et le fichier ouvert", ecrit.ok === true && ecrit.fichier.startsWith(win.dossier) && Boolean(code) && win.ouverts.includes(ecrit.fichier) && /essai@example\.test/.test(contenu), contenu.slice(0, 200));
  const faux = await win.appeler("oxoai:mdp-oublie", { ...demande, code: "AAAA-AAAA" });
  verifier("Windows : un faux code est refusé (`code`), rien ne part", faux.ok === false && faux.raison === "code" && win.envoyes.length === 0, JSON.stringify(faux));
  const autreCompte = await win.appeler("oxoai:mdp-oublie", { ...demande, accountId: "u_autre", code });
  verifier("Windows : le code d'un compte ne sert pas pour un autre", autreCompte.ok === false && win.envoyes.length === 0, JSON.stringify(autreCompte));
  const bon = await win.appeler("oxoai:mdp-oublie", { ...demande, code: code.toLowerCase() });
  verifier("Windows : le bon code (minuscules acceptées) remet le mot de passe à la passerelle, et le fichier est effacé", bon.ok === true && win.envoyes.length === 1 && win.envoyes[0].accountId === "u_essai" && !existsSync(ecrit.fichier), JSON.stringify(bon));
  const encore = await win.appeler("oxoai:mdp-oublie", { ...demande, code });
  verifier("Windows : le code ne sert qu'une fois", encore.ok === false && win.envoyes.length === 1, JSON.stringify(encore));
  await win.appeler("oxoai:mdp-oublie-fichier", demande);
  const essais = [];
  for (let i = 0; i < 5; i++) essais.push((await win.appeler("oxoai:mdp-oublie", { ...demande, code: "BBBB-BBBB" })).raison);
  verifier("Windows : cinq faux codes, et le code tombe (`expire`), fichier effacé", essais.join(",") === "code,code,code,code,expire" && !existsSync(join(win.dossier, "mot-de-passe-oublie.txt")), essais.join(","));
  const arabe = (await import("node:module")).createRequire(import.meta.url)(join(RACINE, "electron", "motDePasseOublie.cjs")).TEXTES;
  const langues = Object.keys(arabe);
  verifier(
    "textes du processus principal : sept langues, mêmes clés, aucun caractère de contrôle de direction ni tiret cadratin",
    langues.length === 7 && ["fr", "en", "zh", "ja", "es", "de", "ar"].every((l) => JSON.stringify(Object.keys(arabe[l])) === JSON.stringify(Object.keys(arabe.fr))) && !/[\u200e\u200f\u202a-\u202e\u2066-\u2069—]/.test(JSON.stringify(arabe)),
    langues.join(","),
  );
}

console.log("\n8 bis. Repartir de zéro sur cet ordinateur (electron/repartirDeZero.cjs) : tout est mis de côté, rien n'est supprimé");
{
  const exiger = (await import("node:module")).createRequire(import.meta.url);
  const R = exiger(join(RACINE, "electron", "repartirDeZero.cjs"));
  const { installerMotDePasseOublie } = exiger(join(RACINE, "electron", "motDePasseOublie.cjs"));
  const maison = join(ICI, "repartir-maison");
  const donnees = join(maison, ".oxoai");
  const profil = join(maison, "Profil", "OxoAI");
  const poser = (f, v) => {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, v);
  };
  poser(join(donnees, "data", "accounts.json"), "COMPTES-ANCIENS");
  poser(join(donnees, "data", ".cle"), "CLE-ANCIENNE");
  poser(join(profil, "Local Storage", "x"), "PROFIL-ANCIEN");
  poser(join(maison, ".lmstudio", "models", "m.gguf"), "MODELE");
  poser(join(maison, ".openclaw", "openclaw.json"), "OPENCLAW");

  // Par le canal de la fenêtre, comme l'écran : mot faux, puis Touch ID refusé, puis accepté.
  const canaux = {};
  let relances = 0;
  let touch = "non";
  const fenetre = { id: "f" };
  installerMotDePasseOublie({
    ipcMain: { handle: (nom, f) => (canaux[nom] = f) },
    systemPreferences: { promptTouchID: () => (touch === "ok" ? Promise.resolve() : Promise.reject(new Error("non"))) },
    shell: { openPath: async () => "", showItemInFolder: () => {} },
    dossier: () => join(maison, "app"),
    depuisLaFenetre: (e) => e?.sender === fenetre,
    disponible: () => true,
    envoyer: () => true,
    langue: () => "fr",
    nom: "Essai",
    plateforme: "darwin",
    donnees,
    profil: () => profil,
    relancer: () => relances++,
  });
  const appeler = (nom, demande, expediteur = fenetre) => canaux[nom]({ sender: expediteur }, demande);
  const apercu = await appeler("oxoai:repartir-apercu");
  const h = R.horodatage();
  verifier(
    "l'aperçu donne le mot à taper et les noms exacts : `~/.oxoai-ancien-AAAA-MM-JJ-hhmm` et le profil à côté",
    apercu.disponible === true && apercu.mot === "REPARTIR" && apercu.dossiers[0] === `${donnees}-ancien-${h}` && apercu.dossiers[1] === `${profil}-ancien-${h}`,
    JSON.stringify(apercu),
  );
  verifier("un autre expéditeur que la fenêtre n'obtient rien", (await appeler("oxoai:repartir-apercu", undefined, { autre: 1 })).disponible === false && (await appeler("oxoai:repartir", { mot: "REPARTIR" }, { autre: 1 })).ok === false, "accepté");
  const motFaux = await appeler("oxoai:repartir", { mot: "oui" });
  verifier("mot faux : refusé (`mot`), aucun témoin, aucune relance", motFaux.raison === "mot" && !existsSync(R.temoinDe(donnees)) && relances === 0, JSON.stringify(motFaux));
  const refuse = await appeler("oxoai:repartir", { mot: "repartir" });
  verifier("l'ordinateur ne reconnaît pas la personne : refusé, rien d'écrit", refuse.raison === "refuse" && !existsSync(R.temoinDe(donnees)), JSON.stringify(refuse));
  touch = "ok";
  const accepte = await appeler("oxoai:repartir", { mot: " repartir " });
  await attendre(1700);
  verifier("reconnue et mot juste : la demande est écrite à côté, l'application relancée, rien n'a encore bougé", accepte.ok === true && relances === 1 && existsSync(R.temoinDe(donnees)) && existsSync(join(donnees, "data", "accounts.json")), JSON.stringify(accepte));

  // Le lancement suivant : les deux étapes, comme main.cjs.
  R.appliquer(donnees, "donnees");
  R.appliquer(donnees, "profil", profil);
  const [ancienDonnees, ancienProfil] = accepte.dossiers;
  verifier(
    "au lancement suivant : `~/.oxoai` et le profil sont déplacés tels quels (comptes, clé, profil relisibles), rien n'est supprimé",
    !existsSync(donnees) && !existsSync(profil) && readFileSync(join(ancienDonnees, "data", "accounts.json"), "utf8") === "COMPTES-ANCIENS" && readFileSync(join(ancienDonnees, "data", ".cle"), "utf8") === "CLE-ANCIENNE" && readFileSync(join(ancienProfil, "Local Storage", "x"), "utf8") === "PROFIL-ANCIEN",
    JSON.stringify(accepte.dossiers),
  );
  verifier("LM Studio et OpenClaw de la personne ne sont pas touchés", readFileSync(join(maison, ".lmstudio", "models", "m.gguf"), "utf8") === "MODELE" && readFileSync(join(maison, ".openclaw", "openclaw.json"), "utf8") === "OPENCLAW", "touchés");
  const b = await appeler("oxoai:repartir-bilan");
  verifier("le premier lancement d'après dit où sont les anciennes données", b?.etat === "fait" && JSON.stringify(b.dossiers) === JSON.stringify(accepte.dossiers), JSON.stringify(b));
  R.appliquer(donnees, "donnees");
  verifier("relancer encore ne déplace rien de plus", existsSync(ancienDonnees) && !existsSync(donnees), "déplacé");
  await appeler("oxoai:repartir-oublier");
  verifier("« Compris » efface le bilan, pas les anciennes données", (await appeler("oxoai:repartir-bilan")) === null && existsSync(ancienDonnees), "bilan resté");

  // Échec : le profil ne peut pas bouger. `~/.oxoai` revient à sa place, jamais à moitié.
  const maison2 = join(ICI, "repartir-echec");
  const donnees2 = join(maison2, ".oxoai");
  const profil2 = join(maison2, "Profil");
  poser(join(donnees2, "data", "accounts.json"), "COMPTES");
  poser(join(profil2, "x"), "P");
  const prevus = R.demander({ donnees: donnees2, profil: profil2 });
  poser(join(prevus[1].vers, "occupe"), "un dossier non vide là où le profil devait aller");
  R.appliquer(donnees2, "donnees");
  R.appliquer(donnees2, "profil", profil2);
  const b2 = R.bilan(donnees2);
  verifier("un dossier qui refuse de bouger : tout revient à sa place, et l'écran le dira", b2?.etat === "echec" && readFileSync(join(donnees2, "data", "accounts.json"), "utf8") === "COMPTES" && existsSync(join(profil2, "x")) && !existsSync(prevus[0].vers), JSON.stringify(b2));

  const sources = readFileSync(join(RACINE, "electron", "repartirDeZero.cjs"), "utf8") + readFileSync(join(RACINE, "electron", "motDePasseOublie.cjs"), "utf8");
  verifier(
    "hors ligne : ni le module « mot de passe oublié » ni « repartir de zéro » n'ouvrent le réseau, et rien n'y supprime un dossier",
    !/require\("node:(https?|net|dns|tls)"\)|fetch\(|net\.request/.test(sources) && !/rmSync\((?!fichier\(\)|temoinDe)/.test(sources),
    "réseau ou suppression",
  );
}

console.log("\n9. Le provisoire d'une réinitialisation expire au bout de 72 heures (accounts.ts, en direct)");
{
  const ICI2 = join(ICI, "direct");
  mkdirSync(ICI2, { recursive: true });
  const script = `
    const accounts = await import(${JSON.stringify(join(RACINE, "gateway", "src", "accounts.ts"))});
    const roles = await import(${JSON.stringify(join(RACINE, "gateway", "src", "roles.ts"))});
    const a = await accounts.createAccount({ fullName: "Admin", email: "admin@example.test", password: "Admin-mot-de-passe-1" });
    const b = await accounts.createAccount({ fullName: "Bea", email: "bea@example.test", password: "Bea-mot-de-passe-1" });
    const r = await accounts.reinitialiserParAdministrateur(a.account.id, b.account.id, "Admin-mot-de-passe-1", undefined, false, roles.estAdministrateur);
    const avant = await accounts.verifyAccount(b.account.id, r.provisoire);
    const maintenant = Date.now;
    Date.now = () => maintenant() + 73 * 3600_000;
    const apres = await accounts.verifyAccount(b.account.id, r.provisoire);
    const changer = await accounts.remplacerMotDePasseProvisoire(b.account.id, r.provisoire, "Bea-nouveau-mot-de-passe");
    console.log(JSON.stringify({ avant, apres, changer }));
    process.exit(0);`;
  writeFileSync(join(ICI2, "direct.mjs"), script);
  writeFileSync(join(ICI, "profil-direct.json"), JSON.stringify({ chiffrement: "fichier" }));
  const sortie = await new Promise((ok) => {
    const e = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ICI2, "direct.mjs")], {
      cwd: RACINE,
      env: { PATH: `${BIN}:/usr/bin:/bin`, HOME: join(ICI2, "maison"), TMPDIR: tmpdir(), OXOAI_CONFIG: join(ICI, "profil-direct.json"), OXOAI_DATA_DIR: join(ICI2, "donnees") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let s = "";
    e.stdout.on("data", (b) => (s += b));
    e.stderr.on("data", (b) => (s += b));
    e.on("close", () => ok(s));
  });
  let r = {};
  try {
    r = JSON.parse(sortie.trim().split("\n").pop());
  } catch {
    /* sortie illisible : le contrôle le dira */
  }
  verifier("avant 72 heures : le provisoire mène au choix d'un mot de passe à soi", r.avant?.aChanger === true, sortie.slice(-300));
  verifier("après 72 heures : il n'ouvre plus rien, pas même le choix", r.apres?.ok === false && !r.apres?.aChanger && /expiré|expired/.test(r.apres?.reason ?? "") && r.changer?.ok === false && r.changer?.statut === 410, sortie.slice(-300));
}

const partie = new Promise((ok) => passerelle.once("exit", ok));
try {
  process.kill(-passerelle.pid, "SIGTERM");
} catch {
  passerelle.kill();
}
await Promise.race([partie, attendre(5000)]);
await attendre(300);
verifier("aucun appel au trousseau macOS (dossier personnel jetable, clé par fichier)", !existsSync(join(ICI, "security.log")), "security appelé");
if (echecs.length > 0 || process.env.ESSAI_JOURNAL) console.log(journal.slice(-3000));
rmSync(ICI, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(`\n${reussis} réussi(s), ${echecs.length} échec(s)`);
process.exit(echecs.length > 0 ? 1 : 0);
