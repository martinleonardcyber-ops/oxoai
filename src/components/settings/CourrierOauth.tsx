import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Info, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { GuideApplication } from "@/components/settings/GuideApplication";
import { FormulaireClientGoogle } from "@/components/settings/ClientGoogle";
import { branding } from "@/config/branding";
import { collerRetourCourrier, connecterAvec, etat as lireEtatCourrier, type EtatCourrier } from "@/lib/courrier";
import { etatClientGoogle, type EtatClientGoogle } from "@/lib/google";
import { guideCourrierMicrosoft, guideGoogle } from "@/lib/guidesApplications";
import { instance } from "@/lib/instance";
import { t, tf } from "@/lib/i18n";

/**
 * Brancher une boîte Google ou Microsoft en cliquant.
 *
 * ── Ce que cet écran doit dire honnêtement ──────────────────────────────────
 *
 * Que ce chemin demande une application déclarée chez le fournisseur, une
 * seule fois. Google et Microsoft ne distribuent pas d'identifiant
 * d'application automatiquement : il faut qu'une organisation déclare la
 * sienne chez elle.
 *
 * ── Ce qui a changé le 28/09/2026 ───────────────────────────────────────────
 *
 * Medhi : « quand je veux connecter Gmail, il n'y a pas la redirection vers où
 * je dois aller pour créer l'appli ». L'écran demandait un identifiant
 * d'application sans dire où le créer, ni comment. Désormais :
 *
 *  - Gmail reprend l'application Google de l'instance, celle de Drive et
 *    d'Agenda, de type « Application de bureau » : rien à déclarer, pas
 *    d'adresse de retour (courrierOauth.ts, `ouvrirBoucle`). Si elle n'existe
 *    pas encore, le formulaire de Drive et d'Agenda s'affiche ici, avec ses
 *    boutons vers chaque page de la console Google Cloud ;
 *  - Outlook reprend l'application Microsoft 365 de l'instance si elle existe
 *    (il suffit de lui ajouter une adresse de retour et deux permissions),
 *    sinon l'écran dit comment en créer une, bouton vers Entra compris.
 *
 * Pour un compte personnel Outlook, l'écran renvoie au mot de passe
 * d'application.
 */
