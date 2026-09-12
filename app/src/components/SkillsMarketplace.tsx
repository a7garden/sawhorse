import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type { AgentPresence, MarketSkill } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function SkillsMarketplace({
  agents,
  busy,
  setBusy,
}: {
  agents: AgentPresence[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation("packs");
  const targets = useMemo(
    () => agents.filter((a) => ["claude", "codex"].includes(a.id)),
    [agents],
  );
  // null means no explicit choice yet; an intentionally empty selection stays empty.
  const [selection, setSelection] = useState<string[] | null>(null);
  const selected =
    selection ?? targets.filter((a) => a.detected).map((a) => a.id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketSkill[]>([]);
  const [searched, setSearched] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [notice, setNotice] = useState("");
  const [log, setLog] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Record<string, string[]>>({});
  const request = useRef(0);
  const operation = useRef(false);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  async function search(value: string) {
    const q = value.trim();
    if (q.length < 2) return;
    const id = ++request.current;
    setQuery(value);
    setSearching(true);
    setError("");
    setResults([]);
    setSearched(q);
    try {
      const rows = await api.skillsMarketSearch(q);
      if (id === request.current) setResults(rows);
    } catch (e) {
      if (id === request.current) setError(String(e));
    } finally {
      if (id === request.current) setSearching(false);
    }
  }

  async function install(row: MarketSkill) {
    if (busy || operation.current || !selected.length || !row.skillId) return;
    operation.current = true;
    const agentIds = [...selected];
    setBusy(true);
    setInstalling(row.id);
    setOperationError("");
    setNotice("");
    setLog("");
    try {
      setLog(await api.skillsMarketInstall(row.source, row.skillId, agentIds));
      setCompleted((prev) => ({
        ...prev,
        [row.id]: [...new Set([...(prev[row.id] ?? []), ...agentIds])],
      }));
      setNotice(t("marketplace.installSuccess", { name: row.name }));
    } catch (e) {
      setOperationError(String(e));
    } finally {
      operation.current = false;
      setBusy(false);
      setInstalling(null);
    }
  }

  async function update() {
    if (busy || operation.current) return;
    operation.current = true;
    setBusy(true);
    setOperationError("");
    setNotice("");
    setLog("");
    try {
      setLog(await api.skillsMarketUpdate());
      setNotice(t("skillsTab.market.updated"));
    } catch (e) {
      setOperationError(String(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="skill-market" aria-label={t("skillsTab.market.title")}>
      <div className="market-section-heading">
        <div className="market-source-icon">
          <Sparkles size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2>
            skills.sh{" "}
            <span className="market-badge">
              {t("marketplace.defaultSource")}
            </span>
          </h2>
          <p>{t("marketplace.skillsSourceDesc")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void update()}
        >
          <RefreshCw size={14} /> {t("skillsTab.market.updateAll")}
        </Button>
      </div>
      <form
        className="market-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <Search size={18} className="text-muted-foreground" />
        <Input
          aria-label={t("skillsTab.market.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("marketplace.searchPlaceholder")}
        />
        <Button type="submit" disabled={searching || query.trim().length < 2}>
          {searching ? <Loader2 className="animate-spin" /> : <Search />}{" "}
          {t("skillsTab.market.search")}
        </Button>
      </form>
      <div className="market-topics">
        <span>{t("marketplace.explore")}</span>
        {["react", "design", "testing", "documentation", "workflow"].map(
          (topic) => (
            <button
              key={topic}
              type="button"
              disabled={searching}
              onClick={() => void search(topic)}
            >
              {topic}
              <ArrowUpRight size={11} />
            </button>
          ),
        )}
      </div>
      <div className="market-targets">
        <span>{t("skillsTab.market.targets")}</span>
        {targets.map((agent) => (
          <button
            type="button"
            key={agent.id}
            disabled={busy}
            aria-pressed={selected.includes(agent.id)}
            onClick={() =>
              setSelection(
                selected.includes(agent.id)
                  ? selected.filter((id) => id !== agent.id)
                  : [...selected, agent.id],
              )
            }
          >
            {selected.includes(agent.id) && <Check size={12} />}
            {agent.name}
            {!agent.detected && ` · ${t("packAgents.undetected")}`}
          </button>
        ))}
        <span className="market-scope">{t("marketplace.globalScope")}</span>
      </div>
      {!selected.length && (
        <p className="market-hint">{t("skillsTab.market.noTargets")}</p>
      )}
      {error && (
        <div role="alert" className="market-error">
          <p>{error}</p>
          {searched && (
            <Button
              size="xs"
              variant="outline"
              disabled={searching || busy}
              onClick={() => void search(searched)}
            >
              {t("marketplace.retrySearch")}
            </Button>
          )}
        </div>
      )}
      {operationError && (
        <p role="alert" className="market-error">
          {operationError}
        </p>
      )}
      {notice && (
        <p role="status" className="market-notice">
          {notice}
        </p>
      )}
      <div aria-busy={searching}>
        {searching ? (
          <div role="status" className="market-empty">
            <Loader2 className="animate-spin" size={20} />
            {t("marketplace.searching")}
          </div>
        ) : searched && !error ? (
          <>
            <p className="market-result-count">
              {t("marketplace.results", {
                query: searched,
                count: results.length,
              })}
            </p>
            {!results.length && (
              <div className="market-empty">
                {t("skillsTab.market.noResults")}
              </div>
            )}
            <div className="market-grid">
              {results.map((row) => {
                const done =
                  selected.length > 0 &&
                  selected.every((id) => completed[row.id]?.includes(id));
                return (
                  <article className="market-item" key={row.id}>
                    <div className="market-item-top">
                      <Sparkles size={17} />
                      <span className="market-badge">
                        {t("catalog.tabs.skill")}
                      </span>
                    </div>
                    <h3>{row.name}</h3>
                    <p className="market-repo">{row.source}</p>
                    <div className="market-item-footer">
                      <span>
                        {t("skillsTab.market.installs", {
                          n: row.installs.toLocaleString(),
                        })}
                      </span>
                      <Button
                        size="sm"
                        variant={done ? "outline" : "default"}
                        disabled={
                          busy || !selected.length || !row.skillId || done
                        }
                        onClick={() => void install(row)}
                      >
                        {installing === row.id ? (
                          <Loader2 className="animate-spin" />
                        ) : done ? (
                          <Check />
                        ) : (
                          <Download />
                        )}
                        {done ? t("core.installed") : t("actions.install")}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        ) : (
          !error && (
            <div className="market-empty">
              <Search size={22} />
              <strong>{t("marketplace.startSearch")}</strong>
              <span>{t("marketplace.startSearchDesc")}</span>
            </div>
          )
        )}
      </div>
      {log && (
        <details className="market-log">
          <summary>{t("skillsTab.market.logTitle")}</summary>
          <pre>{log}</pre>
        </details>
      )}
    </section>
  );
}
