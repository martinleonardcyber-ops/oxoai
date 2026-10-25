/*
 * La réflexion du modèle, vue sur une vraie machine jetable (GitHub Actions),
 * 29/09/2026.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Signalé par Medhi le 29/09/2026 : sous Windows, et peut-être sous Linux, le
 * Chat n'affichait ni la réflexion du modèle local ni son temps (« Réflexion
 * en cours... 12 s », puis « Réflexion : 12 s »), alors que le Mac les
 * affiche. Rien ne pouvait se voir d'ici : cet essai garde le flux BRUT d'une
 * question qui fait réfléchir le modèle, à trois endroits, pour chaque
 * modèle essayé :
 *
 *  1. directement à l'API de LM Studio (127.0.0.1:1234), sans OxoAI : ce que
 *     le moteur envoie vraiment sur ce système (canal `reasoning_content`,
 *     `reasoning`, ou `<think>` dans le texte) ;
 *  2. à travers la passerelle, par l'API compatible (le relais, octet pour
 *     octet, qu'utilisent l'extension VS Code, la ligne de commande et OpenCode) ;
 *  3. à travers la passerelle, comme l'écran du Chat la pose (`tools: false`,
 *     niveau « Moyen ») : c'est là que la réflexion doit arriver séparée, par
 *     `reasoning_content`, avant la réponse, sur une durée mesurable, et la
 *     réponse sans balise.
 *
 * Chaque flux est gardé tel quel (`reflexion-<modèle>-<endroit>.sse.txt`),
 * avec l'heure d'arrivée de chaque évènement (`….temps.txt`), et un résumé de
 * ce qui a été vu (`reflexion-resume.json`).
 *
 * ── Mode d'emploi ───────────────────────────────────────────────────────────
 *
 * Sous Windows, appelé par scripts/essai-windows-ci.mjs (étape 6), sur
 * l'application empaquetée déjà en route. Sous Linux (job `reflexion-linux`
 * de .github/workflows/essai-windows.yml), seul :
 *
 *   OXOAI_ESSAI_MACHINE_JETABLE=1 node scripts/essai-reflexion-ci.mjs
 *     [--modeles qwen3-1.7b,qwen/qwen3.5-2b] [--sortie essai-reflexion-sortie]
 *
 * La passerelle est alors lancée par `node gateway/src/index.ts`, données
 * jetables, puis le moteur (llmster) et les modèles sont installés comme par
 * l'écran de mise en route. Comme l'essai Windows, il accepte les conditions
 * de LM Studio et écrit dans ~/.lmstudio : machine jetable seulement.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
/** Nom comparable d'un modèle, sans source ni éditeur (« lmstudio/qwen/qwen3-1.7b » → « qwen3-1.7b »), comme santeModeles.ts. */
const nomDuModele = (id) => (String(id).toLowerCase().split("/").pop() ?? "").replace(/:\d+$/, "");
/*
 * Une question courte qui finit par « ? » : l'écran la pose telle quelle au modèle, sans le tri
 * qui découpe les travaux (plan.ts, `estQuestionSimple`). Premier essai du 29/09/2026 avec
 * « …, puis donne le résultat en une phrase. » : un plan en deux étapes, plus de vingt minutes
 * au processeur de la machine d'essai pour Qwen3.5 2B.
 */
const QUESTION = "Combien font 17 fois 23 ?";
const LM_STUDIO = "http://127.0.0.1:1234/v1";

/**
 * Lit un flux SSE jusqu'au bout, en notant l'heure d'arrivée de chaque
 * évènement, et en rend ce qu'un client en tire.
 */
