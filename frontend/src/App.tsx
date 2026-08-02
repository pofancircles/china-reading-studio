import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Clipboard,
  Copy,
  FileText,
  GraduationCap,
  LockKeyhole,
  LoaderCircle,
  MessageCircle,
  PlugZap,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  UserRound,
  UsersRound,
  Volume2,
  X,
} from "lucide-react";

type Level = "HSK1" | "HSK2" | "HSK3" | "HSK4";
type NativeLang = "English" | "Vietnamese";
type Tab = "课堂流程" | "对照阅读" | "生词与表达" | "练习题";

type LevelProfile = {
  code: Level;
  rank: number;
  vocab_size: number;
  max_sentence_len: number;
  target_total_len: [number, number];
  max_target_words: number;
  grammar_focus: string[];
  task_focus: string[];
  question_types: string[];
};

type LevelComparison = {
  level: Level;
  known_ratio: number;
  out_of_level_words: number;
  out_of_level_examples: string[];
  max_sentence_len: number;
  target_total_len: [number, number];
  suggested_target_words: string[];
  grammar_focus: string[];
  task_focus: string[];
  question_types: string[];
};

type Analysis = {
  sentences: { id: number; text: string }[];
  topic_word_candidates: { word: string; reason: string; frequency?: number; pos?: string; status?: string; first_level?: string | null; is_compound?: boolean; components?: string[] }[];
  level_comparison: LevelComparison[];
  level_profile: LevelProfile;
  material_distinctiveness: { status: "sufficient" | "low"; known_ratio_spread: number; out_of_level_spread: number };
};

type ModelStatus = {
  configured: boolean;
  provider: string;
  model: string;
  mode: "ai" | "demo";
  access_required?: boolean;
  access_configured?: boolean;
};

type ProbeState = {
  status: "idle" | "loading" | "success" | "error";
  code?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
};

type ProbeResponse = {
  ok: boolean;
  code: string;
  configured: boolean;
  provider: string;
  model: string;
  latency_ms?: number;
};

type Package = {
  rewritten: {
    title: string;
    sentences: { text: string; source_sentence_ids: number[] }[];
    deleted_info: string;
    teacher_notes: string;
  };
  pinyin: { word: string; pinyin: string }[];
  pinyin_sentences: { word: string; pinyin: string }[][];
  vocab: {
    word: string;
    pos: string;
    meaning: string;
    example: string;
    pitfall: string;
    sino_viet: string;
  }[];
  questions: { type: string; q: string; options: string[]; answer: string; follow_up: string }[];
  lesson_plan: {
    title: string;
    total_minutes: number;
    level_task?: string;
    objectives: string[];
    stages: {
      title: string;
      start_minute: number;
      end_minute: number;
      duration: number;
      objective: string;
      teacher_actions: string[];
      student_actions: string[];
      materials: string[];
      prompts: string[];
      expected_output: string;
    }[];
    homework: string;
    available: boolean;
    note?: string;
  };
  quality: {
    in_level_ratio: number;
    compliance_score: number;
    violations: string[];
    sentence_over_length: string[];
    total_length: number;
    target_total_len: [number, number];
    total_length_status: "below_target" | "within_target" | "above_target";
    detected_grammar: string[];
    grammar_violations: string[];
    details?: { has_violations: boolean; has_overlength_sentences: boolean; has_forbidden_grammar?: boolean; status: "ok" | "needs_review" | "unavailable"; source_limited?: boolean; source_difficulty_limited?: boolean; out_of_level_count?: number; level_profile?: LevelProfile };
  };
  meta: {
    demo_mode: boolean;
    generation_mode?: "ai" | "partial" | "demo";
    generation_components?: Record<"rewrite" | "vocab" | "questions" | "lesson_plan", "ai" | "demo" | "unavailable">;
    target_words: string[];
    level: Level;
    native_lang: NativeLang;
    level_profile?: LevelProfile;
    fallback_code?: string;
    fallback_codes?: Record<string, string>;
    fallback_details?: Record<string, string[]>;
    generation_warnings?: Record<string, string[]>;
    ignored_keep_words?: string[];
    auto_keep_words?: string[];
  };
};

type RetryableComponent = "vocab" | "questions" | "lesson_plan";
type GenerationComponent = "rewrite" | RetryableComponent;
type GenerationStepStatus = "waiting" | "loading" | "success" | "failed";

type GenerationProgress = {
  components: Record<GenerationComponent, GenerationStepStatus>;
};

type ComponentResponse = {
  component: RetryableComponent;
  status: "ai" | "unavailable";
  code: string;
  details?: string[];
  warnings?: string[];
  data: Package["vocab"] | Package["questions"] | Package["lesson_plan"] | null;
};

function createGenerationProgress(): GenerationProgress {
  return {
    components: {
      rewrite: "waiting",
      lesson_plan: "waiting",
      vocab: "waiting",
      questions: "waiting",
    },
  };
}

const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");
const SAMPLE =
  "春节快到了，很多在外地工作的人开始安排回家的时间。小林平时工作很忙，但是每年春节都会回到南方的家乡，和家人一起吃饭。对他来说，回家不只是一个假期，也是和家人重新在一起的机会。";

const LEVEL_UI: Record<Level, LevelProfile> = {
  HSK1: { code: "HSK1", rank: 1, vocab_size: 150, max_sentence_len: 8, target_total_len: [80, 140], max_target_words: 4, grammar_focus: ["是 / 有 / 在", "喜欢 / 想"], task_focus: ["识别关键词", "复述事实", "简单问答"], question_types: ["fact", "choice", "repeat"] },
  HSK2: { code: "HSK2", rank: 2, vocab_size: 300, max_sentence_len: 12, target_total_len: [140, 220], max_target_words: 5, grammar_focus: ["因为……所以……", "但是", "已经……"], task_focus: ["按顺序复述", "说明原因", "联系个人经历"], question_types: ["fact", "sequence", "reason"] },
  HSK3: { code: "HSK3", rank: 3, vocab_size: 600, max_sentence_len: 18, target_total_len: [220, 350], max_target_words: 6, grammar_focus: ["虽然……但是……", "如果……就……"], task_focus: ["概括段意", "解释原因", "做简单推断"], question_types: ["fact", "inference", "explain"] },
  HSK4: { code: "HSK4", rank: 4, vocab_size: 1200, max_sentence_len: 25, target_total_len: [350, 550], max_target_words: 8, grammar_focus: ["不仅……而且……", "即使……也……", "观点比较"], task_focus: ["概括观点", "比较信息", "迁移讨论"], question_types: ["fact", "inference", "discussion"] },
};

