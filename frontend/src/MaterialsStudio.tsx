import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
  exportLessonToDocx,
  exportWorksheetToDocx,
  MAX_SLIDES,
  MIN_SLIDES,
  validateDeckDraft,
  validateLessonDraft,
  validateWorksheetDraft,
  type DeckDraft,
  type LessonDraft,
  type MaterialDraft,
  type MaterialSource,
  type WorksheetDraft,
} from "./materials";

type StudioTab = "lesson" | "deck" | "worksheet";
type ExportKind = "lesson" | "pptx" | "student" | "teacher";
type DirtyState = Record<StudioTab, boolean>;

const TABS: StudioTab[] = ["lesson", "deck", "worksheet"];
const TAB_LABELS: Record<StudioTab, string> = {
  lesson: "教师详案",
  deck: "学生课件",
  worksheet: "课后练习",
};
const SLIDE_KIND_LABELS: Record<DeckDraft["slides"][number]["kind"], string> = {
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

function splitLines(value: string) {
  return value.split("\n");
}

export function MaterialsStudio({ source, onClose }: { source: MaterialSource; onClose: () => void }) {
  const [draft, setDraft] = useState<MaterialDraft>(() => createMaterialDraft(source));
  const [activeTab, setActiveTab] = useState<StudioTab>("lesson");
  const [selectedSlideId, setSelectedSlideId] = useState(() => draft.deck.slides[0]?.id ?? "");
  const [dirty, setDirty] = useState<DirtyState>({ lesson: false, deck: false, worksheet: false });
  const [feedback, setFeedback] = useState("三类草稿已根据确认方案生成，可以分别微调和导出。");
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState("");
  const [exportSuccess, setExportSuccess] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Record<StudioTab, HTMLButtonElement | null>>({ lesson: null, deck: null, worksheet: null });

  const anyDirty = dirty.lesson || dirty.deck || dirty.worksheet;
  const selectedIndex = useMemo(
    () => Math.max(0, draft.deck.slides.findIndex((slide) => slide.id === selectedSlideId)),
    [draft.deck.slides, selectedSlideId],
  );
  const selectedSlide = draft.deck.slides[selectedIndex];

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
  }, [anyDirty, onClose]);

  function requestClose() {
    if (anyDirty && !window.confirm("关闭后尚未导出的修改将丢失，确定返回吗？")) return;
    onClose();
  }

  function resetNotices(message: string) {
    setFeedback(message);
    setExportError("");
    setExportSuccess("");
  }

  function updateLesson(updater: (current: LessonDraft) => LessonDraft, message = "教师详案修改已保留在当前草稿中。") {
    setDraft((current) => ({ ...current, lesson: updater(current.lesson) }));
    setDirty((current) => ({ ...current, lesson: true }));
    resetNotices(message);
  }

  function updateDeck(updater: (current: DeckDraft) => DeckDraft, message = "学生课件修改已保留在当前草稿中。") {
    setDraft((current) => ({ ...current, deck: updater(current.deck) }));
    setDirty((current) => ({ ...current, deck: true }));
    resetNotices(message);
  }

  function updateWorksheet(updater: (current: WorksheetDraft) => WorksheetDraft, message = "课后练习修改已保留在当前草稿中。") {
    setDraft((current) => ({ ...current, worksheet: updater(current.worksheet) }));
    setDirty((current) => ({ ...current, worksheet: true }));
    resetNotices(message);
  }

  function updateSelectedSlide(patch: Partial<DeckDraft["slides"][number]>) {
    if (!selectedSlide) return;
    updateDeck((current) => ({
      ...current,
      title: selectedSlide.kind === "title" && typeof patch.title === "string" ? patch.title : current.title,
      slides: current.slides.map((slide) => slide.id === selectedSlide.id ? { ...slide, ...patch } : slide),
    }));
  }

  function moveSelectedSlide(direction: -1 | 1) {
    const nextIndex = selectedIndex + direction;
    if (!selectedSlide || nextIndex < 0 || nextIndex >= draft.deck.slides.length) {
      setFeedback(direction < 0 ? "已经是第一页。" : "已经是最后一页。");
      return;
    }
    updateDeck((current) => {
      const slides = [...current.slides];
      [slides[selectedIndex], slides[nextIndex]] = [slides[nextIndex], slides[selectedIndex]];
      return { ...current, slides };
    }, `已将第 ${selectedIndex + 1} 页移动到第 ${nextIndex + 1} 页。`);
  }

  function duplicateSelectedSlide() {
    if (!selectedSlide) return;
    if (draft.deck.slides.length >= MAX_SLIDES) {
      setFeedback(`PPT 最多 ${MAX_SLIDES} 页，请先删除一页再复制。`);
      return;
    }
    const copy = { ...selectedSlide, id: newId("slide"), title: `${selectedSlide.title}（副本）`, body: [...selectedSlide.body] };
    updateDeck((current) => ({
      ...current,
      slides: [...current.slides.slice(0, selectedIndex + 1), copy, ...current.slides.slice(selectedIndex + 1)],
    }), `已复制第 ${selectedIndex + 1} 页。`);
    setSelectedSlideId(copy.id);
  }

  function deleteSelectedSlide() {
    if (!selectedSlide) return;
    if (draft.deck.slides.length <= MIN_SLIDES) {
      setFeedback(`PPT 至少保留 ${MIN_SLIDES} 页，当前页不能删除。`);
      return;
    }
    const nextSelection = draft.deck.slides[selectedIndex + 1]?.id ?? draft.deck.slides[selectedIndex - 1]?.id ?? "";
    updateDeck((current) => ({ ...current, slides: current.slides.filter((slide) => slide.id !== selectedSlide.id) }), `已删除第 ${selectedIndex + 1} 页。`);
    setSelectedSlideId(nextSelection);
  }

  function addSlide() {
    if (draft.deck.slides.length >= MAX_SLIDES) {
      setFeedback(`PPT 最多 ${MAX_SLIDES} 页，请先删除一页再添加。`);
      return;
    }
    const slide: DeckDraft["slides"][number] = {
      id: newId("slide"),
      kind: "interaction",
      title: "新增课堂互动",
      body: ["在这里填写学生可以直接看到并执行的课堂内容。"],
    };
    updateDeck((current) => ({ ...current, slides: [...current.slides, slide] }), `已添加第 ${draft.deck.slides.length + 1} 页。`);
    setSelectedSlideId(slide.id);
  }

  async function handleExport(kind: ExportKind) {
    if (exporting) return;
    const tab: StudioTab = kind === "lesson" ? "lesson" : kind === "pptx" ? "deck" : "worksheet";
    const errors = tab === "lesson"
      ? validateLessonDraft(draft.lesson)
      : tab === "deck"
        ? validateDeckDraft(draft.deck)
        : validateWorksheetDraft(draft.worksheet);
    if (errors.length) {
      setExportError(errors.join("；"));
      setExportSuccess("");
      return;
    }
    setExporting(kind);
    setExportError("");
    setExportSuccess("");
    try {
      if (kind === "lesson") await exportLessonToDocx(draft.lesson);
      else if (kind === "pptx") await exportDeckToPptx(draft.deck);
      else await exportWorksheetToDocx(draft.worksheet, kind === "teacher");
      const success = kind === "lesson"
        ? "教师详案已开始下载。"
        : kind === "pptx"
          ? "学生课件已开始下载。"
          : kind === "student"
            ? "学生版练习已开始下载。"
            : "教师答案版已开始下载。";
      setExportSuccess(success);
      setFeedback("下载完成后仍可继续微调当前草稿。");
      setDirty((current) => ({ ...current, [tab]: false }));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出失败，请稍后重试。");
    } finally {
      setExporting(null);
    }
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: StudioTab) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    let nextTab: StudioTab;
    if (event.key === "Home") nextTab = TABS[0];
    else if (event.key === "End") nextTab = TABS[TABS.length - 1];
    else {
      const offset = event.key === "ArrowRight" ? 1 : -1;
      nextTab = TABS[(TABS.indexOf(currentTab) + offset + TABS.length) % TABS.length];
    }
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  const title = activeTab === "lesson" ? draft.lesson.title : activeTab === "deck" ? draft.deck.title : draft.worksheet.title;

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 flex-col bg-paper text-ink" role="dialog" aria-modal="true" aria-labelledby="materials-studio-title">
      <header className="shrink-0 border-b border-line bg-white/95 px-4 py-3 shadow-sm backdrop-blur md:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={requestClose} title="返回备课方案" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink transition hover:border-moss hover:text-moss"><ArrowLeft size={18} /></button>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-moss">04 / 课堂材料工作台 V2</p>
              <h2 id="materials-studio-title" ref={headingRef} tabIndex={-1} className="truncate font-display text-xl outline-none md:text-2xl">{title || "课堂材料"}</h2>
            </div>
            {dirty[activeTab] && <span className="hidden rounded-full bg-[#fff0e9] px-3 py-1.5 text-xs font-semibold text-coral sm:inline-flex">有未导出修改</span>}
          </div>
          <div className="flex max-w-full gap-2 overflow-x-auto pb-1 xl:justify-end xl:pb-0">
            {activeTab === "lesson" && <ExportButton kind="lesson" label="下载教师详案" icon={<Download size={15} />} exporting={exporting} onClick={handleExport} />}
            {activeTab === "deck" && <ExportButton kind="pptx" label="下载学生 PPT" icon={<MonitorPlay size={15} />} exporting={exporting} onClick={handleExport} />}
            {activeTab === "worksheet" && <>
              <ExportButton kind="student" label="学生版练习" icon={<FileText size={15} />} exporting={exporting} onClick={handleExport} />
              <ExportButton kind="teacher" label="教师答案版" icon={<Download size={15} />} exporting={exporting} onClick={handleExport} />
            </>}
          </div>
        </div>
        <div className="mx-auto mt-2 max-w-[1600px] text-xs" aria-live="polite" aria-atomic="true">
          {exportError ? <p role="alert" className="text-coral">{exportError}</p> : exportSuccess ? <p className="inline-flex items-center gap-1.5 text-moss"><CheckCircle2 size={14} />{exportSuccess}</p> : exporting ? <p className="inline-flex items-center gap-1.5 text-moss"><LoaderCircle size={14} className="animate-spin" />正在生成下载文件，请稍候…</p> : <p className="text-slate-400">{feedback}</p>}
        </div>
      </header>

      <nav className="shrink-0 border-b border-line bg-white px-4 md:px-6" aria-label="课堂材料产品">
        <div className="mx-auto flex max-w-[1600px] gap-1" role="tablist">
          {TABS.map((tab) => <button
            key={tab}
            id={`materials-${tab}-tab`}
            ref={(node) => { tabRefs.current[tab] = node; }}
            type="button"
            role="tab"
            aria-controls={`materials-${tab}-panel`}
            aria-selected={activeTab === tab}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, tab)}
            className={`border-b-2 px-4 py-3 text-sm font-semibold transition ${activeTab === tab ? "border-coral text-ink" : "border-transparent text-slate-400 hover:text-ink"}`}
          >{TAB_LABELS[tab]}{dirty[tab] && <span className="ml-1 text-coral" aria-label="有未导出修改">•</span>}</button>)}
        </div>
      </nav>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {activeTab === "lesson" && <div id="materials-lesson-panel" role="tabpanel" aria-labelledby="materials-lesson-tab"><LessonEditor draft={draft.lesson} onChange={updateLesson} /></div>}
        {activeTab === "deck" && <div id="materials-deck-panel" role="tabpanel" aria-labelledby="materials-deck-tab"><DeckEditor draft={draft.deck} selectedSlideId={selectedSlideId} selectedSlide={selectedSlide} selectedIndex={selectedIndex} onSelect={setSelectedSlideId} onUpdate={updateSelectedSlide} onAdd={addSlide} onMove={moveSelectedSlide} onCopy={duplicateSelectedSlide} onDelete={deleteSelectedSlide} /></div>}
        {activeTab === "worksheet" && <div id="materials-worksheet-panel" role="tabpanel" aria-labelledby="materials-worksheet-tab"><WorksheetEditor draft={draft.worksheet} onChange={updateWorksheet} /></div>}
      </main>
    </div>
  );
}