async function lireFlux(reponse, t0) {
  const brut = [];
  const temps = [];
  const vu = { reasoning_content: 0, reasoning: 0, content: 0, ouvrante: false, fermante: false, requalifiee: 0, erreurs: [] };
  let texte = "";
  let reflexion = "";
  let premiereReflexion = 0;
  let derniereReflexion = 0;
  let premierTexte = 0;
  /** Premier signe visible à l'écran : un statut, de la réflexion ou du texte. */
  let premierSigne = 0;
  const lecteur = reponse.body.getReader();
  const decodeur = new TextDecoder();
  let tampon = "";
  let interrompu = "";
  for (;;) {
    let lu;
    try {
      lu = await lecteur.read();
    } catch (err) {
      // Délai dépassé ou connexion coupée : ce qui est déjà arrivé est gardé, et la coupure dite.
      interrompu = String(err?.name ?? err);
      break;
    }
    const { done, value } = lu;
    if (done) break;
    const morceau = decodeur.decode(value, { stream: true });
    brut.push(morceau);
    tampon += morceau;
    const evenements = tampon.split("\n\n");
    tampon = evenements.pop() ?? "";
    for (const e of evenements) {
      const maintenant = Date.now() - t0;
      const donnee = e
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!donnee) continue;
      temps.push(`+${String(maintenant).padStart(7)} ms ${donnee.slice(0, 400)}`);
      if (donnee === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(donnee);
      } catch {
        continue;
      }
      if (json.error) vu.erreurs.push(JSON.stringify(json.error).slice(0, 300));
      // Un statut non vide (« Chargement… », « Le modèle lit la demande… ») est déjà un signe à l'écran.
      if (json.oxoai?.type === "statut" && json.oxoai.message) premierSigne ||= maintenant;
      if (json.oxoai?.type === "error") vu.erreurs.push(String(json.oxoai.message).slice(0, 300));
      // Ce que l'écran fait de cet évènement (useChat.ts) : les derniers caractères du texte étaient la réflexion.
      if (json.oxoai?.type === "reflexion_requalifiee") {
        vu.requalifiee++;
        const n = Math.min(json.oxoai.caracteres ?? 0, texte.length);
        reflexion += texte.slice(texte.length - n);
        texte = texte.slice(0, texte.length - n);
        premiereReflexion ||= maintenant - (json.oxoai.depuisMs ?? 0);
        derniereReflexion = maintenant;
        if (!texte.trim()) premierTexte = 0;
      }
      const delta = json.choices?.[0]?.delta ?? {};
      for (const champ of ["reasoning_content", "reasoning"]) {
        if (typeof delta[champ] === "string" && delta[champ]) {
          vu[champ] += delta[champ].length;
          reflexion += delta[champ];
          premiereReflexion ||= maintenant;
          derniereReflexion = maintenant;
          premierSigne ||= maintenant;
        }
      }
      if (typeof delta.content === "string" && delta.content) {
        vu.content += delta.content.length;
        texte += delta.content;
        if (!premierTexte && texte.trim()) premierTexte = maintenant;
        if (texte.trim()) premierSigne ||= maintenant;
      }
    }
  }
  vu.ouvrante = /<think>/.test(texte);
  vu.fermante = /<\/think>/.test(texte);
  if (interrompu) vu.erreurs.push(`flux interrompu au bout de ${Date.now() - t0} ms : ${interrompu}`);
  return {
    brut: brut.join(""),
    temps: temps.join("\n"),
    vu,
    texte,
    reflexion,
    // Comme l'écran : du premier au dernier morceau de réflexion reçu.
    dureeReflexion: premiereReflexion ? derniereReflexion - premiereReflexion : 0,
    premierSigne,
    reflexionAvantTexte: Boolean(premiereReflexion) && (!premierTexte || premiereReflexion <= premierTexte),
  };
}

/** Ce que le moteur a fait de la réflexion, en une ligne. */
function forme(vu) {
  const formes = [];
  if (vu.reasoning_content) formes.push(`reasoning_content (${vu.reasoning_content} car.)`);
  if (vu.reasoning) formes.push(`reasoning (${vu.reasoning} car.)`);
  if (vu.ouvrante) formes.push("<think> dans le texte");
  else if (vu.fermante) formes.push("</think> seul dans le texte");
  if (vu.requalifiee) formes.push(`${vu.requalifiee} requalification(s)`);
  return formes.join(", ") || "aucune réflexion";
}

