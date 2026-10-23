import { useEffect, useState } from "react";
import { Check, KeyRound, TriangleAlert, UserCog } from "lucide-react";
import { Card } from "@/components/settings/SettingsShell";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { ACopier } from "@/components/ui/ACopier";
import { Avatar } from "@/components/ui/Avatar";
import { allAccounts, type Account } from "@/lib/store/accounts";
import { ACCOUNTS_CHANGED } from "@/lib/store/sync";
import { useUtilisateurCourant } from "@/lib/store/identity";
import { suisAdministrateur } from "@/lib/invitations";
import { lireEtat as etatDeuxFacteurs } from "@/lib/deuxFacteurs";
import { comptesAdministrateurs, reinitialiserCollegue } from "@/lib/motDePasseOublie";
import { useFormats } from "@/lib/formats";
import { t, tf } from "@/lib/i18n";

/**
 * Un collègue a oublié son mot de passe (23/10/2026).
 *
 * L'administrateur le réinitialise : l'instance tire un mot de passe
 * provisoire, montré ici une seule fois, valable 72 heures, qui n'ouvre que
 * le choix d'un mot de passe à soi (LoginPage, étape « provisoire »). Toutes
 * les séances et clés d'API du collègue tombent, et c'est écrit au journal,
 * au nom du collègue.
 *
 * Ce que l'écran ne propose pas, et que l'instance refuse de toute façon
 * (gateway/src/accounts.ts, `reinitialiserParAdministrateur`) : son propre
 * compte, et un compte qui administre aussi. Le mot de passe de
 * l'administrateur (et son code, s'il a la double authentification) est
 * redemandé à chaque fois. Le second facteur du collègue reste, sauf si la
 * case est cochée.
 *
 * Réservé à l'administrateur : la carte ne s'affiche pas pour un membre.
 */
export function ReinitialiserMotDePasse() {
  const moi = useUtilisateurCourant();
  const formats = useFormats();
  const [admin, setAdmin] = useState(false);
  const [administrateurs, setAdministrateurs] = useState<string[]>([]);
  const [monDeuxFacteurs, setMonDeuxFacteurs] = useState(false);
  const [comptes, setComptes] = useState<Account[]>(() => allAccounts());
  const [cible, setCible] = useState<Account | null>(null);
  const [motDePasse, setMotDePasse] = useState("");
  const [code, setCode] = useState("");
  const [retirerDf, setRetirerDf] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [fait, setFait] = useState<{ nom: string; provisoire: string; expire: string; deuxFacteursRetire: boolean } | null>(null);

  useEffect(() => {
    void suisAdministrateur().then((oui) => {
      setAdmin(oui);
      if (!oui) return;
      void comptesAdministrateurs().then(setAdministrateurs).catch(() => setAdministrateurs([]));
      void etatDeuxFacteurs().then((e) => setMonDeuxFacteurs(e.active)).catch(() => undefined);
    });
    const relire = () => setComptes(allAccounts());
    window.addEventListener(ACCOUNTS_CHANGED, relire);
    return () => window.removeEventListener(ACCOUNTS_CHANGED, relire);
  }, []);

  if (!admin) return null;

  const collegues = comptes.filter((c) => c.id !== moi.id && !administrateurs.includes(c.id));
  const pret = Boolean(cible) && motDePasse !== "" && (!monDeuxFacteurs || code.trim() !== "") && !occupe;

  const choisir = (c: Account | null) => {
    setCible(c);
    setMotDePasse("");
    setCode("");
    setRetirerDf(false);
    setErreur(null);
  };

  const reinitialiser = async () => {
    if (!cible || !pret) return;
    setOccupe(true);
    setErreur(null);
    try {
      const r = await reinitialiserCollegue({
        accountId: cible.id,
        password: motDePasse,
        ...(monDeuxFacteurs ? { code: code.trim() } : {}),
        retirerDeuxFacteurs: retirerDf,
      });
      setFait({ nom: cible.fullName, provisoire: r.provisoire, expire: r.expire, deuxFacteursRetire: r.deuxFacteursRetire });
      choisir(null);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Card>
      <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <UserCog size={18} strokeWidth={1.75} />{" "}{t("Mot de passe oublié par un collègue")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Réinitialisez-le : vous recevez un mot de passe provisoire, valable 72 heures, à lui transmettre. À sa connexion, il en choisit un à lui, que vous ne connaîtrez pas. Ses séances ouvertes et ses clés d'API sont fermées, et la réinitialisation est inscrite au journal.")}
      </p>

      {fait && (
        <InfoBox tone="info" className="mt-3" leading={<Check size={15} strokeWidth={2.5} />}>
          {tf("Mot de passe de {0} réinitialisé. Transmettez-lui ce mot de passe provisoire, de vive voix ou par un autre moyen que l'ordinateur ; il ne vaut que jusqu'au {1}.", fait.nom, formats.dateHeure(fait.expire))}
          {fait.deuxFacteursRetire && <span className="mt-1 block">{t("Sa double authentification a été retirée : il pourra la réactiver dans Réglages, Sécurité.")}</span>}
          <div className="mt-2">
            <ACopier valeur={fait.provisoire} libelle={t("le mot de passe provisoire")} note={t("Il n'est affiché qu'une fois.")} />
          </div>
        </InfoBox>
      )}

      {collegues.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t("Aucun autre compte à réinitialiser sur cette instance.")}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {collegues.map((c) => (
            <li key={c.id} className="rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <Avatar size={32} initials={c.initials} photo={c.photo} nom={c.fullName} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{c.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{c.email}</span>
                </span>
                {cible?.id !== c.id && (
                  <Button variant="secondary" size="sm" icon={KeyRound} onClick={() => choisir(c)}>
                    {t("Réinitialiser le mot de passe")}
                  </Button>
                )}
              </div>

              {cible?.id === c.id && (
                <form
                  className="mt-3 space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void reinitialiser();
                  }}
                >
                  <Field label={t("Votre mot de passe")} hint={t("Redemandé à chaque réinitialisation : une séance laissée ouverte ne suffit pas.")}>
                    <Input type="password" value={motDePasse} autoFocus autoComplete="current-password" onChange={(e) => setMotDePasse(e.target.value)} />
                  </Field>
                  {monDeuxFacteurs && (
                    <Field label={t("Votre code de vérification")} hint={t("Celui de l'application, ou un code de secours.")}>
                      <Input value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={32} onChange={(e) => setCode(e.target.value)} />
                    </Field>
                  )}
                  {c.deuxFacteursActive && (
                    <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
                      <input type="checkbox" className="mt-1" checked={retirerDf} onChange={() => setRetirerDf((v) => !v)} />
                      <span>
                        {t("Retirer aussi sa double authentification. À cocher seulement s'il a perdu son téléphone et ses codes de secours : sinon, laissez-la, elle protège son compte même contre qui connaît le mot de passe provisoire.")}
                      </span>
                    </label>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={() => choisir(null)} disabled={occupe}>
                      {t("Annuler")}
                    </Button>
                    <Button type="submit" variant="destructive" icon={KeyRound} disabled={!pret}>
                      {occupe ? t("Réinitialisation...") : t("Réinitialiser")}
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {erreur && (
        <InfoBox tone="warning" className="mt-3" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
      {administrateurs.some((id) => id !== moi.id) && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {t("Les comptes qui administrent aussi l'instance n'apparaissent pas : leur mot de passe se retrouve sur la machine de l'instance, ou avec un code de récupération.")}
        </p>
      )}
    </Card>
  );
}

export default ReinitialiserMotDePasse;
