"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatRequestSchema = exports.LlmHttpError = exports.LlmUnavailableError = void 0;
exports.formatChatIssues = formatChatIssues;
exports.settingsFromConfig = settingsFromConfig;
exports.readSseDeltas = readSseDeltas;
exports.chat = chat;
exports.forwardChatStream = forwardChatStream;
/** Chat completions for OpenAI, Azure OpenAI, and Anthropic. The API key stays in config and is never logged. */
const node_stream_1 = require("node:stream");
const zod_1 = require("zod");
const config_1 = require("../config/config");
class LlmUnavailableError extends Error {
    constructor(message = 'LLM API key is not configured') {
        super(message);
        this.name = 'LlmUnavailableError';
    }
}
exports.LlmUnavailableError = LlmUnavailableError;
class LlmHttpError extends Error {
    status;
    constructor(status) {
        super(`LLM request failed (${status})`);
        this.name = 'LlmHttpError';
        this.status = status;
    }
}
exports.LlmHttpError = LlmHttpError;
const TIMEOUT_MS = 20_000;
const MAX_TOKENS = 1200;
const MAX_MESSAGES = 20;
const MAX_CHARS = 60_000;
const messageSchema = zod_1.z.object({
    role: zod_1.z.enum(['user', 'assistant']),
    content: zod_1.z.string(),
});
exports.chatRequestSchema = zod_1.z.object({
    system: zod_1.z.string(),
    messages: zod_1.z.array(messageSchema).max(MAX_MESSAGES, `messages must be at most ${MAX_MESSAGES}`),
    json: zod_1.z.boolean().optional(),
    stream: zod_1.z.boolean().optional(),
}).superRefine((value, ctx) => {
    const total = value.system.length + value.messages.reduce((sum, message) => sum + message.content.length, 0);
    if (total > MAX_CHARS)
        ctx.addIssue(`total characters must be at most ${MAX_CHARS}`);
});
function formatChatIssues(error) {
    return error.issues.map((issue) => {
        const field = issue.path.length ? issue.path.map(String).join('.') : 'body';
        return `${field}: ${issue.message}`;
    }).join('; ');
}
function settingsFromConfig() {
    return {
        apiKey: config_1.config.LLM_API_KEY,
        baseUrl: config_1.config.LLM_BASE_URL,
        model: config_1.config.LLM_MODEL,
        apiVersion: config_1.config.LLM_API_VERSION,
    };
}
function isAnthropic(settings) {
    try {
        return new URL(settings.baseUrl).hostname.endsWith('anthropic.com');
    }
    catch {
        return false;
    }
}
function anthropicUrl(root) {
    if (/\/messages$/.test(root))
        return root;
    if (/\/v1$/.test(root))
        return `${root}/messages`;
    return `${root}/v1/messages`;
}
/** Anthropic rejects consecutive roles and a transcript that starts with the assistant. */
function anthropicMessages(messages) {
    const merged = [];
    for (const message of messages) {
        const last = merged[merged.length - 1];
        if (last && last.role === message.role)
            last.content = `${last.content}\n\n${message.content}`;
        else
            merged.push({ role: message.role, content: message.content });
    }
    if (merged.length === 0 || merged[0].role !== 'user')
        merged.unshift({ role: 'user', content: 'Continue.' });
    return merged;
}
function endpoint(settings) {
    const root = settings.baseUrl.replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (isAnthropic(settings)) {
        headers['x-api-key'] = settings.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        return { url: anthropicUrl(root), headers };
    }
    if (settings.apiVersion) {
        headers['api-key'] = settings.apiKey;
        const url = `${root}/openai/deployments/${encodeURIComponent(settings.model)}/chat/completions?api-version=${encodeURIComponent(settings.apiVersion)}`;
        return { url, headers };
    }
    headers.Authorization = `Bearer ${settings.apiKey}`;
    const url = /\/chat\/completions$/.test(root) ? root : `${root}/chat/completions`;
    return { url, headers };
}
function requestBody(settings, request, stream) {
    if (isAnthropic(settings)) {
        const system = request.json && !/json/i.test(request.system) ? `${request.system}\nReply with one JSON object only.` : request.system;
        return JSON.stringify({
            model: settings.model,
            temperature: 0,
            max_tokens: MAX_TOKENS,
            ...(system.trim() ? { system } : {}),
            messages: anthropicMessages(request.messages),
            ...(stream ? { stream: true } : {}),
        });
    }
    return JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: request.system }, ...request.messages],
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        ...(stream ? { stream: true } : {}),
    });
}
function linkedSignal(parent, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const onParentAbort = () => controller.abort();
    if (parent) {
        if (parent.aborted)
            controller.abort();
        else
            parent.addEventListener('abort', onParentAbort);
    }
    return {
        signal: controller.signal,
        clear: () => {
            clearTimeout(timer);
            parent?.removeEventListener('abort', onParentAbort);
        },
    };
}
function isAbort(error) {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}
function isRetryable(error) {
    return error instanceof LlmHttpError && (error.status === 429 || error.status >= 500);
}
async function discard(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        // The body is unused after an error status.
    }
}
/** Pull text deltas out of an OpenAI server-sent-event buffer. `buffer` keeps an incomplete trailing line. */
function readSseDeltas(buffer, chunk) {
    const lines = (buffer + chunk).split('\n');
    const rest = lines.pop() ?? '';
    const deltas = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:'))
            continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]')
            continue;
        try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? json.delta?.text;
            if (typeof content === 'string' && content)
                deltas.push(content);
        }
        catch {
            // A keepalive or a split JSON frame is ignored until the next chunk completes it.
        }
    }
    return { buffer: rest, deltas };
}
async function readStream(response, onDelta) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('LLM stream was empty');
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
        const step = await reader.read();
        if (step.done)
            break;
        const parsed = readSseDeltas(buffer, decoder.decode(step.value, { stream: true }));
        buffer = parsed.buffer;
        for (const delta of parsed.deltas) {
            full += delta;
            onDelta(delta);
        }
    }
    const tail = readSseDeltas(buffer, '\n');
    for (const delta of tail.deltas) {
        full += delta;
        onDelta(delta);
    }
    if (!full.trim())
        throw new Error('LLM response was empty');
    return full;
}
async function fetchChat(settings, request, signal, stream) {
    if (!settings.apiKey.trim())
        throw new LlmUnavailableError();
    const target = endpoint(settings);
    const response = await (settings.fetch ?? globalThis.fetch)(target.url, {
        method: 'POST',
        headers: target.headers,
        signal,
        body: requestBody(settings, request, stream),
    });
    if (!response.ok) {
        await discard(response);
        throw new LlmHttpError(response.status);
    }
    return response;
}
async function withRetry(request, run) {
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const timeout = linkedSignal(request.signal, TIMEOUT_MS);
        try {
            return await run(timeout.signal);
        }
        catch (error) {
            if (isAbort(error) || request.signal?.aborted)
                throw error;
            last = error;
            if (attempt === 0 && isRetryable(error))
                continue;
            throw error;
        }
        finally {
            timeout.clear();
        }
    }
    throw last instanceof Error ? last : new Error('LLM request failed');
}
async function readContent(response, onDelta) {
    const contentType = response.headers?.get('content-type') ?? '';
    if (onDelta && response.body && !contentType.includes('application/json'))
        return readStream(response, onDelta);
    const payload = await response.json();
    const openai = payload.choices?.[0]?.message?.content;
    const claude = (payload.content ?? [])
        .filter((block) => block.type === 'text' || block.type == null)
        .map((block) => block.text)
        .filter((text) => typeof text === 'string')
        .join('');
    const content = typeof openai === 'string' && openai.trim() ? openai : claude;
    if (!content.trim())
        throw new Error('LLM response was empty');
    if (onDelta)
        onDelta(content);
    return content;
}
/** One completion. Retries once on 429 or 5xx. */
async function chat(request, settings = settingsFromConfig()) {
    return withRetry(request, async (signal) => {
        const response = await fetchChat(settings, request, signal, Boolean(request.onDelta || request.stream));
        return readContent(response, request.onDelta);
    });
}
function openAiDeltaFrame(text) {
    return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}