/**
 * L'essai lui-même, sur une passerelle déjà en route (Windows : l'application
 * empaquetée ; Linux : `node gateway/src/index.ts`).
 */
export async function essaiReflexion({ G, entetes, dire, verifier, sortie, modeles, delaiMiseEnRouteMs = 40 * 60_000, lmStudio = LM_STUDIO }) {
  const resume = [];
  /** Les modèles dont le Chat a rendu une réflexion. */
  const avecReflexion = [];
  for (const cle of modeles) {
    dire(`   modèle ${cle}`);
    const slug = nomDuModele(cle).replace(/[^a-z0-9.-]+/g, "-");
    let liste = (await (await fetch(`${G}/oxoai/models`, { headers: entetes() })).json().catch(() => ({}))).models ?? [];
    let modele = liste.find((m) => nomDuModele(m.id) === nomDuModele(cle));
    if (!modele) {
      // Comme « Installer » à l'écran de mise en route : téléchargé, chargé, essayé (santeModeles.ts), suivi par son flux.
      const arret = new AbortController();
      const minuterie = setTimeout(() => arret.abort(), delaiMiseEnRouteMs);
      let etat = null;
      try {
        const flux = await fetch(`${G}/oxoai/provision/stream`, { headers: entetes(), signal: arret.signal });
        const lance = await fetch(`${G}/oxoai/provision/start`, { method: "POST", headers: entetes(), body: JSON.stringify({ model: cle }) });
        dire(`   mise en route de ${cle} : ${lance.status}`);
        const lecteur = flux.body.getReader();
        const decodeur = new TextDecoder();
        let tampon = "";
        let dernier = "";
        /** Une mise en route a commencé depuis la demande : l'état « prêt » d'avant, envoyé à l'ouverture du flux, ne compte pas. */
        let commencee = false;
        lecture: for (;;) {
          const { value, done } = await lecteur.read();
          if (done) break;
          tampon += decodeur.decode(value, { stream: true });
          let fin;
          while ((fin = tampon.indexOf("\n\n")) >= 0) {
            const bloc = tampon.slice(0, fin);
            tampon = tampon.slice(fin + 2);
            const donnees = bloc.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            try {
              etat = JSON.parse(donnees);
            } catch {
              continue;
            }
            const pas = typeof etat.percent === "number" ? ` ${Math.floor(etat.percent / 20) * 20} %` : "";
            const ligne = `${etat.phase} | ${etat.model ?? "-"} | ${String(etat.message ?? "").replace(/[\d.,]+\s*%/g, "").trim()}${pas}${etat.error ? ` | ${etat.error}` : ""}`;
            if (ligne !== dernier) dire(`     ${(dernier = ligne)}`);
            if (etat.phase !== "ready" && etat.phase !== "error") commencee = true;
            if (commencee && (etat.phase === "ready" || etat.phase === "error")) break lecture;
          }
        }
      } catch (err) {
        dire(`     flux de mise en route interrompu : ${err?.name ?? err}`);
      } finally {
        clearTimeout(minuterie);
        arret.abort();
      }
      liste = (await (await fetch(`${G}/oxoai/models`, { headers: entetes() })).json().catch(() => ({}))).models ?? [];
      modele = liste.find((m) => nomDuModele(m.id) === nomDuModele(cle));
      if (!verifier(`réflexion, ${cle} : installé et proposé au Chat`, Boolean(modele), `${JSON.stringify(etat).slice(0, 400)} ; sélecteur : ${liste.map((m) => m.id).join(", ")}`)) continue;
    }
    const id = modele.id;
    const messages = [{ role: "user", content: QUESTION }];
    const endroits = [
      // Sans rien de OxoAI : le moteur tel qu'il est sur ce système (le modèle est déjà en mémoire, chargé par OxoAI).
      ["lmstudio", `${lmStudio}/chat/completions`, { "Content-Type": "application/json" }, { model: id, stream: true, messages }],
      ["relais", `${G}/v1/chat/completions`, entetes(), { model: id, stream: true, messages }],
      ["chat", `${G}/v1/chat/completions`, entetes(), { model: id, stream: true, tools: false, effort: "moyen", messages }],
    ];
    const vus = {};
    for (const [endroit, url, en, corps] of endroits) {
      const t0 = Date.now();
      let r;
      try {
        const reponse = await fetch(url, { method: "POST", headers: en, body: JSON.stringify(corps), signal: AbortSignal.timeout(10 * 60_000) });
        r = { statut: reponse.status, ...(reponse.body ? await lireFlux(reponse, t0) : { brut: await reponse.text(), temps: "", vu: {}, texte: "", reflexion: "" }) };
      } catch (err) {
        r = { statut: 0, brut: String(err?.stack ?? err), temps: "", vu: { erreurs: [String(err)] }, texte: "", reflexion: "", dureeReflexion: 0 };
      }
      writeFileSync(join(sortie, `reflexion-${slug}-${endroit}.sse.txt`), r.brut);
      writeFileSync(join(sortie, `reflexion-${slug}-${endroit}.temps.txt`), r.temps);
      vus[endroit] = r;
      dire(
        `     ${endroit.padEnd(8)} ${r.statut}, ${((Date.now() - t0) / 1000).toFixed(1)} s : ${forme(r.vu)} ; premier signe à ${r.premierSigne ?? 0} ms ; réflexion ${r.dureeReflexion ?? 0} ms ; réponse ${JSON.stringify(r.texte.trim()).slice(0, 160)}${(r.vu.erreurs ?? []).length ? ` ; ${r.vu.erreurs.join(" | ").slice(0, 300)}` : ""}`,
      );
      resume.push({ modele: cle, id, endroit, statut: r.statut, forme: forme(r.vu), vu: r.vu, premierSigneMs: r.premierSigne, dureeReflexionMs: r.dureeReflexion, debutReflexion: r.reflexion.slice(0, 200), debutTexte: r.texte.slice(0, 300) });
    }
    const chat = vus.chat;
    /*
     * Un petit modèle ne réfléchit pas toujours (Qwen3 1.7B, essai Windows du 29/09/2026 : pas un mot
     * de réflexion à « Combien font 17 fois 23 ? » par le Chat, 4 042 caractères au moteur seul) : ce
     * qui est exigé, c'est que TOUTE réflexion reçue arrive séparée, avec sa durée, et jamais dans le
     * texte. Qu'il y en ait au moins une est vérifié sur l'ensemble des modèles, plus bas.
     */
    if (chat.reflexion.trim()) avecReflexion.push(cle);
    verifier(
      `réflexion, ${cle}, Chat de OxoAI : la réflexion reçue arrive séparée (reasoning_content), sur une durée mesurée, jamais dans le texte (<think>, </think>)`,
      chat.statut === 200 && !/<\/?think>/.test(chat.texte) && (!chat.reflexion.trim() || ((chat.vu.reasoning_content > 0 || chat.vu.requalifiee > 0) && chat.dureeReflexion > 0)),
      `${chat.statut} ${forme(chat.vu)} ; ${chat.dureeReflexion} ms ; moteur seul : ${forme(vus.lmstudio?.vu ?? {})} ; ${JSON.stringify(chat.texte.slice(0, 200))}`,
    );
    // Lecture de la demande et tri se disent à l'écran (chat.ts, `attenteAffichee`) : jamais une bulle muette plus de quelques secondes.
    verifier(
      `réflexion, ${cle}, Chat de OxoAI : un premier signe à l'écran (statut, réflexion ou texte) en moins de 8 s`,
      chat.premierSigne > 0 && chat.premierSigne < 8000,
      `${chat.premierSigne} ms`,
    );
    // Le modèle de l'essai doit répondre ; les suivants peuvent partir en boucle au processeur (dit par OxoAI, et noté ici).
    if (cle === modeles[0]) {
      verifier(
        `réflexion, ${cle}, Chat de OxoAI : une réponse, et sans erreur`,
        chat.texte.trim().length > 0 && (chat.vu.erreurs ?? []).length === 0,
        `${JSON.stringify(chat.texte.slice(0, 300))} ${(chat.vu.erreurs ?? []).join(" | ")}`,
      );
    }
  }
  verifier(
    "réflexion : au moins un Chat de OxoAI l'a reçue et rendue séparée (l'essai n'est pas vide)",
    avecReflexion.length > 0,
    "aucun modèle n'a réfléchi par le Chat",
  );
  writeFileSync(join(sortie, "reflexion-resume.json"), JSON.stringify({ plateforme: `${process.platform} ${process.arch}`, question: QUESTION, resultats: resume }, null, 1));
}

