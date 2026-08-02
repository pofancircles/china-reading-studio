# 全世界都在说中国话

面向对外汉语教师的分级阅读备课工具：粘贴真实中文材料，选择旧 HSK 1–4 等级和学生母语，生成课堂可用的改写文章、拼音、生词表、练习题和 30 分钟教案。

## 功能

- 四个等级共享同一份 `LevelProfile`，词汇、句长、篇幅、语法、题型和课堂任务会产生可验证差异。
- 改写、生词、练习题和教案独立生成、独立校验，失败组件可以单独重试。
- 完整备课方案生成后，可进入“课堂材料工作台”逐页微调 6–10 页课件，并下载可编辑 PPTX、学生练习 DOCX 和教师答案 DOCX。
- 课堂材料直接复用老师已确认的内容，在浏览器本地编排和导出，不增加模型调用，也不把生成文件存到服务器。
- 没有可靠 AI 结果时只显示原文预览，不伪造翻译、释义或例句。
- `jieba` 负责词汇检测，`pypinyin` 负责拼音，模型不猜拼音。
- 支持本地开发和单 Docker 服务部署。线上网页与 API 使用同一个网址。

## 本地启动

Windows PowerShell：

```powershell
.\scripts\start-dev.ps1
```

第一次启动会在项目目录创建 `.venv` 并安装 Python 依赖。随后打开 <http://localhost:3000>。

手动启动后端：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

手动启动前端：

```powershell
cd frontend
npm install
npm run dev -- --port 3000
```

## 本地配置

复制 `.env.example` 的字段到 `backend/.env`，只在本机填写真实值。不要把 `backend/.env` 提交到 Git，也不要把 Key 放进前端变量。

```text
LLM_API_KEY=your-key-here
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_TIMEOUT_SECONDS=60
LLM_REASONING_EFFORT=low
LLM_MAX_COMPLETION_TOKENS=2400
APP_ENV=local
APP_ACCESS_CODE=
APP_RATE_LIMIT_PER_HOUR=60
```

线上默认使用 DeepSeek 官方 OpenAI-compatible API 和非推理模型 `deepseek-v4-flash`。用户粘贴的文章和生成请求会发送到 `LLM_BASE_URL` 指向的模型供应商，并按该供应商的条款和隐私政策处理；不要提交学生身份、联系方式或其他机密材料。部署者可以通过环境变量更换其他兼容服务。

线上环境必须设置 `APP_ENV=production`、`APP_ACCESS_CODE` 和 `LLM_API_KEY`。网页会要求输入访问码；服务还会按 IP 做每小时请求限制，避免公开网址被滥用。

## 部署

项目提供了单容器部署文件：`Dockerfile`、`render.yaml` 和 `railway.toml`。容器会先构建 Vite 前端，再由 FastAPI 同时托管静态网页和 `/api/*`。

推荐流程：

1. 将仓库连接到 Railway 或 Render，并使用 Dockerfile 构建。
2. 在平台的 Secrets/Environment 中填写 `LLM_API_KEY` 和自定义 `APP_ACCESS_CODE`。
3. 设置完成后访问平台生成的 `https://...` 网址，先输入访问码，再点击“测试模型”。

GitHub Pages 只能托管静态文件，不能安全运行本项目的 FastAPI 后端和模型 Key，因此不适合作为最终网址。

## 接口

- `GET /health`：健康检查
- `GET /api/model-status`：模型和访问保护状态，不发送模型请求
- `POST /api/model-probe`：发送一次最小模型请求
- `POST /api/analyze`：主题词状态和四级差异预览
- `POST /api/rewrite`：生成并校验分级改写
- `POST /api/generate-component`：单独生成或重试生词、题目、教案
- `POST /api/generate`：兼容的一次性整包接口

## 数据来源

旧 HSK 词表数据来源及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
