import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { motifRepete } from "./gardeBoucle.ts";
import { echantillonnageLocal } from "./backends.ts";

/**
 * Ce que chaque modèle local donne sur CETTE machine : un essai à la mise en
 * route, et les réponses coupées en cours d'usage.
 *
 * Vu par Medhi le 27/09/2026 sur un PC Windows sans carte graphique (16 Go,
 * llmster 0.0.25, 2026.927.3) : même chargé au processeur (`--gpu off`) et
 * avec l'échantillonnage de Qwen, Qwen3.5 4B, choisi d'office pour ce poste,
 * répondait « 不 時////… » au lieu d'une réponse, quand Ministral 3B, sur le
 * même PC, répondait juste. Le défaut est vraisemblablement dans le moteur
 * (llama.cpp de llmster, architecture hybride récente de Qwen3.5, processeur
 * sous Windows) : OxoAI ne peut pas le corriger. Medhi : « ça doit
 * fonctionner en fonction des PC ». La note d'un modèle ne dit pas s'il
 * tourne juste sur un poste donné ; seul un essai le dit.
 *
 * Donc :
 *  - après chaque chargement par la mise en route (provision.ts), et au
 *    premier chargement d'un modèle par le Chat (`loadModel`, backends.ts),
 *    une courte question sans réflexion (`essayerModele`), jugée par
 *    `verdictDeReponse` ;
 *  - chaque coupure du garde-fou (gardeBoucle.ts) est notée : une fois, le
 *    modèle est « douteux » ; deux fois, « défaillant » ;
 *  - un modèle défaillant n'est plus choisi d'office sur cette machine (ni
 *    installé, ni recommandé, ni pris en « Auto ») ; il reste choisissable à la
 *    main, avec un avertissement dans le sélecteur.
 *
 * Le registre est un fichier du dossier des données, par machine et non par
 * personne : c'est le poste qui calcule mal, pas le compte.
 */

/** Pourquoi une réponse d'essai n'en est pas une. */
export type Raison = "vide" | "boucle" | "signes" | "alphabet";

export interface Verdict {
  ok: boolean;
  raison?: Raison;
  /** Le début de ce que le modèle a rendu, pour qui diagnostique (jamais une donnée de la personne : c'est la réponse à la question d'essai). */
  extrait?: string;
  /** L'essai n'a rien pu conclure (moteur muet, délai dépassé) : le modèle n'est pas mis en cause. */
  indecis?: string;
}

export type Etat = "valide" | "douteux" | "defaillant";

export interface Fiche {
  /** L'identifiant tel que vu la dernière fois (« qwen/qwen3.5-4b »). */
  modele: string;
  etat: Etat;
  /** Date de la dernière observation, ISO. */
  date: string;
  /** « coupures » : deux réponses parties en boucle en cours d'usage. */
  raison?: Raison | "coupures";
  extrait?: string;
  /** Réponses coupées par le garde-fou sur cette machine. */
  coupures?: number;
  /** L'essai n'avait rien pu conclure : noté pour ne pas le refaire à chaque chargement. */
  indecis?: string;
}

/* ------------------------------ le verdict ------------------------------- */

/**
 * La question d'essai. Jamais affichée ; en français, parce que le verdict
 * attend alors l'alphabet latin, et qu'un modèle sain répond « Bonjour ».
 */
export const QUESTION_ESSAI = "Réponds seulement : bonjour";

/** Réflexion écrite dans le texte (moteur qui ne la sépare pas) : `<think>…</think>`, fermée ou non. */
function separerReflexion(texte: string): { texte: string; reflexion: string } {
  let reflexion = "";
  const sans = texte
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_, r: string) => {
      reflexion += r;
      return "";
    })
    .replace(/<think>([\s\S]*)$/i, (_, r: string) => {
      reflexion += r;
      return "";
    });
  return { texte: sans, reflexion };
}

/**
 * Un même court motif répété à la suite en fin de texte, à l'échelle d'une
 * réponse d'essai (quelques dizaines de jetons) : `motifRepete` attend 600
 * caractères, qu'un essai borné à 64 jetons n'atteint pas toujours.
 */
function repetitionCourte(texte: string): boolean {
  const n = texte.length;
  for (let p = 1; p <= 40; p++) {
    // 24 caractères et 5 périodes au moins : « bonjour » six fois de suite, oui ; « Bonjour !!! », non.
    const seuil = Math.max(24, p * 5);
    if (n < seuil) break;
    let k = 0;
    while (k + p < n && texte.charCodeAt(n - 1 - k) === texte.charCodeAt(n - 1 - k - p)) k++;
    if (k + p >= seuil) return true;
  }
  return false;
}

