import { useTranslation } from "react-i18next";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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
export function ExtensionMarketplace({
  onChoose,
}: {
  onChoose: (source: CatalogSource) => void;
}) {
  const [url, setUrl] = useState(() => {
    try {
      return localStorage.getItem("sawhorse.marketplace-url") ?? "";
    } catch {
      return "";
    }
  });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const { t } = useTranslation("common");
  return (
    <details className="border-b p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {t("market.connect")}
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        {t("market.connectDesc")}
      </p>
      <div className="flex gap-2">
        <Input
          aria-label={t("market.urlAria")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/sawhorse-catalog.json"
        />
        <Button
          size="sm"
          disabled={busy || !url.trim()}
          onClick={async () => {
            setBusy(true);
            setMessage("");
            setCatalog(null);
            try {
              const result = (await api.fetchExtensionCatalog(
                url.trim(),
              )) as Catalog;
              setCatalog(result);
              try {
                localStorage.setItem("sawhorse.marketplace-url", url.trim());
              } catch {
                /* preference only */
              }
            } catch (e) {
              setMessage(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("market.loadCatalog")}
        </Button>
      </div>
      {message && (
        <p role="status" className="mt-2 text-xs">
          {message}
        </p>
      )}
      {catalog && (
        <div className="mt-3">
          <strong className="text-sm">{catalog.name}</strong>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {catalog.packages.map((item) => (
              <article key={item.id} className="rounded-lg border p-3">
                <strong className="text-sm">{item.name}</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.description}
                </p>
                <Button
                  className="mt-2"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    onChoose(item.source);
                    setMessage(t("market.chosen", { name: item.name }));
                  }}
                >
                  {t("market.choosePackage")}
                </Button>
              </article>
            ))}
          </div>
          {!catalog.packages.length && (
            <p className="py-4 text-xs">{t("market.noPackages")}</p>
          )}
        </div>
      )}
    </details>
  );
}
