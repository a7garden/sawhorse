import { useTranslation } from "react-i18next";
import { useState } from "react";
import {
  ArrowRight,
  Blocks,
  GitBranch,
  Globe,
  Package,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  AgentPresence,
  PackInfo,
  PackageWorkflowSummary,
} from "@/lib/types";
import { SkillsMarketplace } from "./SkillsMarketplace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./extension-marketplace.css";

export type ExtensionKind = "skill" | "workflow" | "feature";
export type CatalogSource = {
  kind: "https" | "git";
  location: string;
  commit?: string;
};
type Catalog = {
  name: string;
  packages: {
    id: string;
    name: string;
    description?: string;
    category?: string;
    source: CatalogSource;
  }[];
};
const kinds = ["skill", "workflow", "feature"] as const;
const icons = { skill: Sparkles, workflow: GitBranch, feature: Blocks };

/** Types describe contributions, not mutually exclusive package formats. */
export function packKinds(pack: PackInfo): ExtensionKind[] {
  return [
    ...(pack.skills.length ? ["skill" as const] : []),
    ...(pack.views.length || pack.actions.length || pack.settings.length
      ? ["feature" as const]
      : []),
  ];
}

export function ExtensionMarketplace({
  onChoose,
  onManage,
  agents,
  packs,
  workflows,
  busy,
  setBusy,
}: {
  onChoose: (source: CatalogSource) => void;
  onManage: (kind: ExtensionKind, packId?: string) => void;
  agents: AgentPresence[];
  packs: PackInfo[];
  workflows: PackageWorkflowSummary[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation("packs");
  const { t: common } = useTranslation("common");
  const [filter, setFilter] = useState<"all" | ExtensionKind>("all");
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem("sawhorse.marketplace-url") ?? "";
    } catch {
      return "";
    }
  });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const featurePacks = packs.filter((pack) =>
    packKinds(pack).includes("feature"),
  );

  async function loadCatalog() {
    setLoading(true);
    setMessage("");
    setCatalog(null);
    try {
      const result = (await api.fetchExtensionCatalog(url.trim())) as Catalog;
      if (
        !result ||
        typeof result.name !== "string" ||
        !Array.isArray(result.packages) ||
        result.packages.some(
          (item) =>
            !item ||
            typeof item.id !== "string" ||
            typeof item.name !== "string" ||
            !item.source ||
            !["https", "git"].includes(item.source.kind) ||
            typeof item.source.location !== "string",
        )
      ) {
        throw new Error(t("marketplace.invalidCatalog"));
      }
      setCatalog(result);
      try {
        localStorage.setItem("sawhorse.marketplace-url", url.trim());
      } catch {
        /* optional preference */
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="extension-marketplace">
      <header className="market-intro">
        <span className="market-eyebrow">SAWHORSE EXTENSIONS</span>
        <h1>{t("marketplace.title")}</h1>
        <p>{t("marketplace.subtitle")}</p>
      </header>
      <div
        className="market-types"
        role="group"
        aria-label={t("marketplace.typeFilter")}
      >
        {kinds.map((kind) => {
          const Icon = icons[kind];
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={filter === kind}
              onClick={() => setFilter(filter === kind ? "all" : kind)}
            >
              <Icon size={21} />
              <span>
                <strong>{t(`marketplace.types.${kind}.title`)}</strong>
                <small>{t(`marketplace.types.${kind}.desc`)}</small>
              </span>
              <ArrowRight size={15} />
            </button>
          );
        })}
      </div>
      <div className="market-filter-bar">
        <button
          type="button"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          {t("marketplace.all")}
        </button>
        <span>{t("marketplace.multiType")}</span>
      </div>
      <div hidden={filter !== "all" && filter !== "skill"}>
        <SkillsMarketplace agents={agents} busy={busy} setBusy={setBusy} />
      </div>
      {(filter === "all" || filter === "workflow") && (
        <section
          aria-label={t("marketplace.types.workflow.title")}
          className="market-collection"
        >
          <div className="market-section-heading">
            <GitBranch size={19} />
            <div className="flex-1">
              <h2>{t("marketplace.types.workflow.title")}</h2>
              <p>{t("marketplace.workflowSourceDesc")}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onManage("workflow")}
            >
              {t("marketplace.manageWorkflows")}
              <ArrowRight />
            </Button>
          </div>
          <div className="market-grid">
            {workflows.map((pack) => (
              <article key={pack.packageId} className="market-item">
                <div className="market-item-top">
                  <GitBranch size={17} />
                  <span className="market-badge">
                    {t("catalog.tabs.workflow")}
                  </span>
                </div>
                <h3>{pack.packageName}</h3>
                <p>
                  {pack.workflows.map((workflow) => workflow.label).join(" · ")}
                </p>
                <div className="market-item-footer">
                  <span>
                    {t(
                      pack.source === "builtin"
                        ? "source.builtin"
                        : "source.user",
                    )}{" "}
                    · v{pack.packageVersion}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onManage("workflow")}
                  >
                    {t("marketplace.viewWorkflows")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!workflows.length && (
            <p className="market-empty">{t("marketplace.workflowEmpty")}</p>
          )}
        </section>
      )}
      {(filter === "all" || filter === "feature") && (
        <section
          aria-label={t("marketplace.types.feature.title")}
          className="market-collection"
        >
          <div className="market-section-heading">
            <Blocks size={19} />
            <div className="flex-1">
              <h2>{t("marketplace.types.feature.title")}</h2>
              <p>{t("marketplace.featureSourceDesc")}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onManage("feature")}
            >
              {t("core.manage")}
              <ArrowRight />
            </Button>
          </div>
          <div className="market-grid">
            <article className="market-item">
              <div className="market-item-top">
                <Globe size={17} />
                <span className="market-badge">
                  {t("catalog.tabs.feature")}
                </span>
              </div>
              <h3>GitHub · {t("core.feeds.name")}</h3>
              <p>{t("marketplace.connectionsDesc")}</p>
              <div className="market-item-footer">
                <span>Sawhorse</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onManage("feature")}
                >
                  {t("core.manage")}
                </Button>
              </div>
            </article>
            {featurePacks.map((pack) => (
              <article key={pack.id} className="market-item">
                <div className="market-item-top">
                  <Package size={17} />
                  <div className="flex flex-wrap gap-1">
                    {[
                      ...packKinds(pack),
                      ...(workflows.some((w) => w.packageId === pack.id)
                        ? ["workflow" as const]
                        : []),
                    ].map((kind) => (
                      <span key={kind} className="market-badge">
                        {t(`catalog.tabs.${kind}`)}
                      </span>
                    ))}
                  </div>
                </div>
                <h3>{pack.name}</h3>
                <p>{pack.description}</p>
                <div className="market-item-footer">
                  <span>
                    {t(pack.enabled ? "status.inUse" : "status.disabled")} · v
                    {pack.version}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onManage("feature", pack.id)}
                  >
                    {t("core.manage")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      <details className="market-custom-source">
        <summary>
          <Globe size={16} />
          {t("marketplace.additionalSource")}
        </summary>
        <p>{t("marketplace.additionalSourceDesc")}</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void loadCatalog();
          }}
        >
          <Input
            className="min-w-48 flex-1"
            aria-label={common("market.urlAria")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/sawhorse-catalog.json"
          />
          <Button type="submit" size="sm" disabled={loading || !url.trim()}>
            {common("market.loadCatalog")}
          </Button>
        </form>
        {message && (
          <p role="alert" className="market-error">
            {message}
          </p>
        )}
        {catalog && (
          <div className="mt-4">
            <h2 className="mb-3 font-semibold">{catalog.name}</h2>
            <div className="market-grid">
              {catalog.packages.map((item) => (
                <article key={item.id} className="market-item">
                  <div className="market-item-top">
                    <Package size={17} />
                    <span className="market-badge">
                      {kinds.includes(item.category as ExtensionKind)
                        ? t(`catalog.tabs.${item.category}`)
                        : t("marketplace.package")}
                    </span>
                  </div>
                  <h3>{item.name}</h3>
                  <p>{item.description}</p>
                  <Button
                    className="mt-3 self-start"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onChoose(item.source)}
                  >
                    {common("market.choosePackage")}
                  </Button>
                </article>
              ))}
            </div>
            {!catalog.packages.length && (
              <p className="market-empty">{common("market.noPackages")}</p>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
