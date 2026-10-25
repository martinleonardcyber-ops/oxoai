import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, ExternalLink, KeyRound, Link2, Loader2, Lock, ShieldAlert, Trash2 } from "lucide-react";
import {
  collerAdresseNatif,
  connecterNatif,
  effacerApplication,
  enregistrerApplication,
  etatNatifs,
  oublierNatif,
  type EtatNatif,
  type EtatNatifs,
  type IdChoix,
  type IdNatif,
} from "@/lib/natifs";
import { etatClientGoogle, type EtatClientGoogle } from "@/lib/google";
import { Card } from "@/components/settings/SettingsShell";
import { FormulaireClientGoogle } from "@/components/settings/ClientGoogle";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { LogoMarqueGrand } from "@/components/settings/TuileService";
import { estNatifProjet, libelleChoixProjet, pourquoiApplicationProjet, revueProjet } from "@/components/settings/ConnecteurProjets";
import { GuideApplication } from "@/components/settings/GuideApplication";
import { activerApisGoogle, API_GOOGLE, guideApplication, type ServiceGoogle } from "@/lib/guidesApplications";
import { branding } from "@/config/branding";
import { formaterDate } from "@/lib/formats";
import { t, tf, lister } from "@/lib/i18n";
// Google Docs, Google Forms, Dropbox (28/09/2026) : leurs textes vivent à part.
import { libelleChoixDocuments, revueDocuments } from "@/components/settings/ConnecteurNatifDocuments";

/**
 * Panneau d'un service branché nativement (gateway/src/oauthNatif.ts) :
 * Google Sheets, Google Slides, YouTube, LinkedIn, Facebook, Instagram,
 * TikTok, et X (ex-Twitter). Ajouté le 28/09/2026 à la demande de Medhi.
 *
 * Il dit, en mots simples, comment l'organisation crée son application chez
 * le fournisseur, ce qui marche sans revue et ce qui en demande une, et que
 * rien n'a encore été essayé avec un vrai compte. Les étapes décrivent les
 * consoles telles que leur documentation les présentait le 28/09/2026 : leurs
 * libellés changent, et l'écran le dit.
 */

/** Les services Google d'ici, et l'API que chacun demande d'activer (lib/guidesApplications.ts). */
const SERVICE_GOOGLE: Partial<Record<IdNatif, ServiceGoogle>> = { sheets: "sheets", slides: "slides", youtube: "youtube", docs: "docs", forms: "forms" };

function Lien({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="underline" href={href} target="_blank" rel="noreferrer noopener">
      {children} <ExternalLink size={11} className="inline" />
    </a>
  );
}

/**
 * Le logo de YouTube, en tête de son panneau (décision de Medhi, 28/09/2026).
 *
 * La liste des connecteurs le montrerait à 22 px, sous les 100 px que la
 * charte impose (https://brand.youtube/youtube-logo/) : le logo complet ne
 * paraît qu'ici, en grand ; la liste montre l'icône de YouTube (`youtubeIcone`,
 * troisième tournée des logos, 28/09/2026, décision de Medhi). La charte des
 * développeurs (https://developers.google.com/youtube/terms/branding-guidelines)
 * prévoit, pour une fonction qui se sert de l'API, le logo complet plutôt que
 * l'icône, placé à côté de cette fonction, sur un fond uni, et cliquable vers
 * YouTube : d'où le lien vers la page d'accueil de YouTube, qu'elle cite en
 * exemple. Elle demande aussi qu'il ne soit pas l'élément le plus en vue de la
 * page : il n'est que dans le panneau déplié, sous le titre de l'écran et la
 * ligne YouTube de la liste. Dans une fenêtre trop étroite pour le montrer
 * entier à 100 px, il ne paraît pas (LogoMarqueGrand).
 */
function LogoYouTube({ nom }: { nom: string }) {
  return <LogoMarqueGrand marque="youtube" hauteur={100} lien="https://www.youtube.com/" libelle={tf("Ouvrir {0}", nom)} />;
}

/*
 * Comment créer l'application, service par service : lib/guidesApplications.ts
 * depuis le 28/09/2026 (boutons vers la page exacte de la console, étapes dans
 * son ordre, adresse de retour dans l'étape où on la colle, erreurs du
 * fournisseur expliquées), affiché par GuideApplication.tsx. Meta ne fait plus
 * choisir un « type » d'app mais des cas d'usage (https://developers.facebook.com/docs/development/create-an-app) :
 * les étapes de Facebook et d'Instagram les nomment, telles que la console les
 * affiche, en anglais.
 */

