import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw, TriangleAlert, UserPlus } from "lucide-react";
import { Card } from "@/components/settings/SettingsShell";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { ACopier } from "@/components/ui/ACopier";
import { createAccount } from "@/lib/store/accounts";
import { suisAdministrateur } from "@/lib/invitations";
import { t, tf } from "@/lib/i18n";

/**
 * Créer le compte d'un collègue qui travaille sur ce même ordinateur.
 *
 * Le trou, vu le 28/09/2026 (tournée des écrans) : sur un poste partagé (un
 * accueil où deux personnes se relaient), l'instance n'est pas ouverte au
 * réseau, donc les invitations sont refusées, et aucun écran ne permettait
 * d'ouvrir un second compte. La seconde personne n'avait pas d'autre choix
 * que le compte de la première, et ses Chats. Décision de Medhi : on l'ajoute.
 *
 * La passerelle savait déjà le faire (`/oxoai/auth/create`, administrateur
 * seul) : le mot de passe choisi ici est provisoire, et la personne en choisit
 * un à elle à sa première connexion (LoginPage, étape « provisoire »). Personne
 * d'autre ne connaîtra donc le sien.
 *
 * Réservé à l'administrateur : la carte ne s'affiche pas pour un membre.
 */

/** Un mot de passe provisoire de seize caractères, sans caractères qui se confondent à l'oral (0/O, 1/l/I). */
function provisoireAuHasard(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const tirage = new Uint32Array(16);
  crypto.getRandomValues(tirage);
  const brut = Array.from(tirage, (n) => alphabet[n % alphabet.length]).join("");
  return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}-${brut.slice(12)}`;
}

export function CreerCompte() {
  const [admin, setAdmin] = useState(false);
  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const [provisoire, setProvisoire] = useState(provisoireAuHasard);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [cree, setCree] = useState<{ nom: string; email: string; provisoire: string } | null>(null);

  useEffect(() => {
    void suisAdministrateur().then(setAdmin);
  }, []);

  if (!admin) return null;

  const pret = nom.trim() !== "" && email.trim() !== "" && provisoire.length >= 10 && !occupe;

  const creer = async () => {
    setOccupe(true);
    setErreur(null);
    setCree(null);
    try {
      const { account } = await createAccount({ fullName: nom.trim(), email: email.trim(), password: provisoire });
      setCree({ nom: account.fullName, email: account.email, provisoire });
      setNom("");
      setEmail("");
      setProvisoire(provisoireAuHasard());
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Card>
      <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <UserPlus size={18} strokeWidth={1.75} />{" "}{t("Créer un compte sur ce poste")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Pour un collègue qui travaille sur cet ordinateur (un poste partagé, un accueil). Transmettez-lui le mot de passe provisoire : à sa première connexion, il en choisit un à lui, que vous ne connaîtrez pas. Il retrouve ensuite son compte dans la liste, à l'ouverture.")}
      </p>

      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (pret) void creer();
        }}
      >
        <Field label={t("Nom complet")}>
          <Input value={nom} autoComplete="off" onChange={(e) => setNom(e.target.value)} />
        </Field>
        <Field label={t("Adresse email")}>
          <Input type="email" autoComplete="off" placeholder={t("collegue@entreprise.fr")} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("Mot de passe provisoire")}>
          <div className="flex gap-2">
            <Input value={provisoire} autoComplete="off" spellCheck={false} onChange={(e) => setProvisoire(e.target.value)} />
            <Button type="button" variant="ghost" icon={RefreshCw} className="shrink-0" onClick={() => setProvisoire(provisoireAuHasard())}>
              {t("Autre")}
            </Button>
          </div>
        </Field>
        <div className="flex justify-end">
          <Button type="submit" icon={occupe ? Loader2 : UserPlus} disabled={!pret}>
            {occupe ? t("Création...") : t("Créer le compte")}
          </Button>
        </div>
      </form>

      {erreur && (
        <InfoBox tone="warning" className="mt-3" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}

      {cree && (
        <InfoBox tone="info" className="mt-3" leading={<Check size={15} strokeWidth={2.5} />}>
          {tf("Compte créé pour {0} ({1}). Donnez-lui ce mot de passe provisoire ; il en choisira un à lui à sa première connexion.", cree.nom, cree.email)}
          <div className="mt-2">
            <ACopier valeur={cree.provisoire} libelle={t("le mot de passe provisoire")} note={t("Il ne sert qu'une fois.")} />
          </div>
        </InfoBox>
      )}
    </Card>
  );
}

export default CreerCompte;
