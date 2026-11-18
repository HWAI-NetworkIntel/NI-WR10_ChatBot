"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const llm_1 = require("../services/llm");
const openai = {
    apiKey: 'sk-openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
};
const azure = {
    apiKey: 'azure-secret',
    baseUrl: 'https://demo.openai.azure.com',
    model: 'gpt-demo',
    apiVersion: '2024-10-21',
};
function completion(content, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content } }] }),
        body: { cancel: async () => undefined },
    };
}
function recordedFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses.shift();
        if (!next)
            throw new Error('unexpected fetch');
        return next;
    };
    return { calls, fetchImpl };
}
function headersOf(init) {
    return new Headers(init.headers);
}
function bodyOf(init) {
    return JSON.parse(String(init.body));
}
(0, node_test_1.test)('OpenAI requests use a bearer token', async () => {
    const { calls, fetchImpl } = recordedFetch([completion('hello')]);
    const text = await (0, llm_1.chat)({ system: 'rules', messages: [{ role: 'user', content: 'hello' }], json: true }, { ...openai, fetch: fetchImpl });
    strict_1.default.equal(text, 'hello');
    strict_1.default.equal(calls.length, 1);
    strict_1.default.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    const headers = headersOf(calls[0].init);
    strict_1.default.equal(headers.get('Authorization'), 'Bearer sk-openai');
    strict_1.default.equal(headers.get('api-key'), null);
    const body = bodyOf(calls[0].init);
    strict_1.default.equal(body.temperature, 0);
    strict_1.default.equal(body.max_tokens, 1200);
    strict_1.default.equal(body.model, 'gpt-4.1');
    strict_1.default.deepEqual(body.response_format, { type: 'json_object' });
    strict_1.default.deepEqual(body.messages[0], { role: 'system', content: 'rules' });
});
(0, node_test_1.test)('Azure requests use the deployments URL and api-key header', async () => {
    const { calls, fetchImpl } = recordedFetch([completion('ok')]);
    await (0, llm_1.chat)({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { ...azure, fetch: fetchImpl });
    strict_1.default.equal(calls.length, 1);
    strict_1.default.equal(calls[0].url, 'https://demo.openai.azure.com/openai/deployments/gpt-demo/chat/completions?api-version=2024-10-21');
    const headers = headersOf(calls[0].init);
    strict_1.default.equal(headers.get('api-key'), 'azure-secret');
    strict_1.default.equal(headers.get('Authorization'), null);
    const body = bodyOf(calls[0].init);
    strict_1.default.equal(body.temperature, 0);
    strict_1.default.equal(body.max_tokens, 1200);
});
(0, node_test_1.test)('retries once on 503', async () => {
    const { calls, fetchImpl } = recordedFetch([completion('', 503), completion('recovered')]);
    const text = await (0, llm_1.chat)({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { ...openai, fetch: fetchImpl });
    strict_1.default.equal(text, 'recovered');
    strict_1.default.equal(calls.length, 2);
    strict_1.default.equal(headersOf(calls[1].init).get('Authorization'), 'Bearer sk-openai');
});
(0, node_test_1.test)('does not retry a 400', async () => {
    const { calls, fetchImpl } = recordedFetch([completion('no', 400), completion('should-not-run')]);
    await strict_1.default.rejects(() => (0, llm_1.chat)({ system: 's', messages: [{ role: 'user', content: 'q' }] }, { ...openai, fetch: fetchImpl }), (error) => error instanceof llm_1.LlmHttpError && error.status === 400);
    strict_1.default.equal(calls.length, 1);
});
(0, node_test_1.test)('Anthropic requests use the Messages API and x-api-key', async () => {
    const claude = {
        apiKey: 'sk-ant-test',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        apiVersion: '2024-10-21',
    };
    const response = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ content: [{ type: 'text', text: '{"sql":"SELECT 1"}' }] }),
        body: { cancel: async () => undefined },
    };
    const { calls, fetchImpl } = recordedFetch([response]);
    const text = await (0, llm_1.chat)({ system: 'rules', messages: [{ role: 'user', content: 'hello' }], json: true }, { ...claude, fetch: fetchImpl });
    strict_1.default.equal(text, '{"sql":"SELECT 1"}');
    strict_1.default.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    const headers = headersOf(calls[0].init);
    strict_1.default.equal(headers.get('x-api-key'), 'sk-ant-test');
    strict_1.default.equal(headers.get('anthropic-version'), '2023-06-01');
    strict_1.default.equal(headers.get('Authorization'), null);
    const body = JSON.parse(String(calls[0].init.body));
    strict_1.default.equal(body.system, 'rules\nReply with one JSON object only.');
    strict_1.default.equal(body.max_tokens, 1200);
    strict_1.default.equal(body.response_format, undefined);
    strict_1.default.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});
(0, node_test_1.test)('reads Anthropic text deltas from the event stream', () => {
    const first = (0, llm_1.readSseDeltas)('', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n');
    strict_1.default.deepEqual(first.deltas, ['Hello']);
});
(0, node_test_1.test)('rejects more than 20 messages or 60000 characters', () => {
    const tooMany = llm_1.chatRequestSchema.safeParse({
        system: 's',
        messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'a' })),
    });
    strict_1.default.equal(tooMany.success, false);
    const tooLong = llm_1.chatRequestSchema.safeParse({
        system: 's',
        messages: [{ role: 'user', content: 'a'.repeat(60_000) }],
    });
    strict_1.default.equal(tooLong.success, false);
    const ok = llm_1.chatRequestSchema.safeParse({
        system: 's',
        messages: [{ role: 'user', content: 'a' }],
        json: true,
    });
    strict_1.default.equal(ok.success, true);
});
