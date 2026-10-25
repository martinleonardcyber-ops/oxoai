import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, KeyRound, Loader2, Pencil, Plus, ShieldAlert, TextCursorInput, Trash2, TriangleAlert } from "lucide-react";
import { Card } from "@/components/settings/SettingsShell";
import { ACopier } from "@/components/ui/ACopier";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { InfoBox } from "@/components/ui/InfoBox";
import { Select } from "@/components/ui/Select";
import { branding } from "@/config/branding";
import {
  DUREES,
  chargerClesApi,
  creerCleApi,
  renommerCleApi,
  revoquerCleApi,
  type CleApi,
  type EtatClesApi,
} from "@/lib/clesApi";
import { listerBases, type Base } from "@/lib/connaissances";
import { fetchModels } from "@/lib/gateway";
import { formaterDate, formaterMomentCourt, useFormats } from "@/lib/formats";
import { enumerer, t, tf } from "@/lib/i18n";
import { copierTexte, selectionner } from "@/lib/pressePapiers";

/**
 * Paramètres → API développeur (demandé par Medhi le 26/09/2026).
 *
 * Des clés personnelles pour l'API compatible OpenAI de l'instance, et la
 * documentation courte qui va avec. Ce que l'écran affiche vient de
 * l'instance : l'adresse de base est celle que la passerelle sert vraiment
 * (chiffrée ou non, ouverte au réseau ou non), les modèles et les bases sont
 * ceux de la personne. Rien de ce qui est écrit ici n'est une promesse que la
 * batterie de sécurité ne vérifie pas (scripts/securite.mjs, 7 ter bis).
 */

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const libelleDuree = (jours: number | null) =>
  jours === null ? t("Sans expiration") : jours === 365 ? t("1 an") : tf("{0} jours", jours);

export function ClesApi() {
  useFormats();
  const [etat, setEtat] = useState<EtatClesApi | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ajout, setAjout] = useState(false);
  /** La clé tout juste créée : affichée une fois, oubliée dès que la personne ferme l'encart. */
  const [nouvelle, setNouvelle] = useState<{ nom: string; secret: string } | null>(null);

  const charger = useCallback(() => {
    void chargerClesApi()
      .then((e) => {
        setEtat(e);
        setErreur(null);
      })
      .catch((err) => setErreur(message(err)));
  }, []);
  useEffect(charger, [charger]);

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex max-w-2xl gap-3">
            <KeyRound size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("Une clé d'API permet à un programme (un script, un tableur, un logiciel compatible OpenAI) de parler aux modèles de l'instance en votre nom : vos modèles, vos bases de connaissances, votre consommation dans Mon usage, votre journal. Elle n'ouvre rien d'autre.")}
            </p>
          </div>
          {!ajout && !nouvelle && (
            <Button icon={Plus} onClick={() => setAjout(true)}>
              {t("Créer une clé")}
            </Button>
          )}
        </div>
        {erreur && (
          <InfoBox tone="warning" className="mt-3" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
            {erreur}
          </InfoBox>
        )}
        {ajout && (
          <CreationCle
            onAnnuler={() => setAjout(false)}
            onCreee={(nom, secret) => {
              setAjout(false);
              setNouvelle({ nom, secret });
              charger();
            }}
          />
        )}
        {nouvelle && <CleMontreeUneFois {...nouvelle} onFermer={() => setNouvelle(null)} />}
      </Card>

      {etat === null ? (
        !erreur && <Loader2 size={18} strokeWidth={1.75} className="mx-auto animate-spin text-muted-foreground" />
      ) : etat.cles.length === 0 ? (
        !ajout && !nouvelle && <p className="px-1 text-sm text-muted-foreground">{t("Aucune clé pour l'instant.")}</p>
      ) : (
        <ul className="space-y-2">
          {etat.cles.map((c) => (
            <LigneCle key={c.id} cle={c} onChange={charger} />
          ))}
        </ul>
      )}

      {etat && <Documentation etat={etat} />}
    </>
  );
}

