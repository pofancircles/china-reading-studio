import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  MonitorPlay,
  Plus,
  Trash2,
} from "lucide-react";

import {
  createMaterialDraft,
  exportDeckToPptx,
  exportWorksheetToDocx,
  validateMaterialDraft,
  type MaterialDraft,
  type MaterialSource,
} from "./materials";

type StudioTab = "deck" | "worksheet";
type ExportKind = "pptx" | "student" | "teacher";

const MIN_SLIDES = 6;
const MAX_SLIDES = 10;

const SLIDE_KIND_LABELS: Record<MaterialDraft["slides"][number]["kind"], string> = {
  title: "封面",
  warmup: "导入",
  reading: "阅读",
  vocabulary: "生词",
  practice: "练习",
  interaction: "互动",
  summary: "总结",
};

function newId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function MaterialsStudio({ source, onClose }: { source: MaterialSource; onClose: () => void }) {
  const [draft, setDraft] = useState<MaterialDraft>(() => createMaterialDraft(source));
  const [activeTab, setActiveTab] = useState<StudioTab>("deck");
  const [selectedSlideId, setSelectedSlideId] = useState(() => draft.slides[0]?.id ?? "");
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("草稿已根据已确认的备课方案生成，可以直接微调。");
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState("");
  const [exportSuccess, setExportSuccess] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const selectedIndex = useMemo(
    () => Math.max(0, draft.slides.findIndex((slide) => slide.id === selectedSlideId)),
    [draft.slides, selectedSlideId],
  );
  const selectedSlide = draft.slides[selectedIndex];

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    headingRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dirty, onClose]);

  function requestClose() {
    if (dirty && !window.confirm("关闭后当前微调将丢失，确定返回吗？")) return;
    onClose();
  }

  function updateDraft(updater: (current: MaterialDraft) => MaterialDraft, message = "修改已保留在当前草稿中。") {
    setDraft(updater);
    setDirty(true);
    setFeedback(message);
    setExportError("");
    setExportSuccess("");
  }

  function updateSelectedSlide(patch: Partial<MaterialDraft["slides"][number]>) {
    if (!selectedSlide) return;
    updateDraft((current) => {
      const nextTitle = selectedSlide.kind === "title" && typeof patch.title === "string" ? patch.title : current.title;
      const worksheetTitle = current.worksheet.title === `${current.title}｜课后练习`
        ? `${nextTitle}｜课后练习`
        : current.worksheet.title;
      return {
        ...current,
        title: nextTitle,
        slides: current.slides.map((slide) => slide.id === selectedSlide.id ? { ...slide, ...patch } : slide),
        worksheet: { ...current.worksheet, title: worksheetTitle },
      };
    });
  }

  function moveSelectedSlide(direction: -1 | 1) {
    const nextIndex = selectedIndex + direction;
    if (!selectedSlide || nextIndex < 0 || nextIndex >= draft.slides.length) {
      setFeedback(direction < 0 ? "已经是第一页。" : "已经是最后一页。");
      return;
    }
    updateDraft((current) => {
      const slides = [...current.slides];
      [slides[selectedIndex], slides[nextIndex]] = [slides[nextIndex], slides[selectedIndex]];
      return { ...current, slides };
    }, `已将第 ${selectedIndex + 1} 页移动到第 ${nextIndex + 1} 页。`);
  }

  function duplicateSelectedSlide() {
    if (!selectedSlide) return;
    if (draft.slides.length >= MAX_SLIDES) {
      setFeedback(`PPT 最多 ${MAX_SLIDES} 页，请先删除一页再复制。`);
      return;
    }
    const copy = { ...selectedSlide, id: newId("slide"), title: `${selectedSlide.title}（副本）`, body: [...selectedSlide.body] };
    updateDraft((current) => ({
      ...current,
      slides: [...current.slides.slice(0, selectedIndex + 1), copy, ...current.slides.slice(selectedIndex + 1)],
    }), `已复制第 ${selectedIndex + 1} 页。`);
    setSelectedSlideId(copy.id);
  }

  function deleteSelectedSlide() {
    if (!selectedSlide) return;
    if (draft.slides.length <= MIN_SLIDES) {
      setFeedback(`PPT 至少保留 ${MIN_SLIDES} 页，当前页不能删除。`);
      return;
    }
    const nextSelection = draft.slides[selectedIndex + 1]?.id ?? draft.slides[selectedIndex - 1]?.id ?? "";
    updateDraft((current) => ({
      ...current,
      slides: current.slides.filter((slide) => slide.id !== selectedSlide.id),
    }), `已删除第 ${selectedIndex + 1} 页。`);
    setSelectedSlideId(nextSelection);
  }

  function addSlide() {
    if (draft.slides.length >= MAX_SLIDES) {
      setFeedback(`PPT 最多 ${MAX_SLIDES} 页，请先删除一页再添加。`);
      return;
    }
    const slide: MaterialDraft["slides"][number] = {
      id: newId("slide"),
      kind: "interaction",
      title: "新增课堂互动",
      body: ["在这里填写教师可以直接使用的课堂内容。"],
    };
    updateDraft((current) => ({ ...current, slides: [...current.slides, slide] }), `已添加第 ${draft.slides.length + 1} 页。`);
    setSelectedSlideId(slide.id);
  }

  async function handleExport(kind: ExportKind) {
    if (exporting) return;
    const errors = validateMaterialDraft(draft);
    if (errors.length) {
      setExportError(errors.join("；"));
      setExportSuccess("");
      return;
    }
    setExporting(kind);
    setExportError("");
    setExportSuccess("");
    try {
      if (kind === "pptx") await exportDeckToPptx(draft);
      else await exportWorksheetToDocx(draft, kind === "teacher");
      setExportSuccess(kind === "pptx" ? "PPT 已开始下载。" : kind === "student" ? "学生版练习已开始下载。" : "教师答案版已开始下载。");
      setFeedback("下载完成后仍可继续微调当前草稿。");
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出失败，请稍后重试。");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 flex-col bg-paper text-ink" role="dialog" aria-modal="true" aria-labelledby="materials-studio-title">
      <header className="shrink-0 border-b border-line bg-white/95 px-4 py-3 shadow-sm backdrop-blur md:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={requestClose} title="返回备课方案" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink transition hover:border-moss hover:text-moss">
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-moss">04 / 课堂材料工作台</p>
              <h2 id="materials-studio-title" ref={headingRef} tabIndex={-1} className="truncate font-display text-xl outline-none md:text-2xl">{draft.title}</h2>
            </div>
            <span className="hidden rounded-full bg-[#e6f0e5] px-3 py-1.5 text-xs font-semibold text-moss sm:inline-flex">{draft.level} · {draft.slides.length} 页</span>
          </div>

          <div className="flex max-w-full gap-2 overflow-x-auto pb-1 xl:justify-end xl:pb-0">
            <ExportButton kind="pptx" label="下载 PPT" icon={<MonitorPlay size={15} />} exporting={exporting} onClick={handleExport} />
            <ExportButton kind="student" label="学生版练习" icon={<FileText size={15} />} exporting={exporting} onClick={handleExport} />
            <ExportButton kind="teacher" label="教师答案版" icon={<Download size={15} />} exporting={exporting} onClick={handleExport} />
          </div>
        </div>
        <div className="mx-auto mt-2 max-w-[1600px] text-xs" aria-live="polite" aria-atomic="true">
          {exportError ? <p role="alert" className="text-coral">{exportError}</p> : exportSuccess ? <p className="inline-flex items-center gap-1.5 text-moss"><CheckCircle2 size={14} />{exportSuccess}</p> : exporting ? <p className="inline-flex items-center gap-1.5 text-moss"><LoaderCircle size={14} className="animate-spin" />正在生成下载文件，请稍候…</p> : <p className="text-slate-400">{feedback}</p>}
        </div>
      </header>

      <div className="shrink-0 border-b border-line bg-white px-4 md:px-6">
        <div className="mx-auto flex max-w-[1600px] gap-1" role="tablist" aria-label="课堂材料类型">
          <button id="materials-deck-tab" type="button" role="tab" aria-controls="materials-deck-panel" aria-selected={activeTab === "deck"} onClick={() => setActiveTab("deck")} className={`border-b-2 px-4 py-3 text-sm font-semibold transition ${activeTab === "deck" ? "border-coral text-ink" : "border-transparent text-slate-400 hover:text-ink"}`}>PPT 课件</button>
          <button id="materials-worksheet-tab" type="button" role="tab" aria-controls="materials-worksheet-panel" aria-selected={activeTab === "worksheet"} onClick={() => setActiveTab("worksheet")} className={`border-b-2 px-4 py-3 text-sm font-semibold transition ${activeTab === "worksheet" ? "border-coral text-ink" : "border-transparent text-slate-400 hover:text-ink"}`}>课后练习</button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {activeTab === "deck" ? (
          <div id="materials-deck-panel" role="tabpanel" aria-labelledby="materials-deck-tab" className="mx-auto grid max-w-[1600px] gap-4 xl:min-h-full xl:grid-cols-[220px_minmax(0,1fr)_320px]">
            <aside className="min-w-0 rounded-2xl border border-line bg-white p-3 shadow-soft" aria-label="PPT 页面列表">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div><p className="text-sm font-semibold">PPT 页面</p><p className="mt-0.5 text-xs text-slate-400">限制 {MIN_SLIDES}–{MAX_SLIDES} 页</p></div>
                <button type="button" onClick={addSlide} disabled={draft.slides.length >= MAX_SLIDES} title={draft.slides.length >= MAX_SLIDES ? `最多 ${MAX_SLIDES} 页` : "添加一页"} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-moss/25 text-moss transition hover:bg-[#e6f0e5] disabled:cursor-not-allowed disabled:opacity-40"><Plus size={16} /></button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2 xl:block xl:space-y-2 xl:overflow-visible xl:pb-0">
                {draft.slides.map((slide, index) => (
                  <button key={slide.id} type="button" onClick={() => setSelectedSlideId(slide.id)} title={`编辑第 ${index + 1} 页：${slide.title}`} aria-current={slide.id === selectedSlideId ? "page" : undefined} className={`w-44 shrink-0 rounded-xl border p-2 text-left transition xl:w-full ${slide.id === selectedSlideId ? "border-moss bg-[#e6f0e5]" : "border-line bg-paper/60 hover:border-moss/50"}`}>
                    <div className="aspect-video rounded-lg border border-line bg-white p-2 shadow-sm">
                      <div className="text-[9px] font-semibold text-coral">{SLIDE_KIND_LABELS[slide.kind]}</div>
                      <div className="mt-1 line-clamp-2 text-[10px] font-semibold leading-4 text-ink">{slide.title || "未命名页面"}</div>
                      <div className="mt-1 line-clamp-2 text-[8px] leading-3 text-slate-400">{slide.body.join(" ")}</div>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs"><span className="font-semibold">{index + 1}</span><span className="max-w-[115px] truncate text-slate-400">{slide.title}</span></div>
                  </button>
                ))}
              </div>
            </aside>

            <section className="min-w-0 rounded-2xl border border-line bg-[#edf1e9] p-3 shadow-inner md:p-6" aria-label="当前幻灯片预览">
              {selectedSlide ? (
                <div className="mx-auto flex h-full max-w-5xl items-center justify-center">
                  <article className="relative aspect-video w-full overflow-hidden rounded-md border border-line bg-white shadow-[0_24px_70px_rgba(45,61,53,0.16)]">
                    <div className="absolute inset-x-0 top-0 h-2 bg-moss" />
                    <div className="absolute right-7 top-6 text-xs font-semibold uppercase tracking-[0.16em] text-moss/60">{draft.level} · {SLIDE_KIND_LABELS[selectedSlide.kind]}</div>
                    <div className="flex h-full flex-col px-[7%] pb-[6%] pt-[9%]">
                      <h3 className="max-w-[82%] font-display text-[clamp(1.35rem,3.2vw,3rem)] leading-tight text-ink">{selectedSlide.title || "未命名页面"}</h3>
                      <div className="mt-[5%] min-h-0 flex-1 space-y-[2.5%] overflow-hidden text-[clamp(0.72rem,1.55vw,1.25rem)] leading-relaxed text-slate-600">
                        {selectedSlide.body.length ? selectedSlide.body.map((line, index) => (
                          <div key={`${index}-${line}`} className="flex gap-3"><span className="mt-[0.65em] h-1.5 w-1.5 shrink-0 rounded-full bg-coral" /><p>{line}</p></div>
                        )) : <p className="text-slate-300">在右侧添加页面内容</p>}
                      </div>
                    </div>
                    <span className="absolute bottom-4 right-5 text-xs text-slate-300">{selectedIndex + 1} / {draft.slides.length}</span>
                  </article>
                </div>
              ) : <p className="py-20 text-center text-sm text-slate-400">暂无可编辑页面</p>}
            </section>

            <aside className="rounded-2xl border border-line bg-white p-4 shadow-soft" aria-label="当前页面编辑器">
              {selectedSlide && <div className="space-y-5">
                <div className="flex items-center justify-between gap-2"><div><p className="text-sm font-semibold">编辑第 {selectedIndex + 1} 页</p><p className="mt-0.5 text-xs text-slate-400">修改会立即反映在预览中</p></div><span className="rounded-full bg-[#fff0e9] px-2.5 py-1 text-xs font-semibold text-coral">{SLIDE_KIND_LABELS[selectedSlide.kind]}</span></div>
                <label className="block text-sm font-medium">页面标题<textarea value={selectedSlide.title} onChange={(event) => updateSelectedSlide({ title: event.target.value })} rows={2} className="mt-2 w-full resize-y rounded-xl border border-line bg-paper p-3 text-sm leading-6 outline-none transition focus:border-moss focus:ring-4 focus:ring-moss/10" /></label>
                <label className="block text-sm font-medium">页面正文<span className="mt-1 block text-xs font-normal text-slate-400">每行会显示为一个内容要点</span><textarea value={selectedSlide.body.join("\n")} onChange={(event) => updateSelectedSlide({ body: event.target.value.split("\n") })} rows={10} className="mt-2 w-full resize-y rounded-xl border border-line bg-paper p-3 text-sm leading-6 outline-none transition focus:border-moss focus:ring-4 focus:ring-moss/10" /></label>
                <div className="grid grid-cols-2 gap-2 border-t border-line pt-4">
                  <StudioButton label="上移" title="将当前页向前移动" icon={<ArrowUp size={15} />} onClick={() => moveSelectedSlide(-1)} />
                  <StudioButton label="下移" title="将当前页向后移动" icon={<ArrowDown size={15} />} onClick={() => moveSelectedSlide(1)} />
                  <StudioButton label="复制" title={draft.slides.length >= MAX_SLIDES ? `最多 ${MAX_SLIDES} 页` : "复制当前页"} icon={<Copy size={15} />} onClick={duplicateSelectedSlide} muted={draft.slides.length >= MAX_SLIDES} />
                  <StudioButton label="删除" title={draft.slides.length <= MIN_SLIDES ? `至少 ${MIN_SLIDES} 页` : "删除当前页"} icon={<Trash2 size={15} />} onClick={deleteSelectedSlide} danger muted={draft.slides.length <= MIN_SLIDES} />
                </div>
              </div>}
            </aside>
          </div>
        ) : (
          <div id="materials-worksheet-panel" role="tabpanel" aria-labelledby="materials-worksheet-tab">
            <WorksheetEditor draft={draft} onChange={updateDraft} />
          </div>
        )}
      </main>
    </div>
  );
}

function ExportButton({ kind, label, icon, exporting, onClick }: { kind: ExportKind; label: string; icon: ReactNode; exporting: ExportKind | null; onClick: (kind: ExportKind) => void }) {
  const active = exporting === kind;
  return <button type="button" onClick={() => onClick(kind)} disabled={exporting !== null} title={label} aria-busy={active} className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2.5 text-xs font-semibold text-ink transition hover:border-moss hover:text-moss disabled:cursor-wait disabled:opacity-50">{active ? <LoaderCircle size={15} className="animate-spin" /> : icon}{active ? "生成中…" : label}</button>;
}

function StudioButton({ label, title, icon, onClick, danger = false, muted = false }: { label: string; title: string; icon: ReactNode; onClick: () => void; danger?: boolean; muted?: boolean }) {
  return <button type="button" onClick={onClick} title={title} disabled={muted} className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "border-red-200 text-red-600 hover:bg-red-50" : "border-line text-ink hover:border-moss hover:text-moss"}`}>{icon}{label}</button>;
}

function WorksheetEditor({ draft, onChange }: { draft: MaterialDraft; onChange: (updater: (current: MaterialDraft) => MaterialDraft, message?: string) => void }) {
  function updateWorksheet(patch: Partial<MaterialDraft["worksheet"]>) {
    onChange((current) => ({ ...current, worksheet: { ...current.worksheet, ...patch } }));
  }

  function updateQuestion(questionId: string, patch: Partial<MaterialDraft["worksheet"]["questions"][number]>) {
    onChange((current) => ({
      ...current,
      worksheet: {
        ...current.worksheet,
        questions: current.worksheet.questions.map((question) => question.id === questionId ? { ...question, ...patch } : question),
      },
    }));
  }

  return <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
    <section className="rounded-2xl border border-line bg-white p-5 shadow-soft md:p-7">
      <div className="mb-6 flex items-start gap-3 border-b border-line pb-5"><BookOpen size={21} className="mt-1 shrink-0 text-moss" /><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">学生版预览</p><h3 className="mt-1 font-display text-2xl">{draft.worksheet.title || "课后练习"}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{draft.worksheet.instructions}</p></div></div>
      <div className="space-y-5">
        {draft.worksheet.questions.map((question, index) => <article key={question.id} className="rounded-xl border border-line bg-paper/40 p-4"><p className="font-semibold leading-7">{index + 1}. {question.prompt || "未填写题干"}</p>{question.options.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{question.options.map((option, optionIndex) => <div key={`${question.id}-${optionIndex}`} className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-slate-600"><span className="mr-2 font-semibold text-coral">{String.fromCharCode(65 + optionIndex)}</span>{option}</div>)}</div>}</article>)}
      </div>
      {draft.worksheet.homework && <div className="mt-6 rounded-xl border border-moss/20 bg-[#f0f6ee] p-4"><p className="text-sm font-semibold text-moss">课后任务</p><p className="mt-1 text-sm leading-6 text-slate-600">{draft.worksheet.homework}</p></div>}
    </section>

    <aside className="space-y-5 rounded-2xl border border-line bg-white p-4 shadow-soft lg:max-h-[calc(100dvh-190px)] lg:overflow-y-auto" aria-label="练习内容编辑器">
      <div><p className="text-sm font-semibold">编辑课后练习</p><p className="mt-1 text-xs leading-5 text-slate-400">学生版会隐藏答案，教师版会附上答案与追问。</p></div>
      <label className="block text-sm font-medium">练习标题<input value={draft.worksheet.title} onChange={(event) => updateWorksheet({ title: event.target.value })} className="mt-2 w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-moss" /></label>
      <label className="block text-sm font-medium">作答说明<textarea value={draft.worksheet.instructions} onChange={(event) => updateWorksheet({ instructions: event.target.value })} rows={3} className="mt-2 w-full resize-y rounded-xl border border-line bg-paper p-3 text-sm leading-6 outline-none focus:border-moss" /></label>
      <div className="space-y-4 border-t border-line pt-4">
        {draft.worksheet.questions.map((question, index) => <fieldset key={question.id} className="rounded-xl border border-line p-3"><legend className="px-1 text-xs font-semibold text-moss">第 {index + 1} 题</legend>
          <label className="mt-2 block text-xs font-medium">题干<textarea value={question.prompt} onChange={(event) => updateQuestion(question.id, { prompt: event.target.value })} rows={3} className="mt-1.5 w-full resize-y rounded-lg border border-line bg-paper p-2.5 text-sm leading-5 outline-none focus:border-moss" /></label>
          {question.options.map((option, optionIndex) => <label key={`${question.id}-edit-${optionIndex}`} className="mt-2 block text-xs font-medium">选项 {String.fromCharCode(65 + optionIndex)}<input value={option} onChange={(event) => updateQuestion(question.id, { options: question.options.map((item, itemIndex) => itemIndex === optionIndex ? event.target.value : item) })} className="mt-1.5 w-full rounded-lg border border-line bg-paper px-2.5 py-2 text-sm outline-none focus:border-moss" /></label>)}
          <label className="mt-2 block text-xs font-medium">答案<input value={question.answer} onChange={(event) => updateQuestion(question.id, { answer: event.target.value })} className="mt-1.5 w-full rounded-lg border border-line bg-paper px-2.5 py-2 text-sm outline-none focus:border-moss" /></label>
          <label className="mt-2 block text-xs font-medium">追问<textarea value={question.followUp} onChange={(event) => updateQuestion(question.id, { followUp: event.target.value })} rows={2} className="mt-1.5 w-full resize-y rounded-lg border border-line bg-paper p-2.5 text-sm leading-5 outline-none focus:border-moss" /></label>
        </fieldset>)}
      </div>
      <label className="block border-t border-line pt-4 text-sm font-medium">课后任务<textarea value={draft.worksheet.homework} onChange={(event) => updateWorksheet({ homework: event.target.value })} rows={4} className="mt-2 w-full resize-y rounded-xl border border-line bg-paper p-3 text-sm leading-6 outline-none focus:border-moss" /></label>
    </aside>
  </div>;
}