/** Ce qui marche sans examen du fournisseur, et ce qui en demande un. */
function Revue({ id }: { id: IdNatif }) {
  if (estNatifProjet(id)) return <p>{revueProjet(id)}</p>;
  const texte: Partial<Record<IdNatif, string>> = {
    ...revueDocuments(),
    sheets: t("Aucun examen pour une application interne à votre Google Workspace. Écrire ouvre toutes les feuilles du compte : Google n'a pas d'accès plus étroit pour une application de bureau."),
    slides: t("Aucun examen pour une application interne à votre Google Workspace. Lecture seule."),
    youtube: t("Aucun examen pour une application interne à votre Google Workspace. Lecture seule : chaînes, vidéos, statistiques publiques. 10 000 unités de quota par jour, une lecture en coûte une."),
    linkedin: t("Sans examen : se connecter et publier au nom de son profil. Impossible : lire les publications d'un profil (LinkedIn n'ouvre plus cet accès). La page d'une entreprise ne passe pas par cette application : elle se branche à part, ligne « LinkedIn (Page d'entreprise) ». Limite : 150 publications par personne et par jour."),
    /*
     * La Page d'entreprise (29/09/2026) : https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access
     * et https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review, lus ce jour-là.
     */
    linkedinPage: t("Tout passe par un examen : LinkedIn n'ouvre les pages d'entreprise qu'au produit « Community Management API », qu'il accorde après avoir vérifié l'organisation, et seulement à une application qui n'a aucun autre produit. Premier palier (« Development tier ») : 500 appels par jour pour l'application et 100 par personne, intégration à terminer en douze mois. Palier standard, sans ces limites : une seconde demande, avec une vidéo de l'application. LinkedIn n'annonce pas de délai d'examen. Le compte qui se connecte doit administrer la page."),
    facebook: t("Sans examen (« accès standard ») : seulement pour les personnes qui ont un rôle dans l'application. Pour d'autres personnes : examen de l'application par Meta et vérification de l'entreprise. L'accès dure 60 jours, puis il faut se reconnecter."),
    instagram: t("Sans examen : seulement pour les comptes qui ont un rôle dans l'application (testeur Instagram compris). Pour d'autres comptes : examen par Meta. Publier : une photo JPEG, à une adresse web publique, 100 publications par jour au plus. L'accès dure 60 jours et se renouvelle seul."),
    tiktok: t("Sans examen : le bac à sable, jusqu'à 10 comptes. Tant que l'application n'a pas passé l'audit de TikTok, tout ce qu'elle publie reste privé (visible de vous seul)."),
    // https://docs.x.com/x-api/getting-started/pricing et https://docs.x.com/changelog, lus le 28/09/2026.
    x: t("Aucun examen de X pour brancher le compte de votre organisation, mais l'API est payante. Depuis le 6 février 2026, X n'a plus d'offre gratuite pour les nouveaux développeurs : on achète des crédits d'avance, et chaque appel est décompté. Tarifs publiés par X au 28 septembre 2026 : publier un post, 0,015 $ (0,20 $ s'il contient une adresse web) ; lire un de vos posts, 0,001 $ si le compte branché est celui qui a créé l'application, 0,005 $ sinon. Il faut des crédits avant le premier appel. Les offres Basic et Pro, pour qui y est déjà abonné, permettent aussi de lire et de publier. Limite de X : 100 posts par 15 minutes. Citer un post, suivre, aimer : X ne le permet plus par son API."),
  };
  return <p>{texte[id]}</p>;
}

/** Traduit au rendu, pas au chargement du module : la langue n'est pas encore connue à ce moment-là. */
function libelleChoix(id: IdNatif, c: IdChoix): string {
  if (estNatifProjet(id)) return libelleChoixProjet(c);
  const documents = libelleChoixDocuments(id);
  if (documents) return documents;
  if (id === "sheets") return t("Permettre aussi d'écrire dans les feuilles (remplacer une plage, ajouter des lignes).");
  if (id === "facebook") return t("Permettre de publier des posts sur les pages.");
  if (id === "instagram") return t("Permettre de publier des photos.");
  if (id === "tiktok") return t("Permettre de publier des vidéos du dossier de travail.");
  if (id === "x") return t("Permettre de publier des posts : un texte, et une image du dossier de travail si vous le demandez.");
  if (id === "linkedinPage") return t("Permettre de publier des posts au nom des pages que le compte administre.");
  return t("Permettre de publier des posts.");
}

