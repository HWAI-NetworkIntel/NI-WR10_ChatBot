/** Start the network impact prediction API. */
const { config } = require('./config/config')
const app = require('./app')

const server = app.listen(config.PORT, () => {
  console.log(JSON.stringify({ event: 'listen', port: config.PORT }))
})

server.on('error', (err) => {
  console.error(JSON.stringify({ event: 'listen_error', code: err.code || 'UNKNOWN' }))
  process.exitCode = 1
})

function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal }))
  server.close((err) => {
    if (err) {
      console.error(JSON.stringify({ event: 'shutdown_error', name: err.name }))
      process.exitCode = 1
    }
  })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
