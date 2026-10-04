"use client";

import { useEffect, useMemo, useState } from "react";
import { Database, Download, FileUp, ShieldCheck } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { hasMeaningfulDifference, MAX_BACKUP_BYTES, parseBackupText } from "@/lib/backup";
import { backupFromSnapshot, clearAllStudyData, getStudySnapshot, mergeStudyData, replaceAllStudyData, type Attempt, type BackupFile, type Draft, type Preferences, type StudySnapshot } from "@/lib/study-store";

type Conflict<T> = { id: string; local: T; incoming: T };
type ImportPlan = {
  backup: BackupFile;
  baseline: StudySnapshot;
  unknownQids: string[];
  conflicts: { attempts: Conflict<Attempt>[]; drafts: Conflict<Draft>[]; preferences: Conflict<Preferences>[] };
  counts: { newAttempts: number; newDrafts: number; newPreferences: number };
};
type ChoiceMap = Record<string, "local" | "incoming">;

function dateStamp() {
  const now = new Date();
  return now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
}

function createDownload(fileName: string, contents: string) {
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function conflictRows<T>(
  incoming: T[],
  local: T[],
  getId: (item: T) => string,
): { conflicts: Conflict<T>[]; newCount: number } {
  const byId = new Map(local.map((item) => [getId(item), item]));
  const conflicts: Conflict<T>[] = [];
  let newCount = 0;
  for (const item of incoming) {
    const localItem = byId.get(getId(item));
    if (!localItem) newCount += 1;
    else if (hasMeaningfulDifference(localItem, item)) conflicts.push({ id: getId(item), local: localItem, incoming: item });
  }
  return { conflicts, newCount };
}

function planImport(backup: BackupFile, unknownQids: string[], baseline: StudySnapshot): ImportPlan {
  const attempts = conflictRows(backup.attempts, baseline.attempts, (item) => item.attemptId);
  const drafts = conflictRows(backup.drafts, baseline.drafts, (item) => item.qid);
  const preferences = conflictRows(backup.preferences, baseline.preferences, (item) => item.key);
  return {
    backup,
    baseline,
    unknownQids,
    conflicts: { attempts: attempts.conflicts, drafts: drafts.conflicts, preferences: preferences.conflicts },
    counts: { newAttempts: attempts.newCount, newDrafts: drafts.newCount, newPreferences: preferences.newCount },
  };
}

function makeChoices<T>(conflicts: Conflict<T>[]): ChoiceMap {
  return Object.fromEntries(conflicts.map((item) => [item.id, "local"]));
}

function dataChangedSincePreview<T>(baseline: T[], current: T[], conflicts: Conflict<T>[], getId: (item: T) => string) {
  const baselineMap = new Map(baseline.map((item) => [getId(item), item]));
  const currentMap = new Map(current.map((item) => [getId(item), item]));
  return conflicts.some((item) => hasMeaningfulDifference(baselineMap.get(item.id), currentMap.get(item.id)));
}

export function DataManager({ knownQids, contentSetVersion }: { knownQids: string[]; contentSetVersion: string }) {
  const [snapshot, setSnapshot] = useState<StudySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [importError, setImportError] = useState("");
  const [message, setMessage] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [attemptChoices, setAttemptChoices] = useState<ChoiceMap>({});
  const [draftChoices, setDraftChoices] = useState<ChoiceMap>({});
  const [preferenceChoices, setPreferenceChoices] = useState<ChoiceMap>({});
  const [backupConfirmation, setBackupConfirmation] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBackupConfirmation, setClearBackupConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const qidSet = useMemo(() => new Set(knownQids), [knownQids]);

  useEffect(() => {
    let active = true;
    getStudySnapshot().then((current) => {
      if (!active) return;
      setStorageError("");
      setSnapshot(current);
    }).catch((error) => {
      if (!active) return;
      setStorageError(error instanceof Error ? error.message : "无法读取本设备数据库。");
      setSnapshot(null);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function downloadCurrentBackup(source: StudySnapshot | null = snapshot) {
    if (!source) {
      setStorageError("读取本设备记录失败，无法生成备份。");
      return false;
    }
    try {
      const file = backupFromSnapshot(source, contentSetVersion);
      createDownload("zhixu-study-backup-" + dateStamp() + ".json", JSON.stringify(file, null, 2));
      setMessage("已发起备份下载，请检查浏览器下载列表。");
      return true;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "备份下载失败。");
      return false;
    }
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setImportError("");
    setMessage("");
    setPlan(null);
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      setImportError("文件超过 10 MiB 上限。请选择较小的 JSON 备份。");
      return;
    }
    try {
      const parsed = parseBackupText(await file.text(), qidSet);
      const current = await getStudySnapshot();
      const next = planImport(parsed.backup, parsed.unknownQids, current);
      setSnapshot(current);
      setPlan(next);
      setAttemptChoices(makeChoices(next.conflicts.attempts));
      setDraftChoices(makeChoices(next.conflicts.drafts));
      setPreferenceChoices(makeChoices(next.conflicts.preferences));
      setBackupConfirmation(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "无法读取这个备份文件。");
    }
  }

  async function handleMerge() {
    if (!plan) return;
    setBusy(true);
    setImportError("");
    setMessage("");
    try {
      const current = await getStudySnapshot();
      const stale =
        dataChangedSincePreview(plan.baseline.attempts, current.attempts, plan.conflicts.attempts, (item) => item.attemptId) ||
        dataChangedSincePreview(plan.baseline.drafts, current.drafts, plan.conflicts.drafts, (item) => item.qid) ||
        dataChangedSincePreview(plan.baseline.preferences, current.preferences, plan.conflicts.preferences, (item) => item.key);
      if (stale) throw new Error("本设备数据在预览后发生变化。请重新选择备份并核对冲突。");
      await mergeStudyData(
        plan.backup,
        new Set(Object.entries(attemptChoices).filter(([, choice]) => choice === "incoming").map(([id]) => id)),
        new Set(Object.entries(draftChoices).filter(([, choice]) => choice === "incoming").map(([id]) => id)),
        new Set(Object.entries(preferenceChoices).filter(([, choice]) => choice === "incoming").map(([id]) => id)),
      );
      const next = await getStudySnapshot();
      setSnapshot(next);
      setMessage("导入完成：已添加 " + plan.counts.newAttempts + " 条练习、" + plan.counts.newDrafts + " 份草稿、" + plan.counts.newPreferences + " 项偏好；冲突按你的选择处理。");
      setPlan(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入失败，原有记录没有被替换。");
    } finally {
      setBusy(false);
    }
  }

  async function handleReplace() {
    if (!plan || !backupConfirmation) return;
    setBusy(true);
    setImportError("");
    try {
      const current = await getStudySnapshot();
      if (!downloadCurrentBackup(current)) throw new Error("覆盖前备份未能发起下载。");
      await replaceAllStudyData(plan.backup);
      setSnapshot(await getStudySnapshot());
      setMessage("已覆盖本设备数据。旧数据备份下载已发起；导入记录仍保留原内容版本。");
      setPlan(null);
      setReplaceOpen(false);
      setBackupConfirmation(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "整库覆盖失败，数据库事务已回滚。");
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (!snapshot || !clearBackupConfirmation) return;
    setBusy(true);
    setStorageError("");
    try {
      if (!downloadCurrentBackup(snapshot)) throw new Error("清除前备份未能发起下载。");
      await clearAllStudyData();
      setSnapshot(await getStudySnapshot());
      setMessage("本设备学习记录已清除，现有备份下载已发起。");
      setClearOpen(false);
      setClearBackupConfirmation(false);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "清除失败。");
    } finally {
      setBusy(false);
    }
  }

  const attemptItems = snapshot?.attempts.length ?? 0;
  const draftItems = snapshot?.drafts.length ?? 0;
  const canClear = Boolean(snapshot && (snapshot.attempts.length || snapshot.drafts.length || snapshot.preferences.length));

  return (
    <div className="content-page data-page">
      <header className="content-page-header">
        <div><div className="eyebrow">THIS BROWSER · 由你掌握</div><h1>本设备数据</h1><p>练习记录和草稿只保存在这个浏览器的 IndexedDB 中，不会同步到账号或其他设备。</p></div>
        <Badge variant="outline"><Database size={14} aria-hidden="true" /> 本设备</Badge>
      </header>

      <Card className="data-status-card">
        <div className="data-status-icon"><ShieldCheck size={22} aria-hidden="true" /></div>
        <div><h2>{loading ? "正在检查本设备存储" : storageError ? "存储暂不可用" : "数据仅保存在此浏览器"}</h2><p>{storageError || "清理网站数据、使用隐私模式或更换设备可能会移除记录。请定期导出 JSON 备份。"}</p></div>
        <div className="data-counts"><span><strong>{attemptItems}</strong> 次练习</span><span><strong>{draftItems}</strong> 份草稿</span></div>
      </Card>

      {storageError && <p className="assessment-error" role="alert">{storageError}</p>}
      {message && <p className="assessment-success" role="status">{message}</p>}
      {importError && <p className="assessment-error" role="alert">{importError}</p>}

      <div className="data-tools-grid">
        <Card className="data-tool-card">
          <div className="data-tool-heading"><Download size={18} aria-hidden="true" /><h2>导出备份</h2></div>
          <p>下载包含 schema 版本、内容集版本、练习记录、草稿和偏好的 JSON 文件。</p>
          <Button onClick={() => downloadCurrentBackup()} disabled={loading || Boolean(storageError)}><Download size={16} aria-hidden="true" />下载 JSON 备份</Button>
        </Card>

        <Card className="data-tool-card">
          <div className="data-tool-heading"><FileUp size={18} aria-hidden="true" /><h2>导入备份</h2></div>
          <p>导入前会检查大小、结构、记录 ID、题号和版本。校验失败时不会写入部分数据。</p>
          <Label className="file-input-label" htmlFor="backup-file">选择 JSON 备份</Label>
          <Input id="backup-file" type="file" accept="application/json,.json" onChange={(event) => void handleFile(event)} disabled={loading || Boolean(storageError)} />
          <small>最大 {Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MiB · 合并默认保留本机冲突记录</small>
        </Card>
      </div>

      {plan && (
        <Card className="import-plan-card">
          <div className="answer-card-header"><div><h2>导入预览</h2><p>文件：{new Date(plan.backup.exportedAt).toLocaleString()} · 内容版本 {plan.backup.contentSetVersion}</p></div><Badge variant={plan.backup.contentSetVersion === contentSetVersion ? "secondary" : "outline"}>{plan.backup.contentSetVersion === contentSetVersion ? "版本一致" : "版本不同"}</Badge></div>
          {plan.backup.contentSetVersion !== contentSetVersion && <p className="content-version-warning">内容版本不同。导入会保留每条历史记录原有版本，不会把旧自评迁移到新检查点。</p>}
          <div className="import-summary-grid"><span>新增练习 <strong>{plan.counts.newAttempts}</strong></span><span>新增草稿 <strong>{plan.counts.newDrafts}</strong></span><span>新增偏好 <strong>{plan.counts.newPreferences}</strong></span><span>未知题号 <strong>{plan.unknownQids.length}</strong></span></div>
          {plan.unknownQids.length > 0 && <p className="source-note">无法映射到本资料集的记录会跳过：{plan.unknownQids.slice(0, 12).join("、")}{plan.unknownQids.length > 12 ? " 等" : ""}</p>}
          {(plan.conflicts.attempts.length > 0 || plan.conflicts.drafts.length > 0 || plan.conflicts.preferences.length > 0) && (
            <Accordion type="multiple" className="import-conflicts">
              {plan.conflicts.attempts.length > 0 && <AccordionItem value="attempts"><AccordionTrigger>练习记录冲突 · {plan.conflicts.attempts.length}</AccordionTrigger><AccordionContent><div className="conflict-list">{plan.conflicts.attempts.map((conflict) => <div className="conflict-row" key={conflict.id}><div><strong>{conflict.local.qid} · {conflict.id}</strong><small>本机更新 {new Date(conflict.local.updatedAt).toLocaleString()} · 导入更新 {new Date(conflict.incoming.updatedAt).toLocaleString()}</small></div><Select value={attemptChoices[conflict.id] ?? "local"} onValueChange={(value) => setAttemptChoices((current) => ({ ...current, [conflict.id]: value as "local" | "incoming" }))}><SelectTrigger aria-label={conflict.id + " 的冲突选择"}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">保留本机</SelectItem><SelectItem value="incoming">使用导入记录</SelectItem></SelectContent></Select></div>)}</div></AccordionContent></AccordionItem>}
              {plan.conflicts.drafts.length > 0 && <AccordionItem value="drafts"><AccordionTrigger>草稿冲突 · {plan.conflicts.drafts.length}</AccordionTrigger><AccordionContent><div className="conflict-list">{plan.conflicts.drafts.map((conflict) => <div className="conflict-row" key={conflict.id}><div><strong>{conflict.id} 草稿</strong><small>本机保存 {new Date(conflict.local.savedAt).toLocaleString()} · 导入保存 {new Date(conflict.incoming.savedAt).toLocaleString()}</small></div><Select value={draftChoices[conflict.id] ?? "local"} onValueChange={(value) => setDraftChoices((current) => ({ ...current, [conflict.id]: value as "local" | "incoming" }))}><SelectTrigger aria-label={conflict.id + " 草稿冲突选择"}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">保留本机</SelectItem><SelectItem value="incoming">使用导入草稿</SelectItem></SelectContent></Select></div>)}</div></AccordionContent></AccordionItem>}
              {plan.conflicts.preferences.length > 0 && <AccordionItem value="preferences"><AccordionTrigger>偏好冲突 · {plan.conflicts.preferences.length}</AccordionTrigger><AccordionContent><div className="conflict-list">{plan.conflicts.preferences.map((conflict) => <div className="conflict-row" key={conflict.id}><div><strong>{conflict.id}</strong></div><Select value={preferenceChoices[conflict.id] ?? "local"} onValueChange={(value) => setPreferenceChoices((current) => ({ ...current, [conflict.id]: value as "local" | "incoming" }))}><SelectTrigger aria-label={conflict.id + " 偏好冲突选择"}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="local">保留本机</SelectItem><SelectItem value="incoming">使用导入偏好</SelectItem></SelectContent></Select></div>)}</div></AccordionContent></AccordionItem>}
            </Accordion>
          )}
          <div className="import-actions">
            <Button onClick={() => void handleMerge()} disabled={busy}>{busy ? "正在校验并合并…" : "合并导入"}</Button>
            <AlertDialog open={replaceOpen} onOpenChange={(open) => { setReplaceOpen(open); if (!open) setBackupConfirmation(false); }}>
              <AlertDialogTrigger asChild><Button variant="outline" onClick={() => setBackupConfirmation(false)} disabled={busy}>完整覆盖本设备</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>覆盖本设备全部学习记录？</AlertDialogTitle><AlertDialogDescription>覆盖无法撤销。系统会先发起一份当前数据备份，再用已校验的文件整批替换记录。</AlertDialogDescription></AlertDialogHeader>
                <Button variant="outline" onClick={() => { if (downloadCurrentBackup()) setBackupConfirmation(true); }}><Download size={15} aria-hidden="true" />下载现有备份</Button>
                <Label className="confirm-data-choice"><Checkbox checked={backupConfirmation} onCheckedChange={(value) => setBackupConfirmation(value === true)} /><span>我已确认备份已下载，并理解这会替换全部本机记录。</span></Label>
                <AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy || !backupConfirmation} onClick={(event) => { event.preventDefault(); void handleReplace(); }}>{busy ? "正在覆盖…" : "确认覆盖"}</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button variant="ghost" onClick={() => setPlan(null)}>取消导入</Button>
          </div>
        </Card>
      )}

      <Card className="data-clear-card">
        <div><h2>清除本设备记录</h2><p>清除会删除此浏览器里的练习、草稿和偏好。先下载备份，再二次确认后操作。</p></div>
        <AlertDialog open={clearOpen} onOpenChange={(open) => { setClearOpen(open); if (!open) setClearBackupConfirmation(false); }}>
          <AlertDialogTrigger asChild><Button variant="destructive" disabled={!canClear || busy}>清除记录</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>清除本设备学习记录？</AlertDialogTitle><AlertDialogDescription>此操作无法撤销。继续前先下载现有数据备份。</AlertDialogDescription></AlertDialogHeader>
            <Button variant="outline" onClick={() => { if (downloadCurrentBackup()) setClearBackupConfirmation(true); }}><Download size={15} aria-hidden="true" />下载现有备份</Button>
            <Label className="confirm-data-choice"><Checkbox checked={clearBackupConfirmation} onCheckedChange={(value) => setClearBackupConfirmation(value === true)} /><span>我已确认备份已下载，仍要清除全部本机记录。</span></Label>
            <AlertDialogFooter><AlertDialogCancel disabled={busy}>保留记录</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy || !clearBackupConfirmation} onClick={(event) => { event.preventDefault(); void handleClear(); }}>{busy ? "正在清除…" : "确认清除"}</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>
    </div>
  );
}
