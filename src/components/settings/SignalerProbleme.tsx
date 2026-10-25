import { useState } from "react";
import { ExternalLink, Mail } from "lucide-react";
import { Field, Textarea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { InfoBox } from "@/components/ui/InfoBox";
import { Card } from "@/components/settings/SettingsShell";
import { useProfile } from "@/hooks/useProfile";
import { branding } from "@/config/branding";
import {
  adresseMail,
  adresseTicket,
  depotGithub,
  informationsSignalement,
  ouvrirDestination,
  titreSignalement,
  type Signalement,
} from "@/lib/signalement";
import { t, tf } from "@/lib/i18n";

/**
 * Écran « Signaler un problème » (27/09/2026).
 *
 * Un formulaire court, puis deux façons d'envoyer, chacune dite pour ce
 * qu'elle est : un ticket public sur GitHub (compte nécessaire), ou un mail
 * depuis la messagerie du poste. Rien ne part tout seul : l'application ne
 * porte aucun jeton (lib/signalement.ts dit pourquoi), elle prépare, la
 * personne relit ce qui partira, puis envoie elle-même.
 */
export function SignalerProbleme() {
  const { profile } = useProfile();
  const [probleme, setProbleme] = useState("");
  const [faisait, setFaisait] = useState("");
  const [attendait, setAttendait] = useState("");
  const [avecTechnique, setAvecTechnique] = useState(true);
  const [ouvert, setOuvert] = useState<"github" | "mail" | null>(null);

  // Relues à chaque rendu : la date et le modèle montrés sont ceux qui partiront.
  const technique = informationsSignalement(profile.preferredModelUid);
  const signalement: Signalement = { probleme, faisait, attendait, avecTechnique };
  const jointes = avecTechnique ? technique : null;
  const ticket = adresseTicket(signalement, jointes);
  const mail = adresseMail(signalement, jointes);
  const depot = depotGithub();
  const pret = probleme.trim().length > 0;

  const ouvrir = (quoi: "github" | "mail") => {
    const adresse = quoi === "github" ? ticket?.adresse : mail.adresse;
    if (adresse && ouvrirDestination(adresse)) setOuvert(quoi);
  };

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <Field label={t("Ce qui ne va pas")} required>
          <Textarea
            rows={3}
            value={probleme}
            onChange={(e) => setProbleme(e.target.value)}
            placeholder={t("Par exemple : la réponse s'arrête au milieu d'une phrase.")}
          />
        </Field>
        <Field label={t("Ce que vous faisiez")}>
          <Textarea
            rows={3}
            value={faisait}
            onChange={(e) => setFaisait(e.target.value)}
            placeholder={t("L'écran où vous étiez, ce que vous avez cliqué ou écrit.")}
          />
        </Field>
        <Field label={t("Ce que vous attendiez")}>
          <Textarea rows={2} value={attendait} onChange={(e) => setAttendait(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={avecTechnique}
            onChange={() => setAvecTechnique((v) => !v)}
          />
          <span>
            {t("Joindre les informations techniques")}
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("Version, système, cadre d'exécution et modèle choisi. Ni vos messages, ni vos documents, ni aucune clé, ni l'adresse d'une instance d'entreprise.")}
            </span>
          </span>
        </label>
      </Card>

      <Card className="space-y-3">
        <p className="text-sm font-medium text-foreground">{t("Ce qui sera envoyé")}</p>
        <p className="text-xs text-muted-foreground">
          {t("Exactement ce texte, rien d'autre : dans le mail tel quel, et sur GitHub rangé dans les champs du ticket. Vous pourrez encore le relire et le modifier avant d'envoyer.")}
        </p>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/60 p-3 text-xs leading-relaxed text-foreground">
          {pret ? `${titreSignalement(signalement)}\n\n${mail.corps}` : t("Décrivez d'abord ce qui ne va pas.")}
        </pre>
        {(ticket?.tronque || mail.tronque) && (
          <InfoBox tone="warning">
            {t("Le texte est trop long pour tenir dans une adresse : il a été coupé là où c'est marqué. Complétez-le une fois le ticket ou le mail ouvert.")}
          </InfoBox>
        )}
      </Card>

      {depot && ticket && (
        <Card className="space-y-3">
          <p className="text-sm font-medium text-foreground">{t("Ouvrir un ticket sur GitHub")}</p>
          <p className="text-sm text-muted-foreground">
            {tf("Le ticket s'ouvre prérempli dans votre navigateur, sur le dépôt {0}. Il faut un compte GitHub pour l'envoyer, et le ticket sera public : n'y mettez rien de privé.", depot)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={ExternalLink} disabled={!pret} onClick={() => ouvrir("github")}>
              {t("Ouvrir sur GitHub")}
            </Button>
            {ouvert === "github" && (
              <span className="text-xs text-muted-foreground">
                {t("Ouvert dans le navigateur. Rien n'est envoyé tant que vous n'avez pas validé le ticket sur GitHub.")}
              </span>
            )}
          </div>
        </Card>
      )}

      {branding.urls.supportEmail && (
      <Card className="space-y-3">
        <p className="text-sm font-medium text-foreground">{t("Envoyer par mail")}</p>
        <p className="text-sm text-muted-foreground">
          {tf("Un mail prérempli s'ouvre dans votre messagerie, adressé à {0}. Il part de votre propre adresse.", branding.urls.supportEmail)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={Mail} disabled={!pret} onClick={() => ouvrir("mail")}>
            {t("Envoyer par mail")}
          </Button>
          {ouvert === "mail" && (
            <span className="text-xs text-muted-foreground">
              {t("Si aucune messagerie ne s'ouvre, ce poste n'en a pas de réglée : copiez le texte ci-dessus dans un mail.")}
            </span>
          )}
        </div>
      </Card>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("Rien ne part en arrière-plan : l'application ne détient aucun accès à GitHub ni à une messagerie. C'est vous qui envoyez, après avoir relu.")}
      </p>
    </div>
  );
}

export default SignalerProbleme;
