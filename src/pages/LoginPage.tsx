import { useEffect, useState } from "react";
import {
  LogIn,
  UserPlus,
  TriangleAlert,
  Lock,
  ArrowLeft,
  KeyRound,
  ShieldCheck,
  Copy,
  Check,
  Mail,
  LifeBuoy,
  Fingerprint,
  FileText,
  RotateCcw,
} from "lucide-react";
import { LogoMark } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Avatar } from "@/components/ui/Avatar";
import { InfoBox } from "@/components/ui/InfoBox";
import { Switch } from "@/components/ui/Switch";
import { branding } from "@/config/branding";
import {
  allAccounts,
  createAccount,
  authenticate,
  definirPremierMotDePasse,
  remplacerMotDePasseProvisoire,
  validerDeuxFacteurs,
  preparerInscription,
  activerInscription,
  recupererAvecCode,
  toUser,
  type Account,
  type Connexion,
} from "@/lib/store/accounts";
import { ACCOUNTS_CHANGED } from "@/lib/store/sync";
import { setCurrentUser } from "@/lib/store/identity";
import { estCodeInvitation, invitationEnCours, oublierInvitation, rejoindreAvecCode } from "@/lib/invitations";
import { GATEWAY_BASE } from "@/lib/endpoint";
import { claimInvitations } from "@/lib/store/projects";
import { claimSessionShares } from "@/lib/store/sessions";
import { cn } from "@/lib/cn";
import { QrCode } from "@/components/ui/QrCode";
import { adresseOtpauth, secretLisible } from "@/lib/deuxFacteurs";
import { t, tf } from "@/lib/i18n";
import { copierTexte } from "@/lib/pressePapiers";
import {
  apercuRepartir,
  bilanRepartir,
  creerCodesRecuperation,
  ecrireCodeLocal,
  ecrireCodeRepartir,
  oublierBilanRepartir,
  reconnaissanceLocale,
  redefinirLocalement,
  repartirDeZero,
  type ApercuRepartir,
} from "@/lib/motDePasseOublie";

/** Même règle que la passerelle (`MOT_DE_PASSE_MIN`), qui reste seule juge. */
const MOT_DE_PASSE_MIN = 10;

type Mode =
  | "choix"
  | "connexion"
  | "premier"
  /** Mot de passe choisi par l'administrateur qui a créé le compte : en choisir un à soi. */
  | "provisoire"
  | "deuxfacteurs"
  /** Instance qui impose le second facteur : activation avant la séance. */
  | "inscription"
  /** Codes de secours remis à la fin de l'activation, une seule fois. */
  | "codes"
  | "creation"
  /** « Mot de passe oublié ? » : les trois voies, expliquées (23/10/2026). */
  | "oubli"
  /** Sur la machine de l'instance : l'ordinateur reconnaît la session. */
  | "oubli-local"
  /** Un code de récupération redéfinit le mot de passe. */
  | "oubli-code"
  /** Premier compte de l'instance : proposer des codes de récupération. */
  | "recuperation"
  /** Ne plus s'en sortir : repartir de zéro sur cet ordinateur, données mises de côté. */
  | "repartir";