export function CourrierOauth({
  adresse,
  fournisseur,
  onBranche,
}: {
  adresse: string;
  fournisseur: "google" | "microsoft";
  /** La boîte a été branchée au retour : l'écran parent relit son état. */
  onBranche: () => void;
}) {
  const [etat, setEtat] = useState<EtatCourrier | null | undefined>(undefined);
  const [client, setClient] = useState<EtatClientGoogle | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenant, setTenant] = useState("");
  const [reprendre, setReprendre] = useState(true);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [attente, setAttente] = useState(false);
  const [lien, setLien] = useState<string | null>(null);
  const [collage, setCollage] = useState("");

  const nom = fournisseur === "google" ? "Google" : "Microsoft";

  const relire = useCallback(async () => {
    const [e, c] = await Promise.all([lireEtatCourrier(), fournisseur === "google" ? etatClientGoogle() : Promise.resolve(null)]);
    setEtat(e);
    setClient(c);
    return e;
  }, [fournisseur]);

  useEffect(() => {
    void relire();
  }, [relire]);

  /*
   * L'accord se donne chez le fournisseur ; seule l'instance sait quand il est
   * revenu. On relit son état : la boîte branchée, ou l'issue d'un retour
   * manqué (Gmail, par la boucle locale), dite ici plutôt que seulement dans
   * l'onglet du navigateur.
   */
  useEffect(() => {
    if (!attente) return;
    const debut = Date.now();
    const minuterie = setInterval(() => {
      void lireEtatCourrier().then((e) => {
        if (!e) return;
        if (e.configure) {
          setAttente(false);
          onBranche();
          return;
        }
        const issue = e.oauth?.issue;
        if (issue && !issue.ok && Date.parse(issue.quand) >= debut - 1000) {
          setAttente(false);
          setErreur(issue.message);
        }
      });
    }, 2000);
    return () => clearInterval(minuterie);
  }, [attente, onBranche]);

  const oauth = etat?.oauth;
  const google = fournisseur === "google";
  const applicationGoogle = google && Boolean(oauth?.google.disponible ?? client?.disponible);
  const applicationMicrosoft = !google && Boolean(oauth?.microsoft.disponible);
  const parInstance = google || (applicationMicrosoft && reprendre);
  const retourMicrosoft = oauth?.microsoft.retour ?? `${instanceVue()}/oxoai/oauth/retour`;

  const lancer = async () => {
    setOccupe(true);
    setErreur(null);
    const r = await connecterAvec(
      adresse,
      parInstance
        ? { fournisseur, application: "instance" }
        : {
            fournisseur,
            clientId,
            ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            ...(tenant.trim() ? { tenant: tenant.trim() } : {}),
          },
    );
    setOccupe(false);
    if (!r.ok) {
      setErreur(r.message);
      return;
    }
    /*
     * La fenêtre s'ouvre à part : la personne s'authentifie chez son
     * fournisseur, pas dans cet écran, et revient ici quand c'est fait.
     */
    setLien(r.url);
    window.open(r.url, "_blank", "noopener,noreferrer");
    setAttente(true);
  };

  const coller = async () => {
    setOccupe(true);
    setErreur(null);
    const r = await collerRetourCourrier(collage.trim());
    setOccupe(false);
    if (!r.ok) {
      setErreur(r.message);
      return;
    }
    setAttente(false);
    setCollage("");
    onBranche();
  };

  if (etat === undefined) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={15} strokeWidth={1.75} className="animate-spin" />
        {t("Lecture de l'état du service…")}
      </p>
    );
  }

  const erreurs = google ? guideGoogle().erreurs : undefined;

  return (
    <div className="space-y-4">
      {google ? (
        applicationGoogle ? (
          <InfoBox leading={<KeyRound size={15} strokeWidth={1.75} />}>
            <div className="space-y-1.5 [overflow-wrap:anywhere]">
              <p className="font-medium">{t("L'application Google de l'instance sert aussi pour Gmail")}</p>
              <p>{tf("Rien d'autre à préparer, ni adresse de retour à déclarer : Gmail reprend l'application déjà enregistrée ({0}), celle de Google Agenda, Drive, Sheets, Slides, Docs, Forms et YouTube.", oauth?.google.identifiant ?? client?.identifiant ?? "")}</p>
              <p className="text-xs">{t("Compte Google Workspace : l'administrateur doit laisser IMAP activé (console d'administration, « Apps », « Google Workspace », « Gmail », « End User Access »). S'il réserve l'accès aux clients OAuth, il y ajoute cette application par son ID client.")}</p>
            </div>
          </InfoBox>
        ) : (
          <>
            <InfoBox leading={<Info size={15} strokeWidth={1.75} />}>
              {tf("Gmail se branche avec l'application Google de votre organisation, la même que pour Google Agenda, Drive, Sheets, Slides, Docs, Forms et YouTube. Elle n'existe pas encore sur cette instance {0} : créez-la une fois, avec les boutons ci-dessous, puis revenez vous connecter.", branding.name)}
            </InfoBox>
            <FormulaireClientGoogle etat={client} api="Gmail API" onEnregistre={() => void relire()} />
          </>
        )
      ) : (
        <>
          {applicationMicrosoft && (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" className="mt-1" checked={reprendre} onChange={(e) => setReprendre(e.target.checked)} disabled={attente} />
              <span>
                {tf("Reprendre l'application Microsoft 365 de l'instance ({0})", oauth?.microsoft.identifiant ?? "")}{" "}
                <span className="text-muted-foreground">{t("Pas de seconde application : on lui ajoute une adresse de retour et deux permissions.")}</span>
              </span>
            </label>
          )}
          <GuideApplication
            guide={guideCourrierMicrosoft(retourMicrosoft, applicationMicrosoft && reprendre)}
            retour={retourMicrosoft}
            noteRetour={t("Microsoft ignore le port de « localhost » : l'adresse se déclare telle quelle, sans port.")}
            titre={applicationMicrosoft && reprendre ? t("Compléter l'application Microsoft 365, une fois") : t("Préparer l'application, une fois pour toute l'instance")}
          />
        </>
      )}

      {!google && !parInstance && (
        <>
          <Field label={t("Identifiant d'application (« client ID »)")} hint={guideCourrierMicrosoft(retourMicrosoft, false).champs?.identifiant}>
            <Input value={clientId} placeholder="00000000-0000-0000-0000-000000000000" onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t("Domaine ou identifiant de votre organisation")} hint={guideCourrierMicrosoft(retourMicrosoft, false).champs?.annuaire}>
            <Input value={tenant} placeholder="00000000-0000-0000-0000-000000000000" onChange={(e) => setTenant(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t("Secret d'application, si votre administrateur en a créé un")} hint={guideCourrierMicrosoft(retourMicrosoft, false).champs?.secret}>
            <Input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </Field>
        </>
      )}

      {erreur && (
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}

      {(!google || applicationGoogle) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="!h-auto min-h-10 max-w-full py-2 text-start"
            icon={occupe || attente ? Loader2 : ExternalLink}
            disabled={occupe || attente || !adresse.includes("@") || (!parInstance && !clientId.trim())}
            onClick={() => void lancer()}
          >
            {occupe ? t("Préparation...") : attente ? t("En attente de votre accord…") : tf("Se connecter avec {0}", nom)}
          </Button>
          {attente && (
            <Button variant="ghost" onClick={() => void relire().then(() => onBranche())}>
              {t("J'ai terminé dans l'autre fenêtre")}
            </Button>
          )}
        </div>
      )}

      {attente && (
        <div className="space-y-2">
          <InfoBox tone="muted">
            {tf("Une fenêtre s'est ouverte chez {0}. Vous y saisissez votre mot de passe, chez eux : {1} ne le voit pas, et ne le conserve pas. Revenez ici quand la page vous dit que la boîte est branchée.", nom, branding.name)}
          </InfoBox>
          {lien && (
            <p className="text-sm text-muted-foreground">
              {t("La page du service ne s'est pas ouverte ?")}{" "}
              <a className="underline" href={lien} target="_blank" rel="noreferrer noopener">
                {t("L'ouvrir")} <ExternalLink size={11} className="inline" />
              </a>
            </p>
          )}
          {google && (
            <>
              <Field label={t("Instance sur une autre machine : collez ici l'adresse affichée par le navigateur après votre accord")}>
                <Input value={collage} onChange={(e) => setCollage(e.target.value)} placeholder="http://127.0.0.1:…/?state=…&code=…" spellCheck={false} />
              </Field>
              {collage.trim() && (
                <div className="flex justify-end">
                  <Button size="sm" variant="secondary" icon={occupe ? Loader2 : Check} disabled={occupe} onClick={() => void coller()}>
                    {t("Terminer la connexion")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {erreurs && applicationGoogle && (
        <details className="rounded-lg border border-border p-2.5 text-sm text-foreground">
          <summary className="cursor-pointer font-medium">{tf("Si {0} affiche une erreur", "Google")}</summary>
          <dl className="mt-2 space-y-2">
            {erreurs.map((x) => (
              <div key={x.code}>
                <dt className="font-mono text-xs">{x.code}</dt>
                <dd className="text-muted-foreground">{x.texte}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

/**
 * Adresse par laquelle ce poste atteint l'instance, pour une instance trop
 * ancienne pour donner elle-même l'adresse de retour à déclarer (`oauth.microsoft.retour`).
 *
 * Lue par `instance()`, comme toutes les requêtes de l'écran. Tournée des
 * connecteurs du 28/09/2026 : elle était lue dans le stockage local, où
 * l'adresse ne se trouve plus depuis qu'elle vit dans le coffre du poste
 * (lib/coffre.ts) ; l'écran retombait alors sur l'origine de la page, et
 * l'application de bureau demandait de déclarer « oxoai://app/oxoai/oauth/retour »
 * chez Google ou Microsoft, qui refusaient ensuite la connexion.
 */
function instanceVue(): string {
  try {
    return instance().url.replace(/\/+$/, "");
  } catch {
    return window.location.origin;
  }
}

export default CourrierOauth;
