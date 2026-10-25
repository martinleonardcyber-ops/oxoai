/**
 * « Mot de passe oublié ? » sur la machine de l'instance (23/10/2026).
 *
 * Demandé par Medhi : « Que faire quand quelqu'un perd son mot de passe ? Ça
 * arrive souvent. » Jusque-là, l'administrateur (ou la personne seule sur son
 * poste) n'avait que `npm run motdepasse`, inutilisable pour qui a installé
 * l'application. La preuve retenue est la même que celle de l'outil : tenir
 * la session de l'ordinateur qui fait tourner l'instance. Rien ne part par
 * mail (l'instance n'en envoie pas), aucune question secrète.
 *
 * ── Comment l'ordinateur reconnaît la personne ─────────────────────────────
 *
 *  - **macOS** : `systemPreferences.promptTouchID`, la fenêtre du système.
 *    Electron y demande la « présence de l'utilisateur »
 *    (`kSecAccessControlUserPresence`) : Touch ID, ou le mot de passe de la
 *    session. C'est le seul moyen sous macOS, sans repli : la clé des données
 *    y vit dans le trousseau, qu'un autre programme ne lit pas sans le mot de
 *    passe de la session. Accepter moins que ce mot de passe pour reprendre un
 *    compte affaiblirait ce qui protège déjà les données.
 *  - **Windows et Linux** : un code à usage unique, écrit dans un fichier du
 *    dossier de l'application (dossier personnel de la session), que la
 *    personne ouvre et recopie dans la fenêtre. Windows Hello ne s'atteint pas
 *    depuis Electron sans module natif, et OxoAI n'ajoute pas de dépendance
 *    pour cela. Ce que le fichier prouve : être devant la session ouverte de
 *    la machine de l'instance, ni dans un navigateur, ni sur un poste
 *    rattaché, et pas seulement être la page affichée (une page détournée ne
 *    lit pas de fichier ; le code ne passe jamais par elle). Sur ces systèmes,
 *    la clé des données est lisible par tout programme de la session
 *    (`safeStorage` : DPAPI sous Windows, trousseau de la session sous Linux) :
 *    la session en tient déjà autant que cette porte en ouvre.
 *
 * Puis le processus principal remet le nouveau mot de passe à **sa**
 * passerelle par le canal qui les relie (`mot-de-passe-local`,
 * gateway/src/index.ts), qui appelle la même fonction que l'outil local
 * (`definirMotDePasse`) : séances et clés d'API révoquées, journal d'audit.
 * Aucune route HTTP n'y mène. Poste rattaché à l'instance d'une autre
 * machine : la porte n'existe pas (la passerelle de ce poste n'est pas
 * l'instance).
 *
 * Le mot de passe n'est ni journalisé ni gardé : il traverse ce processus le
 * temps de le remettre.
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomInt, timingSafeEqual } = require("node:crypto");
const repartir = require("./repartirDeZero.cjs");

const TEXTES = {
  fr: {
    // macOS l'affiche après « OxoAI veut » : un verbe à l'infinitif.
    raison: "redéfinir le mot de passe de {0}",
    titre: "Code pour redéfinir un mot de passe oublié ({1})",
    consigne: "Recopiez ce code dans la fenêtre de {1}. Il sert une seule fois et ne vaut que dix minutes. Si vous n'avez rien demandé, supprimez ce fichier.",
    compte: "Compte : {0}",
    raisonRepartir: "repartir de zéro sur cet ordinateur (les données actuelles sont mises de côté)",
    titreRepartir: "Code pour repartir de zéro sur cet ordinateur ({1})",
    motRepartir: "REPARTIR",
  },
  en: {
    raison: "reset the password of {0}",
    titre: "Code to reset a forgotten password ({1})",
    consigne: "Type this code into the {1} window. It works once and only for ten minutes. If you did not ask for it, delete this file.",
    compte: "Account: {0}",
    raisonRepartir: "start over on this computer (the current data is set aside)",
    titreRepartir: "Code to start over on this computer ({1})",
    motRepartir: "START OVER",
  },
  zh: {
    raison: "重设 {0} 的密码",
    titre: "重设遗忘密码的代码（{1}）",
    consigne: "请把此代码输入 {1} 的窗口。它只能使用一次，十分钟内有效。如果您没有提出请求，请删除此文件。",
    compte: "账户：{0}",
    raisonRepartir: "在这台电脑上从头开始（当前数据会被移到一旁）",
    titreRepartir: "在这台电脑上从头开始的代码（{1}）",
    motRepartir: "从头开始",
  },
  ja: {
    raison: "{0} のパスワードを再設定",
    titre: "忘れたパスワードを再設定するためのコード（{1}）",
    consigne: "このコードを {1} のウィンドウに入力してください。使えるのは一度だけで、有効期限は10分です。心当たりがない場合は、このファイルを削除してください。",
    compte: "アカウント：{0}",
    raisonRepartir: "このコンピュータで最初からやり直す（現在のデータは別の場所に移されます）",
    titreRepartir: "このコンピュータで最初からやり直すためのコード（{1}）",
    motRepartir: "やり直す",
  },
  es: {
    raison: "restablecer la contraseña de {0}",
    titre: "Código para restablecer una contraseña olvidada ({1})",
    consigne: "Escriba este código en la ventana de {1}. Sirve una sola vez y solo durante diez minutos. Si no lo ha pedido, elimine este archivo.",
    compte: "Cuenta: {0}",
    raisonRepartir: "empezar de cero en este ordenador (los datos actuales se apartan)",
    titreRepartir: "Código para empezar de cero en este ordenador ({1})",
    motRepartir: "EMPEZAR",
  },
  de: {
    raison: "das Passwort von {0} neu festlegen",
    titre: "Code zum Zurücksetzen eines vergessenen Passworts ({1})",
    consigne: "Geben Sie diesen Code im Fenster von {1} ein. Er gilt nur einmal und nur zehn Minuten lang. Wenn Sie nichts angefordert haben, löschen Sie diese Datei.",
    compte: "Konto: {0}",
    raisonRepartir: "auf diesem Computer neu beginnen (die aktuellen Daten werden beiseitegelegt)",
    titreRepartir: "Code, um auf diesem Computer neu zu beginnen ({1})",
    motRepartir: "NEU BEGINNEN",
  },
  ar: {
    raison: "إعادة تعيين كلمة مرور {0}",
    titre: "رمز لإعادة تعيين كلمة مرور منسية ({1})",
    consigne: "اكتب هذا الرمز في نافذة {1}. يصلح لمرة واحدة فقط ولمدة عشر دقائق. إذا لم تطلب ذلك، فاحذف هذا الملف.",
    compte: "الحساب: {0}",
    raisonRepartir: "البدء من جديد على هذا الحاسوب (تُنقل البيانات الحالية جانبًا)",
    titreRepartir: "رمز للبدء من جديد على هذا الحاسوب ({1})",
    motRepartir: "ابدأ من جديد",
  },
};

/** Le code du fichier : huit caractères sans ambiguïté (ni 0/O, ni 1/l/I), en deux groupes. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DUREE_CODE_MS = 10 * 60_000;
const ESSAIS_MAX = 5;
const DELAI_PASSERELLE_MS = 30_000;
const NOM_FICHIER = "mot-de-passe-oublie.txt";
/** Clé du code de fichier pour « Repartir de zéro » : jamais un identifiant de compte (`u_…`). */
const CLE_REPARTIR = "repartir-de-zero";