/**
 * La réponse à « Réponds seulement : bonjour » en est-elle une ?
 *
 * Quatre critères simples, dans cet ordre :
 *  - vide : ni texte ni réflexion ;
 *  - boucle : un même motif répété à la suite (garde-fou, ou sa version courte) ;
 *  - signes : moins d'une lettre sur deux parmi ce qui n'est pas une espace
 *    (« 不 時////// » en a deux sur huit) ;
 *  - alphabet : la question est en alphabet latin, et plus d'un tiers des
 *    lettres de la réponse n'en sont pas (« 不 », « 時 »).
 *
 * Le texte est jugé ; sans texte, la réflexion (le flux cassé du PC de Medhi
 * était une réflexion). Un modèle qui réfléchit malgré la consigne et n'a pas
 * fini dans les jetons impartis rend une réflexion saine et aucun texte : il
 * passe, puisque rien ne montre qu'il calcule mal.
 */
export function verdictDeReponse(brut: string, reflexionBrute = ""): Verdict {
  const { texte: sansBalises, reflexion: dansLeTexte } = separerReflexion(brut ?? "");
  const texte = sansBalises.trim();
  const reflexion = `${reflexionBrute ?? ""}${dansLeTexte}`.trim();
  const juge = texte || reflexion;
  const extrait = juge.slice(0, 80);
  if (!juge) return { ok: false, raison: "vide", extrait: "" };
  if (motifRepete(juge) || repetitionCourte(juge)) return { ok: false, raison: "boucle", extrait };
  const visibles = [...juge.replace(/\s+/g, "")];
  const lettres = visibles.filter((c) => /\p{L}/u.test(c));
  if (visibles.length >= 4 && lettres.length / visibles.length < 0.5) return { ok: false, raison: "signes", extrait };
  const horsLatin = lettres.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
  if (horsLatin >= 1 && horsLatin / Math.max(1, lettres.length) > 1 / 3) return { ok: false, raison: "alphabet", extrait };
  return { ok: true, extrait };
}

/* ------------------------------- l'essai --------------------------------- */

/**
 * Délai de l'essai. Généreux : sur le processeur d'un PC de bureau, un modèle
 * de 4 milliards de paramètres écrit quelques jetons par seconde, et la
 * première question après un chargement paie aussi la lecture du gabarit.
 * Borné : un moteur figé ne doit pas bloquer la mise en route.
 */
const DELAI_ESSAI_MS = Number(process.env.OXOAI_ESSAI_MODELE_MS ?? 180_000);

/**
 * Pose la question d'essai au modèle déjà chargé, par le serveur local
 * compatible OpenAI, sans réflexion et en 64 jetons au plus, puis juge.
 *
 * Sans réflexion : c'est le plus court, et le défaut vu sur le PC (« 不 »
 * dès le premier jeton) n'a rien à voir avec elle. Un moteur qui refuse les
 * champs de réflexion voit la question reposée sans eux (comme dans chat.ts).
 */
export async function essayerModele(baseUrl: string, modele: string, apiKey?: string): Promise<Verdict> {
  const qwen3Classique = /qwen3(?![.\d])|qwq/i.test(modele);
  const corps: Record<string, unknown> = {
    model: modele,
    messages: [{ role: "user", content: qwen3Classique ? `${QUESTION_ESSAI} /no_think` : QUESTION_ESSAI }],
    stream: false,
    max_tokens: 64,
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
    ...echantillonnageLocal(modele, false),
  };
  const envoyer = async (c: Record<string, unknown>) =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(DELAI_ESSAI_MS),
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(c),
    });
  try {
    let reponse = await envoyer(corps);
    if (reponse.status === 400 || reponse.status === 422) {
      await reponse.body?.cancel().catch(() => {});
      const { reasoning_effort: _r, chat_template_kwargs: _c, ...sans } = corps;
      reponse = await envoyer(sans);
    }
    if (!reponse.ok) {
      await reponse.body?.cancel().catch(() => {});
      return { ok: true, indecis: `HTTP ${reponse.status}` };
    }
    const json = (await reponse.json()) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[];
    };
    const message = json.choices?.[0]?.message ?? {};
    const texte = typeof message.content === "string" ? message.content : "";
    const reflexion =
      typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : "";
    return verdictDeReponse(texte, reflexion);
  } catch (err) {
    // Délai dépassé ou moteur injoignable : rien ne dit que le modèle calcule mal.
    return { ok: true, indecis: err instanceof Error ? err.name : String(err) };
  }
}

/* ------------------------------ le registre ------------------------------ */

const fichierRegistre = () =>
  join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "modeles-sur-cette-machine.json");

/**
 * Nom comparable d'un modèle : sans éditeur ni numéro de copie. Le catalogue
 * dit « qwen3-8b », LM Studio « qwen/qwen3-8b », et une seconde copie
 * chargée « qwen3-8b:2 ».
 */
export const nomDuModele = (id: string): string => (id.toLowerCase().split("/").pop() ?? id).replace(/:\d+$/, "");

