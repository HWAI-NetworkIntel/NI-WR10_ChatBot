const dotenv = require('dotenv')
const { z } = require('zod')

dotenv.config({ path: '.env', quiet: true })

const envSchema = z.object({
  PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).default('4010'),
  ALLOWED_ORIGIN: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
  console.error(`Invalid configuration:\n${details}`)
  process.exit(1)
}

module.exports = { config: parsed.data }