// Caractères de contrôle : ni dans une adresse affichée par le système, ni dans un fichier.
const sansControle = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 254);

const normaliserCode = (v) => String(v ?? "").toUpperCase().replace(/[\s-]/g, "");

function tirerCode() {
  let brut = "";
  for (let i = 0; i < 8; i++) brut += ALPHABET[randomInt(ALPHABET.length)];
  return `${brut.slice(0, 4)}-${brut.slice(4)}`;
}

/**
 * @param {{
 *   ipcMain: import("electron").IpcMain,
 *   systemPreferences: import("electron").SystemPreferences,
 *   shell: import("electron").Shell,
 *   dossier: () => string,
 *   depuisLaFenetre: (event: unknown) => boolean,
 *   disponible: () => boolean,
 *   envoyer: (message: unknown) => boolean,
 *   langue: () => string,
 *   nom: string,
 *   plateforme?: string,
 *   donnees?: string,
 *   profil?: () => string,
 *   relancer?: () => void,
 * }} options
 */
function installerMotDePasseOublie(options) {
  const { ipcMain, systemPreferences, shell, depuisLaFenetre, disponible, envoyer, langue, nom } = options;
  const plateforme = options.plateforme ?? process.platform;
  const moyen = plateforme === "darwin" ? "systeme" : "fichier";
  const textes = () => TEXTES[langue()] ?? TEXTES.en;
  const remplir = (texte, a) => texte.replaceAll("{0}", a).replaceAll("{1}", nom);

  /** Le code en cours (un seul à la fois), pour un seul compte. */
  let enCours = null;
  /** Réponses attendues de la passerelle, par numéro de demande. */
  const attentes = new Map();
  let numero = 0;

  const fichier = () => path.join(options.dossier(), NOM_FICHIER);
  const effacerFichier = () => {
    try {
      fs.rmSync(fichier(), { force: true });
    } catch {
      /* déjà parti */
    }
  };
  const oublierCode = () => {
    enCours = null;
    effacerFichier();
  };

  /** Le nouveau mot de passe remis à la passerelle de cette machine ; `{ ok, raison? }`. */
  function remettre(accountId, motDePasse, retirerDeuxFacteurs) {
    const id = `mdp-${++numero}`;
    return new Promise((resolve) => {
      const fin = setTimeout(() => {
        attentes.delete(id);
        resolve({ ok: false, raison: "passerelle" });
      }, DELAI_PASSERELLE_MS);
      attentes.set(id, (m) => {
        clearTimeout(fin);
        attentes.delete(id);
        resolve({ ok: m.ok === true, ...(typeof m.raison === "string" ? { raison: m.raison } : {}) });
      });
      if (!envoyer({ type: "mot-de-passe-local", id, accountId, motDePasse, retirerDeuxFacteurs: retirerDeuxFacteurs === true })) {
        clearTimeout(fin);
        attentes.delete(id);
        resolve({ ok: false, raison: "passerelle" });
      }
    });
  }

  ipcMain.handle("oxoai:mdp-oublie-etat", (event) => {
    if (!depuisLaFenetre(event)) return { disponible: false };
    return { disponible: disponible(), moyen };
  });

  /** Windows et Linux : écrit le code dans le fichier, et l'ouvre. Rend le chemin, pour que l'écran le dise. */
  ipcMain.handle("oxoai:mdp-oublie-fichier", async (event, demande) => {
    if (!depuisLaFenetre(event) || moyen !== "fichier" || !disponible()) return { ok: false, raison: "indisponible" };
    const pourRepartir = demande?.pour === "repartir";
    const accountId = pourRepartir ? CLE_REPARTIR : typeof demande?.accountId === "string" ? demande.accountId.slice(0, 100) : "";
    if (!accountId) return { ok: false, raison: "indisponible" };
    const code = tirerCode();
    const tx = textes();
    const contenu = [
      remplir(pourRepartir ? tx.titreRepartir : tx.titre, ""),
      "",
      code,
      "",
      ...(pourRepartir ? [] : [remplir(tx.compte, sansControle(demande?.email ?? "")), ""]),
      remplir(tx.consigne, ""),
      "",
    ].join("\n");
    try {
      fs.mkdirSync(options.dossier(), { recursive: true });
      fs.writeFileSync(fichier(), contenu, { encoding: "utf8", mode: 0o600 });
    } catch {
      return { ok: false, raison: "fichier" };
    }
    enCours = { accountId, code: normaliserCode(code), expire: Date.now() + DUREE_CODE_MS, essais: 0 };
    // Ouvert dans l'éditeur du système ; à défaut, montré dans son dossier.
    const echec = await shell.openPath(fichier()).catch(() => "erreur");
    if (echec) shell.showItemInFolder(fichier());
    return { ok: true, fichier: fichier() };
  });

  /**
   * La preuve, puis le nouveau mot de passe. Rend `{ ok }` ou `{ ok: false,
   * raison }` : `indisponible`, `refuse` (l'ordinateur n'a pas reconnu la
   * personne), `code` (code du fichier faux), `expire`, `passerelle`, ou le
   * message de la passerelle (mot de passe trop court, compte introuvable).
   */
  /**
   * La preuve : la fenêtre du système (macOS), ou le code du fichier pour
   * cette clé (un compte, ou `CLE_REPARTIR`). Rend null si la personne est
   * reconnue, sinon la raison. Rien ne passe par le réseau.
   */
  async function reconnaitre(cle, raisonSysteme, codeDonne) {
    if (moyen === "systeme") {
      try {
        await systemPreferences.promptTouchID(raisonSysteme);
        return null;
      } catch {
        // Annulé, refusé, ou pas de moyen d'authentification : rien n'est changé.
        return "refuse";
      }
    }
    if (!enCours || enCours.accountId !== cle) return "expire";
    if (Date.now() > enCours.expire) {
      oublierCode();
      return "expire";
    }
    const donne = Buffer.from(normaliserCode(codeDonne));
    const attendu = Buffer.from(enCours.code);
    if (donne.length !== attendu.length || !timingSafeEqual(donne, attendu)) {
      enCours.essais += 1;
      if (enCours.essais >= ESSAIS_MAX) {
        oublierCode();
        return "expire";
      }
      return "code";
    }
    // Bon code : il ne servira plus, que la suite réussisse ou non.
    oublierCode();
    return null;
  }

  ipcMain.handle("oxoai:mdp-oublie", async (event, demande) => {
    if (!depuisLaFenetre(event) || !disponible()) return { ok: false, raison: "indisponible" };
    const accountId = typeof demande?.accountId === "string" ? demande.accountId.slice(0, 100) : "";
    const motDePasse = typeof demande?.motDePasse === "string" ? demande.motDePasse : "";
    if (!accountId || !motDePasse || accountId === CLE_REPARTIR) return { ok: false, raison: "indisponible" };
    const refus = await reconnaitre(accountId, remplir(textes().raison, sansControle(demande?.email ?? "")), demande?.code);
    if (refus) return { ok: false, raison: refus };
    return remettre(accountId, motDePasse, demande?.retirerDeuxFacteurs === true);
  });

  /*
   * « Repartir de zéro sur cet ordinateur » (repartirDeZero.cjs) : ce qui
   * sera déplacé et où, le mot à taper ; puis, reconnu et le mot juste, le
   * témoin écrit et l'application relancée. Rien n'est supprimé.
   */
  const repartirPossible = () => Boolean(options.donnees && options.profil && options.relancer);

  ipcMain.handle("oxoai:repartir-apercu", (event) => {
    if (!depuisLaFenetre(event) || !disponible() || !repartirPossible()) return { disponible: false };
    return {
      disponible: true,
      moyen,
      mot: textes().motRepartir,
      dossiers: repartir.apercu({ donnees: options.donnees, profil: options.profil() }).map((d) => d.vers),
    };
  });

  ipcMain.handle("oxoai:repartir", async (event, demande) => {
    if (!depuisLaFenetre(event) || !disponible() || !repartirPossible()) return { ok: false, raison: "indisponible" };
    // Le mot d'abord : une fausse manœuvre ne doit même pas ouvrir la fenêtre du système.
    const attendu = textes().motRepartir.toLocaleUpperCase();
    if (typeof demande?.mot !== "string" || demande.mot.trim().toLocaleUpperCase() !== attendu) return { ok: false, raison: "mot" };
    const refus = await reconnaitre(CLE_REPARTIR, textes().raisonRepartir, demande?.code);
    if (refus) return { ok: false, raison: refus };
    let dossiers;
    try {
      dossiers = repartir.demander({ donnees: options.donnees, profil: options.profil() });
    } catch {
      return { ok: false, raison: "fichier" };
    }
    // Laisser à la réponse le temps d'arriver à l'écran, puis quitter proprement et relancer.
    setTimeout(() => options.relancer(), 1500);
    return { ok: true, dossiers: dossiers.map((d) => d.vers) };
  });

  /** Après le départ : où sont les anciennes données (ou pourquoi rien n'a bougé), jusqu'à « Compris ». */
  ipcMain.handle("oxoai:repartir-bilan", (event) => {
    if (!depuisLaFenetre(event) || !options.donnees) return null;
    return repartir.bilan(options.donnees);
  });
  ipcMain.handle("oxoai:repartir-oublier", (event) => {
    if (!depuisLaFenetre(event) || !options.donnees) return false;
    repartir.oublierBilan(options.donnees);
    return true;
  });

  return {
    /** Réponse de la passerelle (`mot-de-passe-local`), relayée par main.cjs. */
    recevoir(m) {
      if (m && typeof m.id === "string") attentes.get(m.id)?.(m);
    },
  };
}

module.exports = { installerMotDePasseOublie, TEXTES };