function CreationCle({ onAnnuler, onCreee }: { onAnnuler: () => void; onCreee: (nom: string, secret: string) => void }) {
  const [nom, setNom] = useState("");
  const [jours, setJours] = useState<number | null>(90);
  const [motDePasse, setMotDePasse] = useState("");
  const [code, setCode] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const creer = async () => {
    setOccupe(true);
    setErreur(null);
    try {
      const r = await creerCleApi(nom.trim(), jours, motDePasse, code.trim() || undefined);
      onCreee(r.cle.nom, r.secret);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setOccupe(false);
    }
  };
  return (
    <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
      <Field label={t("Nom de la clé")} hint={t("Pour la reconnaître : le programme ou la machine qui s'en sert.")}>
        <Input
          value={nom}
          maxLength={60}
          placeholder={t("Script de relance des devis")}
          onChange={(e) => setNom(e.target.value)}
          autoFocus
        />
      </Field>
      <Field label={t("Expiration")} hint={t("Passé ce délai, la clé ne vaut plus rien : il faut en créer une autre.")}>
        <Select
          value={jours === null ? "jamais" : String(jours)}
          onChange={(v) => setJours(v === "jamais" ? null : Number(v))}
          options={DUREES.map((d) => ({ value: d === null ? "jamais" : String(d), label: libelleDuree(d) }))}
        />
      </Field>
      <Field label={t("Votre mot de passe")} hint={t("Une clé dure plus longtemps que votre séance : on vérifie que c'est bien vous.")}>
        <Input
          type="password"
          value={motDePasse}
          autoComplete="current-password"
          onChange={(e) => setMotDePasse(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !occupe && nom.trim() && motDePasse && void creer()}
        />
      </Field>
      <Field label={t("Code de vérification")} hint={t("Seulement si la double authentification est active.")}>
        <Input value={code} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} />
      </Field>
      {erreur && (
        <InfoBox tone="warning" className="sm:col-span-2" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button icon={occupe ? Loader2 : KeyRound} disabled={occupe || !nom.trim() || !motDePasse} onClick={() => void creer()}>
          {t("Créer la clé")}
        </Button>
        <Button variant="ghost" onClick={onAnnuler}>
          {t("Annuler")}
        </Button>
      </div>
    </div>
  );
}

/** La clé en clair, une seule fois : l'instance ne pourra plus jamais la montrer. */
function CleMontreeUneFois({ nom, secret, onFermer }: { nom: string; secret: string; onFermer: () => void }) {
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
        <p className="font-medium">{tf("Clé « {0} » créée. Copiez-la maintenant : elle ne sera plus jamais affichée.", nom)}</p>
        <p className="mt-1">
          {t("L'instance n'en garde qu'une empreinte : si vous la perdez, révoquez-la et créez-en une autre. Traitez-la comme un mot de passe : quiconque la détient parle aux modèles en votre nom. Ne la collez ni dans un Chat, ni dans un dépôt de code.")}
        </p>
      </InfoBox>
      <ACopier valeur={secret} libelle={t("la clé")} effacerApres={60_000} />
      <Button icon={Check} variant="secondary" onClick={onFermer}>
        {t("J'ai copié la clé")}
      </Button>
    </div>
  );
}

function LigneCle({ cle, onChange }: { cle: CleApi; onChange: () => void }) {
  const [occupe, setOccupe] = useState(false);
  const [confirmer, setConfirmer] = useState(false);
  const [renommer, setRenommer] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const agir = async (f: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await f();
      setRenommer(null);
      setConfirmer(false);
      onChange();
    } catch (err) {
      setErreur(message(err));
    } finally {
      setOccupe(false);
    }
  };
  return (
    <li className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={16} strokeWidth={1.75} className="text-muted-foreground" />
        {renommer === null ? (
          <span className="font-medium text-foreground">{cle.nom}</span>
        ) : (
          <Input
            value={renommer}
            maxLength={60}
            className="max-w-xs py-1.5"
            aria-label={t("Nom de la clé")}
            onChange={(e) => setRenommer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renommer.trim()) void agir(() => renommerCleApi(cle.id, renommer.trim()));
              if (e.key === "Escape") setRenommer(null);
            }}
            autoFocus
          />
        )}
        <span className="font-mono text-xs text-muted-foreground">hlx_•••• {cle.fin}</span>
        {cle.expiree && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-foreground">{t("Expirée")}</span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {enumerer([
          tf("Créée le {0}", formaterDate(cle.creee)),
          cle.derniereUtilisation ? tf("dernière utilisation : {0}", formaterMomentCourt(cle.derniereUtilisation)) : t("jamais utilisée"),
          cle.expire === null
            ? t("sans expiration")
            : cle.expiree
              ? tf("expirée le {0}", formaterDate(cle.expire))
              : tf("expire le {0}", formaterDate(cle.expire)),
        ])}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {renommer !== null ? (
          <>
            <Button size="sm" disabled={occupe || !renommer.trim()} onClick={() => void agir(() => renommerCleApi(cle.id, renommer.trim()))}>
              {t("Enregistrer")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRenommer(null)}>
              {t("Annuler")}
            </Button>
          </>
        ) : confirmer ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-foreground">
              {t("Révoquer cette clé ? Les programmes qui s'en servent seront refusés dès maintenant.")}
            </span>
            <Button variant="destructive" size="sm" disabled={occupe} onClick={() => void agir(() => revoquerCleApi(cle.id))}>
              {t("Révoquer")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmer(false)}>
              {t("Annuler")}
            </Button>
          </span>
        ) : (
          <>
            <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setRenommer(cle.nom)}>
              {t("Renommer")}
            </Button>
            <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setConfirmer(true)}>
              {t("Révoquer")}
            </Button>
          </>
        )}
      </div>
      {erreur && (
        <InfoBox tone="warning" className="mt-2" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
    </li>
  );
}

