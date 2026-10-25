import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ExternalLink,
  FolderOpen,
  Info,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  etat as lireEtat,
  connecter,
  collerAdresse,
  oublier,
  type EtatDrive,
} from "@/lib/drive";
import { Card } from "@/components/settings/SettingsShell";
import { FormulaireClientGoogle } from "@/components/settings/ClientGoogle";
import { etatClientGoogle, type EtatClientGoogle } from "@/lib/google";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { branding } from "@/config/branding";
import { formaterDate } from "@/lib/formats";
import { t, tf } from "@/lib/i18n";

/**
 * Connecteur Google Drive.
 *
 * Trois écrans en un, selon ce que l'instance sait faire.
 *
 * **Le client OAuth manque.** C'est le cas d'une instance neuve : aucun
 * identifiant Google n'est livré avec le produit, chaque entreprise crée le
 * sien. L'écran dit alors, étape par étape, quoi faire dans la console Google
 * Cloud, et à qui transmettre le résultat. Il ne propose aucun bouton qui ne
 * pourrait qu'échouer.
 *
 * **Prêt à brancher.** Un bouton ouvre la page de Google dans le navigateur.
 * L'écran attend ensuite la réponse, en interrogeant l'instance, et n'affiche
 * « connecté » que lorsque l'instance l'est vraiment. Quand l'instance tourne
 * sur une autre machine, la redirection de Google n'y parvient pas : l'écran
 * propose de recopier l'adresse de la page d'erreur, ce qui suffit.
 *
 * **Branché.** Le compte, la date, ce que les agents peuvent faire et ce
 * qu'ils ne peuvent pas faire, et le moyen de débrancher.
 */

/** Adresse de consentement ouverte dans le navigateur de la personne. */
function ouvrir(url: string) {
  // Dans l'application de bureau, la fenêtre native confie ce lien au navigateur.
  window.open(url, "_blank", "noopener,noreferrer");
}