/* ── Seul, sous Linux (ou tout système sans application empaquetée) ──────── */

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
  const option = (nom, defaut) => {
    const i = process.argv.indexOf(`--${nom}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
  };
  const MODELES = option("modeles", "qwen3-1.7b,qwen/qwen3.5-2b").split(",").filter(Boolean);
  const SORTIE = resolve(option("sortie", join(RACINE, "essai-reflexion-sortie")));
  if (process.env.OXOAI_ESSAI_MACHINE_JETABLE !== "1") {
    console.log("Cet essai installe le moteur de LM Studio dans ~/.lmstudio et en accepte les conditions : machine jetable seulement (OXOAI_ESSAI_MACHINE_JETABLE=1).");
    process.exit(2);
  }
  mkdirSync(SORTIE, { recursive: true });
  const journalEssai = createWriteStream(join(SORTIE, "essai.log"), { flags: "w" });
  const debut = Date.now();
  const dire = (texte) => {
    const ligne = `[${((Date.now() - debut) / 1000).toFixed(0).padStart(5)} s] ${texte}`;
    console.log(ligne);
    journalEssai.write(`${ligne}\n`);
  };
  let reussis = 0;
  const echecs = [];
  const verifier = (nom, ok, obtenu) => {
    if (ok) {
      reussis++;
      dire(`  ✓ ${nom}`);
    } else {
      echecs.push(nom);
      dire(`  ✗ ${nom}  —  obtenu : ${String(obtenu).slice(0, 1500)}`);
    }
    return ok;
  };
  const TMP = join(process.env.RUNNER_TEMP || tmpdir(), `oxoai-essai-reflexion-${Date.now()}`);
  const DONNEES = join(TMP, "donnees");
  mkdirSync(DONNEES, { recursive: true });
  writeFileSync(join(TMP, "oxoai.config.json"), JSON.stringify({ chiffrement: "fichier" }));
  const PORT = 8787;
  const G = `http://127.0.0.1:${PORT}`;
  const journalPasserelle = createWriteStream(join(SORTIE, "passerelle.log"), { flags: "w" });
  const passerelle = spawn(process.execPath, [join(RACINE, "gateway", "src", "index.ts")], {
    cwd: RACINE,
    env: { ...process.env, OXOAI_DATA_DIR: DONNEES, OXOAI_CONFIG: join(TMP, "oxoai.config.json"), OXOAI_GATEWAY_PORT: String(PORT), OXOAI_SANS_MISE_A_JOUR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  passerelle.stdout.pipe(journalPasserelle);
  passerelle.stderr.pipe(journalPasserelle);
  let JETON = "";
  let SEANCE = "";
  const entetes = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${JETON}`, "X-OxoAI-Langue": "fr", ...(SEANCE ? { "X-OxoAI-Session": SEANCE } : {}) });
  try {
    dire("1. La passerelle démarre");
    let sante = false;
    for (let i = 0; i < 240 && !sante; i++) {
      sante = await fetch(`${G}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
      if (!sante) await attendre(500);
    }
    if (!verifier("la passerelle répond sur 127.0.0.1:8787/health", sante, "aucune réponse")) throw new Error("passerelle muette");
    const fichierJeton = join(DONNEES, "instance-token");
    for (let i = 0; i < 20 && !existsSync(fichierJeton); i++) await attendre(500);
    JETON = readFileSync(fichierJeton, "utf8").trim();
    dire("2. Le compte administrateur");
    const motDePasse = `Essai-${randomBytes(12).toString("base64url")}-9a`;
    const compte = await (await fetch(`${G}/oxoai/auth/create`, { method: "POST", headers: entetes(), body: JSON.stringify({ fullName: "Administrateur essai", email: "admin@essai-reflexion.test", password: motDePasse }) })).json().catch(() => ({}));
    SEANCE = compte.session?.token ?? "";
    if (!verifier("le premier compte est créé", Boolean(SEANCE), JSON.stringify(compte).slice(0, 300))) throw new Error("pas de séance");
    dire("3. Le moteur de LM Studio et le premier modèle, comme l'écran de mise en route");
    const avant = await (await fetch(`${G}/oxoai/provision`, { headers: entetes() })).json().catch(() => ({}));
    dire(`   machine : ${JSON.stringify(avant.hardware)} ; moteur : ${avant.moteur} ; installé : ${avant.moteurInstalle}`);
    const arret = new AbortController();
    const minuterie = setTimeout(() => arret.abort(), 45 * 60_000);
    const flux = await fetch(`${G}/oxoai/provision/stream`, { headers: entetes(), signal: arret.signal });
    const lance = await fetch(`${G}/oxoai/provision/moteur`, { method: "POST", headers: entetes(), body: JSON.stringify({ conditionsAcceptees: true, model: MODELES[0] }) });
    verifier("installation du moteur acceptée (202)", lance.status === 202, `${lance.status} ${(await lance.text()).slice(0, 300)}`);
    let etat = null;
    try {
      const lecteur = flux.body.getReader();
      const decodeur = new TextDecoder();
      let tampon = "";
      let dernier = "";
      lecture: for (;;) {
        const { value, done } = await lecteur.read();
        if (done) break;
        tampon += decodeur.decode(value, { stream: true });
        let fin;
        while ((fin = tampon.indexOf("\n\n")) >= 0) {
          const bloc = tampon.slice(0, fin);
          tampon = tampon.slice(fin + 2);
          try {
            etat = JSON.parse(bloc.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"));
          } catch {
            continue;
          }
          const pas = typeof etat.percent === "number" ? ` ${Math.floor(etat.percent / 20) * 20} %` : "";
          const ligne = `${etat.phase} | ${etat.model ?? "-"} | ${String(etat.message ?? "").replace(/[\d.,]+\s*%/g, "").trim()}${pas}${etat.error ? ` | ${etat.error}` : ""}`;
          if (ligne !== dernier) dire(`   ${(dernier = ligne)}`);
          if (etat.phase === "ready" || etat.phase === "error") break lecture;
        }
      }
    } catch (err) {
      dire(`   flux interrompu : ${err?.name ?? err}`);
    } finally {
      clearTimeout(minuterie);
      arret.abort();
    }
    if (!verifier("la mise en route arrive à « prêt »", etat?.phase === "ready", JSON.stringify(etat))) throw new Error("pas prêt");
    dire("4. La réflexion du modèle : moteur seul, relais de OxoAI, Chat de OxoAI");
    await essaiReflexion({ G, entetes, dire, verifier, sortie: SORTIE, modeles: MODELES });
  } catch (err) {
    verifier("l'essai s'est déroulé sans exception", false, err?.stack ?? err);
  } finally {
    passerelle.kill();
    await attendre(2000);
    dire(`${reussis} vérification(s) réussie(s), ${echecs.length} échec(s).`);
    for (const e of echecs) dire(`  - ${e}`);
    await new Promise((r) => journalEssai.end(r));
    process.exit(echecs.length ? 1 : 0);
  }
}
