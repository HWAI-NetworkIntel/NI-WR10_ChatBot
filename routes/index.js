const express = require('express')
const networkImpactController = require('../controllers/networkImpactController')

const router = express.Router()

router.get('/health', networkImpactController.health)
router.post('/api/network-impact/predict', networkImpactController.predict)

module.exports = router
