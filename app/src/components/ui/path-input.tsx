import { useTranslation } from "react-i18next";
import { useState, type InputHTMLAttributes } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import { Input } from "./input";
import { Button } from "./button";

export function BrowseButton({
  directory = true,
  multiple = false,
  onSelect,
  label,
}: {
  directory?: boolean;
  multiple?: boolean;
  onSelect: (paths: string[]) => void;
  label?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation("common");
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setError("");
          if (!isTauri()) {
            setError(t("browse.desktopOnly"));
            return;
          }
          setBusy(true);
          try {
            const result = await open({
              directory,
              multiple,
              title: directory ? t("browse.pickFolder") : t("browse.pickFile"),
            });
            if (result) onSelect(Array.isArray(result) ? result : [result]);
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <FolderOpen />
        {label ?? (directory ? t("browse.pickFolder") : t("browse.pickFile"))}
      </Button>
      {error && (
        <small role="alert" className="text-destructive">
          {error}
        </small>
      )}
    </span>
  );
}

export function PathInput({
  directory = true,
  onValueChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  directory?: boolean;
  onValueChange: (value: string) => void;
}) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <Input
        {...props}
        onChange={(event) => onValueChange(event.target.value)}
      />
      <BrowseButton
        directory={directory}
        onSelect={([path]) => onValueChange(path)}
      />
    </span>
  );
}