/**
 * Écran de connexion.
 *
 * Les comptes sont locaux : Helix ne contacte aucun service d'authentification.
 * Le compte détermine à qui appartiennent le profil, la mémoire et les sessions.
 */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  /*
   * Sur un poste rattaché, la liste des comptes arrive de l'instance une
   * fraction de seconde après l'affichage. Sans cette écoute, le collègue reste
   * bloqué sur « créer un compte » et finit par en créer un second en doublon.
   */
  const [accounts, setAccounts] = useState<Account[]>(() => allAccounts());
  /*
   * Une invitation en cours mène droit à la création du compte : la personne
   * vient de rattacher son poste avec son code, il ne lui reste qu'à choisir
   * son nom et son mot de passe.
   */
  const [mode, setMode] = useState<Mode>(
    invitationEnCours() || accounts.length === 0 ? "creation" : "choix",
  );

  useEffect(() => {
    const relire = () => {
      const liste = allAccounts();
      setAccounts(liste);
      // On ne bascule que depuis l'écran de création automatique : si la
      // personne a explicitement demandé « Ajouter un compte », on la laisse.
      /*
       * Et l'inverse : un choix parmi zéro compte. La liste de départ vient de
       * la copie gardée par ce poste ; une instance neuve (réinstallée, ou une
       * autre passerelle sur la même adresse) en compte zéro une fois relue.
       * L'écran restait sur « Choisissez votre compte pour continuer » sans
       * aucun compte à choisir (tournée à l'écran du 28/09/2026).
       */
      setMode((courant) =>
        courant === "creation" && liste.length > 0 && !fullName && !email && !invitationEnCours()
          ? "choix"
          : courant === "choix" && liste.length === 0
            ? "creation"
            : courant,
      );
    };
    window.addEventListener(ACCOUNTS_CHANGED, relire);
    window.addEventListener("storage", relire);
    return () => {
      window.removeEventListener(ACCOUNTS_CHANGED, relire);
      window.removeEventListener("storage", relire);
    };
  });
  const [selected, setSelected] = useState<Account | null>(null);
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [defi, setDefi] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [secretInscription, setSecretInscription] = useState<string | null>(null);
  const [codesSecours, setCodesSecours] = useState<string[]>([]);
  const [compteOuvert, setCompteOuvert] = useState<Account | null>(null);
  const [copie, setCopie] = useState(false);
  /** Les codes affichés sont-ils ceux du second facteur, ou de récupération du mot de passe ? */
  const [sorteCodes, setSorteCodes] = useState<"secours" | "recuperation">("secours");
  /*
   * Mot de passe oublié (23/10/2026). `moyenLocal` : la reconnaissance par
   * l'ordinateur est-elle possible ici (application de bureau qui fait
   * tourner l'instance) ; `fichierCode` : où le code a été écrit (Windows,
   * Linux) ; `codeOubli` : code du fichier, ou code de récupération.
   */
  const [moyenLocal, setMoyenLocal] = useState<"systeme" | "fichier" | null>(null);
  const [fichierCode, setFichierCode] = useState<string | null>(null);
  const [codeOubli, setCodeOubli] = useState("");
  const [retirerDf, setRetirerDf] = useState(false);

  /*
   * Repartir de zéro (electron/repartirDeZero.cjs) : ce qui sera mis de côté
   * et le mot à taper ; `depart` quand la demande est partie (l'application
   * redémarre) ; `bilan` au premier lancement d'après : où sont les anciennes
   * données, ou pourquoi rien n'a bougé.
   */
  const [apercuDepart, setApercuDepart] = useState<ApercuRepartir | null>(null);
  const [motDepart, setMotDepart] = useState("");
  const [depart, setDepart] = useState<string[] | null>(null);
  const [bilan, setBilan] = useState<{ etat: "fait" | "echec"; dossiers: string[] } | null>(null);

  useEffect(() => {
    void reconnaissanceLocale().then(setMoyenLocal);
    void bilanRepartir().then(setBilan);
  }, []);
  /*
   * « Rester connecté sur ce poste ». Ce n'est pas le mot de passe qu'on
   * mémorise — il n'est conservé nulle part — c'est la séance qui dure trente
   * jours au lieu de douze heures. Le choix suit toute la connexion : la
   * séance n'est ouverte qu'à la dernière étape, après le code si la double
   * authentification est active.
   */
  const [rester, setRester] = useState(false);
  /*
   * Invitation en cours : posée par l'écran de mise en route quand le poste a
   * été rattaché avec un code (lib/invitations.ts). Elle porte l'adresse
   * invitée, et l'instance imposera celle-là quoi qu'il arrive.
   */
  const [invitationDuLien] = useState(() => invitationEnCours());
  /*
   * Code d'invitation saisi ici même, sur un poste déjà rattaché à l'instance
   * (parcours du 28/09/2026). « Ajouter un compte » menait à un formulaire
   * que l'instance refusait toujours une fois rempli : elle a déjà des comptes,
   * et n'en ouvre plus que sur invitation ou par l'administrateur connecté
   * (gateway/src/index.ts, `handleAuthCreate`). Or l'écran de connexion est
   * justement celui où personne n'est connecté. Le code demandé d'emblée, et
   * vérifié dès qu'il est complet, en fait un parcours qui aboutit.
   */
  const [codeSaisi, setCodeSaisi] = useState("");
  const [invitationSaisie, setInvitationSaisie] = useState<{ code: string; email: string } | null>(null);
  const invitation = invitationDuLien ?? invitationSaisie;
  const codeRequis = !invitationDuLien && accounts.length > 0;

  // L'adresse du code, posée une fois : le champ est ensuite en lecture seule.
  useEffect(() => {
    if (invitation) setEmail(invitation.email);
  }, [invitation]);

  useEffect(() => {
    if (!codeRequis) return;
    const code = codeSaisi.trim();
    setInvitationSaisie(null);
    if (!estCodeInvitation(code)) return;
    let abandon = false;
    // La même vérification que pour rattacher un poste : elle ne consomme pas le code.
    void rejoindreAvecCode(GATEWAY_BASE, code).then((r) => {
      if (abandon) return;
      if (r.ok) {
        setInvitationSaisie({ code, email: r.email });
        setError(undefined);
      } else setError(r.message);
    });
    return () => {
      abandon = true;
    };
  }, [codeSaisi, codeRequis]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const ouvrir = (account: Account) => {
    const user = toUser(account);
    setCurrentUser(user);
    // Les invitations reçues avant la création du compte deviennent actives.
    claimInvitations(user);
    claimSessionShares(user);
    onSignedIn();
  };

  /** Suite commune à toutes les étapes : séance ouverte, ou étape suivante. */
  const suite = (issue: Connexion) => {
    if (issue.ok) return ouvrir(issue.account);
    if (issue.raison === "a-definir") {
      setNewPassword("");
      setConfirmation("");
      setMode("premier");
      return;
    }
    // Le mot de passe saisi reste en mémoire le temps de l'étape : il prouve qu'on a bien reçu le provisoire.
    if (issue.raison === "a-changer") {
      setNewPassword("");
      setConfirmation("");
      setMode("provisoire");
      return;
    }
    if (issue.raison === "deux-facteurs") {
      setDefi(issue.defi);
      setCode("");
      setMode("deuxfacteurs");
      return;
    }
    if (issue.raison === "inscription") {
      commencerInscription(issue.defi);
      return;
    }
    // Liste du poste en retard : le compte a déjà son mot de passe.
    if (issue.raison === "deja-defini") {
      setPassword("");
      setMode("connexion");
    }
    // Défi expiré ou épuisé : il faut repasser par le mot de passe.
    if (issue.raison === "expire") {
      setDefi(null);
      setPassword("");
      setMode("connexion");
    }
    setError(issue.message);
  };

  const enTravail = async (travail: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await travail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signIn = (account: Account, pwd: string) =>
    enTravail(async () => suite(await authenticate(account.id, pwd, rester)));

  /*
   * Aucun compte ne s'ouvre plus par simple sélection, et l'écran ne sait plus
   * d'avance lesquels n'ont pas encore de mot de passe : la liste ouverte ne
   * le dit plus, parce que le dire revenait à désigner les comptes qu'un
   * porteur du jeton d'instance pouvait s'approprier. On demande donc le mot
   * de passe à tout le monde ; l'instance répond « à définir » pour le seul
   * compte visé, et l'écran bascule alors sur le choix du premier.
   */
  const pick = (account: Account) => {
    setSelected(account);
    setPassword("");
    setNewPassword("");
    setConfirmation("");
    setError(undefined);
    setMode("connexion");
  };

  // La longueur est annoncée par l'aide et bloque le bouton ; seule la
  // différence entre les deux saisies mérite un message, sinon on crie en rouge
  // dès la première lettre tapée.
  const saisiesDifferentes = confirmation !== "" && confirmation !== newPassword;
  const nouveauValide = newPassword.length >= MOT_DE_PASSE_MIN && confirmation === newPassword;

  const provisoire = (account: Account) =>
    enTravail(async () => {
      if (!nouveauValide) return;
      suite(await remplacerMotDePasseProvisoire(account.id, password, newPassword, rester));
    });

  const premier = (account: Account) =>
    enTravail(async () => {
      if (!nouveauValide) return;
      suite(await definirPremierMotDePasse(account.id, newPassword, rester));
    });

  const deuxFacteurs = () =>
    enTravail(async () => {
      if (!defi || !code.trim()) return;
      suite(await validerDeuxFacteurs(defi, code.trim(), rester));
    });

  /*
   * Activation imposée : le secret est demandé une fois par défi (l'instance
   * rend le même si on recharge), puis affiché en QR code.
   */
  const commencerInscription = (nouveauDefi: string) => {
    setDefi(nouveauDefi);
    setCode("");
    setSecretInscription(null);
    setMode("inscription");
    void preparerInscription(nouveauDefi)
      .then(({ secret }) => setSecretInscription(secret))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const activer = () =>
    enTravail(async () => {
      if (!defi || !code.trim()) return;
      const { connexion, codesDeSecours } = await activerInscription(defi, code.trim(), rester);
      if (connexion.ok) {
        setSecretInscription(null);
        setSorteCodes("secours");
        setCodesSecours(codesDeSecours);
        setCompteOuvert(connexion.account);
        setMode("codes");
        return;
      }
      suite(connexion);
    });

  const copierCodes = async () => {
    // lib/pressePapiers (27/09/2026) : dans l'application de bureau, `navigator.clipboard` était toujours refusé.
    if (await copierTexte(codesSecours.join("\n"))) {
      setCopie(true);
    } else {
      setCopie(false);
      setError(t("La copie a échoué : recopiez les codes à la main."));
    }
  };

  const retourAuChoix = () => {
    setMode("choix");
    setDefi(null);
    setError(undefined);
  };

  /** Vers une voie de « Mot de passe oublié ? » : les saisies repartent de zéro. */
  const allerOubli = (vers: "oubli" | "oubli-local" | "oubli-code") => {
    setNewPassword("");
    setConfirmation("");
    setCodeOubli("");
    setFichierCode(null);
    setRetirerDf(false);
    setError(undefined);
    setMode(vers);
  };

  const ecrireCode = (account: Account) =>
    enTravail(async () => {
      setFichierCode(await ecrireCodeLocal(account.id, account.email));
      setCodeOubli("");
    });

  /** L'ordinateur a reconnu la session : nouveau mot de passe enregistré, puis la connexion comme d'habitude. */
  const redefinirIci = (account: Account) =>
    enTravail(async () => {
      if (!nouveauValide) return;
      if (moyenLocal === "fichier" && !codeOubli.trim()) return;
      await redefinirLocalement({
        accountId: account.id,
        email: account.email,
        motDePasse: newPassword,
        retirerDeuxFacteurs: retirerDf,
        ...(moyenLocal === "fichier" ? { code: codeOubli.trim() } : {}),
      });
      setFichierCode(null);
      suite(await authenticate(account.id, newPassword, rester));
    });

  const recuperer = (account: Account) =>
    enTravail(async () => {
      if (!nouveauValide || !codeOubli.trim()) return;
      suite(await recupererAvecCode(account.id, codeOubli.trim(), newPassword, rester));
    });

  const allerRepartir = () =>
    enTravail(async () => {
      const a = await apercuRepartir();
      if (!a) throw new Error(t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."));
      setApercuDepart(a);
      setMotDepart("");
      setCodeOubli("");
      setFichierCode(null);
      setMode("repartir");
    });

  const ecrireCodeDepart = () =>
    enTravail(async () => {
      setFichierCode(await ecrireCodeRepartir());
      setCodeOubli("");
    });

  const repartir = () =>
    enTravail(async () => {
      if (!apercuDepart || !motDepart.trim()) return;
      if (apercuDepart.moyen === "fichier" && !codeOubli.trim()) return;
      setDepart(await repartirDeZero(motDepart.trim(), apercuDepart.moyen === "fichier" ? codeOubli.trim() : undefined));
    });

  /** Premier compte : les codes de récupération, tirés avec le mot de passe qu'on vient de choisir. */
  const tirerCodesRecuperation = () =>
    enTravail(async () => {
      const { codes } = await creerCodesRecuperation(newPassword);
      setCodesSecours(codes);
      setSorteCodes("recuperation");
      setCopie(false);
      setMode("codes");
    });

  const create = () =>
    enTravail(async () => {
      if (!fullName.trim() || !email.trim() || !nouveauValide) return;
      /*
       * Même garde que le bouton (28/09/2026) : Entrée dans la confirmation du
       * mot de passe passait outre le code d'invitation manquant, et l'instance
       * refusait alors la création avec un message qui ne parlait pas du code.
       */
      if (codeRequis && !invitationSaisie) return;
      const { account, inscription } = await createAccount({
        fullName,
        email,
        password: newPassword,
        ...(invitation ? { invitation: invitation.code } : {}),
        rester,
      });
      // Le code a servi : il ne vaut plus rien, et n'a plus à traîner.
      if (invitation) oublierInvitation();
      if (inscription) {
        setSelected(account);
        commencerInscription(inscription);
        return;
      }
      /*
       * Premier compte de l'instance, celui qui l'administre (23/10/2026) :
       * personne au-dessus pour réinitialiser son mot de passe. On lui propose
       * des codes de récupération avant d'ouvrir l'application.
       */
      if (accounts.length === 0 && !invitation) {
        setCompteOuvert(account);
        setMode("recuperation");
        return;
      }
      ouvrir(account);
    });

  const carteDuCompte = (account: Account) => (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <Avatar size={36} initials={account.initials} photo={account.photo} nom={account.fullName} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">{account.fullName}</span>
        <span className="block truncate text-xs text-muted-foreground">{account.email}</span>
      </span>
    </div>
  );

  const lienRetour = (libelle: string) => (
    <button
      type="button"
      onClick={retourAuChoix}
      className="flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft size={14} strokeWidth={1.75} /> {libelle}
    </button>
  );

  /** Nouveau mot de passe et sa confirmation : création et premier mot de passe. */
  const champsNouveau = (valider: () => void, autoFocus = false) => (
    <>
      <Field
        label={t("Mot de passe")}
        hint={tf("Au moins {0} caractères. Une phrase courte se retient mieux qu'un mot compliqué.", MOT_DE_PASSE_MIN)}
      >
        <Input
          type="password"
          value={newPassword}
          autoFocus={autoFocus}
          autoComplete="new-password"
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </Field>
      <Field label={t("Confirmez le mot de passe")} error={saisiesDifferentes ? t("Les deux saisies diffèrent.") : undefined}>
        <Input
          type="password"
          value={confirmation}
          autoComplete="new-password"
          onChange={(e) => setConfirmation(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") valider();
          }}
        />
      </Field>
    </>
  );

  return (
    // `my-auto` plutôt que `justify-center` : centré quand tout tient, et
    // défilable quand la fenêtre est basse. Avec `justify-center`, le haut de la
    // carte sortait de l'écran sans qu'on puisse y remonter.
    <div className="flex h-screen w-screen flex-col items-center overflow-y-auto bg-background px-6 py-10">
      <div className="my-auto w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark size={52} animated />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {branding.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {mode === "creation"
              ? t("Créez votre compte pour commencer.")
              : mode === "premier" || mode === "provisoire"
                ? t("Choisissez votre mot de passe.")
                : mode === "oubli" || mode === "oubli-local" || mode === "oubli-code"
                  ? t("Mot de passe oublié")
                  : mode === "repartir"
                    ? t("Repartir de zéro")
                  : mode === "recuperation"
                    ? t("Une dernière précaution.")
                : mode === "deuxfacteurs"
                  ? t("Dernière étape : le code de vérification.")
                  : mode === "inscription"
                    ? t("Votre instance demande une double authentification.")
                    : mode === "codes"
                      ? sorteCodes === "recuperation"
                        ? t("Gardez vos codes de récupération.")
                        : t("Gardez vos codes de secours.")
                      : t("Choisissez votre compte pour continuer.")}
          </p>
        </div>

        {/* Premier lancement après « Repartir de zéro » : où sont les anciennes données */}
        {bilan && (
          <InfoBox tone={bilan.etat === "fait" ? "info" : "warning"} className="mb-4" leading={<RotateCcw size={15} strokeWidth={1.75} />}>
            {bilan.etat === "fait"
              ? t("Nouveau départ. Vos anciennes données sont restées sur cet ordinateur, ici :")
              : t("Repartir de zéro n'a pas pu se faire : un dossier était encore utilisé par un programme. Rien n'a bougé, vos données sont toujours là. Fermez les autres programmes, puis réessayez.")}
            {bilan.etat === "fait" && (
              <>
                <ul className="mt-2 space-y-1">
                  {bilan.dossiers.map((d) => (
                    <li key={d} className="break-all font-mono text-xs">{d}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs">{t("Pour les effacer pour de bon, mettez ces dossiers à la corbeille et videz-la.")}</p>
              </>
            )}
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void oublierBilanRepartir();
                  setBilan(null);
                }}
              >
                {t("Compris")}
              </Button>
            </div>
          </InfoBox>
        )}

        {/* Choix du compte */}
        {mode === "choix" && (
          <div className="space-y-2">
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => pick(account)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-start transition-colors hover:bg-muted"
              >
                <Avatar size={36} initials={account.initials} photo={account.photo} nom={account.fullName} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">
                    {account.fullName}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {account.email}
                  </span>
                </span>
                <Lock size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
              </button>
            ))}
            <Button
              variant="secondary"
              icon={UserPlus}
              block
              className="mt-3"
              onClick={() => {
                setMode("creation");
                setError(undefined);
              }}
            >
              {t("Ajouter un compte")}
            </Button>
          </div>
        )}

        {/* Saisie du mot de passe */}
        {mode === "connexion" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <Field label={t("Mot de passe")}>
              <Input
                type="password"
                value={password}
                autoFocus
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void signIn(selected, password);
                }}
              />
            </Field>
            <label className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Switch
                checked={rester}
                onChange={setRester}
                label={t("Rester connecté sur ce poste")}
              />
              <span>{t("Rester connecté sur ce poste")}</span>
            </label>
            <Button
              icon={LogIn}
              block
              disabled={busy || !password}
              onClick={() => void signIn(selected, password)}
            >
              {t("Se connecter")}
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("Votre mot de passe n'est conservé nulle part. Coché, ce poste reste reconnu trente jours au lieu de douze heures, et cette séance se révoque à tout moment dans Réglages, Sécurité.")}
            </p>
            <button
              type="button"
              onClick={() => allerOubli("oubli")}
              className="flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              <LifeBuoy size={14} strokeWidth={1.75} /> {t("Mot de passe oublié ?")}
            </button>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {/* Premier mot de passe d'un compte créé sans */}
        {mode === "premier" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <InfoBox tone="info" leading={<KeyRound size={15} strokeWidth={1.75} />}>
              {t("Ce compte n'a pas encore de mot de passe. Choisissez-en un : il sera demandé à chaque connexion, sur ce poste comme sur les autres.")}
            </InfoBox>
            {champsNouveau(() => void premier(selected), true)}
            <Button
              icon={LogIn}
              block
              disabled={busy || !nouveauValide}
              onClick={() => void premier(selected)}
            >
              {t("Enregistrer et me connecter")}
            </Button>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {mode === "provisoire" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <InfoBox tone="info" leading={<KeyRound size={15} strokeWidth={1.75} />}>
              {t("Ce mot de passe vous a été donné par quelqu'un d'autre (la personne qui a créé votre compte, ou l'administrateur qui a réinitialisé le vôtre). Choisissez le vôtre : personne d'autre ne le connaîtra, et l'ancien ne servira plus.")}
            </InfoBox>
            {champsNouveau(() => void provisoire(selected), true)}
            <Button icon={LogIn} block disabled={busy || !nouveauValide} onClick={() => void provisoire(selected)}>
              {t("Enregistrer et me connecter")}
            </Button>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {/* Second facteur */}
        {mode === "deuxfacteurs" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <Field
              label={t("Code de vérification")}
              hint={t("Les six chiffres affichés par votre application d'authentification, ou l'un de vos codes de secours.")}
            >
              <Input
                value={code}
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={32}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void deuxFacteurs();
                }}
              />
            </Field>
            <Button
              icon={ShieldCheck}
              block
              disabled={busy || !code.trim()}
              onClick={() => void deuxFacteurs()}
            >
              {t("Vérifier")}
            </Button>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {/* Activation imposée du second facteur */}
        {mode === "inscription" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <p className="text-sm text-muted-foreground">
              {t("Scannez ce code avec une application d'authentification (Aegis, 2FAS, Mots de passe d'Apple, Google Authenticator...), puis saisissez les six chiffres qu'elle affiche.")}
            </p>
            {secretInscription ? (
              <div className="flex flex-col items-center gap-2">
                <QrCode
                  valeur={adresseOtpauth(secretInscription, selected.email)}
                  titre={t("QR code à scanner avec l'application d'authentification")}
                  taille={180}
                  className="border border-border"
                />
                <p className="text-center text-xs text-muted-foreground">
                  {t("Sans appareil photo, saisissez cette clé :")}
                </p>
                <p className="break-all text-center font-mono text-sm text-foreground">
                  {secretLisible(secretInscription)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("Préparation du code…")}</p>
            )}
            <Field
              label={t("Code de vérification")}
              hint={t("Refusé ? Vérifiez que l'heure du téléphone est réglée automatiquement.")}
            >
              <Input
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={32}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void activer();
                }}
              />
            </Field>
            <Button
              icon={ShieldCheck}
              block
              disabled={busy || !code.trim() || !secretInscription}
              onClick={() => void activer()}
            >
              {t("Activer et me connecter")}
            </Button>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {/* Codes de secours, une seule fois */}
        {mode === "codes" && compteOuvert && (
          <div className="space-y-4">
            <InfoBox tone="info" leading={<KeyRound size={15} strokeWidth={1.75} />}>
              {sorteCodes === "recuperation"
                ? t("Chacun de ces codes redéfinit votre mot de passe une fois, si vous l'oubliez (écran de connexion, « Mot de passe oublié ? »). Ils ne seront plus jamais affichés : imprimez-les ou rangez-les ailleurs que sur cet ordinateur.")
                : t("Chacun de ces codes ouvre votre compte une fois, si vous n'avez plus votre téléphone. Ils ne seront plus jamais affichés : imprimez-les ou rangez-les dans votre gestionnaire de mots de passe.")}
            </InfoBox>
            <ul className="grid grid-cols-2 gap-2 rounded-xl bg-muted/40 p-4 font-mono text-sm text-foreground">
              {codesSecours.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button variant="secondary" icon={copie ? Check : Copy} block onClick={() => void copierCodes()}>
              {copie ? t("Copiés") : t("Copier les codes")}
            </Button>
            <Button icon={LogIn} block onClick={() => ouvrir(compteOuvert)}>
              {t("J'ai mis mes codes à l'abri")}
            </Button>
          </div>
        )}


        {/* Mot de passe oublié : les trois voies (23/10/2026) */}
        {mode === "oubli" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <p className="text-sm text-muted-foreground">
              {t("Personne ne peut relire votre mot de passe, pas même l'instance. Il se remplace, de l'une de ces façons :")}
            </p>
            <div className="space-y-1 rounded-xl border border-border bg-card p-4">
              <p className="text-sm font-medium text-foreground">{t("Demander à un administrateur")}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("Un administrateur de l'instance réinitialise votre mot de passe (Réglages, Profil, Collègues). Il vous remet un mot de passe provisoire, valable 72 heures : à la connexion, vous en choisissez un à vous.")}
              </p>
            </div>
            {moyenLocal && (
              <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">{t("Vous faire reconnaître par cet ordinateur")}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {moyenLocal === "systeme"
                      ? t("Cet ordinateur fait tourner l'instance. macOS vous demande Touch ID ou le mot de passe de votre session, puis vous choisissez un nouveau mot de passe.")
                      : t("Cet ordinateur fait tourner l'instance. L'application écrit un code dans un fichier de votre dossier personnel : ouvrez-le, recopiez le code, puis choisissez un nouveau mot de passe.")}
                  </p>
                </div>
                <Button variant="secondary" icon={moyenLocal === "systeme" ? Fingerprint : FileText} block onClick={() => allerOubli("oubli-local")}>
                  {t("Me faire reconnaître par cet ordinateur")}
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void allerRepartir()}
                  className="flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  <RotateCcw size={13} strokeWidth={1.75} /> {t("Je ne m'en sors pas : repartir de zéro sur cet ordinateur")}
                </button>
              </div>
            )}
            <div className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t("Utiliser un code de récupération")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("Si vous en avez créé (Réglages, Sécurité), chacun redéfinit votre mot de passe une fois. Votre téléphone reste demandé si la double authentification est active.")}
                </p>
              </div>
              <Button variant="secondary" icon={KeyRound} block onClick={() => allerOubli("oubli-code")}>
                {t("J'ai un code de récupération")}
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("Un compte qui n'en a jamais créé, comme ceux d'avant cette version, n'en a pas : passez alors par un administrateur ou par l'ordinateur qui fait tourner l'instance.")}
              </p>
            </div>
            {!moyenLocal && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("Sur l'ordinateur qui fait tourner l'instance, l'application propose aussi de vous faire reconnaître par l'ordinateur lui-même.")}
              </p>
            )}
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {mode === "oubli-local" && selected && moyenLocal && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <InfoBox tone="info" leading={moyenLocal === "systeme" ? <Fingerprint size={15} strokeWidth={1.75} /> : <FileText size={15} strokeWidth={1.75} />}>
              {moyenLocal === "systeme"
                ? t("Choisissez votre nouveau mot de passe. En validant, macOS vous demande Touch ID ou le mot de passe de votre session. Toutes vos séances ouvertes sont fermées, et le changement est inscrit au journal.")
                : t("Choisissez votre nouveau mot de passe, puis recopiez le code que l'application écrit dans un fichier. Toutes vos séances ouvertes sont fermées, et le changement est inscrit au journal.")}
            </InfoBox>
            {champsNouveau(() => void redefinirIci(selected), true)}
            {moyenLocal === "fichier" && (
              <div className="space-y-3">
                <Button variant="secondary" icon={FileText} block disabled={busy} onClick={() => void ecrireCode(selected)}>
                  {fichierCode ? t("Écrire un nouveau code") : t("Écrire le code dans un fichier")}
                </Button>
                {fichierCode && (
                  <>
                    <p className="break-all text-xs leading-relaxed text-muted-foreground">
                      {tf("Le code est dans ce fichier, qui vient de s'ouvrir : {0}. Il ne vaut que dix minutes.", fichierCode)}
                    </p>
                    <Field label={t("Code du fichier")}>
                      <Input
                        value={codeOubli}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t("ABCD-EFGH")}
                        onChange={(e) => setCodeOubli(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void redefinirIci(selected);
                        }}
                      />
                    </Field>
                  </>
                )}
              </div>
            )}
            {selected.deuxFacteursActive && (
              <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <input type="checkbox" className="mt-1" checked={retirerDf} onChange={() => setRetirerDf((v) => !v)} />
                <span>{t("J'ai aussi perdu mon téléphone : retirer la double authentification (à réactiver ensuite dans Réglages, Sécurité).")}</span>
              </label>
            )}
            <Button
              icon={moyenLocal === "systeme" ? Fingerprint : ShieldCheck}
              block
              disabled={busy || !nouveauValide || (moyenLocal === "fichier" && (!fichierCode || !codeOubli.trim()))}
              onClick={() => void redefinirIci(selected)}
            >
              {t("Redéfinir mon mot de passe")}
            </Button>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}

        {mode === "oubli-code" && selected && (
          <div className="space-y-4">
            {carteDuCompte(selected)}
            <Field label={t("Code de récupération")} hint={t("Chaque code ne sert qu'une fois.")}>
              <Input
                value={codeOubli}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                placeholder={t("abcde-fghij")}
                onChange={(e) => setCodeOubli(e.target.value)}
              />
            </Field>
            {champsNouveau(() => void recuperer(selected))}
            <Button icon={KeyRound} block disabled={busy || !nouveauValide || !codeOubli.trim()} onClick={() => void recuperer(selected)}>
              {t("Redéfinir mon mot de passe")}
            </Button>
            {error && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("Pas de code de récupération, ou plus aucun ? Ils n'existent que si vous en avez créé dans Réglages, Sécurité. Revenez en arrière : un administrateur, ou l'ordinateur qui fait tourner l'instance, peuvent aussi vous aider.")}
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("Toutes vos séances ouvertes sont fermées, et le changement est inscrit au journal. Si la double authentification est active, le code de votre téléphone est demandé juste après.")}
            </p>
            {lienRetour(t("Changer de compte"))}
          </div>
        )}


        {/* Repartir de zéro sur cet ordinateur : rien n'est supprimé, tout est mis de côté */}
        {mode === "repartir" && apercuDepart && (
          <div className="space-y-4">
            {depart ? (
              <InfoBox tone="info" leading={<RotateCcw size={15} strokeWidth={1.75} />}>
                {t("C'est noté. L'application se ferme et redémarre comme au premier lancement. Vos anciennes données seront ici :")}
                <ul className="mt-2 space-y-1">
                  {depart.map((d) => (
                    <li key={d} className="break-all font-mono text-xs">{d}</li>
                  ))}
                </ul>
              </InfoBox>
            ) : (
              <>
                <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
                  {t("Tout ce que l'application garde sur cet ordinateur (comptes, Chats, réglages, outils qu'elle a installés) est mis de côté, puis elle redémarre comme au premier lancement. Rien n'est supprimé. LM Studio et ses modèles, OpenClaw et vos documents ne sont pas touchés.")}
                </InfoBox>
                <div className="space-y-1">
                  <p className="text-sm text-foreground">{t("Vos données actuelles iront dans :")}</p>
                  <ul className="space-y-1 rounded-xl bg-muted/40 p-3">
                    {apercuDepart.dossiers.map((d) => (
                      <li key={d} className="break-all font-mono text-xs text-foreground">{d}</li>
                    ))}
                  </ul>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("Elles y restent, lisibles sur cet ordinateur, tant que vous ne les supprimez pas. Pour les effacer pour de bon : mettez ces dossiers à la corbeille et videz-la. Pour revenir en arrière : quittez l'application, supprimez les nouveaux dossiers du même nom sans « -ancien- », et rendez aux anciens leur nom. Les outils que l'application avait installés (moteur de l'écran Code, dictée) seront à reposer, ce qui demande internet ; le reste fonctionne sans.")}
                  </p>
                </div>
                {apercuDepart.moyen === "fichier" && (
                  <div className="space-y-3">
                    <Button variant="secondary" icon={FileText} block disabled={busy} onClick={() => void ecrireCodeDepart()}>
                      {fichierCode ? t("Écrire un nouveau code") : t("Écrire le code dans un fichier")}
                    </Button>
                    {fichierCode && (
                      <>
                        <p className="break-all text-xs leading-relaxed text-muted-foreground">
                          {tf("Le code est dans ce fichier, qui vient de s'ouvrir : {0}. Il ne vaut que dix minutes.", fichierCode)}
                        </p>
                        <Field label={t("Code du fichier")}>
                          <Input value={codeOubli} autoComplete="off" spellCheck={false} placeholder={t("ABCD-EFGH")} onChange={(e) => setCodeOubli(e.target.value)} />
                        </Field>
                      </>
                    )}
                  </div>
                )}
                <Field label={tf("Pour confirmer, tapez {0}", apercuDepart.mot)}>
                  <Input value={motDepart} autoComplete="off" spellCheck={false} onChange={(e) => setMotDepart(e.target.value)} />
                </Field>
                <Button
                  variant="destructive"
                  icon={RotateCcw}
                  block
                  disabled={
                    busy ||
                    motDepart.trim().toLocaleUpperCase() !== apercuDepart.mot.toLocaleUpperCase() ||
                    (apercuDepart.moyen === "fichier" && (!fichierCode || !codeOubli.trim()))
                  }
                  onClick={() => void repartir()}
                >
                  {apercuDepart.moyen === "systeme" ? t("Me faire reconnaître et repartir de zéro") : t("Repartir de zéro")}
                </Button>
                {lienRetour(t("Changer de compte"))}
              </>
            )}
          </div>
        )}

        {/* Premier compte : des codes de récupération, proposés une fois */}
        {mode === "recuperation" && compteOuvert && (
          <div className="space-y-4">
            {carteDuCompte(compteOuvert)}
            <InfoBox tone="info" leading={<LifeBuoy size={15} strokeWidth={1.75} />}>
              {t("Vous administrez cette instance : personne d'autre ne pourra réinitialiser votre mot de passe. Créez des codes de récupération et gardez-les à l'abri : chacun redéfinit votre mot de passe une fois, si vous l'oubliez.")}
            </InfoBox>
            <Button icon={KeyRound} block disabled={busy} onClick={() => void tirerCodesRecuperation()}>
              {t("Créer mes codes de récupération")}
            </Button>
            <Button variant="secondary" block disabled={busy} onClick={() => ouvrir(compteOuvert)}>
              {t("Plus tard")}
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("Vous pourrez les créer à tout moment dans Réglages, Sécurité.")}
            </p>
          </div>
        )}

        {/* Création de compte */}
        {mode === "creation" && (
          <div className="space-y-4">
            {!invitation && codeRequis && (
              <InfoBox leading={<Mail size={15} strokeWidth={1.75} />}>
                {t("Cette instance a déjà des comptes : un nouveau s'ouvre avec le code d'invitation qu'un collègue vous a envoyé (Réglages, Profil, Inviter un collègue).")}
              </InfoBox>
            )}
            {codeRequis && (
              <Field
                label={t("Code d'invitation")}
                hint={invitationSaisie ? t("Code d'invitation reconnu. Vous choisirez votre mot de passe juste après.") : undefined}
              >
                <Input
                  value={codeSaisi}
                  autoFocus
                  placeholder={t("ABCD-EFGH-IJKL-MNOP")}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setCodeSaisi(e.target.value)}
                />
              </Field>
            )}
            {invitation && (
              <InfoBox leading={<Mail size={15} strokeWidth={1.75} />}>
                {t("Vous avez été invité sur cette instance. Choisissez votre mot de passe : il n'appartient qu'à vous, personne d'autre ne le connaîtra.")}
              </InfoBox>
            )}
            <Field label={t("Nom complet")}>
              <Input
                value={fullName}
                autoFocus={!codeRequis}
                placeholder={t("Marie Durand")}
                onChange={(e) => setFullName(e.target.value)}
              />
            </Field>
            <Field
              label={t("Adresse email")}
              hint={invitation ? t("C'est l'adresse à laquelle vous avez été invité.") : undefined}
            >
              <Input
                type="email"
                value={email}
                placeholder={t("marie.durand@entreprise.fr")}
                /*
                 * Sur invitation, l'adresse est celle du code : l'instance la
                 * refuserait de toute façon différente, autant ne pas laisser
                 * quelqu'un la saisir pour rien.
                 */
                disabled={Boolean(invitation)}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            {champsNouveau(() => void create())}
            <Button
              icon={UserPlus}
              block
              disabled={busy || !fullName.trim() || !email.trim() || !nouveauValide || (codeRequis && !invitationSaisie)}
              onClick={() => void create()}
            >
              {t("Créer mon compte")}
            </Button>
            {accounts.length > 0 && lienRetour(t("Retour"))}
          </div>
        )}

        {error && (
          <InfoBox
            tone="warning"
            className={cn("mt-4")}
            leading={<TriangleAlert size={15} strokeWidth={1.75} />}
          >
            {error}
          </InfoBox>
        )}

        <p className="mt-8 text-center text-xs leading-relaxed text-muted-foreground">
          {tf("Les comptes restent sur cette instance. {0} ne contacte aucun service d'authentification. Le mot de passe sépare les comptes entre collègues ; ce n'est pas lui qui chiffre les données de l'instance.", branding.name)}
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
