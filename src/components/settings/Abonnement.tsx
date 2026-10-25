import { useState } from "react";
import { Building2, Check, Cpu, Mail, MapPin, TriangleAlert, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/settings/SettingsShell";
import { Button } from "@/components/ui/Button";
import { InfoBox } from "@/components/ui/InfoBox";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { branding } from "@/config/branding";
import {
  FORMULES,
  JETONS_PAR_ECHANGE,
  JETONS_PAR_TACHE,
  LANCEMENT,
  MODELES_INCLUS,
  MOIS_PAYES_PAR_AN,
  SUR_DEVIS,
  arrondiBas,
  echangesParJour,
  facteur,
  jetonsInclus,
  prixAnnuel,
  prixLancement,
  tachesParMois,
  type Formule,
  type Public,
} from "@/config/offre";
import { locale, t, tf } from "@/lib/i18n";

/**
 * L'offre d'abonnement.
 *
 * ── Ce que cet écran doit faire comprendre en dix secondes ──────────────────
 *
 * Que le logiciel reste gratuit. C'est contre-intuitif, et si ce n'est pas dit
 * en premier, tout le reste se lit comme un logiciel qu'on essaie de vendre
 * après l'avoir donné. Ce qui est vendu, c'est le **calcul** : des modèles
 * puissants qui tournent sur des cartes en Europe, pour qui n'a pas envie
 * d'acheter la carte. La plateforme entière est comprise dans chaque formule,
 * et l'écran la montre avant les prix.
 *
 * ── Ce qu'il ne fait pas, et le dit ─────────────────────────────────────────
 *
 * Rien n'est branché à un système de paiement. Un bouton « S'abonner » qui
 * n'encaisse rien serait exactement le genre de promesse que ce produit
 * s'interdit. L'écran présente donc une offre, annonce qu'elle n'est pas
 * ouverte, et propose d'écrire, ce qui, lui, fonctionne vraiment
 * (`npm run securite`, § 38, vérifie qu'aucun bouton de paiement n'y entre).
 *
 * Les chiffres viennent tous de `src/config/offre.ts`, avec leur mode de
 * calcul : coût de revient, frais de paiement, part du net qui paie le
 * calcul, jetons qui en découlent. Aucun nombre n'est écrit à la main ici.
 *
 * Refait le 29/09/2026 (grille de Medhi) : deux publics, un sélecteur
 * Mensuel / Annuel, le prix de lancement barré, trois modèles.
 */

type Periode = "mensuel" | "annuel";

const euros = (montant: number) =>
  new Intl.NumberFormat(locale(), { style: "currency", currency: "EUR" }).format(montant);

const millions = (n: number) =>
  new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(arrondiBas(n));

const entier = (n: number) => n.toLocaleString(locale());

/**
 * Ce que la plateforme comprend, dans chaque formule. Chaque ligne existe
 * dans le logiciel (vérifié le 29/09/2026 : pages Chat, Cowork, Code, Agents,
 * Réunions ; connecteurs de la passerelle ; `extensions/vscode` et
 * `cli/oxoai.mjs`). Les agents tournent dans l'instance : « jour et nuit »
 * seulement tant que la machine qui l'héberge est allumée, et l'écran le dit.
 */
function plateforme(): string[] {
  return [
    t("Modèles locaux sur vos machines, gratuits et sans limite"),
    t("Chat, avec recherche sur le web et documents joints"),
    t("Cowork : un agent qui travaille dans vos fichiers"),
    t("Code : un agent de code dans vos projets"),
    t("Agents qui travaillent seuls, jour et nuit, tant que la machine qui les héberge est allumée"),
    t("Connecteurs : Gmail, Drive, Slack, Microsoft 365 et bien d'autres"),
    t("Réunions : enregistrement, transcription, compte rendu"),
    t("Extension VS Code et ligne de commande"),
    t("Vos fichiers, vos Chats et vos réglages restent sur vos machines"),
    t("Modèles hébergés en Europe, logiciel libre au code public"),
  ];
}

export function Abonnement() {
  const [periode, setPeriode] = useState<Periode>("mensuel");
  const lancement = LANCEMENT.actif && periode === "mensuel";
  const particuliers = FORMULES.filter((f) => f.public === "particulier");
  const entreprises = FORMULES.filter((f) => f.public === "entreprise");

  return (
    <>
      <Card>
        <h3 className="text-lg font-semibold text-foreground">
          {t("Le logiciel est gratuit. Ce qui se paie, c'est le calcul.")}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {tf("{0} est un logiciel libre : vous pouvez l'installer sur vos machines, gratuitement et pour toujours, et y faire tourner vos propres modèles. C'est le cas aujourd'hui sur ce poste, et rien ne vous oblige à en changer.", branding.name)}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t("Un modèle vraiment puissant demande une carte graphique à plusieurs milliers d'euros, et quelqu'un pour l'entretenir. L'abonnement vous donne accès à ces modèles sans acheter la carte : ils tournent sur des serveurs en Europe, et vos demandes ne quittent pas l'Europe.")}
        </p>

        <h4 className="mt-5 text-sm font-semibold text-foreground">
          {t("Dans chaque formule, la plateforme entière")}
        </h4>
        <ul className="mt-2 grid gap-x-6 gap-y-1.5 cq-md:grid-cols-2">
          {plateforme().map((ligne) => (
            <li key={ligne} className="flex items-start gap-2 text-sm text-muted-foreground">
              <Check size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-success" />
              <span className="min-w-0">{ligne}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6">
        <h3 className="text-lg font-semibold text-foreground">{t("Les modèles hébergés")}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {t("Chaque formule donne un crédit de calcul par mois. Chaque modèle le consomme à son tarif, sur ce qu'il lit et sur ce qu'il écrit, réflexion comprise : les millions de jetons affichés plus bas sont des estimations.")}
        </p>
        <div className="mt-4 grid gap-3 cq-md:grid-cols-2">
          {MODELES_INCLUS.map((m) => (
            <div key={m.id} className="flex flex-col rounded-xl border border-border p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Cpu size={15} strokeWidth={1.75} className="shrink-0" /> {m.nom}
                <span className="ms-auto whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                  {tf("crédit ×{0}", facteur(m).toLocaleString(locale(), { maximumFractionDigits: 2 }))}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{m.modele}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{m.description}</p>
              <p className="mt-auto flex items-center gap-1.5 pt-2 text-xs text-muted-foreground">
                <MapPin size={13} strokeWidth={1.75} className="shrink-0" />
                {tf("Hébergé en {0}", m.heberge)}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {t("Les modèles sont à poids ouverts, d'où qu'ils viennent. C'est ce qui permet de les faire tourner sur des machines en Europe plutôt que d'envoyer vos documents chez leur éditeur : le pays du modèle compte moins que le pays de la machine qui le fait tourner.")}
        </p>
      </Card>

      <Card className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-lg font-semibold text-foreground">{t("Les formules")}</h3>
          <SegmentedTabs
            size="sm"
            className="ms-auto"
            value={periode}
            onChange={(v) => setPeriode(v as Periode)}
            options={[
              { id: "mensuel", label: t("Mensuel") },
              { id: "annuel", label: t("Annuel") },
            ]}
          />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {lancement
            ? tf("Prix de lancement : −{0} % sur le mensuel, les {1} premiers mois de l'abonnement. Les jetons restent ceux du prix normal. À l'année, {2} mois sont offerts.", Math.round(LANCEMENT.taux * 100), LANCEMENT.mois, 12 - MOIS_PAYES_PAR_AN)
            : tf("À l'année, {0} mois sont offerts : vous en payez {1} sur douze. Le crédit reste le même chaque mois.", 12 - MOIS_PAYES_PAR_AN, MOIS_PAYES_PAR_AN)}
        </p>

        <TitrePublic icone={User} titre={t("Particuliers")} detail={t("Prix TTC")} />
        <div className="mt-3 grid gap-3 cq-md:grid-cols-2">
          {particuliers.map((f) => (
            <CarteFormule key={f.id} formule={f} periode={periode} />
          ))}
        </div>

        <TitrePublic icone={Building2} titre={t("Entreprises")} detail={tf("Prix HT, par poste, {0} postes minimum", Math.min(...entreprises.map((f) => f.postesMin)))} />
        <div className="mt-3 grid gap-3 cq-md:grid-cols-2">
          {entreprises.map((f) => (
            <CarteFormule key={f.id} formule={f} periode={periode} />
          ))}
          <CarteSurDevis />
        </div>

        <div className="mt-5 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <p>
            {t("Les jetons d'une formule sont plusieurs façons de dépenser le même crédit : tout sur un modèle, ou un mélange. Ils ne s'additionnent pas. Le crédit se décompte sur les jetons réellement lus et écrits : un modèle qui réfléchit longtemps écrit plus, et consomme plus.")}
          </p>
          <p>
            {t("Quand le crédit du mois est épuisé, le Chat passe au modèle local de votre machine, sans rien facturer de plus.")}
          </p>
          <p>
            {tf("Les équivalences sont des estimations : un échange de Chat compte environ {0} jetons (question, historique et réponse), une tâche d'agent ou de Code environ {1}.", entier(JETONS_PAR_ECHANGE), entier(JETONS_PAR_TACHE))}
          </p>
        </div>
      </Card>

      <Card className="mt-6">
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          <span className="font-medium text-foreground">
            {t("Ces formules ne sont pas encore ouvertes.")}
          </span>{" "}
          {t("Aucun paiement n'est possible depuis cet écran, et les prix affichés sont une proposition : ils reposent sur les tarifs publiés par l'hébergeur et peuvent changer avant l'ouverture.")}
        </InfoBox>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button icon={Mail} onClick={() => ecrire(tf("Intérêt pour un abonnement {0}", branding.name))}>
            {t("Écrire pour être prévenu")}
          </Button>
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {t("Votre message part de votre messagerie, vers")}{" "}{branding.urls.supportEmail}.
          </span>
        </div>
      </Card>
    </>
  );
}

/** Ouvre la messagerie de la personne : c'est tout ce que cet écran sait faire, et il le fait vraiment. */
function ecrire(sujet: string) {
  window.location.href = `mailto:${branding.urls.supportEmail}?subject=${encodeURIComponent(sujet)}`;
}

function TitrePublic({ icone: Icone, titre, detail }: { icone: LucideIcon; titre: string; detail: string }) {
  return (
    <div className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-2">
      <h4 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <Icone size={16} strokeWidth={1.75} className="shrink-0 self-center" /> {titre}
      </h4>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

/** « TTC par mois », « HT par poste et par an »… selon le public et la période. */
function unite(pub: Public, periode: Periode): string {
  if (pub === "particulier") return periode === "mensuel" ? t("TTC par mois") : t("TTC par an");
  return periode === "mensuel" ? t("HT par poste et par mois") : t("HT par poste et par an");
}

function CarteFormule({ formule, periode }: { formule: Formule; periode: Periode }) {
  const modeles = MODELES_INCLUS.filter((m) => formule.modeles.includes(m.id));
  // Les équivalences se comptent sur le polyvalent : toutes les formules l'ont, et c'est lui qui donne le plus (30/09/2026).
  const repere = modeles.find((m) => m.id === "polyvalent") ?? modeles[0];
  const annuel = periode === "annuel";
  const remise = !annuel && LANCEMENT.actif ? prixLancement(formule) : formule.prix;
  const affiche = annuel ? prixAnnuel(formule) : remise;
  const entreprise = formule.public === "entreprise";

  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border p-3 cq-sm:p-4">
      <p className="text-base font-semibold text-foreground">{formule.nom}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{formule.pour}</p>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-2xl font-semibold tabular-nums text-foreground">{euros(affiche)}</span>
        {remise < formule.prix && (
          <s className="text-sm tabular-nums text-muted-foreground">
            <span className="sr-only">{t("au lieu de")} </span>
            {euros(formule.prix)}
          </s>
        )}
        <span className="text-xs text-muted-foreground">{unite(formule.public, periode)}</span>
      </div>
      <p className="mt-1 min-h-[1.25rem] text-xs text-muted-foreground">
        {annuel ? (
          tf("Soit {0} par mois", euros(affiche / 12))
        ) : remise < formule.prix ? (
          <>
            <span className="me-1.5 whitespace-nowrap rounded-full bg-success/15 px-1.5 py-0.5 font-medium text-success">
              {tf("−{0} %", Math.round(LANCEMENT.taux * 100))}
            </span>
            {tf("les {0} premiers mois, puis {1}", LANCEMENT.mois, euros(formule.prix))}
          </>
        ) : null}
      </p>

      <div className="mt-3 rounded-lg bg-muted/50 p-3">
        <p className="text-xs font-medium text-muted-foreground">
          {entreprise ? t("Crédit par poste et par mois, mis en commun dans l'équipe") : t("Crédit du mois")}
        </p>
        <dl className="mt-1.5 space-y-1">
          {modeles.map((m, i) => (
            <div key={m.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <dt className="text-muted-foreground">
                {i > 0 && <span className="me-1 text-xs">{t("ou")}</span>}
                {m.nom}
              </dt>
              <dd className="font-medium tabular-nums text-foreground">
                {tf("environ {0} millions de jetons", millions(jetonsInclus(formule, m)))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {/* Une seule phrase : la virgule collée entre deux moitiés restait latine en arabe, en chinois et en japonais (30/09/2026). */}
          {tf(
            "Environ {0} échanges de Chat par jour avec le modèle polyvalent, ou environ {1} tâches d'agent ou de Code par mois.",
            entier(echangesParJour(jetonsInclus(formule, repere))),
            entier(tachesParMois(jetonsInclus(formule, repere))),
          )}
        </p>
      </div>

      <ul className="mt-3 space-y-1.5">
        <Ligne>{formule.modeles.length === MODELES_INCLUS.length ? t("Tous les modèles hébergés") : t("Le modèle polyvalent")}</Ligne>
        <Ligne>{entreprise ? tf("{0} postes minimum", formule.postesMin) : t("Un poste")}</Ligne>
        <Ligne>{t("Toute la plateforme")}</Ligne>
      </ul>
    </div>
  );
}

function Ligne({ children }: { children: string }) {
  return (
    <li className="flex items-start gap-2 text-sm text-muted-foreground">
      <Check size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-success" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** La formule Entreprise : pas de prix, un devis. Le bouton écrit, il n'achète rien. */
function CarteSurDevis() {
  const lignes = [
    t("Un abonnement par poste"),
    tf("La consommation réelle, au coût de l'hébergeur plus {0} %", Math.round(SUR_DEVIS.majoration * 100)),
    t("Installation sur vos serveurs"),
    t("Accompagnement de vos équipes"),
    t("Support garanti par contrat"),
  ];
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border p-4 cq-md:col-span-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-base font-semibold text-foreground">{SUR_DEVIS.nom}</p>
        <span className="text-sm text-muted-foreground">{t("Sur devis")}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("Pour une organisation qui veut tout chez elle, avec un engagement de service")}
      </p>
      <ul className="mt-3 grid gap-x-6 gap-y-1.5 cq-md:grid-cols-2">
        {lignes.map((l) => (
          <Ligne key={l}>{l}</Ligne>
        ))}
      </ul>
      <div className="mt-4">
        <Button variant="secondary" icon={Mail} onClick={() => ecrire(tf("Demande de devis {0} Entreprise", branding.name))}>
          {t("Demander un devis")}
        </Button>
      </div>
    </div>
  );
}

export default Abonnement;
