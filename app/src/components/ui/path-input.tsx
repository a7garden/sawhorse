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
            setError("파일 탐색기는 데스크톱 앱에서 사용할 수 있습니다.");
            return;
          }
          setBusy(true);
          try {
            const result = await open({
              directory,
              multiple,
              title: directory ? "폴더 선택" : "파일 선택",
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
        {label ?? (directory ? "폴더 선택" : "파일 선택")}
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
