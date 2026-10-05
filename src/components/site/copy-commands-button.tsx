"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyCommandsButton({ value }: { value: string }) {
  const [message, setMessage] = useState("");

  async function copyCommands() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setMessage("命令已复制");
    } catch {
      setMessage("浏览器未开放剪贴板权限，请手动选中命令复制");
    }
  }

  return (
    <div className="assist-copy-control">
      <Button type="button" variant="outline" size="sm" onClick={() => void copyCommands()}>
        {message === "命令已复制" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        复制命令
      </Button>
      <span className="assist-copy-status" role="status" aria-live="polite">{message}</span>
    </div>
  );
}