export function DriveGoogle({ onChange }: { onChange?: () => void } = {}) {
  const [etat, setEtat] = useState<EtatDrive | null | undefined>(undefined);
  const [enCours, setEnCours] = useState(false);
  const [retrait, setRetrait] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  /** Adresse d'autorisation de la demande en cours, pour la rouvrir. */
  const [adresseGoogle, setAdresseGoogle] = useState<string | null>(null);
  const [collage, setCollage] = useState("");

  const [clientGoogle, setClientGoogle] = useState<EtatClientGoogle | null>(null);
  const relire = useCallback(async () => {
    const [e, c] = await Promise.all([lireEtat(), etatClientGoogle()]);
    setEtat(e);
    setClientGoogle(c);
    return e;
  }, []);

  useEffect(() => {
    void relire();
  }, [relire]);

  /*
   * Attente de la réponse de Google. L'accord se donne dans le navigateur, hors
   * de cette fenêtre : seule l'instance sait quand il est arrivé. On l'interroge
   * toutes les deux secondes, et on s'arrête dès qu'elle n'attend plus. Le
   * message affiché est celui que l'instance rend à ce moment-là, jamais une
   * issue supposée.
   */
  const attente = Boolean(etat?.attente);
  useEffect(() => {
    if (!attente) return;
    const minuterie = setInterval(() => {
      void relire().then((e) => {
        if (!e || e.attente) return;
        setAdresseGoogle(null);
        setCollage("");
        if (e.issue?.ok) {
          setSucces(e.issue.message);
          onChange?.();
        } else if (e.issue) {
          setErreur(e.issue.message);
        }
      });
    }, 2000);
    return () => clearInterval(minuterie);
  }, [attente, relire, onChange]);

  const lancer = async () => {
    setEnCours(true);
    setErreur(null);
    setSucces(null);
    const r = await connecter();
    setEnCours(false);
    if (!r.ok || !r.url) {
      setErreur(r.message);
      return;
    }
    setAdresseGoogle(r.url);
    ouvrir(r.url);
    await relire();
  };

  const validerCollage = async () => {
    setEnCours(true);
    setErreur(null);
    const r = await collerAdresse(collage.trim());
    setEnCours(false);
    if (!r.ok) {
      setErreur(r.message);
      return;
    }
    setAdresseGoogle(null);
    setCollage("");
    setSucces(r.message);
    await relire();
    onChange?.();
  };

  const debrancher = async () => {
    setRetrait(true);
    setErreur(null);
    setSucces(null);
    const r = await oublier();
    setRetrait(false);
    setAdresseGoogle(null);
    if (!r.ok) setErreur(r.message);
    else setSucces(r.message);
    await relire();
    onChange?.();
  };

  if (etat === undefined) {
    return (
      <Card className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
        {t("Lecture de l'état du connecteur…")}
      </Card>
    );
  }
  if (etat === null) {
    return (
      <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
        {tf("L'instance {0} ne répond pas. Google Drive se branche depuis cet écran dès qu'elle est joignable.", branding.name)}
      </InfoBox>
    );
  }

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

  /* --------------------------- client OAuth absent --------------------------- */
  // Un accès enregistré reste débranchable même si le client a disparu du profil.
  if (!etat.disponible && !etat.aReconnecter) {
    return (
      <div className="space-y-3">
        {etat.manque === "identifiant-invalide" && (
          <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
            {t("L'identifiant Google renseigné sur l'instance n'a pas la bonne forme : il doit se terminer par « .apps.googleusercontent.com ». Vérifiez le copier-coller.")}
          </InfoBox>
        )}
        {/*
          * L'application Google se saisit à l'écran depuis le 26/09/2026
          * (ClientGoogle.tsx), partagée avec Google Agenda ; le profil de
          * déploiement (« google » dans oxoai.config.json) reste possible et
          * l'emporte.
          */}
        <FormulaireClientGoogle etat={clientGoogle} api="Google Drive API" onEnregistre={() => void relire()} />
      </div>
    );
  }

  /* --------------------------------- branché --------------------------------- */
  if (etat.configure && !attente) {
    const depuis = etat.depuis ? new Date(etat.depuis) : null;
    return (
      <div className="space-y-3">
        <Card className="flex items-start gap-3">
          <FolderOpen size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{etat.compte}</p>
            <p className="truncate text-sm text-muted-foreground">
              {etat.nom ? `${etat.nom}, ` : ""}
              {depuis && !Number.isNaN(depuis.getTime())
                ? tf("connecté le {0}", formaterDate(depuis))
                : t("connecté")}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            {t("Connecté")}
          </span>
        </Card>

        <InfoBox leading={<Lock size={15} strokeWidth={1.75} />}>
          {t("Lecture seule. Vos agents peuvent chercher et lire les fichiers auxquels ce compte Google a accès ; ils ne peuvent ni créer, ni modifier, ni partager, ni supprimer quoi que ce soit. Les documents, feuilles de calcul et présentations Google se lisent, ainsi que les fichiers texte ; les PDF et les fichiers Word ou Excel déposés tels quels sont seulement listés.")}
        </InfoBox>
        <InfoBox tone="muted" leading={<Info size={15} strokeWidth={1.75} />}>
          {tf("Ce Drive est branché pour toute l'instance : chaque compte {0} peut en faire lire les fichiers à ses agents. L'accès est conservé chiffré sur l'instance et n'est transmis qu'à Google.", branding.name)}
        </InfoBox>

        {messages}

        <div className="flex justify-end">
          <Button
            variant="destructive"
            size="sm"
            icon={retrait ? Loader2 : Trash2}
            disabled={retrait}
            onClick={() => void debrancher()}
          >
            {retrait ? t("Débranchement…") : t("Débrancher Google Drive")}
          </Button>
        </div>
      </div>
    );
  }

  /* ------------------------ à brancher, ou à reconnecter ---------------------- */
  return (
    <div className="space-y-3">
      {!etat.chiffrementDonnees && (
        <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
          {tf("Le chiffrement des données n'est pas actif sur cette instance. {0} refusera d'enregistrer l'accès au Drive tant que ce sera le cas.", branding.name)}
        </InfoBox>
      )}
      {etat.aReconnecter && !attente && (
        <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
          {t("Google n'accepte plus l'accès enregistré pour")}{" "}{etat.compte}{" "}{t(": il a été révoqué, il a expiré, ou le client Google de l'instance a changé. Vos agents n'ont plus accès au Drive. Reconnectez-le, ou débranchez-le.")}
        </InfoBox>
      )}

      <Card className="space-y-4">
        {!attente ? (
          <>
            <p className="text-sm text-foreground">
              {tf("Vous allez vous connecter à Google dans votre navigateur, puis accepter que {0} lise votre Drive. Seule la lecture est demandée.", branding.name)}
            </p>
            {messages}
            <div className="flex flex-wrap justify-end gap-2">
              {etat.aReconnecter && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={retrait ? Loader2 : Trash2}
                  disabled={retrait}
                  onClick={() => void debrancher()}
                >
                  {t("Débrancher")}
                </Button>
              )}
              <Button
                icon={enCours ? Loader2 : etat.aReconnecter ? RefreshCw : FolderOpen}
                disabled={enCours || !etat.disponible || !etat.chiffrementDonnees}
                onClick={() => void lancer()}
              >
                {enCours
                  ? t("Préparation…")
                  : etat.aReconnecter
                    ? t("Reconnecter Google Drive")
                    : t("Se connecter avec Google")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 text-sm text-foreground">
              <Loader2 size={16} strokeWidth={1.75} className="shrink-0 animate-spin" />
              {t("En attente de votre accord dans la fenêtre Google. Cette demande expire dans dix minutes.")}
            </div>
            {adresseGoogle && (
              <a
                href={adresseGoogle}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink size={14} strokeWidth={1.75} />
                {t("Rouvrir la page Google")}
              </a>
            )}
            <Field
              label={t("La page affiche une erreur après votre accord ?")}
              hint={t("C'est normal quand l'instance est installée sur une autre machine que ce poste : Google renvoie vers une adresse commençant par http://127.0.0.1, que seule l'instance comprend. Copiez l'adresse complète de cette page, depuis la barre du navigateur, et collez-la ici.")}
            >
              <Input
                placeholder="http://127.0.0.1:…/?state=…&code=…"
                value={collage}
                autoComplete="off"
                onChange={(e) => setCollage(e.target.value)}
              />
            </Field>
            {messages}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                disabled={enCours}
                onClick={() => void lancer()}
              >
                {t("Recommencer")}
              </Button>
              <Button
                size="sm"
                icon={enCours ? Loader2 : Link2}
                disabled={enCours || !collage.trim()}
                onClick={() => void validerCollage()}
              >
                {t("Valider cette adresse")}
              </Button>
            </div>
          </>
        )}
      </Card>

      <InfoBox tone="muted" leading={<Lock size={15} strokeWidth={1.75} />}>
        {tf("{0} parle directement à Google, sans intermédiaire, avec l'autorisation que votre entreprise a créée. Le certificat de Google est vérifié à chaque échange. Au débranchement, l'accès est aussi révoqué chez Google.", branding.name)}
      </InfoBox>
    </div>
  );
}

export default DriveGoogle;
