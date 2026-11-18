/** Start the NI chat HTTP service. */
const { config } = require('./config/config')
const app = require('./app')
const { startSchemaRefresh } = require('./services/schemaService')

async function boot() {
  await startSchemaRefresh()
  const server = app.listen(config.PORT, () => {
    console.log(JSON.stringify({ event: 'listen', port: config.PORT }))
  })
  server.on('error', (err) => {
    console.error(JSON.stringify({ event: 'listen', code: err.code ?? 'error' }))
    process.exit(1)
  })
}

void boot()