/** Un bloc de code, recopiable d'un clic. */
function BlocCode({ code, libelle }: { code: string; libelle: string }) {
  /*
   * L'échec de la copie était avalé (`catch(() => undefined)`) : dans
   * l'application de bureau, le bouton ne faisait rien (27/09/2026). Refusée,
   * la copie sélectionne le code et le dit, comme ACopier.
   */
  const [etat, setEtat] = useState<"prêt" | "copié" | "sélectionné">("prêt");
  const bloc = useRef<HTMLPreElement>(null);
  const minuterie = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(minuterie.current), []);
  return (
    <div className="relative">
      {/*
        Classes physiques, voulues (30/09/2026) : un bloc de code reste de gauche
        à droite dans une page arabe, son bouton de copie reste donc à sa droite,
        là où la marge lui est réservée.
      */}
      <pre ref={bloc} dir="ltr" className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 pr-11 font-mono text-[12.5px] leading-relaxed text-foreground">
        {code}
      </pre>
      <IconButton
        icon={etat === "copié" ? Check : etat === "sélectionné" ? TextCursorInput : Copy}
        label={
          etat === "copié"
            ? tf("{0} : copié", libelle)
            : etat === "sélectionné"
              ? tf("{0} : sélectionné, à copier au clavier", libelle)
              : tf("Copier {0}", libelle)
        }
        size={30}
        iconSize={15}
        className="absolute right-1.5 top-1.5"
        onClick={() => {
          void copierTexte(code).then((ok) => {
            if (!ok) selectionner(bloc.current);
            setEtat(ok ? "copié" : "sélectionné");
            window.clearTimeout(minuterie.current);
            minuterie.current = window.setTimeout(() => setEtat("prêt"), 3000);
          });
        }}
      />
      {etat === "sélectionné" && (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {t("Copie automatique refusée : le texte est sélectionné, copiez-le au clavier.")}
        </p>
      )}
    </div>
  );
}

