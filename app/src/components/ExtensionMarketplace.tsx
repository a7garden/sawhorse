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
  return (
    <details className="border-b p-4">
      <summary className="cursor-pointer text-sm font-medium">
        마켓플레이스 연결
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        Sawhorse 카탈로그 주소를 연결해 기능·워크플로·스킬 패키지를 찾아
        설치하세요.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="마켓플레이스 주소"
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
          목록 불러오기
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
                    setMessage(
                      `${item.name}을 선택했습니다. 아래에서 패키지를 검증·설치하세요.`,
                    );
                  }}
                >
                  설치할 패키지 선택
                </Button>
              </article>
            ))}
          </div>
          {!catalog.packages.length && (
            <p className="py-4 text-xs">등록된 패키지가 없습니다.</p>
          )}
        </div>
      )}
    </details>
  );
}