/** The browser reads OpenAI token frames. Anthropic streams are rewritten into that shape. */
async function translateAnthropicSse(upstream, res) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const reader = upstream.body?.getReader();
    if (!reader) {
        res.end();
        return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    const writeDeltas = (parsed) => {
        for (const delta of parsed.deltas)
            res.write(openAiDeltaFrame(delta));
    };
    while (true) {
        const step = await reader.read();
        if (step.done)
            break;
        const parsed = readSseDeltas(buffer, decoder.decode(step.value, { stream: true }));
        buffer = parsed.buffer;
        writeDeltas(parsed);
    }
    writeDeltas(readSseDeltas(buffer, '\n'));
    res.write('data: [DONE]\n\n');
    res.end();
}
function pipeSse(upstream, res) {
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (!upstream.body) {
        res.end();
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const stream = node_stream_1.Readable.fromWeb(upstream.body);
        stream.on('error', reject);
        res.on('error', reject);
        res.on('finish', () => resolve());
        stream.pipe(res);
    });
}
/** Proxy a provider SSE response to the client. Retries once before the first byte is sent. */
async function forwardChatStream(request, res, settings = settingsFromConfig()) {
    const client = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded)
            client.abort();
    });
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const timeout = linkedSignal(client.signal, TIMEOUT_MS);
        try {
            const upstream = await fetchChat(settings, { ...request, signal: client.signal }, timeout.signal, true);
            if (isAnthropic(settings))
                await translateAnthropicSse(upstream, res);
            else
                await pipeSse(upstream, res);
            return;
        }
        catch (error) {
            if (isAbort(error) || client.signal.aborted)
                throw error;
            last = error;
            if (res.headersSent)
                throw error;
            if (attempt === 0 && isRetryable(error))
                continue;
            throw error;
        }
        finally {
            timeout.clear();
        }
    }
    throw last instanceof Error ? last : new Error('LLM request failed');
}
