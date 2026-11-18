const { AppError } = require('../utils/AppError')

async function predictNetworkImpact(_input) {
  throw new AppError(501, 'ALGORITHM_NOT_CONFIGURED', 'The network impact algorithm is not connected yet.')
}

module.exports = { predictNetworkImpact }
