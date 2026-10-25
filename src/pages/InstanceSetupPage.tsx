import { useCallback, useEffect, useRef, useState } from "react";
import {
  Laptop,
  Server,
  ArrowLeft,
  Check,
  Link2,
  TriangleAlert,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { LogoMark } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { branding } from "@/config/branding";
import { setInstance, normaliseUrl, probeInstance } from "@/lib/instance";
import { secretsEcrits } from "@/lib/coffre";
import {
  estCodeInvitation,
  lireLienInvitation,
  rejoindreAvecCode,
  retenirInvitation,
  type InvitationRecue,
} from "@/lib/invitations";
import { t, tf } from "@/lib/i18n";

/**
 * Premier lancement : à quoi ce poste est-il rattaché ?
 *
 * C'est ici que se joue l'usage « comme un ERP » : un collègue invité sur un
 * projet installe le logiciel sur son PC, indique l'adresse de l'instance de
 * l'entreprise, et travaille sans rien installer d'autre — ni modèle, ni
 * cluster. L'inférence et les données viennent de l'instance.
 */
export function InstanceSetupPage({
  onReady,
  invitation,
  onAnnuler,
}: {
  onReady: () => void;
  /** Invitation reçue par lien : les deux champs arrivent remplis. */
  invitation?: InvitationRecue | null;
  /** Présent seulement quand ce poste est déjà rattaché : de quoi renoncer. */
  onAnnuler?: () => void;
}) {
  const [mode, setMode] = useState<"choix" | "rejoindre">(invitation ? "rejoindre" : "choix");
  const [url, setUrl] = useState(invitation?.adresse ?? "");
  const [token, setToken] = useState(invitation?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // `onReady` recharge la page : le coffre doit avoir enregistré avant, sans
  // quoi l'application repartirait sans savoir à quoi elle est rattachée.
  const standalone = async () => {
    setInstance({ url: "http://localhost:8787", remote: false });
    await secretsEcrits();
    onReady();
  };

  /**
   * Rattache ce poste.
   *
   * Deux entrées pour un seul champ, et la forme suffit à les distinguer : un
   * **code d'invitation** (quatre groupes de quatre) ou un **jeton
   * d'instance**. Le code est la voie normale depuis la 0.23.0 : l'instance
   * remet elle-même le jeton, que le collègue n'a donc jamais à recopier.
   */
  const rejoindre = useCallback(async (adresseSaisie: string, codeSaisi: string) => {
    const address = normaliseUrl(adresseSaisie);
    const saisi = codeSaisi.trim();
    if (!address || !saisi) return;
    setBusy(true);
    setError(undefined);

    let jeton = saisi;
    if (estCodeInvitation(saisi)) {
      const accueil = await rejoindreAvecCode(address, saisi);
      if (!accueil.ok) {
        setBusy(false);
        setError(accueil.message);
        return;
      }
      jeton = accueil.jeton;
      // L'écran de connexion enchaînera sur la création du compte.
      retenirInvitation(saisi, accueil.email);
    }

    const result = await probeInstance(address, jeton);
    setBusy(false);

    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setInstance({
      url: address,
      remote: true,
      token: jeton,
      label: address.replace(/^https?:\/\//, ""),
    });
    await secretsEcrits();
    onReady();
  }, [onReady]);

  const join = () => void rejoindre(url, token);

  /*
   * Lien cliqué : les deux champs arrivent remplis. On s'arrête là.
   *
   * Le rattachement ne part **pas** tout seul, et c'est délibéré. Le système
   * ouvre un lien `oxoai://` d'où qu'il vienne : du mail attendu, mais aussi
   * d'une page web visitée par hasard. Rien ne distingue les deux à
   * l'arrivée. Un rattachement automatique laisserait donc n'importe quel
   * site pointer ce poste vers l'instance de son choix, où la personne
   * saisirait ensuite son mot de passe en croyant être chez elle.
   *
   * L'écran affiche donc l'adresse, en toutes lettres, et attend un clic.
   * C'est une marche, mais c'est la seule, et elle remplace deux recopies.
   *
   * La garde empêche d'écraser une saisie en cours si la page se rend à
   * nouveau avec la même invitation.
   */
  const lienJoue = useRef<string | null>(null);
  useEffect(() => {
    if (!invitation) return;
    const empreinte = `${invitation.adresse}|${invitation.code}`;
    if (lienJoue.current === empreinte) return;
    lienJoue.current = empreinte;
    setMode("rejoindre");
    setUrl(invitation.adresse);
    setToken(invitation.code);
    setError(undefined);
  }, [invitation]);

  /**
   * Un lien collé remplit les deux champs.
   *
   * Coller le lien entier dans le champ de l'adresse est le geste naturel
   * quand la messagerie ne l'a pas rendu cliquable. Le refuser au motif qu'il
   * ne ressemble pas à une adresse serait une punition pour avoir bien fait.
   */
  const coller = (texte: string): boolean => {
    const lu = lireLienInvitation(texte);
    if (!lu?.adresse && !lu?.code) return false;
    if (lu.adresse) setUrl(lu.adresse);
    if (lu.code) setToken(lu.code);
    setError(undefined);
    return true;
  };

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark size={52} animated />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {tf("Bienvenue dans {0}", branding.name)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {mode === "choix"
              ? t("Comment souhaitez-vous utiliser ce poste ?")
              : invitation
                ? t("Vérifiez l'adresse, puis rejoignez.")
                : t("Indiquez l'adresse de l'instance de votre entreprise.")}
          </p>
        </div>

        {mode === "choix" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={standalone}
              className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-4 text-start transition-colors hover:bg-muted"
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Laptop size={18} strokeWidth={1.75} className="text-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{t("Poste autonome")}</span>
                <span className="block text-sm text-muted-foreground">
                  {t("Tout fonctionne sur cette machine. Un modèle adapté sera installé automatiquement.")}
                </span>
              </span>
              <ArrowRight size={16} strokeWidth={1.75} className="mt-1 shrink-0 text-muted-foreground" />
            </button>

            <button
              type="button"
              onClick={() => setMode("rejoindre")}
              className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-4 text-start transition-colors hover:bg-muted"
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Server size={18} strokeWidth={1.75} className="text-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">
                  {t("Rejoindre l'instance de mon entreprise")}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t("Vos projets et conversations viennent de l'instance.")}{" "}
                  <strong className="font-medium text-foreground">
                    {t("Aucun modèle à installer")}
                  </strong>{" "}
                  {t("sur cette machine.")}
                </span>
              </span>
              <ArrowRight size={16} strokeWidth={1.75} className="mt-1 shrink-0 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {invitation && (
              <InfoBox leading={<Link2 size={15} strokeWidth={1.75} />}>
                {t("Invitation ouverte depuis un lien. Elle rattachera ce poste à")}{" "}
                <strong className="font-medium text-foreground">{invitation.adresse}</strong>{t(". Si cette adresse ne vous dit rien, n'allez pas plus loin : un lien peut venir d'ailleurs que du mail que vous attendiez.")}
              </InfoBox>
            )}
            {onAnnuler && (
              <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
                {t("Ce poste est déjà en service. Le rattacher à cette instance fera venir d'elle vos projets et vos chats. Vos données actuelles restent sur cette machine : vous les retrouverez en revenant au poste autonome dans Réglages.")}
              </InfoBox>
            )}
            <Field
              label={t("Adresse de l'instance")}
              hint={t("Collez ici le lien reçu par mail, il remplira les deux champs. Ou saisissez l'adresse : oxoai.mon-entreprise.fr")}
            >
              <Input
                placeholder={t("oxoai.mon-entreprise.fr")}
                value={url}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
                onPaste={(e) => {
                  if (coller(e.clipboardData.getData("text"))) e.preventDefault();
                }}
              />
            </Field>

            <Field
              label={t("Code d'invitation, ou jeton d'instance")}
              hint={
                estCodeInvitation(token)
                  ? t("Code d'invitation reconnu. Vous choisirez votre mot de passe juste après.")
                  : t("Le code vous a été envoyé par mail (quatre groupes de quatre). À défaut, votre administrateur vous a donné le jeton de l'instance.")
              }
            >
              <Input
                /*
                 * En clair, et non en champ masqué : un code d'invitation se
                 * recopie depuis un mail, souvent à la main. Le masquer ferait
                 * échouer une saisie sur deux sans rien protéger — il vaut sept
                 * jours, un seul usage, et une seule adresse.
                 */
                placeholder={t("ABCD-EFGH-IJKL-MNOP")}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onPaste={(e) => {
                  if (coller(e.clipboardData.getData("text"))) e.preventDefault();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url.trim() && token.trim()) join();
                }}
              />
            </Field>

            <Button
              icon={busy ? Loader2 : Check}
              block
              disabled={busy || !url.trim() || !token.trim()}
              onClick={join}
            >
              {busy ? t("Vérification...") : t("Rejoindre")}
            </Button>

            {error && (
              <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
                {error}
              </InfoBox>
            )}

            <button
              type="button"
              onClick={() => {
                if (onAnnuler) return onAnnuler();
                setMode("choix");
                setError(undefined);
              }}
              className="flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft size={14} strokeWidth={1.75} />{" "}
              {onAnnuler ? t("Rester sur ce poste") : t("Retour")}
            </button>
          </div>
        )}

        <p className="mt-8 text-center text-xs leading-relaxed text-muted-foreground">
          {t("Ce choix est modifiable plus tard dans Réglages. Dans les deux cas, vos documents et vos conversations ne sortent jamais de chez vous : rien n'est envoyé à un service d'intelligence artificielle, tout est calculé sur vos machines. Seule l'installation télécharge le moteur et le modèle auprès de leurs éditeurs.")}
        </p>
      </div>
    </div>
  );
}

export default InstanceSetupPage;