function LessonEditor({ draft, onChange }: { draft: LessonDraft; onChange: (updater: (current: LessonDraft) => LessonDraft, message?: string) => void }) {
  const patchLesson = (patch: Partial<LessonDraft>) => onChange((current) => ({ ...current, ...patch }));
  const patchStage = (id: string, patch: Partial<LessonDraft["stages"][number]>) => onChange((current) => ({ ...current, stages: current.stages.map((stage) => stage.id === id ? { ...stage, ...patch } : stage) }));
  const patchVocabulary = (index: number, patch: Partial<LessonDraft["vocabulary"][number]>) => onChange((current) => ({ ...current, vocabulary: current.vocabulary.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));

  return <div className="mx-auto grid max-w-[1500px] gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
    <section className="rounded-2xl border border-line bg-white p-5 shadow-soft md:p-8" aria-label="教师详案预览">
      <div className="border-b border-line pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">教师详案预览 · {draft.level}</p>
        <h3 className="mt-2 font-display text-3xl">{draft.title || "未命名教案"}</h3>
        <div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-[#e6f0e5] px-3 py-1.5 font-semibold text-moss">{draft.totalMinutes} 分钟</span><span className="rounded-full bg-paper px-3 py-1.5 text-slate-500">五阶段固定流程</span></div>
        <PreviewList title="教学目标" items={draft.objectives} />
      </div>
      <div className="mt-6 space-y-5">
        <article className="rounded-xl border border-line bg-paper/40 p-4">
          <h4 className="font-display text-xl">{draft.rewrittenTitle || "分级阅读"}</h4>
          <div className="mt-3 space-y-2 text-sm leading-7 text-slate-600">{draft.rewrittenSentences.map((sentence, index) => <p key={`${index}-${sentence}`}>{sentence}</p>)}</div>
        </article>
        {draft.vocabulary.length > 0 && <article><h4 className="text-sm font-semibold text-moss">核心词汇</h4><div className="mt-3 grid gap-3 md:grid-cols-2">{draft.vocabulary.map((item, index) => <div key={`${item.word}-${index}`} className="rounded-xl border border-line p-3"><p className="font-semibold">{item.word} <span className="text-xs font-normal text-slate-400">{item.pos}</span></p><p className="mt-1 text-sm text-slate-600">{item.meaning}</p>{item.example && <p className="mt-1 text-xs leading-5 text-slate-400">例：{item.example}</p>}</div>)}</div></article>}
        <div className="space-y-4">{draft.stages.map((stage, index) => <article key={stage.id} className="rounded-xl border border-line p-4">
          <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-coral">阶段 {index + 1} · {stage.startMinute}–{stage.endMinute} 分钟</p><h4 className="mt-1 font-display text-xl">{stage.title}</h4></div><span className="shrink-0 rounded-full bg-paper px-2.5 py-1 text-xs text-slate-500">{stage.duration} 分钟</span></div>
          <p className="mt-3 text-sm leading-6 text-slate-600"><strong className="text-ink">目标：</strong>{stage.objective}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2"><PreviewList title="教师行动" items={stage.teacherActions} /><PreviewList title="学生活动" items={stage.studentActions} /><PreviewList title="学生提示语" items={stage.prompts} /><PreviewList title="使用材料" items={stage.materials} /></div>
          <p className="mt-3 rounded-lg bg-[#f0f6ee] px-3 py-2 text-sm leading-6 text-moss"><strong>可见产出：</strong>{stage.expectedOutput}</p>
        </article>)}</div>
        <article className="rounded-xl border border-moss/20 bg-[#f0f6ee] p-4"><h4 className="text-sm font-semibold text-moss">课后任务</h4><p className="mt-2 text-sm leading-6 text-slate-600">{draft.homework}</p></article>
        {draft.teacherNotes && <article className="rounded-xl border border-line bg-paper/40 p-4"><h4 className="text-sm font-semibold">教师备注</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{draft.teacherNotes}</p></article>}
      </div>
    </section>

    <aside className="space-y-5 rounded-2xl border border-line bg-white p-4 shadow-soft xl:max-h-[calc(100dvh-190px)] xl:overflow-y-auto" aria-label="教师详案编辑器">
      <div><p className="text-sm font-semibold">编辑教师详案</p><p className="mt-1 text-xs leading-5 text-slate-400">阶段与时间轴保持固定；逐行填写的内容会导出为项目列表。</p></div>
      <TextInput label="教案标题" value={draft.title} onChange={(value) => patchLesson({ title: value })} />
      <LinesInput label="教学目标" value={draft.objectives} onChange={(value) => patchLesson({ objectives: value })} rows={4} />
      <TextInput label="阅读标题" value={draft.rewrittenTitle} onChange={(value) => patchLesson({ rewrittenTitle: value })} />
      <LinesInput label="改写课文" value={draft.rewrittenSentences} onChange={(value) => patchLesson({ rewrittenSentences: value })} rows={8} />
      {draft.vocabulary.length > 0 && <div className="space-y-3 border-t border-line pt-4"><p className="text-sm font-semibold">核心词汇</p>{draft.vocabulary.map((item, index) => <fieldset key={`${item.word}-${index}`} className="rounded-xl border border-line p-3"><legend className="px-1 text-xs font-semibold text-moss">词汇 {index + 1}</legend>
        <div className="mt-2 grid grid-cols-2 gap-2"><CompactInput label="词语" value={item.word} onChange={(value) => patchVocabulary(index, { word: value })} /><CompactInput label="词性" value={item.pos} onChange={(value) => patchVocabulary(index, { pos: value })} /></div>
        <CompactInput label="释义" value={item.meaning} onChange={(value) => patchVocabulary(index, { meaning: value })} />
        <CompactInput label="例句" value={item.example} onChange={(value) => patchVocabulary(index, { example: value })} />
        <CompactInput label="易错点" value={item.pitfall} onChange={(value) => patchVocabulary(index, { pitfall: value })} />
        <CompactInput label="汉越词" value={item.sinoViet} onChange={(value) => patchVocabulary(index, { sinoViet: value })} />
      </fieldset>)}</div>}
      <div className="space-y-4 border-t border-line pt-4">{draft.stages.map((stage, index) => <fieldset key={stage.id} className="rounded-xl border border-line p-3"><legend className="px-1 text-xs font-semibold text-coral">阶段 {index + 1} · {stage.startMinute}–{stage.endMinute} 分钟</legend>
        <TextInput label="阶段标题" value={stage.title} onChange={(value) => patchStage(stage.id, { title: value })} compact />
        <TextArea label="阶段目标" value={stage.objective} onChange={(value) => patchStage(stage.id, { objective: value })} rows={2} compact />
        <LinesInput label="教师行动" value={stage.teacherActions} onChange={(value) => patchStage(stage.id, { teacherActions: value })} rows={3} compact />
        <LinesInput label="学生活动" value={stage.studentActions} onChange={(value) => patchStage(stage.id, { studentActions: value })} rows={3} compact />
        <LinesInput label="学生提示语" value={stage.prompts} onChange={(value) => patchStage(stage.id, { prompts: value })} rows={3} compact />
        <LinesInput label="使用材料" value={stage.materials} onChange={(value) => patchStage(stage.id, { materials: value })} rows={2} compact />
        <TextArea label="可见产出" value={stage.expectedOutput} onChange={(value) => patchStage(stage.id, { expectedOutput: value })} rows={2} compact />
      </fieldset>)}</div>
      <TextArea label="课后任务" value={draft.homework} onChange={(value) => patchLesson({ homework: value })} rows={4} />
      <TextArea label="教师备注" value={draft.teacherNotes} onChange={(value) => patchLesson({ teacherNotes: value })} rows={4} />
    </aside>
  </div>;
}

function PreviewList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="mt-3"><p className="text-xs font-semibold text-moss">{title}</p><ul className="mt-1 space-y-1 text-sm leading-6 text-slate-600">{items.map((item, index) => <li key={`${index}-${item}`} className="flex gap-2"><span className="text-coral">•</span><span>{item}</span></li>)}</ul></div>;
}

function DeckEditor({ draft, selectedSlideId, selectedSlide, selectedIndex, onSelect, onUpdate, onAdd, onMove, onCopy, onDelete }: {
  draft: DeckDraft;
  selectedSlideId: string;
  selectedSlide: DeckDraft["slides"][number] | undefined;
  selectedIndex: number;
  onSelect: (id: string) => void;
  onUpdate: (patch: Partial<DeckDraft["slides"][number]>) => void;
  onAdd: () => void;
  onMove: (direction: -1 | 1) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  return <div className="mx-auto grid max-w-[1600px] gap-4 xl:min-h-full xl:grid-cols-[220px_minmax(0,1fr)_320px]">
    <aside className="min-w-0 rounded-2xl border border-line bg-white p-3 shadow-soft" aria-label="PPT 页面列表">
      <div className="mb-3 flex items-center justify-between gap-2"><div><p className="text-sm font-semibold">PPT 页面</p><p className="mt-0.5 text-xs text-slate-400">限制 {MIN_SLIDES}–{MAX_SLIDES} 页</p></div><button type="button" onClick={onAdd} disabled={draft.slides.length >= MAX_SLIDES} title={draft.slides.length >= MAX_SLIDES ? `最多 ${MAX_SLIDES} 页` : "添加一页"} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-moss/25 text-moss transition hover:bg-[#e6f0e5] disabled:cursor-not-allowed disabled:opacity-40"><Plus size={16} /></button></div>
      <div className="flex gap-2 overflow-x-auto pb-2 xl:block xl:space-y-2 xl:overflow-visible xl:pb-0">{draft.slides.map((slide, index) => <button key={slide.id} type="button" onClick={() => onSelect(slide.id)} title={`编辑第 ${index + 1} 页：${slide.title}`} aria-current={slide.id === selectedSlideId ? "page" : undefined} className={`w-44 shrink-0 rounded-xl border p-2 text-left transition xl:w-full ${slide.id === selectedSlideId ? "border-moss bg-[#e6f0e5]" : "border-line bg-paper/60 hover:border-moss/50"}`}>
        <div className="aspect-video rounded-lg border border-line bg-white p-2 shadow-sm"><div className="text-[9px] font-semibold text-coral">{SLIDE_KIND_LABELS[slide.kind]}</div><div className="mt-1 line-clamp-2 text-[10px] font-semibold leading-4 text-ink">{slide.title || "未命名页面"}</div><div className="mt-1 line-clamp-2 text-[8px] leading-3 text-slate-400">{slide.body.join(" ")}</div></div><div className="mt-1.5 flex items-center justify-between text-xs"><span className="font-semibold">{index + 1}</span><span className="max-w-[115px] truncate text-slate-400">{slide.title}</span></div>
      </button>)}</div>
    </aside>
    <section className="min-w-0 rounded-2xl border border-line bg-[#edf1e9] p-3 shadow-inner md:p-6" aria-label="当前幻灯片预览">
      {selectedSlide ? <div className="mx-auto flex h-full max-w-5xl items-center justify-center"><article className="relative aspect-video w-full overflow-hidden rounded-md border border-line bg-white shadow-[0_24px_70px_rgba(45,61,53,0.16)]"><div className="absolute inset-x-0 top-0 h-2 bg-moss" /><div className="absolute right-7 top-6 text-xs font-semibold uppercase tracking-[0.16em] text-moss/60">{draft.level} · {SLIDE_KIND_LABELS[selectedSlide.kind]}</div><div className="flex h-full flex-col px-[7%] pb-[6%] pt-[9%]"><h3 className="max-w-[82%] font-display text-[clamp(1.35rem,3.2vw,3rem)] leading-tight text-ink">{selectedSlide.title || "未命名页面"}</h3><div className="mt-[5%] min-h-0 flex-1 space-y-[2.5%] overflow-hidden text-[clamp(0.72rem,1.55vw,1.25rem)] leading-relaxed text-slate-600">{selectedSlide.body.length ? selectedSlide.body.map((line, index) => <div key={`${index}-${line}`} className="flex gap-3"><span className="mt-[0.65em] h-1.5 w-1.5 shrink-0 rounded-full bg-coral" /><p>{line}</p></div>) : <p className="text-slate-300">在右侧添加页面内容</p>}</div></div><span className="absolute bottom-4 right-5 text-xs text-slate-300">{selectedIndex + 1} / {draft.slides.length}</span></article></div> : <p className="py-20 text-center text-sm text-slate-400">暂无可编辑页面</p>}
    </section>
    <aside className="rounded-2xl border border-line bg-white p-4 shadow-soft" aria-label="当前页面编辑器">{selectedSlide && <div className="space-y-5">
      <div className="flex items-center justify-between gap-2"><div><p className="text-sm font-semibold">编辑第 {selectedIndex + 1} 页</p><p className="mt-0.5 text-xs text-slate-400">修改会立即反映在预览中</p></div><span className="rounded-full bg-[#fff0e9] px-2.5 py-1 text-xs font-semibold text-coral">{SLIDE_KIND_LABELS[selectedSlide.kind]}</span></div>
      <TextArea label="页面标题" value={selectedSlide.title} onChange={(value) => onUpdate({ title: value })} rows={2} />
      <LinesInput label="页面正文" hint="每行会显示为一个内容要点" value={selectedSlide.body} onChange={(value) => onUpdate({ body: value })} rows={10} />
      <div className="grid grid-cols-2 gap-2 border-t border-line pt-4"><StudioButton label="上移" title="将当前页向前移动" icon={<ArrowUp size={15} />} onClick={() => onMove(-1)} /><StudioButton label="下移" title="将当前页向后移动" icon={<ArrowDown size={15} />} onClick={() => onMove(1)} /><StudioButton label="复制" title={draft.slides.length >= MAX_SLIDES ? `最多 ${MAX_SLIDES} 页` : "复制当前页"} icon={<Copy size={15} />} onClick={onCopy} muted={draft.slides.length >= MAX_SLIDES} /><StudioButton label="删除" title={draft.slides.length <= MIN_SLIDES ? `至少 ${MIN_SLIDES} 页` : "删除当前页"} icon={<Trash2 size={15} />} onClick={onDelete} danger muted={draft.slides.length <= MIN_SLIDES} /></div>
    </div>}</aside>
  </div>;
}

function WorksheetEditor({ draft, onChange }: { draft: WorksheetDraft; onChange: (updater: (current: WorksheetDraft) => WorksheetDraft, message?: string) => void }) {
  const patchWorksheet = (patch: Partial<WorksheetDraft>) => onChange((current) => ({ ...current, ...patch }));
  const patchQuestion = (questionId: string, patch: Partial<WorksheetDraft["questions"][number]>) => onChange((current) => ({ ...current, questions: current.questions.map((question) => question.id === questionId ? { ...question, ...patch } : question) }));
  return <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
    <section className="rounded-2xl border border-line bg-white p-5 shadow-soft md:p-7">
      <div className="mb-6 flex items-start gap-3 border-b border-line pb-5"><BookOpen size={21} className="mt-1 shrink-0 text-moss" /><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-moss">学生版预览 · {draft.level}</p><h3 className="mt-1 font-display text-2xl">{draft.title || "课后练习"}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{draft.instructions}</p></div></div>
      <div className="space-y-5">{draft.questions.map((question, index) => <article key={question.id} className="rounded-xl border border-line bg-paper/40 p-4"><p className="font-semibold leading-7">{index + 1}. {question.prompt || "未填写题干"}</p>{question.options.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{question.options.map((option, optionIndex) => <div key={`${question.id}-${optionIndex}`} className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-slate-600"><span className="mr-2 font-semibold text-coral">{String.fromCharCode(65 + optionIndex)}</span>{option}</div>)}</div>}</article>)}</div>
      {draft.homework && <div className="mt-6 rounded-xl border border-moss/20 bg-[#f0f6ee] p-4"><p className="text-sm font-semibold text-moss">课后任务</p><p className="mt-1 text-sm leading-6 text-slate-600">{draft.homework}</p></div>}
    </section>
    <aside className="space-y-5 rounded-2xl border border-line bg-white p-4 shadow-soft lg:max-h-[calc(100dvh-190px)] lg:overflow-y-auto" aria-label="练习内容编辑器">
      <div><p className="text-sm font-semibold">编辑课后练习</p><p className="mt-1 text-xs leading-5 text-slate-400">题目数量与题型固定；学生版隐藏答案，教师版附答案与追问。</p></div>
      <TextInput label="练习标题" value={draft.title} onChange={(value) => patchWorksheet({ title: value })} />
      <TextArea label="作答说明" value={draft.instructions} onChange={(value) => patchWorksheet({ instructions: value })} rows={3} />
      <div className="space-y-4 border-t border-line pt-4">{draft.questions.map((question, index) => <fieldset key={question.id} className="rounded-xl border border-line p-3"><legend className="px-1 text-xs font-semibold text-moss">第 {index + 1} 题 · {question.type || "固定题型"}</legend>
        <TextArea label="题干" value={question.prompt} onChange={(value) => patchQuestion(question.id, { prompt: value })} rows={3} compact />
        {question.options.map((option, optionIndex) => <CompactInput key={`${question.id}-edit-${optionIndex}`} label={`选项 ${String.fromCharCode(65 + optionIndex)}`} value={option} onChange={(value) => patchQuestion(question.id, { options: question.options.map((item, itemIndex) => itemIndex === optionIndex ? value : item) })} />)}
        <CompactInput label="答案" value={question.answer} onChange={(value) => patchQuestion(question.id, { answer: value })} />
        <TextArea label="追问" value={question.followUp} onChange={(value) => patchQuestion(question.id, { followUp: value })} rows={2} compact />
      </fieldset>)}</div>
      <TextArea label="课后任务" value={draft.homework} onChange={(value) => patchWorksheet({ homework: value })} rows={4} />
    </aside>
  </div>;
}

function TextInput({ label, value, onChange, compact = false }: { label: string; value: string; onChange: (value: string) => void; compact?: boolean }) {
  return <label className={`block font-medium ${compact ? "mt-2 text-xs" : "text-sm"}`}>{label}<input value={value} onChange={(event) => onChange(event.target.value)} className={`${compact ? "mt-1.5 rounded-lg px-2.5 py-2" : "mt-2 rounded-xl px-3 py-2.5"} w-full border border-line bg-paper text-sm outline-none transition focus:border-moss focus:ring-4 focus:ring-moss/10`} /></label>;
}

function CompactInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <TextInput label={label} value={value} onChange={onChange} compact />;
}

function TextArea({ label, value, onChange, rows, compact = false, hint }: { label: string; value: string; onChange: (value: string) => void; rows: number; compact?: boolean; hint?: string }) {
  return <label className={`block font-medium ${compact ? "mt-2 text-xs" : "text-sm"}`}>{label}{hint && <span className="mt-1 block text-xs font-normal text-slate-400">{hint}</span>}<textarea value={value} onChange={(event) => onChange(event.target.value)} rows={rows} className={`${compact ? "mt-1.5 rounded-lg p-2.5 leading-5" : "mt-2 rounded-xl p-3 leading-6"} w-full resize-y border border-line bg-paper text-sm outline-none transition focus:border-moss focus:ring-4 focus:ring-moss/10`} /></label>;
}

function LinesInput({ label, value, onChange, rows, compact = false, hint }: { label: string; value: string[]; onChange: (value: string[]) => void; rows: number; compact?: boolean; hint?: string }) {
  return <TextArea label={label} value={value.join("\n")} onChange={(next) => onChange(splitLines(next))} rows={rows} compact={compact} hint={hint ?? "每行一项"} />;
}

function ExportButton({ kind, label, icon, exporting, onClick }: { kind: ExportKind; label: string; icon: ReactNode; exporting: ExportKind | null; onClick: (kind: ExportKind) => void }) {
  const active = exporting === kind;
  return <button type="button" onClick={() => onClick(kind)} disabled={exporting !== null} title={label} aria-busy={active} className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2.5 text-xs font-semibold text-ink transition hover:border-moss hover:text-moss disabled:cursor-wait disabled:opacity-50">{active ? <LoaderCircle size={15} className="animate-spin" /> : icon}{active ? "生成中…" : label}</button>;
}

function StudioButton({ label, title, icon, onClick, danger = false, muted = false }: { label: string; title: string; icon: ReactNode; onClick: () => void; danger?: boolean; muted?: boolean }) {
  return <button type="button" onClick={onClick} title={title} disabled={muted} className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "border-red-200 text-red-600 hover:bg-red-50" : "border-line text-ink hover:border-moss hover:text-moss"}`}>{icon}{label}</button>;
}