type Registre = Record<string, Fiche>;

/**
 * Le registre, ou `null` s'il existe mais ne se lit pas. Dans ce cas on
 * n'écrit rien par-dessus (règle du projet, pertes du 20/09 et du 24/09) :
 * mieux vaut refaire un essai qu'effacer ce qu'on savait.
 */
function lire(): Registre | null {
  const chemin = fichierRegistre();
  if (!existsSync(chemin)) return {};
  try {
    const lu = JSON.parse(readFileSync(chemin, "utf8")) as { modeles?: unknown };
    if (!lu || typeof lu !== "object" || typeof lu.modeles !== "object" || lu.modeles === null) return null;
    return lu.modeles as Registre;
  } catch {
    return null;
  }
}

function ecrire(registre: Registre): void {
  const chemin = fichierRegistre();
  try {
    mkdirSync(dirname(chemin), { recursive: true });
    const provisoire = `${chemin}.${process.pid}.tmp`;
    writeFileSync(provisoire, `${JSON.stringify({ version: 1, modeles: registre }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(provisoire, chemin);
  } catch (err) {
    console.error(`[oxoai] état des modèles non enregistré : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Modifie la fiche d'un modèle ; rien si le registre ne se lit pas. */
function modifier(modele: string, changer: (avant: Fiche | undefined) => Fiche): Fiche | null {
  const registre = lire();
  if (registre === null) {
    console.error("[oxoai] modeles-sur-cette-machine.json illisible : rien n'est écrit par-dessus.");
    return null;
  }
  const fiche = changer(registre[nomDuModele(modele)]);
  registre[nomDuModele(modele)] = fiche;
  ecrire(registre);
  return fiche;
}

export function ficheDe(modele: string): Fiche | undefined {
  return lire()?.[nomDuModele(modele)];
}

/** Ne plus choisir ce modèle d'office sur cette machine. */
export function estDefaillant(modele: string): boolean {
  return ficheDe(modele)?.etat === "defaillant";
}

/**
 * Jamais essayé ni observé sur cette machine : l'essai reste à faire. Registre
 * illisible : on ne sait pas, et on ne refait pas l'essai à chaque chargement.
 */
export function aEssayer(modele: string): boolean {
  const registre = lire();
  return registre !== null && !registre[nomDuModele(modele)];
}

/**
 * Note le résultat d'un essai. Un bon essai efface une défaillance passée
 * (moteur mis à jour, modèle réinstallé) ; les coupures déjà comptées restent.
 */
export function noterEssai(modele: string, verdict: Verdict): void {
  const date = new Date().toISOString();
  modifier(modele, (avant) =>
    verdict.ok
      ? {
          modele,
          etat: "valide",
          date,
          ...(avant?.coupures ? { coupures: avant.coupures } : {}),
          ...(verdict.indecis ? { indecis: verdict.indecis } : {}),
        }
      : {
          modele,
          etat: "defaillant",
          date,
          raison: verdict.raison,
          extrait: verdict.extrait,
          ...(avant?.coupures ? { coupures: avant.coupures } : {}),
        },
  );
  console.log(
    `[oxoai] essai de ${modele} sur cette machine : ${verdict.ok ? (verdict.indecis ? `sans conclusion (${verdict.indecis})` : "réponse correcte") : `réponse incorrecte (${verdict.raison})`}`,
  );
}

/** Coupures au-delà desquelles un modèle n'est plus choisi d'office. */
export const COUPURES_MAX = 2;

/**
 * Une réponse de ce modèle vient d'être coupée par le garde-fou. Rend son
 * nouvel état, ou `null` si le registre ne se lit pas.
 */
export function noterCoupure(modele: string): Etat | null {
  const fiche = modifier(modele, (avant) => {
    const coupures = (avant?.coupures ?? 0) + 1;
    const defaillant = coupures >= COUPURES_MAX || avant?.etat === "defaillant";
    return {
      modele,
      etat: defaillant ? "defaillant" : "douteux",
      date: new Date().toISOString(),
      coupures,
      ...(defaillant ? { raison: avant?.etat === "defaillant" && avant.raison ? avant.raison : "coupures" } : {}),
      ...(avant?.extrait && avant.etat === "defaillant" ? { extrait: avant.extrait } : {}),
    };
  });
  return fiche?.etat ?? null;
}

/** Ce que le sélecteur de modèles montre : l'état, la raison, la date. Rien pour un modèle sain. */
export function etatSurCetteMachine(modele: string): { etat: "douteux" | "defaillant"; raison?: string; date: string } | undefined {
  const fiche = ficheDe(modele);
  if (!fiche || fiche.etat === "valide") return undefined;
  return { etat: fiche.etat, ...(fiche.raison ? { raison: fiche.raison } : {}), date: fiche.date };
}