/**
 * La Page d'entreprise LinkedIn se branche à part (29/09/2026) : le panneau du
 * profil le dit, et mène à l'autre ligne. `ancienne` : ce compte a été branché
 * avec l'ancienne case « page », qui n'est plus lue (gateway/src/oauthNatif.ts).
 */
function VersPageLinkedin({ ancienne, onOuvrir }: { ancienne: boolean; onOuvrir?: (id: IdNatif) => void }) {
  return (
    <InfoBox tone={ancienne ? "warning" : "muted"} leading={ancienne ? <ShieldAlert size={15} strokeWidth={1.75} /> : undefined}>
      <div className="space-y-2 [overflow-wrap:anywhere]">
        <p>
          {ancienne
            ? t("La case « page d'entreprise » cochée à cette connexion ne sert plus : LinkedIn ne l'accorde pas à l'application du profil. Le profil n'y perd rien. Pour la page, branchez « LinkedIn (Page d'entreprise) », avec sa propre application.")
            : t("Cette application sert au profil. La Page d'entreprise se branche à part, avec une seconde application : LinkedIn n'accorde pas les deux à la même.")}
        </p>
        {onOuvrir && (
          <Button
            size="sm"
            variant="secondary"
            className="!h-auto min-h-8 max-w-full py-1.5 text-start"
            icon={Link2}
            onClick={() => {
              onOuvrir("linkedinPage");
              // La ligne de la page est juste en dessous ; on l'amène à l'écran une fois ouverte.
              window.setTimeout(() => document.getElementById("connecteur-linkedinPage")?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
            }}
          >
            {t("Brancher la Page d'entreprise")}
          </Button>
        )}
      </div>
    </InfoBox>
  );
}

export function ConnecteurNatif({ id, onChange, onOuvrir }: { id: IdNatif; onChange?: () => void; onOuvrir?: (id: IdNatif) => void }) {
  const [etats, setEtats] = useState<EtatNatifs | null | undefined>(undefined);
  const [client, setClient] = useState<EtatClientGoogle | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  const [adresse, setAdresse] = useState<string | null>(null);
  const [collage, setCollage] = useState("");
  const [identifiant, setIdentifiant] = useState("");
  const [secret, setSecret] = useState("");
  const [choix, setChoix] = useState<IdChoix[]>([]);

  const relire = useCallback(async () => {
    const [e, c] = await Promise.all([etatNatifs(), etatClientGoogle()]);
    setEtats(e);
    setClient(c);
    return e?.services.find((s) => s.id === id) ?? null;
  }, [id]);

  useEffect(() => {
    void relire();
  }, [relire]);

  const etat: EtatNatif | undefined = etats?.services.find((s) => s.id === id);
  const attente = Boolean(etat?.attente);
  // L'accord se donne chez le fournisseur : seule l'instance sait quand il est revenu.
  useEffect(() => {
    if (!attente) return;
    const minuterie = setInterval(() => {
      void relire().then((e) => {
        if (!e || e.attente) return;
        setAdresse(null);
        setCollage("");
        if (e.issue?.ok) {
          setSucces(e.issue.message);
          onChange?.();
        } else if (e.issue) setErreur(e.issue.message);
      });
    }, 2000);
    return () => clearInterval(minuterie);
  }, [attente, relire, onChange]);

  const agir = async (fn: () => Promise<{ ok: boolean; message: string; url?: string }>, apres?: (url?: string) => void) => {
    setEnCours(true);
    setErreur(null);
    setSucces(null);
    const r = await fn();
    setEnCours(false);
    if (!r.ok) setErreur(r.message);
    else {
      setSucces(r.message);
      apres?.(r.url);
    }
    await relire();
    onChange?.();
  };

  if (etats === undefined) {
    return (
      <Card className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
        {t("Lecture de l'état du service…")}
      </Card>
    );
  }
  /*
   * Instance injoignable (revue du 28/09/2026) : le panneau déplié restait un
   * cadre vide, sans rien dire. Il le dit, comme celui des messageries.
   */
  if (!etats) {
    return (
      <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
        {tf("L'instance {0} ne répond pas. Réessayez quand elle est joignable.", branding.name)}
      </InfoBox>
    );
  }
  if (!etat) return null;
  const admin = etats.administrateur;
  const logo = id === "youtube" ? <LogoYouTube nom={etat.nom} /> : null;

  const messages = (
    <>
      {erreur && (
        <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
      {succes && <InfoBox leading={<Check size={15} strokeWidth={1.75} />}>{succes}</InfoBox>}
    </>
  );

  if (etat.configure) {
    const depuis = etat.depuis ? new Date(etat.depuis) : null;
    const expire = etat.expireLe ? new Date(etat.expireLe) : null;
    const ecrit = etat.accordes?.includes("ecriture") || etat.accordes?.includes("envoi");
    // Brevo et Mailchimp : des brouillons, et l'envoi s'il est coché, pas des publications.
    const droitsProjet = estNatifProjet(id)
      ? [etat.accordes?.includes("ecriture") ? t("brouillons") : "", etat.accordes?.includes("envoi") ? t("envoi de campagnes") : ""].filter(Boolean)
      : null;
    return (
      <div className="space-y-3">
        {logo}
        <Card className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{etat.compte}</p>
            <p className="text-sm text-muted-foreground">
              {droitsProjet && droitsProjet.length > 0 ? tf("{0}, lecture et {1}", etat.nom, lister(droitsProjet)) : ecrit ? tf("{0}, lecture et publication", etat.nom) : tf("{0}, lecture seule", etat.nom)}
              {depuis && !Number.isNaN(depuis.getTime()) ? tf(", connecté le {0}", formaterDate(depuis)) : ""}
            </p>
            {expire && !Number.isNaN(expire.getTime()) && (
              <p className="text-xs text-muted-foreground">{tf("L'accès expire le {0} : il faudra se reconnecter.", formaterDate(expire))}</p>
            )}
          </div>
          <span className="shrink-0 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">{t("Connecté")}</span>
        </Card>
        <InfoBox leading={<Lock size={15} strokeWidth={1.75} />}>
          {ecrit
            ? t("Vos agents peuvent lire, et proposer d'écrire ou de publier : chaque écriture et chaque publication vous est montrée en entier et n'a lieu qu'après votre accord, à chaque fois, quel que soit le niveau d'approbation. Seul l'administrateur de l'instance peut publier. L'accès est conservé chiffré sur l'instance et n'en ressort jamais.")
            : t("Lecture seule : vos agents peuvent lire, sans rien modifier ni publier. L'accès est conservé chiffré sur l'instance et n'en ressort jamais.")}
        </InfoBox>
        {id === "linkedin" && <VersPageLinkedin ancienne={Boolean(etat.accordes?.includes("page"))} onOuvrir={onOuvrir} />}
        {messages}
        {admin && (
          <div className="flex justify-end">
            <Button variant="destructive" size="sm" icon={enCours ? Loader2 : Trash2} disabled={enCours} onClick={() => void agir(() => oublierNatif(id))}>
              {tf("Débrancher {0}", etat.nom)}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const basculer = (c: IdChoix) => setChoix((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));
  const lancer = () =>
    agir(
      () => connecterNatif(id, choix),
      (url) => {
        if (!url) return;
        setAdresse(url);
        // Dans l'application de bureau, la fenêtre native confie ce lien au navigateur.
        window.open(url, "_blank", "noopener,noreferrer");
      },
    );
  const boucle = etat.retour.startsWith("http://127.0.0.1") && !etat.retour.includes("/oxoai/oauth/retour");
  // X accepte une application « publique », sans secret (oauthNatif.ts, `secretFacultatif`).
  // Dropbox aussi : PKCE suffit, le secret est facultatif (natifs/documents.ts).
  const secretFacultatif = id === "x" || id === "dropbox";
  const guide = etat.google ? null : guideApplication(id, { retour: etat.retour });
  const serviceGoogle = SERVICE_GOOGLE[id];

  const panneau = (
    <Card className="space-y-3 max-sm:border-0 max-sm:bg-transparent max-sm:p-0">
      <div>
        <p className="font-medium text-foreground">{tf("{0} : se connecter", etat.nom)}</p>
        <p className="text-sm text-muted-foreground">
          {etat.google
            ? t("Par la connexion Google, avec l'application Google de votre organisation.")
            : id === "x"
              ? /*
                 * Tournée de la 2026.928.3 (SECURITE.md § 43) : X recevait la
                 * phrase commune, « X examine les applications… », que
                 * contredit sa rubrique (« Aucun examen de X »). Ce qui
                 * empêche une application commune chez X, c'est la facture.
                 */
                t("Avec l'application que votre organisation crée chez X, une fois. Le logiciel ne peut pas en fournir une commune : X facture chaque appel à l'application qui le fait, sur ses crédits.")
              : id === "linkedinPage"
                ? t("Avec une seconde application LinkedIn, que votre organisation crée pour sa Page d'entreprise, une fois. LinkedIn n'ouvre les pages qu'à une application qui ne sert qu'à cela, et l'examine avant.")
              : id === "dropbox"
                ? t("Avec l'application que votre organisation crée chez Dropbox, une fois. Le logiciel ne peut pas en fournir une commune : Dropbox limite une application à 500 comptes, et l'examine avant d'en relier plus de 50.")
              : estNatifProjet(id)
                ? pourquoiApplicationProjet(id)
                : tf("Avec l'application que votre organisation crée chez {0}, une fois. Le logiciel ne peut pas en fournir une commune : {0} examine les applications qui servent d'autres comptes que ceux de leur éditeur.", etat.nom)}
        </p>
      </div>
      {etat.aReconnecter && (
        <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
          {tf("{0} n'accepte plus l'accès enregistré (révoqué, expiré, ou application changée). Reconnectez-vous.", etat.nom)}
        </InfoBox>
      )}
      {id === "linkedin" && <VersPageLinkedin ancienne={Boolean(etat.accordes?.includes("page"))} onOuvrir={onOuvrir} />}
      {etat.google ? (
        client?.disponible && serviceGoogle ? (
          /*
           * L'application Google de l'instance existe déjà (28/09/2026, point 6
           * de la demande de Medhi) : on le dit, pour que personne ne crée une
           * application de plus, et l'on donne l'activation de l'API de ce
           * service, au cas où elle ne l'aurait pas été avec les autres.
           */
          <InfoBox leading={<KeyRound size={15} strokeWidth={1.75} />}>
            <div className="space-y-2 [overflow-wrap:anywhere]">
              <p className="font-medium">{t("L'application Google de l'instance sert aussi ici")}</p>
              <p>{tf("Rien à créer : c'est la même application que pour Gmail, Agenda, Drive, Sheets, Slides, Docs, Forms et YouTube. Il faut seulement que « {0} » soit activée dans son projet, ce que fait le bouton d'activation des API quand il a servi.", API_GOOGLE[serviceGoogle].nom)}</p>
              <a
                href={activerApisGoogle([serviceGoogle])}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors [overflow-wrap:break-word] hover:bg-muted"
              >
                <ExternalLink size={14} strokeWidth={1.75} className="shrink-0" />
                <span className="min-w-0">{tf("Ouvrir l'activation de « {0} »", API_GOOGLE[serviceGoogle].nom)}</span>
              </a>
              <p className="text-xs">{t("Si Google répond « API has not been used in project… or it is disabled », c'est cette activation qui manque : faites-la, attendez quelques minutes, puis recommencez.")}</p>
            </div>
          </InfoBox>
        ) : null
      ) : guide ? (
        <GuideApplication
          guide={guide}
          retour={etat.retour}
          noteRetour={boucle ? t("Le port change à chaque connexion : déclarez-la avec l'astérisque.") : t("C'est l'adresse par laquelle ce navigateur atteint l'instance. Si le fournisseur exige https, ouvrez l'instance par une adresse en https.")}
        />
      ) : null}
      <InfoBox tone="muted">
        {/* 375 px : une portée d'un seul tenant (account_info.read) sortait du cadre ; elle se coupe. */}
        <div className="space-y-1 [overflow-wrap:anywhere]">
          <p className="font-medium">{id === "x" ? t("Ce que permet chaque offre de X") : estNatifProjet(id) ? t("Ce que permet ce branchement") : t("Ce qui demande un examen du fournisseur")}</p>
          <Revue id={id} />
        </div>
      </InfoBox>

      {!admin ? (
        <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
          {tf("Seul l'administrateur de l'instance peut brancher {0} : ce service agit au nom de toute l'organisation. Transmettez-lui ces étapes.", etat.nom)}
        </InfoBox>
      ) : etat.google && !client?.disponible ? (
        <FormulaireClientGoogle etat={client} api={serviceGoogle ? API_GOOGLE[serviceGoogle].nom : ""} onEnregistre={() => void relire()} />
      ) : !etat.application.disponible ? (
        <>
          <Field label={tf("Identifiant de l'application {0}", etat.nom)} hint={guide?.champs?.identifiant}>
            <Input value={identifiant} onChange={(e) => setIdentifiant(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            label={id === "dropbox" ? t("« App secret », facultatif") : secretFacultatif ? t("Secret de l'application, pour une « Web App » seulement") : t("Secret de l'application")}
            hint={
              id === "dropbox"
                ? t("Vous pouvez le laisser vide : la connexion à Dropbox est protégée sans lui (PKCE). S'il est donné, il est gardé chiffré sur l'instance et n'en ressort jamais.")
                : secretFacultatif
                  ? t("Laissez vide pour une « Native App » : X la protège sans secret. S'il est donné, il est gardé chiffré sur l'instance et n'en ressort jamais.")
                  : `${guide?.champs?.secret ? `${guide.champs.secret} ` : ""}${t("Gardé chiffré sur l'instance, il n'en ressort jamais.")}`
            }
          >
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <div className="flex justify-end">
            <Button
              size="sm"
              icon={enCours ? Loader2 : Check}
              disabled={enCours || !identifiant.trim() || (!secretFacultatif && !secret.trim())}
              onClick={() =>
                void agir(
                  () => enregistrerApplication(id, identifiant.trim(), secret.trim()),
                  () => {
                    setSecret("");
                    setIdentifiant("");
                  },
                )
              }
            >
              {t("Enregistrer l'application")}
            </Button>
          </div>
        </>
      ) : (
        <>
          {etat.choix.map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" className="mt-1" checked={choix.includes(c.id)} onChange={() => basculer(c.id)} disabled={attente} />
              <span>
                {libelleChoix(id, c.id)}{" "}
                <span className="text-muted-foreground">{c.revue ? t("Demande un examen du fournisseur : sans lui, la connexion sera refusée.") : t("Chaque écriture ou publication vous sera montrée et demandera votre accord.")}</span>
              </span>
            </label>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/*
              * 375 px (vu le 28/09/2026 avec Google Forms) : l'identifiant Google, d'un seul
              * tenant, sortait du panneau, et le libellé du bouton, replié sur deux lignes,
              * était coupé par sa hauteur fixe. L'identifiant se coupe, le bouton grandit.
              */}
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {tf("Application : {0}", etat.application.identifiant ?? "")}
              {!etat.google && (
                <>
                  {" · "}
                  <button type="button" className="underline" disabled={enCours || attente} onClick={() => void agir(() => effacerApplication(id))}>
                    {t("la retirer")}
                  </button>
                </>
              )}
            </p>
            <Button size="sm" className="!h-auto min-h-8 max-w-full py-1.5 text-start" icon={enCours || attente ? Loader2 : Link2} disabled={enCours || attente} onClick={() => void lancer()}>
              {attente ? t("En attente de votre accord…") : tf("Se connecter à {0}", etat.nom)}
            </Button>
          </div>
          {adresse && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {t("La page du service ne s'est pas ouverte ?")} <Lien href={adresse}>{t("L'ouvrir")}</Lien>
              </p>
              {boucle && (
                <>
                  <Field label={t("Instance sur une autre machine : collez ici l'adresse affichée par le navigateur après votre accord")}>
                    <Input value={collage} onChange={(e) => setCollage(e.target.value)} placeholder="http://127.0.0.1:…?state=…&code=…" spellCheck={false} />
                  </Field>
                  {collage.trim() && (
                    <div className="flex justify-end">
                      <Button size="sm" variant="secondary" disabled={enCours} onClick={() => void agir(() => collerAdresseNatif(id, collage.trim()), () => setAdresse(null))}>
                        {t("Terminer la connexion")}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      {messages}
    </Card>
  );
  if (!logo) return panneau;
  return (
    <div className="space-y-3">
      {logo}
      {panneau}
    </div>
  );
}
