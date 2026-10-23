import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, LifeBuoy, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { Card } from "@/components/settings/SettingsShell";
import { useFormats } from "@/lib/formats";
import { creerCodesRecuperation, lireEtatRecuperation, type EtatRecuperation } from "@/lib/motDePasseOublie";
import { t, tf } from "@/lib/i18n";
import { copierTexte } from "@/lib/pressePapiers";

/**
 * Codes de récupération du mot de passe (23/10/2026).
 *
 * Dix codes, chacun redéfinit le mot de passe une fois depuis l'écran de
 * connexion (« Mot de passe oublié ? »). Ils ne remplacent pas le second
 * facteur : avec la double authentification, le téléphone reste demandé
 * ensuite. Montrés une seule fois ; l'instance n'en garde que l'empreinte.
 * En tirer une nouvelle série redemande le mot de passe (et le code du
 * téléphone si la double authentification est active) : une séance laissée
 * ouverte ne doit pas suffire à se fabriquer une porte de retour.
 */
export function CodesRecuperation() {
  const formats = useFormats();
  const [etat, setEtat] = useState<EtatRecuperation | null>(null);
  const [erreurChargement, setErreurChargement] = useState<string | undefined>();
  const [demande, setDemande] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [motDePasse, setMotDePasse] = useState("");
  const [code, setCode] = useState("");
  const [erreur, setErreur] = useState<string | undefined>();
  const [occupe, setOccupe] = useState(false);
  const [copie, setCopie] = useState(false);

  const charger = useCallback(() => {
    lireEtatRecuperation()
      .then((e) => {
        setEtat(e);
        setErreurChargement(undefined);
      })
      .catch((err: unknown) => setErreurChargement(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(charger, [charger]);

  const fermer = () => {
    setDemande(false);
    setCodes(null);
    setMotDePasse("");
    setCode("");
    setErreur(undefined);
    setCopie(false);
  };

  const creer = () => {
    if (!motDePasse || (etat?.deuxFacteursActive && !code.trim())) return;
    setOccupe(true);
    setErreur(undefined);
    creerCodesRecuperation(motDePasse, etat?.deuxFacteursActive ? code.trim() : undefined)
      .then((r) => {
        setCodes(r.codes);
        setMotDePasse("");
        setCode("");
      })
      .catch((err: unknown) => setErreur(err instanceof Error ? err.message : String(err)))
      .finally(() => setOccupe(false));
  };

  const copier = async (liste: string[]) => {
    if (await copierTexte(liste.join("\n"))) setCopie(true);
    else {
      setCopie(false);
      setErreur(t("La copie a échoué : recopiez les codes à la main."));
    }
  };

  const messageErreur = erreur && (
    <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
      {erreur}
    </InfoBox>
  );

  if (erreurChargement) {
    return (
      <Card>
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreurChargement}
        </InfoBox>
      </Card>
    );
  }
  if (!etat) {
    return (
      <Card>
        <p className="text-sm text-muted-foreground">{t("Chargement…")}</p>
      </Card>
    );
  }

  if (codes) {
    return (
      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound size={18} strokeWidth={1.75} className="text-foreground" />
          <p className="font-medium text-foreground">{t("Vos codes de récupération")}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("Chacun de ces codes redéfinit votre mot de passe une fois, si vous l'oubliez (écran de connexion, « Mot de passe oublié ? »). Ils ne seront plus jamais affichés : imprimez-les ou rangez-les ailleurs que sur cet ordinateur.")}
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-xl bg-muted/40 p-4 font-mono text-sm text-foreground">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {messageErreur}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={copie ? Check : Copy} onClick={() => void copier(codes)}>
            {copie ? t("Copiés") : t("Copier les codes")}
          </Button>
          <Button
            icon={Check}
            onClick={() => {
              fermer();
              charger();
            }}
          >
            {t("J'ai mis mes codes à l'abri")}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted">
          <LifeBuoy size={20} strokeWidth={1.75} className="text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t("Codes de récupération")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {etat.restants === 1
              ? tf("Un code encore valable, d'une série créée le {0}.", etat.creeLe ? formats.date(etat.creeLe) : "")
              : etat.restants > 1
                ? tf("{0} codes encore valables, d'une série créée le {1}.", etat.restants, etat.creeLe ? formats.date(etat.creeLe) : "")
                : t("Aucun code pour l'instant. Si vous oubliez votre mot de passe, un code de récupération vous permet d'en choisir un nouveau sans l'aide de personne.")}
          </p>
          {etat.deuxFacteursActive && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Ils remplacent le mot de passe seulement : le code de votre téléphone reste demandé à la connexion.")}
            </p>
          )}
        </div>
      </div>

      {demande ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {etat.restants > 0
              ? t("Une nouvelle série remplace l'ancienne, qui cesse aussitôt de fonctionner. Confirmez que c'est bien vous.")
              : t("Confirmez que c'est bien vous.")}
          </p>
          <Field label={t("Votre mot de passe")}>
            <Input
              type="password"
              value={motDePasse}
              autoFocus
              autoComplete="current-password"
              onChange={(e) => setMotDePasse(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") creer();
              }}
            />
          </Field>
          {etat.deuxFacteursActive && (
            <Field label={t("Code de vérification")} hint={t("Celui de l'application, ou un code de secours.")}>
              <Input
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={32}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") creer();
                }}
              />
            </Field>
          )}
          {messageErreur}
          <div className="flex gap-2">
            <Button icon={KeyRound} onClick={creer} disabled={occupe || !motDePasse || (etat.deuxFacteursActive && !code.trim())}>
              {t("Créer les codes")}
            </Button>
            <Button variant="ghost" onClick={fermer} disabled={occupe}>
              {t("Annuler")}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant={etat.restants > 0 ? "secondary" : "primary"} icon={etat.restants > 0 ? RefreshCw : KeyRound} onClick={() => setDemande(true)}>
          {etat.restants > 0 ? t("Remplacer mes codes") : t("Créer mes codes de récupération")}
        </Button>
      )}
    </Card>
  );
}

export default CodesRecuperation;