export default function Home() {
  const [text, setText] = useState(SAMPLE);
  const [level, setLevel] = useState<Level>("HSK2");
  const [nativeLang, setNativeLang] = useState<NativeLang>("English");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [customWords, setCustomWords] = useState<string[]>([]);
  const [customWord, setCustomWord] = useState("");
  const [result, setResult] = useState<Package | null>(null);
  const [tab, setTab] = useState<Tab>("课堂流程");
  const [loading, setLoading] = useState<"analyze" | "generate" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [accessCode, setAccessCode] = useState(() => (
    typeof window === "undefined" ? "" : window.sessionStorage.getItem("china-reading-access-code") ?? ""
  ));
  const [componentLoading, setComponentLoading] = useState<RetryableComponent | null>(null);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress>(createGenerationProgress);

  const wordSet = useMemo(() => new Set(selectedWords), [selectedWords]);
  const candidateWords = useMemo(() => analysis?.topic_word_candidates ?? [], [analysis]);
  const activeProfile = analysis?.level_profile.code === level ? analysis.level_profile : LEVEL_UI[level];

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(""), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (accessCode) window.sessionStorage.setItem("china-reading-access-code", accessCode);
    else window.sessionStorage.removeItem("china-reading-access-code");
  }, [accessCode]);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/model-status`)
      .then((response) => response.json())
      .then((payload: ModelStatus) => active && setModelStatus(payload))
      .catch(() => active && setModelStatus(null));
    return () => { active = false; };
  }, []);

  async function callApi(path: string, body: unknown) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (accessCode.trim()) headers["X-App-Access-Code"] = accessCode.trim();
      const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "请求失败");
      return payload;
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error("无法连接后端。请先运行：python -m uvicorn main:app --port 8000");
      }
      throw err;
    }
  }

  async function handleProbe() {
    setProbe({ status: "loading" });
    try {
      const next = await callApi("/api/model-probe", {}) as ProbeResponse;
      setModelStatus((current) => ({
        configured: next.configured,
        provider: next.provider,
        model: next.model,
        mode: next.configured ? "ai" : "demo",
        access_required: current?.access_required,
        access_configured: current?.access_configured,
      }));
      setProbe({
        status: next.ok ? "success" : "error",
        code: next.code,
        provider: next.provider,
        model: next.model,
        latencyMs: next.latency_ms,
      });
    } catch (err) {
      setProbe({ status: "error", code: "provider_error" });
      if (err instanceof Error) setError(err.message);
    }
  }

  async function handleAnalyze() {
    setError("");
    setLoading("analyze");
    setResult(null);
    try {
      const next = (await callApi("/api/analyze", { text, level })) as Analysis;
      setAnalysis(next);
      setSelectedWords([]);
      setCustomWords([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析失败，请确认后端已启动。");
    } finally {
      setLoading(null);
    }
  }

  function handleTextChange(value: string) {
    setText(value);
    setAnalysis(null);
    setResult(null);
    setSelectedWords([]);
    setCustomWords([]);
  }

  function handleLevelChange(value: Level) {
    setLevel(value);
    setAnalysis(null);
    setResult(null);
    setSelectedWords([]);
    setCustomWords([]);
  }

  async function requestPackageComponent(component: RetryableComponent, base: Package, rewrittenText: string): Promise<ComponentResponse> {
    try {
      return await callApi("/api/generate-component", {
        component,
        rewritten_text: rewrittenText,
        level: base.meta.level,
        native_lang: base.meta.native_lang,
        target_words: base.meta.target_words,
      }) as ComponentResponse;
    } catch {
      return { component, status: "unavailable", code: "provider_error", details: [], data: null };
    }
  }

  async function handleGenerate(options: { focusLesson?: boolean } = {}) {
    setError("");
    setLoading("generate");
    setGenerationProgress({
      components: {
        rewrite: "loading",
        lesson_plan: "waiting",
        vocab: "waiting",
        questions: "waiting",
      },
    });
    try {
      const base = (await callApi("/api/rewrite", {
        text,
        level,
        native_lang: nativeLang,
        keep_words: selectedWords,
      })) as Package;
      if (base.meta.generation_components?.rewrite !== "ai") {
        setGenerationProgress({
          components: {
            rewrite: "failed",
            lesson_plan: "waiting",
            vocab: "waiting",
            questions: "waiting",
          },
        });
        if (result?.meta.generation_components?.rewrite === "ai") {
          setError("本次重新生成没有在时限内完成，已保留上一份成功结果。可稍后再试。")
        } else {
          setResult(base);
        }
        if (options.focusLesson !== false) setTab("对照阅读");
        return;
      }
      const rewrittenText = base.rewritten.sentences.map((sentence) => sentence.text).join("");
      setGenerationProgress({
        components: {
          rewrite: "success",
          lesson_plan: "loading",
          vocab: "waiting",
          questions: "waiting",
        },
      });
      const lessonResponse = await requestPackageComponent("lesson_plan", base, rewrittenText);
      setGenerationProgress((current) => ({
        components: {
          ...current.components,
          lesson_plan: lessonResponse.status === "ai" ? "success" : "failed",
          vocab: "loading",
          questions: "loading",
        },
      }));
      const materialResponses = await Promise.all((["vocab", "questions"] as RetryableComponent[]).map(async (component) => {
        const response = await requestPackageComponent(component, base, rewrittenText);
        setGenerationProgress((current) => ({
          components: {
            ...current.components,
            [component]: response.status === "ai" ? "success" : "failed",
          },
        }));
        return response;
      }));
      const responses = [lessonResponse, ...materialResponses];
      const next: Package = { ...base, meta: { ...base.meta, generation_components: { ...base.meta.generation_components } as NonNullable<Package["meta"]["generation_components"]> } };
      const fallbackCodes = { ...(base.meta.fallback_codes ?? {}) };
      const fallbackDetails = { ...(base.meta.fallback_details ?? {}) };
      const generationWarnings = { ...(base.meta.generation_warnings ?? {}) };
      for (const response of responses) {
        next.meta.generation_components![response.component] = response.status;
        if (response.status === "ai" && response.data) {
          delete fallbackCodes[response.component];
          delete fallbackDetails[response.component];
          if (response.warnings?.length) generationWarnings[response.component] = response.warnings;
          else delete generationWarnings[response.component];
          if (response.component === "vocab") next.vocab = response.data as Package["vocab"];
          if (response.component === "questions") next.questions = response.data as Package["questions"];
          if (response.component === "lesson_plan") next.lesson_plan = response.data as Package["lesson_plan"];
        } else {
          fallbackCodes[response.component] = response.code;
          if (response.details?.length) fallbackDetails[response.component] = response.details;
        }
      }
      const hasFailures = Object.keys(fallbackCodes).length > 0;
      next.meta = {
        ...next.meta,
        generation_mode: hasFailures ? "partial" : "ai",
        demo_mode: false,
        fallback_codes: fallbackCodes,
        fallback_details: fallbackDetails,
        generation_warnings: generationWarnings,
        fallback_code: Object.entries(fallbackCodes).map(([name, code]) => `${name}:${code}`).join(","),
      };
      setResult(next);
      if (options.focusLesson !== false) setTab("课堂流程");
    } catch (err) {
      setGenerationProgress((current) => ({
        components: Object.fromEntries(Object.entries(current.components).map(([name, status]) => [name, status === "loading" ? "failed" : status])) as Record<GenerationComponent, GenerationStepStatus>,
      }));
      setError(err instanceof Error ? err.message : "生成失败，请稍后重试。");
    } finally {
      setLoading(null);
    }
  }

  async function handleRetryComponent(component: RetryableComponent) {
    if (componentLoading || loading === "generate") return;
    if (!result || result.meta.generation_components?.rewrite !== "ai") {
      await handleGenerate({ focusLesson: false });
      return;
    }
    setError("");
    setComponentLoading(component);
    try {
      const next = await callApi("/api/generate-component", {
        component,
        rewritten_text: result.rewritten.sentences.map((sentence) => sentence.text).join(""),
        level: result.meta.level,
        native_lang: result.meta.native_lang,
        target_words: result.meta.target_words,
      }) as ComponentResponse;
      setResult((current) => {
        if (!current) return current;
        const generationComponents = { ...current.meta.generation_components, [component]: next.status } as NonNullable<Package["meta"]["generation_components"]>;
        const fallbackCodes = { ...(current.meta.fallback_codes ?? {}) };
        const fallbackDetails = { ...(current.meta.fallback_details ?? {}) };
        const generationWarnings = { ...(current.meta.generation_warnings ?? {}) };
        if (next.status === "ai") delete fallbackCodes[component];
        else {
          fallbackCodes[component] = next.code;
          if (next.details?.length) fallbackDetails[component] = next.details;
        }
        if (next.status === "ai") delete fallbackDetails[component];
        if (next.status === "ai" && next.warnings?.length) generationWarnings[component] = next.warnings;
        else if (next.status === "ai") delete generationWarnings[component];
        const hasUnavailable = Object.values(generationComponents).some((status) => status === "unavailable");
        const generationMode: "ai" | "partial" | "demo" = generationComponents.rewrite !== "ai" ? "demo" : hasUnavailable ? "partial" : "ai";
        const fallbackCode = Object.entries(fallbackCodes).map(([name, code]) => `${name}:${code}`).join(",");
        const updated: Package = {
          ...current,
          meta: { ...current.meta, generation_components: generationComponents, generation_mode: generationMode, demo_mode: generationMode === "demo", fallback_codes: fallbackCodes, fallback_details: fallbackDetails, generation_warnings: generationWarnings, fallback_code: fallbackCode },
        };
        if (next.status === "ai" && next.data) {
          if (component === "vocab") updated.vocab = next.data as Package["vocab"];
          if (component === "questions") updated.questions = next.data as Package["questions"];
          if (component === "lesson_plan") updated.lesson_plan = next.data as Package["lesson_plan"];
        }
        return updated;
      });
      if (next.status !== "ai") setError(`重试未通过校验：${fallbackMessage(next.code)}${next.details?.length ? ` 具体违规：${next.details.join("；")}` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "组件重试失败，请稍后再试。");
    } finally {
      setComponentLoading(null);
    }
  }

  function toggleWord(word: string) {
    if (!wordSet.has(word) && selectedWords.length >= activeProfile.max_target_words) {
      setError(`${activeProfile.code} 最多保留 ${activeProfile.max_target_words} 个主题词。`);
      return;
    }
    setError("");
    setSelectedWords((current) => (wordSet.has(word) ? current.filter((item) => item !== word) : [...current, word]));
  }

  function addCustomWords() {
    const additions = customWord
      .split(/[，,\s]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 0 && word.length <= 20);
    if (!additions.length) return;
    const existing = new Set([...customWords, ...candidateWords.map((item) => item.word)]);
    const remaining = Math.max(0, activeProfile.max_target_words - selectedWords.length);
    const unique = additions.filter((word) => !existing.has(word)).slice(0, remaining);
    if (!unique.length) {
      setError(`${activeProfile.code} 最多保留 ${activeProfile.max_target_words} 个主题词。`);
      return;
    }
    setCustomWords((current) => [...current, ...unique]);
    setSelectedWords((current) => Array.from(new Set([...current, ...unique])));
    setCustomWord("");
  }

  function removeCustomWord(word: string) {
    setCustomWords((current) => current.filter((item) => item !== word));
    setSelectedWords((current) => current.filter((item) => item !== word));
  }

  async function copyText(label: string, value: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const node = document.createElement("textarea");
        node.value = value;
        node.style.position = "fixed";
        node.style.opacity = "0";
        document.body.appendChild(node);
        node.focus();
        node.select();
        document.execCommand("copy");
        node.remove();
      }
      setCopied(label);
    } catch {
      setError("复制失败，请检查浏览器的剪贴板权限。");
    }
  }

  function packageText() {
    if (!result) return "";
    const lesson = result.lesson_plan.stages.map((stage) => [
      `${stage.start_minute}-${stage.end_minute} 分钟｜${stage.title}`,
      `目标：${stage.objective}`,
      `教师：${stage.teacher_actions.join("；")}`,
      `学生：${stage.student_actions.join("；")}`,
      `课堂用语：${stage.prompts.join("；")}`,
      `预期产出：${stage.expected_output}`,
    ].join("\n")).join("\n\n");
    const rewritten = result.rewritten.sentences.map((sentence) => sentence.text).join("\n");
    const vocab = result.vocab.map((item) => `${item.word}（${item.pos}）\t${item.meaning}\t${item.example}`).join("\n");
    const questions = result.questions.map((item, index) => `${index + 1}. ${item.q}\n答案：${item.answer}\n追问：${item.follow_up}`).join("\n");
    return `${result.lesson_plan.title || result.rewritten.title}\n\n【30 分钟课堂流程】\n${lesson}\n\n【分级阅读】\n${rewritten}\n\n【生词与表达】\n${vocab}\n\n【练习题】\n${questions}\n\n【课后任务】\n${result.lesson_plan.homework}`;
  }

  return (
    <main className="grain min-h-screen">
      <div className="mx-auto max-w-7xl px-5 py-5 lg:px-10 lg:py-6">
        <header className="flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-moss">
              <span className="h-2 w-2 rounded-full bg-coral" /> Teacher studio
            </div>
            <h1 className="font-display text-3xl tracking-tight text-ink md:text-4xl">全世界都在说中国话</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">把真实中文材料，变成一节可以直接带进课堂的分级阅读课。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:max-w-[52%] md:justify-end">
            {modelStatus?.access_required && <label className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-2 text-xs text-slate-500">
              <LockKeyhole size={14} className="text-moss" />
              <input
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                autoComplete="current-password"
                placeholder={modelStatus.access_configured ? "输入访问码" : "访问码待配置"}
                className="w-24 bg-transparent text-ink outline-none placeholder:text-slate-400"
              />
            </label>}
            <div className="flex items-center gap-2 rounded-full border border-line bg-white/70 px-3 py-2 text-xs text-slate-500" title={modelStatus?.configured ? `${modelStatus.provider} · ${modelStatus.model}` : "未配置 LLM_API_KEY，将使用演示模式"}>
              <span className={`h-2 w-2 rounded-full ${probe.status === "success" ? "bg-emerald-500" : probe.status === "error" ? "bg-coral" : modelStatus?.configured ? "bg-amber-400" : modelStatus ? "bg-amber-400" : "bg-slate-300"}`} />
              <span>{probe.status === "success" ? "模型可用" : probe.status === "error" ? "模型测试失败" : modelStatus?.configured ? "模型已配置" : modelStatus ? "本地演示" : "后端未连接"}</span>
            </div>
            <button onClick={handleProbe} disabled={probe.status === "loading"} title="发送一次最小请求测试模型，不会显示密钥" className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-2 text-xs font-semibold text-ink transition hover:border-moss disabled:cursor-wait disabled:opacity-60">
              {probe.status === "loading" ? <LoaderCircle size={14} className="animate-spin" /> : <PlugZap size={14} />}
              {probe.status === "loading" ? "测试中…" : "测试模型"}
            </button>
            {probe.status === "success" && <span role="status" aria-live="polite" className="text-xs text-moss">{probeResultMessage(probe)}</span>}
            {probe.status === "error" && <span role="alert" className="text-xs leading-5 text-coral">{probeResultMessage(probe)}</span>}
          </div>
        </header>

        <section className="grid gap-4 py-5 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="rounded-2xl border border-line bg-white p-5 shadow-soft">
            <div className="mb-3 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm font-semibold"><FileText size={17} className="text-moss" /> 原文材料</label>
              <button className="text-xs text-moss underline-offset-4 hover:underline" onClick={() => setText(SAMPLE)}>填入示例</button>
            </div>
            <textarea value={text} onChange={(event) => handleTextChange(event.target.value)} className="min-h-[204px] w-full resize-y rounded-xl border border-line bg-paper p-4 text-[15px] leading-8 outline-none transition focus:border-moss focus:ring-4 focus:ring-moss/10" placeholder="粘贴一篇中文文章…" />
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400"><span>{text.length} 字</span><span>建议 80–800 字</span></div>
          </div>

          <div className="flex flex-col gap-4 rounded-2xl border border-line bg-[#eff4ec] p-5">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">01 / 设置课堂目标</p><h2 className="mt-1.5 font-display text-2xl">先定好学生的阅读坡度</h2></div>
            <div className="grid gap-3">
              <SelectField label="目标等级" value={level} onChange={(value) => handleLevelChange(value as Level)} options={["HSK1", "HSK2", "HSK3", "HSK4"]} />
              <SelectField label="学生母语" value={nativeLang} onChange={(value) => { setNativeLang(value as NativeLang); setResult(null); }} options={["English", "Vietnamese"]} labels={{ Vietnamese: "Tiếng Việt" }} />
            </div>
            <LevelProfileSummary profile={activeProfile} compact />
            <button onClick={handleAnalyze} disabled={loading !== null || text.length < 10} className="mt-auto flex items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-moss disabled:cursor-not-allowed disabled:opacity-50">
              {loading === "analyze" ? <LoaderCircle className="animate-spin" size={17} /> : <Sparkles size={17} />} 分析主题词 <ArrowRight size={16} />
            </button>
          </div>
        </section>

        {error && !result && <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle size={17} className="mt-0.5 shrink-0" /> <span>{error}</span></div>}

        {analysis && <section className="fade-up mb-6 rounded-2xl border border-line bg-white p-5 shadow-soft">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-coral">02 / 保留主题词</p><h2 className="mt-1 font-display text-2xl">哪些词，是这节课要教的？</h2><p className="mt-1 text-sm text-slate-500">保留词可以暂时超出 HSK 范围，系统会把它们加入生词与表达，并贯穿课堂流程。</p></div>
            <button onClick={() => handleGenerate()} disabled={loading !== null || componentLoading !== null} className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-coral px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#b85c45] disabled:opacity-50">{loading === "generate" ? <LoaderCircle className="animate-spin" size={17} /> : <Sparkles size={17} />} {loading === "generate" ? "生成中…" : "生成课堂材料"}</button>
          </div>
          <LevelComparisonTable comparisons={analysis.level_comparison} selected={level} />
          {(analysis.material_distinctiveness.status === "low" || isLowSeparation(analysis.level_comparison)) && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800"><strong>这段材料的等级区分度有限。</strong> 四个等级的已知词比例接近；生成时仍会按句长、语法、题型和课堂任务拉开差异，但不会为了凑篇幅编造事实。建议换一篇信息更丰富的材料。</div>}
          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {candidateWords.map(({ word, reason, status, first_level, is_compound }) => <button key={word} title={reason} onClick={() => toggleWord(word)} className={`flex min-h-[88px] items-start gap-2 rounded-xl border p-3 text-left transition ${wordSet.has(word) ? "border-moss bg-[#e6f0e5] text-moss" : "border-line bg-white text-slate-600 hover:border-moss"}`}><span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${wordSet.has(word) ? "border-moss bg-moss text-white" : "border-slate-300"}`}>{wordSet.has(word) && <Check size={11} strokeWidth={3} />}</span><span><strong className="block text-sm">{word}</strong><span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${status === "above_level" ? "bg-[#fff0e9] text-coral" : "bg-[#e6f0e5] text-moss"}`}>{candidateStatusLabel(status, first_level, is_compound)}</span><small className="mt-1 block text-xs leading-5 text-slate-400">{reason}</small></span></button>)}
          </div>
          <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center">
            <div className="relative flex-1"><input value={customWord} onChange={(event) => setCustomWord(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addCustomWords()} className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 pr-10 text-sm outline-none focus:border-moss" placeholder="添加系统没识别到的主题词，如：奶茶" /><Plus size={17} className="pointer-events-none absolute right-3 top-3 text-slate-400" /></div>
            <button onClick={addCustomWords} disabled={!customWord.trim()} className="flex items-center justify-center gap-1.5 rounded-xl border border-moss px-4 py-2.5 text-sm font-semibold text-moss transition hover:bg-[#e6f0e5] disabled:cursor-not-allowed disabled:opacity-40"><Plus size={16} /> 添加主题词</button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2"><span className="mr-1 text-xs font-semibold text-slate-500">已选 {selectedWords.length}/{activeProfile.max_target_words} 个：</span>{selectedWords.length ? selectedWords.map((word) => <span key={word} className="inline-flex items-center gap-1 rounded-full bg-[#e6f0e5] px-2.5 py-1 text-xs text-moss">{word}<button onClick={() => customWords.includes(word) ? removeCustomWord(word) : toggleWord(word)} title="移除主题词" className="rounded-full hover:bg-moss/15"><X size={13} /></button></span>) : <span className="text-xs text-slate-400">点击上方词语或手动添加</span>}</div>
        </section>}

        {loading === "generate" && <GenerationProgressPanel progress={generationProgress} retainingResult={Boolean(result)} />}

        {result && <section className="fade-up pb-10">
          <div className="mb-4 flex flex-col justify-between gap-3 md:flex-row md:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">03 / 教材生成结果</p><h2 className="mt-1 font-display text-3xl">{result.lesson_plan.title || result.rewritten.title || "你的分级阅读课"}</h2></div><div className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><span className="rounded-full bg-[#e6f0e5] px-3 py-1.5 text-moss">{generationLabel(result.meta)}</span><span>{result.meta.level}</span><span>{result.lesson_plan.available ? `${result.lesson_plan.total_minutes} 分钟` : "课堂流程未生成"}</span><span>{result.meta.target_words.length}/{result.meta.level_profile?.max_target_words ?? result.meta.target_words.length} 个目标词</span><span>{Math.round(result.quality.compliance_score * 100)}% 等级合规率</span><span>{result.quality.violations.length} 个超纲词</span><button onClick={() => copyText("整份材料", packageText())} className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1.5 font-semibold text-ink transition hover:border-moss"><Copy size={13} /> {copied === "整份材料" ? "已复制" : "复制可用内容"}</button></div></div>
          {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle size={17} className="mt-0.5 shrink-0" /> <span>{error}</span></div>}
          {loading !== "generate" && ((result.meta.generation_mode ?? (result.meta.demo_mode ? "demo" : "ai")) !== "ai" || Object.keys(result.meta.generation_warnings ?? {}).length > 0) && <GenerationWarning meta={result.meta} onRetry={() => handleGenerate({ focusLesson: false })} retrying={false} pendingComponent={componentLoading} />}
          <QualitySummary quality={result.quality} level={result.meta.level} />
          <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line">{(["课堂流程", "对照阅读", "生词与表达", "练习题"] as Tab[]).map((item) => <button key={item} onClick={() => setTab(item)} className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold transition ${tab === item ? "border-coral text-ink" : "border-transparent text-slate-400 hover:text-ink"}`}>{item}</button>)}</div>
          {tab === "课堂流程" && <LessonPlan plan={result.lesson_plan} componentStatus={result.meta.generation_components?.lesson_plan} onCopy={() => copyText("课堂流程", lessonPlanText(result.lesson_plan))} copied={copied === "课堂流程"} onRetry={() => handleRetryComponent("lesson_plan")} retrying={componentLoading === "lesson_plan" || loading === "generate"} />}
          {tab === "对照阅读" && (result.meta.generation_components?.rewrite === "unavailable" ? <EmptyResult title="分级改写没有生成成功" detail="右侧不会用原文冒充分级改写。重新生成整套材料后，生词、题目和教案才会继续生成。" loadingTitle="正在重新生成分级改写" onRetry={() => handleGenerate({ focusLesson: false })} retrying={loading === "generate"} wholePackage /> : <Comparison result={result} original={text} onCopy={() => copyText("改写内容", result.rewritten.sentences.map((sentence) => sentence.text).join("\n"))} copied={copied === "改写内容"} />)}
          {tab === "生词与表达" && <VocabTable vocab={result.vocab} nativeLang={nativeLang} unavailable={result.meta.generation_components?.vocab === "unavailable"} onCopy={() => copyText("生词与表达", result.vocab.map((item) => `${item.word}\t${item.pos}\t${item.meaning}\t${item.example}`).join("\n"))} copied={copied === "生词与表达"} onRetry={() => handleRetryComponent("vocab")} retrying={componentLoading === "vocab" || loading === "generate"} />}
          {tab === "练习题" && <Questions questions={result.questions} unavailable={result.meta.generation_components?.questions === "unavailable"} onCopy={() => copyText("练习题", result.questions.map((item, index) => `${index + 1}. ${item.q}\n答案：${item.answer}\n追问：${item.follow_up}`).join("\n"))} copied={copied === "练习题"} onRetry={() => handleRetryComponent("questions")} retrying={componentLoading === "questions" || loading === "generate"} />}
        </section>}
      </div>
    </main>
  );
}

function GenerationProgressPanel({ progress, retainingResult }: { progress: GenerationProgress; retainingResult: boolean }) {
  const components = progress.components;
  let message = "正在整理并校验生成结果…";
  if (components.rewrite === "loading") {
    message = "第 1/3 步：正在生成分级改写。课堂流程、生词和练习题尚未开始。";
  } else if (components.lesson_plan === "loading") {
    message = "第 2/3 步：分级改写已完成，正在优先生成 30 分钟课堂流程。生词和练习题仍在等待。";
  } else if (components.vocab === "loading" || components.questions === "loading") {
    const active = [components.vocab === "loading" && "生词与表达", components.questions === "loading" && "练习题"].filter(Boolean);
    message = components.lesson_plan === "failed"
      ? `第 3/3 步：课堂流程未通过校验，正在继续并行生成${active.join("和")}；完成后可单独重试课堂流程。`
      : `第 3/3 步：课堂流程请求已完成，正在并行生成${active.join("和")}。`;
  }
  const steps: { component: GenerationComponent; label: string }[] = [
    { component: "rewrite", label: "分级改写" },
    { component: "lesson_plan", label: "课堂流程" },
    { component: "vocab", label: "生词与表达" },
    { component: "questions", label: "练习题" },
  ];
  return <div role="status" aria-live="polite" className="mb-6 rounded-2xl border border-moss/20 bg-[#f0f6ee] p-4 shadow-soft"><div className="flex items-start gap-2"><LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-moss" /><div><p className="text-sm font-semibold text-ink">正在生成课堂材料</p><p className="mt-1 text-sm leading-6 text-slate-600">{message}</p>{retainingResult && <p className="mt-1 text-xs text-slate-500">当前页面保留的是上一版结果，新版本完成后会一次性替换。</p>}</div></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{steps.map(({ component, label }) => <GenerationStep key={component} label={label} status={components[component]} />)}</div></div>;
}

function GenerationStep({ label, status }: { label: string; status: GenerationStepStatus }) {
  const state = {
    waiting: { text: "等待前序步骤", className: "border-line bg-white text-slate-400", icon: <Clock3 size={14} /> },
    loading: { text: "生成中", className: "border-moss/30 bg-white text-moss", icon: <LoaderCircle size={14} className="animate-spin" /> },
    success: { text: "已完成", className: "border-emerald-200 bg-white text-emerald-700", icon: <CheckCircle2 size={14} /> },
    failed: { text: "未通过", className: "border-amber-300 bg-white text-amber-700", icon: <AlertTriangle size={14} /> },
  }[status];
  return <div className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${state.className}`}><strong className="font-semibold">{label}</strong><span className="inline-flex items-center gap-1">{state.icon}{state.text}</span></div>;
}

function LevelProfileSummary({ profile, compact = false }: { profile: LevelProfile; compact?: boolean }) {
  return <div className={`rounded-xl border border-line/80 bg-white/70 ${compact ? "p-3" : "p-4"}`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wider text-moss">{profile.code} 课堂坡度</span><span className="text-xs text-slate-400">累计约 {profile.vocab_size} 词</span></div><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span>单句 ≤ {profile.max_sentence_len} 字</span><span>全文 {profile.target_total_len[0]}–{profile.target_total_len[1]} 字</span><span>重点词 ≤ {profile.max_target_words}</span></div><p className="mt-2 text-xs leading-5 text-slate-500">课堂重点：{profile.task_focus.join("、")}</p><p className="mt-1 text-xs leading-5 text-slate-500">题型：{profile.question_types.map(questionTypeLabel).join("、")}</p></div>;
}

function LevelComparisonTable({ comparisons, selected }: { comparisons: LevelComparison[]; selected: Level }) {
  return <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-paper/70"><div className="min-w-[920px]"><div className="flex items-center justify-between border-b border-line px-4 py-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-moss">等级差异预览</p><p className="mt-1 text-xs text-slate-400">同一篇原文在词汇、篇幅、题型和课堂输出上的确定性差异</p></div><span className="text-xs text-slate-400">当前：{selected}</span></div><div className="grid grid-cols-[0.6fr_0.9fr_1.1fr_1.2fr_1.5fr] gap-3 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><span>等级</span><span>已知词比例</span><span>句长 / 目标长度</span><span>预计讲解</span><span>题型 / 课堂输出</span></div>{comparisons.map((item) => <div key={item.level} className={`grid grid-cols-[0.6fr_0.9fr_1.1fr_1.2fr_1.5fr] gap-3 border-t border-line/70 px-4 py-3 text-sm ${item.level === selected ? "bg-white text-ink" : "text-slate-500"}`}><strong>{item.level}</strong><span>{Math.round(item.known_ratio * 100)}% <small className="text-xs text-slate-400">· {item.out_of_level_words} 个待处理</small></span><span className="text-xs">≤ {item.max_sentence_len} 字 · {item.target_total_len[0]}–{item.target_total_len[1]} 字</span><span className="text-xs">{item.suggested_target_words.length ? item.suggested_target_words.join("、") : "无额外目标词"}</span><span className="text-xs leading-5"><strong className="font-medium">{item.question_types.map(questionTypeLabel).join(" / ")}</strong><br />{item.task_focus.join("、")}</span></div>)}</div></div>;
}

function questionTypeLabel(value: string) {
  const labels: Record<string, string> = { fact: "事实", choice: "选择", repeat: "复述", sequence: "顺序", reason: "原因", inference: "推断", explain: "解释", discussion: "讨论" };
  return labels[value] ?? value;
}

function isLowSeparation(comparisons: LevelComparison[]) {
  if (comparisons.length < 2) return false;
  const ratios = comparisons.map((item) => item.known_ratio);
  return Math.max(...ratios) - Math.min(...ratios) < 0.08;
}

function candidateStatusLabel(status?: string, firstLevel?: string | null, isCompound?: boolean) {
  if (status === "above_level") return firstLevel ? `需讲解 · ${firstLevel}` : "需讲解";
  if (isCompound || status === "known_composite") return "已知词组合";
  return "本级已学";
}

function generationLabel(meta: Package["meta"]) {
  const mode = meta.generation_mode ?? (meta.demo_mode ? "demo" : "ai");
  return mode === "ai" ? "AI 已生成" : mode === "partial" ? "部分生成成功" : "改写未成功";
}

function fallbackMessage(code?: Package["meta"]["fallback_code"]) {
  const messages: Record<string, string> = {
    not_configured: "请在本机填写 backend/.env 的 LLM_API_KEY 后重启后端。",
    auth_failed: "模型认证失败，请检查本机密钥是否正确、是否有可用额度。",
    provider_error: "模型服务暂时无法访问，请稍后重试。",
    invalid_response: "模型返回格式不完整，请重新生成；系统不会用虚构释义或模板例句补位。",
    empty_rewrite: "模型没有返回可用的改写句子，系统已拦截这次结果。",
    level_violation: "模型结果没有通过当前等级的篇幅、句长、词汇、语法或事实来源检查。",
    invalid_config: "模型服务地址配置不合法，请检查 backend/.env。",
    internal_error: "本地生成流程发生临时错误，请重启后端后再试。",
  };
  if (!code) return "部分内容没有生成成功，请重新生成。";
  const codes = code.split(",").map((item) => item.split(":").pop() ?? item);
  return Array.from(new Set(codes)).map((item) => messages[item] ?? "部分内容没有生成成功，请重新生成。").join(" ");
}

function probeResultMessage(probe: ProbeState) {
  if (probe.status === "success") {
    const details = [probe.model, typeof probe.latencyMs === "number" ? `${probe.latencyMs} ms` : ""].filter(Boolean).join(" · ");
    return details ? `连接成功 · ${details}` : "连接成功";
  }
  const messages: Record<string, string> = {
    not_configured: "未配置本地 API Key",
    auth_failed: "认证失败，请检查 Key 或额度",
    provider_error: "服务未在限定时间内响应，请稍后重试",
    invalid_response: "服务已响应，但返回格式无法识别",
    invalid_config: "模型服务地址配置有误",
    internal_error: "本地生成流程发生临时错误",
  };
  return `连接失败：${messages[probe.code ?? ""] ?? "无法完成模型测试"}`;
}

function GenerationWarning({ meta, onRetry, retrying, pendingComponent }: { meta: Package["meta"]; onRetry: () => void; retrying: boolean; pendingComponent?: RetryableComponent | null }) {
  const components = meta.generation_components;
  const fallbackCodes = meta.fallback_codes ?? {};
  const failedNames = Object.keys(fallbackCodes).filter((name) => name !== pendingComponent);
  const blockedNames = components ? Object.entries(components)
    .filter(([name, status]) => status === "unavailable" && !(name in fallbackCodes) && name !== pendingComponent)
    .map(([name]) => name) : [];
  const visibleFallbackCode = failedNames.map((name) => `${name}:${fallbackCodes[name]}`).join(",");
  const detailLines = Object.entries(meta.fallback_details ?? {})
    .filter(([name]) => name !== pendingComponent)
    .flatMap(([name, details]) => details.map((detail) => `${componentLabel(name)}：${detail}`));
  const warningLines = Object.entries(meta.generation_warnings ?? {})
    .filter(([name]) => name !== pendingComponent)
    .flatMap(([name, details]) => details.map((detail) => `${componentLabel(name)}：${detail}`));
  const hasFailures = failedNames.length > 0 || blockedNames.length > 0;
  const headline = pendingComponent
    ? `正在单独重试${componentLabel(pendingComponent)}，其他结果会保留。`
    : meta.generation_mode === "partial" ? "本次只有部分内容生成成功。"
      : hasFailures ? "本次没有生成可用的分级改写。"
        : "教材已完整生成，有少量课堂用语建议教师确认。";
  return <div role={pendingComponent ? "status" : "alert"} aria-live="polite" aria-busy={Boolean(pendingComponent) || retrying} className="mb-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 md:flex-row md:items-center md:justify-between"><div><p><strong>{headline}</strong>{visibleFallbackCode && <> {fallbackMessage(visibleFallbackCode)}</>}</p>{failedNames.length > 0 && <p className="mt-1 text-xs leading-5"><strong>失败阶段：</strong>{failedNames.map(componentLabel).join("、")}</p>}{blockedNames.length > 0 && <p className="mt-1 text-xs leading-5"><strong>尚未生成：</strong>{blockedNames.map(componentLabel).join("、")}</p>}{detailLines.length > 0 && <p className="mt-1 text-xs leading-5"><strong>具体违规：</strong>{detailLines.join("；")}</p>}{warningLines.length > 0 && <p className="mt-1 text-xs leading-5"><strong>教师确认：</strong>{warningLines.join("；")}</p>}</div>{pendingComponent ? <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold"><LoaderCircle size={14} className="animate-spin" />正在重试当前组件…</span> : <RetryButton onClick={onRetry} retrying={retrying} wholePackage />}</div>;
}

function componentLabel(value: string) {
  return ({ rewrite: "分级改写", vocab: "生词", questions: "题目", lesson_plan: "教案" } as Record<string, string>)[value] ?? value;
}

function RetryButton({ onClick, retrying, wholePackage = false }: { onClick: () => void; retrying: boolean; wholePackage?: boolean }) {
  return <button onClick={onClick} disabled={retrying} aria-busy={retrying} className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 transition hover:border-amber-500 hover:bg-amber-50 disabled:cursor-wait disabled:opacity-60">{retrying ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}{retrying ? "正在重新生成…" : wholePackage ? "重新生成整套材料" : "只重试当前组件"}</button>;
}

function SelectField({ label, value, onChange, options, labels = {} }: { label: string; value: string; onChange: (value: string) => void; options: string[]; labels?: Record<string, string> }) {
  return <label className="text-sm font-medium">{label}<span className="relative mt-2 block"><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none rounded-xl border border-line bg-white px-3 py-3 pr-10 text-sm outline-none focus:border-moss">{options.map((option) => <option key={option} value={option}>{labels[option] ?? option}</option>)}</select><ChevronDown size={16} className="pointer-events-none absolute right-3 top-3.5 text-slate-400" /></span></label>;
}

function QualitySummary({ quality, level }: { quality: Package["quality"]; level: Level }) {
  const unavailable = quality.details?.status === "unavailable";
  const hasIssues = quality.violations.length > 0 || quality.sentence_over_length.length > 0 || quality.grammar_violations.length > 0 || quality.total_length_status === "above_target";
  const suggestedLevel = ({ HSK1: "HSK2", HSK2: "HSK3 或 HSK4", HSK3: "HSK4", HSK4: "HSK4" } as Record<Level, string>)[level];
  const title = unavailable ? "改写未成功，以下指标仅描述原文" : hasIssues ? "生成结果未完全通过等级检查" : "生成结果通过确定性检查";
  return <div className={`mb-4 rounded-xl border px-4 py-3 ${unavailable || hasIssues ? "border-amber-200 bg-amber-50/70" : "border-moss/20 bg-[#f0f6ee]"}`}><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-2">{unavailable || hasIssues ? <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" /> : <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-moss" />}<div><p className="text-sm font-semibold text-ink">{title}</p><p className="mt-0.5 text-xs text-slate-500">目标 {level} · 等级合规率 {Math.round(quality.compliance_score * 100)}% · 词汇合规 {Math.round(quality.in_level_ratio * 100)}%</p></div></div><span className="text-xs text-slate-500">{quality.total_length} / {quality.target_total_len[0]}–{quality.target_total_len[1]} 字 · {quality.violations.length} 个超纲词 · {quality.sentence_over_length.length} 个长句</span></div>{quality.details?.source_limited && !unavailable && <p className="mt-2 text-xs text-amber-800">原文信息量不足以安全扩展到建议篇幅，系统允许短于目标，避免编造事实。</p>}{quality.details?.source_difficulty_limited && <p className="mt-2 text-xs leading-5 text-amber-800">原文难度明显高于 {level}。系统会优先保留中心意思并缩短文章；如果需要保留更多抽象观点，建议改用 {suggestedLevel}。</p>}{hasIssues && <div className="mt-3 grid gap-3 border-t border-amber-200/80 pt-3 text-xs text-slate-600 md:grid-cols-3">{quality.violations.length > 0 && <div><strong className="text-amber-800">超纲词</strong><p className="mt-1 leading-6">{quality.violations.join("、")}</p></div>}{quality.sentence_over_length.length > 0 && <div><strong className="text-amber-800">超长句</strong><p className="mt-1 leading-6">{quality.sentence_over_length.join(" ")}</p></div>}{quality.grammar_violations.length > 0 && <div><strong className="text-amber-800">禁用句型</strong><p className="mt-1 leading-6">{quality.grammar_violations.join("、")}</p></div>}</div>}</div>;
}

function lessonPlanText(plan: Package["lesson_plan"]) {
  const stages = plan.stages.map((stage) => [
    `${stage.start_minute}-${stage.end_minute} 分钟｜${stage.title}`,
    `目标：${stage.objective}`,
    `教师动作：${stage.teacher_actions.join("；")}`,
    `学生活动：${stage.student_actions.join("；")}`,
    `课堂用语：${stage.prompts.join("；")}`,
    `预期产出：${stage.expected_output}`,
  ].join("\n")).join("\n\n");
  return `${plan.title}\n\n课堂目标：${plan.objectives.join("；")}\n\n${stages}\n\n课后任务：${plan.homework}`;
}

function LessonPlan({ plan, componentStatus, onCopy, copied, onRetry, retrying }: { plan: Package["lesson_plan"]; componentStatus?: "ai" | "demo" | "unavailable"; onCopy: () => void; copied: boolean; onRetry: () => void; retrying: boolean }) {
  if (!plan.stages.length) {
    return <EmptyResult title="课堂流程没有生成成功" detail="没有可靠的流程时，系统不会用通用模板冒充专属教案。你可以只重试课堂流程，不影响已生成的其他内容。" loadingTitle="正在生成课堂流程" onRetry={onRetry} retrying={retrying} />;
  }
  return <div>
    <div className="mb-5 grid gap-3 rounded-2xl border border-moss/20 bg-[#f0f6ee] p-5 lg:grid-cols-[1fr_auto] lg:items-start">
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-moss"><Target size={15} /> 本课目标</div>
        <div className="mt-3 flex flex-wrap gap-2">{plan.objectives.map((objective) => <span key={objective} className="rounded-full bg-white px-3 py-1.5 text-sm text-slate-600">{objective}</span>)}</div>
        {!plan.available && <p className="mt-3 text-xs leading-5 text-amber-700">{plan.note || "这是课堂结构示意，专属活动和用语仍需重新生成。"}</p>}
      </div>
      <button onClick={onCopy} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-moss/20 bg-white px-3 py-1.5 text-xs font-semibold text-moss hover:bg-moss/10"><Copy size={13} /> {copied ? "已复制" : "复制流程"}</button>
    </div>
    <div className="relative space-y-3 before:absolute before:bottom-5 before:left-[23px] before:top-5 before:w-px before:bg-line">
      {plan.stages.map((stage, index) => <article key={`${stage.start_minute}-${stage.title}`} className="relative grid gap-4 rounded-2xl border border-line bg-white p-5 pl-[66px] shadow-soft lg:grid-cols-[0.8fr_1.2fr]">
        <div className="absolute left-3 top-5 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-ink text-sm font-semibold text-white">{index + 1}</div>
        <div>
          <div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full bg-[#fff0e9] px-2.5 py-1 text-xs font-semibold text-coral"><Clock3 size={13} /> {stage.start_minute}–{stage.end_minute} 分钟</span>{componentStatus === "demo" && <span className="text-xs text-amber-700">结构示意</span>}</div>
          <h3 className="mt-3 font-display text-2xl">{stage.title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500"><strong className="text-ink">阶段目标：</strong>{stage.objective}</p>
          <div className="mt-4 rounded-xl bg-paper px-3 py-3 text-sm leading-6 text-slate-600"><strong className="text-ink">看得见的产出：</strong>{stage.expected_output}</div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <StageList icon={<GraduationCap size={16} />} title="老师怎么做" items={stage.teacher_actions} />
          <StageList icon={<UsersRound size={16} />} title="学生怎么做" items={stage.student_actions} />
          <StageList icon={<MessageCircle size={16} />} title="老师可以直接说" items={stage.prompts} accent />
          <StageList icon={<BookOpen size={16} />} title="使用材料" items={stage.materials} />
        </div>
      </article>)}
    </div>
    {plan.homework && <div className="mt-4 flex items-start gap-3 rounded-2xl border border-line bg-white p-5"><UserRound size={18} className="mt-0.5 shrink-0 text-moss" /><div><p className="text-sm font-semibold">课后迁移</p><p className="mt-1 text-sm leading-6 text-slate-600">{plan.homework}</p></div></div>}
  </div>;
}

function StageList({ icon, title, items, accent = false }: { icon: ReactNode; title: string; items: string[]; accent?: boolean }) {
  return <div className={accent ? "rounded-xl bg-[#fff7f2] p-3" : "p-1"}><div className={`mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider ${accent ? "text-coral" : "text-moss"}`}>{icon}{title}</div>{items.length ? <ul className="space-y-1.5 text-sm leading-6 text-slate-600">{items.map((item) => <li key={item} className="flex gap-2"><span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-40" />{item}</li>)}</ul> : <p className="text-sm text-slate-400">无额外内容</p>}</div>;
}

function EmptyResult({ title, detail, loadingTitle, onRetry, retrying, wholePackage = false }: { title: string; detail: string; loadingTitle?: string; onRetry: () => void; retrying: boolean; wholePackage?: boolean }) {
  if (retrying) return <div role="status" aria-live="polite" className="rounded-2xl border border-moss/20 bg-[#f0f6ee] px-6 py-14 text-center"><LoaderCircle size={22} className="mx-auto animate-spin text-moss" /><h3 className="mt-3 text-base font-semibold text-ink">{loadingTitle ?? "正在重新生成当前内容"}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{wholePackage ? "系统会先完成分级改写和课堂流程，再生成生词与练习题。" : "其他已生成内容会保留，请稍候。"}</p></div>;
  return <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50/60 px-6 py-14 text-center"><AlertTriangle size={22} className="mx-auto text-amber-600" /><h3 className="mt-3 text-base font-semibold text-ink">{title}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{detail}</p><div className="mt-5"><RetryButton onClick={onRetry} retrying={false} wholePackage={wholePackage} /></div></div>;
}

function Comparison({ result, original, onCopy, copied }: { result: Package; original: string; onCopy: () => void; copied: boolean }) {
  const [speaking, setSpeaking] = useState(false);
  const [speechMessage, setSpeechMessage] = useState("");
  const rewritten = result.rewritten.sentences.map((sentence) => sentence.text).join("");

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  function speak() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { setSpeechMessage("当前浏览器不支持朗读"); return; }
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const utterance = new SpeechSynthesisUtterance(rewritten);
    utterance.lang = "zh-CN";
    utterance.rate = 0.85;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => { setSpeaking(false); setSpeechMessage("朗读暂时不可用"); };
    setSpeechMessage("");
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  return <div className="grid gap-5 lg:grid-cols-2"><div className="rounded-2xl border border-line bg-white p-5"><div className="mb-5 flex items-center justify-between"><h3 className="font-semibold">原文</h3><span className="text-xs text-slate-400">{original.length} 字</span></div><p className="whitespace-pre-wrap text-[15px] leading-9 text-slate-600">{original}</p><div className="mt-8 border-t border-line pt-4 text-xs leading-5 text-slate-400">{result.rewritten.deleted_info}</div></div><div className="rounded-2xl border border-moss/20 bg-[#f0f6ee] p-5"><div className="mb-5 flex items-center justify-between"><h3 className="font-semibold text-moss">{result.rewritten.title || "分级改写"}</h3><div className="flex items-center gap-1"><button onClick={onCopy} title="复制改写内容" className="inline-flex items-center gap-1 rounded-full border border-moss/20 px-2.5 py-1.5 text-xs text-moss hover:bg-moss/10"><Clipboard size={14} /> {copied ? "已复制" : "复制改写"}</button><button onClick={speak} title={speaking ? "停止朗读" : "朗读改写内容"} className="rounded-full p-2 text-moss hover:bg-moss/10"><Volume2 size={16} /></button></div></div>{speechMessage && <p className="mb-3 text-xs text-amber-700">{speechMessage}</p>}<div className="space-y-5">{result.rewritten.sentences.map((sentence, index) => <div key={`${sentence.text}-${index}`} className="group rounded-xl border border-transparent p-2 transition hover:border-moss/20 hover:bg-white/70"><div className="mb-1 text-xs text-moss/70">{sentence.source_sentence_ids.map((id) => `原文 ${id + 1}`).join(" · ")}</div><p className="text-[16px] leading-8">{sentence.text}</p><p className="mt-1 text-sm tracking-wide text-coral/80">{(result.pinyin_sentences[index] ?? []).map((item, itemIndex) => <span key={`${item.word}-${itemIndex}`} className="mr-1">{item.pinyin}</span>)}</p></div>)}</div><div className="mt-7 border-t border-moss/15 pt-4 text-xs leading-5 text-slate-500">备课提示：{result.rewritten.teacher_notes}</div></div></div>;
}

function VocabTable({ vocab, nativeLang, unavailable, onCopy, copied, onRetry, retrying }: { vocab: Package["vocab"]; nativeLang: NativeLang; unavailable: boolean; onCopy: () => void; copied: boolean; onRetry: () => void; retrying: boolean }) {
  if (!vocab.length && unavailable) return <EmptyResult title="生词与表达没有生成成功" detail="为了避免不准确的翻译和重复模板例句，这里不再自动填入占位内容。" loadingTitle="正在生成生词与表达" onRetry={onRetry} retrying={retrying} />;
  return <div className="overflow-hidden rounded-2xl border border-line bg-white"><div className="flex items-center justify-between border-b border-line bg-paper px-5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-slate-400">生词与表达</span><button onClick={onCopy} disabled={!vocab.length} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1.5 text-xs font-semibold text-ink hover:border-moss disabled:cursor-not-allowed disabled:opacity-40"><Copy size={13} /> {copied ? "已复制" : "复制生词"}</button></div><div className="overflow-x-auto"><div className="min-w-[700px]"><div className="grid grid-cols-[1fr_0.7fr_1.6fr_1.8fr] gap-4 border-b border-line bg-paper/70 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400"><span>词语</span><span>词性</span><span>{nativeLang === "English" ? "语境释义" : "Nghĩa trong ngữ cảnh"}</span><span>自然例句</span></div>{vocab.length ? vocab.map((item) => <div key={item.word} className="grid grid-cols-[1fr_0.7fr_1.6fr_1.8fr] gap-4 border-b border-line px-5 py-4 text-sm last:border-0"><div><strong className="text-base">{item.word}</strong>{item.sino_viet && <div className="mt-1 text-xs text-coral">{item.sino_viet}</div>}</div><span className="text-slate-400">{item.pos}</span><div><p>{item.meaning}</p>{item.pitfall && <p className="mt-1 text-xs text-coral">易错：{item.pitfall}</p>}</div><span className="text-slate-600">{item.example}</span></div>) : <div className="px-5 py-12 text-center text-sm text-slate-400">这篇材料没有额外目标词。</div>}</div></div></div>;
}

function Questions({ questions, unavailable, onCopy, copied, onRetry, retrying }: { questions: Package["questions"]; unavailable: boolean; onCopy: () => void; copied: boolean; onRetry: () => void; retrying: boolean }) {
  if (!questions.length && unavailable) return <EmptyResult title="练习题没有生成成功" detail="系统没有用与文章无关的通用题目补位。你可以只重试练习题，或先使用课堂流程中的提问。" loadingTitle="正在生成练习题" onRetry={onRetry} retrying={retrying} />;
  return <div><div className="mb-4 flex justify-end"><button onClick={onCopy} disabled={!questions.length} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink hover:border-moss disabled:cursor-not-allowed disabled:opacity-40"><Copy size={13} /> {copied ? "已复制" : "复制练习"}</button></div><div className="grid gap-4 lg:grid-cols-3">{questions.map((question, index) => <article key={`${question.type}-${index}`} className="rounded-2xl border border-line bg-white p-5 shadow-soft"><div className="mb-5 flex items-center justify-between gap-2"><span className="rounded-full bg-[#e6f0e5] px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-moss">{index + 1} · {question.type}</span>{question.answer && <span className="text-xs text-slate-400">答案 {question.answer}</span>}</div><h3 className="text-[15px] font-semibold leading-7">{question.q}</h3>{question.options.length > 0 && <div className="mt-5 space-y-2">{question.options.map((option, optionIndex) => <div key={option} className="rounded-lg border border-line px-3 py-2.5 text-sm text-slate-600"><span className="mr-2 text-xs font-semibold text-coral">{String.fromCharCode(65 + optionIndex)}</span>{option}</div>)}</div>}{question.follow_up && <p className="mt-5 border-t border-line pt-4 text-xs leading-5 text-slate-500">追问：{question.follow_up}</p>}</article>)}</div></div>;
}