function Documentation({ etat }: { etat: EtatClesApi }) {
  const [modele, setModele] = useState<string | null>(null);
  const [bases, setBases] = useState<Base[] | null>(null);
  useEffect(() => {
    void fetchModels()
      .then((liste) => {
        const conversation = liste.filter((m) => m.roles.includes("chat"));
        setModele((conversation.find((m) => m.loaded) ?? conversation[0] ?? liste[0])?.uid ?? null);
      })
      .catch(() => setModele(null));
    void listerBases()
      .then(setBases)
      .catch(() => setBases([]));
  }, []);

  const base = etat.adresses.locale;
  const id = modele ?? t("identifiant-du-modele");
  // Le nom de la variable d'environnement suit la marque : aucun nom de produit écrit ici.
  const variable = `${branding.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  const bonjour = t("Bonjour, présente-toi en une phrase.");
  const kb = bases?.[0]?.id ?? "kb_…";

  const exemples = useMemo(
    () => ({
      curl: [
        `curl ${base}/chat/completions \\`,
        `  -H "Authorization: Bearer $${variable}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify({ model: id, messages: [{ role: "user", content: bonjour }] })}'`,
      ].join("\n"),
      python: [
        "import os",
        "from openai import OpenAI",
        "",
        `client = OpenAI(base_url="${base}", api_key=os.environ["${variable}"])`,
        "",
        "reponse = client.chat.completions.create(",
        `    model="${id}",`,
        `    messages=[{"role": "user", "content": ${JSON.stringify(bonjour)}}],`,
        ")",
        "print(reponse.choices[0].message.content)",
      ].join("\n"),
      flux: [
        "flux = client.chat.completions.create(",
        `    model="${id}",`,
        `    messages=[{"role": "user", "content": ${JSON.stringify(bonjour)}}],`,
        "    stream=True,",
        ")",
        "for morceau in flux:",
        "    if morceau.choices and morceau.choices[0].delta.content:",
        '        print(morceau.choices[0].delta.content, end="", flush=True)',
      ].join("\n"),
      bases: [
        "reponse = client.chat.completions.create(",
        `    model="${id}",`,
        `    messages=[{"role": "user", "content": ${JSON.stringify(t("Que disent nos documents sur les congés ?"))}}],`,
        `    extra_body={"connaissances": ["${kb}"]},`,
        ")",
      ].join("\n"),
      modeles: `curl ${base}/models -H "Authorization: Bearer $${variable}"`,
    }),
    [base, variable, id, bonjour, kb],
  );

  return (
    <Card className="mt-6 space-y-5">
      <div>
        <h3 className="font-semibold text-foreground">{t("Utiliser l'API")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("L'instance parle le format de l'API d'OpenAI : tout client prévu pour elle fonctionne en changeant l'adresse de base et la clé.")}
        </p>
      </div>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("Adresse de base")}</h4>
        <ACopier valeur={base} libelle={t("l'adresse")} note={t("Depuis cette machine, celle où tourne l'instance.")} />
        {etat.adresses.reseau.map((a) => (
          <ACopier
            key={a.url}
            valeur={a.url}
            libelle={t("l'adresse")}
            note={a.genre === "prive" ? t("Depuis le même réseau privé (VPN).") : t("Depuis le même réseau (Wi-Fi, câble).")}
          />
        ))}
        {etat.adresses.reseau.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("Depuis une autre machine, l'API n'est pas joignable : l'instance n'écoute que sur cette machine tant qu'elle n'est pas ouverte aux collègues (Réglages, Profil, rubrique Collègues).")}
          </p>
        )}
        {etat.adresses.chiffre && (
          <p className="text-sm text-muted-foreground">
            {t("L'instance chiffre avec un certificat qu'elle a signé elle-même : le fichier instance-cert.pem, dans le dossier tls de ses données. Donnez-le à votre programme comme autorité de confiance (avec curl : --cacert instance-cert.pem).")}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("Avec curl")}</h4>
        <p className="text-sm text-muted-foreground">
          {tf("Rangez la clé dans la variable d'environnement {0} plutôt que dans le code.", variable)}
        </p>
        <BlocCode code={exemples.curl} libelle={t("l'exemple curl")} />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("En Python, avec le paquet openai")}</h4>
        <BlocCode code={exemples.python} libelle={t("l'exemple Python")} />
        <p className="text-sm text-muted-foreground">{t("En flux, mot après mot :")}</p>
        <BlocCode code={exemples.flux} libelle={t("l'exemple en flux")} />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("Bases de connaissances")}</h4>
        <p className="text-sm text-muted-foreground">
          {t("Le champ connaissances reçoit les identifiants des bases à consulter : les passages proches de la question sont donnés au modèle, avec vos droits, comme dans le Chat. Sans flux, la réponse les rend dans oxoai.sources.")}
        </p>
        <BlocCode code={exemples.bases} libelle={t("l'exemple avec une base")} />
        {bases && bases.length > 0 && (
          <ul className="space-y-1 text-sm">
            {bases.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{b.nom}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{b.id}</code>
              </li>
            ))}
          </ul>
        )}
        {bases && bases.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("Vous ne voyez encore aucune base de connaissances.")}</p>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("Modèles")}</h4>
        <p className="text-sm text-muted-foreground">
          {t("La liste des modèles que vous pouvez utiliser ; le champ id se donne dans model.")}
        </p>
        <BlocCode code={exemples.modeles} libelle={t("l'exemple des modèles")} />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("Ce qu'une clé ne permet pas")}</h4>
        <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
          <li>{t("Aucune autre route de l'instance : ni les comptes, ni les Chats, ni les fichiers, ni les agents, ni les réglages, ni Code.")}</li>
          <li>{t("Aucun outil exécuté par l'instance (tools: true), ni vos connecteurs. Les outils que votre programme déclare et exécute lui-même restent possibles.")}</li>
          <li>{t("Créer une autre clé : cela se fait ici, avec votre séance.")}</li>
          <li>{t("Passer dans l'adresse : une clé ne se présente que dans l'en-tête Authorization. Glissée dans une adresse, elle est refusée.")}</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          {tf(
            "Au plus {0} requêtes par minute et par clé, {1} clés par personne. Chaque appel est inscrit à votre journal (Réglages, Sécurité), sans son contenu.",
            etat.parMinute,
            etat.limite,
          )}
        </p>
      </section>
    </Card>
  );
}
