"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.parseEnv = parseEnv;
/** Load and validate .env. Values are never printed. */
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
/** Trim strings. Blank values are treated as unset so defaults can apply. */
function trimEnv(value) {
    if (typeof value !== 'string')
        return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
function requiredText(name) {
    return zod_1.z.preprocess(trimEnv, zod_1.z.string({ error: `${name} is required` }).min(1, `${name} is required`));
}
function optionalText() {
    return zod_1.z.preprocess(trimEnv, zod_1.z.string().min(1).optional());
}
function portNumber(name) {
    const message = `${name} must be an integer from 1 to 65535`;
    return zod_1.z
        .string({ error: message })
        .regex(/^\d+$/, message)
        .transform((value) => Number(value))
        .pipe(zod_1.z.number().int().min(1).max(65535));
}
function envFlag(fallback) {
    return zod_1.z.preprocess(trimEnv, zod_1.z.stringbool('must be true or false').optional().default(fallback));
}
const envSchema = zod_1.z.object({
    DB_SERVER: requiredText('DB_SERVER'),
    DB_DATABASE: requiredText('DB_DATABASE'),
    DB_USER: requiredText('DB_USER'),
    DB_PASSWORD: requiredText('DB_PASSWORD'),
    DB_PORT: zod_1.z.preprocess(trimEnv, portNumber('DB_PORT').optional()),
    DB_ENCRYPT: envFlag(true),
    DB_TRUST_CERT: envFlag(false),
    LLM_BASE_URL: zod_1.z.preprocess(trimEnv, zod_1.z.string({ error: 'LLM_BASE_URL is required' }).url('LLM_BASE_URL must be an absolute URL')),
    LLM_API_KEY: requiredText('LLM_API_KEY'),
    LLM_MODEL: requiredText('LLM_MODEL'),
    LLM_API_VERSION: optionalText(),
    ALLOWED_ORIGIN: zod_1.z.preprocess(trimEnv, zod_1.z.string({ error: 'ALLOWED_ORIGIN is required' }).url('ALLOWED_ORIGIN must be an absolute URL')),
    PORT: zod_1.z.preprocess(trimEnv, portNumber('PORT').optional().default(4010)),
});
function formatIssues(error) {
    return error.issues
        .map((issue) => {
        const field = issue.path.length ? issue.path.map(String).join('.') : 'environment';
        return `- ${field}: ${issue.message}`;
    })
        .join('\n');
}
/** Validate an environment object. Throws an Error whose message lists field names only. */
function parseEnv(source) {
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
        throw new Error(`Invalid configuration:\n${formatIssues(parsed.error)}`);
    }
    return parsed.data;
}
function loadConfig() {
    const loaded = dotenv_1.default.config({ path: '.env', quiet: true });
    try {
        return parseEnv(process.env);
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : 'Invalid configuration';
        const fileNote = loaded.error
            ? `Could not read .env (${loaded.error.code ?? 'error'}).\n`
            : '';
        console.error(`${fileNote}${detail}\nFix .env and restart.`);
        process.exit(1);
    }
}
exports.config = loadConfig();
